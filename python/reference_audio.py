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
# 필수 조건은 지켰지만 이 엔진에서 검증된(권장) 길이 범위 밖이다 — 경고. 차단이 아니다.
OUTSIDE_RECOMMENDED_LENGTH = "OUTSIDE_RECOMMENDED_LENGTH"

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

    길이 조건은 두 층이다 — 섞지 않는다.
      · 필수(min/max_duration_sec): 어기면 error(차단). **엔진이 실제로 요구하는 조건**만 여기 둔다.
        None 이면 그 방향의 필수 한계가 없다는 뜻이다(무제한 지원 선언이 아니다 — 권장 범위 밖은 미검증).
      · 권장(recommended_*_sec): 이 앱에서 결과를 검증한 범위. 밖이면 warning(OUTSIDE_RECOMMENDED_LENGTH).
    basis / recommended_basis 는 그 수치의 출처다. 출처 없는 수치를 여기 넣지 않는다.
    수치는 휴리스틱 — 일반적 휴지/작은 peak로 정상 음성을 차단하지 않도록 보수적으로 잡는다."""
    engine: str
    min_duration_sec: Optional[float]
    max_duration_sec: Optional[float]
    recommended_min_sec: Optional[float] = None
    recommended_max_sec: Optional[float] = None
    basis: str = ""
    recommended_basis: str = ""
    # 품질 임계값(정책 — 엔진마다 달라질 수 있음)
    near_silent_rms_dbfs: float = -55.0     # 전체 RMS가 이 이하면 거의 무음(error)
    near_silent_ratio: float = 0.95         # 무음 창 비율이 이 이상이면 거의 무음(error)
    high_silence_ratio: float = 0.40        # 이 이상이면 무음 과다(warning)
    severe_clip_ratio: float = 0.05         # 클리핑 비율 이 이상이면 심각(error)
    clip_warn_ratio: float = 0.001          # 이 이상이면 소량 클리핑(warning)

    def to_dict(self) -> dict:
        return asdict(self)

    # ── 파생 값(구간 추천·확정·정렬·화면이 모두 여기서 읽는다. 상수를 복제하지 않는다) ──
    def region_bounds(self, source_duration_sec: Optional[float] = None):
        """구간 도구가 쓰는 (min_sec, max_sec). 필수 한계가 없는 방향은 0 / 원본 전체 길이다."""
        lo = 0.0 if self.min_duration_sec is None else float(self.min_duration_sec)
        if self.max_duration_sec is not None:
            hi = float(self.max_duration_sec)
        elif source_duration_sec is not None and source_duration_sec > 0:
            hi = float(source_duration_sec)
        else:
            hi = float("inf")
        return lo, hi

    def recommended_bounds(self):
        """추천이 노리는 (min_sec, max_sec). 권장이 없으면 필수 범위를 그대로 쓴다."""
        lo = self.recommended_min_sec
        hi = self.recommended_max_sec
        if lo is None and hi is None:
            return self.region_bounds()
        return (0.0 if lo is None else float(lo), float("inf") if hi is None else float(hi))

    def region_threshold_sec(self) -> Optional[float]:
        """이 길이를 넘는 원본에는 구간을 추천한다(필수 상한이 있으면 그것, 없으면 권장 상한)."""
        if self.max_duration_sec is not None:
            return float(self.max_duration_sec)
        if self.recommended_max_sec is not None:
            return float(self.recommended_max_sec)
        return None

    def within_required(self, duration_sec: float) -> bool:
        if self.min_duration_sec is not None and duration_sec < self.min_duration_sec:
            return False
        if self.max_duration_sec is not None and duration_sec > self.max_duration_sec:
            return False
        return True

    def within_recommended(self, duration_sec: float) -> bool:
        if self.recommended_min_sec is not None and duration_sec < self.recommended_min_sec:
            return False
        if self.recommended_max_sec is not None and duration_sec > self.recommended_max_sec:
            return False
        return True

    def describe(self) -> dict:
        """IPC/화면용 요약. 화면은 이 값에서 문구를 만든다 — 숫자를 화면 코드에 다시 적지 않는다."""
        return {
            "engine": self.engine,
            "required": {"min_sec": self.min_duration_sec, "max_sec": self.max_duration_sec},
            "recommended": {"min_sec": self.recommended_min_sec, "max_sec": self.recommended_max_sec},
            "basis": self.basis,
            "recommended_basis": self.recommended_basis,
        }


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

    # 2) 길이 정책 — 필수(경계 포함: min/max 정확히 허용). None 이면 그 방향은 검사하지 않는다.
    dur = analysis.duration_sec
    if policy.min_duration_sec is not None and dur < policy.min_duration_sec:
        err(TOO_SHORT, f"참조가 너무 짧습니다({dur:.2f}s < {policy.min_duration_sec:.1f}s).",
            {"duration_sec": dur, "min": policy.min_duration_sec})
    elif policy.max_duration_sec is not None and dur > policy.max_duration_sec:
        err(TOO_LONG, f"참조가 너무 깁니다({dur:.2f}s > {policy.max_duration_sec:.1f}s).",
            {"duration_sec": dur, "max": policy.max_duration_sec})
    elif not policy.within_recommended(dur):
        # 권장(검증) 범위 밖 — 막지 않고 알린다. 길다고 더 좋은 결과가 나온다는 뜻이 아니다.
        lo, hi = policy.recommended_min_sec, policy.recommended_max_sec
        rng = ("%s~%s초" % ("" if lo is None else f"{lo:.0f}", "" if hi is None else f"{hi:.0f}"))
        warn(OUTSIDE_RECOMMENDED_LENGTH,
             f"참조 길이 {dur:.2f}s 는 이 엔진에서 검증된 범위({rng}) 밖입니다 — 결과 품질은 확인되지 않았습니다.",
             {"duration_sec": dur, "recommended_min": lo, "recommended_max": hi})

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
    threshold = policy.region_threshold_sec()
    if meta.readable and threshold is not None and meta.duration_sec > threshold:
        # 필수 상한 초과(TOO_LONG) 또는 권장 상한 초과(구간 추천 대상) → 원본 전체 품질 스캔 불필요.
        # 실제 모델에 갈 구간은 확정 단계(analyze_region)가 따로 잰다.
        return assess_reference(meta, policy)
    # 그 외에는 품질 스캔 포함 분석
    full = analyze_reference_cached(path, quality_scan=True)
    return assess_reference(full, policy)


# ── 엔진별 정책 인스턴스 ────────────────────────────────────────────────────
# GPT-SoVITS: 벤더 추론 코드(GPT_SoVITS/inference_webui.py) 가 3~10초 밖 참조를 예외로 거부한다.
# → **필수** 조건. (경계 포함 허용)
GPTSOVITS_POLICY = ReferencePolicy(
    engine="gptsovits",
    min_duration_sec=3.0,
    max_duration_sec=10.0,
    basis="GPT-SoVITS 벤더 추론 코드가 3~10초 밖 참조를 거부한다(inference_webui.py).",
)

# Qwen3-TTS(로컬 0.6B Base, qwen_tts 패키지): 참조 길이의 벤더 필수 조건이 확인되지 않았다 —
# qwen_tts 는 참조 전체를 speaker encoder(x-vector) 와 speech tokenizer(ICL ref_code) 에 그대로 넣고
# 길이 검사·절단을 하지 않는다. 로컬 스냅샷에 모델 카드가 없어 벤더 권장값은 확인하지 못했다.
# → 필수는 처리 가능 조건(손상·빈 음성·거의 무음·심한 클리핑)만. 길이 필수 한계 없음(None).
# → 권장 3~10초 = **이 앱이 검증한 범위**(GPU 실측 6.5~7.5초 클립으로 청취 통과, 정렬·혼입 방지
#   도구가 이 범위에서 설계·검증). 밖은 미검증 → 경고. "길수록 좋다" 는 근거가 없다.
# 자원 보호: ICL 참조 프레임은 chunk_budget 이 실제 값으로 예산에 넣는다(고정 상수 아님).
QWEN3_POLICY = ReferencePolicy(
    engine="qwen3",
    min_duration_sec=None,
    max_duration_sec=None,
    recommended_min_sec=3.0,
    recommended_max_sec=10.0,
    basis="Qwen3-TTS 벤더 코드에 참조 길이 필수 조건 없음(qwen_tts: 길이 검사·절단 없이 전체 사용). "
          "처리 불가 조건(손상·빈 음성·거의 무음·심한 클리핑)만 필수.",
    recommended_basis="이 앱에서 청취·정렬 검증을 마친 범위(2026-09-05 GPU 실측 6.5~7.5초 클립). "
                      "벤더 권장값은 오프라인에서 미확인. 범위 밖은 미검증 — 경고, 차단 아님.",
)

POLICIES = {
    GPTSOVITS_POLICY.engine: GPTSOVITS_POLICY,
    QWEN3_POLICY.engine: QWEN3_POLICY,
}

# 정책 엔진 해석의 단일 규칙. 화면(ref-analyze/ref-trim)과 합성(tts_worker)이 같은 함수를 쓴다.
#   auto/빈값 → Qwen 런타임이 있으면 qwen3, 없으면 gptsovits(화면 안내 "한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS" 와 동일).
#   qwen3 / gptsovits → 그대로.
#   그 외(f5tts·kokoro 등) → gptsovits 정책 **유지**(이번 분리 범위 밖 — 근거 검토 전까지 기존 표시를 바꾸지 않는다).
POLICY_FALLBACK_ENGINE = GPTSOVITS_POLICY.engine


def resolve_policy_engine(preferred_engine, qwen_available: bool) -> str:
    e = (preferred_engine or "auto")
    e = str(e).strip().lower() or "auto"
    if e == "auto":
        return QWEN3_POLICY.engine if qwen_available else GPTSOVITS_POLICY.engine
    if e in POLICIES:
        return e
    return POLICY_FALLBACK_ENGINE


def policy_for_engine(engine: str) -> ReferencePolicy:
    """알려진 엔진의 정책. 모르는 이름은 조용히 기본으로 바꾸지 않는다 — 호출부가 resolve 로 먼저 정한다."""
    try:
        return POLICIES[str(engine)]
    except KeyError:
        raise ValueError("UNKNOWN_REFERENCE_POLICY_ENGINE: %r" % (engine,))
