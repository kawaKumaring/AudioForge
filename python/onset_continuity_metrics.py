# -*- coding: utf-8 -*-
"""onset_continuity_metrics.py — 청크 온셋/연속성 계측의 **단일 권위**. 순수 numpy.

왜 별도 모듈인가(설계 결정):
  boundary_metrics.py 는 스스로 "TEST-ONLY, tts_worker._concat_with_boundaries 의 거울" 이라고
  선언한 **join 서술자 전용** 모듈이다. 반면 여기 있는 계측(F0 / 화자 임베딩 거리 / mel 거리 /
  온셋 기울기 / 앞뒤 무음 / 첫 300 ms vs 안정 구간)은
    · 일반 자동분할(비표현형)
    · 표현형 운율 엔진
    · 이후 연속성-품질 브랜치
  가 **똑같이** 써야 하는 범용 계측이며, 테스트 전용으로 못 박을 수 없다.
  그래서 범용 계측은 여기에 두고, boundary_metrics 는 저수준 1차 함수를 **여기서 import** 해 쓴다.
  → RMS / F0 / 화자거리 계산이 두 곳에 존재하지 않는다(중복 금지).

무엇을 하지 않는가(하드 요건):
  · 모델을 로드하지 않는다. 화자 임베딩은 **주입된 함수**로만 얻는다(embed_fn).
  · 파일 I/O·네트워크·서브프로세스·로깅이 없다. numpy 외 의존성이 없다.
  · 판정/보정/삭제를 하지 않는다 — 서술(숫자)만 한다. 임계값은 '분석 파라미터' 이지 합격 기준이 아니다.
  · 레코드에 오디오 샘플·대사·전사·경로를 **어떤 형태로도** 담지 않는다. 직렬화가 이를 강제한다.

임계/창 길이는 전부 이 모듈의 범용 상수다 — 특정 엔진(표현형 등)의 상수로 복제하지 말 것.
"""

import math
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

import numpy as np

# ────────────────────────── 범용 분석 상수 ──────────────────────────

WINDOW_MS = 50.0                 # prev/next 창 길이(기존 join 계측과 동일한 계약 고정값)
ZERO_CROSS_SEARCH_MS = 50.0      # zero crossing 탐색 한계(초과 시 한계값으로 saturate)
TRAILING_FRAME_MS = 5.0          # 저에너지 판정 프레임(비중첩)
TRAILING_LOOKBACK_MS = 1000.0    # trailing 판정 시 되돌아보는 최대 길이
TRAILING_REL_THRESHOLD = 0.10    # 구간 최대 프레임 RMS 대비 -20 dB 이하 = 저에너지 후보

ONSET_WINDOW_MS = 300.0          # '첫 300 ms' 온셋 창 — 안정 구간과 대조하는 기준 창
TAIL_WINDOW_MS = 300.0           # '마지막 구간' 창 — 온셋과 대칭. 청크 끝이 안정 구간과 얼마나 다른가
ONSET_SLOPE_FRAME_MS = 10.0      # 온셋 기울기 계산 프레임(비중첩)
STABLE_MARGIN_MS = 200.0         # 안정 구간을 잡을 때 청크 앞/뒤에서 잘라내는 여유
STABLE_MIN_MS = 300.0            # 안정 구간 최소 길이. 못 채우면 fallback 플래그를 세운다
SILENCE_FRAME_MS = 5.0           # 앞/뒤 무음 판정 프레임
SILENCE_REL_THRESHOLD = 0.10     # 무음 판정 상대 임계(구간 최대 프레임 RMS 대비)

F0_MIN_HZ = 60.0
F0_MAX_HZ = 400.0
F0_VOICED_MIN_CORR = 0.30        # 자기상관 정규화 피크가 이보다 낮으면 무성으로 보고 0.0
F0_ANALYSIS_MS = 500.0           # F0 분석에 쓰는 최대 창 길이(더 길면 '가운데' 를 잘라 쓴다)

JOIN_WINDOW_MS = 100.0           # join 양옆 비교 창(무음을 걷어낸 '실제 발화' 쪽에서 잡는다)

MEL_N_FFT = 1024
MEL_N_MELS = 40
MEL_FMIN_HZ = 50.0
MEL_FMAX_RATIO = 0.5             # nyquist 비율 상한
MEL_FLOOR = 1e-10                # log 바닥값(고정 → 결정적)


class MetricsError(ValueError):
    """입력 계약 위반(신호/구간 서술자). 메시지엔 숫자·인덱스만 담는다."""


class PrivacyViolation(ValueError):
    """직렬화 단계에서 숫자/인덱스 이외의 값이 감지됨."""


# ────────────────────────── 1차 함수(단일 권위) ──────────────────────────

def ms_to_samples(ms: float, sr: int) -> int:
    return int(round(float(ms) * int(sr) / 1000.0))


def window_stats(win: np.ndarray):
    """(rms, peak, dc, hf_energy). 빈 창이면 전부 0.0.

    hf_energy = 1차 차분 제곱 평균(단순 고역통과 에너지 — scipy/FFT 없음).
    """
    w = np.asarray(win, dtype=np.float64)
    if w.size == 0:
        return 0.0, 0.0, 0.0, 0.0
    rms = float(math.sqrt(float(np.mean(w * w))))
    peak = float(np.max(np.abs(w)))
    dc = float(np.mean(w))
    if w.size < 2:
        hf = 0.0
    else:
        d = np.diff(w)
        hf = float(np.mean(d * d))
    return rms, peak, dc, hf


def rms_of(win: np.ndarray) -> float:
    w = np.asarray(win, dtype=np.float64)
    if w.size == 0:
        return 0.0
    return float(math.sqrt(float(np.mean(w * w))))


def peak_of(win: np.ndarray) -> float:
    w = np.asarray(win, dtype=np.float64)
    if w.size == 0:
        return 0.0
    return float(np.max(np.abs(w)))


def sample_jump(sig: np.ndarray, index: int) -> float:
    """이음매 단차 |x[i] - x[i-1]| — 파형에 실제로 존재하는 계단 크기."""
    s = np.asarray(sig)
    i = int(index)
    if i < 1 or i >= s.size:
        raise MetricsError("sample_jump index out of range: %d/%d" % (i, s.size))
    return float(abs(float(s[i]) - float(s[i - 1])))


def zero_cross_distance_back(sig: np.ndarray, j: int, lo: int, limit: int) -> int:
    """x[j-1] 에서 가장 가까운 zero crossing 까지의 샘플 거리(못 찾으면 limit 으로 saturate)."""
    start = max(int(lo), j - 1 - int(limit))
    seg = np.asarray(sig)[start:j]
    if seg.size < 1:
        return int(limit)
    s = np.sign(seg.astype(np.float64, copy=False))
    best: Optional[int] = None
    zeros = np.nonzero(s == 0.0)[0]
    if zeros.size:
        best = int(zeros[-1])
    if s.size >= 2:
        ch = np.nonzero(s[:-1] * s[1:] < 0.0)[0]
        if ch.size:
            cand = int(ch[-1]) + 1          # crossing 직후 샘플 위치
            best = cand if best is None else max(best, cand)
    if best is None:
        return int(limit)
    return int(min(limit, (seg.size - 1) - best))


def zero_cross_distance_fwd(sig: np.ndarray, h: int, hi: int, limit: int) -> int:
    """x[h] 에서 가장 가까운 zero crossing 까지의 샘플 거리(못 찾으면 limit 으로 saturate)."""
    stop = min(int(hi), h + int(limit) + 1)
    seg = np.asarray(sig)[h:stop]
    if seg.size < 1:
        return int(limit)
    s = np.sign(seg.astype(np.float64, copy=False))
    best: Optional[int] = None
    zeros = np.nonzero(s == 0.0)[0]
    if zeros.size:
        best = int(zeros[0])
    if s.size >= 2:
        ch = np.nonzero(s[:-1] * s[1:] < 0.0)[0]
        if ch.size:
            cand = int(ch[0])               # crossing 직전 샘플 위치
            best = cand if best is None else min(best, cand)
    if best is None:
        return int(limit)
    return int(min(limit, best))


