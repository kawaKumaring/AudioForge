# -*- coding: utf-8 -*-
"""경계 envelope — 시작·끝이 "S자 없이 딱 켜지고 딱 꺼지는" 결함의 회귀 테스트.

사용자 청취로 확정된 결함이고, 실제 산출 WAV(A2 3종) 계측으로 시작 쪽 계단을 재현했다.
계측 수치와 창 길이 선택 근거는 doc/boundary-envelope-2026-08-28.md.

이 파일이 지키는 것(넷 다 동시에):
  1. 클릭 감소  — 경계의 고역 트랜지언트가 실제로 줄어든다(SYNTHETIC 신호, 정답을 아는 상태에서).
  2. 자음 보존  — 실측된 가장 이른 고역 버스트(8ms) 위치의 감쇠가 1 dB 안이다. **최우선 제약.**
  3. duration 불변 — envelope 은 gain 곱셈뿐이라 프레임 수·sample rate 를 바꾸지 않는다.
  4. cache key 불변 — 경계 envelope 은 캐시 키 입력이 아니다(새 config 필드를 만들지 않았다).

사용자 미디어는 읽지 않는다 — 전부 SYNTHETIC 신호다.
"""
import math
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:                                     # pragma: no cover
    HAS_NUMPY = False

try:
    import soundfile as _sf                             # noqa: F401
    HAS_SOUNDFILE = True
except ImportError:                                     # pragma: no cover
    HAS_SOUNDFILE = False

_DEFER = "numpy/soundfile 부재 — 공유 qwen venv 에서 실행"

SR = 24000
ONSET_N = 240      # 10ms @ 24k
OFFSET_N = 480     # 20ms @ 24k


# ────────────────────────── SYNTHETIC 신호(정답을 아는 재료) ──────────────────────────

