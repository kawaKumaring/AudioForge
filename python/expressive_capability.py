# -*- coding: utf-8 -*-
"""표현형 운율 ENGINE — 엔진 capability 선언/프로브 계약 (순수, stdlib only).

이 모듈은 **모델을 로드하지 않고, GPU 를 만지지 않고, 어떤 프로덕션 워커도 import 하지 않는다.**
하는 일은 하나뿐이다 — "이 엔진이 무엇을 실제로 할 수 있는가"를 **정직하게** 한 곳에서 결정한다.

핵심 규칙(전부 테스트로 고정):
  1. 선언(claim)은 **상한**일 뿐이다. 선언만으로는 절대 'supported' 가 되지 않는다.
     실제 프로브 증거(ProbeEvidence)가 없으면 상태는 'unknown'(=UNVERIFIED)이며,
     호출부는 이를 '지원됨'으로 취급해서는 안 된다(is_usable 는 'supported' 에만 True).
  2. 엔진이 스스로 'unsupported' 라고 선언하면 그대로 믿는다(보수적 방향의 선언은 신뢰).
  3. 프로브가 입력을 받아들였지만(accepted) 효과가 관측되지 않으면(honored=False) 'degraded' 다.
     "받아들여졌으니 됐다"는 성공으로 보고하지 않는다.
  4. 결과 레코드는 짧은 안전 토큰(enum 값)만 담는다 — 경로/대사/참조 전사/자유 텍스트 금지.

계약 소비: 국소 운율 종류(LOCAL_PROSODY_KINDS)는 expressive_timeline 에서 **import** 한다.
값을 복사하지 않는다(드리프트 금지).
"""
from dataclasses import dataclass, field
from typing import Dict, Mapping, Optional, Sequence, Tuple

import expressive_timeline as ex

CAPABILITY_CONTRACT_VERSION = 1

# ─────────────────────────────────────────────────────────────────────────────
# 1. 상태 / 기능 enum
# ─────────────────────────────────────────────────────────────────────────────

# 'unknown' 은 "실제 엔진 없이는 판정 불가(UNVERIFIED)" 를 뜻한다 — 성공이 아니다.
CAPABILITY_STATES = ("supported", "degraded", "unsupported", "unknown")
UNVERIFIED_STATE = "unknown"

# 순위 비교는 판정 가능한 3 상태에서만 정의된다('unknown' 은 순위가 없다).
CAPABILITY_STATE_RANK = {"unsupported": 0, "degraded": 1, "supported": 2}

CAPABILITY_FEATURES = (
    "single_call_long_form",              # 여러 문장을 한 번의 호출로 생성
    "continuous_emotion_weights",         # 한 호출 안에서 시간축 감정 가중치(연속 blend)
    "emotion_instruction_text",           # 한 호출 안의 인라인 감정/지시 텍스트
    "context_overlap_conditioning",       # 앞 문맥(오디오/텍스트) 겹침 조건화
    "punctuation_native_instruction",     # 구두점 억양을 모델이 직접 해석
    "nonverbal_laugh_instruction",        # 모델 네이티브 비언어 웃음 지시
    "laugh_same_speaker_conditioning",    # 동일 화자 조건에서 웃음 후보 생성
    "cached_laugh_sample",                # 사용자가 고른 캐시 웃음 샘플 사용 가능
    "voice_conditioned_laugh_transform",  # 목소리 조건 웃음 생성/변환(실험적)
    "reference_transcript_icl",           # 참조 전사 기반 ICL(아니면 x-vector-only)
    "deterministic_seed",                 # 동일 seed 로 동일 출력
    "vowel_extend_sustainable_final",     # 받침 ㅇ/ㄴ/ㅁ/ㄹ 늘임을 이 엔진이 실제로 해내는가
    # 감정별 참조 클립으로 감정 음향이 실제로 실현되는가. 판정 주체는 emotion_acoustic.py 다.
    # ⚠️ 같은 참조를 쓰면 모델 입력이 동일하므로 이 기능은 구조적으로 degraded 다(태그만 붙는다).
    "emotion_reference_acoustic",
    # ── PHASE E3 에서 감사한 축 ────────────────────────────────────────────
    "f0_contour_input",                   # 시간축 F0 곡선을 모델에 직접 넣을 수 있는가
    "duration_pause_control",             # 길이·쉼을 모델 인자로 지시할 수 있는가
    "speaker_clone_with_emotion_control", # 사용자 목소리 복제와 감정 지시를 **동시에**
)

