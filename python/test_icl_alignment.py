# -*- coding: utf-8 -*-
"""controlled-prefix 정렬·절단(부모 소유)의 계약 — 실모델 없음(ASR 결과만 주입).

★주입하는 것은 '인식 결과'이지 '정답 창'이 아니다. 창은 언제나 production 코드가 만든다.

고정하는 계약:
  - 텍스트로 위치를 먼저 잡는다: 목표 대사 머리 anchor 가 ASR 스트림에서 유일 매치일 것,
    그 anchor **이전**에 참조 고유 3gram 이 실제로 있을 것.
  - 그 anchor 시각 주변 좁은 창 **안에서만** 파형 경계 규칙을 쓴다. 창 밖의 무음은, 그것이
    진짜 경계보다 **더 길어도**, 후보가 될 수 없다(이게 이번 결함의 핵심이다).
  - 좌표 변환: global = window_start_sample + local. 절단 결과 길이·시작 지점으로 고정한다.
  - fail-closed: anchor 부재/중복, 참조 선행 미확인, ASR 실패/무단어, 창 내 경계 미검출,
    cut 이 anchor 뒤 → 예외 + 사유 코드. **파일은 손대지 않는다**(부분 절단본 0).
  - fade/crossfade 없음: 절단 이후 샘플은 원본과 동일.
  - 보안: 요약·예외에 전사 원문·경로가 없다.
"""
import math
import os
import random
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icl_alignment as ia  # noqa: E402
import prefix_alignment as pa  # noqa: E402

SR = 24000
REF_TEXT = "참조 음성의 원래 대사입니다"
TARGET_TEXT = "안녕하세요 오늘 좋은 소식이 있습니다"

# ── 합성 파형 좌표(전부 SR=24000 기준, 프레임 격자 hop=120 에 정확히 맞춘 값) ──
REF_A = 24000          # 참조 앞 문장 1.000s   [0, 24000)
DECOY_GAP = 7200       # 참조 **내부** 무음 300ms [24000, 31200)  ← 진짜 경계보다 길다(함정)
REF_B = 24000          # 참조 뒤 문장 1.000s   [31200, 55200)
REAL_GAP = 3960        # 진짜 경계 무음 165ms  [55200, 59160)
TARGET_N = 48000       # 목표 대사 2.000s      [59160, 107160)

TARGET_ONSET = REF_A + DECOY_GAP + REF_B + REAL_GAP      # 59160
GAP_START = REF_A + DECOY_GAP + REF_B                    # 55200
VALLEY_AT = GAP_START + 1560                             # 56760 (무음 안의 최저점)
TOTAL_N = TARGET_ONSET + TARGET_N                        # 107160


def _speech(n, amp=0.30, f0=180.0, phase0=0.0):
    weights = ((1, 1.0), (2, 0.6), (3, 0.45), (4, 0.3), (5, 0.22), (6, 0.16), (7, 0.12), (8, 0.09))
    norm = sum(w for _, w in weights)
    return [amp * sum(w * math.sin(2 * math.pi * f0 * h * (i / SR) + phase0)
                      for h, w in weights) / norm for i in range(n)]


def _noise(n, amp, seed):
    rng = random.Random(seed)
    return [amp * (rng.random() * 2.0 - 1.0) for _ in range(n)]


def _decoy_wave():
    """참조 발화 안에 '진짜 경계보다 긴' 무음이 있는 생성물 — 실측 표본과 같은 함정 구조."""
    return (_speech(REF_A)
            + _noise(DECOY_GAP, 1e-3, 101)                     # 300ms — 더 길다
            + _speech(REF_B, phase0=0.7)
            + _noise(1560, 1e-3, 102) + _noise(240, 5e-5, 103) + _noise(2160, 1e-3, 104)
            + _speech(TARGET_N, amp=0.35, f0=210.0))


def _words(pairs):
    """[(단어, start, end)] → whisper 결과 형태(segments[*].words[*])."""
    return {"segments": [{"words": [{"word": w, "start": s, "end": e} for w, s, e in pairs]}]}


def _default_asr(onset_sec=TARGET_ONSET / SR):
    """참조가 먼저, 목표가 onset_sec 부터. 실제 인식기처럼 단어 단위 시각만 준다."""
    return _words([
        ("참조", 0.00, 0.45), ("음성의", 0.45, 1.00),
        ("원래", 1.30, 1.80), ("대사입니다", 1.80, 2.30),
        ("안녕하세요", onset_sec, onset_sec + 0.70),
        ("오늘", onset_sec + 0.70, onset_sec + 1.05),
        ("좋은", onset_sec + 1.05, onset_sec + 1.40),
        ("소식이", onset_sec + 1.40, onset_sec + 1.75),
        ("있습니다", onset_sec + 1.75, onset_sec + 2.00),
    ])