def _frame_rms(region: np.ndarray, frame: int):
    """비중첩 프레임 RMS 배열(뒤쪽 정렬). 프레임을 못 채우면 빈 배열."""
    n_frames = region.size // frame
    if n_frames < 1:
        return np.zeros(0, dtype=np.float64), 0
    usable = region[region.size - n_frames * frame:]
    frames = usable.reshape(n_frames, frame).astype(np.float64, copy=False)
    return np.sqrt(np.mean(frames * frames, axis=1)), n_frames


def trailing_low_energy_len(sig: np.ndarray, j: int, lo: int, sr: int,
                            frame_ms: float = TRAILING_FRAME_MS,
                            lookback_ms: float = TRAILING_LOOKBACK_MS,
                            rel_threshold: float = TRAILING_REL_THRESHOLD) -> int:
    """j 직전의 '저에너지/비음성 후보' 꼬리 길이(샘플).

    lookback 구간을 frame_ms 비중첩 프레임으로 나눠 프레임 RMS 를 구하고, **구간 최대 프레임 RMS ×
    rel_threshold** 를 임계로 삼는다(절대 dBFS 대신 상대 판정 — 화자/참조 음량에 독립).
    구간 전체가 완전 무음이면 분석 구간 전체 길이를 반환한다.
    """
    sig = np.asarray(sig)
    frame = max(1, ms_to_samples(frame_ms, sr))
    lookback = max(frame, ms_to_samples(lookback_ms, sr))
    start = max(int(lo), j - lookback)
    region = sig[start:j]
    frame_rms, n_frames = _frame_rms(region, frame)
    if n_frames < 1:
        return 0
    usable_size = n_frames * frame
    ref = float(np.max(frame_rms))
    if ref <= 0.0:
        return int(usable_size)
    thr = ref * float(rel_threshold)
    count = 0
    for k in range(n_frames - 1, -1, -1):
        if frame_rms[k] <= thr:
            count += 1
        else:
            break
    return int(count * frame)


def leading_low_energy_len(sig: np.ndarray, start: int, stop: int, sr: int,
                           frame_ms: float = SILENCE_FRAME_MS,
                           rel_threshold: float = SILENCE_REL_THRESHOLD) -> int:
    """구간 앞쪽의 저에너지(무음 후보) 길이(샘플). trailing 과 동일한 상대 임계 규약."""
    sig = np.asarray(sig)
    frame = max(1, ms_to_samples(frame_ms, sr))
    region = sig[max(0, int(start)):max(int(start), int(stop))]
    n_frames = region.size // frame
    if n_frames < 1:
        return 0
    usable = region[:n_frames * frame]
    frames = usable.reshape(n_frames, frame).astype(np.float64, copy=False)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
    ref = float(np.max(frame_rms))
    if ref <= 0.0:
        return int(usable.size)
    thr = ref * float(rel_threshold)
    count = 0
    for k in range(n_frames):
        if frame_rms[k] <= thr:
            count += 1
        else:
            break
    return int(count * frame)


# ────────────────────────── F0 (자기상관, 순수 numpy) ──────────────────────────

