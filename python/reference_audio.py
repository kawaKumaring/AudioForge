# -*- coding: utf-8 -*-
"""참조 음성의 객관적 상태 분석 + 엔진별 적합성 판정.

설계 원칙: "오디오 사실 분석"과 "엔진 정책 판정"을 분리한다.
  - analyze_reference(): 길이/샘플레이트/채널/RMS/peak/무음비율/클리핑비율 등 사실만 측정.
    엔진 규칙(예: 3~10초)을 여기 하드코딩하지 않는다 → Qwen3-TTS 등 다른 엔진이 같은
    분석 결과를 그대로 재사용할 수 있다.
  - assess_reference(): ReferencePolicy(엔진별 기준)를 분석 사실에 적용해 error/warning 판정.

결과(dataclass)는 IPC/UI에서 쓸 수 있도록 json.dumps 가능해야 하고, 문자열 메시지만이
아니라 안정적인 issue code(FILE_NOT_FOUND 등)를 함께 제공한다.

의존성: soundfile + numpy (프로젝트가 이미 사용). 새 패키지 없음.
"""
import os
import math
from dataclasses import dataclass, field, asdict
from typing import Optional, List

# ── 안정적 issue code (IPC/UI가 문자열 메시지 대신 이 코드로 분기) ──
FILE_NOT_FOUND = "FILE_NOT_FOUND"
DECODE_FAILED = "DECODE_FAILED"
EMPTY_AUDIO = "EMPTY_AUDIO"
TOO_SHORT = "TOO_SHORT"
TOO_LONG = "TOO_LONG"
NEAR_SILENT = "NEAR_SILENT"
HIGH_SILENCE_RATIO = "HIGH_SILENCE_RATIO"
CLIPPING_DETECTED = "CLIPPING_DETECTED"
SEVERE_CLIPPING = "SEVERE_CLIPPING"
MULTI_CHANNEL = "MULTI_CHANNEL"

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

# ── 분석 계측 상수 (엔진 무관 — "어떻게 측정하는가". 정책 임계값 아님) ──
# 무음 창 크기: 20~30ms 권장. 제로 크로싱을 무음으로 오인하지 않도록 개별 샘플이 아니라
# 이 창의 RMS로 무음을 판정한다. 25ms는 음성 프레임 분석의 일반적 값.
SILENCE_WINDOW_MS = 25.0
# 창 RMS가 이 dBFS 미만이면 해당 창을 "무음"으로 계산(측정 기준). 정책이 아니라 계측 상수.
SILENCE_WINDOW_DBFS = -45.0
# 샘플 절댓값이 이 값 이상이면 클리핑으로 계산. 16-bit full scale 근처. (휴리스틱)
CLIP_SAMPLE_THRESHOLD = 0.99
# dBFS 하한(무음/0 입력을 JSON 안전한 유한값으로 표현). log10(0) = -inf 방지.
DBFS_FLOOR = -120.0
# 블록 스캔 크기(프레임). 긴 파일을 통째로 메모리에 올리지 않기 위한 상한.
# 무음 창 정렬을 위해 실제로는 창 크기 배수로 재조정된다.
_SCAN_BLOCK_TARGET = 1 << 20  # ~1M frames


def _to_dbfs(linear: float) -> float:
    """선형 진폭 → dBFS. 0/음수 입력은 DBFS_FLOOR로 안전 처리."""
    if linear is None or linear <= 0.0:
        return DBFS_FLOOR
    return max(DBFS_FLOOR, 20.0 * math.log10(linear))