class GlobalSearchIsWrongTest(unittest.TestCase):
    """이번 결함의 근거를 회귀로 고정한다 — 파형 전체 탐색은 참조 내부를 고른다."""

    def test_whole_waveform_search_locks_onto_reference_internal_silence(self):
        det = pa.detect_prefix_boundary(_decoy_wave(), SR)
        self.assertTrue(det["ok"], "전역 탐색은 '성공'으로 보고한다 — 그래서 위험하다")
        self.assertLess(det["cut_sample"], GAP_START,
                        "전역 탐색의 cut 은 진짜 경계보다 한참 앞(참조 내부)이다")
        self.assertLess(det["onset_sample"], REF_B + REF_A + DECOY_GAP,
                        "onset 도 참조 뒤 문장의 시작을 목표로 오인한다")

    def test_longest_silence_rule_would_also_fail(self):
        """'가장 긴 침묵'으로 대체해도 참조 내부를 고른다 — 파형-only 규칙은 원리적으로 못 푼다."""
        dips = pa.find_dips(_decoy_wave(), SR)
        longest = max(dips, key=lambda d: d["end_sec"] - d["start_sec"])
        self.assertLess(longest["start_sec"] * SR, GAP_START)


class _AlignBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_icl_align_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.path = os.path.join(self.tmp, "segment_qwen_001_c000.wav")
        self.wave = _decoy_wave()
        self._write(self.path, self.wave)

    @staticmethod
    def _write(path, wave):
        import numpy as np
        import soundfile as sf
        sf.write(path, np.asarray(wave, dtype="float32"), SR)

    @staticmethod
    def _read(path):
        import soundfile as sf
        d, sr = sf.read(path, dtype="float32")
        return list(d), int(sr)

    def _run(self, asr=None, prefix=REF_TEXT, target=TARGET_TEXT):
        result = _default_asr() if asr is None else asr
        return ia.align_and_trim(self.path, prefix, target, lambda p: result)