def _band_noise(dur=0.6, sr=SR, lo=200.0, hi=3000.0, seed=7, amp=0.2):
    """대역 제한 잡음 — 딱 켜지는 신호. 4kHz 위에는 내용이 **없으므로** 그 위에서 관측되는 것은
    전부 경계가 만든 splatter 다(내용 오염 없는 클릭 계측)."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(dur * sr))
    S = np.fft.rfft(x)
    f = np.fft.rfftfreq(x.size, 1.0 / sr)
    S[(f < lo) | (f > hi)] = 0.0
    y = np.fft.irfft(S, n=x.size)
    return (amp * y / np.max(np.abs(y))).astype(np.float32)


def _burst_at(ms, dur=0.6, sr=SR, burst_ms=4.0, seed=11):
    """t=ms 에 짧은 고역 버스트(파열음 대역)를 심은 낮은 레벨 신호. 자음 보존 계측용."""
    n = int(dur * sr)
    x = (_band_noise(dur, sr, 200.0, 1500.0, seed, 0.05)).astype(np.float64)
    nb = int(round(burst_ms * sr / 1000.0))
    i = int(round(ms * sr / 1000.0))
    rng = np.random.default_rng(seed + 1)
    b = rng.standard_normal(nb)
    S = np.fft.rfft(b)
    f = np.fft.rfftfreq(nb, 1.0 / sr)
    S[f < 2000.0] = 0.0
    b = np.fft.irfft(S, n=nb)
    x[i:i + nb] += 0.4 * b / max(np.max(np.abs(b)), 1e-9)
    return x.astype(np.float32)


def _speech_like(dur=0.6, sr=SR, lead_ms=60.0, seed=5):
    """실측된 결함 signature 를 재현한 신호.

    A2 3종의 공통 형태: 앞 50~70ms 는 최대 프레임의 4~9% 짜리 저레벨 광대역 lead-in 이고,
    주 유성 에너지는 그 뒤에 선다. 그래서 파일이 **sample 0 부터 이미 소리를 담은 채** 시작한다.
    실제 녹음(reference_clip)은 같은 자리가 0.4% 라 켜짐이 들리지 않는다 — 그 차이가 결함이다.
    """
    rng = np.random.default_rng(seed)
    n = int(dur * sr)
    t = np.arange(n) / float(sr)
    v = np.zeros(n)
    for h, a in ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.18), (5, 0.1)):
        v += a * np.sin(2 * np.pi * 190.0 * h * t)
    v /= np.max(np.abs(v))
    body = 0.5 * np.clip((t - lead_ms / 1000.0) / 0.030, 0.0, 1.0) * v
    noise = rng.standard_normal(n)
    S = np.fft.rfft(noise)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    S[f < 200.0] = 0.0
    noise = np.fft.irfft(S, n=n)
    noise /= np.max(np.abs(noise))
    lead = 0.045 * noise * np.clip(1.6 - t / (lead_ms / 1000.0), 0.35, 1.0)
    return (body + lead).astype(np.float32)


def _local_hp(sig):
    """2차 차분 — support 3 샘플짜리 **국소** 고역. 경계의 계단에만 반응한다.

    ⚠️ 전역 FFT brick-wall HP 를 쓰면 안 된다. sinc 누설이 신호 전체에 퍼져 경계 측정에 바닥이
       생기고, 창을 늘려도 값이 더 내려가지 않는 **가짜 포화**가 관측된다(개발 중 실제로 겪었다).
    """
    s = np.asarray(sig, dtype=np.float64)
    out = np.zeros_like(s)
    out[2:] = s[2:] - 2.0 * s[1:-1] + s[:-2]
    return np.abs(out)


def _pad_for_diagnosis(x, sr=SR, pad_sec=1.0):
    """사용자 진단용 무음(앞뒤 1.0초)을 붙인다 — 클릭은 '디지털 무음에서 한 샘플 만에 켜지는 것'
    이라 무음을 붙이지 않으면 관측되지 않는다. 이 무음은 **진단용**이지 fade 길이가 아니다."""
    z = np.zeros(int(round(pad_sec * sr)), dtype=np.float64)
    return np.concatenate([z, np.asarray(x, dtype=np.float64), z]), z.size


def _boundary_ratio(x, sr=SR, at_start=True, radius_ms=3.0):
    """경계 ±3ms 안의 국소 고역 피크 / 본문 고역 median.

    1.0 이하면 '경계가 본문의 평범한 한 지점보다도 튀지 않는다'는 뜻이다.
    참고 실측: 실제 녹음의 시작 경계 0.4 vs 합성 산출 17.7~56.4(= 결함).
    """
    p, off = _pad_for_diagnosis(x, sr)
    hp = _local_hp(p)
    body = hp[off:off + len(x)]
    base = float(np.median(body[body > 0]))
    r = int(round(radius_ms * sr / 1000.0))
    j = off if at_start else off + len(x)
    return float(np.max(hp[max(0, j - r):min(hp.size, j + r)])) / max(base, 1e-15)


def _boundary_peak(x, sr=SR, at_start=True, radius_ms=3.0):
    p, off = _pad_for_diagnosis(x, sr)
    hp = _local_hp(p)
    r = int(round(radius_ms * sr / 1000.0))
    j = off if at_start else off + len(x)
    return float(np.max(hp[max(0, j - r):min(hp.size, j + r)]))


def _interior_peak(x, at_index, sr=SR, radius_ms=3.0):
    """자르지 않은 원본의 같은 지점 — '경계가 아예 없을 때' 의 값(정답)."""
    p, off = _pad_for_diagnosis(x, sr)
    hp = _local_hp(p)
    r = int(round(radius_ms * sr / 1000.0))
    return float(np.max(hp[off + at_index - r:off + at_index + r]))


def _energy_loss_db(a, b, n=None):
    a = np.asarray(a, dtype=np.float64)[:n]
    b = np.asarray(b, dtype=np.float64)[:n]
    ea = float(np.sum(a * a))
    eb = float(np.sum(b * b))
    return -10.0 * math.log10(max(eb, 1e-30) / max(ea, 1e-30))


# ────────────────────────── 창 계약(순수) ──────────────────────────

@unittest.skipUnless(HAS_NUMPY, _DEFER)
class WindowContract(unittest.TestCase):
    """계약 곡선은 smoothstep(3u²−2u³) 하나뿐이다. 곡선이 바뀌면 여기서 깨진다."""

    def setUp(self):
        import audio_finishing
        self.af = audio_finishing

    def test_fade_in_starts_exactly_zero_and_is_monotonic(self):
        w = self.af.smoothstep_fade_in_window(ONSET_N)
        self.assertEqual(len(w), ONSET_N)
        self.assertEqual(float(w[0]), 0.0, "시작점은 정확히 0 — 무음과 만나는 지점")
        self.assertTrue(bool(np.all(np.diff(w) >= 0.0)), "단조 증가")
        self.assertAlmostEqual(float(w[-1]), 1.0, places=3, msg="끝점은 1에 붙는다")

    def test_fade_out_ends_exactly_zero_and_is_monotonic(self):
        w = self.af.smoothstep_fade_out_window(OFFSET_N)
        self.assertEqual(len(w), OFFSET_N)
        self.assertEqual(float(w[-1]), 0.0, "끝점은 정확히 0 — 무음과 만나는 지점")
        self.assertTrue(bool(np.all(np.diff(w) <= 0.0)), "단조 감소")
        self.assertAlmostEqual(float(w[0]), 1.0, places=3)

    def test_curve_is_smoothstep_not_linear_or_cosine(self):
        """u=0.25/0.5/0.75 에서 3u²−2u³ 값과 일치. 곡선 드리프트(선형·cosine 대체) 차단."""
        n = 1000
        w = self.af.smoothstep_fade_in_window(n)
        for u in (0.25, 0.5, 0.75):
            expect = 3 * u * u - 2 * u ** 3
            self.assertAlmostEqual(float(w[int(u * n)]), expect, places=5, msg=f"u={u}")
        # fade-out 은 1 − smoothstep. 위상은 (k+1)/n 이라 인덱스 k 에서 u=(k+1)/n.
        wo = self.af.smoothstep_fade_out_window(n)
        for u in (0.25, 0.5, 0.75):
            k = int(u * n) - 1
            uu = (k + 1) / n
            self.assertAlmostEqual(float(wo[k]), 1.0 - (3 * uu * uu - 2 * uu ** 3), places=5)

    def test_zero_length_window_is_empty(self):
        self.assertEqual(len(self.af.smoothstep_fade_in_window(0)), 0)
        self.assertEqual(len(self.af.smoothstep_fade_out_window(-5)), 0)


# ────────────────────────── plan / apply(순수) ──────────────────────────

@unittest.skipUnless(HAS_NUMPY, _DEFER)
class PlanAndApply(unittest.TestCase):

    def setUp(self):
        import audio_finishing
        self.af = audio_finishing

    def test_default_lengths_are_the_measured_ones(self):
        p = self.af.compute_boundary_plan(SR, SR)
        self.assertEqual(p.onset_samples, ONSET_N, "onset 10ms = 240 sample @24k")
        self.assertEqual(p.offset_samples, OFFSET_N, "offset 20ms = 480 sample @24k")
        self.assertFalse(p.offset_yielded_to_tail)

    def test_offset_yielded_when_tail_owns_the_end(self):
        """tail 'auto' 가 cosine fade 를 걸면 말끝은 tail 소관 — 같은 구간을 두 번 fade 하지 않는다."""
        p = self.af.compute_boundary_plan(SR, SR, tail_owns_offset=True)
        self.assertEqual(p.offset_samples, 0, "offset 양보")
        self.assertEqual(p.onset_samples, ONSET_N, "시작은 tail 과 겹치지 않으므로 그대로")
        self.assertTrue(p.offset_yielded_to_tail)

    def test_short_signal_clamps_without_overlap(self):
        for n in (1, 2, 100, 400, 719):
            p = self.af.compute_boundary_plan(n, SR)
            self.assertLessEqual(p.onset_samples + p.offset_samples, n, f"n={n} 두 창이 겹치면 안 됨")
            self.assertGreaterEqual(p.onset_samples, 0)
            self.assertGreaterEqual(p.offset_samples, 0)

    def test_bad_sr_and_length_rejected(self):
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.compute_boundary_plan(100, 0)
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.compute_boundary_plan(-1, SR)

    def test_duration_and_sample_rate_are_invariant(self):
        """3. duration 불변 — gain 곱셈뿐이라 프레임 수가 바뀌지 않는다."""
        x = _band_noise()
        p = self.af.compute_boundary_plan(len(x), SR)
        y = self.af.apply_boundary_envelope(x, SR, p)
        self.assertEqual(len(y), len(x), "프레임 수 불변")
        self.assertEqual(y.dtype, np.float32)

    def test_input_not_mutated(self):
        x = _band_noise()
        before = x.copy()
        self.af.apply_boundary_envelope(x, SR, self.af.compute_boundary_plan(len(x), SR))
        self.assertTrue(bool(np.array_equal(x, before)), "입력 배열 비변형")

    def test_interior_is_untouched(self):
        """내부는 손대지 않는다 — 내부 chunk 경계에 fade 가 새지 않는다는 구조적 보증."""
        x = np.ones(SR, dtype=np.float32)
        y = self.af.apply_boundary_envelope(x, SR, self.af.compute_boundary_plan(len(x), SR))
        self.assertTrue(bool(np.all(y[ONSET_N:len(y) - OFFSET_N] == 1.0)))
        self.assertEqual(float(y[0]), 0.0)
        self.assertEqual(float(y[-1]), 0.0)

    def test_double_apply_blocked(self):
        """두 번 걸면 gain 이 제곱된다 — 실제로 들리는 사고라 구조적으로 막는다."""
        x = _band_noise()
        p = self.af.compute_boundary_plan(len(x), SR)
        self.af.apply_boundary_envelope(x, SR, p)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_boundary_envelope(x, SR, p)
        self.assertEqual(cm.exception.code, "BOUNDARY_DOUBLE_APPLY")

    def test_sr_mismatch_rejected(self):
        x = _band_noise()
        p = self.af.compute_boundary_plan(len(x), SR)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_boundary_envelope(x, 16000, p)
        self.assertEqual(cm.exception.code, "AUDIO_SR_MISMATCH")

    def test_stereo_rejected(self):
        x = np.zeros((100, 2), dtype=np.float32)
        p = self.af.compute_boundary_plan(100, SR)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_boundary_envelope(x, SR, p)
        self.assertEqual(cm.exception.code, "AUDIO_INVALID")


# ────────────────────────── 1. 클릭 감소 / 2. 자음 보존 ──────────────────────────

@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ClickReductionAndOnsetPreservation(unittest.TestCase):
    """두 기준을 **동시에** 만족함을 수치로 단언한다. 하나만 통과하면 실패로 본다."""

    def setUp(self):
        import audio_finishing
        self.af = audio_finishing

    def _apply(self, x):
        p = self.af.compute_boundary_plan(len(x), SR)
        return self.af.apply_boundary_envelope(x, SR, p)

    def test_repro_abrupt_start_exists_without_envelope(self):
        """결함 재현 — envelope 이 없으면 시작 경계가 본문의 평범한 지점보다 크게 튄다.
        실측 대조: 실제 녹음 0.4 / 합성 산출 17.7~56.4 / 이 SYNTHETIC 7.7."""
        x = _speech_like()
        self.assertGreater(_boundary_ratio(x, at_start=True), 3.0,
                           "무처리 시작 경계가 본문 median 을 크게 넘어야 재현 성립")

    def test_start_click_is_reduced(self):
        """1. 클릭 감소(시작). 실측 감소폭: A2 3종 -22.0~-23.4 dB, 이 SYNTHETIC -18.9 dB."""
        x = _speech_like()
        before = _boundary_ratio(x, at_start=True)
        after = _boundary_ratio(self._apply(x), at_start=True)
        drop_db = 20 * math.log10(after / before)
        self.assertLess(drop_db, -12.0, f"시작 클릭이 12dB 이상 줄어야 함(실측 {drop_db:.1f} dB)")
        self.assertLess(after, 2.0, "경계가 본문 median 수준 이하로 내려와야 함")

    def test_end_click_is_reduced(self):
        """1. 클릭 감소(끝). 실측 -33.6 dB."""
        x = _speech_like()
        before = _boundary_ratio(x, at_start=False)
        after = _boundary_ratio(self._apply(x), at_start=False)
        drop_db = 20 * math.log10(after / before)
        self.assertLess(drop_db, -12.0, f"끝 클릭이 12dB 이상 줄어야 함(실측 {drop_db:.1f} dB)")
        self.assertLess(after, 2.0)

    def test_faded_boundary_is_no_sharper_than_no_boundary(self):
        """창 길이를 고른 **바로 그 기준**을 고정한다.

        발화 한복판에서 잘라 최악의 계단을 만든 뒤 창을 걸었을 때, 그 경계가 '자르지 않은 원본의
        같은 지점'(경계가 아예 없는 상태)보다 날카롭지 않아야 한다. 0 dB 이하 = 계단 소멸.
        실측: onset 10ms → A2 -15.7~-19.1 dB, 이 SYNTHETIC -26.5 dB.
              offset 20ms → A2 -26.3~-28.0 dB, 이 SYNTHETIC -32.8 dB.
        """
        x = _speech_like()
        c = int(0.3 * SR)
        ref = _interior_peak(x, c)

        head = np.asarray(x[c:], dtype=np.float32)
        p_on = self.af.compute_boundary_plan(len(head), SR)
        got_on = _boundary_peak(self.af.apply_boundary_envelope(head, SR, p_on), at_start=True)
        excess_on = 20 * math.log10(got_on / ref)
        self.assertLess(excess_on, -6.0, f"시작 계단 잔여 {excess_on:.1f} dB")

        tail = np.asarray(x[:c], dtype=np.float32)
        p_off = self.af.compute_boundary_plan(len(tail), SR)
        got_off = _boundary_peak(self.af.apply_boundary_envelope(tail, SR, p_off), at_start=False)
        excess_off = 20 * math.log10(got_off / ref)
        self.assertLess(excess_off, -6.0, f"끝 계단 잔여 {excess_off:.1f} dB")

    def test_earliest_measured_consonant_burst_survives(self):
        """2. 자음 보존(최우선 제약) — A2 실측에서 가장 이른 고역 버스트는 8ms 였다.
        그 위치의 감쇠가 1 dB 를 넘으면 onset 이 너무 길다는 뜻이다."""
        g = self.af.smoothstep_fade_in_window(ONSET_N)
        i8 = int(round(8.0 * SR / 1000.0))
        atten_db = -20 * math.log10(float(g[i8]))
        self.assertLess(atten_db, 1.0,
                        f"8ms 버스트 감쇠가 1dB 미만이어야 함(실측 {atten_db:.2f} dB)")

    def test_burst_at_8ms_energy_is_preserved(self):
        """같은 요구를 신호로 확인 — 8ms 에 심은 버스트의 에너지 손실이 1 dB 안."""
        x = _burst_at(8.0)
        y = self._apply(x)
        i = int(round(8.0 * SR / 1000.0))
        n = int(round(4.0 * SR / 1000.0))
        loss = _energy_loss_db(x[i:i + n], y[i:i + n])
        self.assertLess(loss, 1.0, f"8ms 버스트 에너지 손실 {loss:.2f} dB")

    def test_whole_utterance_energy_is_essentially_untouched(self):
        """전체 왜곡은 무시할 수준이어야 한다(A2 실측 0.0003~0.0008 dB)."""
        x = _band_noise(dur=4.8)
        loss = _energy_loss_db(x, self._apply(x))
        self.assertLess(loss, 0.05, f"전체 에너지 손실 {loss:.5f} dB")

    def test_onset_window_does_not_reach_the_voiced_onset(self):
        """A2 3종 모두 주 유성 에너지는 50~70ms 에서 시작했다. 10ms 창은 거기 닿지 않는다."""
        self.assertLess(self.af.BOUNDARY_ONSET_MS, 50.0)
        g = self.af.smoothstep_fade_in_window(ONSET_N)
        self.assertAlmostEqual(float(g[-1]), 1.0, places=3, msg="10ms 지나면 gain 은 사실상 1")


# ────────────────────────── 4. cache key 불변 ──────────────────────────

class CacheKeyInvariance(unittest.TestCase):
    """경계 envelope 은 **캐시 키 입력이 아니다**. 새 config 필드를 만들지 않았으므로
    canonical payload 는 바이트 단위로 그대로여야 한다(같은 텍스트 → 같은 키 → 재생성 없음)."""

    def test_canonical_payload_unchanged(self):
        import emotion_sampler as es
        self.assertEqual(es.canonical_cache_key_payload(es.EMOTION_SAMPLER_PARITY_INPUT),
                         es.EMOTION_SAMPLER_PARITY_PAYLOAD)
        self.assertEqual(es.build_cache_key(es.EMOTION_SAMPLER_PARITY_INPUT),
                         es.EMOTION_SAMPLER_PARITY_KEY)

    def test_no_boundary_field_leaked_into_cache_key(self):
        import emotion_sampler as es
        payload = es.canonical_cache_key_payload(es.EMOTION_SAMPLER_PARITY_INPUT)
        self.assertNotIn("boundary", payload, "경계 envelope 은 캐시 키에 들어가지 않는다")
        self.assertNotIn("onset", payload)


# ────────────────────────── production 배선(_finish_and_place) ──────────────────────────

@unittest.skipUnless(HAS_NUMPY and HAS_SOUNDFILE, _DEFER)
class FinishAndPlaceWiring(unittest.TestCase):
    """단 하나의 최종 조립 지점에서만 적용되고, 적용 샘플 수가 metadata 로 나가는지."""

    _AUTO = {"mode": "auto", "pad_ms": 120, "fade_ms": 8}

    def setUp(self):
        import audio_finishing
        import tts_worker
        self.af = audio_finishing
        self.tw = tts_worker
        self.dir = tempfile.mkdtemp(prefix="af_bound_")
        self.addCleanup(lambda: shutil.rmtree(self.dir, ignore_errors=True))

    def _cand(self, samples, name="cand.wav"):
        import soundfile as sf
        p = os.path.join(self.dir, name)
        sf.write(p, samples, SR)
        return p

    def _run(self, samples, tail_cfg=None):
        import soundfile as sf
        cand = self._cand(samples)
        final = os.path.join(self.dir, "synthesized.wav")
        info = self.tw._finish_and_place(cand, final, 0.0, self.dir, tail_cfg)
        data, sr = sf.read(final, dtype="float32")
        return info, data, sr

    def test_tail_off_default_applies_envelope_and_keeps_duration(self):
        """기본값(tail off)에서 envelope 이 걸리고, 길이·sr 은 그대로다."""
        x = _band_noise(dur=1.0)
        info, data, sr = self._run(x, None)
        self.assertEqual(len(data), len(x), "duration 불변")
        self.assertEqual(sr, SR, "sample rate 불변")
        self.assertEqual(info["boundary_onset_samples"], ONSET_N)
        self.assertEqual(info["boundary_offset_samples"], OFFSET_N)
        self.assertEqual(info["tail_mode"], "off")
        self.assertEqual(float(data[0]), 0.0, "시작이 정확히 0")
        self.assertEqual(float(data[-1]), 0.0, "끝이 정확히 0")

    def test_tail_off_reduces_boundary_transient_on_real_path(self):
        """배선 전체(pitch→envelope→write→재오픈)를 지난 뒤에도 클릭이 줄어 있어야 한다.
        PCM_16 양자화까지 통과한 실제 산출물로 재는 것이 요점이다."""
        x = _speech_like(dur=1.0)
        _, data, _ = self._run(x, None)
        before = _boundary_ratio(x, at_start=True)
        after = _boundary_ratio(data, at_start=True)
        self.assertLess(20 * math.log10(after / before), -12.0)

    def test_tail_auto_yields_the_end_no_double_fade(self):
        """tail auto 가 cosine fade 를 걸면 offset 은 0 으로 기록된다(이중 fade 없음)."""
        x = _band_noise(dur=1.0).copy()
        x[-1] = 0.8                                    # 말끝이 무음이 아님 → tail fade 대상
        info, data, _ = self._run(x, self._AUTO)
        self.assertEqual(info["tail_mode"], "auto")
        self.assertTrue(info["tail_fade_applied"])
        self.assertEqual(info["boundary_offset_samples"], 0, "말끝 권위는 tail")
        self.assertEqual(info["boundary_onset_samples"], ONSET_N, "시작은 여전히 envelope 소관")
        pad = int(round(120 * SR / 1000.0))
        self.assertEqual(len(data), len(x) + pad, "tail padding 만큼만 늘어난다")
        self.assertEqual(float(data[0]), 0.0)

    def test_tail_auto_already_silent_keeps_boundary_offset(self):
        """tail 이 fade 를 걸지 않는 경우(이미 무음)에는 경계 offset 이 그대로 적용된다."""
        x = _band_noise(dur=1.0).copy()
        x[-int(0.05 * SR):] = 0.0                      # 말끝 무음 → already_silent
        info, _, _ = self._run(x, self._AUTO)
        self.assertFalse(info["tail_fade_applied"])
        self.assertEqual(info["boundary_offset_samples"], OFFSET_N)

    def test_metadata_schema_carries_applied_sample_counts(self):
        self.assertIn("boundary_onset_samples", self.tw._METADATA_KEYS)
        self.assertIn("boundary_offset_samples", self.tw._METADATA_KEYS)
        meta = self.tw._build_tts_metadata(boundary_onset_samples=ONSET_N,
                                           boundary_offset_samples=OFFSET_N)
        self.assertEqual(meta["boundary_onset_samples"], ONSET_N)
        self.assertEqual(meta["boundary_offset_samples"], OFFSET_N)


if __name__ == "__main__":
    unittest.main()
