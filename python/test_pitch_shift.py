# -*- coding: utf-8 -*-
"""pitch_shift 백엔드 회귀 — 순수 로직(clamp/ratio) + ffmpeg rubberband 왕복 실측.
계약 tts-prosody-integration-contract §6·§7·§11 준수:
- pitch_method는 production에서 "rubberband" | None 둘뿐(asetrate 폴백 없음).
- clamp_quantize가 정규화 권위, 0은 apply 호출 금지, 실패는 부분출력 삭제 + 예외.
ffmpeg/rubberband 미탐지 환경에서는 왕복 테스트를 skip(순수 로직은 항상 실행)."""
import math
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pitch_shift as ps
from audio_utils import find_ffmpeg


def _estimate_f0(data, sr):
    """유성 톤의 기본주파수를 자기상관으로 추정(단일 정현파 대상, 결정적)."""
    import numpy as np
    x = data.astype("float64")
    x = x - x.mean()
    if not np.any(x):
        return 0.0
    corr = np.correlate(x, x, mode="full")[len(x) - 1:]
    # 최소 주기(80Hz 상한 주파수 대비) 이후의 첫 최대 피크
    lo = int(sr / 800)   # 800Hz까지
    hi = int(sr / 60)    # 60Hz까지
    lo = max(lo, 1)
    seg = corr[lo:hi]
    if seg.size == 0:
        return 0.0
    lag = lo + int(np.argmax(seg))
    return sr / lag if lag > 0 else 0.0


class ClampQuantizeTest(unittest.TestCase):
    def test_clamp_upper_lower(self):
        self.assertEqual(ps.clamp_quantize(2.4), 2.0)
        self.assertEqual(ps.clamp_quantize(3.0), 2.0)
        self.assertEqual(ps.clamp_quantize(-3.0), -2.0)
        self.assertEqual(ps.clamp_quantize(2.0), 2.0)
        self.assertEqual(ps.clamp_quantize(-2.0), -2.0)

    def test_quantize_half_step(self):
        self.assertEqual(ps.clamp_quantize(0.3), 0.5)
        self.assertEqual(ps.clamp_quantize(0.24), 0.0)
        self.assertEqual(ps.clamp_quantize(0.7), 0.5)
        self.assertEqual(ps.clamp_quantize(0.75), 1.0)   # round-half은 파이썬 banker's지만 0.75/0.5=1.5→2*0.5=1.0
        self.assertEqual(ps.clamp_quantize(-0.7), -0.5)
        self.assertEqual(ps.clamp_quantize(1.2), 1.0)

    def test_none_and_nonnumeric_to_zero(self):
        self.assertEqual(ps.clamp_quantize(None), 0.0)
        self.assertEqual(ps.clamp_quantize("x"), 0.0)
        self.assertEqual(ps.clamp_quantize(float("nan")), 0.0)
        self.assertEqual(ps.clamp_quantize(float("inf")), 0.0)

    def test_zero_is_canonical(self):
        # -0.0 등이 0.0으로 정규화되어 == 0.0 게이트가 동작
        z = ps.clamp_quantize(-0.0)
        self.assertEqual(z, 0.0)
        self.assertFalse(z != 0.0)


class RatioTest(unittest.TestCase):
    def test_known_ratios(self):
        self.assertAlmostEqual(ps.semitones_to_ratio(0), 1.0, places=9)
        self.assertAlmostEqual(ps.semitones_to_ratio(12), 2.0, places=9)
        self.assertAlmostEqual(ps.semitones_to_ratio(-12), 0.5, places=9)
        self.assertAlmostEqual(ps.semitones_to_ratio(1), 2 ** (1 / 12), places=9)


class ApplyGuardTest(unittest.TestCase):
    def test_zero_semitone_raises(self):
        # 0은 호출부가 스킵해야 하며 apply 직접 호출은 논리 오류
        with self.assertRaises(ValueError):
            ps.apply_pitch_shift("nonexistent.wav", 0.0, "out.wav")

    def test_missing_input_raises_and_no_partial(self):
        ff = find_ffmpeg()
        if not ff:
            self.skipTest("ffmpeg 없음")
        avail, _ = ps.pitch_available(ff)
        if not avail:
            self.skipTest("rubberband 미지원")
        tmp = tempfile.mkdtemp(prefix="af_pitch_")
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        out = os.path.join(tmp, "out.wav")
        with self.assertRaises(ps.PitchError):
            ps.apply_pitch_shift(os.path.join(tmp, "does_not_exist.wav"), 1.0, out)
        self.assertFalse(os.path.exists(out))  # 부분 출력 미잔류


class RubberbandRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.ff = find_ffmpeg()
        if not self.ff:
            self.skipTest("ffmpeg 없음")
        avail, reason = ps.pitch_available(self.ff)
        if not avail:
            self.skipTest(f"rubberband 미지원({reason})")
        # production 계약: 지원되면 method는 정확히 "rubberband"
        self.assertEqual(reason, "rubberband")
        self.tmp = tempfile.mkdtemp(prefix="af_pitch_rt_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.src = os.path.join(self.tmp, "tone.wav")
        self._make_tone(self.src, freq=220.0, dur=2.0, sr=24000)

    def _make_tone(self, path, freq, dur, sr):
        import numpy as np
        import soundfile as sf
        t = np.arange(int(dur * sr)) / sr
        sig = (0.3 * np.sin(2 * np.pi * freq * t)).astype("float32")
        sf.write(path, sig, sr)

    def _read(self, path):
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data, sr

    def test_up_one_semitone_preserves_length_sr_and_shifts_f0(self):
        import numpy as np
        out = os.path.join(self.tmp, "up1.wav")
        ret = ps.apply_pitch_shift(self.src, 1.0, out)
        self.assertEqual(ret, out)
        src, sr0 = self._read(self.src)
        dst, sr1 = self._read(out)
        # SR 유지
        self.assertEqual(sr0, sr1)
        # 길이 유지(±1 프레임 tolerance보다 넉넉히 ±0.02s)
        self.assertAlmostEqual(len(src) / sr0, len(dst) / sr1, delta=0.02)
        # finite
        self.assertTrue(bool(np.all(np.isfinite(dst))))
        # 클리핑 없음(peak < 1.0)
        self.assertLess(float(np.max(np.abs(dst))), 1.0)
        # F0가 목표 반음(220 * 2^(1/12) ≈ 233.08Hz)으로 상승
        f0_src = _estimate_f0(src, sr0)
        f0_dst = _estimate_f0(dst, sr1)
        target = 220.0 * (2 ** (1 / 12))
        self.assertAlmostEqual(f0_src, 220.0, delta=6.0)
        self.assertAlmostEqual(f0_dst, target, delta=8.0)
        self.assertGreater(f0_dst, f0_src + 5.0)  # 확실히 올라감

    def test_down_preserves_length_and_lowers_f0(self):
        import numpy as np
        out = os.path.join(self.tmp, "down2.wav")
        ps.apply_pitch_shift(self.src, -2.0, out)
        src, sr0 = self._read(self.src)
        dst, sr1 = self._read(out)
        self.assertEqual(sr0, sr1)
        self.assertAlmostEqual(len(src) / sr0, len(dst) / sr1, delta=0.02)
        f0_src = _estimate_f0(src, sr0)
        f0_dst = _estimate_f0(dst, sr1)
        self.assertLess(f0_dst, f0_src - 5.0)  # 확실히 내려감


class PlaceFinalWithPitchTest(unittest.TestCase):
    """공통 최종 단계(계약 §6.1) — 실제 모델 없이 '가짜 최종 WAV'(sine)로 엔진 무관 경로 검증."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_place_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.cand = os.path.join(self.tmp, "candidate.wav")
        self.final = os.path.join(self.tmp, "synthesized.wav")
        self._make_tone(self.cand, freq=220.0, dur=1.5, sr=24000)

    def _make_tone(self, path, freq, dur, sr):
        import numpy as np
        import soundfile as sf
        t = np.arange(int(dur * sr)) / sr
        sig = (0.3 * np.sin(2 * np.pi * freq * t)).astype("float32")
        sf.write(path, sig, sr)

    def _read(self, path):
        import soundfile as sf
        data, sr = sf.read(path, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data, sr

    def test_zero_is_noop_but_places_final(self):
        import numpy as np
        # 기존 final(다른 내용) 존재 → 0이면 candidate가 그대로 final로 배치(무보정, 재인코딩 없음)
        self._make_tone(self.final, freq=440.0, dur=0.5, sr=24000)
        cand_data, cand_sr = self._read(self.cand)
        r = ps.place_final_with_pitch(self.cand, self.final, 0.0, self.tmp)
        self.assertEqual(r["pitch_semitones"], 0.0)
        self.assertIsNone(r["pitch_method"])
        self.assertFalse(r["pitch_postprocessed"])
        self.assertEqual(r["output_sample_rate"], 24000)
        # final 내용이 candidate와 동일(무보정 배치)
        fin_data, fin_sr = self._read(self.final)
        self.assertEqual(fin_sr, cand_sr)
        self.assertEqual(len(fin_data), len(cand_data))
        self.assertTrue(bool(np.allclose(fin_data, cand_data)))
        # candidate는 os.replace로 소비됨
        self.assertFalse(os.path.exists(self.cand))

    def test_pitch_applied_replaces_and_shifts(self):
        import numpy as np
        ff = find_ffmpeg()
        if not ff or not ps.pitch_available(ff)[0]:
            self.skipTest("rubberband 미지원")
        r = ps.place_final_with_pitch(self.cand, self.final, 2.0, self.tmp)
        self.assertEqual(r["pitch_semitones"], 2.0)
        self.assertEqual(r["pitch_method"], "rubberband")
        self.assertTrue(r["pitch_postprocessed"])
        cand_before = 220.0
        fin, sr = self._read(self.final)
        self.assertEqual(sr, 24000)
        # 길이 유지(±0.02s)
        self.assertAlmostEqual(len(fin) / sr, 1.5, delta=0.02)
        self.assertLess(float(np.max(np.abs(fin))), 1.0)  # 클리핑 없음
        f0 = _estimate_f0(fin, sr)
        self.assertGreater(f0, cand_before + 10.0)  # +2반음 → 확실히 상승
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ".pitch-tmp.wav")))  # 임시본 정리됨

    def test_failure_preserves_existing_final(self):
        import numpy as np
        # 기존 final(마커) 존재. candidate가 없으면(검증 실패) final은 os.replace 미도달로 무손상.
        self._make_tone(self.final, freq=330.0, dur=0.7, sr=24000)
        before, before_sr = self._read(self.final)
        missing = os.path.join(self.tmp, "nope.wav")
        with self.assertRaises(Exception):
            ps.place_final_with_pitch(missing, self.final, 0.0, self.tmp)
        after, after_sr = self._read(self.final)
        self.assertEqual(before_sr, after_sr)
        self.assertEqual(len(before), len(after))
        self.assertTrue(bool(np.allclose(before, after)))  # 기존 final 무손상


if __name__ == "__main__":
    unittest.main()