class WindowedCutTest(_AlignBase):
    def test_cut_lands_in_the_real_boundary_not_the_longer_decoy(self):
        r = self._run()
        self.assertEqual(r["cut_sample"], VALLEY_AT)
        self.assertGreater(r["cut_sample"], GAP_START, "진짜 경계 무음 안에서 잘린다")
        self.assertLess(r["cut_sample"], TARGET_ONSET)

    def test_search_window_is_restricted_to_the_anchor(self):
        s = self._run()["summary"]
        self.assertEqual(s["window_start_sample"],
                         TARGET_ONSET - int(round(pa.ANCHOR_WINDOW_LEAD_SEC * SR)))
        self.assertEqual(s["window_end_sample"],
                         TARGET_ONSET + int(round(pa.ANCHOR_WINDOW_TRAIL_SEC * SR)))
        self.assertEqual(s["anchor_start_sample"], TARGET_ONSET)
        self.assertGreater(s["window_start_sample"], REF_A + DECOY_GAP,
                           "참조 내부 무음(더 긴 침묵)은 창 밖이라 후보가 될 수 없다")

    def test_global_coordinates_are_window_start_plus_local(self):
        """좌표 변환 고정: 같은 창을 직접 잘라 로컬로 재현하면 정확히 offset 만큼 차이난다."""
        s = self._run()["summary"]
        ws, we = s["window_start_sample"], s["window_end_sample"]
        local = pa.detect_prefix_boundary(self.wave[ws:we], SR)
        self.assertTrue(local["ok"])
        for k in ("tail_end_sample", "valley_sample", "onset_sample", "cut_sample"):
            self.assertEqual(s[k], ws + local[k], k)
        self.assertEqual(s["tail_end_sample"], GAP_START)
        self.assertEqual(s["valley_sample"], VALLEY_AT)
        # onset 은 프레임 격자(hop 120) 단위라 실제 시작(59160)을 걸치는 프레임에서 잡힌다.
        # 한 프레임 이상 어긋나면 그건 다른 지점을 본 것이다.
        self.assertIn(s["onset_sample"], (TARGET_ONSET - 120, TARGET_ONSET))
        self.assertEqual(s["lead_samples"], s["onset_sample"] - VALLEY_AT)

    def test_trimmed_file_length_and_samples(self):
        r = self._run()
        self.assertEqual(r["frames_before"], TOTAL_N)
        self.assertEqual(r["frames_after"], TOTAL_N - VALLEY_AT)
        got, sr = self._read(self.path)
        self.assertEqual(sr, SR)
        self.assertEqual(len(got), TOTAL_N - VALLEY_AT)
        # fade/crossfade 없음 — 절단 이후는 원본과 같다(PCM16 양자화 오차만 허용).
        for i in (0, 1, 100, TARGET_ONSET - VALLEY_AT, TARGET_ONSET - VALLEY_AT + 5000,
                  len(got) - 1):
            self.assertAlmostEqual(got[i], self.wave[VALLEY_AT + i], delta=1e-4, msg=f"sample {i}")

    def test_cut_precedes_anchor_word_start(self):
        """첫 자음(마찰음·파열음) 보존 — cut 은 anchor 단어 시작보다 반드시 앞이다."""
        s = self._run()["summary"]
        self.assertLess(s["cut_sample"], s["anchor_start_sample"])
        self.assertLess(s["tail_end_sample"], s["cut_sample"], "tail_end 이후여야 한다")
        self.assertGreaterEqual(s["lead_samples"], int(round(pa.MIN_LEAD_SEC * SR)))

    def test_summary_is_numbers_only(self):
        r = self._run()
        for k, v in r["summary"].items():
            self.assertIsInstance(v, (int, float), k)
        blob = repr(r)
        self.assertNotIn(REF_TEXT, blob)
        self.assertNotIn(TARGET_TEXT, blob)
        self.assertNotIn(self.tmp, blob)

    def test_late_word_timestamp_still_resolves(self):
        """단어 시각이 실제 onset 보다 늦게 보고돼도(창 lead 안이면) 같은 경계를 찾는다."""
        r = self._run(asr=_default_asr(onset_sec=(TARGET_ONSET + 2400) / SR))  # +100ms 지연
        self.assertEqual(r["cut_sample"], VALLEY_AT)


