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

  - 영속 저장(durable library): 확정 클립은 앱 소유 영속 디렉터리에 남아 재시작 후에도 재사용된다.
    manifest는 해시와 clipId만 담고 경로는 영원히 담지 않는다(build_manifest_record / resolve_reusable_clip).
  - 재탐색(rescan): 기존 후보 구간을 명시적 제외 입력으로 받아 겹치지 않는 새 후보만 더한다
    (rescan_candidates). 남은 구간이 없으면 NO_MORE_REFERENCE_CANDIDATES 상태를 돌려준다.

정책:
  - 원본 미디어는 절대 변경하지 않는다. 이 모듈은 어떤 파일도 쓰지 않는다.
  - 외부 전송 없음. 저장 구조에는 경로·전사 원문이 담기지 않는다(불투명 id + 숫자 지표만).
  - 참조 동일성의 단일 권위는 '내용 해시'다. path|size|mtime 조합은 캐시 권위로 쓰지 않는다
    (파일을 옮기면 틀리고, 이름·크기가 같은 채 내용만 바뀌어도 틀린다). reference_cache_key가 강제한다.
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
UNKNOWN_REFERENCE_ASSET = "UNKNOWN_REFERENCE_ASSET"            # manifest에 기록되지 않은 자산 조회/삭제
CROSS_DEVICE_PROMOTION = "CROSS_DEVICE_PROMOTION"              # staging↔durable 볼륨이 달라 원자적 승격 불가
CLIP_CHECKSUM_MISMATCH = "CLIP_CHECKSUM_MISMATCH"              # 저장된 클립 체크섬이 manifest와 불일치
MANIFEST_CONTAINS_PATH = "MANIFEST_CONTAINS_PATH"              # manifest에 경로 문자열이 섞임(절대 금지)
PROMOTE_ORDER_VIOLATION = "PROMOTE_ORDER_VIOLATION"            # 승격 단계 순서 위반(건너뜀/재배열)
CLIP_VERIFICATION_FAILED = "CLIP_VERIFICATION_FAILED"          # staging 클립 검증 실패(디코드/샘플/규격)

REFERENCE_GUARD_CODES = (
    NO_REFERENCE_SELECTED,
    MULTIPLE_REFERENCES_SELECTED,
    UNKNOWN_REFERENCE_SELECTED,
    OVERLAPPING_CANDIDATES,
    TOO_MANY_CANDIDATES,
    INVALID_FINGERPRINT_INPUT,
    UNKNOWN_REFERENCE_ASSET,
    CROSS_DEVICE_PROMOTION,
    CLIP_CHECKSUM_MISMATCH,
    MANIFEST_CONTAINS_PATH,
    PROMOTE_ORDER_VIOLATION,
    CLIP_VERIFICATION_FAILED,
)

# ── 승격(promote) 결과 상태 — 예외가 아니라 구조화 상태. TS와 집합이 동일해야 한다. ──
REFERENCE_PROMOTED = "REFERENCE_PROMOTED"                      # 6단계 전부 성공(manifest 교체까지)
REFERENCE_PROMOTE_FAILED = "REFERENCE_PROMOTE_FAILED"          # 중간 실패 — 기존 manifest/클립 불변

REFERENCE_PROMOTE_STATUSES = (
    REFERENCE_PROMOTED,
    REFERENCE_PROMOTE_FAILED,
)

# ── 재탐색(rescan) 결과 상태 — 예외가 아니라 구조화 상태로 돌려준다. TS와 집합이 동일해야 한다. ──
REFERENCE_CANDIDATES_FOUND = "REFERENCE_CANDIDATES_FOUND"          # 새 후보를 1개 이상 찾음
NO_MORE_REFERENCE_CANDIDATES = "NO_MORE_REFERENCE_CANDIDATES"      # 남은 유효 구간 없음(빈 배열을 조용히 주지 않는다)

