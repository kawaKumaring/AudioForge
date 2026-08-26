# -*- coding: utf-8 -*-
"""생성 상한 telemetry(가산) 계약 테스트 — 순수·GPU 불요·합성 불요.

고정하는 것
  1) chunk 행의 자가 완결성: generation_chunks 각 항목에 output_sample_rate 가 실린다(상위 dict와
     join하지 않아도 frames를 초로 바꿀 수 있다).
  2) 결측/이상값은 0으로 위조되지 않고 None(= unavailable)으로 표면화된다.
  3) frames 는 원래부터 조건부(layout 길이 불일치 시 미첨부)이므로 현행 버전 실행에서도 부재할 수 있다.
  4) metadata 는 JSON 직렬화 가능하고 민감값(대사/전사/경로)을 담지 않는다.
  5) 생산 상수(ABS_LIMIT/SLOPE/BASE/MIN_LIMIT)와 두 watchdog 값이 base와 바이트 동일하다.
"""
import io
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generation_limit as gl  # noqa: E402
import tts_worker as w  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)


def _read(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


# 1. 양수 정수 검증기 = 'unavailable' 규약의 파이썬측 단일 소스
class PositiveIntOrNoneTest(unittest.TestCase):
    def test_accepts_positive_int(self):
        self.assertEqual(w._positive_int_or_none(24000), 24000)
        self.assertEqual(w._positive_int_or_none(24000.0), 24000)

    def test_rejects_zero_and_negative_as_none_not_zero(self):
        for bad in (0, -1, -24000, 0.0, -0.5):
            got = w._positive_int_or_none(bad)
            self.assertIsNone(got, repr(bad))
            self.assertNotEqual(got, 0, "0으로 위조 금지")

    def test_rejects_nan_inf(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertIsNone(w._positive_int_or_none(bad), repr(bad))

    def test_rejects_non_numeric_and_bool(self):
        # bool 은 int 하위형이라 True -> 1 로 새어나갈 수 있다. 명시적으로 막는다.
        for bad in (None, "24000", "", True, False, [24000], {"sr": 24000}, object()):
            self.assertIsNone(w._positive_int_or_none(bad), repr(bad))

    def test_never_raises(self):
        # 세션 복원/진단 경로에서 예외로 합성이나 복원을 깨뜨리지 않는다.
        class Boom(object):
            def __int__(self):
                raise RuntimeError("boom")
        self.assertIsNone(w._positive_int_or_none(Boom()))


# 2. chunk 행 자가 완결성(emit shape)
def _chunk_row(entry, layout=None):
    """production 의 gen_chunks 조립과 동일한 형태를 순수하게 재현(생성/모델 불요)."""
    row = {"original_segment_index": entry["original_segment_index"], "chunk_index": entry["chunk_index"],
           "chunk_count": entry["chunk_count"], "production_tokens": entry.get("production_tokens"),
           "generation_limit": entry.get("generation_limit"),
           "generated_iterations": entry.get("generated_iterations"),
           "termination_reason": entry.get("termination_reason"), "emotion_id": entry.get("emotion_id"),
           "output_sample_rate": w._positive_int_or_none(entry.get("sr")),
           "generation_elapsed_sec": w._positive_float_or_none(entry.get("generation_elapsed_sec"))}
    if layout is not None:
        row["frames"] = layout["frames"]
        row["gap_before_samples"] = layout["gap_before_samples"]
        row["start_sample"] = layout["start_sample"]
    return row


_ENTRY = {"original_segment_index": 0, "chunk_index": 0, "chunk_count": 1, "out_path": "C:/job/seg0_c0.wav",
          "sr": 24000, "x_vector_only": False, "emotion_id": "happy", "production_tokens": 30,
          "generation_limit": 247, "generated_iterations": 90, "generation_elapsed_sec": 35.271,
          "termination_reason": "completed_before_limit", "status": "ok"}


class PositiveFloatValidatorTest(unittest.TestCase):
    """_positive_float_or_none — 0 을 거르는 것이 핵심이다(분자의 0 은 거짓 0 s/iter 를 만든다)."""

    def test_accepts_positive_float_and_int(self):
        self.assertEqual(w._positive_float_or_none(35.271), 35.271)
        self.assertEqual(w._positive_float_or_none(1), 1.0)
        self.assertEqual(w._positive_float_or_none(1e-6), 1e-6)

    def test_rejects_zero_and_negative_as_none_not_zero(self):
        for bad in (0, 0.0, -0.0, -1, -35.2):
            got = w._positive_float_or_none(bad)
            self.assertIsNone(got, repr(bad))
            self.assertNotEqual(got, 0, "0 으로 위조하지 않는다: %r" % (bad,))

    def test_rejects_nan_inf(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertIsNone(w._positive_float_or_none(bad), repr(bad))

    def test_rejects_non_numeric_and_bool(self):
        for bad in (None, "35.2", [], {}, True, False):
            self.assertIsNone(w._positive_float_or_none(bad), repr(bad))

    def test_never_raises(self):
        class Weird:
            def __float__(self):
                raise RuntimeError("nope")
        for bad in (Weird(), object(), b"1.0"):
            self.assertIsNone(w._positive_float_or_none(bad))


class ChunkRowShapeTest(unittest.TestCase):
    def test_source_is_the_written_sr(self):
        # bridge 가 실제 기록에 쓴 그 값. 두 번째 진실 소스를 만들지 않는다.
        src = _read(os.path.join(_HERE, "qwen_bridge.py"))
        self.assertIn('sf.write(cpath, d, int(g["sr"]))', src)
        self.assertIn('"sr": int(g["sr"])', src)
        # tts_worker 는 그 entry["sr"] 을 그대로 output_sample_rate 로 승격한다.
        self.assertIn('"output_sample_rate": _positive_int_or_none(e.get("sr"))',
                      _read(os.path.join(_HERE, "tts_worker.py")))
        self.assertEqual(_chunk_row(_ENTRY)["output_sample_rate"], 24000)

    def test_row_is_self_contained_for_duration(self):
        row = _chunk_row(_ENTRY, {"frames": 48000, "gap_before_samples": 0, "start_sample": 0})
        # 상위 dict 없이 이 행만으로 초 계산이 성립한다.
        self.assertEqual(row["frames"] / row["output_sample_rate"], 2.0)

    def test_frames_conditional_absent_is_unavailable_not_zero(self):
        # layout 길이 불일치(테스트 스텁 등) -> frames 미첨부. 현행 버전 실행에서도 일어난다.
        row = _chunk_row(_ENTRY, layout=None)
        self.assertNotIn("frames", row)
        self.assertIsNone(row.get("frames"))
        self.assertNotEqual(row.get("frames"), 0, "결측 frames를 0으로 위조 금지")

    def test_bad_sr_becomes_none_not_zero(self):
        for bad in (0, -24000, float("nan"), float("inf"), None, "24000"):
            e = dict(_ENTRY)
            e["sr"] = bad
            row = _chunk_row(e)
            self.assertIsNone(row["output_sample_rate"], repr(bad))
            self.assertNotEqual(row["output_sample_rate"], 0, "0으로 위조 금지")

    def test_no_sensitive_values_in_row(self):
        row = _chunk_row(_ENTRY, {"frames": 48000, "gap_before_samples": 0, "start_sample": 0})
        blob = json.dumps(row, ensure_ascii=False)
        self.assertNotIn("out_path", row)
        self.assertNotIn("seg0_c0.wav", blob)
        self.assertNotIn("C:/job", blob)
        for k in ("text", "ref_text", "transcript", "ref_audio", "spoken_text"):
            self.assertNotIn(k, row)

    def test_json_round_trip(self):
        rows = [_chunk_row(_ENTRY, {"frames": 48000, "gap_before_samples": 0, "start_sample": 0}),
                _chunk_row(dict(_ENTRY, chunk_index=1, sr=0))]
        meta = w._build_tts_metadata(output_sample_rate=24000, generation_chunks=rows,
                                     speed_postprocessed=False)
        back = json.loads(json.dumps(meta, ensure_ascii=False))
        self.assertEqual(back["generation_chunks"][0]["output_sample_rate"], 24000)
        self.assertIsNone(back["generation_chunks"][1]["output_sample_rate"])
        # 키 자체는 존재해야 한다 — '없는 키'와 '거절된 값'을 소비자가 구분할 필요가 없도록.
        self.assertIn("output_sample_rate", back["generation_chunks"][1])


# 3. 중첩 필드는 allowlist 로 잘리지 않는다(고정 스키마는 상위 키만)
class MetadataAllowlistTest(unittest.TestCase):
    def test_generation_chunks_allowlisted_and_nested_keys_survive(self):
        self.assertIn("generation_chunks", w._METADATA_KEYS)
        rows = [_chunk_row(_ENTRY, {"frames": 48000, "gap_before_samples": 0, "start_sample": 0})]
        meta = w._build_tts_metadata(generation_chunks=rows)
        self.assertEqual(meta["generation_chunks"][0]["output_sample_rate"], 24000)
        self.assertEqual(meta["generation_chunks"][0]["frames"], 48000)

    def test_top_level_contract_unchanged(self):
        # 기존 소비자 호환: 상위 키가 사라지거나 이름이 바뀌지 않았다.
        for k in ("output_sample_rate", "elapsed_seconds", "device", "device_selection_source",
                  "generation_limit", "generated_iterations", "termination_reason",
                  "generation_chunks", "speed_postprocessed", "x_vector_only_mode", "seed"):
            self.assertIn(k, w._METADATA_KEYS, k)

    def test_generation_elapsed_sec_is_per_chunk_not_top_level(self):
        """generation_elapsed_sec 는 chunk 단위 값이며 top-level metadata 키가 아니다.

        chunk 단위여야 하는 이유: generated_iterations 가 chunk 단위이므로 그것으로 나눈
        seconds_per_iteration 이 의미를 가지려면 분자도 같은 chunk 의 값이어야 한다.
        top-level 로 두면 실행당 표본이 1개뿐이라 device별 p95 를 계산할 수 없다."""
        self.assertNotIn("generation_elapsed_sec", w._METADATA_KEYS)
        self.assertIn("generation_elapsed_sec", _chunk_row(_ENTRY))

    def test_elapsed_seconds_is_not_substituted(self):
        """작업 전체 시간(elapsed_seconds)을 생성 시간으로 재사용하지 않는다.

        elapsed_seconds 의 타이머는 장치 선택·참조 평가·모델 로딩·결합·pitch·원자적 배치까지
        포함한다. 두 값은 서로 다른 구간이며, chunk 행에는 전자가 실리지 않는다."""
        self.assertNotIn("elapsed_seconds", _chunk_row(_ENTRY))
        # bridge 가 재는 구간이 blocking 생성 호출 하나임을 소스로 고정한다.
        src = _read(os.path.join(_HERE, "qwen_bridge.py"))
        i_start = src.index("_t_gen = time.monotonic()")
        i_call = src.index("model.generate_voice_clone(", i_start)
        i_stop = src.index("time.monotonic() - _t_gen", i_call)
        # 시작 → 호출 → 정지 순서이고, 그 사이에 다른 무거운 단계가 끼어 있지 않다.
        between = src[i_start:i_stop]
        for forbidden in ("_load_model", "assess_reference", "select_device", "_finish_and_place",
                          "_concat_with_boundaries", "pitch_shift"):
            self.assertNotIn(forbidden, between,
                             "생성 구간 타이머가 %s 까지 감싸면 생성 시간이 아니다" % forbidden)


# 4. metadata frames/sr 가 실제 출력 WAV 와 일치한다(mock — 진짜 합성 없음)
class WavAgreementTest(unittest.TestCase):
    def test_metadata_matches_real_wav_frames_and_rate(self):
        try:
            import numpy as np
            import soundfile as sf
        except ImportError:
            self.skipTest("numpy/soundfile 없음")
        import tempfile
        sr, frames = 24000, 31200      # 1.3초
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "chunk0.wav")
            sf.write(p, np.zeros(frames, dtype="float32"), sr)   # 합성 아님 — 무음 기록
            row = _chunk_row(dict(_ENTRY, sr=sr),
                             {"frames": frames, "gap_before_samples": 0, "start_sample": 0})
            info = sf.info(p)
            self.assertEqual(row["output_sample_rate"], info.samplerate)
            self.assertEqual(row["frames"], info.frames)
            self.assertAlmostEqual(row["frames"] / float(row["output_sample_rate"]),
                                   info.duration, places=9)


# 5. 생산 상수·watchdog 불변(가산 작업이 안전장치를 건드리지 않았다)
class ProductionInvariantsTest(unittest.TestCase):
    def test_generation_limit_constants(self):
        self.assertEqual(gl.SLOPE, 2.9)
        self.assertEqual(gl.BASE, 160)
        self.assertEqual(gl.MIN_LIMIT, 200)
        self.assertEqual(gl.ABS_LIMIT, 256)

    def test_generation_limit_source_literals(self):
        src = _read(os.path.join(_HERE, "generation_limit.py"))
        for line in ("SLOPE = 2.9", "BASE = 160", "MIN_LIMIT = 200", "ABS_LIMIT = 256"):
            self.assertIn(line, src, line)

    def test_qwen_inactivity_seconds(self):
        self.assertEqual(w._QWEN_INACTIVITY_SEC, 280)
        self.assertIn("_QWEN_INACTIVITY_SEC = 280", _read(os.path.join(_HERE, "tts_worker.py")))

    def test_both_watchdog_values(self):
        src = _read(os.path.join(_REPO, "src", "main", "ipc", "audio.ipc.ts"))
        found = re.findall(r"const WATCHDOG_MS = (\d+)", src)
        self.assertEqual(found, ["300000", "300000"], "watchdog 두 값이 모두 300000 이어야 한다")


if __name__ == "__main__":
    unittest.main()
