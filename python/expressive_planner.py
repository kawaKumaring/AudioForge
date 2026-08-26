# -*- coding: utf-8 -*-
"""표현형 운율 ENGINE — 순수 생성 계획기(planner). 타임라인 → 생성 계획.

의존성: stdlib + expressive_timeline(계약) + expressive_capability(엔진 판정) + generation_limit(상한 권위).
모델/GPU/파일 I/O/서브프로세스 없음. **프로덕션에 배선되어 있지 않다** — 통합 담당자가 나중에 붙인다.

────────────────────────────────────────────────────────────────────────────
왜 이 모듈이 있는가
────────────────────────────────────────────────────────────────────────────
지금 동작(감정/구두점마다 짧은 WAV 를 만들어 이어 붙이기)은 **목표가 아니다.**
이 계획기는 정반대 방향을 강제한다.

  · 한 번의 호출에 안전하게 들어가는 만큼 최대한 담는다. 문장마다 자르지 않는다.
  · 같은 감정의 2~3 문장은 모델 상한 안에서 한 덩어리로 묶는다.
  · **쉼표에서 절대 자르지 않는다.**
  · **감정 태그를 강제 분할점으로 삼지 않는다** — 계약이 이미 is_chunk_boundary=False 로
    선언했으므로 그 값을 그대로 소비한다(여기서 다시 유도하지 않는다).
  · 분할은 오직 세 가지 이유로만 일어난다: 문단 구조 / 긴 종결 / 모델 생성 상한.
    (+ 정책 상한 SENTENCE_GROUP_MAX 와 capability 가 낮아서 생긴 전략 경계는 별도 코드로 기록한다.)
  · 자동 재시도 없음. 맞추려고 생성 상한을 올리는 일도 없음.
  · 모든 분할은 '왜' 를 구조화된 사유 코드로 남긴다.

정직성 원칙: 엔진이 못 하는 것을 할 수 있는 척하지 않는다. capability 가 'supported' 가 아니면
계획은 더 낮은 전략을 고르고 degraded/unsupported 로 표기한다. 후처리로 만든 것을
'의미를 달성했다' 고 주장하지 않는다(semantic_claim=False).
"""
import hashlib
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

import expressive_capability as cap
import expressive_timeline as ex
import generation_limit  # 생성 상한의 유일 권위(순수 math). 값을 복사하지 않는다.

PLAN_VERSION = 1

# ─────────────────────────────────────────────────────────────────────────────
# 1. 분할 사유 / 금지 목록
# ─────────────────────────────────────────────────────────────────────────────

SPLIT_REASON_CODES = (
    "PARAGRAPH_BREAK",             # 문단 구조(빈 줄)
    "LONG_TERMINAL",               # 긴 종결(긴 말줄임 fade_end 또는 사용자가 쓴 명시적 쉼)
    "GENERATION_LIMIT",            # 모델 생성 상한 — 맞추려고 상한을 올리지 않는다
    "SENTENCE_GROUP_MAX",          # 정책 상한(같은 감정 2~3 문장 묶기)
    "EMOTION_STRATEGY_OVERLAP",    # 전략 B — 겹침 문맥 경계(실험적)
    "EMOTION_STRATEGY_HARD_JOIN",  # 전략 C — 마지막 수단 하드 조인(degraded)
    "END_OF_INPUT",                # 마지막 청크의 종료(분할이 아님)
)

# 여기 있는 코드가 계획에 나타나면 계약 위반이다(테스트가 고정한다).
FORBIDDEN_SPLIT_REASONS = (
    "COMMA",             # 쉼표 분할 금지
    "EMOTION_TAG",       # 감정 태그 강제 분할 금지
    "PUNCTUATION_MARK",  # 구두점마다 새 WAV 금지
    "SENTENCE",          # 문장마다 분할 금지
)

# 계획이 절대 지시하지 않는 후처리(사용자가 듣기 전에 기본값을 바꾸는 종류).
FORBIDDEN_POST_PROCESS_OPS = (
    "chunk_start_fade_in",        # 모든 청크 시작 일괄 페이드인
    "first_syllable_trim",        # 첫 음절 일괄 트림
    "global_denoise",             # 전역 디노이즈
    "noise_gate",                 # 전역 노이즈 게이트
    "global_pitch_normalize",     # 파일 전체 피치 균일화
    "global_formant_normalize",   # 파일 전체 포먼트 균일화
    "consonant_time_stretch",     # 자음 시간 늘이기
    "final_consonant_time_stretch",  # 받침 자음 늘이기
    "final_consonant_repeat",     # 받침 자음 반복/복제로 길이 벌기(명시적 금지)
)

# 긴 종결 판정: 계약의 fade_end 지속 힌트 표에서 count=4 이상을 '긴 종결' 로 본다(값 복사 아님).
LONG_TERMINAL_MIN_DURATION_MS = ex.FADE_END_DURATION_MS_BY_COUNT[4]

# 문장 종결로 취급하는 국소 운율(계약 LOCAL_PROSODY_KINDS 의 부분집합).
TERMINAL_PROSODY_KINDS = ("firm_end", "fade_end", "emphasis", "question_rise", "shock_rise")

# 정책 상한: 한 청크에 담는 문장 수(같은 감정 2~3 문장 묶기 목표). 모델 상한과 별개의 정책값이다.
SENTENCE_GROUP_MAX_DEFAULT = 3
SENTENCE_GROUP_PREFERRED_MIN = 2

# ─────────────────────────────────────────────────────────────────────────────
# 2. 감정 블렌딩 전략
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_STRATEGIES = (
    "single_call_continuous",  # A — 전후 문맥을 한 번의 호출로 생성
    "overlap_context",         # B — 겹침 문맥(실험적)
    "hard_join",               # C — 마지막 수단. 결과는 degraded
)

STRATEGY_REASON_CODES = (
    "CONTINUOUS_WEIGHTS_SUPPORTED",       # A, 연속 가중치까지 방출
    "INLINE_INSTRUCTION_SUPPORTED",       # A, 인라인 지시만(가중치 방출 안 함)
    "NO_INLINE_SUPPORT_FALLBACK_OVERLAP",  # B(인라인이 '명시적으로' 불가)
    "NO_CONTEXT_SUPPORT_LAST_RESORT",     # C(겹침도 '명시적으로' 불가)
    "CAPABILITY_UNVERIFIED_FALLBACK",     # 미검증 → 위 전략으로 올라갈 수 없음
)

# 전환 목표 궤적: 이전 100% → 이전 70/신규 30 → 이전 30/신규 70 → 신규 100%.
EMOTION_TRAJECTORY_STEPS = ((100, 0), (70, 30), (30, 70), (0, 100))
EMOTION_TRAJECTORY_IMMEDIATE_STEPS = ((0, 100),)

TRAJECTORY_REALIZATIONS = (
    "continuous_weights",     # 엔진이 연속 가중치를 실제로 받아들임(검증됨)
    "single_call_implicit",   # 한 호출 안 인라인 지시 — 수치 궤적은 내보내지 않는다
    "overlap_approximation",  # 전략 B 의 근사(실험적)
    "immediate",              # 즉시 전환 — 궤적 자체가 없음(계약 mode='immediate')
    "none",                   # 전략 C — 궤적 미실현
)

# 전략 B 의 겹침 목표(실험적 기본값). 실제 엔진에서 검증되지 않았다.
OVERLAP_CONTEXT_MS_DEFAULT = 400
OVERLAP_CONTEXT_TAIL_CHARS = 24

# ─────────────────────────────────────────────────────────────────────────────
# 3. 구두점 실현
# ─────────────────────────────────────────────────────────────────────────────

PUNCTUATION_REALIZATIONS = ("model_native", "post_process", "unsupported")

POST_PROCESS_OPS = (
    "scoped_amplitude_decay",    # fade_end — 범위 한정 감쇠
    "scoped_gain_envelope",      # emphasis — 범위 한정 게인 포락
    "scoped_f0_ramp",            # question_rise — 범위 한정 F0 램프(실험적)
    "final_vowel_time_stretch",  # vowel_extend — 마지막 '모음' 만 늘임(자음 금지)
)

# 네이티브가 없을 때 쓸 수 있는 후처리(없으면 None → unsupported 로 표기, 조용히 버리지 않음).
PROSODY_POST_PROCESS_OP = {
    "firm_end": None,           # 단호한 종결은 후처리로 만들 수 없다
    "fade_end": "scoped_amplitude_decay",
    "emphasis": "scoped_gain_envelope",
    "question_rise": "scoped_f0_ramp",
    "shock_rise": None,         # 놀람+상승은 후처리 등가물이 없다
    "vowel_extend": "final_vowel_time_stretch",
}