REFERENCE_SCAN_STATUSES = (
    REFERENCE_CANDIDATES_FOUND,
    NO_MORE_REFERENCE_CANDIDATES,
)

# ── 정책 상수 ──
MAX_AUTO_CANDIDATES = 3        # 자동 추천 후보 최대 개수
MIN_REGION_MS = 3000           # 참조 하한(3.0초) — reference_region 정책과 동일
MAX_REGION_MS = 10000          # 참조 상한(10.0초)

# ── 영속(durable) 저장소 계약 — 실제 디렉터리 해석/파일 이동은 main(통합 담당) 소유. ──
# 레이아웃:  <app userData>/reference-library/manifest.json          ← manifest(원자적 교체 대상)
#            <app userData>/reference-library/<clipId>.wav          ← 영속 자산
#            <app userData>/reference-library/staging/run-<runId>/  ← 이 실행(run) 전용 staging
#            <app userData>/reference-library/staging/run-<runId>.journal.json ← 이 run이 만든 clipId 목록
#
# OS temp은 영속 위치가 아니다(재시작/청소로 사라진다).
# staging은 "캐시 어딘가"가 아니라 **durable 대상의 부모와 같은 볼륨/파일시스템 아래**에 만든
# run 스코프 디렉터리여야 한다. C:\ staging + E:\ durable 조합은 승격 시점에 정확히 터진다
# (교차 볼륨 os.replace는 Windows에서 예외). assert_promotion_same_volume가 사전 차단한다.
MANIFEST_VERSION = 1
REFERENCE_LIBRARY_DIR_NAME = "reference-library"   # userData 하위 영속 디렉터리명
REFERENCE_STAGING_DIR_NAME = "staging"             # 위 디렉터리 하위 staging(같은 볼륨 보장)
MANIFEST_FILE_NAME = "manifest.json"
CLIP_FILE_EXTENSION = ".wav"
# manifest 레코드에 허용되는 필드 — 이 목록이 전부다(경로 필드는 영원히 없다).
MANIFEST_RECORD_FIELDS = (
    "clip_id",
    "fingerprint",
    "source_sha256",
    "region_start_ms",
    "region_duration_ms",
    "transcript_sha256",
    "analysis_version",
    "clip_sha256",
)

# ── 승격 순서 — 이 순서가 계약이다. 건너뛰거나 재배열하면 PROMOTE_ORDER_VIOLATION. ──
#   1 staging 디렉터리 생성(durable 부모와 같은 볼륨, run 스코프)
#   2 staging에 WAV 기록
#   3 검증: 디코드 / 전 샘플 유한 / 샘플레이트 / 채널 수 / 길이 / 체크섬
#   4 클립을 durable로 원자적 승격
#   5 manifest를 임시 파일에 기록하고 플랫폼이 허용하는 만큼 flush
#   6 manifest를 마지막에 원자적으로 교체
PROMOTE_STEPS = (
    "CREATE_STAGING_DIR",
    "WRITE_STAGING_CLIP",
    "VERIFY_STAGING_CLIP",
    "PROMOTE_CLIP",
    "WRITE_MANIFEST_TEMP",
    "REPLACE_MANIFEST",
)
# 3단계에서 반드시 확인해야 하는 항목(하나라도 실패하면 승격하지 않는다).
CLIP_VERIFICATION_CHECKS = (
    "decodable",
    "all_samples_finite",
    "sample_rate",
    "channel_count",
    "duration_ms",
    "clip_sha256",
)
RUN_SCOPE_PREFIX = "run-"                       # run 스코프 이름 접두사(고아 소유 판정의 유일한 근거)
RUN_JOURNAL_SUFFIX = ".journal.json"            # run이 만든 clipId 목록 파일
MANIFEST_TEMP_SUFFIX = ".tmp"                   # manifest 임시 파일 접미사(5단계)

