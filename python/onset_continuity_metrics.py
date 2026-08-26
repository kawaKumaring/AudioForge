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
ONSET_SLOPE_FRAME_MS = 10.0      # 온셋 기울기 계산 프레임(비중첩)
STABLE_MARGIN_MS = 200.0         # 안정 구간을 잡을 때 청크 앞/뒤에서 잘라내는 여유
STABLE_MIN_MS = 300.0            # 안정 구간 최소 길이. 못 채우면 fallback 플래그를 세운다
SILENCE_FRAME_MS = 5.0           # 앞/뒤 무음 판정 프레임
SILENCE_REL_THRESHOLD = 0.10     # 무음 판정 상대 임계(구간 최대 프레임 RMS 대비)

F0_MIN_HZ = 60.0
F0_MAX_HZ = 400.0
F0_VOICED_MIN_CORR = 0.30        # 자기상관 정규화 피크가 이보다 낮으면 무성으로 보고 0.0
F0_ANALYSIS_MS = 500.0           # F0 분석에 쓰는 최대 창 길이(더 길면 '가운데' 를 잘라 쓴다)

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
    """온셋 구간의 프레임 RMS 증가 기울기(진폭/초). 프레임이 2개 미만이면 0.0.

    최소제곱 1차 회귀 기울기를 쓴다 — 첫 프레임과 마지막 프레임만 보는 것보다 잡음에 강하다.
    부호 그대로 서술한다(감소면 음수). 판정하지 않는다.
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
                                     zero_cross_search_ms: float = ZERO_CROSS_SEARCH_MS) -> List[dict]:
    """산출 신호 + 청크 구간 → 청크당 레코드 1개(ONSET_RECORD_FIELDS 정확히 그대로).

    각 청크의 **첫 onset_window_ms** 를 같은 청크의 **안정 구간**과 대조한다.
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

        onset = sig[start:onset_hi]
        stable = sig[st_lo:st_hi]

        o_rms, o_peak, o_dc, o_hf = window_stats(onset)
        s_rms, s_peak, s_dc, s_hf = window_stats(stable)

        o_f0 = f0_hz(onset, sr)
        s_f0 = f0_hz(stable, sr)
        f0_ratio = float(o_f0 / s_f0) if (o_f0 > 0.0 and s_f0 > 0.0) else 0.0

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