# 후처리가 실험적인 op(의미 달성 주장 금지 + 실험 표기).
EXPERIMENTAL_POST_PROCESS_OPS = ("scoped_f0_ramp",)

# '~' 판정 사유는 expressive_capability 의 VOWEL_EXTEND_VERDICT_REASONS 를 그대로 소비한다.
UNSUPPORTED_PROSODY_REASONS = (
    ("NO_POST_PROCESS_EQUIVALENT",)  # 네이티브 없음 + 후처리 등가물 없음
    + cap.VOWEL_EXTEND_VERDICT_REASONS
)

# ─────────────────────────────────────────────────────────────────────────────
# 4. 웃음
# ─────────────────────────────────────────────────────────────────────────────

LAUGH_STRATEGIES = (
    "model_native_instruction",     # A
    "same_conditioning_candidate",  # B
    "cached_sample",                # C
    "voice_conditioned_transform",  # D(실험적)
)

LAUGH_STRATEGY_REASONS = (
    "NATIVE_INSTRUCTION_SUPPORTED",
    "NO_NATIVE_FALLBACK_SAME_CONDITIONING",
    "NO_GENERATION_FALLBACK_CACHED_SAMPLE",
    "NO_CACHE_FALLBACK_VOICE_TRANSFORM",
    "NO_STRATEGY_AVAILABLE",
)

LAUGH_POSITION_BEHAVIOURS = {
    "leading": "laugh_then_speech_one_breath",
    "inline": "short_laugh_continue_same_state",
    "trailing": "connect_sentence_final_emotion_natural_decay",
    "standalone": "isolated_nonverbal",
}

# 웃음 주변은 하드 조인 금지 — 아래 검사를 통과해야 한다.
LAUGH_REQUIRED_CHECKS = (
    "level_match",
    "f0_continuity",
    "speaker_similarity",
    "breath_silence_alignment",
)
LAUGH_JOIN_POLICY = "no_hard_join"
LAUGH_OPTIONAL_OVERLAP_BLEND_MS = 30
LAUGH_INLINE_MAX_MS = ex.LAUGH_DURATION_MS_BY_REPEAT[3]

LAUGH_MANIFEST_FIELDS = (
    "event_index", "chunk_index", "node_index", "line_index",
    "event_kind",                      # 항상 "nonverbal"
    "style", "position", "position_behaviour",
    "intensity", "brightness", "duration_hint",
    "raw_repeat_count", "effective_repeat_count", "capped",
    "strategy", "strategy_reason", "experimental", "degraded",
    "never_literal_text",              # 항상 True — 음절로 렌더링 금지
    "asr_compare_as_words",            # 항상 False
    "verify_position", "verify_presence",
    "join_policy", "required_checks", "optional_overlap_blend_ms",
    "gap_ms", "carried_emotion_id",
    "source_start_cp", "source_end_cp",
)

LAUGH_EVENT_KIND = "nonverbal"

# ─────────────────────────────────────────────────────────────────────────────
# 5. 연속성(continuity)
# ─────────────────────────────────────────────────────────────────────────────

REFERENCE_MODES = ("icl", "x_vector_only")
SEED_POLICIES = ("fixed", "per_chunk_derived", "random")

# 모든 청크가 '완전히 동일' 해야 하는 필드.
CONTINUITY_IDENTICAL_FIELDS = (
    "reference_clip_id",
    "reference_transcript_id",
    "reference_mode",
    "speaker_id",
    "language",
    "generation_settings_id",
    "seed_policy",
    "emotion_track_id",   # 감정 상태의 '트랙 동일성'(청크별 값이 아니라 같은 타임라인에서 나왔는지)
    "context_chain_id",   # 선행 문맥 사슬의 동일성
)

# 값 자체는 청크마다 다르지만 '반드시 존재하고 앞뒤로 이어져야' 하는 필드.
CONTINUITY_CHAINED_FIELDS = (
    "preceding_context_id",
    "entry_emotion_id",
    "seed_value",
)

CONTINUITY_FIELD_ORDER = CONTINUITY_IDENTICAL_FIELDS + CONTINUITY_CHAINED_FIELDS

CONTINUITY_DIVERGENCE_CODES = (
    "IDENTICAL_FIELD_DIVERGED",
    "CONTEXT_CHAIN_BROKEN",
    "EMOTION_STATE_MISSING",
    "EMOTION_STATE_BROKEN",
    "SEED_POLICY_VIOLATED",
)

# ─────────────────────────────────────────────────────────────────────────────
# 6. degraded / unsupported 코드
# ─────────────────────────────────────────────────────────────────────────────

DEGRADATION_CODES = (
    "REFERENCE_X_VECTOR_ONLY",              # 참조 전사 없이 x-vector 만 — 절대 조용히 넘어가지 않는다
    "EMOTION_HARD_JOIN",                    # 전략 C
    "EMOTION_OVERLAP_EXPERIMENTAL",         # 전략 B
    "MID_UNIT_EMOTION_TRANSITION_DEFERRED",  # 문장 중간 전환을 다음 문장으로 미룸(문장 중간 분할 금지)
    "NON_DETERMINISTIC_SEED",               # seed_policy=random → 재현 불가
    "PUNCTUATION_POST_PROCESS_ONLY",        # 네이티브 없음 → 후처리 근사(의미 달성 주장 없음)
    "LAUGH_CACHED_SAMPLE",                  # 웃음 전략 C
    "LAUGH_VOICE_TRANSFORM_EXPERIMENTAL",   # 웃음 전략 D
    "VOWEL_EXTEND_NON_SUSTAINABLE_FINAL",   # 지속 불가 받침 — degraded + 경고
    "CAPABILITY_UNVERIFIED",                # 실제 엔진 없이는 판정 불가
)

UNSUPPORTED_CODES = (
    "PROSODY_NO_REALIZATION",         # 네이티브도 후처리도 없음
    "VOWEL_EXTEND_NO_TARGET",         # 늘일 대상 자체가 없음
    "VOWEL_EXTEND_NOT_REALIZABLE",    # 받침 계열 — 자음 늘이기/반복 금지라 실현 경로 없음
    "LAUGH_NO_STRATEGY",              # 웃음 전략 A~D 전부 불가
    "UNIT_EXCEEDS_GENERATION_LIMIT",  # 한 문장이 상한 초과 — 쉼표 분할/상한 상향 금지 → 차단 이슈
)

BLOCKING_UNSUPPORTED_CODES = ("UNIT_EXCEEDS_GENERATION_LIMIT",)

RETRY_POLICY = "none"

GAP_SOURCES = ("none", "explicit_pause", "sentence_gap", "paragraph_gap")

SENTENCE_GAP_REALIZATIONS = ("in_call_natural", "inserted_silence")


class PlanError(ValueError):
    """계획 입력 계약 위반. 메시지엔 짧은 토큰/숫자만 담는다."""


# ─────────────────────────────────────────────────────────────────────────────
# 7. 요청 입력
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GenerationSettings:
    """한 계획 전체에 걸쳐 '동일하게' 유지되어야 하는 조건. 값은 짧은 id 토큰이다.

    reference_transcript_id 는 전사 '내용' 이 아니라 그 전사를 가리키는 id 다(전문 반입 금지).
    reference_mode='x_vector_only' 는 반드시 계획에 degradation 으로 드러난다.
    """

    settings_id: str
    speaker_id: str
    language: str
    reference_clip_id: str
    reference_transcript_id: str
    reference_mode: str = "icl"
    seed_policy: str = "fixed"
    seed_value: int = 0
    max_tokens: Optional[int] = None          # None → generation_limit.max_segment_tokens()
    token_counter_id: str = "unspecified"
    sentence_group_max: int = SENTENCE_GROUP_MAX_DEFAULT
    overlap_context_ms: int = OVERLAP_CONTEXT_MS_DEFAULT

    def __post_init__(self):
        if self.reference_mode not in REFERENCE_MODES:
            raise PlanError("unknown reference_mode: %s" % self.reference_mode)
        if self.seed_policy not in SEED_POLICIES:
            raise PlanError("unknown seed_policy: %s" % self.seed_policy)
        if not isinstance(self.seed_value, int) or isinstance(self.seed_value, bool):
            raise PlanError("seed_value must be int")
        if self.max_tokens is not None and (not isinstance(self.max_tokens, int) or self.max_tokens <= 0):
            raise PlanError("max_tokens must be a positive int or None")
        if not isinstance(self.sentence_group_max, int) or self.sentence_group_max < 1:
            raise PlanError("sentence_group_max must be >= 1")

    def effective_max_tokens(self) -> int:
        # 상한의 권위는 generation_limit 이다. 계획기는 이 값을 '올리지 않는다'.
        return generation_limit.max_segment_tokens() if self.max_tokens is None else self.max_tokens


