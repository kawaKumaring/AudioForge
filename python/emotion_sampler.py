# -*- coding: utf-8 -*-
"""감정 샘플러(Emotion Sampler) 순수 모듈 — 캐시 키 · 상태 기계 · 표준 문구 세트. stdlib only.

⚠️ '감정 샘플러'는 '감정 참조 등록'과 다른 기능이다. 혼동 금지:
  · 감정 참조 등록: 감정마다 **별도 참조 클립을 등록**한다(전용 목소리 등록됨 / 등록 필요 / 기본 목소리 사용).
    등록물은 합성 입력으로 영속 사용된다.
  · 감정 샘플러(이 모듈): **기본(default) 참조 목소리 하나**로 감정별 표준 문구를 미리 합성해
    "내 목소리로 [기쁨]은 어떻게 들리나?"를 대사 작성 전에 들어보게 한다.
    결과물은 **일회성 미리듣기 샘플**이며 절대 감정 참조로 등록되지 않는다(등록 경로 없음).

TS 거울: src/shared/emotionSampler.ts. 같은 상수 · **바이트 동일한** canonical 직렬화 · 같은 상태/사유 코드.
양쪽 테스트가 서로의 소스를 파싱해 parity 를 강제한다(레포의 parity-by-parsing 선례를 따름).

비민감 계약: 절대경로 · 참조 전사문 · 합성 프롬프트 문자열을 상태 dict / 캐시 키 입력 / 표시 문자열에
넣지 않는다. 표준 문구 자체도 키 입력·표시에서 제외하고 '버전 번호'만 흐른다.

순수성: 무거운 import 없음(hashlib/math/re 만). GPU·모델·파일 I/O 없음.
"""
import hashlib
import math
import re

# ── 1) 버전 상수 ────────────────────────────────────────────────────────────
# 캐시 키 '형식' 버전. 직렬화 구조를 바꾸면 올린다(기존 키 전부 무효화).
# v2: 목소리 입력을 경로 기반 지문(path|size|mtimeMs)에서 참조 라이브러리의 콘텐츠 SHA-256 으로 교체.
# v3: 표현 이벤트(expression.kind)와 세기(expression.strength)를 키에 추가.
EMOTION_SAMPLER_KEY_VERSION = 3
# 표준 문구/이벤트 세트 버전. 문구나 행 카탈로그가 바뀌면 반드시 올린다 → 캐시 샘플 전부 무효화.
# v2: 표현 프로소디 언어 계약 소비로 전환 + 구두점/웃음 행 추가.
EMOTION_SAMPLER_PHRASE_VERSION = 2

# ── 2) 표준 문구 세트(버전 있는 상수) ───────────────────────────────────────
# 짧고 중립적이며 감정색이 없는 문장만. 모든 감정이 같은 문구를 쓴다 → 감정 차이만 귀에 남는다.
# ⚠️ 이 문자열들은 화면에 렌더하지 않는다(계약 6). 버전만 표시한다.
EMOTION_SAMPLER_PHRASES = (
    "안녕하세요.",
    "잠시 후에 다시 말씀드리겠습니다.",
)

# 현재 문구 세트(버전 포함)의 고정 지문. 문구 변경 시 PHRASE_VERSION 을 올리고 함께 갱신할 것.
# 구두점·웃음 행이 얹히는 호스트 문구(v2 추가). 최종 음절 '요'는 종성이 없어
# '~'(vowel_extend)가 계약상 open_vowel 로 분류된다 — 분류 판정은 계약 파서가 한다.
EMOTION_SAMPLER_EXPRESSION_HOST = "그럼 이제 시작할게요"

EMOTION_SAMPLER_PHRASE_SET_SHA256 = "54b752e341268b6d5446378197ad127f9655ddf8a203dab9ee4eb0d2557c468a"


def phrase_script():
    """표준 문구 세트를 합성 대본 한 줄로 결합(공백 하나). TS emotionSamplerPhraseScript() 와 동일."""
    return " ".join(EMOTION_SAMPLER_PHRASES)


def phrase_set_digest():
    """sha256(canonical({phrase_version, phrases})). 문구를 바꾸면 테스트가 먼저 깨진다."""
    return sampler_sha256_hex(_canonicalize({
        "host": EMOTION_SAMPLER_EXPRESSION_HOST,
        "phrase_version": EMOTION_SAMPLER_PHRASE_VERSION,
        "phrases": list(EMOTION_SAMPLER_PHRASES),
        "rows": ["%s:%s:%s" % (r["row_id"], r["family"], r["expect_kind"])
                 for r in EMOTION_SAMPLE_ROWS],
    }))


# ── 3) 상태 / 사유 코드 — 조용한 무표시 금지. 실패·강등은 각각 '이름 있는' 상태다. ─────
EMOTION_SAMPLE_STATES = (
    "idle",           # 미생성
    "generating",     # 생성 중
    "ready",          # 재생 가능(정상)
    "degraded",       # 재생 가능하지만 x-vector-only 로 강등되어 만들어짐
    "limitExceeded",  # 생성 한도 초과 → 결과 폐기(재생 불가)
    "failed",         # 생성 실패 + 사유
    "unsupported",    # 엔진 capability 가 '못 한다'고 판정 — 생성 시도 자체를 막는다
    "unverified",     # capability 가 프로브로 확인되지 않음(unknown) — '됨'으로 표시하지 않는다
)

EMOTION_SAMPLE_STATE_LABEL = {
    "idle": "미생성",
    "generating": "생성 중",
    "ready": "재생 가능",
    "degraded": "재생 가능(음색만 반영)",
    "limitExceeded": "생성 한도 초과",
    "failed": "실패",
    "unsupported": "지원 안 됨",
    "unverified": "미검증",
}

