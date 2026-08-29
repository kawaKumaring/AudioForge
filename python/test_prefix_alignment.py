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


def _short_lead_generation():
    """최저 골이 개시에 붙어 여백이 20ms 에 못 미치지만, **그 앞에 안전 후보가 있는** 생성물.

    무음 구간(50ms)의 잡음이 단조 감쇠해 가장 깊은 지점이 개시 직전(여백 5ms)에 놓인다.
    P5 이전에는 이 상황을 통째로 fail-closed 했다 — 20ms 앞에도 잡음 바닥 이하인 프레임이
    실제로 있는데도 '가장 조용한 한 점'만 봤기 때문이다."""
    gap = 1200  # 50ms — tail_end(30ms) 는 성립하되 최저점의 여백은 모자라게 만든다
    rng = random.Random(31)
    ramp = [1e-3 * (1.0 - 0.99 * (i / gap)) * (rng.random() * 2.0 - 1.0) for i in range(gap)]
    return _speech(2640) + ramp + _speech(4800)


def _slow_residue_then_late_dip():
    """[tail_end, onset-20ms] 안이 전부 잡음 바닥보다 **위**인 생성물(보조 후보 없음).

    참조 잔여가 천천히 죽어 여백 구간에서는 아직 바닥에 닿지 않았고, 진짜 침묵은 개시 직전
    15ms 에만 있다. 좌표(hop=120): tail_end 프레임 10 · 개시 프레임 16 · 최저 골 프레임 15.
    여백 조건을 만족하는 마지막 프레임은 12 인데 11·12 는 바닥보다 위 → 자르지 않는다."""
    return (_speech(1200)
            + _floor_noise(360, 1.35e-3, seed=51)     # [1200,1560) 잔여 — 바닥보다 위
            + _floor_noise(480, 1.0e-3, seed=52)      # [1560,2040) 진짜 침묵(개시 직전)
            + _speech(1680, amp=0.35, f0=210.0))


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

    def test_lead_too_short_when_no_feasible_frame_reaches_the_noise_floor(self):
        """여백이 모자라고 **보조 후보도 없으면** 예전과 똑같이 자르지 않는다.

        P5 이후에도 fail-closed 가 살아 있다는 회귀다. 이 픽스처의 [tail_end, onset-20ms] 안
        프레임은 잡음 바닥보다 위(잔여가 아직 안 죽었다) — 임계를 낮춰 구제하지 않는다."""
        det = pa.detect_prefix_boundary(_slow_residue_then_late_dip(), SR24)
        self._assert_failed(det, pa.REASON_BOUNDARY_LEAD_TOO_SHORT)
        self.assertIsNotNone(det["valley_sample"], "왜 실패했는지 볼 수 있게 관측값은 남긴다")
        self.assertEqual(det["lead_fallback_applied"], 0)
        self.assertEqual(det["lead_fallback_candidates"], 0, "조건을 만족한 후보가 하나도 없다")
        self.assertIsNone(det["lead_fallback_cut_sample"])

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


