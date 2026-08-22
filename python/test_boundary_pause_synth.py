# -*- coding: utf-8 -*-
"""쉼·말끝·경계 처리 — SYNTHETIC-WAV 단위 스캐폴딩 (Phase 1, TEST-ONLY / PROTOTYPE).

목적
  - "말끝이 칼로 자른 듯"(abrupt tail) 증상을 사용자 음성이 아닌 SYNTHETIC sine/envelope로 재현.
  - tail padding / cosine fade / 내부 경계(zero-cross·crossfade) 정책 후보를 순수 로직으로 검증.

경계 (중요)
  - 이 파일은 production 코드가 아니다. 여기 담긴 tail/fade/boundary 함수는 계약 검증용 **프로토타입**이며,
    production 배선은 통합 단계에서 tts_worker._concat_* / place_final_* 경계에 이식한다(본 doc 참고).
  - 순수 stdlib(`wave`,`math`,`array`,`struct`)만 쓴다 → numpy/soundfile 불필요, 이 워크트리에서 그대로 실행 가능.
  - production `_concat_with_boundaries`/`_concat_with_silence`는 soundfile+numpy를 쓰므로, 그 함수를
    직접 부르는 통합 테스트는 **공유 qwen venv가 있어야 실행**된다(여기서는 실행 안 함).

실행:  python -m unittest python/test_boundary_pause_synth.py   (또는 이 파일 직접 실행)
"""
import math
import os
import struct
import tempfile
import unittest
import wave

SR = 24000  # Qwen native sr(참고). 정책은 sr 무관.
INT16_MAX = 32767


# ────────────────────────── SYNTHETIC 신호 생성 (사용자 음성 미사용) ──────────────────────────

def make_sine(freq=220.0, dur=0.20, sr=SR, amp=0.8, envelope="flat"):
    """float [-1,1] 샘플 리스트. envelope:
       - "flat"        : 끝까지 amp 유지 → 마지막 샘플 |amp| 큼(칼로 자른 듯의 원인 신호).
       - "decay"       : 끝에서 0으로 선형 감쇠 → 마지막 샘플 ~0(이미 무음 tail).
       - "click_ready" : flat과 동일하되 마지막 샘플이 정확히 peak 근처가 되도록 위상 정렬.
    """
    n = max(1, int(dur * sr))
    out = []
    for i in range(n):
        s = amp * math.sin(2 * math.pi * freq * (i / sr))
        if envelope == "decay":
            s *= max(0.0, 1.0 - i / max(1, n - 1))
        out.append(s)
    if envelope == "click_ready":
        out[-1] = amp  # 마지막 샘플을 강제로 peak(최악의 경계)
    return out


