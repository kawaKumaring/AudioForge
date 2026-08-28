# -*- coding: utf-8 -*-
"""prefix_alignment(PHASE 2 골격) — 3-신호 순수 정렬 계약 테스트(synthetic 데이터).

고정하는 계약:
  - s1: target anchor(3~5단위) 유일 매치. 모호(복수 매치)/부재를 구분해 fail-closed.
  - s2: anchor 이전에 참조 고유 3gram ≥ 1.
  - s3: anchor 이전 파형 dip(RMS ≤ -28 dBFS) + dip 끝에서 잘랐을 때 유성음.
  - 종합: 세 신호 전부 통과해야 ok — 하나라도 빠지면 사유 코드와 함께 실패(fail-closed).
  - 고정 offset 상수 금지: 결과는 후보 나열이며 최종 cut 위치 필드가 존재하지 않는다.
  - 순수성: 파일 I/O·Whisper·numpy 없이 순수 데이터만 다룬다(소스 검사).

실행: 실모델·오디오 파일 불필요(전부 synthetic).
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prefix_alignment as pa  # noqa: E402

SR = 8000

REF = list("참조문장은이것입니다")      # 참조 전사(prefix 로 발화됨)
TARGET = list("안녕하세요오늘좋은소식")  # target 대사


def _tone(seconds, amp=0.3, freq=220.0):
    n = int(seconds * SR)
    return [amp * math.sin(2 * math.pi * freq * i / SR) for i in range(n)]


def _silence(seconds, amp=0.0005):
    return [amp] * int(seconds * SR)


def _build_waveform(prefix_sec=1.0, gap_sec=0.2, target_sec=2.0):
    """[0, prefix) 발화 + [prefix, prefix+gap) dip + 이후 발화."""
    return _tone(prefix_sec) + _silence(gap_sec) + _tone(target_sec)


def _build_stream(prefix_units, target_units, prefix_sec=1.0, gap_sec=0.2, target_sec=2.0):
    """(unit, start_sec, end_sec) 스트림 — prefix 단위는 [0,prefix), target 단위는 gap 이후."""
    out = []
    if prefix_units:
        step = prefix_sec / len(prefix_units)
        for i, u in enumerate(prefix_units):
            out.append((u, i * step, (i + 1) * step))
    if target_units:
        t0 = prefix_sec + gap_sec
        step = target_sec / len(target_units)
        for i, u in enumerate(target_units):
            out.append((u, t0 + i * step, t0 + (i + 1) * step))
    return out


class RmsDbfsTest(unittest.TestCase):
    def test_rms_and_dbfs_basics(self):
        self.assertEqual(pa.rms([]), 0.0)
        self.assertAlmostEqual(pa.rms([0.5, -0.5]), 0.5)
        self.assertEqual(pa.dbfs(0.0), -120.0)
        self.assertAlmostEqual(pa.dbfs(1.0), 0.0)
        self.assertAlmostEqual(pa.dbfs(0.1), -20.0, places=6)

    def test_dip_threshold_is_contract_value(self):
        self.assertEqual(pa.RMS_DIP_DBFS, -28.0)


class AnchorTest(unittest.TestCase):
    def test_unique_anchor_found(self):
        stream = REF + TARGET
        a = pa.select_unique_anchor(TARGET, stream)
        self.assertTrue(a["ok"])
        self.assertEqual(a["index"], len(REF))
        self.assertGreaterEqual(a["length"], pa.ANCHOR_MIN_UNITS)
        self.assertLessEqual(a["length"], pa.ANCHOR_MAX_UNITS)

    def test_anchor_not_found(self):
        a = pa.select_unique_anchor(TARGET, REF)  # 스트림에 target 이 아예 없다
        self.assertFalse(a["ok"])
        self.assertEqual(a["reason_code"], pa.REASON_ANCHOR_NOT_FOUND)

    def test_anchor_ambiguous_when_head_repeats(self):
        """target 머리 5단위가 스트림에 두 번 → 3~5 전부 모호 → AMBIGUOUS(fail-closed)."""
        head = TARGET[:pa.ANCHOR_MAX_UNITS]
        stream = REF + head + list("잡음") + head + TARGET[pa.ANCHOR_MAX_UNITS:]
        a = pa.select_unique_anchor(TARGET, stream)
        self.assertFalse(a["ok"])
        self.assertEqual(a["reason_code"], pa.REASON_ANCHOR_AMBIGUOUS)

    def test_longer_anchor_disambiguates(self):
        """3단위는 두 곳이지만 4단위는 한 곳 → 유일해지는 최소 길이 채택."""
        stream = REF + TARGET[:3] + list("딴말") + TARGET
        a = pa.select_unique_anchor(TARGET, stream)
        self.assertTrue(a["ok"])
        self.assertEqual(a["length"], 4)

    def test_too_short_target_is_empty_input(self):
        a = pa.select_unique_anchor(list("한둘"), REF + TARGET)
        self.assertFalse(a["ok"])
        self.assertEqual(a["reason_code"], pa.REASON_EMPTY_INPUT)


class RefTrigramTest(unittest.TestCase):
    def test_unique_trigrams_exclude_target(self):
        uniq = pa.unique_ref_trigrams(REF, TARGET)
        self.assertTrue(uniq)
        self.assertTrue(all(t not in pa.unique_ref_trigrams(TARGET, TARGET) for t in uniq))
        self.assertEqual(pa.unique_ref_trigrams(TARGET, TARGET), set())

    def test_hits_counted_only_before_anchor(self):
        stream = REF + TARGET
        anchor_index = len(REF)
        self.assertGreaterEqual(
            pa.ref_trigram_hits_before(stream, anchor_index, REF, TARGET), 1)
        # anchor 가 스트림 맨 앞이면 '이전' 이 없다 → 0
        self.assertEqual(pa.ref_trigram_hits_before(TARGET, 0, REF, TARGET), 0)


class DipTest(unittest.TestCase):
    def test_dip_detected_in_gap(self):
        wave = _build_waveform()
        dips = pa.find_dips(wave, SR)
        self.assertEqual(len(dips), 1)
        d = dips[0]
        self.assertAlmostEqual(d["start_sec"], 1.0, delta=0.05)
        self.assertAlmostEqual(d["end_sec"], 1.2, delta=0.05)
        self.assertLessEqual(d["min_dbfs"], pa.RMS_DIP_DBFS)

    def test_no_dip_in_continuous_speech(self):
        self.assertEqual(pa.find_dips(_tone(2.0), SR), [])

    def test_voiced_after_gap_end_true_and_silence_false(self):
        wave = _build_waveform()
        self.assertTrue(pa.is_voiced_after(wave, SR, 1.2))
        tail_silent = _tone(1.0) + _silence(2.0)
        self.assertFalse(pa.is_voiced_after(tail_silent, SR, 1.2))


class ResolveTest(unittest.TestCase):
    def _happy_inputs(self):
        wave = _build_waveform()
        stream = _build_stream(REF, TARGET)
        return TARGET, REF, stream, wave

    def test_happy_path_ok(self):
        t, r, stream, wave = self._happy_inputs()
        res = pa.resolve_prefix_cut(t, r, stream, wave, SR)
        self.assertTrue(res["ok"])
        self.assertEqual(res["reason_code"], pa.REASON_OK)
        self.assertGreaterEqual(res["ref_trigram_hits"], 1)
        self.assertTrue(res["candidates"])
        self.assertTrue(any(c["ok"] for c in res["candidates"]))
        self.assertAlmostEqual(res["anchor_start_sec"], 1.2, delta=0.05)

    def test_no_final_cut_field(self):
        """고정 offset 금지 — 최종 cut 위치를 고르지 않는다(후보 나열만)."""
        t, r, stream, wave = self._happy_inputs()
        res = pa.resolve_prefix_cut(t, r, stream, wave, SR)
        self.assertNotIn("cut_sec", res)
        self.assertNotIn("cut_sample", res)
        self.assertNotIn("offset", res)
        for c in res["candidates"]:
            self.assertIn("dip", c)          # 후보는 dip '구간'이다 — 지점 선택은 PHASE 3 정책
            self.assertIn("ok", c)

    def test_fail_closed_empty_inputs(self):
        for args in (([], REF), (TARGET, [])):
            res = pa.resolve_prefix_cut(args[0], args[1], _build_stream(REF, TARGET),
                                        _build_waveform(), SR)
            self.assertFalse(res["ok"])
            self.assertEqual(res["reason_code"], pa.REASON_EMPTY_INPUT)
        res = pa.resolve_prefix_cut(TARGET, REF, [], _build_waveform(), SR)
        self.assertFalse(res["ok"])
        res = pa.resolve_prefix_cut(TARGET, REF, _build_stream(REF, TARGET), [], SR)
        self.assertFalse(res["ok"])
        res = pa.resolve_prefix_cut(TARGET, REF, _build_stream(REF, TARGET),
                                    _build_waveform(), 0)
        self.assertFalse(res["ok"])

    def test_fail_closed_anchor_missing(self):
        """스트림에 target 이 없다(생성이 target 을 발화하지 않았다) → anchor 실패."""
        stream = _build_stream(REF, list("전혀다른내용입니다"))
        res = pa.resolve_prefix_cut(TARGET, REF, stream, _build_waveform(), SR)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason_code"], pa.REASON_ANCHOR_NOT_FOUND)

    def test_fail_closed_no_ref_trigram_before_anchor(self):
        """anchor 앞에 참조 고유 3gram 이 없다(prefix 가 발화되지 않았다) → s2 실패."""
        stream = _build_stream([], TARGET, prefix_sec=0.0, gap_sec=1.2)
        res = pa.resolve_prefix_cut(TARGET, REF, stream, _build_waveform(), SR)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason_code"], pa.REASON_NO_REF_TRIGRAM)

    def test_fail_closed_no_dip(self):
        """파형에 dip 가 없다(연속 발화) → s3 실패(NO_DIP)."""
        stream = _build_stream(REF, TARGET, gap_sec=0.2)
        wave = _tone(3.2)  # 끊김 없는 발화
        res = pa.resolve_prefix_cut(TARGET, REF, stream, wave, SR)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason_code"], pa.REASON_NO_DIP)

    def test_fail_closed_cut_not_voiced(self):
        """dip 는 있으나 dip 끝 이후가 무음(발화가 이어지지 않음) → s3 실패(CUT_NOT_VOICED)."""
        stream = _build_stream(REF, TARGET)
        wave = _tone(1.0) + _silence(2.2)  # dip 이후 계속 무음
        res = pa.resolve_prefix_cut(TARGET, REF, stream, wave, SR)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason_code"], pa.REASON_CUT_NOT_VOICED)

    def test_result_shape_is_stable(self):
        """실패 경로 포함 항상 같은 형태(상위가 그대로 기록 가능)."""
        keys = {"ok", "reason_code", "anchor", "anchor_start_sec", "ref_trigram_hits", "candidates"}
        t, r, stream, wave = self._happy_inputs()
        self.assertEqual(set(pa.resolve_prefix_cut(t, r, stream, wave, SR)), keys)
        self.assertEqual(set(pa.resolve_prefix_cut([], [], [], [], 0)), keys)


class PurityTest(unittest.TestCase):
    def test_module_is_pure_stdlib(self):
        """생성 경로 미배선 골격 — 오디오/모델/파일 의존이 소스에 없어야 한다."""
        src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prefix_alignment.py")
        with open(src_path, "r", encoding="utf-8") as f:
            src = f.read()
        for banned in ("import numpy", "import soundfile", "import torch", "import whisper",
                       "subprocess", "open(", "qwen", "tts_worker"):
            self.assertNotIn(banned, src, banned)


if __name__ == "__main__":
    unittest.main(verbosity=2)
