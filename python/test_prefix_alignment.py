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
import random
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


# ══════════════════════════════════════════════════════════════════════════════
# controlled-prefix 텍스트 조립
# ══════════════════════════════════════════════════════════════════════════════

class ControlledPrefixTextTest(unittest.TestCase):
    """[참조 전사][문장 종결][개행][목표 대사] — 종결 보장과 개행 분리가 계약이다.
    종결부호가 없으면 참조와 목표가 한 문장으로 이어 읽혀 경계(무음)가 생기지 않는다."""

    def test_terminator_added_when_missing(self):
        out = pa.build_controlled_prefix_text("참조 문장입니다", "안녕하세요")
        self.assertEqual(out, "참조 문장입니다.\n안녕하세요")

    def test_existing_terminator_is_kept(self):
        for end in (".", "!", "?", "…", "。", "！", "？"):
            out = pa.build_controlled_prefix_text("참조 문장" + end, "목표 대사")
            self.assertEqual(out, "참조 문장" + end + "\n목표 대사")
            self.assertNotIn(end + ".", out, "이미 종결된 문장에 부호를 덧붙이지 않는다")

    def test_whitespace_is_normalized_so_newline_is_the_only_separator(self):
        out = pa.build_controlled_prefix_text("  참조 문장.  ", "\n\t 목표 대사 ")
        self.assertEqual(out, "참조 문장.\n목표 대사")
        self.assertEqual(out.count("\n"), 1)

    def test_target_is_last_and_unmodified(self):
        out = pa.build_controlled_prefix_text("참조.", "목표 대사입니다")
        self.assertTrue(out.endswith("목표 대사입니다"))
        self.assertEqual(out.split("\n", 1)[1], "목표 대사입니다")

    def test_empty_inputs_raise(self):
        """조립이 성립하지 않으면 조용히 통과시키지 않는다(빈 prefix 로 ICL 을 흉내내지 않는다)."""
        for ref, tgt in (("", "목표"), ("   ", "목표"), ("참조.", ""), ("참조.", "   ")):
            with self.assertRaises(ValueError):
                pa.build_controlled_prefix_text(ref, tgt)

    def test_ensure_sentence_terminated(self):
        self.assertEqual(pa.ensure_sentence_terminated("가나다"), "가나다.")
        self.assertEqual(pa.ensure_sentence_terminated("가나다?"), "가나다?")
        self.assertEqual(pa.ensure_sentence_terminated("  "), "")


# ══════════════════════════════════════════════════════════════════════════════
# 파형 자동 경계(tail_end → onset → valley → cut)
# ══════════════════════════════════════════════════════════════════════════════

SR24 = 24000  # 실측 표본과 같은 sample rate


def _speech(n, amp=0.30, sr=SR24, f0=180.0, envelope=None):
    """광대역(하모닉 스택) 발화 모사 — 순음보다 실제 발화의 spectral flux 특성에 가깝다."""
    weights = ((1, 1.0), (2, 0.6), (3, 0.45), (4, 0.3), (5, 0.22), (6, 0.16), (7, 0.12), (8, 0.09))
    norm = sum(w for _, w in weights)
    out = []
    for i in range(n):
        t = i / sr
        v = sum(w * math.sin(2 * math.pi * f0 * h * t) for h, w in weights)
        a = amp if envelope is None else amp * envelope(i)
        out.append(a * v / norm)
    return out


def _floor_noise(n, amp, seed=7):
    rng = random.Random(seed)
    return [amp * (rng.random() * 2.0 - 1.0) for _ in range(n)]


def _happy_generation():
    """실측 happy 표본과 같은 좌표를 만드는 합성 신호(SR 24000, hop 5ms = 120 샘플).

    참조 발화 [0, 2640) → 바닥 잡음 → [4200, 4440) 최저 골 → 목표 발화 [5160, …).
    기대: tail_end 2640(110ms) · valley 4200(175ms) · onset 5040(210ms) · 여백 840(35ms).
    이 숫자는 '픽스처 근거'다 — 모듈에는 어떤 고정 offset 상수도 없다."""
    return (_speech(2640)
            + _floor_noise(4200 - 2640, 1e-3, seed=11)
            + _floor_noise(4440 - 4200, 5e-5, seed=12)
            + _floor_noise(5160 - 4440, 1e-3, seed=13)
            + _speech(12000))