_RUN_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")

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
    """합성/샘플러 경로에 넘기는 payload — 정확히 하나의 클립. 경로/전사 원문 없음.

    샘플러는 여기 담긴 fingerprint/cache_key를 그대로 쓰고 자기 나름의 지문을 만들지 않는다
    (내용 기반 지문이 참조 동일성의 단일 권위 — 요구 2)."""
    c = assert_single_reference(entry, selected_ids)
    entry = entry or {}
    fp = entry.get("fingerprint", "")
    return {
        "clip_id": c["id"],
        "start_ms": c["start_ms"],
        "duration_ms": c["duration_ms"],
        "fingerprint": fp,
        "source_sha256": entry.get("source_sha256", ""),
        "cache_key": reference_cache_key(fp) if fp else "",
        "analysis_version": entry.get("analysis_version", REFERENCE_ANALYSIS_VERSION),
    }


def reference_identity(entry_or_record):
    """샘플러/캐시가 소비하는 참조 동일성 묶음. 경로·크기·mtime은 포함되지 않는다."""
    e = entry_or_record or {}
    fp = e.get("fingerprint", "")
    return {
        "fingerprint": reference_cache_key(fp),
        "cache_key": reference_cache_key(fp),
        "source_sha256": _require_sha256(e.get("source_sha256"), "source_sha256"),
        "analysis_version": e.get("analysis_version", REFERENCE_ANALYSIS_VERSION),
    }


def reference_cache_key(fingerprint):
    """재사용 캐시 키 = 내용 기반 지문 그 자체(소문자 hex 64).

    `path|size|mtimeMs` 같은 경로/스탯 조합은 캐시 권위가 아니다 — 파일을 옮기기만 해도 달라지고,
    이름·크기가 같은 채로 내용만 바뀌면 그대로여서 둘 다 틀린다. 규격 위반은 즉시 거부한다."""
    v = str(fingerprint or "").strip().lower()
    if not _SHA256_RE.match(v):
        raise ReferenceLibraryError(
            INVALID_FINGERPRINT_INPUT,
            "cache key must be a content fingerprint (64 hex), not a path/size/mtime tuple")
    return v


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


