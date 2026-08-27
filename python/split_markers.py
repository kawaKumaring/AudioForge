"""분할 마커 검증 — src/shared/splitMarkers.ts 의 Python 미러 (C2-P0.3).

규칙·상수·reasonCode 문자열이 TS 쪽과 1:1로 같아야 한다(양방향 parity 테스트로 고정).

⚠️ stdlib only. numpy / torch / soundfile / ffmpeg 없이 import 가능해야 한다(separate.py split 경로가 가볍기 때문).
⚠️ 조용한 복구 금지: clamp / sort / dedupe 하지 않는다. 잘못된 입력은 구조화 오류로 REJECT 한다.
⚠️ 오류 payload에는 marker index / reasonCode / 숫자값만 담는다.
   파일 경로·파일명·지문 문자열·미디어 내용은 절대 넣지 않는다(미디어 정책).
⚠️ payload 키는 camelCase — emit("result", outputDir=...) 처럼 renderer와 그대로 주고받는 wire 형식이다.
"""

import math

# 트랙 하나의 최소 길이(초). 이보다 짧은 구간이 생기면 REJECT — ffmpeg 0초 트랙 방지.
MIN_TRACK_SECONDS = 1.0

# 분할 지점 최대 개수. 넘으면 REJECT(개별 마커 오류를 쏟아내지 않고 목록 단위로 1건).
MAX_MARKER_COUNT = 200

# 트랙 길이 비교용 부동소수 허용오차(초). 10.2-9.2 = 0.9999999999999996 같은 이진오차 오검출 방지.
TRACK_LENGTH_EPSILON = 1e-9

# 목록 단위(특정 마커가 아닌) 오류의 index 값.
LIST_LEVEL_INDEX = -1

# reasonCode 집합(문자열 prefix 추론 금지 — renderer/main/Python 공용 권위 집합).
# 이 튜플의 순서·철자는 src/shared/splitMarkers.ts SPLIT_MARKER_REASON_CODES 와 정확히 같아야 한다.
SPLIT_MARKER_REASON_CODES = (
    "MARKER_NOT_FINITE",      # number가 아니거나 NaN/Infinity
    "MARKER_NOT_POSITIVE",    # 0초 이하(0 정확히 포함 — 첫 트랙 시작은 마커가 아니다)
    "MARKER_BEYOND_DURATION", # 오디오 길이 이상(길이 정확히 포함 — ffmpeg 음수 -t 유발)
    "MARKER_NOT_INCREASING",  # 앞 마커보다 작음(정렬은 검증기가 대신 해주지 않는다)
    "MARKER_DUPLICATE",       # 앞 마커와 값이 같음(0초 트랙 유발)
    "TRACK_TOO_SHORT",        # 인접 경계 간 구간이 최소 트랙 길이 미만
    "MARKER_COUNT_EXCEEDED",  # 마커 개수가 최대치 초과
    "FINGERPRINT_MISMATCH",   # 마커가 만들어진 파일 지문과 처리 대상 파일 지문이 다름
    "DURATION_INVALID",       # 길이가 유한 양수가 아님(ffprobe 실패 등) → 범위 검증 불가
)


def _is_finite_number(v):
    """TS의 `typeof v === 'number' && Number.isFinite(v)` 미러. bool/str은 숫자가 아니다(강제 변환 없음)."""
    if isinstance(v, bool):
        return False
    if not isinstance(v, (int, float)):
        return False
    return math.isfinite(v)


def _normalize_fingerprint(v):
    if not isinstance(v, str):
        return None
    t = v.strip()
    return t if t else None


def fingerprint_matches(a, b):
    """지문 비교 헬퍼. 지문 값 자체는 호출자가 공급한다(여기서 파일 해시를 계산하지 않는다).

    - 둘 다 없음 → True(지문 추적을 쓰지 않는 호출자)
    - 한쪽만 있음 → False(마커에는 지문이 있는데 대상 파일에는 없음 = 신뢰 불가)
    - 둘 다 있음 → 문자열 완전 일치일 때만 True
    """
    na = _normalize_fingerprint(a)
    nb = _normalize_fingerprint(b)
    if na is None and nb is None:
        return True
    if na is None or nb is None:
        return False
    return na == nb


def _err(index, reason_code, value=None, limit=None):
    e = {"index": index, "reasonCode": reason_code}
    if value is not None:
        e["value"] = value
    if limit is not None:
        e["limit"] = limit
    return e


