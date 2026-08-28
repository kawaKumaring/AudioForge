# -*- coding: utf-8 -*-
"""audio_finishing.py 단위 테스트 — SYNTHETIC 신호만(사용자 음성/워크플로우 미사용).

실행 환경 주의(정직 보고):
  - audio_finishing는 numpy에 의존한다. numpy가 있으면 순수 array 테스트가 **여기서 실제 실행**된다.
    numpy가 없으면(원래 fresh 워크트리 가정) 전 스위트를 skip한다 — "requires shared qwen venv — integration
    owner verifies at review".
  - tts_worker._finish_and_place 통합 테스트(staging→tail 순서, pitch-fail/finishing-fail 보존, 취소·정리,
    pending 0)는 **soundfile**를 요구한다. soundfile 부재 시 해당 테스트만 skip("requires shared qwen venv
    — integration owner verifies at review"). soundfile가 있으면 실제 실행된다.
  - 두 축을 분리해, 실행되지 않은 스위트를 pass로 주장하지 않는다.

실행:  python -m unittest python/test_audio_finishing.py
"""
import math
import os
import tempfile
import unittest

try:
    import numpy as np
    HAS_NUMPY = True
except Exception:
    HAS_NUMPY = False

try:
    import soundfile as _sf  # noqa: F401
    HAS_SOUNDFILE = True
except Exception:
    HAS_SOUNDFILE = False

_DEFER = "requires shared qwen venv — integration owner verifies at review"

SR = 24000