# ─────────────────────────────────────────────────────────────────────────────
# 재탐색(rescan) — 기존 후보 구간을 명시적 제외 입력으로 받는다(요구 3)
# ─────────────────────────────────────────────────────────────────────────────
def rescan_candidates(scored, existing=(), max_count=MAX_AUTO_CANDIDATES,
                      min_duration_ms=MIN_REGION_MS, max_duration_ms=MAX_REGION_MS):
    """이미 가진 후보(existing)의 반열린 구간과 겹치는 것을 전부 제외하고 새 후보를 찾는다.

    - existing은 명시적 입력이다(한 번의 스캔이 3개를 고르는 것으로 끝내지 않는다).
      끝점이 맞닿는 구간은 여전히 허용한다(반열린 [start, start+duration) 규칙 유지).
    - 기존 후보를 교체·재정렬·삭제하지 않는다. 결과 candidates는 existing을 원래 순서 그대로
      앞에 두고 새로 찾은 것만 뒤에 붙인다.
    - 남은 유효 구간이 없으면 빈 배열을 조용히 주지 않고 NO_MORE_REFERENCE_CANDIDATES 상태를 준다.
      겹치는 구간을 억지로 만들어내지도 않는다.
    - 같은 입력 + 같은 제외 집합이면 항상 같은 결과(pick_auto_candidates가 결정적).

    반환: {"status", "added", "candidates", "excluded_count", "room"}
    """
    existing = list(existing or [])
    room = max(0, int(max_count) - len(existing))
    added = []
    if room > 0:
        added = pick_auto_candidates(scored, room, existing, min_duration_ms, max_duration_ms)
    status = REFERENCE_CANDIDATES_FOUND if added else NO_MORE_REFERENCE_CANDIDATES
    return {
        "status": status,
        "added": added,
        "candidates": existing + added,   # 기존은 순서 그대로 보존
        "excluded_count": len(existing),
        "room": room,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 영속 저장소(durable library) — manifest는 순수 데이터, 파일 이동은 main 소유
# ─────────────────────────────────────────────────────────────────────────────
# Windows 볼륨 토큰(드라이브 문자 또는 UNC \\server\share). 파일시스템을 건드리지 않는 문자열 판정.
_VOLUME_RE = re.compile(r"^(?:([A-Za-z]:)|(\\\\[^\\]+\\[^\\]+))")


def path_volume(path):
    """경로의 볼륨 토큰(소문자). 판정 불가면 빈 문자열. fs 접근 없음 — 문자열만 본다."""
    s = str(path or "").replace("/", "\\")
    m = _VOLUME_RE.match(s)
    if not m:
        return ""
    return (m.group(1) or m.group(2)).lower()


def assert_promotion_same_volume(staging_path, durable_path):
    """원자적 승격 전제: staging과 durable이 같은 볼륨이어야 한다.

    교차 볼륨 os.replace는 Windows에서 실패한다(그리고 복사+삭제는 원자적이지 않다).
    staging을 cache/temp에 두더라도 durable과 같은 드라이브여야 하며, 아니면 승격을 시도조차 하지 않는다."""
    a, b = path_volume(staging_path), path_volume(durable_path)
    if a != b:
        raise ReferenceLibraryError(CROSS_DEVICE_PROMOTION, "staging and durable volumes differ")
    return True


def clip_file_name(clip_id):
    """영속 자산 파일명 — clipId + 확장자. 디렉터리는 붙이지 않는다(경로 해석은 main 소유)."""
    cid = str(clip_id or "").strip().lower()
    if not re.match(r"^[0-9a-f]{%d}$" % CLIP_ID_LENGTH, cid):
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "clip_id must be %d hex chars" % CLIP_ID_LENGTH)
    return cid + CLIP_FILE_EXTENSION


def empty_manifest():
    """빈 manifest(신규 설치/최초 실행)."""
    return {"manifest_version": MANIFEST_VERSION, "records": []}


def build_manifest_record(entry, clip_sha256, clip_id=None):
    """영속 항목 1건. MANIFEST_RECORD_FIELDS 외의 필드는 만들지 않는다(경로 필드는 영원히 없다).

    clip_sha256은 '실제로 durable에 저장된 클립 파일'의 sha256이다 — 재시작 후 무결성 검증에 쓴다.
    clip_id 미지정이면 entry의 기본 후보를 쓴다."""
    e = entry or {}
    cid = clip_id or e.get("default_candidate_id")
    record = {
        "clip_id": str(cid or "").strip().lower(),
        "fingerprint": reference_cache_key(e.get("fingerprint")),
        "source_sha256": _require_sha256(e.get("source_sha256"), "source_sha256"),
        "region_start_ms": int(e.get("region_start_ms", 0)),
        "region_duration_ms": int(e.get("region_duration_ms", 0)),
        "transcript_sha256": _require_sha256(e.get("transcript_sha256"), "transcript_sha256"),
        "analysis_version": int(e.get("analysis_version", REFERENCE_ANALYSIS_VERSION)),
        "clip_sha256": _require_sha256(clip_sha256, "clip_sha256"),
    }
    return assert_manifest_record_valid(record)