CAPABILITY_RESOLUTION_REASONS = (
    "probe_confirmed",              # 프로브가 효과까지 확인 → supported
    "probe_not_honored",            # 입력은 받았지만 효과 없음 → degraded
    "probe_rejected",               # 입력 자체를 거부 → unsupported
    "probe_absent",                 # 프로브 없음 → unknown(UNVERIFIED)
    "engine_declared_unsupported",  # 엔진이 스스로 못 한다고 선언
    "claim_caps_evidence",          # 증거보다 선언이 더 낮아 선언이 상한으로 작동
)


class CapabilityContractError(ValueError):
    """capability 입력 계약 위반(알 수 없는 기능명/상태값 등). 메시지엔 enum 토큰만 담는다."""


class CapabilityHonestyError(AssertionError):
    """'지원됨' 으로 보고하려 한 기능이 실제로는 supported 가 아님 — 가짜 성공 차단."""


# ─────────────────────────────────────────────────────────────────────────────
# 2. 프로브 증거
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ProbeEvidence:
    """한 기능에 대한 프로브 결과. 오디오/텍스트/경로를 담지 않는다.

    attempted : 프로브를 실제로 실행했는가. False 면 어떤 결론도 내지 않는다(unknown).
    accepted  : 엔진이 입력(가중치/지시/문맥)을 오류 없이 받아들였는가.
    honored   : 요청한 효과가 관측 가능한 형태로 반영되었는가.
                accepted=True, honored=False 는 "무시당했다" 이며 degraded 다.
    """

    feature: str
    attempted: bool = False
    accepted: bool = False
    honored: bool = False

    def __post_init__(self):
        if self.feature not in CAPABILITY_FEATURES and self.feature not in ex.LOCAL_PROSODY_KINDS:
            raise CapabilityContractError("unknown probe target: %s" % self.feature)


def evidence_state(evidence: Optional[ProbeEvidence]) -> str:
    """프로브 증거 → 상태. 증거 없음/미시도는 반드시 'unknown'."""
    if evidence is None or not evidence.attempted:
        return UNVERIFIED_STATE
    if not evidence.accepted:
        return "unsupported"
    if not evidence.honored:
        return "degraded"
    return "supported"


def _evidence_reason(evidence: Optional[ProbeEvidence]) -> str:
    st = evidence_state(evidence)
    if st == UNVERIFIED_STATE:
        return "probe_absent"
    if st == "unsupported":
        return "probe_rejected"
    if st == "degraded":
        return "probe_not_honored"
    return "probe_confirmed"


# ─────────────────────────────────────────────────────────────────────────────
# 3. 단일 기능 판정
# ─────────────────────────────────────────────────────────────────────────────

def _check_state(value: str) -> str:
    if value not in CAPABILITY_STATES:
        raise CapabilityContractError("unknown capability state: %s" % value)
    return value