def f0_hz(win: np.ndarray, sr: int,
          fmin: float = F0_MIN_HZ, fmax: float = F0_MAX_HZ,
          voiced_min_corr: float = F0_VOICED_MIN_CORR,
          analysis_ms: float = F0_ANALYSIS_MS) -> float:
    """창 하나의 F0 추정(Hz). 무성/판정 불가면 0.0.

    정규화 자기상관의 [sr/fmax, sr/fmin] 구간 최대 피크를 쓴다. 외부 라이브러리 없이 결정적이며,
    자기상관은 FFT 로 계산한다(O(n log n) — 긴 안정 구간에서도 느려지지 않는다).
    창이 analysis_ms 보다 길면 **가운데** 구간만 잘라 쓴다(구간 대표값, 결정적).
    0.0 은 '0 Hz' 가 아니라 '추정하지 않음' 을 뜻한다.
    """
    w = np.asarray(win, dtype=np.float64)
    sr = int(sr)
    if w.size < 2 or sr <= 0:
        return 0.0
    max_len = max(2, ms_to_samples(analysis_ms, sr))
    if w.size > max_len:
        mid = w.size // 2
        lo = max(0, mid - max_len // 2)
        w = w[lo:lo + max_len]
    w = w - float(np.mean(w))
    energy = float(np.dot(w, w))
    if energy <= 0.0:
        return 0.0
    lag_min = max(1, int(math.floor(sr / float(fmax))))
    lag_max = int(math.ceil(sr / float(fmin)))
    lag_max = min(lag_max, w.size - 1)
    if lag_max <= lag_min:
        return 0.0
    n_fft = 1
    while n_fft < 2 * w.size:
        n_fft *= 2
    spec = np.fft.rfft(w, n=n_fft)
    ac = np.fft.irfft(spec * np.conjugate(spec), n=n_fft)[:w.size]
    if ac.size <= lag_max:
        return 0.0
    seg = ac[lag_min:lag_max + 1] / energy
    k = int(np.argmax(seg))
    if float(seg[k]) < float(voiced_min_corr):
        return 0.0
    lag = lag_min + k
    if lag <= 0:
        return 0.0
    return float(sr) / float(lag)


# ────────────────────────── mel 스펙트럼 거리 (순수 numpy) ──────────────────────────

def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def _mel_to_hz(m):
    return 700.0 * (np.power(10.0, np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(sr: int, n_fft: int = MEL_N_FFT, n_mels: int = MEL_N_MELS,
                   fmin: float = MEL_FMIN_HZ, fmax: Optional[float] = None) -> np.ndarray:
    """(n_mels, n_fft//2+1) 삼각 mel 필터뱅크. 외부 오디오 라이브러리 없이 결정적으로 만든다."""
    sr = int(sr)
    if fmax is None:
        fmax = float(sr) * MEL_FMAX_RATIO
    fmax = min(float(fmax), float(sr) * MEL_FMAX_RATIO)
    n_bins = n_fft // 2 + 1
    fft_freqs = np.linspace(0.0, sr / 2.0, n_bins)
    mel_pts = np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2)
    hz_pts = _mel_to_hz(mel_pts)
    fb = np.zeros((n_mels, n_bins), dtype=np.float64)
    for m in range(n_mels):
        lo, mid, hi = hz_pts[m], hz_pts[m + 1], hz_pts[m + 2]
        if hi <= lo:
            continue
        left = (fft_freqs - lo) / max(mid - lo, 1e-12)
        right = (hi - fft_freqs) / max(hi - mid, 1e-12)
        fb[m] = np.clip(np.minimum(left, right), 0.0, None)
    return fb


def mel_spectrum(win: np.ndarray, sr: int, n_fft: int = MEL_N_FFT,
                 n_mels: int = MEL_N_MELS, filterbank: Optional[np.ndarray] = None) -> np.ndarray:
    """창 하나의 log-mel 스펙트럼(n_mels,). 창은 hann 으로 가중하고 n_fft 로 zero-pad/절단한다."""
    w = np.asarray(win, dtype=np.float64)
    if w.size == 0:
        return np.full(n_mels, math.log(MEL_FLOOR), dtype=np.float64)
    if w.size > n_fft:
        w = w[:n_fft]
    hann = np.hanning(w.size) if w.size > 1 else np.ones(1, dtype=np.float64)
    w = w * hann
    if w.size < n_fft:
        w = np.concatenate([w, np.zeros(n_fft - w.size, dtype=np.float64)])
    spec = np.abs(np.fft.rfft(w, n=n_fft)) ** 2
    fb = mel_filterbank(sr, n_fft, n_mels) if filterbank is None else filterbank
    mel = fb.dot(spec)
    return np.log(np.maximum(mel, MEL_FLOOR))


def mel_distance(win_a: np.ndarray, win_b: np.ndarray, sr: int,
                 n_fft: int = MEL_N_FFT, n_mels: int = MEL_N_MELS) -> float:
    """두 창의 log-mel 스펙트럼 사이 평균 절대 거리. 같은 창이면 0.0."""
    fb = mel_filterbank(sr, n_fft, n_mels)
    a = mel_spectrum(win_a, sr, n_fft, n_mels, fb)
    b = mel_spectrum(win_b, sr, n_fft, n_mels, fb)
    return float(np.mean(np.abs(a - b)))


# ────────────────────────── 화자 임베딩 거리(주입 함수) ──────────────────────────

def cosine_distance(a: Sequence[float], b: Sequence[float]) -> float:
    """1 - cosine similarity. 어느 한쪽이 영벡터면 1.0(=최대 불일치)로 서술한다."""
    va = np.asarray(a, dtype=np.float64).ravel()
    vb = np.asarray(b, dtype=np.float64).ravel()
    if va.size == 0 or vb.size == 0 or va.size != vb.size:
        raise MetricsError("embedding size mismatch: %d vs %d" % (va.size, vb.size))
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na <= 0.0 or nb <= 0.0:
        return 1.0
    return float(1.0 - float(np.dot(va, vb)) / (na * nb))


def speaker_distance(signal: np.ndarray, span_a, span_b, sr: int,
                     embed_fn: Callable[[np.ndarray, int], Sequence[float]]) -> float:
    """두 구간의 화자 임베딩 거리. 임베딩은 **주입된 함수**로만 얻는다(모델 로딩 없음).

    embed_fn(mono_float_array, sample_rate) -> 실수 벡터. 반환 벡터 길이는 두 호출에서 같아야 한다.
    """
    if embed_fn is None:
        raise MetricsError("embed_fn required")
    sig = np.asarray(signal, dtype=np.float32)
    a = sig[max(0, int(span_a[0])):max(0, int(span_a[1]))]
    b = sig[max(0, int(span_b[0])):max(0, int(span_b[1]))]
    return cosine_distance(embed_fn(a, int(sr)), embed_fn(b, int(sr)))


# ────────────────────────── 온셋 기울기 ──────────────────────────

def onset_slope(sig: np.ndarray, start: int, stop: int, sr: int,
                frame_ms: float = ONSET_SLOPE_FRAME_MS) -> float:
    """구간의 프레임 RMS 변화 기울기(진폭/초). 프레임이 2개 미만이면 0.0.

    최소제곱 1차 회귀 기울기를 쓴다 — 첫 프레임과 마지막 프레임만 보는 것보다 잡음에 강하다.
    부호 그대로 서술한다(감소면 음수). 온셋 창에도 tail 창에도 같은 자로 쓰인다. 판정하지 않는다.
    """
    sig = np.asarray(sig)
    frame = max(1, ms_to_samples(frame_ms, sr))
    region = sig[max(0, int(start)):max(int(start), int(stop))]
    n_frames = region.size // frame
    if n_frames < 2:
        return 0.0
    usable = region[:n_frames * frame]
    frames = usable.reshape(n_frames, frame).astype(np.float64, copy=False)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
    t = (np.arange(n_frames, dtype=np.float64) * frame) / float(sr)
    t_mean = float(np.mean(t))
    denom = float(np.sum((t - t_mean) ** 2))
    if denom <= 0.0:
        return 0.0
    r_mean = float(np.mean(frame_rms))
    return float(np.sum((t - t_mean) * (frame_rms - r_mean)) / denom)


# ────────────────────────── 구간 서술자 / 안정 구간 ──────────────────────────

@dataclass(frozen=True)
class ChunkSpan:
    """산출 신호 안에서 청크 하나가 차지하는 구간. 텍스트도 경로도 담지 않는다.

    chunk_index        : 계획서의 청크 인덱스.
    start_sample       : 이 청크의 실제 오디오가 시작하는 샘플(선언된 앞 무음 '뒤').
    end_sample         : 이 청크의 실제 오디오가 끝난 다음 샘플(exclusive).
    gap_before_samples : 이 청크 앞에 삽입된 선언 무음 길이(창 통계에서 제외하기 위함).
    """

    chunk_index: int
    start_sample: int
    end_sample: int
    gap_before_samples: int = 0


def stable_region(span: ChunkSpan, sr: int,
                  margin_ms: float = STABLE_MARGIN_MS,
                  min_ms: float = STABLE_MIN_MS):
    """청크 안의 '안정 구간' (start, end, fallback). 앞뒤 margin 을 잘라낸 가운데 구간.

    최소 길이를 못 채우면 청크 전체를 쓰고 fallback=1 로 표기한다(조용히 넘어가지 않는다).
    """
    margin = ms_to_samples(margin_ms, sr)
    lo = int(span.start_sample) + margin
    hi = int(span.end_sample) - margin
    min_len = ms_to_samples(min_ms, sr)
    if hi - lo >= max(1, min_len):
        return lo, hi, 0
    return int(span.start_sample), int(span.end_sample), 1


def tail_region(span: ChunkSpan, sr: int, tail_window_ms: float = TAIL_WINDOW_MS):
    """청크의 '마지막 구간' (start, end). 온셋 창(첫 300 ms)과 정확히 대칭인 끝 300 ms.

    청크가 창보다 짧으면 청크 전체를 쓴다(잘라내지 않는다 — 서술 대상이 사라지면 안 되므로).
    """
    win = max(1, ms_to_samples(tail_window_ms, sr))
    end = int(span.end_sample)
    start = max(int(span.start_sample), end - win)
    return start, end


# ────────────────────────── 공개 API: 청크 온셋/연속성 레코드 ──────────────────────────

ONSET_RECORD_FIELDS = (
    "chunk_index",
    "start_sample", "end_sample", "chunk_samples",
    "gap_before_samples",
    "stable_start_sample", "stable_end_sample", "stable_region_fallback",
    "onset_window_samples",
    "speaker_distance", "speaker_distance_available",
    "onset_f0_hz", "stable_f0_hz", "f0_delta_hz", "f0_ratio",
    "onset_rms", "stable_rms", "onset_peak", "stable_peak", "rms_delta_db",
    "onset_dc", "stable_dc",
    "onset_hf_energy", "stable_hf_energy",
    "mel_distance",
    "leading_silence_samples", "trailing_silence_samples",
    "onset_slope",
    "boundary_sample_jump", "boundary_sample_jump_available",
    "prev_zero_cross_distance", "next_zero_cross_distance",
    # ── 마지막 구간(끝 300 ms) 축 — 온셋 축과 대칭. 청크의 '끝' 이 안정 구간과 얼마나 다른가.
    "tail_window_samples",
    "tail_rms", "tail_peak", "tail_hf_energy",
    "tail_rms_delta_db",
    "tail_f0_hz", "tail_f0_delta_hz", "tail_f0_ratio",
    "tail_slope",
    # ── 무음에 오염되지 않는 F0(유성 프레임 기준). 창 F0 가 0.0 인 경우와 구분하기 위함.
    "onset_first_voiced_f0_hz", "onset_first_voiced_offset_samples", "onset_first_voiced_available",
    "tail_last_voiced_f0_hz", "tail_last_voiced_trailing_samples", "tail_last_voiced_available",
    "sample_rate",
)

ONSET_INT_FIELDS = (
    "chunk_index",
    "start_sample", "end_sample", "chunk_samples",
    "gap_before_samples",
    "stable_start_sample", "stable_end_sample", "stable_region_fallback",
    "onset_window_samples",
    "speaker_distance_available",
    "leading_silence_samples", "trailing_silence_samples",
    "boundary_sample_jump_available",
    "prev_zero_cross_distance", "next_zero_cross_distance",
    "tail_window_samples",
    "onset_first_voiced_offset_samples", "onset_first_voiced_available",
    "tail_last_voiced_trailing_samples", "tail_last_voiced_available",
    "sample_rate",
)


def _rms_delta_db(a: float, b: float) -> float:
    """20*log10(a/b). 어느 한쪽이 0 이면 0.0 으로 서술한다(무한대 금지 — 직렬화가 비유한을 거부)."""
    if a <= 0.0 or b <= 0.0:
        return 0.0
    return float(20.0 * math.log10(a / b))


def compute_onset_continuity_metrics(signal, sr, spans: Sequence[ChunkSpan],
                                     embed_fn: Optional[Callable] = None,
                                     onset_window_ms: float = ONSET_WINDOW_MS,
                                     stable_margin_ms: float = STABLE_MARGIN_MS,
                                     stable_min_ms: float = STABLE_MIN_MS,
                                     zero_cross_search_ms: float = ZERO_CROSS_SEARCH_MS,
                                     tail_window_ms: float = TAIL_WINDOW_MS) -> List[dict]:
    """산출 신호 + 청크 구간 → 청크당 레코드 1개(ONSET_RECORD_FIELDS 정확히 그대로).

    각 청크의 **첫 onset_window_ms** 와 **마지막 tail_window_ms** 를 같은 청크의 **안정 구간**과
    각각 대조한다(두 끝은 대칭적으로 서술된다 — 시작만 보면 청크가 어떻게 끝나는지 알 수 없다).
    화자 임베딩 거리는 embed_fn 이 주어졌을 때만 계산되며, 없으면 available=0 이고
    speaker_distance 값은 의미가 없다(0.0). 임베딩 모델은 절대 여기서 로드하지 않는다.
    """
    sig = np.asarray(signal, dtype=np.float32)
    if sig.ndim != 1:
        raise MetricsError("mono(1-D) only: ndim=%d" % sig.ndim)
    sr = int(sr)
    if sr <= 0:
        raise MetricsError("sr must be positive: %d" % sr)
    if sig.size and not bool(np.all(np.isfinite(sig))):
        raise MetricsError("signal contains non-finite values")

    items = list(spans or [])
    if not items:
        return []
    for sp in items:
        if not isinstance(sp, ChunkSpan):
            raise MetricsError("ChunkSpan descriptor required")
        if sp.start_sample < 0 or sp.end_sample > sig.size or sp.end_sample <= sp.start_sample:
            raise MetricsError("span out of range: %d..%d / %d"
                               % (sp.start_sample, sp.end_sample, sig.size))
        if sp.gap_before_samples < 0:
            raise MetricsError("gap_before_samples negative: %d" % sp.gap_before_samples)

    onset_win = max(1, ms_to_samples(onset_window_ms, sr))
    zc_limit = max(1, ms_to_samples(zero_cross_search_ms, sr))
    fb = mel_filterbank(sr, MEL_N_FFT, MEL_N_MELS)

    records: List[dict] = []
    for sp in items:
        start, end = int(sp.start_sample), int(sp.end_sample)
        st_lo, st_hi, st_fb = stable_region(sp, sr, stable_margin_ms, stable_min_ms)
        onset_hi = min(end, start + onset_win)
        tail_lo, tail_hi = tail_region(sp, sr, tail_window_ms)

        onset = sig[start:onset_hi]
        stable = sig[st_lo:st_hi]
        tail = sig[tail_lo:tail_hi]

        o_rms, o_peak, o_dc, o_hf = window_stats(onset)
        s_rms, s_peak, s_dc, s_hf = window_stats(stable)
        t_rms, t_peak, _t_dc, t_hf = window_stats(tail)

        o_f0 = f0_hz(onset, sr)
        s_f0 = f0_hz(stable, sr)
        t_f0 = f0_hz(tail, sr)
        f0_ratio = float(o_f0 / s_f0) if (o_f0 > 0.0 and s_f0 > 0.0) else 0.0
        t_f0_ratio = float(t_f0 / s_f0) if (t_f0 > 0.0 and s_f0 > 0.0) else 0.0

        # 창 F0 가 0.0 인 것은 '무성' 과 '앞/뒤가 무음이라 못 쟀음' 을 구분하지 못한다.
        # 유성 프레임 기준 값을 따로 들고 가 그 구분을 레코드에 남긴다.
        of_hz, of_off, of_av = first_voiced_f0(sig, sr, start, onset_hi)
        tl_hz, tl_rest, tl_av = last_voiced_f0(sig, sr, tail_lo, tail_hi)

        if embed_fn is not None:
            dist = speaker_distance(sig, (start, onset_hi), (st_lo, st_hi), sr, embed_fn)
            avail = 1
        else:
            dist, avail = 0.0, 0

        # 경계 단차: 청크 시작 바로 앞 샘플과의 계단(첫 샘플이 신호 맨 앞이면 잴 수 없음).
        if start >= 1:
            jump = sample_jump(sig, start)
            jump_avail = 1
            prev_zc = zero_cross_distance_back(sig, start, max(0, start - zc_limit - 1), zc_limit)
        else:
            jump, jump_avail, prev_zc = 0.0, 0, zc_limit

        rec = {
            "chunk_index": int(sp.chunk_index),
            "start_sample": start,
            "end_sample": end,
            "chunk_samples": end - start,
            "gap_before_samples": int(sp.gap_before_samples),
            "stable_start_sample": int(st_lo),
            "stable_end_sample": int(st_hi),
            "stable_region_fallback": int(st_fb),
            "onset_window_samples": int(onset_hi - start),
            "speaker_distance": float(dist),
            "speaker_distance_available": int(avail),
            "onset_f0_hz": float(o_f0),
            "stable_f0_hz": float(s_f0),
            "f0_delta_hz": float(o_f0 - s_f0),
            "f0_ratio": f0_ratio,
            "onset_rms": float(o_rms),
            "stable_rms": float(s_rms),
            "onset_peak": float(o_peak),
            "stable_peak": float(s_peak),
            "rms_delta_db": _rms_delta_db(o_rms, s_rms),
            "onset_dc": float(o_dc),
            "stable_dc": float(s_dc),
            "onset_hf_energy": float(o_hf),
            "stable_hf_energy": float(s_hf),
            "mel_distance": float(np.mean(np.abs(
                mel_spectrum(onset, sr, MEL_N_FFT, MEL_N_MELS, fb)
                - mel_spectrum(stable, sr, MEL_N_FFT, MEL_N_MELS, fb)))),
            "leading_silence_samples": leading_low_energy_len(sig, start, end, sr),
            "trailing_silence_samples": trailing_low_energy_len(sig, end, start, sr),
            "onset_slope": onset_slope(sig, start, onset_hi, sr),
            "boundary_sample_jump": float(jump),
            "boundary_sample_jump_available": int(jump_avail),
            "prev_zero_cross_distance": int(prev_zc),
            "next_zero_cross_distance": zero_cross_distance_fwd(sig, start, end, zc_limit),
            "tail_window_samples": int(tail_hi - tail_lo),
            "tail_rms": float(t_rms),
            "tail_peak": float(t_peak),
            "tail_hf_energy": float(t_hf),
            "tail_rms_delta_db": _rms_delta_db(t_rms, s_rms),
            "tail_f0_hz": float(t_f0),
            "tail_f0_delta_hz": float(t_f0 - s_f0),
            "tail_f0_ratio": t_f0_ratio,
            "tail_slope": onset_slope(sig, tail_lo, tail_hi, sr),
            "onset_first_voiced_f0_hz": float(of_hz),
            "onset_first_voiced_offset_samples": int(of_off),
            "onset_first_voiced_available": int(of_av),
            "tail_last_voiced_f0_hz": float(tl_hz),
            "tail_last_voiced_trailing_samples": int(tl_rest),
            "tail_last_voiced_available": int(tl_av),
            "sample_rate": sr,
        }
        assert tuple(rec.keys()) == ONSET_RECORD_FIELDS
        records.append(rec)
    return records


# ────────────────────────── 직렬화(프라이버시 강제: 숫자만) ──────────────────────────

def serialize_record(record: dict) -> dict:
    """레코드 1개 → **숫자만** 담은 dict. 문자열 필드가 하나도 없다는 점이 하드 계약이다.

    ONSET_RECORD_FIELDS 이외의 키는 통과시키지 않는다. 경로·대사·전사·샘플 배열은 형식상 불가능하다.
    """
    if not isinstance(record, dict):
        raise PrivacyViolation("record must be a dict")
    extra = set(record.keys()) - set(ONSET_RECORD_FIELDS)
    if extra:
        raise PrivacyViolation("disallowed fields: %d" % len(extra))
    missing = set(ONSET_RECORD_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation("missing fields: %d" % len(missing))

    out = {}
    for key in ONSET_RECORD_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise PrivacyViolation("'%s' is not numeric" % key)
        if key in ONSET_INT_FIELDS:
            out[key] = int(value)
        else:
            f = float(value)
            if not math.isfinite(f):
                raise PrivacyViolation("'%s' is not finite" % key)
            out[key] = f
    return out


def serialize_records(records: Sequence[dict]) -> List[dict]:
    return [serialize_record(r) for r in (records or [])]


def format_records(records: Sequence[dict]) -> str:
    """진단용 텍스트 표. 숫자만 나온다(직렬화를 거치므로 동일 보증)."""
    rows = serialize_records(records)
    lines = ["\t".join(ONSET_RECORD_FIELDS)]
    for r in rows:
        cells = []
        for key in ONSET_RECORD_FIELDS:
            v = r[key]
            cells.append(str(v) if isinstance(v, int) else ("%.6g" % v))
        lines.append("\t".join(cells))
    return "\n".join(lines)


# ══════════════════════════ 운율 프로필(F0 궤적 기반 서술) ══════════════════════════
#
# 왜 여기인가: F0 궤적·반음 변환·분위수·상승/하강 비율은 (a) 참조 클립 (b) 산출물 (c) 경계 보정
# 후보의 전/후 비교가 **똑같이** 쓰는 범용 서술이다. 특정 엔진 전용이 아니므로 이 모듈(단일 권위)에
# 둔다. boundary_metrics 는 여기서 import 해 'join 관점' 레코드만 조립한다(수식 중복 0).
#
# 이 절도 위 하드 요건을 그대로 따른다 — 판정하지 않고, 보정하지 않고, 숫자만 서술한다.
# 임계값(PROSODY_FLAT_SEMITONES 등)은 '분석 파라미터' 이며 합격 기준이 아니다.

F0_TRACK_FRAME_MS = 50.0         # F0 궤적 프레임 길이(60 Hz 에서도 최소 3 주기 확보)
F0_TRACK_HOP_MS = 10.0           # F0 궤적 홉
PROSODY_FLAT_SEMITONES = 0.5     # 인접 프레임 반음 변화가 이 미만이면 '평탄' 으로 센다
PROSODY_RUN_MIN_FRAMES = 2       # 상승/하강 구간(run)으로 셀 최소 연속 프레임 수


def semitone_delta(f_from: float, f_to: float) -> float:
    """f_from → f_to 의 반음 차 12*log2(f_to/f_from). 어느 한쪽이 0 이하면 0.0(=측정 불가).

    0.0 은 '변화 없음' 과 '측정 불가' 를 구분하지 않는다 — 호출부가 available 플래그를 따로 들고
    가야 한다(f0_hz 가 0.0 으로 '추정하지 않음' 을 표현하는 기존 규약과 동일).
    """
    a, b = float(f_from), float(f_to)
    if a <= 0.0 or b <= 0.0:
        return 0.0
    return float(12.0 * math.log2(b / a))


def f0_track(sig: np.ndarray, sr: int, start: int = 0, stop: Optional[int] = None,
             frame_ms: float = F0_TRACK_FRAME_MS, hop_ms: float = F0_TRACK_HOP_MS,
             fmin: float = F0_MIN_HZ, fmax: float = F0_MAX_HZ,
             voiced_min_corr: float = F0_VOICED_MIN_CORR) -> np.ndarray:
    """[start, stop) 구간의 프레임별 F0 배열(Hz). 무성 프레임은 0.0.

    프레임은 **완전히 구간 안에 들어가는 것만** 쓴다(경계를 넘어 다음 청크 오디오를 섞지 않는다).
    각 프레임의 추정은 f0_hz 하나로만 한다 — 자기상관 구현이 두 곳에 존재하지 않는다.
    """
    s = np.asarray(sig, dtype=np.float64)
    sr = int(sr)
    if sr <= 0:
        raise MetricsError("sr must be positive: %d" % sr)
    lo = max(0, int(start))
    hi = s.size if stop is None else min(s.size, int(stop))
    frame = max(2, ms_to_samples(frame_ms, sr))
    hop = max(1, ms_to_samples(hop_ms, sr))
    if hi - lo < frame:
        return np.zeros(0, dtype=np.float64)
    n = 1 + (hi - lo - frame) // hop
    out = np.zeros(n, dtype=np.float64)
    for k in range(n):
        a = lo + k * hop
        out[k] = f0_hz(s[a:a + frame], sr, fmin=fmin, fmax=fmax,
                       voiced_min_corr=voiced_min_corr, analysis_ms=frame_ms)
    return out


def frame_rms_track(sig: np.ndarray, sr: int, start: int = 0, stop: Optional[int] = None,
                    frame_ms: float = F0_TRACK_FRAME_MS,
                    hop_ms: float = F0_TRACK_HOP_MS) -> np.ndarray:
    """f0_track 과 **같은 프레임 격자**의 프레임 RMS 배열. 인덱스가 1:1 대응한다."""
    s = np.asarray(sig, dtype=np.float64)
    sr = int(sr)
    if sr <= 0:
        raise MetricsError("sr must be positive: %d" % sr)
    lo = max(0, int(start))
    hi = s.size if stop is None else min(s.size, int(stop))
    frame = max(2, ms_to_samples(frame_ms, sr))
    hop = max(1, ms_to_samples(hop_ms, sr))
    if hi - lo < frame:
        return np.zeros(0, dtype=np.float64)
    n = 1 + (hi - lo - frame) // hop
    out = np.zeros(n, dtype=np.float64)
    for k in range(n):
        a = lo + k * hop
        out[k] = rms_of(s[a:a + frame])
    return out


def first_voiced_f0(sig: np.ndarray, sr: int, start: int, stop: int,
                    frame_ms: float = F0_TRACK_FRAME_MS, hop_ms: float = F0_TRACK_HOP_MS):
    """[start, stop) 안에서 **처음** 유성으로 판정된 프레임의 (f0_hz, 프레임 시작 offset, available).

    available=0 이면 (0.0, -1, 0). 앞 무음이 길어 첫 50 ms 가 무성인 실제 케이스를 0.0 으로
    뭉개지 않기 위해 존재한다(경계 계측이 무음에 오염되지 않게 하는 핵심).
    """
    track = f0_track(sig, sr, start, stop, frame_ms, hop_ms)
    hop = max(1, ms_to_samples(hop_ms, sr))
    idx = np.nonzero(track > 0.0)[0]
    if idx.size == 0:
        return 0.0, -1, 0
    k = int(idx[0])
    return float(track[k]), int(k * hop), 1


def last_voiced_f0(sig: np.ndarray, sr: int, start: int, stop: int,
                   frame_ms: float = F0_TRACK_FRAME_MS, hop_ms: float = F0_TRACK_HOP_MS):
    """[start, stop) 안에서 **마지막** 유성 프레임의 (f0_hz, stop 까지의 잔여 거리, available).

    두 번째 값은 그 프레임의 끝에서 stop 까지 남은 샘플 수 — 이 청크가 유성으로 끝난 뒤 몇 샘플이
    비음성인지 그대로 읽을 수 있다. available=0 이면 (0.0, -1, 0).
    """
    track = f0_track(sig, sr, start, stop, frame_ms, hop_ms)
    hop = max(1, ms_to_samples(hop_ms, sr))
    frame = max(2, ms_to_samples(frame_ms, sr))
    idx = np.nonzero(track > 0.0)[0]
    if idx.size == 0:
        return 0.0, -1, 0
    k = int(idx[-1])
    frame_end = max(0, int(start)) + k * hop + frame
    return float(track[k]), int(max(0, int(stop) - frame_end)), 1


# ────────────────────────── 운율 프로필 레코드 ──────────────────────────

PROSODY_PROFILE_FIELDS = (
    "sample_rate",
    "analysis_samples",
    "frame_count", "voiced_frame_count", "active_frame_count",
    "voiced_ratio",
    "f0_q10_hz", "f0_q25_hz", "f0_q50_hz", "f0_q75_hz", "f0_q90_hz",
    "f0_range_semitones", "f0_iqr_semitones", "f0_std_semitones",
    "rms_q10", "rms_q50", "rms_q90", "rms_range_db",
    "delta_pair_count",
    "rising_ratio", "falling_ratio", "flat_ratio", "rising_falling_balance",
    "abs_delta_median_semitones", "abs_delta_p90_semitones",
    "rise_run_count", "fall_run_count",
)

PROSODY_PROFILE_INT_FIELDS = (
    "sample_rate", "analysis_samples",
    "frame_count", "voiced_frame_count", "active_frame_count",
    "delta_pair_count", "rise_run_count", "fall_run_count",
)


def _quantile(values: np.ndarray, q: float) -> float:
    if values.size == 0:
        return 0.0
    return float(np.quantile(values, q))


def _count_runs(signs: np.ndarray, want: int, min_len: int) -> int:
    """signs 안에서 값이 want 인 **연속 구간** 중 길이가 min_len 이상인 것의 개수."""
    count, run = 0, 0
    for v in signs:
        if int(v) == want:
            run += 1
        else:
            if run >= min_len:
                count += 1
            run = 0
    if run >= min_len:
        count += 1
    return int(count)


def prosody_profile(signal, sr, start: int = 0, stop: Optional[int] = None,
                    frame_ms: float = F0_TRACK_FRAME_MS, hop_ms: float = F0_TRACK_HOP_MS,
                    flat_semitones: float = PROSODY_FLAT_SEMITONES,
                    active_rel_threshold: float = SILENCE_REL_THRESHOLD,
                    run_min_frames: int = PROSODY_RUN_MIN_FRAMES) -> dict:
    """구간 하나의 운율 프로필 — PROSODY_PROFILE_FIELDS 그대로인 숫자 dict.

    정의(전부 문서화된 고정 규약):
      - F0 분위수는 **유성 프레임만** 모아 계산한다(무성 0.0 이 분포를 끌어내리지 않게).
      - f0_range_semitones = 12*log2(q90/q10), f0_iqr_semitones = 12*log2(q75/q25).
      - f0_std_semitones = 유성 프레임을 q50 기준 반음으로 바꾼 값의 표준편차
        → 피치 변화 폭의 단일 스칼라. 값이 작을수록 평탄하다.
      - RMS 분위수는 **활성 프레임만** 쓴다(프레임 RMS 가 최대 프레임 RMS 의
        active_rel_threshold 배 초과). 무음 비율이 다른 두 클립을 비교할 때 무음 바닥이
        q10 을 지배하지 않게 하기 위함이다.
      - 상승/하강은 **유성이 연속된 구간 안의 인접 프레임 쌍**만 본다(무성 건너뛰기 금지 —
        무음을 가로지른 큰 점프를 억양으로 세지 않기 위함).
        abs(delta) < flat_semitones 는 flat, delta 가 양수면 rising, 음수면 falling.
      - rise_run_count / fall_run_count = 같은 부호가 run_min_frames 이상 이어진 구간 수.

    판정하지 않는다. 특히 이 프로필은 목표치가 아니다 — 두 신호를 같은 자로 재기 위한 도구다.
    """
    sig = np.asarray(signal, dtype=np.float64)
    if sig.ndim != 1:
        raise MetricsError("mono(1-D) only: ndim=%d" % sig.ndim)
    sr = int(sr)
    if sr <= 0:
        raise MetricsError("sr must be positive: %d" % sr)
    lo = max(0, int(start))
    hi = sig.size if stop is None else min(sig.size, int(stop))
    if hi < lo:
        raise MetricsError("stop before start: %d < %d" % (hi, lo))

    f0 = f0_track(sig, sr, lo, hi, frame_ms, hop_ms)
    rms = frame_rms_track(sig, sr, lo, hi, frame_ms, hop_ms)
    n = int(min(f0.size, rms.size))
    f0, rms = f0[:n], rms[:n]

    voiced_mask = f0 > 0.0
    voiced = f0[voiced_mask]
    ref = float(np.max(rms)) if rms.size else 0.0
    active_mask = rms > (ref * float(active_rel_threshold)) if ref > 0.0 else np.zeros(n, dtype=bool)
    active = rms[active_mask]

    q10 = _quantile(voiced, 0.10)
    q25 = _quantile(voiced, 0.25)
    q50 = _quantile(voiced, 0.50)
    q75 = _quantile(voiced, 0.75)
    q90 = _quantile(voiced, 0.90)

    if voiced.size and q50 > 0.0:
        f0_std_st = float(np.std(12.0 * np.log2(voiced / q50)))
    else:
        f0_std_st = 0.0

    r10 = _quantile(active, 0.10)
    r50 = _quantile(active, 0.50)
    r90 = _quantile(active, 0.90)

    # 유성이 연속된 구간 안의 인접 쌍만 모은다(무성이 끼면 run 을 끊는다).
    deltas: List[float] = []
    signs: List[int] = []
    flat = float(flat_semitones)
    for k in range(1, n):
        if voiced_mask[k] and voiced_mask[k - 1]:
            d = semitone_delta(float(f0[k - 1]), float(f0[k]))
            deltas.append(d)
            signs.append(0 if abs(d) < flat else (1 if d > 0.0 else -1))
        else:
            signs.append(0)
    darr = np.asarray(deltas, dtype=np.float64)
    sarr = np.asarray(signs, dtype=np.int64)
    pair_count = int(darr.size)
    if pair_count:
        rising = float(np.count_nonzero(darr >= flat)) / pair_count
        falling = float(np.count_nonzero(darr <= -flat)) / pair_count
        flat_ratio = float(1.0 - rising - falling)
        abs_med = float(np.median(np.abs(darr)))
        abs_p90 = float(np.quantile(np.abs(darr), 0.90))
    else:
        rising = falling = 0.0
        flat_ratio = 0.0
        abs_med = abs_p90 = 0.0

    rec = {
        "sample_rate": int(sr),
        "analysis_samples": int(hi - lo),
        "frame_count": int(n),
        "voiced_frame_count": int(voiced.size),
        "active_frame_count": int(active.size),
        "voiced_ratio": float(voiced.size / n) if n else 0.0,
        "f0_q10_hz": q10, "f0_q25_hz": q25, "f0_q50_hz": q50,
        "f0_q75_hz": q75, "f0_q90_hz": q90,
        "f0_range_semitones": float(semitone_delta(q10, q90)),
        "f0_iqr_semitones": float(semitone_delta(q25, q75)),
        "f0_std_semitones": float(f0_std_st),
        "rms_q10": r10, "rms_q50": r50, "rms_q90": r90,
        "rms_range_db": float(_rms_delta_db(r90, r10)),
        "delta_pair_count": pair_count,
        "rising_ratio": rising, "falling_ratio": falling, "flat_ratio": flat_ratio,
        "rising_falling_balance": float(rising - falling),
        "abs_delta_median_semitones": abs_med,
        "abs_delta_p90_semitones": abs_p90,
        "rise_run_count": _count_runs(sarr, 1, int(run_min_frames)),
        "fall_run_count": _count_runs(sarr, -1, int(run_min_frames)),
    }
    assert tuple(rec.keys()) == PROSODY_PROFILE_FIELDS
    return rec


def serialize_prosody_profile(record: dict) -> dict:
    """운율 프로필 1개 → 숫자만. 스키마 밖 키·비유한·불리언을 전부 거부한다."""
    if not isinstance(record, dict):
        raise PrivacyViolation("profile must be a dict")
    extra = set(record.keys()) - set(PROSODY_PROFILE_FIELDS)
    if extra:
        raise PrivacyViolation("disallowed fields: %d" % len(extra))
    missing = set(PROSODY_PROFILE_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation("missing fields: %d" % len(missing))
    out = {}
    for key in PROSODY_PROFILE_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise PrivacyViolation("'%s' is not numeric" % key)
        if key in PROSODY_PROFILE_INT_FIELDS:
            out[key] = int(value)
        else:
            f = float(value)
            if not math.isfinite(f):
                raise PrivacyViolation("'%s' is not finite" % key)
            out[key] = f
    return out


PROSODY_COMPARISON_FIELDS = (
    "f0_std_ratio", "f0_std_delta_pct",
    "f0_range_ratio", "f0_range_delta_pct",
    "f0_iqr_ratio", "f0_iqr_delta_pct",
    "rms_range_ratio",
    "f0_median_semitone_offset",
    "rising_ratio_delta", "falling_ratio_delta", "flat_ratio_delta",
    "abs_delta_median_ratio",
)


def compare_prosody_profiles(reference: dict, generated: dict) -> dict:
    """두 운율 프로필의 대조 — 얼마나 더 평탄한가를 비율/퍼센트로 서술한다.

    *_delta_pct = (generated - reference) / reference * 100 → 음수면 생성물이 **더 좁다(평탄하다)**.
    reference 쪽이 0 이면 해당 비율/퍼센트는 0.0 으로 둔다(무한대 금지).
    f0_median_semitone_offset 은 중앙 F0 의 반음 차이(음역 차이)이며 평탄도와 다른 축이므로
    별도 필드로 분리해 둔다. 어느 값도 좋다/나쁘다를 뜻하지 않는다.
    """
    for name, rec in (("reference", reference), ("generated", generated)):
        missing = set(PROSODY_PROFILE_FIELDS) - set((rec or {}).keys())
        if missing:
            raise MetricsError("%s profile missing fields: %d" % (name, len(missing)))

    def ratio(key):
        a = float(reference[key])
        return (float(generated[key]) / a) if a > 0.0 else 0.0

    def pct(key):
        a = float(reference[key])
        return ((float(generated[key]) - a) / a * 100.0) if a > 0.0 else 0.0

    rec = {
        "f0_std_ratio": ratio("f0_std_semitones"),
        "f0_std_delta_pct": pct("f0_std_semitones"),
        "f0_range_ratio": ratio("f0_range_semitones"),
        "f0_range_delta_pct": pct("f0_range_semitones"),
        "f0_iqr_ratio": ratio("f0_iqr_semitones"),
        "f0_iqr_delta_pct": pct("f0_iqr_semitones"),
        "rms_range_ratio": ratio("rms_range_db"),
        "f0_median_semitone_offset": semitone_delta(float(reference["f0_q50_hz"]),
                                                    float(generated["f0_q50_hz"])),
        "rising_ratio_delta": float(generated["rising_ratio"]) - float(reference["rising_ratio"]),
        "falling_ratio_delta": float(generated["falling_ratio"]) - float(reference["falling_ratio"]),
        "flat_ratio_delta": float(generated["flat_ratio"]) - float(reference["flat_ratio"]),
        "abs_delta_median_ratio": ratio("abs_delta_median_semitones"),
    }
    assert tuple(rec.keys()) == PROSODY_COMPARISON_FIELDS
    return rec


def serialize_prosody_comparison(record: dict) -> dict:
    """운율 대조 1개 → 숫자만. 프로필 직렬화와 동일한 하드 계약(스키마 밖·비유한·불리언 거부)."""
    if not isinstance(record, dict):
        raise PrivacyViolation("comparison must be a dict")
    extra = set(record.keys()) - set(PROSODY_COMPARISON_FIELDS)
    if extra:
        raise PrivacyViolation("disallowed fields: %d" % len(extra))
    missing = set(PROSODY_COMPARISON_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation("missing fields: %d" % len(missing))
    out = {}
    for key in PROSODY_COMPARISON_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise PrivacyViolation("'%s' is not numeric" % key)
        f = float(value)
        if not math.isfinite(f):
            raise PrivacyViolation("'%s' is not finite" % key)
        out[key] = f
    return out


# ══════════════════════════ join 연속성(청크 '사이' 서술) ══════════════════════════
#
# 왜 필요한가(빠져 있던 축):
#   · compute_onset_continuity_metrics 는 청크 **안**만 본다(온셋 vs 안정 구간, tail vs 안정 구간).
#   · boundary_metrics 는 이음매 **샘플 한 점**과 고정 50 ms 창만 본다(파형 단차 관점).
#   두 계측 어디에도 "앞 청크의 말끝과 뒤 청크의 말머리가 서로 얼마나 다른가" 가 없다.
#   경계에서 무엇이 튀는지는 바로 그 **건너편 대조**로만 분류된다 → 여기서 채운다.
#
# 무음 취급(핵심 설계):
#   join 양옆 창은 **선언된 무음과 생성된 무음을 모두 걷어낸 '실제 발화' 쪽**에서 잡는다.
#   그러지 않으면 앞 청크 끝의 자연스러운 여운(무음)이 rms_step_db 를 큰 음수로 만들어
#   "경계에서 레벨이 튄다" 는 가짜 결론이 나온다. 무음 자체는 별도 필드로 따로 센다.
#
# 이 절도 위 하드 요건 그대로 — 판정하지 않고, 보정하지 않고, 숫자만 서술한다.

JOIN_RECORD_FIELDS = (
    "left_chunk_index", "right_chunk_index",
    "join_index", "gap_samples",
    "window_samples",
    # 무음 축: 이 경계에서 청자가 실제로 듣는 정적의 총량 = 앞 여운 + 선언 무음 + 뒤 머뭇거림
    "left_trailing_silence_samples", "right_leading_silence_samples",
    "effective_pause_samples", "effective_pause_ms",
    "declared_pause_ms", "undeclared_pause_ms",
    # RMS 축(무음 제거 후 실제 발화끼리)
    "left_tail_rms", "right_head_rms", "rms_step_db",
    "left_tail_peak", "right_head_peak",
    # F0 축(유성 프레임 기준 — 무음이 0.0 으로 오염시키지 않는다)
    "left_tail_f0_hz", "right_head_f0_hz",
    "f0_step_semitones", "f0_step_available",
    # 음색/화자 축
    "mel_distance",
    "speaker_distance", "speaker_distance_available",
    "hf_energy_step",
    # 파형 축(이음매 한 점)
    "sample_jump", "sample_jump_available",
    "sample_rate",
)

JOIN_INT_FIELDS = (
    "left_chunk_index", "right_chunk_index",
    "join_index", "gap_samples",
    "window_samples",
    "left_trailing_silence_samples", "right_leading_silence_samples",
    "effective_pause_samples",
    "f0_step_available",
    "speaker_distance_available",
    "sample_jump_available",
    "sample_rate",
)


def active_tail_window(span: ChunkSpan, win: int, silence: int):
    """앞 청크에서 '무음을 걷어낸 마지막 win 샘플' 구간 (lo, hi). 전부 무음이면 빈 구간."""
    lo0, hi0 = int(span.start_sample), int(span.end_sample)
    hi = max(lo0, hi0 - int(silence))
    lo = max(lo0, hi - int(win))
    return lo, hi


def active_head_window(span: ChunkSpan, win: int, silence: int):
    """뒤 청크에서 '무음을 걷어낸 처음 win 샘플' 구간 (lo, hi). 전부 무음이면 빈 구간."""
    lo0, hi0 = int(span.start_sample), int(span.end_sample)
    lo = min(hi0, lo0 + int(silence))
    hi = min(hi0, lo + int(win))
    return lo, hi


def compute_join_continuity_metrics(signal, sr, spans: Sequence[ChunkSpan],
                                    embed_fn: Optional[Callable] = None,
                                    window_ms: float = JOIN_WINDOW_MS,
                                    onset_window_ms: float = ONSET_WINDOW_MS,
                                    tail_window_ms: float = TAIL_WINDOW_MS) -> List[dict]:
    """산출 신호 + 청크 구간 → **인접 청크 쌍마다** 레코드 1개(JOIN_RECORD_FIELDS 그대로).

    청크가 n 개면 레코드는 n-1 개다(join 이 없는 단일 청크는 빈 리스트 — boundary_metrics 와 같은 계약).
    spans 는 start_sample 오름차순으로 정렬해 쓴다. 겹치는 구간은 계약 위반으로 거부한다.

    F0 계단(f0_step_semitones)은 앞 청크 tail 의 **마지막 유성 프레임** 과 뒤 청크 onset 의
    **첫 유성 프레임** 을 비교한다. 둘 중 하나라도 유성이 없으면 available=0 이고 값은 0.0 이다
    (0.0 을 '변화 없음' 으로 읽지 말 것 — available 이 권위다).
    """
    sig = np.asarray(signal, dtype=np.float32)
    if sig.ndim != 1:
        raise MetricsError("mono(1-D) only: ndim=%d" % sig.ndim)
    sr = int(sr)
    if sr <= 0:
        raise MetricsError("sr must be positive: %d" % sr)
    if sig.size and not bool(np.all(np.isfinite(sig))):
        raise MetricsError("signal contains non-finite values")

    items = list(spans or [])
    for sp in items:
        if not isinstance(sp, ChunkSpan):
            raise MetricsError("ChunkSpan descriptor required")
        if sp.start_sample < 0 or sp.end_sample > sig.size or sp.end_sample <= sp.start_sample:
            raise MetricsError("span out of range: %d..%d / %d"
                               % (sp.start_sample, sp.end_sample, sig.size))
        if sp.gap_before_samples < 0:
            raise MetricsError("gap_before_samples negative: %d" % sp.gap_before_samples)
    if len(items) < 2:
        return []

    ordered = sorted(items, key=lambda s: int(s.start_sample))
    for a, b in zip(ordered, ordered[1:]):
        if int(b.start_sample) < int(a.end_sample):
            raise MetricsError("spans overlap: %d < %d" % (b.start_sample, a.end_sample))

    win = max(1, ms_to_samples(window_ms, sr))
    fb = mel_filterbank(sr, MEL_N_FFT, MEL_N_MELS)

    records: List[dict] = []
    for left, right in zip(ordered, ordered[1:]):
        gap = int(right.gap_before_samples)
        join_index = int(right.start_sample) - gap

        # 무음 축 — 선언 무음(gap)과 생성 무음(여운/머뭇거림)을 따로 센다.
        left_sil = trailing_low_energy_len(sig, int(left.end_sample), int(left.start_sample), sr)
        right_sil = leading_low_energy_len(sig, int(right.start_sample), int(right.end_sample), sr)
        eff = int(left_sil) + gap + int(right_sil)

        lt_lo, lt_hi = active_tail_window(left, win, left_sil)
        rh_lo, rh_hi = active_head_window(right, win, right_sil)
        left_win = sig[lt_lo:lt_hi]
        right_win = sig[rh_lo:rh_hi]

        l_rms, l_peak, _l_dc, l_hf = window_stats(left_win)
        r_rms, r_peak, _r_dc, r_hf = window_stats(right_win)

        # F0 계단 — 무음을 제외한 유성 프레임 기준(창 F0 의 0.0 오염을 피한다).
        t_lo, t_hi = tail_region(left, sr, tail_window_ms)
        o_hi = min(int(right.end_sample),
                   int(right.start_sample) + ms_to_samples(onset_window_ms, sr))
        l_f0, _l_rest, l_av = last_voiced_f0(sig, sr, t_lo, t_hi)
        r_f0, _r_off, r_av = first_voiced_f0(sig, sr, int(right.start_sample), o_hi)
        step_av = 1 if (l_av and r_av) else 0
        f0_step = semitone_delta(l_f0, r_f0) if step_av else 0.0

        if embed_fn is not None and left_win.size and right_win.size:
            dist = speaker_distance(sig, (lt_lo, lt_hi), (rh_lo, rh_hi), sr, embed_fn)
            dist_av = 1
        else:
            dist, dist_av = 0.0, 0

        if 1 <= join_index < sig.size:
            jump, jump_av = sample_jump(sig, join_index), 1
        else:
            jump, jump_av = 0.0, 0

        rec = {
            "left_chunk_index": int(left.chunk_index),
            "right_chunk_index": int(right.chunk_index),
            "join_index": int(join_index),
            "gap_samples": gap,
            "window_samples": int(win),
            "left_trailing_silence_samples": int(left_sil),
            "right_leading_silence_samples": int(right_sil),
            "effective_pause_samples": int(eff),
            "effective_pause_ms": float(eff * 1000.0 / sr),
            "declared_pause_ms": float(gap * 1000.0 / sr),
            "undeclared_pause_ms": float((int(left_sil) + int(right_sil)) * 1000.0 / sr),
            "left_tail_rms": float(l_rms),
            "right_head_rms": float(r_rms),
            "rms_step_db": _rms_delta_db(r_rms, l_rms),
            "left_tail_peak": float(l_peak),
            "right_head_peak": float(r_peak),
            "left_tail_f0_hz": float(l_f0),
            "right_head_f0_hz": float(r_f0),
            "f0_step_semitones": float(f0_step),
            "f0_step_available": int(step_av),
            "mel_distance": float(np.mean(np.abs(
                mel_spectrum(left_win, sr, MEL_N_FFT, MEL_N_MELS, fb)
                - mel_spectrum(right_win, sr, MEL_N_FFT, MEL_N_MELS, fb)))),
            "speaker_distance": float(dist),
            "speaker_distance_available": int(dist_av),
            "hf_energy_step": float(r_hf - l_hf),
            "sample_jump": float(jump),
            "sample_jump_available": int(jump_av),
            "sample_rate": sr,
        }
        assert tuple(rec.keys()) == JOIN_RECORD_FIELDS
        records.append(rec)
    return records


def serialize_join_record(record: dict) -> dict:
    """join 레코드 1개 → **숫자만**. 청크 레코드와 동일한 하드 계약."""
    if not isinstance(record, dict):
        raise PrivacyViolation("record must be a dict")
    extra = set(record.keys()) - set(JOIN_RECORD_FIELDS)
    if extra:
        raise PrivacyViolation("disallowed fields: %d" % len(extra))
    missing = set(JOIN_RECORD_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation("missing fields: %d" % len(missing))
    out = {}
    for key in JOIN_RECORD_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise PrivacyViolation("'%s' is not numeric" % key)
        if key in JOIN_INT_FIELDS:
            out[key] = int(value)
        else:
            f = float(value)
            if not math.isfinite(f):
                raise PrivacyViolation("'%s' is not finite" % key)
            out[key] = f
    return out


def serialize_join_records(records: Sequence[dict]) -> List[dict]:
    return [serialize_join_record(r) for r in (records or [])]


def format_join_records(records: Sequence[dict]) -> str:
    """진단용 텍스트 표(join). 숫자만 나온다(직렬화를 거치므로 동일 보증)."""
    rows = serialize_join_records(records)
    lines = ["\t".join(JOIN_RECORD_FIELDS)]
    for r in rows:
        cells = []
        for key in JOIN_RECORD_FIELDS:
            v = r[key]
            cells.append(str(v) if isinstance(v, int) else ("%.6g" % v))
        lines.append("\t".join(cells))
    return "\n".join(lines)