def _sine(freq=220.0, dur=0.2, sr=SR, amp=0.8, decay=False):
    """SYNTHETIC float32 sine. decay=True면 끝에서 0으로 선형 감쇠(이미 무음 tail)."""
    n = max(1, int(dur * sr))
    t = np.arange(n, dtype=np.float64) / sr
    s = amp * np.sin(2 * math.pi * freq * t)
    if decay:
        s = s * np.linspace(1.0, 0.0, n)
    return s.astype(np.float32)


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class TailPlanAndApply(unittest.TestCase):
    """말끝 fade/padding 순수 array 로직 — numpy만 필요(여기서 실행)."""

    def setUp(self):
        import audio_finishing as af
        self.af = af

    def _cfg(self, **kw):
        base = {"mode": "auto", "pad_ms": 120, "fade_ms": 8}
        base.update(kw)
        return base

    def test_last_sample_nonzero_gets_faded_to_zero(self):
        """flat sine(끝 진폭 큼) → fade 적용, body 마지막 샘플 정확히 0, 이후 padding도 0."""
        s = _sine()
        s[-1] = 0.8  # 끝을 강제로 peak(칼로 자른 듯의 원인 신호)
        plan = self.af.compute_tail_plan(s, SR, self._cfg())
        self.assertTrue(plan.fade_applied)
        self.assertFalse(plan.already_silent)
        out = self.af.apply_final_tail(s, SR, plan)
        pad = int(round(120 * SR / 1000.0))
        body_end = len(out) - pad
        self.assertEqual(out[body_end - 1], 0.0, "fade body 끝 샘플은 정확히 0")
        self.assertTrue(np.all(out[body_end:] == 0.0), "padding 전부 0")

    def test_already_silent_no_fade_padding_only_body_preserved(self):
        """이미 무음 tail(마지막 ≤5ms peak ≤ 1e-4) → fade 미적용, body 원형 보존 + padding만.
        (참고: 선형 decay는 마지막 5ms가 여전히 ~0.02라 1e-4 계약상 '무음' 아님 — 실제 0 tail을 만든다.)"""
        s = _sine()
        s[-int(0.01 * SR):] = 0.0  # 마지막 10ms를 정확히 0으로 → 무음 tail
        plan = self.af.compute_tail_plan(s, SR, self._cfg())
        self.assertTrue(plan.already_silent)
        self.assertFalse(plan.fade_applied)
        out = self.af.apply_final_tail(s, SR, plan)
        self.assertTrue(np.array_equal(out[:len(s)], s), "무음 tail은 body 비변형")
        self.assertEqual(len(out) - len(s), int(round(120 * SR / 1000.0)))

    def test_zero_ms_fade_and_pad(self):
        """fade_ms=0, pad_ms=0 → 길이·내용 불변(단 array 복사)."""
        s = _sine()
        plan = self.af.compute_tail_plan(s, SR, self._cfg(fade_ms=0, pad_ms=0))
        self.assertFalse(plan.fade_applied, "fade_ms=0 → fade 미적용")
        out = self.af.apply_final_tail(s, SR, plan)
        self.assertEqual(len(out), len(s))
        self.assertTrue(np.array_equal(out, s))

    def test_very_short_signal_no_crash(self):
        """수 ms 신호도 예외 없이 fade+padding."""
        s = _sine(dur=0.003)  # ~72 samples
        plan = self.af.compute_tail_plan(s, SR, self._cfg())
        out = self.af.apply_final_tail(s, SR, plan)
        self.assertGreater(len(out), len(s))
        self.assertTrue(np.all(np.isfinite(out)))

    def test_fade_longer_than_file_covers_whole(self):
        """fade_ms가 파일 길이보다 길면 min(fade,len)=len → 전체 fade, 끝 샘플 0."""
        s = _sine(dur=0.005, amp=0.8)  # 120 samples @24k; 20ms fade=480>120
        s[:] = 0.8  # 전부 큰 값(무음 아님)
        plan = self.af.compute_tail_plan(s, SR, self._cfg(fade_ms=20, pad_ms=0))
        self.assertTrue(plan.fade_applied)
        out = self.af.apply_final_tail(s, SR, plan)
        self.assertEqual(len(out), len(s))
        self.assertEqual(out[-1], 0.0, "전체 fade → 끝 샘플 정확히 0")
        self.assertLess(abs(out[0]), 0.8, "첫 샘플도 fade 창에 포함되어 감쇠")

    def test_120ms_exact_frame_count(self):
        s = _sine(decay=True)
        plan = self.af.compute_tail_plan(s, SR, self._cfg(pad_ms=120))
        out = self.af.apply_final_tail(s, SR, plan)
        self.assertEqual(len(out) - len(s), 2880, "120ms @24k = 정확히 2880 샘플")

    def test_cosine_endpoint_exactly_zero(self):
        """cosine fade 창 끝점이 정확히 0(부동소수 오차 없이)."""
        w = self.af._cosine_fade_window(200)
        self.assertEqual(w[-1], 0.0)
        self.assertAlmostEqual(float(w[0]), 0.5 * (1 + math.cos(math.pi / 200)), places=6)
        self.assertTrue(np.all(np.diff(w) <= 1e-7), "단조 감소(1→0)")

    def test_double_apply_blocked(self):
        """같은 plan 두 번 적용 → TAIL_DOUBLE_APPLY(호출자 단계 권위의 방어적 백스톱)."""
        s = _sine()
        plan = self.af.compute_tail_plan(s, SR, self._cfg())
        self.af.apply_final_tail(s, SR, plan)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_final_tail(s, SR, plan)
        self.assertEqual(cm.exception.code, "TAIL_DOUBLE_APPLY")

    def test_off_mode_is_noop(self):
        """config 부재/off → 무변경(레거시 회귀 보존)."""
        s = _sine()
        for cfg in (None, {"mode": "off"}):
            plan = self.af.compute_tail_plan(s, SR, cfg)
            self.assertEqual(plan.mode, "off")
            out = self.af.apply_final_tail(s, SR, plan)
            self.assertTrue(np.array_equal(out, s))

    def test_input_not_mutated(self):
        s = _sine()
        s[-1] = 0.8
        before = s.copy()
        plan = self.af.compute_tail_plan(s, SR, self._cfg())
        self.af.apply_final_tail(s, SR, plan)
        self.assertTrue(np.array_equal(s, before), "apply는 입력 배열을 변형하지 않는다")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class TailConfigValidation(unittest.TestCase):
    """범위 밖 config → INVALID_TTS_CONFIG(조용한 clamp 금지, 계약 §3)."""

    def setUp(self):
        import audio_finishing as af
        self.af = af

    def test_pad_over_range_rejected(self):
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.parse_tail_config({"mode": "auto", "pad_ms": 301, "fade_ms": 8})
        self.assertEqual(cm.exception.code, "INVALID_TTS_CONFIG")

    def test_pad_negative_rejected(self):
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.parse_tail_config({"mode": "auto", "pad_ms": -1, "fade_ms": 8})

    def test_fade_over_range_rejected(self):
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.parse_tail_config({"mode": "auto", "pad_ms": 120, "fade_ms": 21})
        self.assertEqual(cm.exception.code, "INVALID_TTS_CONFIG")

    def test_fade_negative_rejected(self):  # I5-c 경계 매트릭스 완성(fade min-1)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.parse_tail_config({"mode": "auto", "pad_ms": 120, "fade_ms": -1})
        self.assertEqual(cm.exception.code, "INVALID_TTS_CONFIG")

    def test_bad_mode_rejected(self):
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.parse_tail_config({"mode": "crossfade"})

    def test_boundaries_accepted(self):
        self.assertEqual(self.af.parse_tail_config({"mode": "auto", "pad_ms": 0, "fade_ms": 0}).mode, "auto")
        self.assertEqual(self.af.parse_tail_config({"mode": "auto", "pad_ms": 300, "fade_ms": 20}).pad_ms, 300)

    def test_none_and_empty_are_off(self):
        self.assertEqual(self.af.parse_tail_config(None).mode, "off")
        self.assertEqual(self.af.parse_tail_config({}).mode, "off")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ValidateAudioArray(unittest.TestCase):
    """검증 통계 + reject 판정(계약 §4: mono·sr>0·non-empty·finite, NaN/inf·stereo 거부)."""

    def setUp(self):
        import audio_finishing as af
        self.af = af

    def test_mono_ok(self):
        st = self.af.validate_audio_array(_sine(), SR)
        self.assertEqual(st["channels"], 1)
        self.assertTrue(st["finite"])
        self.assertGreater(st["frames"], 0)
        self.af.require_valid_mono(st)  # 예외 없음

    def test_stereo_reported_and_rejected(self):
        stereo = np.stack([_sine(), _sine()], axis=1)  # (frames, 2)
        st = self.af.validate_audio_array(stereo, SR)
        self.assertEqual(st["channels"], 2)
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.require_valid_mono(st)
        self.assertEqual(cm.exception.code, "AUDIO_INVALID")

    def test_nan_inf_rejected(self):
        for bad in (np.nan, np.inf, -np.inf):
            s = _sine()
            s[10] = bad
            st = self.af.validate_audio_array(s, SR)
            self.assertFalse(st["finite"])
            with self.assertRaises(self.af.AudioFinishingError):
                self.af.require_valid_mono(st)

    def test_empty_rejected(self):
        st = self.af.validate_audio_array(np.zeros(0, dtype=np.float32), SR)
        self.assertEqual(st["frames"], 0)
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.require_valid_mono(st)

    def test_bad_sr_rejected(self):
        st = self.af.validate_audio_array(_sine(), 0)
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.require_valid_mono(st)

    def test_no_file_path_accepted(self):
        """validate_audio_array는 array만 받는다(파일 경로 아님) — 계약 명시."""
        st = self.af.validate_audio_array([0.0, 0.1, -0.1], SR)
        self.assertEqual(st["channels"], 1)
        self.assertEqual(st["frames"], 3)


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class ApplyTailGuards(unittest.TestCase):
    def setUp(self):
        import audio_finishing as af
        self.af = af

    def test_sr_mismatch_rejected(self):
        s = _sine()
        plan = self.af.compute_tail_plan(s, SR, {"mode": "auto", "pad_ms": 120, "fade_ms": 8})
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_final_tail(s, 48000, plan)  # plan.sr=24000
        self.assertEqual(cm.exception.code, "AUDIO_SR_MISMATCH")

    def test_stereo_apply_rejected(self):
        stereo = np.stack([_sine(dur=0.02), _sine(dur=0.02)], axis=1)
        plan = self.af.compute_tail_plan(_sine(dur=0.02), SR, {"mode": "auto", "pad_ms": 0, "fade_ms": 0})
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.apply_final_tail(stereo, SR, plan)
        self.assertEqual(cm.exception.code, "AUDIO_INVALID")