class LeadFallbackTest(unittest.TestCase):
    """§B5-1 — 최저 골이 최소 여백을 어길 때만 도는 보조 후보 탐색.

    실측 근거(보존 진단 20260829-064419-s1-c2, 24kHz): tail_end 202440 / 최저 골 203040 /
    개시 203400 → 여백 360샘플(15ms)로 480샘플(20ms)에 모자라 fail-closed 했다. 그런데 같은
    구간의 202920 은 -66.50dBFS(최저 골 -66.52dB 와 0.02dB 차이, 잡음 바닥 -63.78dB 보다
    2.72dB 아래)이고 여백은 정확히 480샘플이었다 — 안전 후보가 실제로 있었다."""

    def test_primary_valley_is_untouched_when_the_lead_is_enough(self):
        """[1·7] 여백이 충분하면 보조 탐색은 아예 돌지 않는다 — 기존 값이 한 개도 안 바뀐다."""
        det = pa.detect_prefix_boundary(_happy_generation(), SR24)
        self.assertTrue(det["ok"], det["reason_code"])
        self.assertEqual(det["cut_sample"], 4200)          # 기존 성공 픽스처의 절단 지점 불변
        self.assertEqual(det["valley_sample"], 4200)
        self.assertEqual(det["lead_samples"], 840)
        for k in ("lead_fallback_applied", "lead_fallback_candidates",
                  "lead_fallback_cut_sample", "lead_fallback_cut_dbfs"):
            self.assertIsNone(det[k], f"{k} — 보조 탐색을 타지 않았다는 사실이 남아야 한다")

    def test_short_lead_takes_the_latest_safe_candidate(self):
        """[2] 여백이 모자라면 [tail_end, onset-20ms] 안 '바닥 이하인 가장 늦은 프레임'을 고른다."""
        wave = _short_lead_generation()
        det = pa.detect_prefix_boundary(wave, SR24)
        self.assertTrue(det["ok"], det["reason_code"])
        self.assertEqual(det["lead_fallback_applied"], 1)
        self.assertEqual(det["valley_sample"], 3600, "최저 골 관측값은 그대로 남는다")
        self.assertEqual((det["onset_sample"] - det["valley_sample"]), 120,
                         "기본 골의 여백은 5ms — 그래서 보조 탐색이 돌았다")
        self.assertEqual(det["cut_sample"], 3240)
        self.assertEqual(det["cut_sample"], det["lead_fallback_cut_sample"])
        self.assertEqual(det["lead_samples"], int(round(pa.MIN_LEAD_SEC * SR24)))
        self.assertGreater(det["cut_sample"], det["tail_end_sample"])
        dbs = pa.frame_levels_dbfs(wave, SR24)
        self.assertLessEqual(dbs[det["cut_sample"] // 120], det["noise_floor_dbfs"],
                             "채택 지점은 그 창의 잡음 바닥 이하다")

    def test_fail_closed_when_every_feasible_frame_is_above_the_floor(self):
        """[3] 후보 구간이 비어 있지 않아도 에너지 조건을 못 넘기면 자르지 않는다."""
        det = pa.detect_prefix_boundary(_slow_residue_then_late_dip(), SR24)
        self.assertFalse(det["ok"])
        self.assertEqual(det["reason_code"], pa.REASON_BOUNDARY_LEAD_TOO_SHORT)
        self.assertIsNone(det["cut_sample"])
        self.assertEqual(det["lead_fallback_candidates"], 0)
        hop = det["hop_samples"]
        te, on = det["tail_end_sample"] // hop, det["onset_sample"] // hop
        self.assertGreater(on - 4, te, "후보 구간 자체는 비어 있지 않다(에너지에서 막힌 것이다)")

    def test_empty_feasible_interval_yields_no_candidate(self):
        """[4] 후보 구간이 비면 None — 넓혀서 구제하지 않는다.

        ★파형 경로에서는 이 분기가 사실상 도달 불가다: tail_end 는 6프레임(30ms) 연속 무음의
        첫 프레임이고 개시는 그 무음 안에서 성립할 수 없으므로 onset ≥ tail_end+6 이며,
        여백 4프레임(20ms)을 빼도 tail_end+2 가 남는다. 그래도 계약은 함수 자체로 고정한다."""
        dbs = [-90.0] * 40                      # 전 프레임이 바닥 이하 — 막는 건 범위뿐이다
        self.assertEqual(pa.latest_safe_cut_frame(dbs, 10, 14, 120, 480, -60.0), (None, 0),
                         "onset-4 == tail_end → 열린 구간 (10, 10] 은 비어 있다")
        self.assertEqual(pa.latest_safe_cut_frame(dbs, 10, 13, 120, 480, -60.0), (None, 0))
        self.assertEqual(pa.latest_safe_cut_frame(dbs, 10, 15, 120, 480, -60.0), (11, 1),
                         "한 프레임만 들어오면 그 하나가 채택된다")

    def test_candidate_at_or_before_tail_end_is_rejected(self):
        """[5] tail_end 자신과 그 앞은 후보가 아니다(기존 안전 조건 tail_end < cut 그대로)."""
        dbs = [-90.0] * 40
        for i in range(11, 40):
            dbs[i] = -10.0                      # tail_end 앞·자신만 조용하게 둔다
        self.assertEqual(pa.latest_safe_cut_frame(dbs, 10, 20, 120, 480, -60.0), (None, 0))
        dbs[11] = -90.0
        self.assertEqual(pa.latest_safe_cut_frame(dbs, 10, 20, 120, 480, -60.0), (11, 1))

    def test_first_consonant_burst_is_not_swallowed(self):
        """[6] 목표가 마찰음으로 시작해도 보조 후보는 그 버스트보다 최소 여백만큼 앞이다."""
        rng = random.Random(77)
        gap = 1200
        ramp = [1e-3 * (1.0 - 0.99 * (i / gap)) * (rng.random() * 2.0 - 1.0) for i in range(gap)]
        white = [rng.random() * 2.0 - 1.0 for _ in range(481)]
        burst = [0.05 * (white[i + 1] - white[i]) for i in range(480)]   # 20ms 고역 자음
        burst_start = 2640 + gap
        det = pa.detect_prefix_boundary(_speech(2640) + ramp + burst + _speech(4800), SR24)
        self.assertTrue(det["ok"], det["reason_code"])
        self.assertLessEqual(det["cut_sample"], burst_start - int(round(pa.MIN_LEAD_SEC * SR24)),
                             "첫 자음 시작보다 최소 여백 이상 앞에서 자른다")
        self.assertGreater(det["cut_sample"], det["tail_end_sample"])

    def test_measured_failure_sample_selects_202920(self):
        """[실측 재현] 20260829-064419-s1-c2 의 프레임 dBFS 로 후보 선택만 재현한다.

        파형을 다시 열지 않고 **보고된 수치**만으로 규칙을 검증한다(hop 120 격자 위의 값).
        기대: 202920(-66.50dB, 바닥 -63.78dB 이하) 채택 · 여백 정확히 480샘플."""
        hop, floor = 120, -63.78
        measured = {202440: -61.19, 202560: -62.49, 202680: -64.61,
                    202800: -66.27, 202920: -66.50, 203040: -66.52}
        onset_frame = 203400 // hop
        dbs = [-20.0] * (onset_frame + 4)
        for sample, level in measured.items():
            dbs[sample // hop] = level
        frame, count = pa.latest_safe_cut_frame(dbs, 202440 // hop, onset_frame, hop, 480, floor)
        self.assertEqual(frame * hop, 202920, "실패 표본에서 코드가 고르는 지점")
        self.assertEqual(count, 3, "202680·202800·202920 세 프레임이 조건을 만족한다")
        self.assertEqual((onset_frame - frame) * hop, 480, "여백은 정확히 20.0ms")


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
