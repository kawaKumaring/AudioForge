# -*- coding: utf-8 -*-
"""controlled-prefix 생성·절단의 bridge 계약(참조혼입 대응) — 모델·GPU 없음(가짜 모델).

고정하는 계약:
  - 조립: prefix_text 가 있으면 생성 텍스트 = [참조 전사][문장 종결][개행][목표 대사].
    없으면 목표 대사 그대로(기존 동작 불변).
  - 상한: 동적 max_new_tokens 는 **결합 텍스트** 토큰 수로 산정한다(공식 자체는 그대로).
    상한이 모자라면 잘린 결과를 채택하지 않고 GENERATION_LIMIT_EXCEEDED 로 실패한다.
  - 절단: **bridge 는 자르지 않는다**. controlled-prefix raw 를 그대로 chunk WAV 로 쓰고
    needs_alignment/alignment_request 를 부모에게 넘긴다(중간 산출물). 파형만으로는 목표 대사
    시작을 특정할 수 없고(참조 발화 내부 무음이 더 길다 — prefix_alignment §D 실측) 텍스트 정렬이
    필요한데 이 venv 에는 whisper 가 없다. 실제 정렬·절단 계약은 test_icl_alignment.py 가 고정한다.
  - 기록: bridge 단계의 reference_alignment/reference_cut_sample 은 아직 None 이다 —
    부모가 정렬을 끝낸 뒤에만 채워진다(미정렬 raw 가 결과로 확정될 수 없다).
"""
import math
import os
import random
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chunk_budget as cb
import generation_limit as gl  # noqa: E402
import qwen_bridge  # noqa: E402

# 가짜 모델에는 vendor speech tokenizer 가 없다 — 참조 codec 프레임 측정기를 고정값(85 frame ≈ 7초)으로 대체.
# production 측정 실패는 예외(fail-closed)라 여기서만 바꿔 끼운다.
qwen_bridge.REF_FRAMES_MEASURER = lambda _model, _seg: 85

SR = 24000
REF_TEXT = "참조 음성의 원래 대사입니다"
TARGET_TEXT = "안녕하세요 오늘 좋은 소식이 있습니다"


def _speech(n, amp=0.30, f0=180.0, envelope=None):
    weights = ((1, 1.0), (2, 0.6), (3, 0.45), (4, 0.3), (5, 0.22), (6, 0.16), (7, 0.12), (8, 0.09))
    norm = sum(w for _, w in weights)
    out = []
    for i in range(n):
        v = sum(w * math.sin(2 * math.pi * f0 * h * (i / SR)) for h, w in weights)
        a = amp if envelope is None else amp * envelope(i)
        out.append(a * v / norm)
    return out


def _noise(n, amp, seed):
    rng = random.Random(seed)
    return [amp * (rng.random() * 2.0 - 1.0) for _ in range(n)]


def _prefixed_wave():
    """실측 happy 표본과 같은 좌표: tail_end 2640 · valley/cut 4200 · onset 5040."""
    return (_speech(2640) + _noise(1560, 1e-3, 11) + _noise(240, 5e-5, 12)
            + _noise(720, 1e-3, 13) + _speech(12000))


class _FakeProc:
    """processor 대역 — 텍스트 길이에 비례하는 토큰 수를 돌려준다(결합 텍스트 반영 확인용)."""

    def __init__(self, per_char=1):
        self.per_char = per_char
        self.seen = []

    def __call__(self, text=None, return_tensors=None):
        self.seen.append(text)
        n = max(1, len(text) * self.per_char)
        return {"input_ids": _FakeIds(n)}


class _FakeIds:
    def __init__(self, n):
        self.shape = (1, n)


class _FakeGenModel:
    def __init__(self, wave, sim_iters=100, sr=SR):
        self.wave = wave
        self.sim_iters = sim_iters
        self.sr = sr
        self.received = None

    def generate_voice_clone(self, text=None, language=None, ref_audio=None, ref_text=None,
                             x_vector_only_mode=False, max_new_tokens=None):
        self.received = {"text": text, "ref_text": ref_text, "max_new_tokens": max_new_tokens,
                         "x_vector_only_mode": x_vector_only_mode}
        qwen_bridge._COUNTER["n"] = self.sim_iters
        return [list(self.wave)], self.sr


def _seg(prefix=REF_TEXT, out_path="o.wav", text=TARGET_TEXT, index=0):
    s = {"index": index, "text": text, "ref_audio": "r.wav", "ref_text": REF_TEXT,
         "x_vector_only": False, "language_name": "Korean", "emotion_id": "default",
         "out_path": out_path}
    if prefix:
        s["prefix_text"] = prefix
    return s


class GenerationTextTest(unittest.TestCase):
    def test_prefix_is_prepended_with_terminator_and_newline(self):
        text, used = qwen_bridge._generation_text(_seg())
        self.assertTrue(used)
        self.assertEqual(text, REF_TEXT + ".\n" + TARGET_TEXT)

    def test_without_prefix_text_is_unchanged(self):
        text, used = qwen_bridge._generation_text(_seg(prefix=None))
        self.assertFalse(used)
        self.assertEqual(text, TARGET_TEXT)

    def test_blank_prefix_is_not_controlled_prefix(self):
        text, used = qwen_bridge._generation_text(_seg(prefix="   "))
        self.assertFalse(used, "공백만 있는 prefix 로 controlled-prefix 를 흉내내지 않는다")
        self.assertEqual(text, TARGET_TEXT)