def assert_manifest_record_valid(record):
    """레코드 불변식: 허용 필드만, 해시 형식 정상, 경로 문자열 0."""
    r = dict(record or {})
    extra = sorted(set(r.keys()) - set(MANIFEST_RECORD_FIELDS))
    if extra:
        raise ReferenceLibraryError(MANIFEST_CONTAINS_PATH, "unexpected fields: %s" % ",".join(extra))
    missing = [f for f in MANIFEST_RECORD_FIELDS if f not in r]
    if missing:
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "missing fields: %s" % ",".join(missing))
    clip_file_name(r["clip_id"])                       # clip_id 형식 검증(부수효과 없음)
    reference_cache_key(r["fingerprint"])
    _require_sha256(r["source_sha256"], "source_sha256")
    _require_sha256(r["transcript_sha256"], "transcript_sha256")
    _require_sha256(r["clip_sha256"], "clip_sha256")
    hits = find_sensitive_strings(r)
    if hits:
        raise ReferenceLibraryError(MANIFEST_CONTAINS_PATH, "at %s" % hits[0]["at"])
    return r


def assert_manifest_valid(manifest):
    """manifest 전체 불변식. 경로가 한 글자라도 섞이면 즉시 거부한다."""
    m = manifest or {}
    if int(m.get("manifest_version", 0)) != MANIFEST_VERSION:
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "unsupported manifest_version")
    records = list(m.get("records") or [])
    for r in records:
        assert_manifest_record_valid(r)
    ids = [r["clip_id"] for r in records]
    if len(ids) != len(set(ids)):
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "duplicate clip_id in manifest")
    return {"manifest_version": MANIFEST_VERSION, "records": records}


def upsert_manifest_record(manifest, record):
    """레코드 추가/갱신(clip_id 기준). 원본 manifest를 변형하지 않고 새 dict를 돌려준다."""
    m = assert_manifest_valid(manifest or empty_manifest())
    rec = assert_manifest_record_valid(record)
    records = [r for r in m["records"] if r["clip_id"] != rec["clip_id"]]
    records.append(rec)
    return {"manifest_version": MANIFEST_VERSION, "records": records}


def find_manifest_record(manifest, fingerprint):
    """지문으로 영속 레코드를 찾는다. 없으면 None. (재시작 후 재사용 조회 경로)"""
    fp = reference_cache_key(fingerprint)
    for r in (manifest or {}).get("records") or []:
        if r.get("fingerprint") == fp:
            return r
    return None


def find_manifest_record_by_clip_id(manifest, clip_id):
    cid = str(clip_id or "").strip().lower()
    for r in (manifest or {}).get("records") or []:
        if r.get("clip_id") == cid:
            return r
    return None


def plan_asset_deletion(manifest, clip_id):
    """삭제 계획 — 그 manifest 레코드가 소유한 자산만. prefix 청소를 하지 않는다.

    반환: {"clip_id", "file_names": [...]}. 기록에 없는 id는 UNKNOWN_REFERENCE_ASSET로 거부한다
    (기록하지 않은 것은 절대 지우지 않는다)."""
    rec = find_manifest_record_by_clip_id(manifest, clip_id)
    if rec is None:
        raise ReferenceLibraryError(UNKNOWN_REFERENCE_ASSET, "clip_id not in manifest")
    return {"clip_id": rec["clip_id"], "file_names": [clip_file_name(rec["clip_id"])]}


def remove_manifest_record(manifest, clip_id):
    """사용자가 그 참조를 제거할 때만 호출. (새 manifest, 삭제 계획) 반환."""
    plan = plan_asset_deletion(manifest, clip_id)
    m = assert_manifest_valid(manifest)
    records = [r for r in m["records"] if r["clip_id"] != plan["clip_id"]]
    return {"manifest_version": MANIFEST_VERSION, "records": records}, plan


def verify_stored_clip(record, actual_clip_sha256):
    """재시작 후 무결성 검증 — 저장된 클립의 실제 sha256이 레코드와 같아야 한다."""
    rec = assert_manifest_record_valid(record)
    if rec["clip_sha256"] != _require_sha256(actual_clip_sha256, "clip_sha256"):
        raise ReferenceLibraryError(CLIP_CHECKSUM_MISMATCH, "stored clip checksum differs")
    return rec