def resolve_feature(feature: str, claim: Optional[str], evidence: Optional[ProbeEvidence]) -> dict:
    """선언 + 프로브 증거 → 최종 상태 레코드.

    선언은 상한이다. 선언만으로 상태가 올라가는 경로는 존재하지 않는다.
    """
    claimed = UNVERIFIED_STATE if claim is None else _check_state(claim)
    ev_state = evidence_state(evidence)

    if claimed == "unsupported":
        state, reason = "unsupported", "engine_declared_unsupported"
    elif ev_state == UNVERIFIED_STATE:
        # 증거가 없으면 선언이 무엇이든 UNVERIFIED. 여기가 '가짜 성공' 차단선이다.
        state, reason = UNVERIFIED_STATE, "probe_absent"
    elif claimed == UNVERIFIED_STATE:
        state, reason = ev_state, _evidence_reason(evidence)
    elif CAPABILITY_STATE_RANK[claimed] < CAPABILITY_STATE_RANK[ev_state]:
        state, reason = claimed, "claim_caps_evidence"
    else:
        state, reason = ev_state, _evidence_reason(evidence)

    return {
        "feature": feature,
        "claimed": claimed,
        "evidence": ev_state,
        "state": state,
        "verified": state != UNVERIFIED_STATE and ev_state != UNVERIFIED_STATE,
        "reason": reason,
    }


def is_usable(state: str) -> bool:
    """'지원됨' 으로 취급해도 되는 상태인가. 'supported' 하나뿐이다."""
    return _check_state(state) == "supported"


# ─────────────────────────────────────────────────────────────────────────────
# 4. 프로필
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CapabilityProfile:
    """엔진 하나의 capability 판정 결과 묶음.

    features      : CAPABILITY_FEATURES 전부에 대한 판정 레코드(빠짐 없음 — 누락은 unknown 으로 채운다).
    prosody_kinds : expressive_timeline.LOCAL_PROSODY_KINDS 각각의 '모델 네이티브 실현' 판정.
    """

    engine_id: str
    features: Dict[str, dict] = field(default_factory=dict)
    prosody_kinds: Dict[str, dict] = field(default_factory=dict)

    def state_of(self, feature: str) -> str:
        if feature not in self.features:
            raise CapabilityContractError("unknown feature: %s" % feature)
        return self.features[feature]["state"]

    def is_supported(self, feature: str) -> bool:
        return is_usable(self.state_of(feature))

    def prosody_state(self, kind: str) -> str:
        if kind not in self.prosody_kinds:
            raise CapabilityContractError("unknown prosody kind: %s" % kind)
        return self.prosody_kinds[kind]["state"]

    def prosody_is_native(self, kind: str) -> bool:
        return is_usable(self.prosody_state(kind))

    def unverified_features(self) -> Tuple[str, ...]:
        return tuple(f for f in CAPABILITY_FEATURES
                     if self.features[f]["state"] == UNVERIFIED_STATE)

    def unverified_prosody_kinds(self) -> Tuple[str, ...]:
        return tuple(k for k in ex.LOCAL_PROSODY_KINDS
                     if self.prosody_kinds[k]["state"] == UNVERIFIED_STATE)

    def degraded_features(self) -> Tuple[str, ...]:
        return tuple(f for f in CAPABILITY_FEATURES if self.features[f]["state"] == "degraded")


def build_profile(engine_id: str,
                  claims: Optional[Mapping[str, str]] = None,
                  evidence: Optional[Mapping[str, ProbeEvidence]] = None,
                  prosody_claims: Optional[Mapping[str, str]] = None,
                  prosody_evidence: Optional[Mapping[str, ProbeEvidence]] = None) -> CapabilityProfile:
    """선언표 + 프로브표 → CapabilityProfile. 누락 항목은 전부 'unknown' 으로 채운다."""
    claims = dict(claims or {})
    evidence = dict(evidence or {})
    prosody_claims = dict(prosody_claims or {})
    prosody_evidence = dict(prosody_evidence or {})

    for key in claims:
        if key not in CAPABILITY_FEATURES:
            raise CapabilityContractError("unknown feature: %s" % key)
    for key in evidence:
        if key not in CAPABILITY_FEATURES:
            raise CapabilityContractError("unknown feature: %s" % key)
    for key in list(prosody_claims) + list(prosody_evidence):
        if key not in ex.LOCAL_PROSODY_KINDS:
            raise CapabilityContractError("unknown prosody kind: %s" % key)

    features = {f: resolve_feature(f, claims.get(f), evidence.get(f)) for f in CAPABILITY_FEATURES}

    # 구두점(국소 운율)의 네이티브 실현은 상위 스위치 punctuation_native_instruction 에 종속된다.
    # 상위가 supported 가 아니면 개별 종류가 아무리 선언/관측되어도 네이티브로 올라갈 수 없다.
    umbrella = features["punctuation_native_instruction"]["state"]
    prosody = {}
    for kind in ex.LOCAL_PROSODY_KINDS:
        rec = resolve_feature(kind, prosody_claims.get(kind), prosody_evidence.get(kind))
        if umbrella != "supported" and rec["state"] == "supported":
            rec = dict(rec, state=umbrella, reason="claim_caps_evidence", verified=False)
        prosody[kind] = rec

    return CapabilityProfile(engine_id=str(engine_id), features=features, prosody_kinds=prosody)


