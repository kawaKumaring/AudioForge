# -*- coding: utf-8 -*-
"""boundary_metrics.py — TEST-ONLY 경계(join) 진단 계측. 순수 numpy, 프로덕션 미배선.

이 모듈은 **어떤 프로덕션 워커도 import 하지 않는다**. 파일 I/O·모델·GPU·서브프로세스가 없고,
numpy 외 의존성이 없다. 목적은 단 하나 — 이미 결합된 mono float32 신호와 '경계 서술자'를 받아
각 join 을 **수치로만** 서술하는 것. 어떤 판정/삭제/보정도 하지 않는다(진단 전용).

무엇을 계측하는가(실제 프로덕션 계약을 그대로 반영):
  tts_worker._concat_with_boundaries(paths, gaps_before, out) 는 chunk 를 순서대로 이어붙이되
  i>0 이고 gaps_before[i]>0 일 때만 chunk i **앞**에 정확한 0 무음 gaps_before[i]*sr 샘플을 넣는다.
  crossfade·zero-cross 정렬·window 는 **없다**(hard butt join). 따라서 실제 존재하는 join 은 두 종류다.
    (a) 자동분할 내부 chunk join  — text_segmenter.split_for_generation 이 만든 chunk 사이. gap 항상 0.
    (b) 원 segment join           — tts_grammar 의 boundary_type(explicitPause / lineSilenceGap /
                                    emotionBoundaryPause / internal)을 _boundary_gaps_from_plan 이
                                    초 단위 gap 으로 환산한 값. immediate 감정 전환은 gap 0.
  말끝(tail) fade/padding 은 audio_finishing.apply_final_tail 이 **결합·pitch 이후 파일 끝에 1회만**
  적용한다 → join 지점의 declared_fade_samples/declared_padding_samples 는 프로덕션에서 항상 0 이다.
  (그래서 서술자에 남겨두되 기본값 0 이고, 값은 그대로 echo 만 한다.)

join_index 규약(중요):
  join_index = 이전 chunk 오디오가 끝난 **바로 다음 샘플 인덱스**. 즉 gap 이 있으면 gap 의 첫 샘플,
  gap 이 0 이면 다음 chunk 의 첫 샘플. 따라서
    prev 창 = signal[j-W : j]                                   (이전 chunk 실제 오디오의 마지막 W)
    next 창 = signal[j+gap : j+gap+W]                           (다음 chunk 실제 오디오의 처음 W)
  선언된 무음은 창에서 제외한다 — 무음 길이가 창 통계를 희석하지 않게 하기 위함이다.
  sample_jump 만은 계약 그대로 |x[j] - x[j-1]| 로, **파형에 실제로 존재하는 이음매 단차**를 잰다
  (gap>0 이면 '마지막 실제 샘플 → 0' 단차, gap==0 이면 '이전 끝 → 다음 시작' 단차).

프라이버시(하드 요건): 이 모듈은 오디오 샘플·대사·참조 전사·파일 경로를 **어떤 형태로도** 내보내지
않는다. 레코드는 숫자/인덱스와 emotion_id(짧은 안전 토큰) 뿐이며, 직렬화 helper 가 이를 강제한다.

계측 1차 함수의 단일 권위: 창 통계(RMS/peak/DC/HF)·이음매 단차·zero-cross 거리·저에너지 꼬리 길이는
**onset_continuity_metrics** 에 한 벌만 존재하며 여기서는 import 해 쓴다(중복 구현 금지). 이 모듈이
계속 소유하는 것은 'join 서술자' 라는 관점 하나뿐이다 — 결합 규칙 거울, BoundaryPoint, join 레코드 스키마.
"""

import math
import re
from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np

import onset_continuity_metrics as ocm

# ────────────────────────── 분석 상수(문서화된 기본값) ──────────────────────────

# 값의 권위는 onset_continuity_metrics 다(여기서 재정의하지 않는다 — 드리프트 방지).
WINDOW_MS = ocm.WINDOW_MS                          # prev/next 창 길이(계약 고정: 50 ms)
ZERO_CROSS_SEARCH_MS = ocm.ZERO_CROSS_SEARCH_MS    # zero crossing 탐색 한계
TRAILING_FRAME_MS = ocm.TRAILING_FRAME_MS          # trailing 저에너지 판정 프레임(비중첩)
TRAILING_LOOKBACK_MS = ocm.TRAILING_LOOKBACK_MS    # trailing 판정 되돌아보기 최대 길이
TRAILING_REL_THRESHOLD = ocm.TRAILING_REL_THRESHOLD  # 구간 최대 프레임 RMS 대비 상대 임계