class GenerateSegmentTest(unittest.TestCase):
    def setUp(self):
        self.builder = lambda t: t
        qwen_bridge._COUNTER["n"] = 0

    def test_limit_uses_combined_text_not_target_only(self):
        """상한은 결합 텍스트 기준 — 참조 발화만큼 늘어난 생성량을 상한이 알고 있어야 한다."""
        proc = _FakeProc()
        m = _FakeGenModel(_prefixed_wave())
        out = qwen_bridge._generate_segment(m, _seg(), self.builder, proc)
        combined = REF_TEXT + ".\n" + TARGET_TEXT
        self.assertEqual(m.received["text"], combined, "모델에 결합 텍스트가 간다")
        self.assertEqual(out["prod_tokens"], len(combined))
        # controlled-prefix 는 참조를 재발화하므로 예산에 replay frame 이 들어간다.
        self.assertEqual(out["generation_limit"],
                         cb.budget_for(len(combined), reference_replay_frames=83)["generation_limit"])
        self.assertGreater(out["prod_tokens"], len(TARGET_TEXT), "목표 대사만 셌으면 과소평가된다")
        self.assertTrue(out["controlled_prefix"])

    def test_icl_still_passes_ref_text_to_vendor(self):
        m = _FakeGenModel(_prefixed_wave())
        qwen_bridge._generate_segment(m, _seg(), self.builder, _FakeProc())
        self.assertEqual(m.received["ref_text"], REF_TEXT)
        self.assertFalse(m.received["x_vector_only_mode"])

    def test_limit_policy_formula_unchanged(self):
        """정책 변경 금지 — compute_max_new_tokens 공식 자체는 그대로 쓴다."""
        self.assertEqual(gl.SLOPE, 2.9)
        self.assertEqual(gl.BASE, 160)
        self.assertEqual(gl.ABS_LIMIT, 256)
        self.assertEqual(gl.MIN_LIMIT, 200)

    def test_limit_reached_is_reported_not_silently_truncated(self):
        proc = _FakeProc()
        combined_tokens = len(REF_TEXT + ".\n" + TARGET_TEXT)
        limit = cb.budget_for(combined_tokens, reference_replay_frames=83)["generation_limit"]
        m = _FakeGenModel(_prefixed_wave(), sim_iters=limit)
        out = qwen_bridge._generate_segment(m, _seg(), self.builder, proc)
        self.assertEqual(out["termination_reason"], "generation_limit")


class _PlanBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_icl_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.out = os.path.join(self.tmp, "segment_qwen_001.wav")
        self.builder = lambda t: t
        qwen_bridge._COUNTER["n"] = 0

    def _run(self, wave, prefix=REF_TEXT):
        seg = _seg(prefix=prefix, out_path=self.out)
        plan = [{"seg": seg, "chunk_index": 0, "chunk_count": 1, "text": seg["text"]}]
        model = _FakeGenModel(wave)
        return qwen_bridge._generate_plan(model, plan, self.builder, _FakeProc(), 1)

    def _read(self, path):
        import soundfile as sf
        d, sr = sf.read(path, dtype="float32")
        return list(d), int(sr)


class RawChunkTest(_PlanBase):
    def test_written_wav_is_the_untrimmed_raw(self):
        """bridge 는 자르지 않는다 — chunk WAV 는 생성 파형 그대로(길이·샘플 동일)."""
        wave = _prefixed_wave()
        entry = self._run(wave)[0]
        got, sr = self._read(entry["out_path"])
        self.assertEqual(sr, SR)
        self.assertEqual(len(got), len(wave), "raw 길이 그대로")
        for i in (0, 1, 2639, 4200, 5040, len(wave) - 1):
            self.assertAlmostEqual(got[i], wave[i], delta=1e-4, msg=f"sample {i}")

    def test_raw_is_marked_unfinished_and_carries_alignment_input(self):
        """미정렬 raw 가 최종 결과로 오인될 수 없다 — needs_alignment 와 정렬 입력이 붙는다."""
        entry = self._run(_prefixed_wave())[0]
        self.assertTrue(entry["controlled_prefix"])
        self.assertTrue(entry["needs_alignment"])
        self.assertIsNone(entry["reference_cut_sample"], "절단 기록은 부모가 채운다")
        self.assertIsNone(entry["reference_alignment"])
        req = entry["alignment_request"]
        self.assertTrue(req["needs_alignment"])
        self.assertEqual(req["prefix_text"], REF_TEXT)
        self.assertEqual(req["target_text"], TARGET_TEXT)
        self.assertEqual(req["sample_rate"], SR)

    def test_bridge_no_longer_judges_boundaries(self):
        """경계 판정은 bridge 에 없다(파형-only 판정은 참조 내부 무음을 고른다 — §D 실측)."""
        self.assertFalse(hasattr(qwen_bridge, "BridgeIclBoundaryFailed"))
        import inspect
        src = inspect.getsource(qwen_bridge._generate_plan)
        self.assertNotIn("detect_prefix_boundary", src)

    def test_without_prefix_nothing_is_marked(self):
        """안전 모드/기존 경로 회귀 — 절단도 기록도 정렬 요청도 없다(바이트 불변)."""
        wave = _speech(4800)
        entry = self._run(wave, prefix=None)[0]
        self.assertIsNone(entry["reference_cut_sample"])
        self.assertIsNone(entry["reference_alignment"])
        self.assertIsNone(entry["alignment_request"])
        self.assertFalse(entry["controlled_prefix"])
        self.assertFalse(entry["needs_alignment"])
        got, _ = self._read(entry["out_path"])
        self.assertEqual(len(got), len(wave))


if __name__ == "__main__":
    unittest.main(verbosity=2)