def unknown_profile(engine_id: str = "unknown_engine") -> CapabilityProfile:
    """실제 엔진 없이 알 수 있는 유일하게 정직한 프로필 — 전부 UNVERIFIED.

    통합 담당자가 실제 프로브를 붙이기 전까지의 기본값이다. 이 프로필로 계획하면
    전략은 항상 마지막 수단으로 떨어지며, 그것이 오늘의 정직한 답이다.
    """
    return build_profile(engine_id)


# ─────────────────────────────────────────────────────────────────────────────
# 5. 정직성 강제 / 직렬화
# ─────────────────────────────────────────────────────────────────────────────

def assert_no_false_success(profile: CapabilityProfile, reported_supported: Sequence[str]) -> None:
    """'지원됨' 으로 보고하려는 기능 목록이 실제 supported 인지 강제한다.

    unknown/degraded/unsupported 를 성공으로 보고하려 하면 CapabilityHonestyError.
    """
    bad = []
    for f in reported_supported or ():
        if f in CAPABILITY_FEATURES:
            st = profile.state_of(f)
        elif f in ex.LOCAL_PROSODY_KINDS:
            st = profile.prosody_state(f)
        else:
            raise CapabilityContractError("unknown capability target: %s" % f)
        if st != "supported":
            bad.append((f, st))
    if bad:
        raise CapabilityHonestyError(
            "false success: " + ",".join("%s=%s" % (f, st) for f, st in bad))