def validate_markers(markers, duration_seconds, fingerprint=None, expected_fingerprint=None,
                     min_track_seconds=None, max_marker_count=None):
    """분할 마커 검증. 통과하면 입력 그대로 돌려주고, 아니면 구조화 오류 목록을 돌려준다.

    절대 고쳐서 돌려주지 않는다(no silent repair).

    반환(ok):   {"ok": True, "markers": [...], "trackCount": int|None, "autoSilenceSplit": bool}
    반환(reject): {"ok": False, "errors": [{"index": int, "reasonCode": str, "value"?: float, "limit"?: float}]}

    단계: 빈 목록 → 개수 → 지문 → 길이 → 마커별(유한/양수/범위/순서/중복) → 트랙 길이.
    앞 단계에서 걸리면 뒤 단계는 돌리지 않는다(정렬 안 된 값으로 계산한 트랙 길이는 무의미).
    """
    if not isinstance(markers, (list, tuple)):
        raise TypeError("validate_markers: markers must be a list or tuple")

    min_track = (min_track_seconds
                 if _is_finite_number(min_track_seconds) and min_track_seconds > 0
                 else MIN_TRACK_SECONDS)
    max_count = (int(math.floor(max_marker_count))
                 if _is_finite_number(max_marker_count) and max_marker_count > 0
                 else MAX_MARKER_COUNT)

    # 1) 마커 0개 = 정상. 배치가 ffmpeg 무음 자동 분할로 간다(조용한 fallthrough가 아니라 명시 신호).
    if len(markers) == 0:
        return {"ok": True, "markers": [], "trackCount": None, "autoSilenceSplit": True}

    # 2) 개수 초과 — 목록 단위 1건만.
    if len(markers) > max_count:
        return {"ok": False,
                "errors": [_err(LIST_LEVEL_INDEX, "MARKER_COUNT_EXCEEDED", len(markers), max_count)]}

    # 3) 지문 불일치 — 다른 파일 기준 마커이므로 좌표 검증 자체가 무의미. 즉시 반환.
    if not fingerprint_matches(fingerprint, expected_fingerprint):
        return {"ok": False, "errors": [_err(LIST_LEVEL_INDEX, "FINGERPRINT_MISMATCH")]}

    # 4) 길이가 유한 양수가 아니면 범위 검증이 불가능하다 → 조용히 통과시키지 않는다.
    duration = duration_seconds
    if not _is_finite_number(duration) or duration <= 0:
        value = duration if _is_finite_number(duration) else None
        return {"ok": False, "errors": [_err(LIST_LEVEL_INDEX, "DURATION_INVALID", value)]}

    # 5) 마커별 검증. 한 마커가 여러 규칙을 어기면 규칙마다 1건씩 보고한다.
    errors = []
    accepted = []
    prev = None

    for i, raw in enumerate(markers):
        if not _is_finite_number(raw):
            # NaN/Infinity/문자열/bool — 강제 변환하지 않는다. prev도 갱신하지 않는다.
            errors.append(_err(i, "MARKER_NOT_FINITE"))
            continue
        bad = False
        if raw <= 0:
            errors.append(_err(i, "MARKER_NOT_POSITIVE", raw, 0))
            bad = True
        if raw >= duration:
            errors.append(_err(i, "MARKER_BEYOND_DURATION", raw, duration))
            bad = True
        if prev is not None:
            if raw == prev:
                errors.append(_err(i, "MARKER_DUPLICATE", raw, prev))
                bad = True
            elif raw < prev:
                # 비인접 중복([10,20,10])도 필연적으로 이 규칙에 걸린다.
                errors.append(_err(i, "MARKER_NOT_INCREASING", raw, prev))
                bad = True
        prev = raw
        if not bad:
            accepted.append(raw)

    if errors:
        return {"ok": False, "errors": errors}

    # 6) 트랙 길이. 여기 도달했으면 accepted는 (0, duration) 안의 강한 증가 수열이다.
    boundaries = [0] + list(accepted) + [duration]
    for j in range(len(boundaries) - 1):
        length = boundaries[j + 1] - boundaries[j]
        if length < min_track - TRACK_LENGTH_EPSILON:
            # 구간 j의 책임 마커: 구간을 닫는 마커(마지막 구간은 그 구간을 여는 마지막 마커).
            errors.append(_err(min(j, len(accepted) - 1), "TRACK_TOO_SHORT", length, min_track))

    if errors:
        return {"ok": False, "errors": errors}

    return {"ok": True, "markers": list(accepted), "trackCount": len(accepted) + 1,
            "autoSilenceSplit": False}


def parse_marker_csv(text):
    """--split-points CSV를 '고치지 않고' 숫자열로 옮긴다.

    숫자로 못 읽는 토큰은 원문 문자열 그대로 남겨 validate_markers가 MARKER_NOT_FINITE로 REJECT하게 한다
    (조용히 버리지 않는다 — 기존 `if x.strip()` 필터가 바로 그 조용한 삭제였다).
    빈 토큰(트레일링 콤마 등)은 구분자 잡음이므로 무시한다.
    """
    out = []
    if not text:
        return out
    for tok in str(text).split(","):
        s = tok.strip()
        if not s:
            continue
        try:
            out.append(float(s))
        except ValueError:
            out.append(s)
    return out