def evaluate_reuse_against_record(record, requested):
    """영속 레코드(전사 원문 없음, 해시만)와 요청을 비교한다 — 재시작 직후 경로.

    evaluate_reuse와 같은 반환 모양/같은 사유 코드를 쓴다. 레코드에는 전사 원문이 없으므로
    전사는 해시로만 비교한다(그래서 manifest에 원문을 담을 필요가 없다)."""
    rec = assert_manifest_record_valid(record)
    requested = requested or {}
    r_region = requested.get("region") or {}
    r_version = requested.get("analysis_version", REFERENCE_ANALYSIS_VERSION)
    requested_fp = compute_fingerprint_from_request(requested)

    reasons = []
    if rec["source_sha256"] != _require_sha256(requested.get("source_sha256"), "source_sha256"):
        reasons.append(REF_SOURCE_CHANGED)
    if (rec["region_start_ms"] != seconds_to_ms(r_region.get("start", 0.0))
            or rec["region_duration_ms"] != seconds_to_ms(r_region.get("duration", 0.0))):
        reasons.append(REF_REGION_CHANGED)
    if rec["transcript_sha256"] != sha256_hex_of_string(normalize_transcript(requested.get("transcript", ""))):
        reasons.append(REF_TRANSCRIPT_CHANGED)
    if rec["analysis_version"] != r_version:
        reasons.append(REF_ANALYSIS_VERSION_CHANGED)

    order = {code: i for i, code in enumerate(REFERENCE_INVALIDATION_REASONS)}
    reasons.sort(key=lambda c: order[c])
    return {
        "reusable": (not reasons) and rec["fingerprint"] == requested_fp,
        "reasons": reasons,
        "fingerprint": requested_fp,
        "stored_fingerprint": rec["fingerprint"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 승격(promote) — 순서·검증·실패 불변식. 실제 fs 호출은 effects로 주입받는다(여긴 순수).
# ─────────────────────────────────────────────────────────────────────────────
def _require_run_id(run_id):
    v = str(run_id or "").strip().lower()
    if not _RUN_ID_RE.match(v):
        raise ReferenceLibraryError(INVALID_FINGERPRINT_INPUT, "run_id must be 8~32 hex chars")
    return v


def run_scoped_staging_dir_name(run_id):
    """이 실행 전용 staging 디렉터리명. durable 부모와 같은 볼륨 아래에 만들어야 한다."""
    return RUN_SCOPE_PREFIX + _require_run_id(run_id)


def run_journal_file_name(run_id):
    """이 run이 만든 clipId 목록 파일명. 고아 정리의 유일한 근거."""
    return RUN_SCOPE_PREFIX + _require_run_id(run_id) + RUN_JOURNAL_SUFFIX


def manifest_temp_file_name(run_id):
    """5단계 manifest 임시 파일명(같은 디렉터리에서 원자적 교체 가능해야 한다)."""
    return MANIFEST_FILE_NAME + "." + _require_run_id(run_id) + MANIFEST_TEMP_SUFFIX


def is_run_scoped_name(name, run_id):
    """이름이 그 run 소유의 staging 산출물인가(디렉터리/저널/manifest 임시본). 접두사 일치만으로는 안 된다."""
    n = str(name or "").strip().lower()
    return n in (run_scoped_staging_dir_name(run_id),
                 run_journal_file_name(run_id),
                 manifest_temp_file_name(run_id))


def build_run_journal(run_id, clip_ids):
    """run 저널 — 이 실행이 durable에 새로 넣으려 한 clipId 목록. 경로는 담지 않는다."""
    ids = []
    for cid in (clip_ids or []):
        c = str(cid or "").strip().lower()
        clip_file_name(c)                 # 형식 검증
        if c not in ids:
            ids.append(c)
    return {"run_id": _require_run_id(run_id), "clip_ids": ids}


def is_orphan_owned_by_run(file_name, journal, manifest):
    """durable 디렉터리의 파일 하나가 '이 run이 남긴 고아'인가.

    True 조건(전부 만족해야 한다):
      - 파일명이 저널에 적힌 clipId의 정식 파일명과 '완전히' 같다(접두사 일치는 인정하지 않는다).
      - 그 clipId가 현재 manifest에 없다(등재된 것은 고아가 아니며 절대 지우지 않는다).
    저널에 없는 파일, 남의 파일, prefix만 같은 파일은 전부 False — 광역 스캔 삭제를 막는다."""
    ids = list((journal or {}).get("clip_ids") or [])
    if not ids:
        return False
    name = str(file_name or "").strip().lower()
    for cid in ids:
        c = str(cid or "").strip().lower()
        try:
            owned = clip_file_name(c)
        except ReferenceLibraryError:
            continue
        if name == owned:
            return find_manifest_record_by_clip_id(manifest, c) is None
    return False


def evaluate_clip_verification(measured, expected):
    """3단계 검증 — 실패한 항목 이름 목록을 돌려준다(빈 목록이면 통과)."""
    m = measured or {}
    e = expected or {}
    failed = []
    if not m.get("decodable"):
        failed.append("decodable")
    if not m.get("all_samples_finite"):
        failed.append("all_samples_finite")
    for key in ("sample_rate", "channel_count", "duration_ms"):
        if key in e and int(m.get(key, -1)) != int(e[key]):
            failed.append(key)
    try:
        _require_sha256(m.get("clip_sha256"), "clip_sha256")
    except ReferenceLibraryError:
        failed.append("clip_sha256")
    return failed


def assert_clip_verified(measured, expected):
    """검증 실패면 승격하지 않는다(4단계로 넘어가지 않음)."""
    failed = evaluate_clip_verification(measured, expected)
    if failed:
        raise ReferenceLibraryError(CLIP_VERIFICATION_FAILED, ",".join(failed))
    return measured


def assert_promote_order(observed):
    """관찰된 단계 열이 PROMOTE_STEPS의 접두사인지(건너뜀/재배열 없음) 확인한다."""
    obs = list(observed or [])
    if len(obs) > len(PROMOTE_STEPS) or obs != list(PROMOTE_STEPS[:len(obs)]):
        raise ReferenceLibraryError(PROMOTE_ORDER_VIOLATION, "->".join(obs))
    return obs


def promote_reference_clip(effects, request):
    """확정 클립을 영속 저장소로 승격한다 — 순서를 호출부가 틀릴 수 없게 여기서 고정한다.

    effects: PROMOTE_STEPS와 1:1인 콜러블 6개(실제 fs 작업은 main 소유).
      create_staging_dir(run_id)                     -> staging_dir 경로
      write_staging_clip(staging_dir, file_name)     -> staged 경로
      verify_staging_clip(staged_path)               -> {decodable, all_samples_finite,
                                                          sample_rate, channel_count, duration_ms, clip_sha256}
      promote_clip(staged_path, durable_file_name)   -> durable 경로 (원자적 rename/replace)
      write_manifest_temp(manifest_dict, temp_name)  -> temp 경로 (기록 + flush)
      replace_manifest(temp_path)                    -> None      (원자적 교체, 마지막)

    request: {run_id, entry, durable_dir, manifest, expected{sample_rate,channel_count,duration_ms}, clip_id?}

    반환(성공): {"status": REFERENCE_PROMOTED, "manifest", "record", "steps", "orphan_clip_ids": []}
    반환(실패): {"status": REFERENCE_PROMOTE_FAILED, "failed_step", "error_code", "steps",
                "orphan_clip_ids", "manifest"(원본 그대로), "journal"}
    실패 시 이 함수는 manifest를 변형하지 않는다 — 원본 객체를 그대로 돌려준다.
    5·6단계 전에 실패하면 replace_manifest는 호출조차 되지 않으므로 기존 manifest는 불변이다."""
    req = request or {}
    run_id = _require_run_id(req.get("run_id"))
    entry = req.get("entry") or {}
    manifest = req.get("manifest") or empty_manifest()
    durable_dir = req.get("durable_dir") or ""
    clip_id = str(req.get("clip_id") or entry.get("default_candidate_id") or "").strip().lower()
    file_name = clip_file_name(clip_id)
    journal = build_run_journal(run_id, [clip_id])

    steps = []
    failed_step = None
    error_code = None
    new_manifest = None
    record = None
    try:
        staging_dir = effects["create_staging_dir"](run_id)
        # staging은 durable 부모와 같은 볼륨이어야 한다 — 아니면 4단계에서 터진다. 여기서 미리 막는다.
        assert_promotion_same_volume(staging_dir, durable_dir)
        steps.append("CREATE_STAGING_DIR")

        failed_step = "WRITE_STAGING_CLIP"
        staged = effects["write_staging_clip"](staging_dir, file_name)
        steps.append("WRITE_STAGING_CLIP")

        failed_step = "VERIFY_STAGING_CLIP"
        measured = effects["verify_staging_clip"](staged)
        assert_clip_verified(measured, req.get("expected"))
        steps.append("VERIFY_STAGING_CLIP")

        failed_step = "PROMOTE_CLIP"
        effects["promote_clip"](staged, file_name)
        steps.append("PROMOTE_CLIP")

        failed_step = "WRITE_MANIFEST_TEMP"
        record = build_manifest_record(entry, measured["clip_sha256"], clip_id)
        new_manifest = upsert_manifest_record(manifest, record)
        temp_path = effects["write_manifest_temp"](new_manifest, manifest_temp_file_name(run_id))
        steps.append("WRITE_MANIFEST_TEMP")

        failed_step = "REPLACE_MANIFEST"
        effects["replace_manifest"](temp_path)
        steps.append("REPLACE_MANIFEST")
    except ReferenceLibraryError as e:
        if failed_step is None:
            failed_step = "CREATE_STAGING_DIR"
        error_code = e.code
    except Exception:
        if failed_step is None:
            failed_step = "CREATE_STAGING_DIR"
        error_code = None

    assert_promote_order(steps)
    if len(steps) == len(PROMOTE_STEPS):
        return {"status": REFERENCE_PROMOTED, "manifest": new_manifest, "record": record,
                "steps": steps, "orphan_clip_ids": [], "journal": journal}
    # 4단계를 넘겼다면 클립은 durable에 있는데 manifest에는 없다 → 이 run 소유의 고아.
    orphans = [clip_id] if "PROMOTE_CLIP" in steps else []
    return {"status": REFERENCE_PROMOTE_FAILED, "failed_step": failed_step, "error_code": error_code,
            "steps": steps, "orphan_clip_ids": orphans,
            "manifest": manifest, "journal": journal}


def resolve_reusable_clip(manifest, requested):
    """재시작 후 재사용 조회: 요청 → 지문 → 영속 레코드 → clip_id.

    반환: {"reusable", "clip_id", "file_name", "record", "fingerprint", "reasons"}
    라이브러리에 없으면 reusable False + clip_id None(사유 없음 — 무효화가 아니라 부재).
    clip_id를 실제 파일 경로로 바꾸는 일은 main 소유다(여기서는 파일명까지만)."""
    fp = compute_fingerprint_from_request(requested)
    rec = find_manifest_record(manifest, fp)
    if rec is None:
        return {"reusable": False, "clip_id": None, "file_name": None, "record": None,
                "fingerprint": fp, "reasons": []}
    verdict = evaluate_reuse_against_record(rec, requested)
    return {
        "reusable": verdict["reusable"],
        "clip_id": rec["clip_id"] if verdict["reusable"] else None,
        "file_name": clip_file_name(rec["clip_id"]) if verdict["reusable"] else None,
        "record": rec,
        "fingerprint": fp,
        "reasons": verdict["reasons"],
    }