EMOTION_SAMPLE_REASON_CODES = (
    "SAMPLER_XVECTOR_ONLY",      # degraded 전용 — 참조 전사 없이(x-vector-only) 생성됨
    "SAMPLER_GENERATION_LIMIT",  # limitExceeded 전용 — 생성 반복 상한 도달, 결과 폐기
    "SAMPLER_ENGINE_ERROR",      # failed — 합성 엔진/브리지 오류
    "SAMPLER_REFERENCE_MISSING",  # failed — 기본 참조 목소리 없음/사라짐
    "SAMPLER_CANCELLED",         # failed — 사용자가 중단
    "SAMPLER_UNKNOWN",           # failed — 분류되지 않은 오류(조용한 무표시 대신 이 코드를 쓴다)
    # ↓ 엔진 capability 계약(expressive_capability.py · expressive_planner.py)의 코드를 그대로 쓴다.
    #   그 모듈은 아직 이 브랜치에 병합되지 않아 parity 대조가 불가능하다 — 병합되면 드리프트 가드 추가.
    "LAUGH_NO_STRATEGY",           # unsupported — 웃음 전략 A~D 전부 불가
    "VOWEL_EXTEND_NOT_REALIZABLE",  # unsupported — 받침 계열: 자음 늘이기/반복 금지라 실현 경로 없음
    "CAPABILITY_UNVERIFIED",       # unverified — 실제 엔진 프로브 없이는 판정 불가(성공 아님)
)

EMOTION_SAMPLE_REASON_LABEL = {
    "SAMPLER_XVECTOR_ONLY": "참조 전사 없이 생성되어 음색만 반영되었습니다",
    "SAMPLER_GENERATION_LIMIT": "생성 한도에 도달해 결과를 버렸습니다",
    "SAMPLER_ENGINE_ERROR": "합성 엔진 오류",
    "SAMPLER_REFERENCE_MISSING": "기본 목소리를 찾을 수 없습니다",
    "SAMPLER_CANCELLED": "사용자가 중단했습니다",
    "SAMPLER_UNKNOWN": "알 수 없는 오류",
    "LAUGH_NO_STRATEGY": "이 엔진에는 웃음을 만드는 방법이 아직 없습니다",
    "VOWEL_EXTEND_NOT_REALIZABLE": "받침이 있어 늘일 수 없습니다(자음을 반복하는 방식은 금지)",
    "CAPABILITY_UNVERIFIED": "엔진이 실제로 해낼 수 있는지 아직 확인되지 않았습니다",
}

# 상태별로 허용되는 사유 코드(교차 오염 방지 — 상태와 사유는 1:N 고정).
EMOTION_SAMPLE_STATE_REASONS = {
    "idle": (),
    "generating": (),
    "ready": (),
    "degraded": ("SAMPLER_XVECTOR_ONLY",),
    "limitExceeded": ("SAMPLER_GENERATION_LIMIT",),
    "failed": ("SAMPLER_ENGINE_ERROR", "SAMPLER_REFERENCE_MISSING", "SAMPLER_CANCELLED", "SAMPLER_UNKNOWN"),
    "unsupported": ("LAUGH_NO_STRATEGY", "VOWEL_EXTEND_NOT_REALIZABLE"),
    "unverified": ("CAPABILITY_UNVERIFIED",),
}

# 입력 검증 실패 코드(문자열 prefix 추론 금지 — TS 와 공유).
EMOTION_SAMPLER_INPUT_ERROR_CODES = (
    "SAMPLER_PATH_LIKE_VALUE",
    "SAMPLER_TEXT_LIKE_VALUE",
    "SAMPLER_INVALID_VOICE_CONTENT_SHA256",
    "SAMPLER_INVALID_ENGINE_ID",
    "SAMPLER_INVALID_MODEL_ID",
    "SAMPLER_INVALID_EMOTION_ID",
    "SAMPLER_INVALID_CONFIG",
    "SAMPLER_INVALID_CACHE_KEY",
    "SAMPLER_INVALID_ROW_ID",
    "SAMPLER_INVALID_EXPRESSION",
    "SAMPLER_EXPRESSION_MISSING",
)


class EmotionSamplerInputError(ValueError):
    """캐시 키/상태 입력 검증 실패. ⚠️ 위반한 '값'은 메시지에 넣지 않는다(코드 + 필드명만)."""

    def __init__(self, code, field):
        super().__init__("%s (field=%s)" % (code, field))
        self.code = code
        self.field = field


# ── 4) 합성 설정(키에 들어가는 부분만) ──────────────────────────────────────
# 샘플은 '감정 하나 · 표준 문구 한 줄'이므로 줄 경계/감정 전환 경계 설정은 결과에 영향이 없다 →
# tts_silence_gap / tts_emotion_boundary_* 는 의도적으로 키에서 제외한다(과도한 캐시 무효화 방지).
EMOTION_SAMPLER_TAIL_MODES = ("off", "auto")

EMOTION_SAMPLER_DEFAULT_CONFIG = {
    "speed": 1.0,
    "pitch": 0.0,
    "tail_mode": "auto",
    "tail_padding_ms": 120,
    "tail_fade_ms": 8,
}

SPEED_MIN, SPEED_MAX = 0.5, 2.0
PITCH_MIN, PITCH_MAX = -2.0, 2.0
TAIL_PADDING_MIN, TAIL_PADDING_MAX = 0, 300
TAIL_FADE_MIN, TAIL_FADE_MAX = 0, 20