class FailClosedTest(_AlignBase):
    def _assert_fails(self, reason, **kw):
        before = os.path.getsize(self.path)
        with self.assertRaises(ia.IclAlignmentFailed) as cm:
            self._run(**kw)
        self.assertEqual(cm.exception.reason_code, reason)
        self.assertEqual(os.path.getsize(self.path), before, "실패 시 파일을 건드리지 않는다")
        got, _ = self._read(self.path)
        self.assertEqual(len(got), TOTAL_N, "raw 가 그대로 남는다(부분 절단본 0)")
        msg = str(cm.exception)
        self.assertNotIn(REF_TEXT, msg)
        self.assertNotIn(TARGET_TEXT, msg)
        self.assertNotIn(self.tmp, msg)

    def test_anchor_absent_fails(self):
        """목표 대사 머리가 인식 결과에 없으면 어디가 목표인지 모른다."""
        self._assert_fails(pa.REASON_ANCHOR_NOT_FOUND,
                           asr=_words([("참조", 0.0, 0.45), ("음성의", 0.45, 1.0),
                                       ("원래", 1.3, 1.8), ("대사입니다", 1.8, 2.3)]))

    def test_anchor_ambiguous_fails(self):
        """목표 머리가 두 번 이상 나오면 어느 쪽인지 확정할 수 없다."""
        onset = TARGET_ONSET / SR
        self._assert_fails(pa.REASON_ANCHOR_AMBIGUOUS,
                           asr=_words([("안녕하세요", 0.0, 0.6), ("참조", 0.6, 1.0),
                                       ("원래", 1.3, 1.8), ("대사입니다", 1.8, 2.3),
                                       ("안녕하세요", onset, onset + 0.7),
                                       ("오늘", onset + 0.7, onset + 1.0)]))

    def test_reference_not_spoken_first_fails(self):
        """anchor 이전에 참조 고유 3gram 이 없으면 '앞을 잘라낼 참조'가 확인되지 않은 것이다."""
        onset = TARGET_ONSET / SR
        self._assert_fails(pa.REASON_NO_REF_TRIGRAM,
                           asr=_words([("어", 0.2, 0.4), ("음", 1.4, 1.6),
                                       ("안녕하세요", onset, onset + 0.7),
                                       ("오늘", onset + 0.7, onset + 1.0)]))

    def test_asr_failure_fails(self):
        before = os.path.getsize(self.path)

        def _boom(_p):
            raise RuntimeError("whisper 폭발: C:/비밀/경로.wav")
        with self.assertRaises(ia.IclAlignmentFailed) as cm:
            ia.align_and_trim(self.path, REF_TEXT, TARGET_TEXT, _boom)
        self.assertEqual(cm.exception.reason_code, ia.REASON_ASR_FAILED)
        self.assertNotIn("비밀", str(cm.exception), "원 예외 문구(경로 포함)를 옮기지 않는다")
        self.assertEqual(os.path.getsize(self.path), before)

    def test_asr_without_word_timestamps_fails(self):
        self._assert_fails(ia.REASON_ASR_NO_WORDS,
                           asr={"segments": [{"text": TARGET_TEXT}]})

    def test_asr_non_mapping_fails(self):
        before = os.path.getsize(self.path)
        with self.assertRaises(ia.IclAlignmentFailed) as cm:
            ia.align_and_trim(self.path, REF_TEXT, TARGET_TEXT, lambda p: None)
        self.assertEqual(cm.exception.reason_code, ia.REASON_ASR_FAILED)
        self.assertEqual(os.path.getsize(self.path), before)

    def test_empty_text_fails(self):
        self._assert_fails(ia.REASON_EMPTY_TEXT, prefix="")

    def test_no_boundary_inside_window_fails(self):
        """창 안이 끊김 없는 발화면 — 창 밖에 무음이 아무리 많아도 — 자르지 않는다."""
        self._write(self.path, _speech(TOTAL_N))
        with self.assertRaises(ia.IclAlignmentFailed) as cm:
            self._run()
        self.assertIn(cm.exception.reason_code,
                      (pa.REASON_BOUNDARY_TAIL_END_NOT_FOUND, pa.REASON_BOUNDARY_ONSET_NOT_FOUND,
                       pa.REASON_BOUNDARY_CUT_NOT_AFTER_TAIL))
        got, _ = self._read(self.path)
        self.assertEqual(len(got), TOTAL_N)

    def test_anchor_at_the_very_start_fails(self):
        """anchor 가 파형 맨 앞이면 잘라낼 참조 구간 자체가 없다 — 창을 만들 수 없다."""
        self._assert_fails(pa.REASON_BOUNDARY_WINDOW_INVALID, asr=_default_asr(onset_sec=0.0))