# emotion_id 안전 토큰: 짧은 식별자만 허용. 경로·문장·전사는 이 패턴을 통과할 수 없다.
SAFE_EMOTION_ID = re.compile(r"^[A-Za-z0-9_.\-]{1,32}$")

RECORD_FIELDS = (
    "prev_tail_rms", "prev_tail_peak",
    "next_head_rms", "next_head_peak",
    "prev_tail_dc", "next_head_dc",
    "sample_jump",
    "prev_zero_cross_distance", "next_zero_cross_distance",
    "hf_energy_prev", "hf_energy_next", "hf_energy_delta",
    "trailing_low_energy_len",
    "declared_gap_samples", "declared_fade_samples", "declared_padding_samples",
    "original_segment_index", "chunk_index", "emotion_id",
)

INT_FIELDS = (
    "prev_zero_cross_distance", "next_zero_cross_distance",
    "trailing_low_energy_len",
    "declared_gap_samples", "declared_fade_samples", "declared_padding_samples",
    "original_segment_index", "chunk_index",
)


# 예외도 한 벌만 존재한다(onset_continuity_metrics 소유). 이름만 여기서 재노출한다.
BoundaryMetricsError = ocm.MetricsError
PrivacyViolation = ocm.PrivacyViolation


@dataclass(frozen=True)
class BoundaryPoint:
    """한 join 의 서술자. 오디오도 텍스트도 경로도 담지 않는다.

    join_index                : 이전 chunk 오디오가 끝난 다음 샘플 인덱스(위 규약 참조).
    original_segment_index    : join **이후**(들어오는) chunk 의 원 segment 인덱스.
    chunk_index               : join 이후 chunk 의 자동분할 chunk 인덱스.
    emotion_id                : join 이후 chunk 의 감정 id(짧은 토큰. 'default' 포함).
    declared_gap_samples      : 이 join 에 선언된 무음 샘플 수(_concat_with_boundaries 가 실제 삽입한 값).
    declared_fade_samples     : 이 join 에 선언된 fade 샘플 수. 프로덕션 join 에선 항상 0.
    declared_padding_samples  : 이 join 에 선언된 padding 샘플 수. 프로덕션 join 에선 항상 0.
    """

    join_index: int
    original_segment_index: int
    chunk_index: int
    emotion_id: str
    declared_gap_samples: int = 0
    declared_fade_samples: int = 0
    declared_padding_samples: int = 0


# ────────────────────────── 프로덕션 결합 규칙의 순수 array 미러 ──────────────────────────

def concat_with_boundaries_array(chunk_audios: Sequence[np.ndarray],
                                 gaps_before: Sequence[int]) -> np.ndarray:
    """tts_worker._concat_with_boundaries 의 array 미러(파일 I/O 없음).

    i>0 이고 gaps_before[i]>0 일 때만 chunk i 앞에 0 무음을 넣는다. gaps_before[0] 은 무시된다.
    crossfade·정렬 없음(프로덕션과 동일한 hard butt join)."""
    if len(chunk_audios) != len(gaps_before):
        raise BoundaryMetricsError(
            f"chunk/gap 길이 불일치: {len(chunk_audios)} vs {len(gaps_before)}")
    out: List[np.ndarray] = []
    for i, audio in enumerate(chunk_audios):
        arr = np.asarray(audio, dtype=np.float32)
        if arr.ndim != 1:
            raise BoundaryMetricsError(f"chunk {i} 가 mono(1-D)가 아님: ndim={arr.ndim}")
        g = int(gaps_before[i])
        if g < 0:
            raise BoundaryMetricsError(f"chunk {i} 의 gap 이 음수: {g}")
        if i > 0 and g > 0:
            out.append(np.zeros(g, dtype=np.float32))
        out.append(arr)
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def build_concat_case(chunks: Sequence[dict]):
    """chunk 기술(dict) 목록 → (결합 신호, BoundaryPoint 목록).

    각 dict 키: audio(1-D float array), original_segment_index, chunk_index, emotion_id,
    gap_samples(선택, 기본 0 — 이 chunk '앞' 무음), fade_samples/padding_samples(선택, 기본 0).
    chunk 가 1개면 join 이 없으므로 boundary 목록은 빈 리스트다(계약: join 없는 경우 = 레코드 없음)."""
    audios = [np.asarray(c["audio"], dtype=np.float32) for c in chunks]
    gaps = [int(c.get("gap_samples", 0)) for c in chunks]
    signal = concat_with_boundaries_array(audios, gaps)

    boundaries: List[BoundaryPoint] = []
    cursor = 0
    for i, c in enumerate(chunks):
        g = gaps[i] if i > 0 else 0
        if i > 0:
            boundaries.append(BoundaryPoint(
                join_index=int(cursor),
                original_segment_index=int(c["original_segment_index"]),
                chunk_index=int(c["chunk_index"]),
                emotion_id=str(c["emotion_id"]),
                declared_gap_samples=int(g),
                declared_fade_samples=int(c.get("fade_samples", 0)),
                declared_padding_samples=int(c.get("padding_samples", 0)),
            ))
            cursor += g
        cursor += int(audios[i].size)
    return signal, boundaries