# ── 5) 비민감 값 가드 ───────────────────────────────────────────────────────
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_ID_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_EMOTION_ID_RE = re.compile(r"^[a-z]{2,32}$")
_ROW_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
_EXPR_KIND_RE = re.compile(r"^[a-zA-Z][a-zA-Z_]{1,31}$")
_FILE_EXT_RE = re.compile(r"\.(wav|mp3|flac|ogg|m4a|json|txt|srt|py|ts|tsx)$", re.IGNORECASE)
_WHITESPACE_RE = re.compile(r"\s")


def looks_path_like(v):
    """경로처럼 보이는가: 구분자 / 드라이브 문자 / 상위참조 / 홈 단축 / URL 스킴 / 파일 확장자."""
    if "/" in v or "\\" in v:
        return True
    if ":" in v:            # C: · file: · http:
        return True
    if v.startswith("~"):
        return True
    if ".." in v:
        return True
    return bool(_FILE_EXT_RE.search(v))


def looks_text_like(v):
    """문장/전사문처럼 보이는가: 공백을 포함하거나 비 ASCII(한글·CJK 등)를 포함."""
    if _WHITESPACE_RE.search(v):
        return True
    for ch in v:
        if ord(ch) > 0x7F:
            return True
    return False


def assert_sampler_safe_value(field, v):
    """캐시 키 입력 · 상태 dict 에 들어갈 수 있는 값인지 검사(위반 시 예외 — 조용한 통과 없음)."""
    if looks_path_like(v):
        raise EmotionSamplerInputError("SAMPLER_PATH_LIKE_VALUE", field)
    if looks_text_like(v):
        raise EmotionSamplerInputError("SAMPLER_TEXT_LIKE_VALUE", field)


# ⚠️ 목소리 입력의 권위는 참조 라이브러리가 만든 콘텐츠 SHA-256 하나뿐이다.
#    이 모듈은 그 값을 '주입받은 불투명 문자열'로만 소비한다 — 직접 해싱하지 않고, 대체 지문을 만들지 않는다.
#    main 의 audio:fingerprint-reference(`path|size|mtimeMs`)는 경로 기반이라 캐시 권위가 될 수 없다.
#    결과: 같은 내용의 파일은 경로가 달라져도 같은 키(캐시 재사용), 내용이 바뀌면 이름·크기가 같아도 다른 키.


# ── 6) 캐시 키 ──────────────────────────────────────────────────────────────
# canonical 규칙(ttsGrammar D-7 과 동일): object key 알파벳 정렬 · 배열 순서 유지 · 공백 없음 ·
# 문자열 JSON escape · **정수만**(float 금지) · null 은 null.
#
# 직렬화 형태(실제로는 공백 없음):
#   {"config":{"pitch_centi":<int>,"speed_milli":<int>,"tail_fade_ms":<int>,
#              "tail_mode":"<off|auto>","tail_padding_ms":<int>},
#    "engine_id":"<token>",
#    "expression":{"family":"<family>","kind":"<contract kind>","row_id":"<row>","strength":<0..100>},
#    "key_version":<int>,"model_id":"<token>","phrase_version":<int>,
#    "voice_content_sha256":"<64hex>"}
# cache_key = sha256_hex(utf8(위 문자열))