class FrameMeasurementTest(unittest.TestCase):
    def test_frame_geometry_10ms_5ms(self):
        win, hop, count = pa.frame_geometry(24000, SR24)
        self.assertEqual((win, hop), (240, 120))
        self.assertEqual(count, 1 + (24000 - 240) // 120)
        self.assertEqual(pa.frame_geometry(100, SR24)[2], 0, "창보다 짧으면 프레임 0")

    def test_frame_levels_match_direct_rms(self):
        wave = _speech(2400)
        levels = pa.frame_levels_dbfs(wave, SR24)
        self.assertAlmostEqual(levels[0], pa.dbfs(pa.rms(wave[0:240])), places=9)
        self.assertAlmostEqual(levels[3], pa.dbfs(pa.rms(wave[360:600])), places=9)

    def test_percentile_is_nearest_rank(self):
        vals = [-90.0, -80.0, -70.0, -60.0, -50.0, -40.0, -30.0, -20.0, -10.0, 0.0]
        self.assertEqual(pa.percentile(vals, 10), -90.0)
        self.assertEqual(pa.percentile(vals, 100), 0.0)
        self.assertIsNone(pa.percentile([], 10))

    def test_median(self):
        self.assertEqual(pa.median([3.0, 1.0, 2.0]), 2.0)
        self.assertEqual(pa.median([4.0, 1.0, 3.0, 2.0]), 2.5)
        self.assertIsNone(pa.median([]), "빈 표본은 0.0 으로 위조하지 않는다")

    def test_spectral_flux_rises_at_speech_onset_and_stays_low_in_noise(self):
        wave = _floor_noise(2400, 1e-3, seed=3) + _speech(2400)
        sig = list(pa.frame_spectral_signals(wave, SR24))
        quiet = [f for f, _ in sig[:15]]
        onset_zone = max(f for f, _ in sig[18:24])
        self.assertLess(max(quiet), pa.ONSET_FLUX_ABS_MIN,
                        "잡음 바닥의 flux 는 절대 최소치를 넘지 않는다")
        self.assertGreater(onset_zone, pa.ONSET_FLUX_ABS_MIN)
        self.assertTrue(all(0.0 <= z <= 1.0 for _, z in sig), "zcr 은 비율(0~1)")


class BoundaryDetectionTest(unittest.TestCase):
    """자동 경계 규칙 — 실측 happy 표본의 좌표 패턴을 합성 신호로 재현한다."""

    def test_detects_measured_pattern(self):
        det = pa.detect_prefix_boundary(_happy_generation(), SR24)
        self.assertTrue(det["ok"], det["reason_code"])
        self.assertEqual(det["reason_code"], pa.REASON_BOUNDARY_OK)
        self.assertEqual(det["hop_samples"], 120)
        self.assertEqual(det["frame_samples"], 240)
        self.assertEqual(det["tail_end_sample"], 2640)   # 110ms — 참조 잔여 소멸
        self.assertEqual(det["valley_sample"], 4200)     # 175ms — 최저 RMS 골
        self.assertEqual(det["cut_sample"], 4200)        # 절단은 골에서
        self.assertEqual(det["onset_sample"], 5040)      # 210ms — 목표 첫 음절
        self.assertEqual(det["lead_samples"], 840)       # 35ms 여백
        self.assertLess(det["valley_dbfs"], det["noise_floor_dbfs"])

    def test_ordering_and_safety_margins_hold(self):
        det = pa.detect_prefix_boundary(_happy_generation(), SR24)
        self.assertLess(det["tail_end_sample"], det["cut_sample"], "tail_end < cut")
        self.assertLess(det["cut_sample"], det["onset_sample"])
        self.assertGreaterEqual(det["lead_samples"], int(pa.MIN_LEAD_SEC * SR24))

    def test_module_never_shapes_the_waveform(self):
        """잔여를 fade/crossfade 로 덮지 않는다 — 이 모듈은 좌표와 dB 만 돌려준다."""
        for name in dir(pa):
            self.assertNotIn("fade", name.lower(), name)
            self.assertNotIn("curve", name.lower(), name)
        det = pa.detect_prefix_boundary(_happy_generation(), SR24)
        for k, v in det.items():
            self.assertNotIsInstance(v, (list, tuple, dict), f"{k} 가 오디오를 돌려주면 안 된다")

    def test_thresholds_follow_the_noise_floor_not_absolute_db(self):
        """잡음 바닥만 12dB 올려도 같은 지점을 고른다 — 판정은 floor 상대값이다."""
        base = _happy_generation()
        louder_floor = list(base)
        for i in range(2640, 5160):          # 참조·목표 발화는 그대로, 바닥만 4배
            louder_floor[i] *= 4.0
        a = pa.detect_prefix_boundary(base, SR24)
        b = pa.detect_prefix_boundary(louder_floor, SR24)
        self.assertTrue(b["ok"], b["reason_code"])
        self.assertGreater(b["noise_floor_dbfs"], a["noise_floor_dbfs"] + 10.0)
        self.assertEqual(a["tail_end_sample"], b["tail_end_sample"])
        self.assertEqual(a["cut_sample"], b["cut_sample"])
        self.assertEqual(a["onset_sample"], b["onset_sample"])


class BoundaryFailClosedTest(unittest.TestCase):
    """못 자를 상황에서는 자르지 않는다 — 전부 ok=False + 사유 코드."""

    def _assert_failed(self, det, reason):
        self.assertFalse(det["ok"])
        self.assertEqual(det["reason_code"], reason)
        self.assertIsNone(det["cut_sample"], "실패면 절단 지점을 내지 않는다")

    def test_empty_or_invalid_input(self):
        self._assert_failed(pa.detect_prefix_boundary([], SR24), pa.REASON_BOUNDARY_EMPTY_INPUT)
        self._assert_failed(pa.detect_prefix_boundary(_speech(2400), 0),
                            pa.REASON_BOUNDARY_EMPTY_INPUT)
        self._assert_failed(pa.detect_prefix_boundary([0.1] * 10, SR24),
                            pa.REASON_BOUNDARY_EMPTY_INPUT)

    def test_tail_end_not_found_in_continuous_speech(self):
        """끊김 없는 발화(음절 억양은 있으나 30ms 무음이 없다) — 참조가 어디서 끝났는지 알 수 없다."""
        def env(i):
            return 0.05 + 0.95 * abs(math.sin(math.pi * i / 1200.0))
        det = pa.detect_prefix_boundary(_speech(24000, envelope=env), SR24)
        self._assert_failed(det, pa.REASON_BOUNDARY_TAIL_END_NOT_FOUND)

    def test_onset_not_found_when_target_never_starts(self):
        wave = _speech(2640) + _floor_noise(20000, 1e-3, seed=21)
        det = pa.detect_prefix_boundary(wave, SR24)
        self._assert_failed(det, pa.REASON_BOUNDARY_ONSET_NOT_FOUND)
        self.assertEqual(det["tail_end_sample"], 2640, "tail_end 까지는 찾았다는 사실은 남는다")

    def test_lead_too_short_when_valley_hugs_the_onset(self):
        """골이 목표 발화 직전에 붙어 여백이 20ms 미만 → 첫 음절을 삼킬 위험 → 절단 금지."""
        gap = 1200  # 50ms — tail_end(30ms) 는 성립하되 여백은 모자라게 만든다
        rng = random.Random(31)
        ramp = [1e-3 * (1.0 - 0.99 * (i / gap)) * (rng.random() * 2.0 - 1.0) for i in range(gap)]
        det = pa.detect_prefix_boundary(_speech(2640) + ramp + _speech(4800), SR24)
        self._assert_failed(det, pa.REASON_BOUNDARY_LEAD_TOO_SHORT)
        self.assertIsNotNone(det["valley_sample"], "왜 실패했는지 볼 수 있게 관측값은 남긴다")

    def test_cut_not_after_tail_end_when_valley_is_the_first_quiet_frame(self):
        """가장 조용한 지점이 tail_end 자신이면(이후가 계속 커지면) 안전 조건 tail_end < cut 불충족."""
        gap = 2400  # 100ms
        rng = random.Random(41)
        ramp = [1e-5 * (1.0 + 60.0 * (i / gap)) * (rng.random() * 2.0 - 1.0) for i in range(gap)]
        det = pa.detect_prefix_boundary(_speech(2640) + ramp + _speech(4800), SR24)
        self._assert_failed(det, pa.REASON_BOUNDARY_CUT_NOT_AFTER_TAIL)

    def test_result_shape_is_stable_on_every_path(self):
        keys = set(pa._BOUNDARY_RESULT_KEYS)
        self.assertEqual(set(pa.detect_prefix_boundary(_happy_generation(), SR24)), keys)
        self.assertEqual(set(pa.detect_prefix_boundary([], 0)), keys)

    def test_summary_carries_only_numbers(self):
        s = pa.boundary_summary(pa.detect_prefix_boundary(_happy_generation(), SR24))
        for k, v in s.items():
            self.assertIsInstance(v, (int, float), k)
        self.assertNotIn("reason_code", s)
        self.assertIsNone(pa.boundary_summary(None))


class LocalBaselineTest(unittest.TestCase):
    """★전역 median 을 쓰면 발화 flux 가 섞여 임계가 부풀어 검출이 실패한다(실측 실패 사례).
    지역 기준(조용한 프레임만)이라는 사실을 회귀로 고정한다."""

    def test_global_baseline_would_miss_the_onset(self):
        """전역 median(발화 프레임 포함)을 기준으로 삼으면 db 상승 조건이 영영 성립하지 않는다."""
        wave = _happy_generation()
        det = pa.detect_prefix_boundary(wave, SR24)
        self.assertTrue(det["ok"])
        dbs = pa.frame_levels_dbfs(wave, SR24)
        onset_frame = det["onset_sample"] // det["hop_samples"]
        global_db = pa.median(dbs)                       # 발화가 다수 → 발화 수준으로 부푼다
        floor = pa.percentile(dbs, pa.NOISE_FLOOR_PERCENTILE)
        local_db = pa.median([d for d in dbs if d <= floor + pa.QUIET_BASELINE_MARGIN_DB])
        self.assertGreater(global_db, local_db + 30.0, "전역 기준은 발화 수준으로 부푼다")
        self.assertLess(dbs[onset_frame], global_db + pa.ONSET_DB_RISE,
                        "전역 기준이었다면 이 onset 은 임계를 넘지 못한다(=검출 실패)")
        self.assertGreaterEqual(dbs[onset_frame], local_db + pa.ONSET_DB_RISE,
                                "지역 기준이라 검출된다")

    def test_quiet_frames_only_feed_the_baseline(self):
        wave = _happy_generation()
        dbs = pa.frame_levels_dbfs(wave, SR24)
        floor = pa.percentile(dbs, pa.NOISE_FLOOR_PERCENTILE)
        quiet_idx = [i for i, d in enumerate(dbs) if d <= floor + pa.QUIET_BASELINE_MARGIN_DB]
        self.assertTrue(quiet_idx)
        # 참조 발화(프레임 0~21)와 목표 발화(42~)는 조용한 표본에 들어가지 않는다.
        self.assertTrue(all(22 <= i <= 42 for i in quiet_idx), quiet_idx[:5])


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