# ────────────────────────── 내부 계산(순수) ──────────────────────────

# 아래 1차 함수들은 onset_continuity_metrics 가 단일 권위다. 여기서는 이름만 붙여 쓴다.
_ms_to_samples = ocm.ms_to_samples
_window_stats = ocm.window_stats
_zero_cross_distance_back = ocm.zero_cross_distance_back
_zero_cross_distance_fwd = ocm.zero_cross_distance_fwd


def _trailing_low_energy_len(sig: np.ndarray, j: int, lo: int, sr: int,
                             frame_ms: float, lookback_ms: float, rel_threshold: float) -> int:
    """join 직전의 '저에너지/비음성 후보' 꼬리 길이(샘플).

    구현 권위는 onset_continuity_metrics.trailing_low_energy_len 하나뿐이다(여기서 재구현하지 않는다).
    문서화된 상대 임계: lookback 구간의 최대 프레임 RMS × rel_threshold 이하인 마지막 프레임들의 길이.
    절대 dBFS 를 쓰지 않는 이유: 화자/참조 음량에 독립적이어야 하기 때문(상대 판정).
    """
    return ocm.trailing_low_energy_len(sig, j, lo, sr, frame_ms, lookback_ms, rel_threshold)


# ────────────────────────── 공개 API ──────────────────────────

def compute_boundary_metrics(signal, sr, boundaries: Sequence[BoundaryPoint],
                             window_ms: float = WINDOW_MS,
                             zero_cross_search_ms: float = ZERO_CROSS_SEARCH_MS,
                             trailing_frame_ms: float = TRAILING_FRAME_MS,
                             trailing_lookback_ms: float = TRAILING_LOOKBACK_MS,
                             trailing_rel_threshold: float = TRAILING_REL_THRESHOLD) -> List[dict]:
    """결합 신호 + 경계 서술자 → 경계당 레코드 1개(RECORD_FIELDS 정확히 그대로).

    boundaries 가 비면 [] 를 반환한다(join 이 없는 단일 chunk 케이스). 각 창은 인접 join 을 넘지
    않도록 잘린다 — 이전/다음 chunk 의 오디오를 섞어 통계를 오염시키지 않기 위함이다."""
    sig = np.asarray(signal, dtype=np.float32)
    if sig.ndim != 1:
        raise BoundaryMetricsError(f"mono(1-D)만 계측 가능: ndim={sig.ndim}")
    sr = int(sr)
    if sr <= 0:
        raise BoundaryMetricsError(f"sr 는 양수여야 함: {sr}")
    if sig.size and not bool(np.all(np.isfinite(sig))):
        raise BoundaryMetricsError("신호에 비유한 값이 있음")

    items = list(boundaries or [])
    if not items:
        return []

    for b in items:
        if not isinstance(b, BoundaryPoint):
            raise BoundaryMetricsError("BoundaryPoint 서술자가 필요함")
        if b.join_index < 1:
            raise BoundaryMetricsError(f"join_index 가 1 미만: {b.join_index}")
        if b.declared_gap_samples < 0:
            raise BoundaryMetricsError(f"declared_gap_samples 가 음수: {b.declared_gap_samples}")
        if b.join_index + b.declared_gap_samples >= sig.size:
            raise BoundaryMetricsError(
                f"join 이 신호 밖: {b.join_index}+{b.declared_gap_samples} >= {sig.size}")

    order = sorted(range(len(items)), key=lambda k: items[k].join_index)
    win = max(1, _ms_to_samples(window_ms, sr))
    zc_limit = max(1, _ms_to_samples(zero_cross_search_ms, sr))

    records: List[Optional[dict]] = [None] * len(items)
    for pos, idx in enumerate(order):
        b = items[idx]
        j = int(b.join_index)
        gap = int(b.declared_gap_samples)
        h = j + gap                                   # 다음 chunk 실제 오디오 첫 샘플

        # 인접 join 으로 분석 범위를 제한(이전 join 의 오디오 시작 / 다음 join 의 오디오 끝).
        if pos > 0:
            pb = items[order[pos - 1]]
            lo = int(pb.join_index) + int(pb.declared_gap_samples)
        else:
            lo = 0
        if pos + 1 < len(order):
            hi = int(items[order[pos + 1]].join_index)
        else:
            hi = int(sig.size)
        hi = max(hi, h + 1)

        prev_win = sig[max(lo, j - win):j]
        next_win = sig[h:min(hi, h + win)]

        p_rms, p_peak, p_dc, p_hf = _window_stats(prev_win)
        n_rms, n_peak, n_dc, n_hf = _window_stats(next_win)

        jump = ocm.sample_jump(sig, j)

        rec = {
            "prev_tail_rms": p_rms,
            "prev_tail_peak": p_peak,
            "next_head_rms": n_rms,
            "next_head_peak": n_peak,
            "prev_tail_dc": p_dc,
            "next_head_dc": n_dc,
            "sample_jump": jump,
            "prev_zero_cross_distance": _zero_cross_distance_back(sig, j, lo, zc_limit),
            "next_zero_cross_distance": _zero_cross_distance_fwd(sig, h, hi, zc_limit),
            "hf_energy_prev": p_hf,
            "hf_energy_next": n_hf,
            "hf_energy_delta": float(n_hf - p_hf),
            "trailing_low_energy_len": _trailing_low_energy_len(
                sig, j, lo, sr, trailing_frame_ms, trailing_lookback_ms, trailing_rel_threshold),
            "declared_gap_samples": int(gap),
            "declared_fade_samples": int(b.declared_fade_samples),
            "declared_padding_samples": int(b.declared_padding_samples),
            "original_segment_index": int(b.original_segment_index),
            "chunk_index": int(b.chunk_index),
            "emotion_id": str(b.emotion_id),
        }
        records[idx] = rec

    return [r for r in records if r is not None]