def _quantize(value, scale, field, vmin, vmax):
    """음수 대칭 반올림(half away from zero). Python round() 의 banker's rounding 과 갈리지 않게 직접 구현."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", field)
    if not math.isfinite(value):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", field)
    if value < vmin or value > vmax:
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", field)
    scaled = value * scale
    sign = -1 if scaled < 0 else 1
    return int(sign * math.floor(abs(scaled) + 0.5))


def _require_int(value, field, vmin, vmax):
    if isinstance(value, bool) or not isinstance(value, int):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", field)
    if value < vmin or value > vmax:
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", field)
    return value


def _validated_string(v, field, code):
    if not isinstance(v, str) or not v:
        raise EmotionSamplerInputError(code, field)
    assert_sampler_safe_value(field, v)
    return v


def assert_emotion_sample_tag(emotion_id):
    """감정 태그 id 검증. list/tuple/dict 를 넘기면 여기서 즉시 실패 → 대량 생성 진입점이 생길 수 없다."""
    s = _validated_string(emotion_id, "emotion_id", "SAMPLER_INVALID_EMOTION_ID")
    if not _EMOTION_ID_RE.match(s):
        raise EmotionSamplerInputError("SAMPLER_INVALID_EMOTION_ID", "emotion_id")
    return s


def assert_cache_key(cache_key):
    """캐시 키 형식 검증(상태 dict 에 들어가는 키)."""
    if not isinstance(cache_key, str) or not _HEX64_RE.match(cache_key):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CACHE_KEY", "cache_key")
    return cache_key


def canonical_cache_key_payload_at(inp, phrase_version, key_version):
    """canonical 직렬화 문자열(버전 명시 — 마이그레이션/테스트가 옛 버전 키를 재현할 수 있게)."""
    if not isinstance(inp, dict):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", "input")

    voice_content_sha256 = _validated_string(
        inp.get("voice_content_sha256"), "voice_content_sha256", "SAMPLER_INVALID_VOICE_CONTENT_SHA256")
    if not _HEX64_RE.match(voice_content_sha256):
        raise EmotionSamplerInputError("SAMPLER_INVALID_VOICE_CONTENT_SHA256", "voice_content_sha256")

    engine_id = _validated_string(inp.get("engine_id"), "engine_id", "SAMPLER_INVALID_ENGINE_ID")
    if not _ID_TOKEN_RE.match(engine_id) or len(engine_id) > 64:
        raise EmotionSamplerInputError("SAMPLER_INVALID_ENGINE_ID", "engine_id")

    model_id = _validated_string(inp.get("model_id"), "model_id", "SAMPLER_INVALID_MODEL_ID")
    if not _ID_TOKEN_RE.match(model_id) or len(model_id) > 128:
        raise EmotionSamplerInputError("SAMPLER_INVALID_MODEL_ID", "model_id")

    expr = inp.get("expression")
    if not isinstance(expr, dict):
        raise EmotionSamplerInputError("SAMPLER_INVALID_EXPRESSION", "expression")
    expr_row_id = assert_row_id(expr.get("row_id"))
    expr_family = _validated_string(expr.get("family"), "expression.family", "SAMPLER_INVALID_EXPRESSION")
    if expr_family not in EMOTION_SAMPLE_FAMILIES:
        raise EmotionSamplerInputError("SAMPLER_INVALID_EXPRESSION", "expression.family")
    expr_kind = _validated_string(expr.get("kind"), "expression.kind", "SAMPLER_INVALID_EXPRESSION")
    if not _EXPR_KIND_RE.match(expr_kind):
        raise EmotionSamplerInputError("SAMPLER_INVALID_EXPRESSION", "expression.kind")
    expr_strength = expr.get("strength")
    if (isinstance(expr_strength, bool) or not isinstance(expr_strength, int)
            or expr_strength < 0 or expr_strength > 100):
        raise EmotionSamplerInputError("SAMPLER_INVALID_EXPRESSION", "expression.strength")

    cfg = inp.get("config")
    if not isinstance(cfg, dict):
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", "config")
    tail_mode = cfg.get("tail_mode")
    if tail_mode not in EMOTION_SAMPLER_TAIL_MODES:
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", "config.tail_mode")

    if isinstance(phrase_version, bool) or not isinstance(phrase_version, int) or phrase_version < 0:
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", "phrase_version")
    if isinstance(key_version, bool) or not isinstance(key_version, int) or key_version < 0:
        raise EmotionSamplerInputError("SAMPLER_INVALID_CONFIG", "key_version")

    return _canonicalize({
        "config": {
            "pitch_centi": _quantize(cfg.get("pitch"), 100, "config.pitch", PITCH_MIN, PITCH_MAX),
            "speed_milli": _quantize(cfg.get("speed"), 1000, "config.speed", SPEED_MIN, SPEED_MAX),
            "tail_fade_ms": _require_int(cfg.get("tail_fade_ms"), "config.tail_fade_ms",
                                         TAIL_FADE_MIN, TAIL_FADE_MAX),
            "tail_mode": tail_mode,
            "tail_padding_ms": _require_int(cfg.get("tail_padding_ms"), "config.tail_padding_ms",
                                            TAIL_PADDING_MIN, TAIL_PADDING_MAX),
        },
        "engine_id": engine_id,
        "expression": {
            "family": expr_family,
            "kind": expr_kind,
            "row_id": expr_row_id,
            "strength": expr_strength,
        },
        "key_version": key_version,
        "model_id": model_id,
        "phrase_version": phrase_version,
        "voice_content_sha256": voice_content_sha256,
    })


def canonical_cache_key_payload(inp):
    """현재 버전 상수로 canonical 직렬화 문자열 산출."""
    return canonical_cache_key_payload_at(inp, EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION)


def build_cache_key_at(inp, phrase_version, key_version):
    """버전을 명시 지정한 캐시 키(마이그레이션/테스트용)."""
    return sampler_sha256_hex(canonical_cache_key_payload_at(inp, phrase_version, key_version))


def build_cache_key(inp):
    """감정 **하나**에 대한 캐시 키(64 hex). 같은 키 → 반드시 재사용, 재생성 금지.

    감정 목록을 받지 않는다 — 대량 생성 진입점은 이 모듈 어디에도 없다(계약 1).
    """
    return build_cache_key_at(inp, EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION)


# parity 고정 벡터: TS/Python 이 같은 입력에 바이트 동일한 payload · 동일 key 를 내는지 대조.
EMOTION_SAMPLER_PARITY_INPUT = {
    "voice_content_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "engine_id": "qwen",
    "model_id": "qwen3-omni-flash",
    "expression": {"family": "emotion", "row_id": "emotion_happy",
                   "kind": "emotionTransition", "strength": 100},
    "config": {"speed": 1.05, "pitch": -0.5, "tail_mode": "auto", "tail_padding_ms": 120, "tail_fade_ms": 8},
}
EMOTION_SAMPLER_PARITY_PAYLOAD = '{"config":{"pitch_centi":-50,"speed_milli":1050,"tail_fade_ms":8,"tail_mode":"auto","tail_padding_ms":120},"engine_id":"qwen","expression":{"family":"emotion","kind":"emotionTransition","row_id":"emotion_happy","strength":100},"key_version":3,"model_id":"qwen3-omni-flash","phrase_version":2,"voice_content_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
EMOTION_SAMPLER_PARITY_KEY = "d99546c21090dfde7f47416c60b87a51ec1beb4400c02814be7b809b1826d087"


# ── 7) 상태 기계 — 자동 재시도 없음. 거부는 '이유 코드'로 드러난다. ──────────
EMOTION_SAMPLER_REJECTION_CODES = (
    "ALREADY_GENERATING",    # 생성 중 재요청
    "CACHED_SAMPLE_EXISTS",  # 유효 캐시가 있어 재생성 불가(계약 2: 같은 키 → 재사용)
    "NO_SAMPLE_TO_DELETE",   # 지울 샘플이 없음
    "CAPABILITY_NOT_USABLE",  # 엔진이 못 하거나(unsupported) 확인되지 않아(unverified) 생성 불가
    "INVALID_EVENT",         # 이 상태에서 정의되지 않은 이벤트
)


def initial_entry(row_id, cache_key, capability=None):
    """행 하나의 초기 상태. 엔진이 못 하거나 확인 안 된 행은 '미생성'으로 시작하지 않는다."""
    rid = assert_row_id(row_id)
    cap = capability if capability is not None else capability_for_row(rid)
    state = state_for_capability(cap)
    return {
        "row_id": rid,
        "state": state,
        "reason": None if state == "idle" else cap["reason"],
        "cache_key": assert_cache_key(cache_key),
    }


def has_cached_sample(state):
    """재생 가능한 캐시 샘플이 존재하는 상태인가."""
    return state in ("ready", "degraded")


def is_auditionable(state):
    """미리듣기 가능한가. limitExceeded 는 결과를 버렸으므로 재생 불가."""
    return has_cached_sample(state)


def can_regenerate(state):
    """(재)생성이 가능한 상태인가. 유효 캐시가 있으면 False — 같은 키는 절대 재생성하지 않는다."""
    return state in ("idle", "failed", "limitExceeded")


def regenerate_blocked_notice(state):
    """생성 버튼이 비활성인 이유 문구. 회색으로만 죽이지 않고 반드시 함께 렌더한다. 활성이면 None."""
    if state == "generating":
        return "샘플을 만드는 중입니다."
    if state == "ready":
        return "같은 목소리·엔진·설정에서는 결과가 같아 다시 만들 수 없습니다. 목소리나 설정을 바꾸면 새로 만들 수 있습니다."
    if state == "degraded":
        return "이미 만들어진 샘플이 있어 다시 만들 수 없습니다(결과가 같습니다). 참조 전사를 채우거나 설정을 바꾸면 새로 만들 수 있습니다."
    if state == "unsupported":
        return "지금 엔진이 이 표현을 만들지 못합니다. 설정을 바꿔도 만들어지지 않습니다."
    if state == "unverified":
        return "엔진이 이 표현을 해낼 수 있는지 아직 확인되지 않아 만들지 않습니다."
    return None


def _entry_with(entry, state, reason, cache_key=None):
    return {
        "row_id": entry["row_id"],
        "state": state,
        "reason": reason,
        "cache_key": entry["cache_key"] if cache_key is None else assert_cache_key(cache_key),
    }


def _ok(entry):
    return {"entry": entry, "applied": True, "rejected": None}


def _reject(entry, code):
    return {"entry": entry, "applied": False, "rejected": code}


def apply_event(entry, event):
    """상태 전이(순수). 자동 재시도·자동 폴백 없음 — 실패는 실패 상태로 남고 사용자가 다시 누른다.

    거부된 전이는 rejected 코드로 드러난다(조용히 삼키지 않는다).
    불변식: applied == (rejected is None).
    """
    etype = (event or {}).get("type")
    state = entry["state"]

    if etype == "GENERATE_REQUESTED":
        if state == "generating":
            return _reject(entry, "ALREADY_GENERATING")
        if has_cached_sample(state):
            return _reject(entry, "CACHED_SAMPLE_EXISTS")
        # 엔진이 못 하는/확인 안 된 행은 눌러도 시작하지 않는다(가짜 진행 금지).
        if state in ("unsupported", "unverified"):
            return _reject(entry, "CAPABILITY_NOT_USABLE")
        return _ok(_entry_with(entry, "generating", None))

    if etype == "GENERATE_SUCCEEDED":
        if state != "generating":
            return _reject(entry, "INVALID_EVENT")
        if event.get("degraded") is True:
            return _ok(_entry_with(entry, "degraded", "SAMPLER_XVECTOR_ONLY"))
        return _ok(_entry_with(entry, "ready", None))

    if etype == "GENERATE_FAILED":
        if state != "generating":
            return _reject(entry, "INVALID_EVENT")
        reason = event.get("reason")
        if reason not in EMOTION_SAMPLE_STATE_REASONS["failed"]:
            reason = "SAMPLER_UNKNOWN"
        return _ok(_entry_with(entry, "failed", reason))

    if etype == "GENERATE_LIMIT_EXCEEDED":
        if state != "generating":
            return _reject(entry, "INVALID_EVENT")
        return _ok(_entry_with(entry, "limitExceeded", "SAMPLER_GENERATION_LIMIT"))

    if etype == "CACHE_HIT":
        if state == "generating":
            return _reject(entry, "ALREADY_GENERATING")
        if event.get("degraded") is True:
            return _ok(_entry_with(entry, "degraded", "SAMPLER_XVECTOR_ONLY"))
        return _ok(_entry_with(entry, "ready", None))

    if etype == "DELETED":
        if not has_cached_sample(state):
            return _reject(entry, "NO_SAMPLE_TO_DELETE")
        return _ok(_entry_with(entry, "idle", None))

    if etype == "KEY_CHANGED":
        # 설정이 바뀌어도 엔진 능력은 그대로다 — 못 하던 행을 '미생성'으로 되돌리지 않는다.
        if state in ("unsupported", "unverified"):
            return _ok(_entry_with(entry, state, entry["reason"], event.get("cache_key")))
        return _ok(_entry_with(entry, "idle", None, event.get("cache_key")))

    return _reject(entry, "INVALID_EVENT")


# ── 8) 캐시 조회 — hit 이면 재사용(생성 호출 없음). ─────────────────────────
def resolve_request(row_id, cache_key, cache_index, capability=None):
    """감정 **하나**에 대한 요청 해석. 캐시에 키가 있으면 반드시 'reuse'(재생성 없음).

    감정 배열을 받지 않는다 — 시그니처 자체가 대량 생성을 불가능하게 한다(계약 1).
    cache_index: {cache_key: {"degraded": bool}} — **경로를 담지 않는다**(셸이 키로 파일을 찾는다).
    """
    base = initial_entry(row_id, cache_key, capability)
    hit = (cache_index or {}).get(cache_key)
    if hit:
        t = apply_event(base, {"type": "CACHE_HIT", "degraded": hit.get("degraded") is True})
        return {"action": "reuse", "entry": t["entry"]}
    # 엔진이 못 하는/확인 안 된 행은 캐시가 없어도 '생성'을 계획하지 않는다.
    if base["state"] in ("unsupported", "unverified"):
        return {"action": "blocked", "entry": base}
    return {"action": "generate", "entry": base}


# ── 9) 표시용 파생 ──────────────────────────────────────────────────────────
_TONE_BY_STATE = {
    "idle": "neutral",
    "generating": "busy",
    "ready": "ok",
    "degraded": "warn",
    "limitExceeded": "error",
    "failed": "error",
    "unsupported": "error",
    "unverified": "warn",
}


def describe_sample(entry):
    """상태 dict → 표시용 파생(순수). TS describeEmotionSample() 과 같은 문자열을 낸다."""
    state = entry["state"]
    reason = entry.get("reason")
    if state == "generating":
        generate_label = "만드는 중…"
    elif state == "idle":
        generate_label = "샘플 만들기"
    elif state == "unsupported":
        generate_label = "만들 수 없음"
    elif state == "unverified":
        generate_label = "확인 전"
    else:
        generate_label = "다시 만들기"
    return {
        "row_id": entry["row_id"],
        "state": state,
        "state_label": EMOTION_SAMPLE_STATE_LABEL[state],
        "reason": reason,
        "reason_label": EMOTION_SAMPLE_REASON_LABEL[reason] if reason else None,
        "tone": _TONE_BY_STATE[state],
        "audition_enabled": is_auditionable(state),
        "generate_enabled": can_regenerate(state),
        "generate_label": generate_label,
        "generate_notice": regenerate_blocked_notice(state),
        "delete_enabled": has_cached_sample(state),
    }


# 펼쳤을 때 상단에 고정으로 렌더 — 샘플러가 감정 참조 등록이 아님을 화면에서 못 박는다.
EMOTION_SAMPLER_DISCLAIMER = "샘플은 기본 목소리로 만든 미리듣기 전용입니다. 감정 참조로 등록되지 않으며 합성 결과에 쓰이지 않습니다."

# 접이식 섹션 제목. '감정 참조 등록'과 어휘가 겹치지 않게 고른 이름이다.
# (코드/모듈 이름은 emotion_sampler = 감정 샘플러 그대로 두고, 화면에 보이는 이름은 이것 하나로 통일한다.)
EMOTION_SAMPLER_SECTION_TITLE = "감정·표현 미리듣기"

# ── 접힘 상태 요약(progressive disclosure) — 접혀 있을 때는 아래 수치'만' 보여준다. ──
# 상태 6개가 정확히 한 버킷에만 들어간다(중복 집계 없음). idle 은 어느 버킷에도 넣지 않는다.
EMOTION_SAMPLE_SUMMARY_BUCKETS = (
    "generated",
    "generating",
    "attention",
)

EMOTION_SAMPLE_SUMMARY_LABEL = {
    "generated": "만들어짐",
    "generating": "만드는 중",
    "attention": "확인 필요",
}

# 모든 버킷이 0 일 때 대신 보여주는 문장(빈 수치 나열 금지).
EMOTION_SAMPLE_SUMMARY_EMPTY = "아직 만든 미리듣기가 없습니다"

_SUMMARY_BUCKET_BY_STATE = {
    "idle": None,
    "generating": "generating",
    "ready": "generated",
    "degraded": "attention",
    "limitExceeded": "attention",
    "failed": "attention",
    # 못 하는/확인 안 된 행도 '확인 필요' 로 묶는다 — 버킷을 늘리면 접힘 한 줄이 길어진다.
    "unsupported": "attention",
    "unverified": "attention",
}


def summarize_samples(entries):
    """접힘 상태 요약(순수). 항목이 아무리 많아도 수치 3개 + 한 줄로 고정된다."""
    counts = {"generated": 0, "generating": 0, "attention": 0}
    for e in entries:
        bucket = _SUMMARY_BUCKET_BY_STATE[e["state"]]
        if bucket:
            counts[bucket] += 1
    parts = [
        "%s %d" % (EMOTION_SAMPLE_SUMMARY_LABEL[b], counts[b])
        for b in EMOTION_SAMPLE_SUMMARY_BUCKETS if counts[b] > 0
    ]
    out = dict(counts)
    out["text"] = " · ".join(parts) if parts else EMOTION_SAMPLE_SUMMARY_EMPTY
    return out


# ─────────────────────────────────────────────────────────────────────────
# 11) 표현 언어 계약 소비 — 행 카탈로그 · 대본 조립 · 표현 이벤트 키 축
#
# 권위는 python/expressive_timeline.py(= src/shared/expressiveTimeline.ts) 하나다.
# 이 모듈은 그 계약을 '소비'한다: 이벤트 종류/웃음 스타일/세기/분류를 재구현하지 않는다.
#   · 아래 카탈로그는 "어떤 토큰을 어떤 순서로 놓을지"만 선언한다(= 대본 조립 지시).
#   · 그 토큰이 실제로 어떤 이벤트/세기가 되는지는 계약 파서가 정한다.
#     단위테스트가 실제 parse_expressive_timeline 을 돌려 expect_kind/세기를 대조하므로,
#     계약이 바뀌면 여기가 조용히 어긋나지 않고 테스트가 먼저 깨진다.
# ─────────────────────────────────────────────────────────────────────────

EMOTION_SAMPLE_FAMILIES = ("emotion", "emotionTransition", "punctuation", "laugh")

# 샘플 행 카탈로그(v2). 사용자가 이 중에서 하나씩 골라 생성한다 — 일괄 생성 경로는 없다.
# 감정 4행 + 감정 전환 1행은 기존 baseline 그대로를 만든다(비교 기준선 보존).
# ⚠️ 감정 이름은 계약 감정표에 있는 것만 쓴다. 요청받은 '분노'/'차분'은 그 표에 없어
#    각각 '화남'(angry)/'진지'(serious)로 잡았다.
EMOTION_SAMPLE_ROWS = (
    {"row_id": "emotion_happy", "family": "emotion", "label": "기쁨",
     "expect_kind": "emotionTransition",
     "parts": ({"part": "emotion_tag", "label": "기쁨"}, {"part": "space"}, {"part": "baseline_phrase"})},
    {"row_id": "emotion_sad", "family": "emotion", "label": "슬픔",
     "expect_kind": "emotionTransition",
     "parts": ({"part": "emotion_tag", "label": "슬픔"}, {"part": "space"}, {"part": "baseline_phrase"})},
    {"row_id": "emotion_angry", "family": "emotion", "label": "화남",
     "expect_kind": "emotionTransition",
     "parts": ({"part": "emotion_tag", "label": "화남"}, {"part": "space"}, {"part": "baseline_phrase"})},
    {"row_id": "emotion_serious", "family": "emotion", "label": "진지",
     "expect_kind": "emotionTransition",
     "parts": ({"part": "emotion_tag", "label": "진지"}, {"part": "space"}, {"part": "baseline_phrase"})},
    {"row_id": "emotion_transition_happy_sad", "family": "emotionTransition", "label": "기쁨→슬픔 전환",
     "expect_kind": "emotionTransition",
     "parts": ({"part": "emotion_tag", "label": "기쁨"}, {"part": "space"},
               {"part": "baseline_phrase_at", "index": 0}, {"part": "space"},
               {"part": "emotion_tag", "label": "슬픔"}, {"part": "space"},
               {"part": "baseline_phrase_at", "index": 1})},

    {"row_id": "punct_emphasis", "family": "punctuation", "label": "! 강조", "expect_kind": "emphasis",
     "parts": ({"part": "host"}, {"part": "prosody_token", "token": "!"})},
    {"row_id": "punct_question_rise", "family": "punctuation", "label": "? 올림", "expect_kind": "question_rise",
     "parts": ({"part": "host"}, {"part": "prosody_token", "token": "?"})},
    {"row_id": "punct_shock_rise", "family": "punctuation", "label": "!? 놀람", "expect_kind": "shock_rise",
     "parts": ({"part": "host"}, {"part": "prosody_token", "token": "!?"})},
    {"row_id": "punct_fade_end", "family": "punctuation", "label": "... 흐림", "expect_kind": "fade_end",
     "parts": ({"part": "host"}, {"part": "prosody_token", "token": "..."})},
    {"row_id": "punct_vowel_extend", "family": "punctuation", "label": "~ 늘임", "expect_kind": "vowel_extend",
     "parts": ({"part": "host"}, {"part": "prosody_token", "token": "~"})},

    # 요청받은 이름은 6개인데 계약의 style 은 5개다. '밝은 웃음'은 새 style 이 아니라
    # 같은 chuckle 의 반복 수(밝기) 변형으로 잡는다 — 계약에 없는 style 을 만들지 않기 위해서다.
    {"row_id": "laugh_chuckle", "family": "laugh", "label": "피식 웃음", "expect_kind": "chuckle",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "ㅋ"})},
    {"row_id": "laugh_bright", "family": "laugh", "label": "밝은 웃음", "expect_kind": "chuckle",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "ㅋㅋㅋㅋㅋ"})},
    {"row_id": "laugh_breathy", "family": "laugh", "label": "숨 섞인 웃음", "expect_kind": "breathy",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "ㅎㅎ"})},
    {"row_id": "laugh_bashful", "family": "laugh", "label": "수줍은 웃음", "expect_kind": "bashful",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "헤헤"})},
    {"row_id": "laugh_open", "family": "laugh", "label": "열린 웃음", "expect_kind": "open",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "호호"})},
    {"row_id": "laugh_high_giggle", "family": "laugh", "label": "장난스러운 웃음", "expect_kind": "high_giggle",
     "parts": ({"part": "host"}, {"part": "space"}, {"part": "laugh_tag", "inner": "히히"})},
)

_ROW_BY_ID = {r["row_id"]: r for r in EMOTION_SAMPLE_ROWS}


def assert_row_id(row_id):
    """행 id 검증. list/tuple/dict 를 넘기면 즉시 실패한다(일괄 생성 진입점이 생길 수 없다)."""
    v = _validated_string(row_id, "row_id", "SAMPLER_INVALID_ROW_ID")
    if not _ROW_ID_RE.match(v) or v not in _ROW_BY_ID:
        raise EmotionSamplerInputError("SAMPLER_INVALID_ROW_ID", "row_id")
    return v


def sample_row(row_id):
    return _ROW_BY_ID[assert_row_id(row_id)]


def build_sample_script(row_id):
    """행 하나의 합성 대본을 계약 토큰으로 조립해 돌려준다.

    ⚠️ 시그니처 변경: v1 은 build_sample_script(emotion_tag_text) 로 '[감정]' 문자열을 받아 결합했다.
       이제는 행 id 만 받고, 무엇을 어떻게 놓을지는 카탈로그가 정한다.
    ⚠️ 반환값은 '프롬프트'다 — 상태 dict·캐시 키·화면·로그 어디에도 넣지 않는다. 합성 인자 전용.
    ⚠️ 이 문자열의 '의미'는 계약 파서가 정한다(parse_expressive_timeline(script, mode="expressive_v3")).
    """
    row = sample_row(row_id)
    out = []
    for p in row["parts"]:
        kind = p["part"]
        if kind == "emotion_tag":
            out.append("[%s]" % p["label"])
        elif kind == "baseline_phrase":
            out.append(phrase_script())
        elif kind == "baseline_phrase_at":
            idx = p["index"]
            out.append(EMOTION_SAMPLER_PHRASES[idx] if 0 <= idx < len(EMOTION_SAMPLER_PHRASES) else "")
        elif kind == "host":
            out.append(EMOTION_SAMPLER_EXPRESSION_HOST)
        elif kind == "prosody_token":
            out.append(p["token"])
        elif kind == "laugh_tag":
            out.append("[%s]" % p["inner"])
        elif kind == "space":
            out.append(" ")
    return "".join(out)


def expression_from_timeline(row_id, timeline):
    """계약 타임라인에서 이 행의 표현 축을 뽑는다(세기의 권위는 전적으로 계약).

    이벤트가 여러 개면 마지막 것을 쓴다(감정 전환 행처럼 2개인 경우 결정적으로 하나만 고르기 위해).
    """
    row = sample_row(row_id)
    fam = row["family"]
    if fam in ("emotion", "emotionTransition"):
        evs = timeline.get("emotion_transitions") or []
        if not evs:
            raise EmotionSamplerInputError("SAMPLER_EXPRESSION_MISSING", "timeline")
        return {"family": fam, "row_id": row["row_id"], "kind": "emotionTransition",
                "strength": evs[-1]["transition_strength"]}
    if fam == "punctuation":
        evs = timeline.get("local_prosody") or []
        if not evs:
            raise EmotionSamplerInputError("SAMPLER_EXPRESSION_MISSING", "timeline")
        return {"family": fam, "row_id": row["row_id"], "kind": evs[-1]["kind"],
                "strength": evs[-1]["strength"]}
    evs = timeline.get("laughs") or []
    if not evs:
        raise EmotionSamplerInputError("SAMPLER_EXPRESSION_MISSING", "timeline")
    return {"family": fam, "row_id": row["row_id"], "kind": evs[-1]["style"],
            "strength": evs[-1]["intensity"]}


# ── 엔진 capability ──────────────────────────────────────────────────────
#
# ⚠️ 권위는 엔진 capability 모듈(expressive_capability.py + expressive_planner.py)이고,
#    그 모듈은 feature/expressive-prosody-engine 에 있으며 이 브랜치에 병합되지 않았다.
#    아래 표는 그 계약의 '선언'을 이름 그대로 옮겨 둔 기본값일 뿐, 프로브로 확인된 값이 아니다.
# ⚠️ capability 규칙: 선언만으로는 절대 supported 가 되지 않는다. 프로브 증거가 없으면
#    'unknown' 이고, 'unknown' 은 성공이 아니다. usable 은 'supported' 뿐이다.

EMOTION_SAMPLER_CAPABILITY_STATES = ("supported", "degraded", "unsupported", "unknown")

_CAP_OK = {"state": "supported", "reason": None}
_CAP_LAUGH = {"state": "unsupported", "reason": "LAUGH_NO_STRATEGY"}
_CAP_UNVERIFIED = {"state": "unknown", "reason": "CAPABILITY_UNVERIFIED"}


def _declared_capability():
    out = {}
    for r in EMOTION_SAMPLE_ROWS:
        if r["family"] == "laugh":
            out[r["row_id"]] = _CAP_LAUGH
        elif r["expect_kind"] == "vowel_extend":
            out[r["row_id"]] = _CAP_UNVERIFIED
        else:
            out[r["row_id"]] = _CAP_OK
    return out


EMOTION_SAMPLE_DECLARED_CAPABILITY = _declared_capability()


def capability_for_vowel_extend(classification):
    """계약의 '~' 최종음 분류 -> capability 판정. 분류는 계약이, 판정은 엔진 규칙이 한다.

    non_sustainable_final -> unsupported / VOWEL_EXTEND_NOT_REALIZABLE (자음 반복 금지 → 실현 경로 없음)
    그 밖(open_vowel / sustainable_final / undeterminable) -> unknown(프로브 없음)
    ⚠️ 어느 경우에도 'supported' 가 나오지 않는다 — 프로브 전까지 '됨'이라고 말하지 않는다.
    """
    if classification == "non_sustainable_final":
        return {"state": "unsupported", "reason": "VOWEL_EXTEND_NOT_REALIZABLE"}
    return {"state": "unknown", "reason": "CAPABILITY_UNVERIFIED"}


def is_capability_usable(state):
    """이 capability 로 실제 생성을 시도해도 되는가. 'supported' 만 True."""
    return state == "supported"


def state_for_capability(cap):
    """capability -> 초기 상태. 못 하거나 확인 안 된 것은 각자의 이름 있는 상태로 시작한다."""
    if cap["state"] == "supported":
        return "idle"
    if cap["state"] == "unsupported":
        return "unsupported"
    return "unverified"


def capability_for_row(row_id, override=None):
    """행의 capability(주입 override 우선). 엔진 capability 모듈이 병합되면 통합 담당이 주입한다."""
    rid = assert_row_id(row_id)
    if override and rid in override:
        return override[rid]
    return EMOTION_SAMPLE_DECLARED_CAPABILITY[rid]


# ── 10) canonical 직렬화 + sha256 (tts_grammar.py 와 동일 알고리즘). ────────
def _json_escape(s):
    out = ['"']
    for ch in s:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _canonicalize(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        raise ValueError("canonical: float 금지")
    if isinstance(v, str):
        return _json_escape(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_canonicalize(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys())
        return "{" + ",".join(_json_escape(k) + ":" + _canonicalize(v[k]) for k in keys) + "}"
    raise TypeError("canonical: 미지원 타입 %r" % type(v))


def sampler_sha256_hex(s):
    """문자열 → sha256 hex(64자)."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()
