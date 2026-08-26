# -*- coding: utf-8 -*-
"""재사용 가능한 참조 클립 라이브러리 — 순수 로직(stdlib only, 파일/네트워크 부수효과 없음).

목적: 확정된 3~10초 참조 클립을 "재사용 가능한 자산"으로 만든다. 대본·속도·감정을 바꿔도
지문(fingerprint)이 그대로면 재분석 없이 그 클립을 그대로 쓴다.

구성:
  - 지문(fingerprint): 원본 SHA-256 + 확정 구간(start/duration) + 전사 + 분석 버전.
    정규 직렬화(canonical serialization)를 한 곳(build_fingerprint_payload)에만 정의하고
    TS(src/shared/referenceLibrary.ts)가 바이트 단위로 동일하게 미러링한다.
  - 무효화(invalidation): 위 4개 입력이 바뀔 때만, 각각 고유한 reason code로 구분해 알린다.
    대본/속도/감정/피치는 지문 입력이 아니므로 절대 무효화하지 않는다.
  - 자동 후보(auto candidates): 점수화된 구간에서 서로 겹치지 않는 최대 3개를 고른다.
    선택된 후보는 다음 탐색에서 제외된다(select_best_candidate의 taken 인자).
  - 단일 참조 보증: 후보는 여러 개 저장·미리듣기 가능하지만 합성에 넘기는 참조는 정확히 1개다
    (assert_single_reference / build_synthesis_reference).

정책:
  - 원본 미디어는 절대 변경하지 않는다. 이 모듈은 어떤 파일도 쓰지 않는다.
  - 외부 전송 없음. 저장 구조에는 경로·전사 원문이 담기지 않는다(불투명 id + 숫자 지표만).
"""
import hashlib
import math
import re

# ── 분석 버전 — 알고리즘/지표 정의가 바뀌면 올린다(= 기존 지문 전량 무효화). TS와 동일해야 한다. ──
REFERENCE_ANALYSIS_VERSION = 1

# ── 무효화 사유 코드 — 각 원인이 서로 구분되는 고유 코드. TS와 집합이 동일해야 한다. ──
REF_SOURCE_CHANGED = "REF_SOURCE_CHANGED"                      # 원본 파일이 다름(SHA-256 불일치)
REF_REGION_CHANGED = "REF_REGION_CHANGED"                      # 확정 구간(start 또는 duration)이 다름
REF_TRANSCRIPT_CHANGED = "REF_TRANSCRIPT_CHANGED"              # 참조 전사문이 다름
REF_ANALYSIS_VERSION_CHANGED = "REF_ANALYSIS_VERSION_CHANGED"  # 분석 버전 상향(알고리즘 변경)

REFERENCE_INVALIDATION_REASONS = (
    REF_SOURCE_CHANGED,
    REF_REGION_CHANGED,
    REF_TRANSCRIPT_CHANGED,
    REF_ANALYSIS_VERSION_CHANGED,
)

# ── 가드 코드 — 구조/선택 불변식 위반. TS와 집합이 동일해야 한다. ──
NO_REFERENCE_SELECTED = "NO_REFERENCE_SELECTED"                # 선택된 참조가 0개
MULTIPLE_REFERENCES_SELECTED = "MULTIPLE_REFERENCES_SELECTED"  # 선택된 참조가 2개 이상(합성 경로 위반)
UNKNOWN_REFERENCE_SELECTED = "UNKNOWN_REFERENCE_SELECTED"      # 저장된 후보에 없는 id
OVERLAPPING_CANDIDATES = "OVERLAPPING_CANDIDATES"              # 저장 후보끼리 구간이 겹침
TOO_MANY_CANDIDATES = "TOO_MANY_CANDIDATES"                    # 후보 3개 초과
INVALID_FINGERPRINT_INPUT = "INVALID_FINGERPRINT_INPUT"        # 지문 입력이 규격 위반