# ────────────────────────── 직렬화(프라이버시 강제) ──────────────────────────

def serialize_record(record: dict) -> dict:
    """레코드 1개 → 숫자/인덱스/안전 emotion_id 만 담은 dict.

    RECORD_FIELDS 이외의 키는 통과시키지 않고, 문자열은 emotion_id 하나뿐이며 SAFE_EMOTION_ID
    패턴(짧은 식별자)을 강제한다. 경로·대사·전사는 이 패턴을 통과할 수 없으므로 여기서 차단된다."""
    if not isinstance(record, dict):
        raise PrivacyViolation("레코드는 dict 여야 함")
    extra = set(record.keys()) - set(RECORD_FIELDS)
    if extra:
        raise PrivacyViolation(f"허용되지 않은 필드 {len(extra)}개")
    missing = set(RECORD_FIELDS) - set(record.keys())
    if missing:
        raise PrivacyViolation(f"필드 누락 {len(missing)}개")

    out = {}
    for key in RECORD_FIELDS:
        value = record[key]
        if key == "emotion_id":
            text = str(value)
            if not SAFE_EMOTION_ID.match(text):
                raise PrivacyViolation("emotion_id 가 안전 토큰 형식이 아님(길이/문자 위반)")
            out[key] = text
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
            raise PrivacyViolation(f"'{key}' 가 수치가 아님")
        if key in INT_FIELDS:
            out[key] = int(value)
        else:
            f = float(value)
            if not math.isfinite(f):
                raise PrivacyViolation(f"'{key}' 가 비유한")
            out[key] = f
    return out


def serialize_records(records: Sequence[dict]) -> List[dict]:
    """레코드 목록 직렬화(프라이버시 강제)."""
    return [serialize_record(r) for r in (records or [])]


def format_records(records: Sequence[dict]) -> str:
    """진단용 텍스트 표. 숫자·인덱스·emotion_id 만 나온다(직렬화를 거치므로 동일 보증)."""
    rows = serialize_records(records)
    lines = ["\t".join(RECORD_FIELDS)]
    for r in rows:
        cells = []
        for key in RECORD_FIELDS:
            v = r[key]
            cells.append(v if key == "emotion_id" else
                         (str(v) if isinstance(v, int) else f"{v:.6g}"))
        lines.append("\t".join(cells))
    return "\n".join(lines)