def profile_to_record(profile: CapabilityProfile) -> dict:
    """계획서에 그대로 박아 넣을 수 있는 짧은 토큰 전용 레코드(자유 텍스트 없음)."""
    return {
        "capability_contract_version": CAPABILITY_CONTRACT_VERSION,
        "engine_id": profile.engine_id,
        "features": {f: profile.features[f]["state"] for f in CAPABILITY_FEATURES},
        "feature_reasons": {f: profile.features[f]["reason"] for f in CAPABILITY_FEATURES},
        "feature_verified": {f: bool(profile.features[f]["verified"]) for f in CAPABILITY_FEATURES},
        "prosody_kinds": {k: profile.prosody_kinds[k]["state"] for k in ex.LOCAL_PROSODY_KINDS},
        "unverified_features": list(profile.unverified_features()),
        "unverified_prosody_kinds": list(profile.unverified_prosody_kinds()),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 6. '~' 늘임 — 언어 분류를 '소비' 하고, 최종 지원/강등 판정은 여기(ENGINE)가 내린다
#
#  언어 계약은 '~' 를 문법적으로 전부 받아들이고 3분류만 노출한다. 음향 품질(supported)을
#  언어 계층이 단언하지 않는다 — 그 판정은 엔진 capability 인 이 모듈의 책임이다.
#  ⚠️ 분류를 여기서 다시 유도하지 않는다. 계약이 노출한 값을 그대로 옮길 뿐이다.
#  ⚠️ 받침 자음을 복제/반복해 길이를 버는 구현은 금지다. 늘임 대상이 모음이 아닌 경우
#     '자연스럽게 늘어난다' 고 절대 보고하지 않는다(실청 검증 전까지 UNVERIFIED).
# ─────────────────────────────────────────────────────────────────────────────

# 언어 계약이 노출하는 3분류.
VOWEL_EXTEND_CLASSES = ("open_vowel", "sustainable_final", "non_sustainable_final")

# 언어 계약이 아직 3분류를 노출하지 않는 동안 쓰는 어댑터 전용 값(재유도 아님 — 계약 판정의 이관).
VOWEL_EXTEND_ADAPTER_CLASSES = ("final_consonant_unclassified", "no_target")

VOWEL_EXTEND_ALL_CLASSES = VOWEL_EXTEND_CLASSES + VOWEL_EXTEND_ADAPTER_CLASSES

VOWEL_EXTEND_CLASS_SOURCES = (
    "contract_classification",   # 계약이 3분류를 직접 노출
    "contract_legacy_supported", # 구 계약의 supported=True 를 open_vowel 로 이관
    "contract_legacy_reason",    # 구 계약의 degraded_reason 을 이관
    "absent",                    # 늘임 레코드 자체가 없음
)

VOWEL_EXTEND_VERDICT_REASONS = (
    "OPEN_VOWEL_ENGINE_STATE",         # 열린 모음 — 엔진 capability 상태를 그대로 따른다
    "SUSTAINABLE_FINAL_UNVERIFIED",    # ㅇ/ㄴ/ㅁ/ㄹ — 전용 프로브 없이는 supported 로 올리지 않는다
    "NON_SUSTAINABLE_FINAL_DEGRADED",  # 그 외 받침 — degraded + 경고
    "CLASSIFICATION_UNAVAILABLE",      # 3분류 미노출 → 추측 금지, UNVERIFIED
    "NO_TARGET",                       # 늘일 대상 자체가 없음
)


def classify_vowel_extend(vowel_record) -> dict:
    """계약이 낸 '~' 판정을 그대로 옮긴다. 원문에서 분류를 다시 유도하지 않는다."""
    if not isinstance(vowel_record, dict):
        return {"classification": "no_target", "source": "absent", "degraded_reason": None}

    c = vowel_record.get("classification")
    if c in VOWEL_EXTEND_ALL_CLASSES:
        return {"classification": c, "source": "contract_classification",
                "degraded_reason": vowel_record.get("degraded_reason")}

    # ── 구 계약 어댑터: 계약이 이미 내린 결론만 이관한다 ──
    if vowel_record.get("supported") is True:
        return {"classification": "open_vowel", "source": "contract_legacy_supported",
                "degraded_reason": None}
    reason = vowel_record.get("degraded_reason")
    if reason == "final_consonant":
        # 구 계약은 ㅇ/ㄴ/ㅁ/ㄹ 과 그 외 받침을 구분하지 않는다 → 추측하지 않고 UNVERIFIED.
        return {"classification": "final_consonant_unclassified", "source": "contract_legacy_reason",
                "degraded_reason": reason}
    return {"classification": "no_target", "source": "contract_legacy_reason", "degraded_reason": reason}


def resolve_vowel_extend_capability(vowel_record, profile: CapabilityProfile) -> dict:
    """언어 분류 + 엔진 capability → '~' 늘임의 최종 판정.

    allowed_post_process 는 **열린 모음일 때만** True 다. 받침(지속 가능 여부 무관)은
    자음 늘이기/반복이 금지되므로 후처리 경로를 열지 않는다 — 네이티브 실현만이 정직한 길이며
    그것은 실제 엔진 프로브가 있어야 확인된다.
    """
    cls = classify_vowel_extend(vowel_record)
    kind_state = profile.prosody_state("vowel_extend")
    classification = cls["classification"]

    if classification == "no_target":
        state, reason, allowed = "unsupported", "NO_TARGET", False
    elif classification == "open_vowel":
        state, reason = kind_state, "OPEN_VOWEL_ENGINE_STATE"
        allowed = state != "supported"      # 네이티브가 아니면 모음 한정 늘임 후처리 허용
    elif classification == "sustainable_final":
        # 문법적으로는 허용된다. 그러나 '자연스럽게 늘어난다' 는 실청 검증 전까지 단언 금지.
        sustain = profile.state_of("vowel_extend_sustainable_final")
        state = sustain if sustain == "supported" else (
            "degraded" if sustain == "degraded" else UNVERIFIED_STATE)
        if state == "supported" and kind_state != "supported":
            state = kind_state
        reason, allowed = "SUSTAINABLE_FINAL_UNVERIFIED", False
    elif classification == "non_sustainable_final":
        state, reason, allowed = "degraded", "NON_SUSTAINABLE_FINAL_DEGRADED", False
    else:  # final_consonant_unclassified
        state, reason, allowed = UNVERIFIED_STATE, "CLASSIFICATION_UNAVAILABLE", False

    return {
        "classification": classification,
        "classification_source": cls["source"],
        "degraded_reason": cls["degraded_reason"],
        "prosody_state": kind_state,
        "state": state,
        "reason": reason,
        "allowed_post_process": bool(allowed),
        "natural_extension_claimed": False,   # 어떤 경로에서도 '자연스럽게 늘어난다' 고 주장하지 않는다
        "final_consonant_repeat_allowed": False,   # 명시적 금지
    }


# ─────────────────────────────────────────────────────────────────────────────
# 8. 설치된 로컬 모델 감사 (PHASE E3)
#
#   GPU 도, 모델 로딩도, 다운로드도 없다. 근거는 **디스크에 있는 파일**뿐이다 —
#   각 스냅샷의 config.json, vendor 모델 카드, vendor 추론 코드, 그리고 우리 adapter.
#
#   크다는 이유로 supported 라고 적지 않는다. 근거가 없으면 unknown 이고, vendor 가
#   스스로 못 한다고 하면 unsupported 다. 이 표에서 supported 는 한 칸도 나오지 않는데,
#   그것이 지금 이 저장소가 가진 사실이다.
# ─────────────────────────────────────────────────────────────────────────────

LOCAL_MODEL_AUDIT_VERSION = 1

#: 왜 그렇게 적었는가(비민감 enum). 경로·가중치·사용자 자료를 담지 않는다.
EV_CARD_NO_INSTRUCTION = "VENDOR_CARD_NO_INSTRUCTION_CONTROL"  # 모델 카드 표의 해당 칸이 비어 있다
EV_CODE_DECLARED_UNSUPPORTED = "VENDOR_CODE_DECLARED_UNSUPPORTED"
EV_NO_SUCH_PARAMETER = "NO_SUCH_PARAMETER"          # 추론 API 에 그런 인자가 없다
EV_ENTRY_POINT_REFUSES = "ENTRY_POINT_REFUSES_MODEL_TYPE"  # 그 함수가 이 모델 종류를 거부한다
EV_PARAM_REACHABLE_UNTESTED = "PARAMETER_REACHABLE_UNTESTED"
EV_MECHANISM_UNVERIFIED = "MECHANISM_PRESENT_EFFECT_UNVERIFIED"
EV_VARIANT_NOT_INSTALLED = "VARIANT_NOT_INSTALLED"
EV_ADAPTER_PATH_PINNED = "ADAPTER_PATH_PINNED"      # adapter 가 다른 스냅샷 경로에 고정돼 있다

AUDIT_EVIDENCE = (
    EV_CARD_NO_INSTRUCTION, EV_CODE_DECLARED_UNSUPPORTED, EV_NO_SUCH_PARAMETER,
    EV_ENTRY_POINT_REFUSES, EV_PARAM_REACHABLE_UNTESTED, EV_MECHANISM_UNVERIFIED,
    EV_VARIANT_NOT_INSTALLED, EV_ADAPTER_PATH_PINNED,
)

#: 이번 감사가 보는 축. 사용자가 물은 항목 그대로다.
AUDIT_FEATURES = (
    "emotion_instruction_text",            # emotion/instruct 입력
    "continuous_emotion_weights",          # 연속 intensity
    "f0_contour_input",                    # F0 contour 직접 입력
    "duration_pause_control",              # duration·pause 제어
    "emotion_reference_acoustic",          # reference audio 기반 표현 전달
    "speaker_clone_with_emotion_control",  # 복제와 감정 제어 동시
)

#: 감사한 모델. `installed` 는 저장소가 실제로 가진 것이고, 나머지는 같은 계열에서
#: 감정 지시를 선언한 변종이다(설치돼 있지 않다 — 그래서 판정이 아니라 후보다).
AUDIT_MODELS = ("qwen3_tts_0b6_base", "qwen3_tts_1b7_base",
                "qwen3_tts_1b7_custom_voice", "qwen3_tts_1b7_voice_design")

#: 두 Base 스냅샷이 공유하는 판정. 크기만 다르고 종류(`tts_model_type: base`)가 같다.
#:
#: 핵심 사실 하나: 이 계열에서 **목소리 복제는 Base 만** 되고 **감정 지시는 Base 만
#: 안 된다.** 둘이 겹치는 변종이 아예 없다 — 그래서 마지막 축이 unsupported 다.
_BASE_CLAIMS = {
    # 모델 카드의 Instruction Control 칸이 Base 행에서만 비어 있다(CustomVoice/VoiceDesign 은 ✅).
    "emotion_instruction_text": ("unsupported", EV_CARD_NO_INSTRUCTION),
    # 세기를 연속값으로 받는 인자가 추론 API 어디에도 없다.
    "continuous_emotion_weights": ("unsupported", EV_NO_SUCH_PARAMETER),
    # F0 곡선을 넣을 자리가 없다. 있는 것은 텍스트·참조·샘플링 인자뿐이다.
    "f0_contour_input": ("unsupported", EV_NO_SUCH_PARAMETER),
    # 길이·쉼도 마찬가지다. 우리 쪽 속도 조절은 모델이 아니라 후처리(atempo)다.
    "duration_pause_control": ("unsupported", EV_NO_SUCH_PARAMETER),
    # 참조 조건화는 실제로 있다. 다만 "감정까지 옮겨지는가"는 아직 재지 않았다.
    "emotion_reference_acoustic": ("unknown", EV_MECHANISM_UNVERIFIED),
    # 복제는 Base, 지시는 CustomVoice/VoiceDesign — 한 모델에 같이 있지 않다.
    "speaker_clone_with_emotion_control": ("unsupported", EV_CARD_NO_INSTRUCTION),
}

#: 감정 지시를 선언한 변종. 설치돼 있지 않고, 목소리 복제를 하지 않는다.
_INSTRUCT_VARIANT_CLAIMS = {
    "emotion_instruction_text": ("unknown", EV_VARIANT_NOT_INSTALLED),
    "continuous_emotion_weights": ("unsupported", EV_NO_SUCH_PARAMETER),
    "f0_contour_input": ("unsupported", EV_NO_SUCH_PARAMETER),
    "duration_pause_control": ("unsupported", EV_NO_SUCH_PARAMETER),
    # 이 변종들은 ref_audio 를 받지 않는다 — 참조 기반 표현 전달이라는 축 자체가 없다.
    "emotion_reference_acoustic": ("unsupported", EV_ENTRY_POINT_REFUSES),
    # 목소리 복제 자체를 못 한다(generate_voice_clone 이 base 타입만 받는다).
    "speaker_clone_with_emotion_control": ("unsupported", EV_ENTRY_POINT_REFUSES),
}

_AUDIT_ROWS = {
    "qwen3_tts_0b6_base": {
        "model_size": "0b6", "model_type": "base", "installed": True,
        # adapter 가 이 스냅샷을 가리키고 있다 — 오늘 실제로 쓰는 모델이다.
        "adapter_connectable": True, "adapter_note": None,
        "claims": dict(_BASE_CLAIMS, **{
            # vendor 코드가 이 크기에 대해 명시적으로 "instruct 미지원"이라고 적어 두었다.
            "emotion_instruction_text": ("unsupported", EV_CODE_DECLARED_UNSUPPORTED),
        }),
    },
    "qwen3_tts_1b7_base": {
        "model_size": "1b7", "model_type": "base", "installed": True,
        # 파일은 다 있는데 adapter 가 0b6 스냅샷 경로에 고정돼 있다 — 자산 문제가 아니라 배선 문제다.
        "adapter_connectable": False, "adapter_note": EV_ADAPTER_PATH_PINNED,
        "claims": dict(_BASE_CLAIMS, **{
            # 0b6 전용 차단문에 걸리지 않으므로 인자는 모델까지 닿는다. 그러나 모델 카드가
            # Base 의 지시 제어를 선언하지 않았다 — 닿는 것과 듣는 것은 다른 일이다.
            "emotion_instruction_text": ("unknown", EV_PARAM_REACHABLE_UNTESTED),
        }),
    },
    "qwen3_tts_1b7_custom_voice": {
        "model_size": "1b7", "model_type": "custom_voice", "installed": False,
        "adapter_connectable": False, "adapter_note": EV_VARIANT_NOT_INSTALLED,
        "claims": dict(_INSTRUCT_VARIANT_CLAIMS),
    },
    "qwen3_tts_1b7_voice_design": {
        "model_size": "1b7", "model_type": "voice_design", "installed": False,
        "adapter_connectable": False, "adapter_note": EV_VARIANT_NOT_INSTALLED,
        "claims": dict(_INSTRUCT_VARIANT_CLAIMS),
    },
}


def local_model_audit():
    """설치·연결·기능 감사 표. 순수 함수이고 파일을 읽지 않는다(근거는 이미 굳혀 두었다).

    각 칸은 `(state, evidence)` 이며 state 는 `CAPABILITY_STATES` 값이다. **supported 는
    한 칸도 없다** — 프로브 없이 supported 를 적을 수 있는 경로가 이 모듈에는 없다.
    """
    rows = []
    for name in AUDIT_MODELS:
        spec = _AUDIT_ROWS[name]
        features = {}
        for feature in AUDIT_FEATURES:
            state, evidence = spec["claims"][feature]
            if state not in CAPABILITY_STATES:
                raise CapabilityContractError("bad state")
            if evidence not in AUDIT_EVIDENCE:
                raise CapabilityContractError("bad evidence")
            features[feature] = {"state": state, "evidence": evidence}
        rows.append({
            "model": name,
            "model_size": spec["model_size"],
            "model_type": spec["model_type"],
            "installed": spec["installed"],
            "adapter_connectable": spec["adapter_connectable"],
            "adapter_note": spec["adapter_note"],
            "needs_download": not spec["installed"],
            # 아직 판정이 열려 있는 축이 있으면 GPU 프로브가 남았다는 뜻이다.
            "needs_gpu_probe": any(v["state"] == UNVERIFIED_STATE
                                   for v in features.values()),
            "features": features,
        })
    return rows


def native_emotion_path_available():
    """지금 이 컴퓨터에서 **모델이 직접** 감정을 받는 통로가 있는가.

    설치돼 있고, adapter 로 연결되며, 감정 지시가 supported 인 모델이 하나라도 있어야
    참이다. 오늘은 거짓이다 — 설치된 둘은 Base 이고 Base 는 지시 제어를 선언하지 않았다.
    """
    for row in local_model_audit():
        if not (row["installed"] and row["adapter_connectable"]):
            continue
        if row["features"]["emotion_instruction_text"]["state"] == "supported":
            return True
    return False


def audit_summary():
    """run bundle 에 실을 요약. 짧은 토큰만 담는다."""
    rows = local_model_audit()
    return {
        "audit_version": LOCAL_MODEL_AUDIT_VERSION,
        "models": len(rows),
        "installed": sum(1 for r in rows if r["installed"]),
        "connectable": sum(1 for r in rows if r["adapter_connectable"]),
        "native_emotion_path": native_emotion_path_available(),
        "open_probes": sorted({f for r in rows for f, v in r["features"].items()
                               if v["state"] == UNVERIFIED_STATE}),
    }