REFERENCE_GUARD_CODES = (
    NO_REFERENCE_SELECTED,
    MULTIPLE_REFERENCES_SELECTED,
    UNKNOWN_REFERENCE_SELECTED,
    OVERLAPPING_CANDIDATES,
    TOO_MANY_CANDIDATES,
    INVALID_FINGERPRINT_INPUT,
)

# ── 정책 상수 ──
MAX_AUTO_CANDIDATES = 3        # 자동 추천 후보 최대 개수
MIN_REGION_MS = 3000           # 참조 하한(3.0초) — reference_region 정책과 동일
MAX_REGION_MS = 10000          # 참조 상한(10.0초)

# ── 정규 직렬화 상수 — 여기 한 곳이 권위. TS가 바이트 단위로 미러링한다. ──
FINGERPRINT_PAYLOAD_HEADER = "reflib-fp/1"   # 직렬화 포맷 자체의 버전(분석 버전과 별개)
FINGERPRINT_FIELD_SEPARATOR = "\n"           # 필드 구분자(개행). 끝에 개행 없음.
FINGERPRINT_FIELD_ORDER = (                  # 필드 순서 — 절대 바꾸지 않는다(바꾸면 header 버전 상향)
    "analysis_version",
    "source_sha256",
    "region_start_ms",
    "region_duration_ms",
    "transcript_sha256",
)
CLIP_ID_PAYLOAD_HEADER = "reflib-clip/1"
CLIP_ID_LENGTH = 16                          # 클립 id = sha256 hex 앞 16자

# 지문에 절대 들어가지 않는 축(대본/속도/감정/피치) — 바뀌어도 재분석하지 않는다.
VOLATILE_AXES = ("script", "speed", "emotion_id", "pitch")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# 정규화 시 양끝에서 제거하는 공백 — ASCII 6종으로 명시(언어별 strip 차이 제거).
_TRIM_CHARS = " \t\n\r\f\v"


class ReferenceLibraryError(Exception):
    """구조화 오류 — code는 REFERENCE_GUARD_CODES 중 하나. 메시지에 경로/전사 원문을 담지 않는다."""

    def __init__(self, code, detail=""):
        super().__init__("%s%s" % (code, (": " + detail) if detail else ""))
        self.code = code
        self.detail = detail


# ─────────────────────────────────────────────────────────────────────────────
# 정규화 helper — TS와 동일 규칙
# ─────────────────────────────────────────────────────────────────────────────
def normalize_transcript(text):
    """전사 정규화: ASCII 공백 6종(space/tab/LF/CR/FF/VT)만 양끝에서 제거. 내부는 손대지 않는다.
    언어별 strip()의 유니코드 공백 차이를 없애기 위해 문자 집합을 명시한다."""
    if text is None:
        return ""
    return str(text).strip(_TRIM_CHARS)


def seconds_to_ms(seconds):
    """초 → 정수 밀리초. floor(x*1000 + 0.5)로 반올림 규칙을 TS와 동일하게 고정한다
    (파이썬 round()의 짝수 반올림, JS Math.round의 음수 처리 차이를 모두 회피)."""
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "seconds must be a number")
    v = float(seconds)
    if not math.isfinite(v) or v < 0:
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "seconds must be finite and >= 0")
    return int(math.floor(v * 1000.0 + 0.5))