def approximate_count_tokens(text: str) -> int:
    """⚠️ 프로덕션 토크나이저가 **아니다**. 테스트/미리보기 전용 거친 근사.

    실제 계획에는 qwen_bridge 의 production token 계수기를 주입해야 한다.
    계획서의 token_counter_id 가 어떤 계수기를 썼는지 기록한다.
    """
    return len(text or "")


# ─────────────────────────────────────────────────────────────────────────────
# 8. 문장 단위(sentence unit) 추출
# ─────────────────────────────────────────────────────────────────────────────

def _has_content_text(s: str) -> bool:
    """공백 판정은 계약의 공백 집합(EXPRESSIVE_WHITESPACE_CHARS)을 그대로 쓴다 — 재정의 금지."""
    return ex._has_non_whitespace(s or "")


class _Unit(object):
    __slots__ = ("index", "node_start", "node_end", "paragraph_index",
                 "line_index_start", "line_index_end", "entry_emotion_id", "exit_emotion_id",
                 "entry_transitions", "internal_transitions", "prosody_events", "laugh_events",
                 "terminator", "has_content")

    def __init__(self, node_start, line_index):
        self.index = -1
        self.node_start = node_start
        self.node_end = node_start
        self.paragraph_index = 0
        self.line_index_start = line_index
        self.line_index_end = line_index
        self.entry_emotion_id = None
        self.exit_emotion_id = None
        self.entry_transitions = []
        self.internal_transitions = []
        self.prosody_events = []
        self.laugh_events = []
        self.terminator = None
        self.has_content = False


def _terminator_is_long(term) -> bool:
    if term is None:
        return False
    if term["trigger"] == "explicit_pause":
        return True
    if term["trigger"] == "prosody" and term.get("kind") == "fade_end":
        return int(term.get("duration_hint", 0)) >= LONG_TERMINAL_MIN_DURATION_MS
    return False


def extract_sentence_units(timeline) -> Tuple[List[dict], int]:
    """타임라인 노드 → 문장 단위 목록. (units, leading_pause_ms) 반환.

    단위는 (a) 종결 국소 운율, (b) 줄바꿈, (c) 명시적 쉼, (d) 입력 끝 에서 끝난다.
    감정 태그는 단위를 끊지 **않는다**(계약 is_chunk_boundary=False 를 그대로 소비).
    쉼표는 어디에서도 단위를 끊지 않는다.
    """
    nodes = timeline["nodes"]
    lps = timeline["local_prosody"]
    ets = timeline["emotion_transitions"]
    pzs = timeline["explicit_pauses"]

    units: List[_Unit] = []
    pending_emotion = "default"
    paragraph_index = 0
    pending_paragraph = False
    line_has_content = False
    leading_pause_ms = 0

    cur = _Unit(0, 0)

    def touch(node):
        nonlocal line_has_content
        if not cur.has_content:
            cur.entry_emotion_id = pending_emotion
            cur.paragraph_index = paragraph_index
            cur.line_index_start = node["line_index"]
        cur.has_content = True
        cur.line_index_end = node["line_index"]
        line_has_content = True

    def close(node_end, terminator):
        nonlocal cur, pending_paragraph
        if cur.has_content:
            cur.node_end = node_end
            cur.exit_emotion_id = pending_emotion
            cur.terminator = terminator
            cur.index = len(units)
            units.append(cur)
        cur = _Unit(node_end, 0)

    for i, nd in enumerate(nodes):
        kind = nd["kind"]

        if kind == "text":
            if _has_content_text(nd["text"]):
                if not cur.has_content and pending_paragraph:
                    paragraph_index += 1
                    pending_paragraph = False
                touch(nd)
            continue

        if kind == "emotionTransition":
            et = ets[nd["event_index"]]
            if cur.has_content:
                cur.internal_transitions.append(nd["event_index"])
            pending_emotion = et["target_emotion"]
            if not cur.has_content:
                # 내용 전에 온 전환은 이 단위의 '진입 감정' 이다(전환 자체는 분할점이 아니다).
                cur.entry_emotion_id = pending_emotion
                cur.entry_transitions.append({"event_index": nd["event_index"],
                                              "target_emotion": et["target_emotion"],
                                              "transition_mode": et["transition_mode"]})
            continue

        if kind == "localProsody":
            lp = lps[nd["event_index"]]
            if not cur.has_content and pending_paragraph:
                paragraph_index += 1
                pending_paragraph = False
            touch(nd)
            cur.prosody_events.append(nd["event_index"])
            if lp["kind"] in TERMINAL_PROSODY_KINDS:
                close(i + 1, {"trigger": "prosody", "kind": lp["kind"],
                              "duration_hint": lp["duration_hint"], "pause_ms": None})
            continue

        if kind == "nonverbalLaugh":
            if not cur.has_content and pending_paragraph:
                paragraph_index += 1
                pending_paragraph = False
            touch(nd)
            cur.laugh_events.append(nd["event_index"])
            continue

        if kind == "explicitPause":
            pz = pzs[nd["event_index"]]
            if cur.has_content:
                close(i + 1, {"trigger": "explicit_pause", "kind": None,
                              "duration_hint": None, "pause_ms": pz["pause_ms"]})
            elif units:
                # 내용 없는 쉼은 앞 단위의 종결로 흡수한다(빈 청크를 만들지 않기 위해).
                units[-1].terminator = {"trigger": "explicit_pause", "kind": None,
                                        "duration_hint": None, "pause_ms": pz["pause_ms"]}
                units[-1].node_end = i + 1
                cur = _Unit(i + 1, 0)
            else:
                leading_pause_ms += pz["pause_ms"]
                cur = _Unit(i + 1, 0)
            continue

        if kind == "lineBreak":
            if line_has_content:
                close(i + 1, {"trigger": "line_break", "kind": None,
                              "duration_hint": None, "pause_ms": None})
            else:
                # 내용 없는 줄 = 빈 줄 → 문단 경계(다음 내용이 나올 때 확정한다).
                if units:
                    pending_paragraph = True
                cur = _Unit(i + 1, 0)
            line_has_content = False
            continue

    close(len(nodes), {"trigger": "end_of_input", "kind": None, "duration_hint": None, "pause_ms": None})

    out = []
    for u in units:
        out.append({
            "index": u.index,
            "node_start": u.node_start,
            "node_end": u.node_end,
            "paragraph_index": u.paragraph_index,
            "line_index_start": u.line_index_start,
            "line_index_end": u.line_index_end,
            "entry_emotion_id": u.entry_emotion_id or "default",
            "exit_emotion_id": u.exit_emotion_id or "default",
            "entry_transitions": list(u.entry_transitions),
            "internal_transitions": list(u.internal_transitions),
            "prosody_events": list(u.prosody_events),
            "laugh_events": list(u.laugh_events),
            "terminator": u.terminator,
            "terminator_is_long": _terminator_is_long(u.terminator),
        })
    return out, leading_pause_ms


# ─────────────────────────────────────────────────────────────────────────────
# 9. 전략 선택
# ─────────────────────────────────────────────────────────────────────────────