@unittest.skipUnless(HAS_NUMPY, _DEFER)
class BoundaryResolution(unittest.TestCase):
    """경계 간격 우선순위(explicit>line>emotion>internal) + 비합산 + immediate/pause."""

    def setUp(self):
        import audio_finishing as af
        self.af = af
        self.B = af.BoundaryDescriptor

    def test_priority_explicit_wins(self):
        d = self.B(explicit_pause_ms=500, is_line_boundary=True, line_gap_ms=300,
                   is_emotion_boundary=True, emotion_gap_ms=200)
        self.assertEqual(self.af.resolve_boundary_gap_ms(d), 500.0)

    def test_priority_line_over_emotion(self):
        d = self.B(is_line_boundary=True, line_gap_ms=300,
                   is_emotion_boundary=True, emotion_gap_ms=200)
        self.assertEqual(self.af.resolve_boundary_gap_ms(d), 300.0)

    def test_emotion_when_only_emotion(self):
        d = self.B(is_emotion_boundary=True, emotion_gap_ms=200, emotion_mode="pause")
        self.assertEqual(self.af.resolve_boundary_gap_ms(d), 200.0)

    def test_internal_is_zero(self):
        self.assertEqual(self.af.resolve_boundary_gap_ms(self.B()), 0.0)

    def test_emotion_immediate_is_zero(self):
        d = self.B(is_emotion_boundary=True, emotion_gap_ms=200, emotion_mode="immediate")
        self.assertEqual(self.af.resolve_boundary_gap_ms(d), 0.0)

    def test_pause_override_non_additive(self):
        """explicit + line + emotion 동시 → 합이 아니라 explicit 하나만(1000이 아니라 500)."""
        d = self.B(explicit_pause_ms=500, is_line_boundary=True, line_gap_ms=300,
                   is_emotion_boundary=True, emotion_gap_ms=200)
        got = self.af.resolve_boundary_gap_ms(d)
        self.assertNotEqual(got, 500 + 300 + 200)
        self.assertEqual(got, 500.0)

    def test_emotion_gap_over_range_rejected(self):
        d = self.B(is_emotion_boundary=True, emotion_gap_ms=1001, emotion_mode="pause")
        with self.assertRaises(self.af.AudioFinishingError) as cm:
            self.af.resolve_boundary_gap_ms(d)
        self.assertEqual(cm.exception.code, "INVALID_TTS_CONFIG")

    def test_bad_emotion_mode_rejected(self):
        d = self.B(is_emotion_boundary=True, emotion_gap_ms=200, emotion_mode="smooth")
        with self.assertRaises(self.af.AudioFinishingError):
            self.af.resolve_boundary_gap_ms(d)

    def test_plan_and_samples(self):
        plan = self.af.resolve_boundary_plan([
            self.B(),                                              # 0
            self.B(is_line_boundary=True, line_gap_ms=300),        # 300
            self.B(explicit_pause_ms=500),                         # 500
        ])
        self.assertEqual(plan, [0.0, 300.0, 500.0])
        self.assertEqual(self.af.gap_ms_to_samples(500, SR), 12000)

    def test_summary_fields(self):
        descs = [self.B(explicit_pause_ms=500), self.B(explicit_pause_ms=250),
                 self.B(is_emotion_boundary=True, emotion_gap_ms=200, emotion_mode="pause")]
        plan = self.af.compute_tail_plan(_sine(), SR, {"mode": "auto", "pad_ms": 120, "fade_ms": 8})
        summ = self.af.summarize_finishing(plan, descs)
        self.assertEqual(summ["explicit_pause_count"], 2)
        self.assertEqual(summ["explicit_pause_total_ms"], 750.0)
        self.assertEqual(summ["emotion_boundary_mode"], "pause")
        self.assertEqual(summ["tail_mode"], "auto")
        self.assertEqual(summ["tail_padding_ms"], 120)