class SoftOnsetCalibrationTest(unittest.TestCase):
    """실측 회귀: 실제 목표 대사는 **부드럽게** 시작한다(개시 프레임 flux ≈ 0.15, -43dBFS).

    전역 탐색의 절대 flux 하한 0.5 를 창 안에서도 그대로 쓰면 그 개시를 놓친다 —
    실제 표본에서 PREFIX_BOUNDARY_ONSET_NOT_FOUND 로 실패했다. 창 전용 하한(0.05)이
    그 사이를 지나가게 하되, 창 안 무음 flux(≤0.004 급)와는 여전히 한 자릿수 이상 떨어져 있다."""

    def _soft_wave(self, amp=0.08):
        return (_speech(REF_A) + _noise(DECOY_GAP, 1e-3, 101) + _speech(REF_B, phase0=0.7)
                + _noise(1560, 1e-3, 102) + _noise(240, 5e-5, 103) + _noise(2160, 1e-3, 104)
                + _speech(TARGET_N, amp=amp, f0=210.0))

    def test_thresholds_bracket_the_measured_onset(self):
        self.assertEqual(pa.ONSET_FLUX_ABS_MIN, 0.5, "전역 탐색 기본값은 그대로다")
        self.assertLess(pa.WINDOW_ONSET_FLUX_ABS_MIN, pa.ONSET_FLUX_ABS_MIN)
        wave = self._soft_wave()
        ws = TARGET_ONSET - int(round(pa.ANCHOR_WINDOW_LEAD_SEC * SR))
        we = TARGET_ONSET + int(round(pa.ANCHOR_WINDOW_TRAIL_SEC * SR))
        flux = [f for f, _z in pa.frame_spectral_signals(wave[ws:we], SR)]
        i = (TARGET_ONSET - ws) // 120
        onset_flux = max(flux[i - 1:i + 2])
        quiet_flux = max(flux[(GAP_START - ws) // 120 + 2:i - 1])
        self.assertLess(quiet_flux, pa.WINDOW_ONSET_FLUX_ABS_MIN, "무음은 창 하한 아래")
        self.assertGreater(onset_flux, pa.WINDOW_ONSET_FLUX_ABS_MIN, "실제 개시는 창 하한 위")
        self.assertLess(onset_flux, pa.ONSET_FLUX_ABS_MIN, "그러나 전역 하한은 못 넘는다(실측 상황)")

    def test_windowed_finds_it_and_global_threshold_would_not(self):
        wave = self._soft_wave()
        ws = TARGET_ONSET - int(round(pa.ANCHOR_WINDOW_LEAD_SEC * SR))
        we = TARGET_ONSET + int(round(pa.ANCHOR_WINDOW_TRAIL_SEC * SR))
        ok = pa.detect_prefix_boundary_windowed(wave, SR, TARGET_ONSET / SR)
        self.assertTrue(ok["ok"], ok["reason_code"])
        self.assertEqual(ok["cut_sample"], VALLEY_AT)
        strict = pa.detect_prefix_boundary(wave[ws:we], SR)   # 기본(전역) 하한 0.5
        self.assertFalse(strict["ok"])
        self.assertEqual(strict["reason_code"], pa.REASON_BOUNDARY_ONSET_NOT_FOUND)


class WindowRuleUnitTest(unittest.TestCase):
    """창 생성 규칙 자체(순수) — 상수와 클램프."""

    def test_window_spans_lead_and_trail(self):
        w = pa.alignment_window_samples(1.000, SR, SR * 5)
        self.assertEqual(w["window_start_sample"],
                         24000 - int(round(pa.ANCHOR_WINDOW_LEAD_SEC * SR)))
        self.assertEqual(w["window_end_sample"],
                         24000 + int(round(pa.ANCHOR_WINDOW_TRAIL_SEC * SR)))
        self.assertEqual(w["anchor_start_sample"], 24000)

    def test_window_is_clamped_to_the_waveform(self):
        head = pa.alignment_window_samples(0.200, SR, SR)
        self.assertEqual(head["window_start_sample"], 0, "앞으로 넘치면 0 으로 클램프")
        self.assertTrue(head["ok"])
        tail = pa.alignment_window_samples(0.980, SR, SR)
        self.assertEqual(tail["window_end_sample"], SR, "뒤로 넘치면 파형 끝까지만")
        self.assertTrue(tail["ok"])

    def test_too_short_window_is_rejected(self):
        w = pa.alignment_window_samples(0.010, SR, 300)   # 파형 자체가 300샘플 → 창이 너무 짧다
        self.assertFalse(w["ok"])
        self.assertEqual(w["reason_code"], pa.REASON_BOUNDARY_WINDOW_INVALID)

    def test_bad_inputs_fail_closed(self):
        for args in ((None, SR, SR), (1.0, 0, SR), (1.0, SR, 0), (-1.0, SR, SR),
                     (float("nan"), SR, SR), (1.0, SR, None)):
            self.assertFalse(pa.alignment_window_samples(*args)["ok"], repr(args))

    def test_cut_after_anchor_is_rejected(self):
        """창 안에서 규칙이 통과해도 cut 이 anchor 뒤면 첫 음절을 삼킨다 → 거부."""
        wave = _decoy_wave()
        ok = pa.detect_prefix_boundary_windowed(wave, SR, TARGET_ONSET / SR)
        self.assertTrue(ok["ok"], "정상 anchor 에서는 통과한다")
        self.assertEqual(ok["cut_sample"], VALLEY_AT)
        # anchor 를 valley 지점까지 당기면 — 창(따라서 검출 결과)은 그대로인데 — cut 이 더 이상
        # anchor '앞'이 아니게 된다. lead/trail 을 조정해 창은 정확히 같게 유지한다.
        bad = pa.detect_prefix_boundary_windowed(
            wave, SR, VALLEY_AT / SR, lead_sec=6000 / SR, trail_sec=6000 / SR)
        self.assertEqual(bad["window_start_sample"], ok["window_start_sample"])
        self.assertEqual(bad["window_end_sample"], ok["window_end_sample"])
        self.assertEqual(bad["anchor_start_sample"], VALLEY_AT)
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["reason_code"], pa.REASON_BOUNDARY_CUT_AFTER_ANCHOR)
        self.assertIsNone(bad["cut_sample"])
        self.assertEqual(bad["valley_sample"], VALLEY_AT, "관측값은 남긴다(사후 확인용)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