def select_emotion_strategy(profile: cap.CapabilityProfile) -> dict:
    """A → B → C 선호 순서. 미검증(unknown)은 절대 위 전략으로 올라가지 못한다."""
    cont = profile.state_of("continuous_emotion_weights")
    inline = profile.state_of("emotion_instruction_text")
    overlap = profile.state_of("context_overlap_conditioning")
    single = profile.state_of("single_call_long_form")

    if single == "supported" and cont == "supported":
        return {"strategy": "single_call_continuous", "reason": "CONTINUOUS_WEIGHTS_SUPPORTED",
                "emit_weights": True, "experimental": False, "degraded": False,
                "trajectory_realization": "continuous_weights"}
    if single == "supported" and inline == "supported":
        return {"strategy": "single_call_continuous", "reason": "INLINE_INSTRUCTION_SUPPORTED",
                "emit_weights": False, "experimental": False, "degraded": False,
                "trajectory_realization": "single_call_implicit"}

    unverified = cap.UNVERIFIED_STATE in (cont, inline, single)
    if overlap == "supported":
        reason = "CAPABILITY_UNVERIFIED_FALLBACK" if unverified else "NO_INLINE_SUPPORT_FALLBACK_OVERLAP"
        return {"strategy": "overlap_context", "reason": reason,
                "emit_weights": False, "experimental": True, "degraded": False,
                "trajectory_realization": "overlap_approximation"}

    reason = ("CAPABILITY_UNVERIFIED_FALLBACK"
              if (unverified or overlap == cap.UNVERIFIED_STATE)
              else "NO_CONTEXT_SUPPORT_LAST_RESORT")
    return {"strategy": "hard_join", "reason": reason,
            "emit_weights": False, "experimental": False, "degraded": True,
            "trajectory_realization": "none"}