# ──────────────────────────────────────────────────────────────────────────
# tts_worker._finish_and_place 통합 — soundfile 필요. 부재 시 skip(review에서 검증).
# staging→tail 순서 / pitch-fail·finishing-fail 시 기존 final 보존 / 취소·정리 / pending 0.
# ──────────────────────────────────────────────────────────────────────────

@unittest.skipUnless(HAS_NUMPY and HAS_SOUNDFILE, _DEFER)
class FinishAndPlaceIntegration(unittest.TestCase):
    """pitch=0(ffmpeg 불요) + tail로 staging→finishing→원자 교체 경로 실검증 + 실패 시 무손상 보존.
    핵심(root-cause 대응): FLOAT WAV로 써야 비유한이 살아남는다(PCM_16은 write 순간 NaN→유한으로 소실).
    그래서 비유한 검증 테스트는 반드시 subtype='FLOAT' 후보를 쓴다."""

    _AUTO = {"mode": "auto", "pad_ms": 120, "fade_ms": 8}

    def setUp(self):
        from unittest import mock  # stdlib
        import audio_finishing  # noqa: F401
        import tts_worker
        self.mock = mock
        self.af = audio_finishing
        self.tw = tts_worker
        self.dir = tempfile.mkdtemp(prefix="af_finish_")
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, name, samples, subtype=None):
        import soundfile as sf
        p = os.path.join(self.dir, name)
        sf.write(p, samples, SR, subtype=subtype) if subtype else sf.write(p, samples, SR)
        return p

    def _write_float(self, name, samples):
        """subtype='FLOAT' — NaN/inf가 파일을 왕복해도 보존된다(PCM은 소실)."""
        return self._write(name, samples, subtype="FLOAT")

    def _marker_final(self):
        """기존 synthesized.wav를 심어 두고 바이트 스냅샷 반환(실패 후 무손상 확인용)."""
        p = self._write("synthesized.wav", _sine(dur=0.02, freq=440))
        with open(p, "rb") as f:
            return p, f.read()

    def _leftovers_zero(self):
        self.assertFalse(os.path.exists(os.path.join(self.dir, ".af-staged.wav")), "staged 잔여 0")
        self.assertFalse(os.path.exists(os.path.join(self.dir, ".af-finished.wav")), "finished 잔여 0")

    def _run_fail_and_assert_preserved(self, cand, cfg=None, patches=(), pitch=0.0):
        """_finish_and_place가 AudioFinishingError로 실패하면서 (1) os.replace가 final을 대상으로
        호출되지 않음 (2) 기존 final 바이트 무손상 (3) pending 잔여 0 을 모두 단언."""
        cfg = cfg or self._AUTO
        final, prev = self._marker_final()
        real_replace = os.replace
        calls = []

        def spy(src, dst):
            calls.append((os.path.abspath(src), os.path.abspath(dst)))
            return real_replace(src, dst)

        stack = [self.mock.patch("os.replace", side_effect=spy)]
        stack.extend(patches)
        with _nested(stack):
            with self.assertRaises(self.af.AudioFinishingError):
                self.tw._finish_and_place(cand, final, pitch, self.dir, cfg)
        # final이 os.replace의 대상이 된 적 없어야(원자 교체 미도달)
        self.assertNotIn(os.path.abspath(final), [d for _, d in calls], "final은 교체되면 안 됨")
        with open(final, "rb") as f:
            self.assertEqual(f.read(), prev, "실패 시 기존 final 바이트 무손상")
        self._leftovers_zero()

    # ── 정상 경로 ──
    def test_off_path_shape_matches_place_final(self):
        """tail off → place_final_with_pitch와 **길이·sr·pitch가 동일**(레거시 회귀 보존).

        ⚠️ 바이트까지 동일하지는 않다 — 경계 envelope(시작 10ms / 끝 20ms smoothstep)이 tail 설정과
        무관하게 항상 적용되기 때문이다. 사용자 청취로 확정된 결함의 수정이라 옵션이 아니며,
        길이·sample rate·cache key 는 그대로다. 자세한 계약·계측은
        test_boundary_envelope.py 와 doc/boundary-envelope-2026-08-28.md.
        """
        import soundfile as sf
        cand = self._write("cand.wav", _sine(dur=0.05))
        final = os.path.join(self.dir, "synthesized.wav")
        info = self.tw._finish_and_place(cand, final, 0.0, self.dir, None)
        self.assertTrue(os.path.exists(final))
        data, sr = sf.read(final, dtype="float32")
        self.assertEqual(len(data), int(0.05 * SR))  # padding 없음(off) — envelope은 길이 불변
        self.assertEqual(int(sr), SR)
        self.assertEqual(info["pitch_semitones"], 0.0)
        self.assertEqual(info["tail_mode"], "off")

    def test_auto_path_applies_tail_and_atomic_replace(self):
        import soundfile as sf
        s = _sine(dur=0.05)
        s[-1] = 0.8
        cand = self._write("cand.wav", s)  # PCM_16 candidate (engine emulation)
        final = os.path.join(self.dir, "synthesized.wav")
        self.tw._finish_and_place(cand, final, 0.0, self.dir, self._AUTO)
        data, sr = sf.read(final, dtype="float32")
        info = sf.info(final)
        self.assertEqual(len(data), int(0.05 * SR) + 2880, "tail padding 반영")
        self.assertEqual(int(info.samplerate), SR, "메타 sr 유지")
        self.assertEqual(info.subtype, "PCM_16", "auto pitch0 subtype == staged(PCM_16) 패리티")
        self.assertEqual(float(data[-1]), 0.0, "마지막 padding 샘플 정확히 0")
        self.assertTrue(np.all(np.isfinite(data)))
        self._leftovers_zero()

    # ── 서브타입 패리티(auto == legacy off, per pitch) ──
    def _final_subtype(self, tail_cfg, pitch):
        import soundfile as sf
        d = tempfile.mkdtemp(prefix="af_st_", dir=self.dir)
        cand = os.path.join(d, "cand.wav")
        sf.write(cand, _sine(dur=0.05), SR)  # engine emulation: default PCM_16
        final = os.path.join(d, "synthesized.wav")
        self.tw._finish_and_place(cand, final, pitch, d, tail_cfg)
        return sf.info(final).subtype

    def _rubberband(self):
        import pitch_shift
        return bool(pitch_shift.pitch_available()[0])

    def test_legacy_off_subtype_recorded(self):
        """레거시 off: pitch0 → PCM_16, pitch+1 → FLOAT(rubberband 출력, 기존값)."""
        self.assertEqual(self._final_subtype(None, 0.0), "PCM_16")
        if not self._rubberband():
            self.skipTest("rubberband 미지원 — pitch+1 subtype 측정 불가")
        self.assertEqual(self._final_subtype(None, 1.0), "FLOAT")

    def test_auto_subtype_matches_legacy_pitch0(self):
        self.assertEqual(self._final_subtype(None, 0.0), "PCM_16", "legacy off pitch0")
        self.assertEqual(self._final_subtype(self._AUTO, 0.0), "PCM_16", "auto pitch0 == legacy")

    def test_auto_subtype_matches_legacy_pitch1(self):
        if not self._rubberband():
            self.skipTest("rubberband 미지원 — pitch+1 subtype 측정 불가")
        self.assertEqual(self._final_subtype(None, 1.0), "FLOAT", "legacy off pitch+1")
        self.assertEqual(self._final_subtype(self._AUTO, 1.0), "FLOAT", "auto pitch+1 == legacy")

    def test_subtype_mismatch_rejected(self):
        """pending을 staged와 다른 subtype으로 쓰면(주입) 재오픈 검증이 잡아 거부 + final 무손상."""
        import soundfile as sf
        cand = self._write("cand.wav", _sine(dur=0.05))  # pitch0 → staged PCM_16
        real_write = sf.write

        def wrong_write(path, data, samplerate, *a, **k):
            if str(path).endswith(".af-finished.wav"):
                return real_write(path, data, samplerate, subtype="FLOAT")  # staged=PCM_16과 불일치
            return real_write(path, data, samplerate, *a, **k)
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch("soundfile.write", side_effect=wrong_write)])

    # ── 비유한(FLOAT) 차단: write 이전에 source에서 거부 ──
    def test_float_nan_candidate_rejected_preserves_final(self):
        bad = _sine(dur=0.05); bad[5] = np.nan
        cand = self._write_float("cand.wav", bad)
        self._run_fail_and_assert_preserved(cand)

    def test_float_posinf_candidate_rejected_preserves_final(self):
        bad = _sine(dur=0.05); bad[7] = np.inf
        cand = self._write_float("cand.wav", bad)
        self._run_fail_and_assert_preserved(cand)

    def test_float_neginf_candidate_rejected_preserves_final(self):
        bad = _sine(dur=0.05); bad[9] = -np.inf
        cand = self._write_float("cand.wav", bad)
        self._run_fail_and_assert_preserved(cand)

    def test_stereo_candidate_rejected_preserves_final(self):
        st = np.stack([_sine(dur=0.03), _sine(dur=0.03)], axis=1)
        cand = self._write_float("cand.wav", st)
        self._run_fail_and_assert_preserved(cand)

    # ── in-memory finished 검증(B) 실패: apply_final_tail 출력이 비유한/프레임불일치 ──
    def test_apply_output_nonfinite_rejected(self):
        cand = self._write("cand.wav", _sine(dur=0.05))

        def bad_apply(samples, sr, plan):
            out = np.asarray(samples, dtype=np.float32).copy()
            out[0] = np.nan
            return out
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch.object(self.af, "apply_final_tail", side_effect=bad_apply)])

    def test_expected_frame_mismatch_rejected(self):
        cand = self._write("cand.wav", _sine(dur=0.05))

        def short_apply(samples, sr, plan):
            return np.asarray(samples, dtype=np.float32)[:10].copy()  # 잘못된 길이
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch.object(self.af, "apply_final_tail", side_effect=short_apply)])

    # ── write/재오픈(C) 실패 ──
    def test_sf_write_failure_rejected(self):
        import soundfile as sf
        cand = self._write("cand.wav", _sine(dur=0.05))
        real_write = sf.write

        def boom_write(path, data, samplerate, *a, **k):
            if str(path).endswith(".af-finished.wav"):
                raise OSError("disk full (synthetic)")
            return real_write(path, data, samplerate, *a, **k)
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch("soundfile.write", side_effect=boom_write)])

    def test_zero_byte_pending_rejected(self):
        import soundfile as sf
        cand = self._write("cand.wav", _sine(dur=0.05))
        real_write = sf.write

        def empty_write(path, data, samplerate, *a, **k):
            if str(path).endswith(".af-finished.wav"):
                open(path, "wb").close()  # 0바이트 생성
                return
            return real_write(path, data, samplerate, *a, **k)
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch("soundfile.write", side_effect=empty_write)])

    def test_pending_reopen_meta_sr_mismatch_rejected(self):
        import soundfile as sf
        cand = self._write("cand.wav", _sine(dur=0.05))
        real_info = sf.info

        class _FakeInfo:
            def __init__(self, real, bump):
                self.samplerate = real.samplerate + bump  # 재오픈 시 메타 sr 오염
                self.frames = real.frames
                self.subtype = real.subtype

        def fake_info(path, *a, **k):
            real = real_info(path, *a, **k)
            # staged info는 그대로(패리티 subtype 확보), pending 재오픈 info만 sr 오염.
            bump = 1 if str(path).endswith(".af-finished.wav") else 0
            return _FakeInfo(real, bump)
        self._run_fail_and_assert_preserved(
            cand, patches=[self.mock.patch("soundfile.info", side_effect=fake_info)])

    # ── config / pitch 실패 ──
    def test_invalid_config_rejected_before_touch(self):
        cand = self._write("cand.wav", _sine(dur=0.02))
        final, prev = self._marker_final()
        with self.assertRaises(self.af.AudioFinishingError):
            self.tw._finish_and_place(cand, final, 0.0, self.dir, {"mode": "auto", "pad_ms": 999, "fade_ms": 8})
        with open(final, "rb") as f:
            self.assertEqual(f.read(), prev, "config 거부 시 기존 final 무손상")
        self._leftovers_zero()

    def test_pitch_failure_preserves_final(self):
        """pitch 후처리 실패(place_final_with_pitch가 PitchError) → final 무손상, os.replace(final) 미호출."""
        import pitch_shift
        cand = self._write("cand.wav", _sine(dur=0.05))
        final, prev = self._marker_final()
        real_replace = os.replace
        calls = []

        def spy(src, dst):
            calls.append(os.path.abspath(dst))
            return real_replace(src, dst)

        def boom(src, dst_final, semitones, work_dir, **k):
            raise pitch_shift.PitchError("rubberband 없음(synthetic)", code=pitch_shift.PITCH_UNAVAILABLE)
        with self.mock.patch("os.replace", side_effect=spy), \
                self.mock.patch.object(pitch_shift, "place_final_with_pitch", side_effect=boom):
            with self.assertRaises(pitch_shift.PitchError):
                self.tw._finish_and_place(cand, final, 1.0, self.dir, self._AUTO)
        self.assertNotIn(os.path.abspath(final), calls, "pitch 실패 시 final 미교체")
        with open(final, "rb") as f:
            self.assertEqual(f.read(), prev)
        self._leftovers_zero()


def _nested(cms):
    """여러 context manager를 한 with로 — 파이썬 버전 무관 단순 헬퍼(ExitStack)."""
    import contextlib
    stack = contextlib.ExitStack()
    for cm in cms:
        stack.enter_context(cm)
    return stack


if __name__ == "__main__":
    unittest.main(verbosity=2)