def sha256_hex_of_string(text):
    """UTF-8 바이트의 sha256 hex(소문자 64자)."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _require_sha256(value, field):
    v = (value or "").strip().lower()
    if not _SHA256_RE.match(v):
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "%s must be 64 lowercase hex chars" % field)
    return v


def sha256_hex_of_source(path, reader=None, chunk_size=1024 * 1024):
    """원본 파일의 SHA-256(소문자 hex). reader를 주입하면 실제 파일 없이도 계산할 수 있다.

    reader(path) → bytes 또는 bytes를 내는 iterable. 기본 reader만 파일을 읽기 전용으로 연다.
    원본은 절대 쓰지 않는다(이 함수는 open(path, "rb")만 수행)."""
    h = hashlib.sha256()
    if reader is None:
        def reader(p):
            with open(p, "rb") as f:
                while True:
                    block = f.read(chunk_size)
                    if not block:
                        return
                    yield block
    chunks = reader(path)
    if isinstance(chunks, (bytes, bytearray)):
        chunks = [chunks]
    for block in chunks:
        if not isinstance(block, (bytes, bytearray)):
            raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "reader must yield bytes")
        h.update(block)
    return h.hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# 지문(fingerprint) — 정규 직렬화의 단일 권위
# ─────────────────────────────────────────────────────────────────────────────
def build_fingerprint_payload(source_sha256, region_start_sec, region_duration_sec,
                              transcript, analysis_version=REFERENCE_ANALYSIS_VERSION):
    """지문 계산에 쓰이는 정규 문자열을 만든다(이 포맷이 곧 계약).

    형식(끝 개행 없음):
        reflib-fp/1
        analysis_version=<정수>
        source_sha256=<소문자 hex 64>
        region_start_ms=<정수>
        region_duration_ms=<정수>
        transcript_sha256=<소문자 hex 64>

    - 필드 순서는 FINGERPRINT_FIELD_ORDER 고정, 구분자는 개행 1개, 각 줄은 key=value.
    - 초는 floor(sec*1000+0.5)로 정수 ms 변환 후 10진 표기(부호·자릿수 구분자 없음).
    - 전사는 normalize_transcript 후 UTF-8 sha256(원문은 payload에 담기지 않는다).
    """
    if not isinstance(analysis_version, int) or isinstance(analysis_version, bool) or analysis_version < 0:
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "analysis_version must be a non-negative int")
    values = {
        "analysis_version": str(analysis_version),
        "source_sha256": _require_sha256(source_sha256, "source_sha256"),
        "region_start_ms": str(seconds_to_ms(region_start_sec)),
        "region_duration_ms": str(seconds_to_ms(region_duration_sec)),
        "transcript_sha256": sha256_hex_of_string(normalize_transcript(transcript)),
    }
    lines = [FINGERPRINT_PAYLOAD_HEADER]
    lines.extend("%s=%s" % (k, values[k]) for k in FINGERPRINT_FIELD_ORDER)
    return FINGERPRINT_FIELD_SEPARATOR.join(lines)


def compute_fingerprint(source_sha256, region_start_sec, region_duration_sec,
                        transcript, analysis_version=REFERENCE_ANALYSIS_VERSION):
    """정규 문자열의 sha256 hex(64자). 같은 입력이면 항상 같은 값(프로세스/OS 무관)."""
    return sha256_hex_of_string(build_fingerprint_payload(
        source_sha256, region_start_sec, region_duration_sec, transcript, analysis_version))


def compute_fingerprint_from_request(request):
    """dict 요청에서 지문을 계산한다. 대본/속도/감정/피치(VOLATILE_AXES)는 읽지도 않는다."""
    region = (request or {}).get("region") or {}
    return compute_fingerprint(
        (request or {}).get("source_sha256"),
        region.get("start", 0.0),
        region.get("duration", 0.0),
        (request or {}).get("transcript", ""),
        (request or {}).get("analysis_version", REFERENCE_ANALYSIS_VERSION),
    )


def derive_clip_id(source_sha256, start_sec, duration_sec):
    """파생 클립의 불투명 id(hex 16자). 경로가 아니다 — 경로 매핑은 main 프로세스 소유."""
    payload = FINGERPRINT_FIELD_SEPARATOR.join([
        CLIP_ID_PAYLOAD_HEADER,
        "source_sha256=%s" % _require_sha256(source_sha256, "source_sha256"),
        "start_ms=%d" % seconds_to_ms(start_sec),
        "duration_ms=%d" % seconds_to_ms(duration_sec),
    ])
    return sha256_hex_of_string(payload)[:CLIP_ID_LENGTH]


# ─────────────────────────────────────────────────────────────────────────────
# 재사용 / 무효화
# ─────────────────────────────────────────────────────────────────────────────
def evaluate_reuse(stored, requested):
    """저장된 항목(stored)을 요청(requested)에 재사용할 수 있는지 판정한다.

    stored: {"fingerprint", "source_sha256", "region": {"start","duration"}, "transcript",
             "analysis_version"} — 지문 재계산에 필요한 입력을 그대로 보관한 형태.
    requested: 같은 모양 + (무시되는) script/speed/emotion_id/pitch.

    반환: {"reusable": bool, "reasons": [code...], "fingerprint": hex, "stored_fingerprint": hex}
    reasons는 REFERENCE_INVALIDATION_REASONS 순서로 정렬돼 결정적이다.
    """
    stored = stored or {}
    requested = requested or {}
    s_region = stored.get("region") or {}
    r_region = requested.get("region") or {}
    s_version = stored.get("analysis_version", REFERENCE_ANALYSIS_VERSION)
    r_version = requested.get("analysis_version", REFERENCE_ANALYSIS_VERSION)

    stored_fp = stored.get("fingerprint") or compute_fingerprint(
        stored.get("source_sha256"), s_region.get("start", 0.0), s_region.get("duration", 0.0),
        stored.get("transcript", ""), s_version)
    requested_fp = compute_fingerprint(
        requested.get("source_sha256"), r_region.get("start", 0.0), r_region.get("duration", 0.0),
        requested.get("transcript", ""), r_version)

    reasons = []
    if _require_sha256(stored.get("source_sha256"), "source_sha256") != \
            _require_sha256(requested.get("source_sha256"), "source_sha256"):
        reasons.append(REF_SOURCE_CHANGED)
    if (seconds_to_ms(s_region.get("start", 0.0)) != seconds_to_ms(r_region.get("start", 0.0))
            or seconds_to_ms(s_region.get("duration", 0.0)) != seconds_to_ms(r_region.get("duration", 0.0))):
        reasons.append(REF_REGION_CHANGED)
    if sha256_hex_of_string(normalize_transcript(stored.get("transcript", ""))) != \
            sha256_hex_of_string(normalize_transcript(requested.get("transcript", ""))):
        reasons.append(REF_TRANSCRIPT_CHANGED)
    if s_version != r_version:
        reasons.append(REF_ANALYSIS_VERSION_CHANGED)

    order = {code: i for i, code in enumerate(REFERENCE_INVALIDATION_REASONS)}
    reasons.sort(key=lambda c: order[c])
    return {
        "reusable": (not reasons) and stored_fp == requested_fp,
        "reasons": reasons,
        "fingerprint": requested_fp,
        "stored_fingerprint": stored_fp,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 자동 후보 선택 — 순수 구간 연산
# ─────────────────────────────────────────────────────────────────────────────
def interval_end_ms(interval):
    return int(interval["start_ms"]) + int(interval["duration_ms"])


def intervals_overlap(a, b):
    """겹침 규칙: 구간은 반열린 [start, start+duration). 끝점이 맞닿는 경우(a.end == b.start)는
    겹치지 않음으로 본다. 즉 겹침 ⇔ a.start < b.end AND b.start < a.end."""
    return int(a["start_ms"]) < interval_end_ms(b) and int(b["start_ms"]) < interval_end_ms(a)


def _sort_key(iv):
    # 점수 내림차순 → start 오름차순 → duration 오름차순 → id 오름차순(완전 결정적)
    return (-float(iv.get("score", 0.0)), int(iv["start_ms"]), int(iv["duration_ms"]), str(iv.get("id", "")))


def select_best_candidate(scored, taken=(), min_duration_ms=MIN_REGION_MS, max_duration_ms=MAX_REGION_MS):
    """점수화된 구간들 중, 이미 확보된 구간(taken) 어느 것과도 겹치지 않는 최고 점수 구간 1개를 반환.
    없으면 None. 순수 함수 — 입력을 변형하지 않는다.

    길이 정책([min,max] ms) 밖이거나 duration<=0인 구간은 애초에 후보가 아니다."""
    taken = list(taken or [])
    best = None
    for iv in (scored or []):
        dur = int(iv["duration_ms"])
        if dur <= 0 or dur < min_duration_ms or dur > max_duration_ms:
            continue
        if int(iv["start_ms"]) < 0:
            continue
        if any(intervals_overlap(iv, t) for t in taken):
            continue
        if best is None or _sort_key(iv) < _sort_key(best):
            best = iv
    return best


def pick_auto_candidates(scored, max_count=MAX_AUTO_CANDIDATES, taken=(),
                         min_duration_ms=MIN_REGION_MS, max_duration_ms=MAX_REGION_MS):
    """서로 겹치지 않는 자동 추천 후보를 최대 max_count개 고른다.
    한 후보가 선택되면 다음 탐색의 taken에 들어가 제외된다(요구 4)."""
    picked = []
    acc = list(taken or [])
    for _ in range(max(0, int(max_count))):
        best = select_best_candidate(scored, acc, min_duration_ms, max_duration_ms)
        if best is None:
            break
        picked.append(best)
        acc.append(best)
    return picked


# ─────────────────────────────────────────────────────────────────────────────
# 저장 구조 + 단일 참조 보증
# ─────────────────────────────────────────────────────────────────────────────
def _metric(value):
    try:
        v = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


def build_candidate(source_sha256, start_sec, duration_sec, metrics=None, score=0.0):
    """저장/전송용 후보 1개. 경로·전사 원문 없음, 지표는 숫자만."""
    m = metrics or {}
    return {
        "id": derive_clip_id(source_sha256, start_sec, duration_sec),
        "start_ms": seconds_to_ms(start_sec),
        "duration_ms": seconds_to_ms(duration_sec),
        "score": _metric(score),
        "metrics": {
            "silence_ratio": _metric(m.get("silence_ratio")),
            "clipping_ratio": _metric(m.get("clipping_ratio")),
            "rms_dbfs": _metric(m.get("rms_dbfs")),
            "peak": _metric(m.get("peak")),
            "speech_ratio": _metric(m.get("speech_ratio")),
        },
    }


def assert_candidate_set_valid(candidates):
    """저장 후보 집합 불변식: 3개 이하 + 서로 겹치지 않음."""
    cands = list(candidates or [])
    if len(cands) > MAX_AUTO_CANDIDATES:
        raise ReferenceLibraryError(TOO_MANY_CANDIDATES, "%d > %d" % (len(cands), MAX_AUTO_CANDIDATES))
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            if intervals_overlap(cands[i], cands[j]):
                raise ReferenceLibraryError(OVERLAPPING_CANDIDATES, "index %d and %d" % (i, j))
    return cands


def build_library_entry(source_sha256, region, transcript, candidates=(),
                        default_candidate_id=None, analysis_version=REFERENCE_ANALYSIS_VERSION):
    """영속 저장 항목. 원본 경로·전사 원문은 담지 않는다(해시 + 불투명 id + 숫자만).
    확정 구간은 항상 첫 후보로 포함되며, 기본값 미지정이면 그것이 기본 참조가 된다."""
    src = _require_sha256(source_sha256, "source_sha256")
    region = region or {}
    # 확정 구간은 항상 첫 후보. 호출부가 같은 구간의 후보(지표 포함)를 이미 줬다면 그쪽을 쓴다
    # — 그렇지 않으면 기본 참조만 지표가 0으로 비어 UI가 추천 근거를 보여줄 수 없다.
    confirmed_id = derive_clip_id(src, region.get("start", 0.0), region.get("duration", 0.0))
    supplied = next((c for c in (candidates or []) if c.get("id") == confirmed_id), None)
    confirmed = supplied or build_candidate(src, region.get("start", 0.0), region.get("duration", 0.0))
    cands = [confirmed]
    for c in (candidates or []):
        if not any(x["id"] == c["id"] for x in cands):
            cands.append(c)
    cands = cands[:MAX_AUTO_CANDIDATES]
    assert_candidate_set_valid(cands)
    default_id = default_candidate_id or confirmed["id"]
    if not any(c["id"] == default_id for c in cands):
        raise ReferenceLibraryError(UNKNOWN_REFERENCE_SELECTED, "default id not in candidates")
    return {
        "fingerprint": compute_fingerprint(src, region.get("start", 0.0), region.get("duration", 0.0),
                                           transcript, analysis_version),
        "analysis_version": analysis_version,
        "source_sha256": src,
        "transcript_sha256": sha256_hex_of_string(normalize_transcript(transcript)),
        "region_start_ms": seconds_to_ms(region.get("start", 0.0)),
        "region_duration_ms": seconds_to_ms(region.get("duration", 0.0)),
        "candidates": cands,
        "default_candidate_id": default_id,
    }


def assert_single_reference(entry, selected_ids):
    """합성에 넘길 참조가 정확히 1개임을 강제한다(요구 6 — UI 편의가 아니라 정확성 요구).
    여러 후보를 저장·미리듣기하는 것은 허용되지만 선택은 언제나 1개여야 한다."""
    entry = entry or {}
    cands = assert_candidate_set_valid(entry.get("candidates"))
    if isinstance(selected_ids, str):
        selected_ids = [selected_ids]
    uniq = []
    for sid in (selected_ids or []):
        if sid and sid not in uniq:
            uniq.append(sid)
    if not uniq:
        raise ReferenceLibraryError(NO_REFERENCE_SELECTED, "0 selected")
    if len(uniq) > 1:
        raise ReferenceLibraryError(MULTIPLE_REFERENCES_SELECTED, "%d selected" % len(uniq))
    for c in cands:
        if c["id"] == uniq[0]:
            return c
    raise ReferenceLibraryError(UNKNOWN_REFERENCE_SELECTED, "id not in candidates")


def build_synthesis_reference(entry, selected_ids):
    """합성 경로에 넘기는 payload — 정확히 하나의 클립. 경로/전사 원문 없음."""
    c = assert_single_reference(entry, selected_ids)
    return {
        "clip_id": c["id"],
        "start_ms": c["start_ms"],
        "duration_ms": c["duration_ms"],
        "fingerprint": (entry or {}).get("fingerprint", ""),
        "analysis_version": (entry or {}).get("analysis_version", REFERENCE_ANALYSIS_VERSION),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 위생(hygiene) 검사 — 저장/전송 구조에 경로·전사 원문이 새지 않는지
# ─────────────────────────────────────────────────────────────────────────────
_PATHLIKE_RE = re.compile(r"[/\\]|^[A-Za-z]:|^file:", re.IGNORECASE)


def is_path_like(text):
    """경로처럼 보이는 문자열인가: 슬래시/역슬래시 포함, 드라이브 문자로 시작, file: 스킴."""
    return bool(isinstance(text, str) and text and _PATHLIKE_RE.search(text))


def find_sensitive_strings(value, forbidden=(), _at="$"):
    """구조 안에서 (a) 경로처럼 보이는 문자열, (b) 금지 문자열(전사 원문 등) 포함을 찾아
    위치와 종류만 돌려준다. 값 자체는 반환하지 않는다(로그 유출 방지)."""
    hits = []
    if isinstance(value, dict):
        for k in sorted(value.keys(), key=str):
            hits.extend(find_sensitive_strings(value[k], forbidden, "%s.%s" % (_at, k)))
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            hits.extend(find_sensitive_strings(v, forbidden, "%s[%d]" % (_at, i)))
    elif isinstance(value, str):
        if is_path_like(value):
            hits.append({"at": _at, "kind": "path_like"})
        for f in (forbidden or ()):
            if f and f in value:
                hits.append({"at": _at, "kind": "forbidden_text"})
                break
    return hits