def build_transition_plan(event, selection) -> dict:
    """감정 전환 이벤트 하나 → 궤적 계획. 가중치는 엔진이 실제로 받아들일 때만 방출한다."""
    immediate = event["transition_mode"] == "immediate"
    steps = EMOTION_TRAJECTORY_IMMEDIATE_STEPS if immediate else EMOTION_TRAJECTORY_STEPS
    duration = int(event["transition_duration_hint"])

    if immediate:
        realization = "immediate"
    else:
        realization = selection["trajectory_realization"]

    weights = None
    if selection["emit_weights"]:
        n = len(steps)
        per = duration // n if n else 0
        weights = []
        for k, (prev_pct, new_pct) in enumerate(steps):
            weights.append({"step": k, "prev_pct": prev_pct, "new_pct": new_pct,
                            "offset_ms": per * k, "duration_ms": per})

    return {
        "target_emotion": event["target_emotion"],
        "transition_mode": event["transition_mode"],
        "transition_duration_ms": duration,
        "extra_pause_ms": int(event["extra_pause_ms"]),
        "is_chunk_boundary": bool(event["is_chunk_boundary"]),  # 계약값 그대로 — 재유도 금지
        "target_trajectory": [list(s) for s in steps],
        "weights": weights,
        "weights_emitted": weights is not None,
        "trajectory_realization": realization,
        "degraded": bool(selection["degraded"] and not immediate),
        "source_start_cp": event["source_range"]["start_codepoint"],
        "source_end_cp": event["source_range"]["end_codepoint"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# 10. 청크 텍스트 조립
# ─────────────────────────────────────────────────────────────────────────────

def _prosody_is_native(profile, kind) -> bool:
    return profile.prosody_is_native(kind)


def _build_chunk_text(timeline, node_start, node_end, profile):
    """청크에 들어갈 (generation_text, source_text, inline_instructions, laugh_marks, ...).

    · 웃음 토큰은 **절대** generation_text 에 들어가지 않는다(음절 렌더링 금지).
    · 국소 운율(구두점) 토큰은 capability 와 무관하게 **항상 원문 그대로 남긴다.**
      구두점은 모델이 읽는 평범한 글자이기도 하므로 빼면 오히려 낭독이 나빠진다.
      capability 가 가르는 것은 '표현 증폭분' 을 네이티브로 실현하느냐 후처리로 근사하느냐이며,
      그 판정은 punctuation_plan 에 따로 기록한다(글자를 버리는 일은 없다).
    · 감정 지시는 텍스트에 주입하지 않는다 — 엔진별 문법을 계획기가 알 수 없으므로 오프셋만 남긴다.
    """
    nodes = timeline["nodes"]
    lps = timeline["local_prosody"]
    ets = timeline["emotion_transitions"]

    gen = []
    src = []
    gen_len = 0
    inline_instructions = []
    laugh_marks = []
    kept_prosody = []
    dropped_prosody = []

    for i in range(node_start, node_end):
        nd = nodes[i]
        src.append(nd["raw_token"])
        kind = nd["kind"]
        if kind == "text":
            gen.append(nd["text"])
            gen_len += len(nd["text"])
        elif kind == "lineBreak":
            gen.append("\n")
            gen_len += 1
        elif kind == "emotionTransition":
            et = ets[nd["event_index"]]
            inline_instructions.append({
                "event_index": nd["event_index"], "node_index": i,
                "at_char": gen_len, "emotion_id": et["target_emotion"],
                "transition_mode": et["transition_mode"],
            })
        elif kind == "localProsody":
            lp = lps[nd["event_index"]]
            # 원문 토큰은 capability 와 무관하게 항상 남긴다(provenance 보존, 글자 삭제 없음).
            # '?!' 처럼 계약이 하나의 shock_rise 로 묶은 토큰도 원문 순서 그대로 들어간다.
            gen.append(nd["raw_token"])
            gen_len += len(nd["raw_token"])
            if _prosody_is_native(profile, lp["kind"]):
                kept_prosody.append(nd["event_index"])
            else:
                dropped_prosody.append(nd["event_index"])
        elif kind == "nonverbalLaugh":
            laugh_marks.append({"event_index": nd["event_index"], "node_index": i, "at_char": gen_len})
        # explicitPause 는 항상 청크 경계이므로 청크 안에 들어오지 않는다.

    return ("".join(gen), "".join(src), inline_instructions, laugh_marks,
            kept_prosody, dropped_prosody)


# ─────────────────────────────────────────────────────────────────────────────
# 11. 청크 묶기
# ─────────────────────────────────────────────────────────────────────────────

def _merge_blocker(group_units, unit, prev_unit, selection, settings) -> Optional[str]:
    """현재 그룹에 unit 을 더 담을 수 없는 '구조적' 사유(토큰 상한 제외). 없으면 None."""
    if unit["paragraph_index"] != prev_unit["paragraph_index"]:
        return "PARAGRAPH_BREAK"
    if prev_unit["terminator_is_long"]:
        return "LONG_TERMINAL"
    if unit["entry_emotion_id"] != prev_unit["exit_emotion_id"]:
        # 감정 태그 자체가 분할점인 게 아니라, 엔진이 한 호출 안에서 전환을 못 해서 생기는 경계다.
        if selection["strategy"] == "overlap_context":
            return "EMOTION_STRATEGY_OVERLAP"
        if selection["strategy"] == "hard_join":
            return "EMOTION_STRATEGY_HARD_JOIN"
    if len(group_units) >= settings.sentence_group_max:
        return "SENTENCE_GROUP_MAX"
    return None


def _group_units(timeline, units, selection, settings, profile, count_tokens):
    """문장 단위 → 청크 그룹. 각 그룹은 (units, end_reason, end_detail)."""
    max_tokens = settings.effective_max_tokens()
    groups = []
    cur: List[dict] = []

    def group_tokens(cand):
        text, _s, _i, _l, _k, _d = _build_chunk_text(
            timeline, cand[0]["node_start"], cand[-1]["node_end"], profile)
        return count_tokens(text)

    for u in units:
        if not cur:
            cur = [u]
            continue
        blocker = _merge_blocker(cur, u, cur[-1], selection, settings)
        if blocker is not None:
            groups.append((cur, blocker, _end_detail(blocker, cur[-1], None, None)))
            cur = [u]
            continue
        cand = cur + [u]
        tok = group_tokens(cand)
        if tok > max_tokens:
            # 생성 상한. 여기서 상한을 올리거나 쉼표로 다시 쪼개는 일은 하지 않는다.
            groups.append((cur, "GENERATION_LIMIT", _end_detail("GENERATION_LIMIT", cur[-1], tok, max_tokens)))
            cur = [u]
            continue
        cur = cand

    if cur:
        groups.append((cur, "END_OF_INPUT", _end_detail("END_OF_INPUT", cur[-1], None, None)))
    return groups


def _end_detail(reason, last_unit, tok, max_tokens) -> dict:
    term = last_unit["terminator"] or {}
    detail = {"trigger": term.get("trigger"), "prosody_kind": term.get("kind")}
    if reason == "LONG_TERMINAL":
        detail["duration_hint_ms"] = term.get("duration_hint")
        detail["pause_ms"] = term.get("pause_ms")
        detail["threshold_ms"] = LONG_TERMINAL_MIN_DURATION_MS
    elif reason == "GENERATION_LIMIT":
        detail["would_be_tokens"] = tok
        detail["max_tokens"] = max_tokens
        detail["limit_raised"] = False
    elif reason == "SENTENCE_GROUP_MAX":
        detail["sentence_group_max"] = None  # 아래에서 채운다
    return detail


def _gap_for(reason, last_unit) -> Tuple[Optional[int], str, Optional[str]]:
    """청크 종료 사유 + 마지막 단위의 종결 → (다음 청크 앞 무음 ms, 무음 출처, 문장 간격 실현)."""
    term = last_unit["terminator"] or {}
    trigger = term.get("trigger")
    if reason == "END_OF_INPUT":
        return None, "none", None
    if trigger == "explicit_pause":
        return int(term.get("pause_ms") or 0), "explicit_pause", "inserted_silence"
    if reason == "PARAGRAPH_BREAK":
        return None, "paragraph_gap", "inserted_silence"   # 길이는 런타임 config 소관
    return None, "sentence_gap", "inserted_silence"


# ─────────────────────────────────────────────────────────────────────────────
# 12. 계획 조립
# ─────────────────────────────────────────────────────────────────────────────

def _short_hash(*parts) -> str:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return h[:16]


def _chunk_seed(settings, index) -> Optional[int]:
    if settings.seed_policy == "fixed":
        return settings.seed_value
    if settings.seed_policy == "per_chunk_derived":
        return settings.seed_value + index
    return None


def build_plan(timeline, settings: GenerationSettings, profile: cap.CapabilityProfile,
               count_tokens: Callable[[str], int]) -> dict:
    """표현형 타임라인 → 생성 계획.

    timeline : parse_expressive_timeline(...)['timeline'] (ok=True 인 결과).
    settings : 계획 전체에 고정되는 조건.
    profile  : 엔진 capability 판정(실제 엔진 없이는 전부 UNVERIFIED 가 정직한 값).
    count_tokens : production token 계수기(주입). 계획기는 토크나이저를 직접 만들지 않는다.
    """
    if not isinstance(timeline, dict) or "nodes" not in timeline:
        raise PlanError("timeline dict required")
    if not callable(count_tokens):
        raise PlanError("count_tokens callable required")
    if not isinstance(profile, cap.CapabilityProfile):
        raise PlanError("CapabilityProfile required")

    degradations: List[dict] = []
    unsupported: List[dict] = []

    selection = select_emotion_strategy(profile)
    if selection["strategy"] == "hard_join":
        degradations.append({"code": "EMOTION_HARD_JOIN", "scope": "plan", "index": None,
                             "detail": {"reason": selection["reason"]}})
    elif selection["strategy"] == "overlap_context":
        degradations.append({"code": "EMOTION_OVERLAP_EXPERIMENTAL", "scope": "plan", "index": None,
                             "detail": {"reason": selection["reason"],
                                        "overlap_ms": int(settings.overlap_context_ms)}})
    if selection["reason"] == "CAPABILITY_UNVERIFIED_FALLBACK":
        degradations.append({"code": "CAPABILITY_UNVERIFIED", "scope": "plan", "index": None,
                             "detail": {"features": list(profile.unverified_features())}})

    if settings.reference_mode == "x_vector_only":
        degradations.append({"code": "REFERENCE_X_VECTOR_ONLY", "scope": "plan", "index": None,
                             "detail": {"reference_transcript_used": False}})
    if settings.seed_policy == "random":
        degradations.append({"code": "NON_DETERMINISTIC_SEED", "scope": "plan", "index": None,
                             "detail": {"seed_policy": settings.seed_policy}})

    units, leading_pause_ms = extract_sentence_units(timeline)
    groups = _group_units(timeline, units, selection, settings, profile, count_tokens)

    emotion_track_id = _short_hash(timeline["full_sha256"], "emotion")
    context_chain_id = _short_hash(timeline["full_sha256"], settings.settings_id, profile.engine_id)
    max_tokens = settings.effective_max_tokens()

    ets = timeline["emotion_transitions"]
    lps = timeline["local_prosody"]
    laughs = timeline["laughs"]

    chunks: List[dict] = []
    event_to_chunk = {}
    laugh_to_chunk = {}
    prev_context_id = "start"
    pending_gap_ms = leading_pause_ms if leading_pause_ms > 0 else None
    pending_gap_source = "explicit_pause" if leading_pause_ms > 0 else "none"

    for ci, (gunits, end_reason, end_detail) in enumerate(groups):
        node_start = gunits[0]["node_start"]
        node_end = gunits[-1]["node_end"]
        (gen_text, src_text, inline_instructions, laugh_marks,
         kept_prosody, dropped_prosody) = _build_chunk_text(timeline, node_start, node_end, profile)

        if end_reason == "SENTENCE_GROUP_MAX":
            end_detail = dict(end_detail, sentence_group_max=settings.sentence_group_max)

        prod_tokens = int(count_tokens(gen_text))
        gen_limit = (generation_limit.compute_max_new_tokens(prod_tokens) if prod_tokens > 0 else None)
        oversized = prod_tokens > max_tokens
        if oversized:
            unsupported.append({
                "code": "UNIT_EXCEEDS_GENERATION_LIMIT", "scope": "chunk", "index": ci,
                "detail": {"prod_tokens": prod_tokens, "max_tokens": max_tokens,
                           "sentence_count": len(gunits), "limit_raised": False,
                           "comma_split_used": False},
            })

        # 청크 '안' 에서 일어나는 감정 전환 = 문장 중간 전환 + 두 번째 문장부터의 진입 전환.
        # (첫 문장의 진입 전환은 청크 경계에서 일어난 것이므로 entry_transition_plans 로 따로 남긴다.)
        internal = list(gunits[0]["internal_transitions"])
        for u in gunits[1:]:
            internal.extend(t["event_index"] for t in u["entry_transitions"])
            internal.extend(u["internal_transitions"])
        internal.sort()
        transitions = []
        for eidx in internal:
            tp = build_transition_plan(ets[eidx], selection)
            tp["event_index"] = eidx
            if selection["strategy"] != "single_call_continuous":
                tp["deferred"] = True
                tp["trajectory_realization"] = "none"
                degradations.append({
                    "code": "MID_UNIT_EMOTION_TRANSITION_DEFERRED", "scope": "event", "index": eidx,
                    "detail": {"chunk_index": ci, "strategy": selection["strategy"]},
                })
            else:
                tp["deferred"] = False
            tp["at_chunk_start"] = False
            transitions.append(tp)

        for eidx in kept_prosody + dropped_prosody:
            event_to_chunk[eidx] = ci
        for m in laugh_marks:
            laugh_to_chunk[m["event_index"]] = ci

        # 청크 경계에서 일어난 전환(첫 문장 진입) — 궤적 정보를 통합 담당자가 볼 수 있게 남긴다.
        entry_transition_plans = []
        for t in gunits[0]["entry_transitions"]:
            tp = build_transition_plan(ets[t["event_index"]], selection)
            tp["event_index"] = t["event_index"]
            tp["at_chunk_start"] = True
            tp["deferred"] = False
            entry_transition_plans.append(tp)

        gap_ms, gap_source, gap_realization = _gap_for(end_reason, gunits[-1])

        # 문장 간 줄바꿈이 청크 '안' 에 남아 있으면 모델이 자연스럽게 쉬어야 한다(무음 삽입 아님).
        internal_line_breaks = sum(
            1 for i in range(node_start, node_end) if timeline["nodes"][i]["kind"] == "lineBreak")

        preceding_context = {
            "preceding_context_id": prev_context_id,
            "overlap_source_chunk": (ci - 1) if (ci > 0 and selection["strategy"] == "overlap_context") else None,
            "overlap_ms": (int(settings.overlap_context_ms)
                           if (ci > 0 and selection["strategy"] == "overlap_context") else 0),
            "overlap_text_tail_chars": (OVERLAP_CONTEXT_TAIL_CHARS
                                        if (ci > 0 and selection["strategy"] == "overlap_context") else 0),
            "carried_emotion_id": gunits[0]["entry_emotion_id"],
            "experimental": selection["strategy"] == "overlap_context" and ci > 0,
        }
        context_id = _short_hash(context_chain_id, ci, gunits[-1]["exit_emotion_id"])

        chunk = {
            "index": ci,
            "node_start": node_start,
            "node_end": node_end,
            "unit_indices": [u["index"] for u in gunits],
            "sentence_count": len(gunits),
            "paragraph_index": gunits[0]["paragraph_index"],
            "line_index_start": gunits[0]["line_index_start"],
            "line_index_end": gunits[-1]["line_index_end"],
            "generation_text": gen_text,
            "source_text": src_text,
            "inline_emotion_instructions": inline_instructions,
            "laugh_marks": laugh_marks,
            "native_prosody_events": kept_prosody,
            "non_native_prosody_events": dropped_prosody,
            "internal_line_breaks": internal_line_breaks,
            "sentence_gap_realization": ("in_call_natural" if internal_line_breaks > 0 else None),
            "entry_emotion_id": gunits[0]["entry_emotion_id"],
            "exit_emotion_id": gunits[-1]["exit_emotion_id"],
            "entry_transitions": list(gunits[0]["entry_transitions"]),
            "entry_transition_plans": entry_transition_plans,
            "emotion_transitions": transitions,
            "leading_gap_ms": pending_gap_ms,
            "leading_gap_source": pending_gap_source,
            "trailing_gap_ms": gap_ms,
            "trailing_gap_source": gap_source,
            "trailing_gap_realization": gap_realization,
            "end_reason": end_reason,
            "end_reason_detail": end_detail,
            "prod_tokens": prod_tokens,
            "max_tokens": max_tokens,
            "generation_limit": gen_limit,
            "generation_limit_raised": False,
            "oversized": oversized,
            "retry_policy": RETRY_POLICY,
            "preceding_context": preceding_context,
            "context_id": context_id,
            "continuity": {
                "reference_clip_id": settings.reference_clip_id,
                "reference_transcript_id": settings.reference_transcript_id,
                "reference_mode": settings.reference_mode,
                "speaker_id": settings.speaker_id,
                "language": settings.language,
                "generation_settings_id": settings.settings_id,
                "seed_policy": settings.seed_policy,
                "emotion_track_id": emotion_track_id,
                "context_chain_id": context_chain_id,
                "preceding_context_id": prev_context_id,
                "entry_emotion_id": gunits[0]["entry_emotion_id"],
                "seed_value": _chunk_seed(settings, ci),
            },
            "degraded": bool(selection["degraded"] and ci > 0),
        }

        # 하드 계약: 웃음은 절대 글자로 나가지 않는다.
        for m in laugh_marks:
            token = laughs[m["event_index"]]["raw_token"]
            if token and token in gen_text:
                raise PlanError("laugh token leaked into generation text")

        chunks.append(chunk)
        prev_context_id = context_id
        pending_gap_ms = gap_ms
        pending_gap_source = gap_source

    punctuation_plan = _build_punctuation_plan(lps, profile, event_to_chunk, degradations, unsupported)
    laugh_manifest = _build_laugh_manifest(timeline, units, profile, laugh_to_chunk,
                                           degradations, unsupported)

    blocking = [u for u in unsupported if u["code"] in BLOCKING_UNSUPPORTED_CODES]
    degraded = bool(degradations)

    plan = {
        "plan_version": PLAN_VERSION,
        "contract_version": timeline["contract_version"],
        "mode": timeline["mode"],
        "effective_version": timeline["effective_version"],
        "engine_id": profile.engine_id,
        "capability": cap.profile_to_record(profile),
        "emotion_strategy": {
            "strategy": selection["strategy"],
            "reason": selection["reason"],
            "weights_emitted": selection["emit_weights"],
            "experimental": selection["experimental"],
            "degraded": selection["degraded"],
            "trajectory_realization": selection["trajectory_realization"],
            "target_trajectory": [list(s) for s in EMOTION_TRAJECTORY_STEPS],
            "overlap_ms": (int(settings.overlap_context_ms)
                           if selection["strategy"] == "overlap_context" else 0),
        },
        "chunks": chunks,
        "sentence_units": units,
        "punctuation_plan": punctuation_plan,
        "laugh_manifest": laugh_manifest,
        "asr_parity": {
            "compare_laughter_as_words": False,
            "verify_laugh_position": True,
            "verify_laugh_presence": True,
            "excluded_ranges": [
                {"event_index": m["event_index"],
                 "start_cp": laughs[m["event_index"]]["source_range"]["start_codepoint"],
                 "end_cp": laughs[m["event_index"]]["source_range"]["end_codepoint"]}
                for c in chunks for m in c["laugh_marks"]
            ],
        },
        "continuity": {
            "reference_clip_id": settings.reference_clip_id,
            "reference_transcript_id": settings.reference_transcript_id,
            "reference_mode": settings.reference_mode,
            "reference_degraded": settings.reference_mode == "x_vector_only",
            "speaker_id": settings.speaker_id,
            "language": settings.language,
            "generation_settings_id": settings.settings_id,
            "seed_policy": settings.seed_policy,
            "seed_base": settings.seed_value,
            "emotion_track_id": emotion_track_id,
            "context_chain_id": context_chain_id,
            "token_counter_id": settings.token_counter_id,
        },
        "leading_pause_ms": leading_pause_ms,
        "retry_policy": RETRY_POLICY,
        "generation_limit_raise_allowed": False,
        "max_tokens": max_tokens,
        "sentence_group_max": settings.sentence_group_max,
        "sentence_group_preferred_min": SENTENCE_GROUP_PREFERRED_MIN,
        "multi_sentence_grouping_verified": profile.is_supported("single_call_long_form"),
        "forbidden_split_reasons": list(FORBIDDEN_SPLIT_REASONS),
        "forbidden_post_process_ops": list(FORBIDDEN_POST_PROCESS_OPS),
        "degradations": degradations,
        "unsupported": unsupported,
        "blocking_issues": blocking,
        "degraded": degraded,
        "ok": len(blocking) == 0,
        "summary": {
            "chunk_count": len(chunks),
            "sentence_unit_count": len(units),
            "split_reason_counts": _count_reasons(chunks),
            "native_punctuation_count": sum(1 for p in punctuation_plan if p["realization"] == "model_native"),
            "post_process_punctuation_count": sum(1 for p in punctuation_plan if p["realization"] == "post_process"),
            "unsupported_punctuation_count": sum(1 for p in punctuation_plan if p["realization"] == "unsupported"),
            "laugh_count": len(laugh_manifest),
            "degradation_count": len(degradations),
            "unsupported_count": len(unsupported),
        },
    }
    return plan


def _count_reasons(chunks) -> dict:
    out = {r: 0 for r in SPLIT_REASON_CODES}
    for c in chunks:
        out[c["end_reason"]] = out.get(c["end_reason"], 0) + 1
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 13. 구두점 실현 계획
# ─────────────────────────────────────────────────────────────────────────────

def _build_punctuation_plan(local_prosody, profile, event_to_chunk, degradations, unsupported):
    """국소 운율(구두점) 이벤트마다 '모델 네이티브' vs '후처리' vs '미지원' 을 명시한다.

    두 실현 방식은 절대 섞이지 않는다(native_instruction 과 post_process 는 동시에 채워지지 않는다).
    후처리는 semantic_claim=False — 의미를 달성했다고 주장하지 않는다.
    """
    out = []
    for idx, lp in enumerate(local_prosody):
        kind = lp["kind"]
        chunk_index = event_to_chunk.get(idx)
        rec = {
            "event_index": idx,
            "chunk_index": chunk_index,
            "node_index": lp["node_index"],
            "line_index": lp["line_index"],
            "kind": kind,
            "raw_token": lp["raw_token"],
            "raw_count": lp["raw_count"],
            "effective_count": lp["effective_count"],
            "capped": lp["capped"],
            "strength": lp["strength"],
            "duration_hint": lp["duration_hint"],
            "scope_kind": lp["scope_kind"],
            "scope_start_cp": lp["scope_range"]["start_codepoint"],
            "scope_end_cp": lp["scope_range"]["end_codepoint"],
            "is_chunk_boundary": lp["is_chunk_boundary"],  # 계약값 그대로(항상 False)
            "capability_state": profile.prosody_state(kind),
            "realization": None,
            "native_instruction": None,
            "post_process": None,
            "semantic_claim": False,
            "unsupported_reason": None,
        }

        if kind == "vowel_extend":
            _plan_vowel_extend(rec, lp, profile, degradations, unsupported, idx)
            out.append(rec)
            continue

        if profile.prosody_is_native(kind):
            rec["realization"] = "model_native"
            rec["semantic_claim"] = True
            rec["native_instruction"] = {
                "kind": kind,
                "raw_token": lp["raw_token"],
                "strength": lp["strength"],
                "duration_hint": lp["duration_hint"],
                "effective_count": lp["effective_count"],
                "kept_in_generation_text": True,
            }
            out.append(rec)
            continue

        op = PROSODY_POST_PROCESS_OP.get(kind)
        ve = lp["vowel_extend"]
        if op is None:
            rec["realization"] = "unsupported"
            rec["unsupported_reason"] = "NO_POST_PROCESS_EQUIVALENT"
            unsupported.append({"code": "PROSODY_NO_REALIZATION", "scope": "event", "index": idx,
                                "detail": {"kind": kind, "capability_state": rec["capability_state"]}})
            out.append(rec)
            continue

        rec["realization"] = "post_process"
        rec["semantic_claim"] = False   # 후처리가 의미를 달성했다고 주장하지 않는다
        rec["post_process"] = {
            "op": op,
            "scope_kind": lp["scope_kind"],
            "scope_start_cp": lp["scope_range"]["start_codepoint"],
            "scope_end_cp": lp["scope_range"]["end_codepoint"],
            "strength": lp["strength"],
            "duration_ms": lp["duration_hint"],
            "target_vowel": None,
            "experimental": op in EXPERIMENTAL_POST_PROCESS_OPS,
            "applies_globally": False,   # 범위 한정 — 전역 처리 금지
        }
        degradations.append({"code": "PUNCTUATION_POST_PROCESS_ONLY", "scope": "event", "index": idx,
                             "detail": {"kind": kind, "op": op,
                                        "capability_state": rec["capability_state"]}})
        out.append(rec)
    return out


def _plan_vowel_extend(rec, lp, profile, degradations, unsupported, idx):
    """'~' 늘임 — 언어 3분류는 계약에서, 최종 지원/강등 판정은 expressive_capability 에서 소비한다.

    여기서 분류를 다시 유도하지 않는다. 받침 늘이기/반복은 어떤 경로로도 지시하지 않는다.
    """
    verdict = cap.resolve_vowel_extend_capability(lp["vowel_extend"], profile)
    rec["vowel_extend"] = verdict
    rec["capability_state"] = verdict["state"]

    if verdict["state"] == "supported":
        rec["realization"] = "model_native"
        rec["semantic_claim"] = True
        rec["native_instruction"] = {
            "kind": "vowel_extend",
            "raw_token": lp["raw_token"],
            "strength": lp["strength"],
            "duration_hint": lp["duration_hint"],
            "effective_count": lp["effective_count"],
            "kept_in_generation_text": True,
        }
        return

    if verdict["allowed_post_process"]:
        rec["realization"] = "post_process"
        rec["semantic_claim"] = False
        rec["post_process"] = {
            "op": "final_vowel_time_stretch",
            "scope_kind": lp["scope_kind"],
            "scope_start_cp": lp["scope_range"]["start_codepoint"],
            "scope_end_cp": lp["scope_range"]["end_codepoint"],
            "strength": lp["strength"],
            "duration_ms": lp["duration_hint"],
            "target_vowel": (lp["vowel_extend"] or {}).get("target_vowel"),
            "experimental": "final_vowel_time_stretch" in EXPERIMENTAL_POST_PROCESS_OPS,
            "applies_globally": False,
        }
        degradations.append({"code": "PUNCTUATION_POST_PROCESS_ONLY", "scope": "event", "index": idx,
                             "detail": {"kind": "vowel_extend", "op": "final_vowel_time_stretch",
                                        "classification": verdict["classification"],
                                        "capability_state": verdict["state"]}})
        return

    rec["realization"] = "unsupported"
    rec["unsupported_reason"] = verdict["reason"]
    code = ("VOWEL_EXTEND_NO_TARGET" if verdict["reason"] == "NO_TARGET"
            else "VOWEL_EXTEND_NOT_REALIZABLE")
    unsupported.append({"code": code, "scope": "event", "index": idx,
                        "detail": {"classification": verdict["classification"],
                                   "classification_source": verdict["classification_source"],
                                   "reason": verdict["reason"],
                                   "capability_state": verdict["state"]}})
    if verdict["classification"] == "non_sustainable_final":
        degradations.append({"code": "VOWEL_EXTEND_NON_SUSTAINABLE_FINAL", "scope": "event",
                             "index": idx, "detail": {"reason": verdict["reason"]}})


# ─────────────────────────────────────────────────────────────────────────────
# 14. 웃음 계획 / 이벤트 매니페스트
# ─────────────────────────────────────────────────────────────────────────────

def select_laugh_strategy(profile: cap.CapabilityProfile, cached_sample_available: bool = None) -> dict:
    """웃음 전략 A → B → C → D. 전부 불가하면 unsupported(조용히 버리지 않는다)."""
    if profile.is_supported("nonverbal_laugh_instruction"):
        return {"strategy": "model_native_instruction", "reason": "NATIVE_INSTRUCTION_SUPPORTED",
                "experimental": False, "degraded": False}
    if profile.is_supported("laugh_same_speaker_conditioning"):
        return {"strategy": "same_conditioning_candidate", "reason": "NO_NATIVE_FALLBACK_SAME_CONDITIONING",
                "experimental": False, "degraded": False}
    cached = (profile.is_supported("cached_laugh_sample") if cached_sample_available is None
              else bool(cached_sample_available) and profile.is_supported("cached_laugh_sample"))
    if cached:
        return {"strategy": "cached_sample", "reason": "NO_GENERATION_FALLBACK_CACHED_SAMPLE",
                "experimental": False, "degraded": True}
    if profile.is_supported("voice_conditioned_laugh_transform"):
        return {"strategy": "voice_conditioned_transform", "reason": "NO_CACHE_FALLBACK_VOICE_TRANSFORM",
                "experimental": True, "degraded": True}
    return {"strategy": None, "reason": "NO_STRATEGY_AVAILABLE",
            "experimental": False, "degraded": True}


def _build_laugh_manifest(timeline, units, profile, laugh_to_chunk, degradations, unsupported):
    laughs = timeline["laughs"]
    sel = select_laugh_strategy(profile)

    unit_by_node = {}
    for u in units:
        for n in range(u["node_start"], u["node_end"]):
            unit_by_node[n] = u

    manifest = []
    for idx, lg in enumerate(laughs):
        position = lg["position"]
        behaviour = LAUGH_POSITION_BEHAVIOURS[position]
        u = unit_by_node.get(lg["node_index"])
        if position == "trailing" and u is not None:
            carried = u["exit_emotion_id"]        # 문장 종결 감정에 연결하고 자연 감쇠
        elif u is not None:
            carried = u["entry_emotion_id"]
        else:
            carried = "default"

        duration = int(lg["duration_hint"])
        if position == "inline":
            duration = min(duration, LAUGH_INLINE_MAX_MS)   # 인라인은 '짧은' 웃음

        rec = {
            "event_index": idx,
            "chunk_index": laugh_to_chunk.get(idx),
            "node_index": lg["node_index"],
            "line_index": lg["line_index"],
            "event_kind": LAUGH_EVENT_KIND,
            "style": lg["style"],
            "position": position,
            "position_behaviour": behaviour,
            "intensity": lg["intensity"],
            "brightness": lg["brightness"],
            "duration_hint": duration,
            "raw_repeat_count": lg["raw_repeat_count"],
            "effective_repeat_count": lg["effective_repeat_count"],
            "capped": lg["capped"],
            "strategy": sel["strategy"],
            "strategy_reason": sel["reason"],
            "experimental": sel["experimental"],
            "degraded": sel["degraded"],
            "never_literal_text": True,
            "asr_compare_as_words": False,
            "verify_position": True,
            "verify_presence": True,
            "join_policy": LAUGH_JOIN_POLICY,
            "required_checks": list(LAUGH_REQUIRED_CHECKS),
            "optional_overlap_blend_ms": LAUGH_OPTIONAL_OVERLAP_BLEND_MS,
            "gap_ms": 0,                       # 웃음 주변에 무음을 끼워 넣지 않는다
            "carried_emotion_id": carried,
            "source_start_cp": lg["source_range"]["start_codepoint"],
            "source_end_cp": lg["source_range"]["end_codepoint"],
        }
        assert tuple(rec.keys()) == LAUGH_MANIFEST_FIELDS
        manifest.append(rec)

        if sel["strategy"] is None:
            unsupported.append({"code": "LAUGH_NO_STRATEGY", "scope": "event", "index": idx,
                                "detail": {"position": position, "style": lg["style"]}})
        elif sel["strategy"] == "cached_sample":
            degradations.append({"code": "LAUGH_CACHED_SAMPLE", "scope": "event", "index": idx,
                                 "detail": {"position": position}})
        elif sel["strategy"] == "voice_conditioned_transform":
            degradations.append({"code": "LAUGH_VOICE_TRANSFORM_EXPERIMENTAL", "scope": "event",
                                 "index": idx, "detail": {"position": position}})
    return manifest


# ─────────────────────────────────────────────────────────────────────────────
# 15. 연속성 검증기
# ─────────────────────────────────────────────────────────────────────────────

def validate_plan_continuity(plan) -> dict:
    """계획이 연속성 일관적임을 증명한다. 어긋나면 '처음 어긋난 필드' 를 이름으로 지목한다.

    검사 순서는 CONTINUITY_FIELD_ORDER 고정 순서다(결정적 보고).
    x-vector-only 강등은 명시적으로 드러난다 — 조용히 넘어가는 경로가 없다.
    """
    chunks = plan.get("chunks") or []
    divergences: List[dict] = []
    base = plan.get("continuity") or {}

    if not chunks:
        return {"ok": True, "first_divergent_field": None, "first_divergent_chunk_index": None,
                "divergences": [], "reference_degraded": bool(base.get("reference_degraded")),
                "checked_fields": list(CONTINUITY_FIELD_ORDER)}

    first = chunks[0]["continuity"]

    for field in CONTINUITY_IDENTICAL_FIELDS:
        for c in chunks:
            cont = c.get("continuity") or {}
            if field not in cont:
                divergences.append({"field": field, "chunk_index": c["index"],
                                    "code": "EMOTION_STATE_MISSING" if field == "emotion_track_id"
                                    else "IDENTICAL_FIELD_DIVERGED",
                                    "expected": first.get(field), "actual": None})
                continue
            if cont[field] != first.get(field):
                divergences.append({"field": field, "chunk_index": c["index"],
                                    "code": "IDENTICAL_FIELD_DIVERGED",
                                    "expected": first.get(field), "actual": cont[field]})

    # preceding_context_id — 사슬이 이어져야 한다.
    expected_prev = "start"
    for c in chunks:
        cont = c.get("continuity") or {}
        if cont.get("preceding_context_id") != expected_prev:
            divergences.append({"field": "preceding_context_id", "chunk_index": c["index"],
                                "code": "CONTEXT_CHAIN_BROKEN",
                                "expected": expected_prev, "actual": cont.get("preceding_context_id")})
        expected_prev = c.get("context_id")

    # entry_emotion_id — 존재해야 하고, 경계 전환이 없다면 앞 청크의 종료 감정과 이어져야 한다.
    # 경계에 감정 태그가 있으면(entry_transitions) 값이 달라지는 것이 '정상' 이다 —
    # 그 경우 마지막 전환의 target 과 일치하는지 본다.
    prev_exit = None
    for c in chunks:
        cont = c.get("continuity") or {}
        entry = cont.get("entry_emotion_id")
        entry_ts = c.get("entry_transitions") or []
        if entry is None or entry == "":
            divergences.append({"field": "entry_emotion_id", "chunk_index": c["index"],
                                "code": "EMOTION_STATE_MISSING", "expected": None, "actual": entry})
        elif entry_ts:
            want = entry_ts[-1]["target_emotion"]
            if entry != want:
                divergences.append({"field": "entry_emotion_id", "chunk_index": c["index"],
                                    "code": "EMOTION_STATE_BROKEN",
                                    "expected": want, "actual": entry})
        elif prev_exit is not None and entry != prev_exit:
            divergences.append({"field": "entry_emotion_id", "chunk_index": c["index"],
                                "code": "EMOTION_STATE_BROKEN",
                                "expected": prev_exit, "actual": entry})
        prev_exit = c.get("exit_emotion_id")

    # seed_value — seed_policy 가 정한 값이어야 한다.
    policy = base.get("seed_policy")
    seed_base = base.get("seed_base")
    for c in chunks:
        cont = c.get("continuity") or {}
        got = cont.get("seed_value")
        if policy == "fixed":
            want = seed_base
        elif policy == "per_chunk_derived":
            want = None if seed_base is None else seed_base + c["index"]
        else:
            want = None
        if got != want:
            divergences.append({"field": "seed_value", "chunk_index": c["index"],
                                "code": "SEED_POLICY_VIOLATED", "expected": want, "actual": got})

    first_field = None
    first_index = None
    if divergences:
        order = {f: i for i, f in enumerate(CONTINUITY_FIELD_ORDER)}
        divergences.sort(key=lambda d: (order.get(d["field"], 999), d["chunk_index"]))
        first_field = divergences[0]["field"]
        first_index = divergences[0]["chunk_index"]

    return {
        "ok": not divergences,
        "first_divergent_field": first_field,
        "first_divergent_chunk_index": first_index,
        "divergences": divergences,
        "reference_degraded": bool(base.get("reference_degraded")),
        "checked_fields": list(CONTINUITY_FIELD_ORDER),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 16. 안전 점검(금지 항목이 계획에 없음을 증명)
# ─────────────────────────────────────────────────────────────────────────────

def audit_forbidden(plan) -> dict:
    """계획이 금지 항목을 하나도 지시하지 않는지 감사한다. 위반 목록을 돌려준다(판정은 호출부)."""
    violations = []
    for c in plan.get("chunks") or []:
        if c["end_reason"] in FORBIDDEN_SPLIT_REASONS:
            violations.append({"kind": "split_reason", "chunk_index": c["index"], "value": c["end_reason"]})
        if c["end_reason"] not in SPLIT_REASON_CODES:
            violations.append({"kind": "unknown_split_reason", "chunk_index": c["index"],
                               "value": c["end_reason"]})
        if c.get("generation_limit_raised"):
            violations.append({"kind": "generation_limit_raised", "chunk_index": c["index"], "value": True})
        if c.get("retry_policy") != RETRY_POLICY:
            violations.append({"kind": "retry_policy", "chunk_index": c["index"],
                               "value": c.get("retry_policy")})
    for p in plan.get("punctuation_plan") or []:
        pp = p.get("post_process")
        if pp is not None:
            if pp["op"] in FORBIDDEN_POST_PROCESS_OPS or pp["op"] not in POST_PROCESS_OPS:
                violations.append({"kind": "post_process_op", "event_index": p["event_index"],
                                   "value": pp["op"]})
            if pp.get("applies_globally"):
                violations.append({"kind": "global_post_process", "event_index": p["event_index"],
                                   "value": pp["op"]})
            if p.get("native_instruction") is not None:
                violations.append({"kind": "native_and_post_process_mixed",
                                   "event_index": p["event_index"], "value": pp["op"]})
            if p.get("semantic_claim"):
                violations.append({"kind": "post_process_semantic_claim",
                                   "event_index": p["event_index"], "value": pp["op"]})
    for m in plan.get("laugh_manifest") or []:
        if not m["never_literal_text"]:
            violations.append({"kind": "laugh_literal_text", "event_index": m["event_index"], "value": True})
        if m["asr_compare_as_words"]:
            violations.append({"kind": "laugh_asr_word_compare", "event_index": m["event_index"], "value": True})
        if m["join_policy"] != LAUGH_JOIN_POLICY:
            violations.append({"kind": "laugh_join_policy", "event_index": m["event_index"],
                               "value": m["join_policy"]})
    if plan.get("generation_limit_raise_allowed"):
        violations.append({"kind": "generation_limit_raise_allowed", "value": True})
    if plan.get("retry_policy") != RETRY_POLICY:
        violations.append({"kind": "retry_policy", "value": plan.get("retry_policy")})
    return {"ok": not violations, "violations": violations}


# ─────────────────────────────────────────────────────────────────────────────
# 17. 편의 진입점
# ─────────────────────────────────────────────────────────────────────────────

def plan_from_raw(raw, settings: GenerationSettings, profile: cap.CapabilityProfile,
                  count_tokens: Callable[[str], int], mode="expressive_v3",
                  resolve_emotion=None) -> dict:
    """원문 → (계약 파서) → 계획. 파서가 실패하면 계획을 만들지 않고 에러를 그대로 돌려준다."""
    parsed = ex.parse_expressive_timeline(raw, mode=mode, resolve_emotion=resolve_emotion)
    if not parsed["ok"]:
        return {"ok": False, "plan": None, "errors": parsed["errors"],
                "mode": parsed["mode"], "effective_version": parsed["effective_version"]}
    plan = build_plan(parsed["timeline"], settings, profile, count_tokens)
    return {"ok": plan["ok"], "plan": plan, "errors": [],
            "mode": parsed["mode"], "effective_version": parsed["effective_version"]}