@dataclass
class ReferenceAudioAnalysis:
    """참조 음성의 객관적 사실(엔진 무관). json.dumps 가능."""
    source_path: str
    readable: bool
    duration_sec: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    frames: int = 0
    peak: Optional[float] = None
    rms_dbfs: Optional[float] = None
    silence_ratio: Optional[float] = None
    clipping_ratio: Optional[float] = None
    quality_scanned: bool = False
    decode_error: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferencePolicy:
    """엔진별 적합성 기준. 분석 사실에 적용된다.
    수치는 휴리스틱 — 일반적 휴지/작은 peak로 정상 음성을 차단하지 않도록 보수적으로 잡는다."""
    engine: str
    min_duration_sec: float
    max_duration_sec: float
    # 품질 임계값(정책 — 엔진마다 달라질 수 있음)
    near_silent_rms_dbfs: float = -55.0     # 전체 RMS가 이 이하면 거의 무음(error)
    near_silent_ratio: float = 0.95         # 무음 창 비율이 이 이상이면 거의 무음(error)
    high_silence_ratio: float = 0.40        # 이 이상이면 무음 과다(warning)
    severe_clip_ratio: float = 0.05         # 클리핑 비율 이 이상이면 심각(error)
    clip_warn_ratio: float = 0.001          # 이 이상이면 소량 클리핑(warning)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferenceIssue:
    """판정 결과 항목. code는 안정적(IPC/UI 분기용), message는 사람용."""
    code: str
    severity: str
    message: str
    measured: Optional[dict] = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ReferenceAssessment:
    """엔진 정책 판정 결과. json.dumps 가능."""
    engine: str
    valid: bool
    analysis: ReferenceAudioAnalysis
    errors: List[ReferenceIssue] = field(default_factory=list)
    warnings: List[ReferenceIssue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ── 분석 (사실 측정, 엔진 무관) ─────────────────────────────────────────────

def analyze_reference(path: str, quality_scan: bool = True) -> ReferenceAudioAnalysis:
    """참조 음성의 사실을 측정한다. 메타데이터(길이/sr/채널)는 항상, 품질 스캔
    (peak/rms/무음/클리핑)은 quality_scan=True일 때만. 블록 단위로 읽어 긴 파일을
    통째로 메모리에 올리지 않는다."""
    if not os.path.exists(path):
        return ReferenceAudioAnalysis(source_path=path, readable=False,
                                      decode_error="file not found")
    try:
        import soundfile as sf
        info = sf.info(path)
    except Exception as e:  # 디코딩 불가/손상
        return ReferenceAudioAnalysis(source_path=path, readable=False,
                                      decode_error=str(e))

    sr = int(info.samplerate)
    channels = int(info.channels)
    frames = int(info.frames)
    duration = frames / sr if sr > 0 else 0.0

    ana = ReferenceAudioAnalysis(
        source_path=path, readable=True, duration_sec=duration,
        sample_rate=sr, channels=channels, frames=frames,
    )

    if not quality_scan or frames == 0 or sr <= 0:
        # 품질 스캔 생략(메타데이터만) — TOO_LONG 조기 판정/빈 오디오 등에 사용
        return ana

    import numpy as np

    win = max(1, int(round(sr * SILENCE_WINDOW_MS / 1000.0)))
    # 블록 크기를 창 크기의 배수로 맞춰(대략 목표치) 창 경계가 블록을 넘지 않게 한다.
    block = max(win, (_SCAN_BLOCK_TARGET // win) * win)
    silence_lin = 10.0 ** (SILENCE_WINDOW_DBFS / 20.0)

    peak = 0.0
    sumsq = 0.0
    total_samples = 0          # 전체 채널 샘플 수(클리핑 분모)
    clip_count = 0
    mono_count = 0             # 모노 믹스다운 샘플 수(RMS 분모)
    silence_windows = 0
    total_windows = 0

    try:
        import soundfile as sf
        for blk in sf.blocks(path, blocksize=block, dtype="float32", always_2d=True):
            if blk.size == 0:
                continue
            # peak/clipping: 모든 채널의 개별 샘플 기준
            absblk = np.abs(blk)
            peak = max(peak, float(absblk.max()))
            clip_count += int((absblk >= CLIP_SAMPLE_THRESHOLD).sum())
            total_samples += int(blk.size)
            # RMS/무음: 모노 믹스다운
            mono = blk.mean(axis=1)
            sumsq += float(np.square(mono, dtype=np.float64).sum())
            mono_count += int(mono.shape[0])
            # 창(25ms) 단위 무음 판정
            n = mono.shape[0]
            for start in range(0, n, win):
                w = mono[start:start + win]
                if w.shape[0] == 0:
                    continue
                wrms = math.sqrt(float(np.square(w, dtype=np.float64).mean()))
                total_windows += 1
                if wrms < silence_lin:
                    silence_windows += 1
    except Exception as e:
        # 스캔 중 예외(부분 손상 등)는 정상으로 통과시키면 안 된다 → readable=False로 강등.
        # assess_reference가 파일 존재 여부로 DECODE_FAILED(존재)로 판정한다.
        ana.readable = False
        ana.decode_error = f"scan failed: {e}"
        ana.quality_scanned = False
        return ana

    rms_lin = math.sqrt(sumsq / mono_count) if mono_count > 0 else 0.0
    ana.peak = round(peak, 6)
    ana.rms_dbfs = round(_to_dbfs(rms_lin), 3)
    ana.silence_ratio = round(silence_windows / total_windows, 6) if total_windows else 0.0
    ana.clipping_ratio = round(clip_count / total_samples, 6) if total_samples else 0.0
    ana.quality_scanned = True
    return ana


# ── 분석 캐시 (경로만이 아니라 size/mtime로 변경 감지) ──────────────────────
_analysis_cache = {}


def _cache_key(path: str, quality_scan: bool):
    try:
        st = os.stat(path)
        return (os.path.abspath(path), st.st_size, int(st.st_mtime_ns), quality_scan)
    except OSError:
        return None  # 파일 없음 → 캐시 불가(매번 분석하여 FILE_NOT_FOUND 반환)


def analyze_reference_cached(path: str, quality_scan: bool = True) -> ReferenceAudioAnalysis:
    """analyze_reference의 캐시 버전. 같은 파일(size+mtime 동일) 재사용 시 재분석하지 않는다.
    파일이 바뀌면(size/mtime 변경) 키가 달라져 자동 무효화된다."""
    key = _cache_key(path, quality_scan)
    if key is not None and key in _analysis_cache:
        return _analysis_cache[key]
    ana = analyze_reference(path, quality_scan=quality_scan)
    if key is not None:
        _analysis_cache[key] = ana
    return ana


def clear_analysis_cache():
    _analysis_cache.clear()


# ── 판정 (정책 적용, 엔진별) ────────────────────────────────────────────────

def assess_reference(analysis: ReferenceAudioAnalysis, policy: ReferencePolicy) -> ReferenceAssessment:
    """분석 사실 + 정책 → error/warning 판정. 분석 자체는 하지 않는다(순수 정책)."""
    errors: List[ReferenceIssue] = []
    warnings: List[ReferenceIssue] = []

    def err(code, msg, measured=None):
        errors.append(ReferenceIssue(code, SEVERITY_ERROR, msg, measured))

    def warn(code, msg, measured=None):
        warnings.append(ReferenceIssue(code, SEVERITY_WARNING, msg, measured))

    # 1) 읽기/디코딩 (구조적 — 여기서 실패하면 나머지 판정 무의미)
    if not analysis.readable:
        if not os.path.exists(analysis.source_path):
            err(FILE_NOT_FOUND, f"참조 파일을 찾을 수 없습니다: {analysis.source_path}")
        else:
            err(DECODE_FAILED, f"참조 파일을 디코딩할 수 없습니다: {analysis.decode_error}")
        return ReferenceAssessment(policy.engine, False, analysis, errors, warnings)

    if analysis.frames == 0 or analysis.duration_sec <= 0.0:
        err(EMPTY_AUDIO, "빈 오디오입니다(길이 0).", {"frames": analysis.frames})
        return ReferenceAssessment(policy.engine, False, analysis, errors, warnings)

    # 2) 길이 정책 (경계 포함: min/max 정확히 허용)
    if analysis.duration_sec < policy.min_duration_sec:
        err(TOO_SHORT, f"참조가 너무 짧습니다({analysis.duration_sec:.2f}s < {policy.min_duration_sec:.1f}s).",
            {"duration_sec": analysis.duration_sec, "min": policy.min_duration_sec})
    elif analysis.duration_sec > policy.max_duration_sec:
        err(TOO_LONG, f"참조가 너무 깁니다({analysis.duration_sec:.2f}s > {policy.max_duration_sec:.1f}s).",
            {"duration_sec": analysis.duration_sec, "max": policy.max_duration_sec})

    # 3) 품질 정책 (스캔된 경우만)
    if analysis.quality_scanned:
        sr_ratio = analysis.silence_ratio or 0.0
        rms = analysis.rms_dbfs if analysis.rms_dbfs is not None else DBFS_FLOOR
        clip = analysis.clipping_ratio or 0.0

        if sr_ratio >= policy.near_silent_ratio or rms <= policy.near_silent_rms_dbfs:
            err(NEAR_SILENT, f"거의 무음입니다(무음비율 {sr_ratio:.2f}, RMS {rms:.1f}dBFS).",
                {"silence_ratio": sr_ratio, "rms_dbfs": rms})
        elif sr_ratio >= policy.high_silence_ratio:
            warn(HIGH_SILENCE_RATIO, f"무음 비율이 높습니다({sr_ratio:.2f}).",
                 {"silence_ratio": sr_ratio})

        if clip >= policy.severe_clip_ratio:
            err(SEVERE_CLIPPING, f"심각한 클리핑({clip:.3f}).", {"clipping_ratio": clip})
        elif clip >= policy.clip_warn_ratio:
            warn(CLIPPING_DETECTED, f"클리핑이 감지되었습니다({clip:.3f}).", {"clipping_ratio": clip})

    # 4) 채널 (경고 — GPT-SoVITS는 보통 mono 참조를 기대)
    if analysis.channels > 1:
        warn(MULTI_CHANNEL, f"스테레오/다채널({analysis.channels}ch) — mono 권장.",
             {"channels": analysis.channels})

    valid = len(errors) == 0
    return ReferenceAssessment(policy.engine, valid, analysis, errors, warnings)


def assess_reference_file(path: str, policy: ReferencePolicy) -> ReferenceAssessment:
    """파일 경로 → 분석(캐시) → 판정. 긴 파일이 정책상 이미 TOO_LONG이면 품질 전체 스캔을
    생략(quality_scanned=False)해 수십 분 낭비를 막는다."""
    # 먼저 메타데이터만(싸다) 읽어 길이 확인
    meta = analyze_reference_cached(path, quality_scan=False)
    if meta.readable and meta.duration_sec > policy.max_duration_sec:
        # 이미 TOO_LONG → 품질 스캔 불필요
        return assess_reference(meta, policy)
    # 그 외에는 품질 스캔 포함 분석
    full = analyze_reference_cached(path, quality_scan=True)
    return assess_reference(full, policy)


# ── 엔진별 정책 인스턴스 ────────────────────────────────────────────────────
# GPT-SoVITS 공식 입력 조건: 참조 음성 3~10초. (경계 포함 허용)
GPTSOVITS_POLICY = ReferencePolicy(
    engine="gptsovits",
    min_duration_sec=3.0,
    max_duration_sec=10.0,
)