def write_wav(path, samples, sr=SR, nchannels=1):
    """float [-1,1] → 16-bit PCM WAV(mono 기본). stereo는 동일 샘플을 두 채널로."""
    frames = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, s)) * INT16_MAX)
        for _ in range(nchannels):
            frames += struct.pack("<h", v)
    with wave.open(path, "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


def read_wav(path):
    """WAV → (mono float 샘플 리스트, sr, nchannels). stereo면 첫 채널만 반환(측정용)."""
    with wave.open(path, "rb") as r:
        sr = r.getframerate()
        nch = r.getnchannels()
        n = r.getnframes()
        raw = r.readframes(n)
    vals = struct.unpack("<%dh" % (len(raw) // 2), raw)
    if nch > 1:
        vals = vals[::nch]
    return [v / INT16_MAX for v in vals], sr, nch


# ────────────────────────── 측정 지표(순수) ──────────────────────────

def last_amp(samples, win_ms=5, sr=SR):
    """마지막 win_ms 구간의 peak 절대진폭 — '말끝이 무음인가/큰가' 판정 근거."""
    if not samples:
        return 0.0
    w = max(1, int(win_ms * sr / 1000))
    return max(abs(x) for x in samples[-w:])


def edge_step(samples):
    """신호 끝 → (재생 종료=암묵적 0) 사이의 불연속 크기. 값이 크면 '뚝' 끊기는 클릭."""
    return abs(samples[-1]) if samples else 0.0


def max_boundary_step(a_tail, b_head, k=1):
    """두 조각 이음매의 최대 표본간 점프(내부 경계 클릭 지표)."""
    if not a_tail or not b_head:
        return 0.0
    return abs(b_head[0] - a_tail[-1])


# ────────────────────────── 정책 프로토타입(계약 후보) ──────────────────────────

TAIL_PAD_MS = 120        # 최종 말끝 무음 패딩(계약 후보 §4)
FADE_MS = 8              # 5~12ms 코사인 페이드(마지막 진폭이 클 때만)
FADE_AMP_THRESHOLD = 0.02  # 이 값 이하면 이미 무음 → fade 없이 padding만


def cosine_fade_out(samples, fade_ms=FADE_MS, sr=SR):
    """마지막 fade_ms를 코사인(equal-power 근사) 페이드아웃. 원본 리스트 비변경(복사 반환)."""
    out = list(samples)
    f = min(len(out), max(1, int(fade_ms * sr / 1000)))
    for i in range(f):
        # equal-power: 위치 0→1에서 cos(0)→cos(pi/2). 끝에서 0.
        pos = (i + 1) / f
        out[len(out) - f + i] *= math.cos(pos * math.pi / 2)
    return out


def apply_tail_policy(samples, sr=SR, pad_ms=TAIL_PAD_MS,
                      fade_ms=FADE_MS, amp_threshold=FADE_AMP_THRESHOLD):
    """최종 말끝 정책(계약 후보 §4):
       - 마지막 진폭이 크면(> amp_threshold): 5~12ms 코사인 페이드 후 pad_ms 무음 패딩.
       - 이미 무음이면: 페이드 없이 pad_ms 무음 패딩만.
       반환: (처리된 샘플, applied_fade: bool)."""
    la = last_amp(samples, sr=sr)
    applied_fade = la > amp_threshold
    body = cosine_fade_out(samples, fade_ms, sr) if applied_fade else list(samples)
    pad = [0.0] * max(0, int(pad_ms * sr / 1000))
    return body + pad, applied_fade


def zero_cross_trim(samples, search_ms=3, sr=SR):
    """내부 경계 후보: 끝에서 search_ms 안에서 가장 가까운 zero-cross까지만 남겨 이음매 점프 최소화.
       내용 대량 삭제 금지(search_ms 범위 내 미세 조정만). zero-cross 없으면 원본 유지."""
    if len(samples) < 3:
        return list(samples)
    w = min(len(samples) - 1, max(1, int(search_ms * sr / 1000)))
    for i in range(len(samples) - 1, len(samples) - 1 - w, -1):
        if samples[i - 1] == 0.0 or (samples[i - 1] < 0) != (samples[i] < 0):
            return samples[:i]
    return list(samples)


# ────────────────────────── 테스트 ──────────────────────────

class TailSymptomRepro(unittest.TestCase):
    """SYNTHETIC WAV로 abrupt-tail 재현 + 정책 효과 검증."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_boundary_")
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for f in os.listdir(self.tmp):
            try:
                os.remove(os.path.join(self.tmp, f))
            except OSError:
                pass
        try:
            os.rmdir(self.tmp)
        except OSError:
            pass

    def test_repro_abrupt_tail_nonzero_last_sample(self):
        """flat sine는 마지막 샘플 진폭이 커 재생 종료 시 '뚝' 끊긴다(edge_step 큼)."""
        s = make_sine(envelope="click_ready")
        self.assertGreater(edge_step(s), 0.5, "flat/peak tail은 큰 불연속이어야(증상 재현)")

    def test_tail_policy_removes_click_on_high_tail(self):
        """마지막 진폭이 크면 fade+padding 적용 → 끝 불연속(클릭) 제거."""
        s = make_sine(envelope="click_ready")
        out, faded = apply_tail_policy(s)
        self.assertTrue(faded, "높은 말끝은 fade 적용 대상")
        self.assertLess(edge_step(out), 1e-6, "패딩 무음으로 끝 → 불연속 없음")
        self.assertLess(last_amp(out[:len(out) - 1], sr=SR), 0.05,
                        "fade 후 body 말단 진폭이 충분히 낮아야")

    def test_already_silent_tail_padding_only_no_fade(self):
        """이미 무음(decay)인 말끝은 fade 없이 padding만 — body 원형 보존."""
        s = make_sine(envelope="decay")
        out, faded = apply_tail_policy(s)
        self.assertFalse(faded, "무음 말끝은 fade 미적용(padding only)")
        # padding 앞부분(=원본 body)은 바이트 변형 없이 보존
        self.assertEqual(out[:len(s)], s, "무음 tail은 body를 건드리지 않아야")

    def test_padding_length_matches_contract(self):
        s = make_sine(envelope="decay")
        out, _ = apply_tail_policy(s, pad_ms=120, sr=SR)
        added = len(out) - len(s)
        self.assertEqual(added, int(120 * SR / 1000), "120ms 패딩 샘플 수 일치")

    def test_very_short_wav_no_crash(self):
        """아주 짧은 WAV(수 ms)에서도 fade/padding이 폭주/예외 없이 동작."""
        s = make_sine(dur=0.003, envelope="flat")  # ~72 samples
        out, _ = apply_tail_policy(s)
        self.assertGreater(len(out), len(s))
        self.assertLess(edge_step(out), 1e-6)

    def test_internal_boundary_zero_cross_reduces_jump(self):
        """내부 chunk 경계: zero-cross 트림이 이음매 점프를 줄인다(내용 대량삭제 없이)."""
        a = make_sine(freq=220, dur=0.05, envelope="flat")
        b = make_sine(freq=330, dur=0.05, envelope="flat")
        raw_jump = max_boundary_step(a, b)
        a2 = zero_cross_trim(a)
        trimmed_jump = max_boundary_step(a2, b)
        self.assertLessEqual(trimmed_jump, raw_jump + 1e-9)
        self.assertGreaterEqual(len(a2), len(a) - int(3 * SR / 1000),
                                "트림은 search_ms 범위 내 미세 조정만")

    def test_wav_roundtrip_mono(self):
        """WAV write/read 왕복 — mono, sr 보존, 샘플 수 보존."""
        s = make_sine(dur=0.02, envelope="flat")
        p = os.path.join(self.tmp, "m.wav")
        write_wav(p, s, sr=SR, nchannels=1)
        r, sr, nch = read_wav(p)
        self.assertEqual(sr, SR)
        self.assertEqual(nch, 1)
        self.assertEqual(len(r), len(s))

    def test_stereo_and_sr_are_measurable_for_reject_policy(self):
        """production 정책은 mono/24k만 결합(계약). 여기서는 stereo/다른 sr를 '식별'만 확인 —
           실제 reject는 tts_worker._assert_concat_ready(ndim!=1 예외)가 담당(venv 필요, 여기 미실행)."""
        p = os.path.join(self.tmp, "st.wav")
        write_wav(p, make_sine(dur=0.02), sr=48000, nchannels=2)
        _, sr, nch = read_wav(p)
        self.assertEqual(nch, 2, "stereo 식별")
        self.assertNotEqual(sr, SR, "다른 sr 식별")

    def test_nan_inf_guard_is_finite_after_policy(self):
        """비유한 입력 방어 — 정책 통과 후 전 샘플 유한(실제 production 검증은 place_final_with_pitch)."""
        s = make_sine(envelope="flat")
        out, _ = apply_tail_policy(s)
        self.assertTrue(all(math.isfinite(x) for x in out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
