# -*- coding: utf-8 -*-
"""감정 음향 ENGINE — 감정별 참조 클립의 측정·분리도·추종도 계약.

이 모듈이 답하는 질문은 하나다: **"이 감정은 실제로 감정처럼 들리는가, 아니면 태그만 붙었는가?"**

배경(doc/work-in-progress/tts-emotion-acoustic-strategy.md):
  Qwen3-TTS Base 의 voice clone 경로에는 감정·스타일 지시 인자가 없다. 감정은 오직 참조 클립
  교체로만 실현된다. 따라서 **같은 참조를 쓰면 모델 입력이 완전히 동일**하고, 감정 차이가 나올
  통로 자체가 없다. 실측이 이를 뒷받침한다(F0 변동폭 4.09~4.29 반음으로 세 감정이 사실상 동일).

핵심 규칙(전부 테스트로 고정):
  1. 상태는 **언제나 ProbeEvidence 에서 파생**된다. 별도 규칙표를 두지 않는다 —
     두 개의 진실 소스가 생기면 반드시 갈라진다.
  2. `honored` 는 측정 레코드 없이 True 가 될 수 없다. 이 모듈의 함수는 honored 를
     boolean 인자로 받지 않는다 — 호출부가 "됐다"고 주장할 자리를 아예 없앤다.
  3. 판정은 **계약이 이미 해상도를 정의한 축**(반음)에서만 한다. dB·ms·자/초 축은
     숫자로 기록만 하고 판정하지 않는다(그 단위에는 정해 둔 해상도가 없다).
  4. 고정 프리셋 숫자를 만들지 않는다. "기쁨은 F0 +2 반음" 같은 표는 존재하지 않는다.
     모든 값은 실제 참조 클립에서 측정한다.
  5. 레코드는 숫자와 짧은 안전 토큰만 담는다 — 경로/대사/참조 전사문/자유 텍스트 금지.

계약 소비: 상태 어휘(CAPABILITY_STATES)와 ProbeEvidence 는 expressive_capability 에서
**import** 한다. 값을 복사하지 않는다(병렬 어휘 금지).

순수성: 1~5절은 stdlib 만 쓴다. numpy/오디오가 필요한 측정(6절)은 함수 안에서 lazy import
하므로, 계약만 검증할 때는 numpy 없이도 이 모듈을 import 할 수 있다.
"""
import math

import expressive_capability as cap

EMOTION_ACOUSTIC_CONTRACT_VERSION = 1

# 이 모듈이 판정하는 capability 기능명. expressive_capability.CAPABILITY_FEATURES 에 등록되어 있다
# (ProbeEvidence 가 알 수 없는 기능명을 거부하므로, 등록 없이는 증거를 만들 수 없다).
EMOTION_ACOUSTIC_FEATURE = "emotion_reference_acoustic"

# 모델 native 감정 지시 후보(instruct_ids)가 매핑되는 기존 기능명. 새로 만들지 않는다.
INSTRUCT_FEATURE = "emotion_instruction_text"


# ─────────────────────────────────────────────────────────────────────────────
# 1. 참조 배치(role) — 판정이 아니라 '어떤 파일이 들어가는가' 라는 사실
# ─────────────────────────────────────────────────────────────────────────────

REFERENCE_DISTINCT = "distinct"              # 기본 참조와 다른 클립이 이 감정에 붙어 있다
REFERENCE_SHARED_DEFAULT = "shared_default"  # 기본 참조와 같은 클립을 쓴다(태그만 다르다)
REFERENCE_ABSENT = "absent"                  # 전용 참조가 없다 → 기본 참조로 폴백

EMOTION_REFERENCE_ROLES = (
    REFERENCE_DISTINCT,
    REFERENCE_SHARED_DEFAULT,
    REFERENCE_ABSENT,
)


class EmotionAcousticError(ValueError):
    """감정 음향 계약 위반. 메시지엔 enum 토큰만 담는다(경로·전사문 금지)."""


def _check_role(role):
    if role not in EMOTION_REFERENCE_ROLES:
        raise EmotionAcousticError("unknown reference role: %s" % role)
    return role


def classify_reference_role(emotion_key, default_key):
    """이 감정이 쓰는 참조가 기본 참조와 같은가/다른가/없는가.

    key 는 '같음/다름'만 판정할 수 있으면 되는 불투명 식별자다 — 콘텐츠 SHA-256 이 정석이고,
    합성 직전이라면 이미 해석된 참조 경로도 같은 역할을 한다(tts_worker 가 그렇게 쓴다).
    이 함수는 값을 저장하지도 기록하지도 않는다 — 비교만 하고 토큰 하나를 돌려준다.
    """
    if not emotion_key:
        return REFERENCE_ABSENT
    if not default_key:
        # 기본 참조가 없는데 감정 참조만 있는 상태. 비교 대상이 없으므로 '다르다'고 말할 수 없다.
        return REFERENCE_ABSENT
    return REFERENCE_SHARED_DEFAULT if emotion_key == default_key else REFERENCE_DISTINCT


# ─────────────────────────────────────────────────────────────────────────────
# 2. 판정 사유 코드
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_REF_ABSENT = "EMOTION_REF_ABSENT"
EMOTION_REF_SHARED_DEFAULT = "EMOTION_REF_SHARED_DEFAULT"
EMOTION_REF_PROFILE_MISSING = "EMOTION_REF_PROFILE_MISSING"
EMOTION_REF_NOT_SEPARATED = "EMOTION_REF_NOT_SEPARATED"
EMOTION_RESULT_NOT_MEASURED = "EMOTION_RESULT_NOT_MEASURED"
EMOTION_RESULT_NOT_FOLLOWED = "EMOTION_RESULT_NOT_FOLLOWED"
EMOTION_RESULT_FOLLOWED = "EMOTION_RESULT_FOLLOWED"

EMOTION_ACOUSTIC_REASONS = (
    EMOTION_REF_ABSENT,
    EMOTION_REF_SHARED_DEFAULT,
    EMOTION_REF_PROFILE_MISSING,
    EMOTION_REF_NOT_SEPARATED,
    EMOTION_RESULT_NOT_MEASURED,
    EMOTION_RESULT_NOT_FOLLOWED,
    EMOTION_RESULT_FOLLOWED,
)

# supported 로 갈 수 있는 유일한 사유. 나머지는 전부 degraded 아니면 unknown 이다.
EMOTION_ACOUSTIC_SUPPORTED_REASON = EMOTION_RESULT_FOLLOWED


# ─────────────────────────────────────────────────────────────────────────────
# 3. 감정 음향 프로필 레코드 — 감정별 참조에서 뽑는 값(전부 측정값, 프리셋 없음)
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_ACOUSTIC_PROFILE_FIELDS = (
    "sample_rate",
    "analysis_samples",
    # ── F0 축(반음) — 판정에 쓰는 유일한 축들의 원천 ──
    "f0_q50_hz",
    "f0_range_semitones",
    "f0_iqr_semitones",
    "f0_std_semitones",
    "voiced_ratio",
    # ── 세기 축(dB) — 기록 전용 ──
    "rms_q50",
    "rms_range_db",
    # ── 시간 축(ms) — 기록 전용 ──
    "speech_ms",
    "pause_count",
    "pause_total_ms",
    "pause_longest_ms",
    # ── 음색 축(dB) — 기록 전용 ──
    "spectral_tilt_db",
    # ── 말 속도(자/초) — 전사 글자 '수'가 주어졌을 때만. 없으면 available=0 ──
    "speech_rate_cps",
    "speech_rate_available",
)

EMOTION_ACOUSTIC_PROFILE_INT_FIELDS = (
    "sample_rate",
    "analysis_samples",
    "speech_ms",
    "pause_count",
    "pause_total_ms",
    "pause_longest_ms",
    "speech_rate_available",
)


def serialize_emotion_profile(record):
    """감정 음향 프로필 1개 → 숫자만. 스키마 밖 키·비유한·불리언을 전부 거부한다.

    onset_continuity_metrics.serialize_prosody_profile 과 동일한 하드 계약이다.
    """
    import math

    if not isinstance(record, dict):
        raise EmotionAcousticError("profile must be a dict")
    extra = set(record.keys()) - set(EMOTION_ACOUSTIC_PROFILE_FIELDS)
    if extra:
        raise EmotionAcousticError("disallowed fields: %d" % len(extra))
    missing = set(EMOTION_ACOUSTIC_PROFILE_FIELDS) - set(record.keys())
    if missing:
        raise EmotionAcousticError("missing fields: %d" % len(missing))
    out = {}
    for key in EMOTION_ACOUSTIC_PROFILE_FIELDS:
        value = record[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EmotionAcousticError("'%s' is not numeric" % key)
        if key in EMOTION_ACOUSTIC_PROFILE_INT_FIELDS:
            out[key] = int(value)
        else:
            f = float(value)
            if not math.isfinite(f):
                raise EmotionAcousticError("'%s' is not finite" % key)
            out[key] = f
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 4. 분리도(separation) — 감정 참조가 기본 참조와 실제로 구별되는가
#
#  ⚠️ 판정 축은 반음 단위 4개뿐이다. 구별 기준을 새로 만들지 않고
#     onset_continuity_metrics.PROSODY_FLAT_SEMITONES(0.5 반음)를 그대로 쓴다 —
#     이미 이 저장소가 "이보다 작으면 평탄"이라고 정의해 둔 **분석 해상도**이며,
#     감정용으로 지어낸 문턱값이 아니다.
#  ⚠️ dB·ms·자/초 축은 기록만 한다. 그 단위에는 계약이 정한 해상도가 없어서,
#     문턱을 세우는 순간 그것은 내가 지어낸 숫자가 된다.
# ─────────────────────────────────────────────────────────────────────────────

# 판정에 쓰는 축(전부 반음). 순서는 고정 — follow 레코드의 axis_index 가 이 순서를 가리킨다.
SEPARATION_JUDGED_AXES = (
    "f0_median_offset_semitones",
    "f0_range_delta_semitones",
    "f0_iqr_delta_semitones",
    "f0_std_delta_semitones",
)

# 기록만 하는 축. 판정에 쓰지 않는다.
SEPARATION_RECORDED_AXES = (
    "rms_range_delta_db",
    "spectral_tilt_delta_db",
    "speech_rate_delta_cps",
    "speech_rate_comparable",
    "pause_count_delta",
    "pause_total_delta_ms",
)

EMOTION_SEPARATION_FIELDS = SEPARATION_JUDGED_AXES + (
    "max_axis_semitones",
    "max_axis_index",
    "separated",
) + SEPARATION_RECORDED_AXES

EMOTION_SEPARATION_INT_FIELDS = (
    "max_axis_index",
    "separated",
    "speech_rate_comparable",
    "pause_count_delta",
    "pause_total_delta_ms",
)


def separation_resolution_semitones():
    """구별 판정에 쓰는 해상도(반음). 권위는 onset_continuity_metrics 다 — 여기서 정하지 않는다."""
    import onset_continuity_metrics as ocm
    return float(ocm.PROSODY_FLAT_SEMITONES)


def _semitone_delta(f_from, f_to):
    """반음 차. onset_continuity_metrics.semitone_delta 와 같은 정의(어느 한쪽이 0 이하면 0.0)."""
    import math
    a, b = float(f_from), float(f_to)
    if a <= 0.0 or b <= 0.0:
        return 0.0
    return float(12.0 * math.log2(b / a))


def _require_profile(record, name):
    missing = set(EMOTION_ACOUSTIC_PROFILE_FIELDS) - set((record or {}).keys())
    if missing:
        raise EmotionAcousticError("%s profile missing fields: %d" % (name, len(missing)))
    return record


def emotion_reference_separation(default_profile, emotion_profile, resolution_semitones=None):
    """기본 참조와 감정 참조의 거리 — 판정 축(반음) + 기록 축.

    부호를 살린다. 추종도(follow)가 '같은 방향으로 움직였는가'를 물으려면 방향이 필요하다.
    """
    _require_profile(default_profile, "default")
    _require_profile(emotion_profile, "emotion")
    res = separation_resolution_semitones() if resolution_semitones is None else float(resolution_semitones)

    axes = {
        "f0_median_offset_semitones": _semitone_delta(default_profile["f0_q50_hz"],
                                                      emotion_profile["f0_q50_hz"]),
        "f0_range_delta_semitones": float(emotion_profile["f0_range_semitones"])
        - float(default_profile["f0_range_semitones"]),
        "f0_iqr_delta_semitones": float(emotion_profile["f0_iqr_semitones"])
        - float(default_profile["f0_iqr_semitones"]),
        "f0_std_delta_semitones": float(emotion_profile["f0_std_semitones"])
        - float(default_profile["f0_std_semitones"]),
    }

    # 가장 크게 갈라진 축 하나(동률이면 앞선 축). 이 축이 follow 판정의 기준이 된다.
    best_index, best_abs = 0, -1.0
    for i, name in enumerate(SEPARATION_JUDGED_AXES):
        a = abs(axes[name])
        if a > best_abs:
            best_index, best_abs = i, a

    rate_comparable = (int(default_profile["speech_rate_available"]) == 1
                       and int(emotion_profile["speech_rate_available"]) == 1)

    rec = dict(axes)
    rec["max_axis_semitones"] = float(best_abs)
    rec["max_axis_index"] = int(best_index)
    rec["separated"] = 1 if best_abs >= res else 0
    rec["rms_range_delta_db"] = float(emotion_profile["rms_range_db"]) - float(default_profile["rms_range_db"])
    rec["spectral_tilt_delta_db"] = (float(emotion_profile["spectral_tilt_db"])
                                     - float(default_profile["spectral_tilt_db"]))
    rec["speech_rate_delta_cps"] = ((float(emotion_profile["speech_rate_cps"])
                                     - float(default_profile["speech_rate_cps"]))
                                    if rate_comparable else 0.0)
    rec["speech_rate_comparable"] = 1 if rate_comparable else 0
    rec["pause_count_delta"] = int(emotion_profile["pause_count"]) - int(default_profile["pause_count"])
    rec["pause_total_delta_ms"] = int(emotion_profile["pause_total_ms"]) - int(default_profile["pause_total_ms"])
    assert tuple(rec.keys()) == EMOTION_SEPARATION_FIELDS
    return rec


# ─────────────────────────────────────────────────────────────────────────────
# 5. 추종도(follow) — 생성 결과가 감정 참조 쪽으로 실제로 움직였는가
#
#  이것이 honored 의 **유일한** 근거다. 다른 경로로 honored 가 True 가 되는 길은 없다.
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_FOLLOW_FIELDS = (
    "axis_index",
    "reference_gap_semitones",
    "result_gap_semitones",
    "follow_ratio",
    "followed",
)

EMOTION_FOLLOW_INT_FIELDS = ("axis_index", "followed")


def _axis_value(default_profile, other_profile, axis_index):
    """분리도 판정 축 하나를, 기본 참조를 원점으로 둔 부호 있는 반음 값으로."""
    name = SEPARATION_JUDGED_AXES[int(axis_index)]
    if name == "f0_median_offset_semitones":
        return _semitone_delta(default_profile["f0_q50_hz"], other_profile["f0_q50_hz"])
    key = {
        "f0_range_delta_semitones": "f0_range_semitones",
        "f0_iqr_delta_semitones": "f0_iqr_semitones",
        "f0_std_delta_semitones": "f0_std_semitones",
    }[name]
    return float(other_profile[key]) - float(default_profile[key])


def emotion_result_follow(default_profile, emotion_profile, result_profile,
                          separation, resolution_semitones=None):
    """생성 결과가 감정 참조 방향으로 최소 해상도만큼 움직였는가.

    두 참조를 가장 크게 갈라놓은 축 하나에서, 기본 참조를 원점으로 두고
      reference_gap = 감정참조 - 기본참조
      result_gap    = 생성결과 - 기본참조
    를 잰다.

    followed 조건: **부호가 같고** |result_gap| >= 해상도.
      · 방향이 반대면 따라간 것이 아니다(오늘 실측의 '기쁨이 가장 낮다'가 정확히 이 경우다).
      · 해상도 아래면 잰 것이 아니라 흔들린 것이다.
    """
    _require_profile(default_profile, "default")
    _require_profile(emotion_profile, "emotion")
    _require_profile(result_profile, "result")
    if not isinstance(separation, dict) or "max_axis_index" not in separation:
        raise EmotionAcousticError("separation record required")
    res = separation_resolution_semitones() if resolution_semitones is None else float(resolution_semitones)

    idx = int(separation["max_axis_index"])
    if not (0 <= idx < len(SEPARATION_JUDGED_AXES)):
        raise EmotionAcousticError("axis index out of range: %d" % idx)

    ref_gap = _axis_value(default_profile, emotion_profile, idx)
    res_gap = _axis_value(default_profile, result_profile, idx)

    same_direction = (ref_gap > 0.0 and res_gap > 0.0) or (ref_gap < 0.0 and res_gap < 0.0)
    followed = 1 if (same_direction and abs(res_gap) >= res) else 0

    rec = {
        "axis_index": int(idx),
        "reference_gap_semitones": float(ref_gap),
        "result_gap_semitones": float(res_gap),
        "follow_ratio": float(res_gap / ref_gap) if ref_gap != 0.0 else 0.0,
        "followed": followed,
    }
    assert tuple(rec.keys()) == EMOTION_FOLLOW_FIELDS
    return rec


# ─────────────────────────────────────────────────────────────────────────────
# 6. 판정 — 상태는 언제나 ProbeEvidence 에서 파생된다
# ─────────────────────────────────────────────────────────────────────────────

def emotion_acoustic_evidence(role, separation=None, follow=None):
    """감정 하나의 프로브 증거.

    ⚠️ honored 를 boolean 으로 받지 않는다. follow 레코드가 없으면 honored 는 False 이고,
       레코드가 있어도 그 안의 followed 가 1 일 때만 True 다 — 호출부가 "됐다"고 주장할 자리가 없다.

    attempted : 프로브를 **끝까지** 돌렸는가.
        · 전용 참조가 있는데 측정을 안 했으면 False(= unknown). 참조만 재고 결과를 안 쟀어도 False.
        · 전용 참조가 없는 경우(absent/shared_default)는 더 잴 것이 없으므로 True 다 —
          "모델 입력이 같다"는 것 자체가 완결된 관측이다.
    accepted  : 입력이 실제로 달라졌는가(전용 참조가 들어갔는가).
        · absent/shared_default 도 True 다. 감정 태그 자체는 파이프라인이 받아들였기 때문이다.
          받아들여진 것과 반영된 것은 다르다 — 그 구분이 이 필드의 존재 이유다.
    honored   : 결과가 관측 가능하게 그 방향으로 움직였는가.
    """
    _check_role(role)

    if role in (REFERENCE_ABSENT, REFERENCE_SHARED_DEFAULT):
        # 태그는 받았으나 모델 입력이 기본 참조 그대로다 → 무시당했다(degraded).
        return cap.ProbeEvidence(EMOTION_ACOUSTIC_FEATURE, attempted=True, accepted=True, honored=False)

    if not isinstance(separation, dict):
        return cap.ProbeEvidence(EMOTION_ACOUSTIC_FEATURE, attempted=False, accepted=False, honored=False)

    if int(separation.get("separated", 0)) != 1:
        # 다른 파일이긴 하나 잴 수 있는 차이가 없다 → 갈라 놓지 못했다(degraded).
        return cap.ProbeEvidence(EMOTION_ACOUSTIC_FEATURE, attempted=True, accepted=True, honored=False)

    if not isinstance(follow, dict):
        # 참조는 갈렸는데 결과를 아직 안 쟀다. 이것은 성공이 아니라 미완이다.
        return cap.ProbeEvidence(EMOTION_ACOUSTIC_FEATURE, attempted=False, accepted=True, honored=False)

    return cap.ProbeEvidence(EMOTION_ACOUSTIC_FEATURE, attempted=True, accepted=True,
                             honored=int(follow.get("followed", 0)) == 1)


def _reason_for(role, separation, follow):
    if role == REFERENCE_ABSENT:
        return EMOTION_REF_ABSENT
    if role == REFERENCE_SHARED_DEFAULT:
        return EMOTION_REF_SHARED_DEFAULT
    if not isinstance(separation, dict):
        return EMOTION_REF_PROFILE_MISSING
    if int(separation.get("separated", 0)) != 1:
        return EMOTION_REF_NOT_SEPARATED
    if not isinstance(follow, dict):
        return EMOTION_RESULT_NOT_MEASURED
    return EMOTION_RESULT_FOLLOWED if int(follow.get("followed", 0)) == 1 else EMOTION_RESULT_NOT_FOLLOWED


def resolve_emotion_acoustic(emotion_id, role, separation=None, follow=None):
    """감정 하나의 최종 음향 판정 레코드(짧은 토큰 + 숫자만).

    state 는 evidence 에서 파생된다 — 이 함수가 상태를 직접 정하지 않는다.
    supported 로 가는 길은 `EMOTION_RESULT_FOLLOWED` 하나뿐이고, 그 길은 실제 생성 결과를
    측정해야만 열린다.
    """
    _check_role(role)
    evidence = emotion_acoustic_evidence(role, separation, follow)
    state = cap.evidence_state(evidence)
    reason = _reason_for(role, separation, follow)

    # 불변식: supported 는 오직 하나의 사유로만 도달한다. 다른 조합으로 새는 길이 없는지 강제한다.
    if state == "supported" and reason != EMOTION_ACOUSTIC_SUPPORTED_REASON:
        raise cap.CapabilityHonestyError("false success: %s/%s" % (state, reason))
    if reason == EMOTION_ACOUSTIC_SUPPORTED_REASON and state != "supported":
        raise cap.CapabilityHonestyError("reason/state mismatch: %s/%s" % (state, reason))

    return {
        "emotion_acoustic_contract_version": EMOTION_ACOUSTIC_CONTRACT_VERSION,
        "emotion_id": str(emotion_id),
        "role": role,
        "state": state,
        "reason": reason,
        "attempted": bool(evidence.attempted),
        "accepted": bool(evidence.accepted),
        "honored": bool(evidence.honored),
        "usable": cap.is_usable(state),
    }


def resolve_emotion_set(default_key, emotion_keys, separations=None, follows=None):
    """대사에 쓰인 감정 전부에 대한 판정 묶음.

    emotion_keys: emotion_id → 그 감정이 실제로 쓰는 참조의 불투명 key(없으면 None).
    반환은 emotion_id 로 정렬된 레코드 리스트(결정적 순서).
    """
    separations = separations or {}
    follows = follows or {}
    out = []
    for emotion_id in sorted(emotion_keys or {}):
        role = classify_reference_role(emotion_keys.get(emotion_id), default_key)
        out.append(resolve_emotion_acoustic(emotion_id, role,
                                            separations.get(emotion_id),
                                            follows.get(emotion_id)))
    return out


def emotion_set_summary(records):
    """판정 묶음 → 수치 요약. '몇 개가 실제로 감정으로 들리는가'를 한 줄로 셀 수 있게."""
    counts = {"supported": 0, "degraded": 0, "unsupported": 0, "unknown": 0}
    for r in records or ():
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    return {
        "emotion_acoustic_contract_version": EMOTION_ACOUSTIC_CONTRACT_VERSION,
        "total": len(records or ()),
        "supported": counts["supported"],
        "degraded": counts["degraded"],
        "unsupported": counts["unsupported"],
        "unknown": counts["unknown"],
        # 전부 degraded/unknown 이면 '감정이 실린 결과가 하나도 없다' 는 뜻이다.
        "any_supported": counts["supported"] > 0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. 모델 native 후보: instruct_ids — 숨은 실험 probe
#
#  vendor 배선 실측(doc §4):
#    · generate_voice_clone(**kwargs) → _merge_generate_kwargs 는 `merged = dict(kwargs)` 로
#      시작해 알려진 샘플링 인자만 덮어쓴다 → 모르는 키(instruct_ids)는 그대로 통과한다.
#    · Qwen3TTSForConditionalGeneration.generate 시그니처에 instruct_ids 가 실제로 있다.
#    → 코드 경로상 수용될 자리는 있다. 그러나 런타임 관측이 없으므로
#      **accepted 는 미확인이다** — 배선 추적을 관측으로 승격하지 않는다.
#  그러나 같은 vendor 파일에 `if tts_model_size in "0b6": instruct = None`
#  (주석: for 0b6 model, instruct is not supported) 이 있고, 우리 스냅샷은 정확히 "0b6" 이다.
#  → capability 규칙 2(보수적 자기선언은 신뢰)에 따라 claim 은 unsupported 다.
#
#  결론: probe 로만 유지한다. accepted 를 관측해도 honored 로 승격되지 않는다.
# ─────────────────────────────────────────────────────────────────────────────

# vendor 가 instruct 미지원을 선언하는 모델 크기. 이 값은 config.json 에서 읽어 대조만 한다.
INSTRUCT_UNSUPPORTED_MODEL_SIZES = ("0b6",)

# production 경로에서는 어떤 요청이 와도 켜지지 않는다. 실험 하네스 컨텍스트에서만 켤 수 있다.
INSTRUCT_PROBE_CONTEXTS = ("production", "experiment")


def instruct_claim_for_model_size(model_size):
    """vendor 자기선언 → capability claim. 0b6 이면 unsupported, 그 밖은 판정 불가(unknown)."""
    if str(model_size) in INSTRUCT_UNSUPPORTED_MODEL_SIZES:
        return "unsupported"
    return cap.UNVERIFIED_STATE


def instruct_probe_allowed(context, requested):
    """instruct_ids 실험을 켜도 되는가.

    production 에서는 requested 가 True 여도 False 다 — 기본값이 꺼짐인 정도가 아니라,
    production 컨텍스트에는 켜는 길 자체가 없다.
    """
    if context not in INSTRUCT_PROBE_CONTEXTS:
        raise EmotionAcousticError("unknown probe context: %s" % context)
    if context == "production":
        return False
    return bool(requested)


def instruct_probe_evidence(attempted, accepted, follow=None):
    """instruct_ids 프로브 증거.

    ⚠️ honored 를 boolean 으로 받지 않는다. accepted=True 를 아무리 넣어도 follow 레코드
       없이는 honored=False 다. "받아들여졌으니 됐다"가 성공으로 새는 길을 타입에서 막는다.
    """
    honored = bool(isinstance(follow, dict) and int(follow.get("followed", 0)) == 1)
    return cap.ProbeEvidence(INSTRUCT_FEATURE, attempted=bool(attempted),
                             accepted=bool(accepted), honored=honored)


def instruct_probe_record(model_size, attempted, accepted, follow=None):
    """실험 레코드 — claim(vendor 선언)과 evidence(관측)를 **나란히** 남긴다.

    resolve_feature 가 claim 을 상한으로 적용하므로, 0b6 에서는 관측이 무엇이든 최종 상태가
    unsupported 다. 그래도 evidence 는 그대로 기록한다 — 나중에 모델이 바뀌면 이 관측이 근거가 된다.
    """
    evidence = instruct_probe_evidence(attempted, accepted, follow)
    rec = cap.resolve_feature(INSTRUCT_FEATURE, instruct_claim_for_model_size(model_size), evidence)
    rec = dict(rec)
    rec["model_size"] = str(model_size)
    rec["probe_attempted"] = bool(evidence.attempted)
    rec["probe_accepted"] = bool(evidence.accepted)
    rec["probe_honored"] = bool(evidence.honored)
    return rec


# ─────────────────────────────────────────────────────────────────────────────
# 8. 측정 — 여기서만 numpy/오디오를 만진다(lazy import)
#
#  ⚠️ 이 절은 판정하지 않는다. 숫자만 서술한다. 판정은 4~6절이 한다.
#  ⚠️ 수식을 새로 만들지 않는다. onset_continuity_metrics 의 1차 함수를 그대로 쓴다
#     (그 모듈이 F0/RMS 서술의 단일 권위다 — boundary_metrics 도 같은 방식으로 소비한다).
# ─────────────────────────────────────────────────────────────────────────────

def measure_pause(signal, sr, start=0, stop=None):
    """쉼(pause) 서술 — 발화 안쪽의 저에너지 구간만 센다.

    최소 쉼 길이 문턱을 새로 만들지 않는다. 프레임 격자(hop 10 ms)가 곧 해상도이고,
    무음 판정은 이미 있는 SILENCE_REL_THRESHOLD(구간 최대 프레임 RMS 대비)를 그대로 쓴다.
    앞뒤 무음은 '쉼'이 아니라 여백이므로 제외한다 — 안쪽 구간만 센다.
    """
    import numpy as np
    import onset_continuity_metrics as ocm

    rms = ocm.frame_rms_track(signal, sr, start, stop)
    hop_ms = ocm.F0_TRACK_HOP_MS
    if rms.size == 0:
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0,
                "pause_longest_ms": 0, "pause_spans_ms": []}

    ref = float(np.max(rms))
    if ref <= 0.0:
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0,
                "pause_longest_ms": 0, "pause_spans_ms": []}
    active = rms > (ref * ocm.SILENCE_REL_THRESHOLD)
    idx = np.nonzero(active)[0]
    if idx.size == 0:
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0,
                "pause_longest_ms": 0, "pause_spans_ms": []}

    first, last = int(idx[0]), int(idx[-1])
    speech_ms = int(round((last - first + 1) * hop_ms))

    count = 0
    total = 0
    longest = 0
    run = 0
    spans = []          # 쉼이 **어디에** 있었는지. v3 시간축 프로필이 이 좌표를 쓴다.
    for k in range(first, last + 1):
        if not active[k]:
            run += 1
        else:
            if run > 0:
                count += 1
                total += run
                longest = max(longest, run)
                spans.append([round((k - run - first) * hop_ms, 1),
                              round((k - first) * hop_ms, 1)])
            run = 0
    # 마지막 활성 프레임에서 끝나므로 안쪽 run 은 항상 닫힌다(꼬리 처리 불필요).

    return {
        "speech_ms": speech_ms,
        "pause_count": int(count),
        "pause_total_ms": int(round(total * hop_ms)),
        "pause_longest_ms": int(round(longest * hop_ms)),
        # 좌표는 발화 시작(first) 기준 ms. 개수·합계와 같은 자에서 나온다(두 번 재지 않는다).
        "pause_spans_ms": spans,
    }


def measure_spectral_tilt(signal, sr, start=0, stop=None):
    """스펙트럼 기울기(dB) — mel 대역 상위 절반 대 하위 절반의 에너지 비.

    분할점은 mel 대역 개수의 중점이다(구조적 분할 — 내가 고른 주파수 숫자가 아니다).
    값이 낮을수록 고역이 약하다(어둡다). 좋다/나쁘다를 뜻하지 않는다.
    """
    import math
    import numpy as np
    import onset_continuity_metrics as ocm

    s = np.asarray(signal, dtype=np.float64)
    lo = max(0, int(start))
    hi = s.size if stop is None else min(s.size, int(stop))
    if hi - lo <= 0:
        return 0.0

    frame = max(2, ocm.ms_to_samples(ocm.F0_TRACK_FRAME_MS, sr))
    hop = max(1, ocm.ms_to_samples(ocm.F0_TRACK_HOP_MS, sr))
    if hi - lo < frame:
        return 0.0

    fb = ocm.mel_filterbank(int(sr))
    n = 1 + (hi - lo - frame) // hop
    acc = np.zeros(ocm.MEL_N_MELS, dtype=np.float64)
    used = 0
    for k in range(n):
        a = lo + k * hop
        win = s[a:a + frame]
        if ocm.rms_of(win) <= 0.0:
            continue
        # mel_spectrum 은 log 값을 준다 → 선형으로 되돌려 평균한다(에너지 비를 재야 하므로).
        acc += np.exp(ocm.mel_spectrum(win, int(sr), filterbank=fb))
        used += 1
    if used == 0:
        return 0.0
    acc /= used
    mid = ocm.MEL_N_MELS // 2
    low = float(np.sum(acc[:mid]))
    high = float(np.sum(acc[mid:]))
    if low <= 0.0 or high <= 0.0:
        return 0.0
    return float(10.0 * math.log10(high / low))


def measure_emotion_acoustic_profile(signal, sr, start=0, stop=None, transcript_chars=0):
    """클립 하나 → 감정 음향 프로필(EMOTION_ACOUSTIC_PROFILE_FIELDS).

    transcript_chars: 참조 전사문의 **글자 수**(정수). 전사문 자체는 받지 않는다 —
      말 속도를 재려면 개수만 있으면 되고, 원문은 이 레코드에 들어갈 수 없기 때문이다.
      0 이면 speech_rate_available=0 이고 speech_rate_cps 는 0.0 이다(없는 값을 지어내지 않는다).

    ⚠️ 판정하지 않는다. 목표치도 아니다. 두 클립을 같은 자로 재기 위한 서술이다.
    """
    import numpy as np
    import onset_continuity_metrics as ocm

    s = np.asarray(signal, dtype=np.float64)
    if s.ndim != 1:
        raise EmotionAcousticError("mono(1-D) only: ndim=%d" % s.ndim)
    lo = max(0, int(start))
    hi = s.size if stop is None else min(s.size, int(stop))

    prosody = ocm.prosody_profile(s, sr, lo, hi)
    pause = measure_pause(s, sr, lo, hi)
    tilt = measure_spectral_tilt(s, sr, lo, hi)

    chars = int(transcript_chars or 0)
    speech_sec = float(pause["speech_ms"]) / 1000.0
    if chars > 0 and speech_sec > 0.0:
        rate, rate_available = float(chars) / speech_sec, 1
    else:
        rate, rate_available = 0.0, 0

    rec = {
        "sample_rate": int(prosody["sample_rate"]),
        "analysis_samples": int(prosody["analysis_samples"]),
        "f0_q50_hz": float(prosody["f0_q50_hz"]),
        "f0_range_semitones": float(prosody["f0_range_semitones"]),
        "f0_iqr_semitones": float(prosody["f0_iqr_semitones"]),
        "f0_std_semitones": float(prosody["f0_std_semitones"]),
        "voiced_ratio": float(prosody["voiced_ratio"]),
        "rms_q50": float(prosody["rms_q50"]),
        "rms_range_db": float(prosody["rms_range_db"]),
        "speech_ms": int(pause["speech_ms"]),
        "pause_count": int(pause["pause_count"]),
        "pause_total_ms": int(pause["pause_total_ms"]),
        "pause_longest_ms": int(pause["pause_longest_ms"]),
        "spectral_tilt_db": float(tilt),
        "speech_rate_cps": rate,
        "speech_rate_available": rate_available,
    }
    assert tuple(rec.keys()) == EMOTION_ACOUSTIC_PROFILE_FIELDS
    return rec


def profile_from_prosody_profile(prosody, pause=None, spectral_tilt_db=0.0, transcript_chars=0):
    """이미 뽑아 둔 prosody_profile 레코드를 감정 음향 프로필로 승격한다.

    기존 분석 산출물(analysis.json 등)을 다시 합성하지 않고 재사용하기 위한 어댑터다.
    없는 값은 0 으로 두고 available 플래그로 '없음'을 표시한다 — 추정해 채우지 않는다.
    """
    pause = pause or {}
    speech_ms = int(pause.get("speech_ms", 0))
    chars = int(transcript_chars or 0)
    speech_sec = float(speech_ms) / 1000.0
    if chars > 0 and speech_sec > 0.0:
        rate, rate_available = float(chars) / speech_sec, 1
    else:
        rate, rate_available = 0.0, 0

    rec = {
        "sample_rate": int(prosody["sample_rate"]),
        "analysis_samples": int(prosody["analysis_samples"]),
        "f0_q50_hz": float(prosody["f0_q50_hz"]),
        "f0_range_semitones": float(prosody["f0_range_semitones"]),
        "f0_iqr_semitones": float(prosody["f0_iqr_semitones"]),
        "f0_std_semitones": float(prosody["f0_std_semitones"]),
        "voiced_ratio": float(prosody["voiced_ratio"]),
        "rms_q50": float(prosody["rms_q50"]),
        "rms_range_db": float(prosody["rms_range_db"]),
        "speech_ms": speech_ms,
        "pause_count": int(pause.get("pause_count", 0)),
        "pause_total_ms": int(pause.get("pause_total_ms", 0)),
        "pause_longest_ms": int(pause.get("pause_longest_ms", 0)),
        "spectral_tilt_db": float(spectral_tilt_db),
        "speech_rate_cps": rate,
        "speech_rate_available": rate_available,
    }
    assert tuple(rec.keys()) == EMOTION_ACOUSTIC_PROFILE_FIELDS
    return rec


# ─────────────────────────────────────────────────────────────────────────────
# 8. 시간축 감정 프로필 v3 — "이 감정이 시간에 따라 어떻게 움직이는가"
#
# v2 와 무엇이 다른가
# -------------------
#   v2 = 클립 하나의 **요약 통계**(중앙·범위·IQR). 두 클립을 같은 자로 재기 위한 값이다.
#   v3 = 같은 클립의 **시간축 곡선**. 대상 대사에 옮기려면 "언제 올라가고 언제 쉬는지"가
#        있어야 하고, 요약 통계에는 그 정보가 없다.
#
# 무엇을 하지 않는가
# ------------------
#   · 절대값을 옮기지 않는다. F0 는 **화자 중앙값 기준 semitone delta**, 에너지는 **중앙값을
#     뺀 상대 dB** 다. 원본의 음역과 파일 gain 은 프로필에 들어오지 않는다.
#   · 원본 프레임을 통째로 저장하지 않는다. 시간 정규화(0~1) 축약 좌표만 남긴다.
#   · gain 자동화 명령을 만들지 않는다. 상대 에너지는 **강세 후보를 찾는 분석값**이다.
#   · time-warp 를 실행하지 않는다. 계획(anchor)만 만든다.
#   · 판정하지 않는다. 못 잰 축은 숫자를 지어내지 않고 insufficient/unsupported 로 답한다.
#   · 원문 대사·절대경로를 담지 않는다.
#
# 재사용
# ------
#   프레임 격자·F0·RMS 는 `onset_continuity_metrics` 하나뿐이다(f0_track / frame_rms_track 는
#   같은 격자라 인덱스가 1:1 이다). 쉼은 이 모듈의 measure_pause 를 그대로 쓴다.
#   새 분석기를 만들지 않는다.
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_PROFILE_V3_VERSION = 3
EMOTION_PROFILE_V3_SCHEMA = "af-emotion-profile/3"

#: 요청 하나가 파이프라인의 **어디까지 갔는가**. 앞 단계를 뒤 단계로 승격해 적지 않는다.
#: 특히 참조 구간만 고른 것은 `reference_matched` 이며 `model_applied` 가 아니다.
EMOTION_APPLICATION_STATES = (
    "requested",           # 사용자가 요구한 감정
    "analyzed",            # 참조에서 프로필을 측정했다
    "reference_matched",   # 그 프로필로 참조 구간을 골랐다
    "model_applied",       # 모델에 실제 제어값을 전달했다
    "post_applied",        # 후처리로 실제 적용했다
    "unsupported",         # 적용 통로가 없다
)

#: 축 하나를 **얼마나 잴 수 있었는가**. 적용 상태와 다른 축이다.
AXIS_MEASUREMENT_STATES = (
    "analyzed",       # 잴 수 있었다
    "approximate",    # 재긴 했으나 해상도가 낮다(예: 음절이 아니라 단어 단위)
    "insufficient",   # 자료가 모자라 숫자를 내지 않는다
    "unsupported",    # 검출기가 없다
)

PROFILE_V3_AXES = ("relative_f0", "relative_energy", "rhythm", "pause_tail", "trajectory")

#: 축약 좌표 개수. 원본 프레임 대신 이 개수만큼 시간 정규화 지점을 남긴다.
PROFILE_V3_ANCHORS = 16
#: 유성 프레임이 이보다 적으면 F0 축을 insufficient 로 둔다(숫자를 지어내지 않는다).
PROFILE_V3_MIN_VOICED_FRAMES = 8
#: 유성 비율이 이보다 낮으면 경고를 단다(값은 내되 신뢰도를 낮춘다).
PROFILE_V3_LOW_VOICED_RATIO = 0.35
#: 상대 에너지에서 강세 후보로 볼 문턱(중앙값 대비 dB).
PROFILE_V3_STRESS_DB = 3.0

#: 이 클립이 어디서 왔는가. 호출부가 아는 사실이고, 분석기가 추측하지 않는다.
#:   clean_speech    — 말만 녹음된 자료
#:   separated_stem  — 음악에서 분리한 보컬. 잔향·반주 누출이 남아 있을 수 있다
#:   unknown         — 출처를 모른다(기본값)
SOURCE_KINDS = ("unknown", "clean_speech", "separated_stem")

WARN_LOW_VOICED_RATIO = "LOW_VOICED_RATIO"
WARN_ASR_ABSENT = "ASR_TIMING_ABSENT"
WARN_BACKGROUND_OR_REVERB = "BACKGROUND_OR_REVERB_POSSIBLE"
WARN_SHORT_CLIP = "SHORT_CLIP"
WARN_SEPARATED_STEM = "SEPARATED_STEM_SOURCE"

PROFILE_V3_WARNINGS = (WARN_LOW_VOICED_RATIO, WARN_ASR_ABSENT,
                       WARN_BACKGROUND_OR_REVERB, WARN_SHORT_CLIP,
                       WARN_SEPARATED_STEM)


def quality_baseline_eligible(source_kind, warnings):
    """이 프로필을 **감정 기준(golden)** 으로 삼아도 되는가.

    음악에서 분리한 보컬은 안 된다 — 반주가 남긴 잔향이 연기로 측정된다. 출처를 모르는
    클립도 안 된다(모르는 것을 깨끗하다고 볼 수는 없다). 배경음·잔향 의심이나 유성 비율
    경고가 붙은 클립도 기준이 되지 못한다.

    자격이 없다고 해서 쓸 수 없다는 뜻은 아니다 — 결정성·스키마 검증에는 그대로 쓴다.
    막는 것은 "이것이 그 감정의 표준이다"라고 말하는 일뿐이다.

    자동 dereverb·denoise·정규화로 자격을 만들어 내지 않는다. 그것은 잰 값을 바꾸는
    일이지 자료를 좋게 만드는 일이 아니다.
    """
    if source_kind != "clean_speech":
        return False
    blocking = {WARN_BACKGROUND_OR_REVERB, WARN_LOW_VOICED_RATIO, WARN_SEPARATED_STEM}
    return not (blocking & set(warnings or ()))


def _resample_anchors(values, positions, count=PROFILE_V3_ANCHORS):
    """시간 정규화 곡선을 고정 개수 좌표로 줄인다.

    원본 프레임을 저장하지 않기 위한 것이고, 같은 곡선이면 길이가 달라도 같은 좌표가 나온다
    (시간축을 늘려도 정규화 위치가 보존된다는 뜻이다).
    """
    import numpy as np
    if len(values) == 0:
        return []
    t = np.linspace(0.0, 1.0, count)
    x = np.asarray(positions, dtype=np.float64)
    y = np.asarray(values, dtype=np.float64)
    if x.size == 1:
        return [[round(float(tt), 4), round(float(y[0]), 3)] for tt in t]
    return [[round(float(tt), 4), round(float(np.interp(tt, x, y)), 3)] for tt in t]


def _turning_points(anchors, min_delta=1.0):
    """방향이 바뀌는 지점. 곡선의 모양을 몇 개의 사실로 요약한다."""
    out = []
    for i in range(1, len(anchors) - 1):
        prev, cur, nxt = anchors[i - 1][1], anchors[i][1], anchors[i + 1][1]
        if (cur - prev) * (nxt - cur) < 0 and max(abs(cur - prev), abs(nxt - cur)) >= min_delta:
            out.append([anchors[i][0], round(cur, 3)])
    return out


def _active_mask(rms):
    """말이 실제로 있는 프레임. **에너지 기준**이며 gain 에 흔들리지 않는다.

    왜 필요한가: 자기상관은 거의 무음인 구간에서도 이따금 유성 판정을 낸다. 그 프레임이
    곡선에 섞이면 없는 억양이 생긴다(실측: 같은 음률을 음역만 올렸을 때 무음 구간에서
    유령 유성 프레임이 잡혀 곡선이 5 반음 넘게 튀었다).

    문턱은 새로 만들지 않고 `onset_continuity_metrics.SILENCE_REL_THRESHOLD` 를 쓴다 —
    구간 최대 RMS 대비 상대값이라 파일 gain 이 바뀌어도 같은 프레임이 남는다.
    """
    import numpy as np
    import onset_continuity_metrics as ocm
    if rms.size == 0:
        return np.zeros(0, dtype=bool)
    ref = float(np.max(rms))
    if ref <= 0.0:
        return np.zeros(rms.size, dtype=bool)
    return rms > (ref * ocm.SILENCE_REL_THRESHOLD)


def _relative_f0_axis(f0, rms, reference_median_hz=None):
    """화자 기준 semitone delta 곡선. 절대 Hz 를 남기지 않는다.

    기준(중앙값)을 빼기 때문에 음역이 통째로 옮겨져도 곡선이 같다 — 다른 화자의 연기를
    옮기려면 이 성질이 필요하다.
    """
    import numpy as np
    # 유성이면서 **에너지가 있는** 프레임만 쓴다. 둘 중 하나만으로는 유령 프레임이 남는다.
    voiced = (f0 > 0.0) & _active_mask(rms)
    n_voiced = int(np.count_nonzero(voiced))
    if n_voiced < PROFILE_V3_MIN_VOICED_FRAMES:
        return {"state": "insufficient", "reason": "VOICED_FRAMES_TOO_FEW",
                "voiced_frames": n_voiced, "voiced_ratio": round(
                    float(n_voiced) / max(1, f0.size), 4)}, []
    hz = f0[voiced]
    median_hz = float(np.median(hz)) if reference_median_hz is None else float(reference_median_hz)
    if median_hz <= 0.0:
        return {"state": "insufficient", "reason": "REFERENCE_MEDIAN_INVALID"}, []
    semis = 12.0 * np.log2(hz / median_hz)
    pos = np.nonzero(voiced)[0].astype(np.float64)
    pos = (pos - pos.min()) / max(1e-9, (pos.max() - pos.min()))
    anchors = _resample_anchors(semis, pos)
    ratio = float(n_voiced) / max(1, f0.size)
    return {
        "state": "analyzed",
        # 기준 Hz 는 **재현용 한 값**이다. 곡선 자체는 이 값과 무관하게 상대값이다.
        "reference_median_hz": round(median_hz, 2),
        "voiced_frames": n_voiced,
        "voiced_ratio": round(ratio, 4),
        "confidence": round(min(1.0, ratio / max(1e-9, PROFILE_V3_LOW_VOICED_RATIO)), 3),
        "semitone_anchors": anchors,
        "range_semitones": round(float(np.percentile(semis, 95) - np.percentile(semis, 5)), 3),
        "iqr_semitones": round(float(np.percentile(semis, 75) - np.percentile(semis, 25)), 3),
        "turning_points": _turning_points(anchors),
    }, anchors


def _relative_energy_axis(rms):
    """중앙값을 뺀 상대 dB 곡선. 파일 gain 이 통째로 바뀌어도 값이 같다.

    DC 는 프레임 RMS 이전에 제거하고(호출부), peak 정규화는 하지 않는다 — 그래서 이 곡선은
    **gain 자동화가 아니라 강세 후보**다. gain 명령으로 바꾸지 않는다.
    """
    import numpy as np
    keep = _active_mask(rms)
    active = rms[keep]
    if active.size < PROFILE_V3_MIN_VOICED_FRAMES:
        return {"state": "insufficient", "reason": "ACTIVE_FRAMES_TOO_FEW"}
    db = 20.0 * np.log10(np.maximum(rms, 1e-12))
    med = float(np.median(20.0 * np.log10(active)))
    rel = db - med
    pos = np.nonzero(keep)[0].astype(np.float64)
    pos = (pos - pos.min()) / max(1e-9, (pos.max() - pos.min()))
    anchors = _resample_anchors(rel[keep], pos)
    stress = [[a[0], a[1]] for a in anchors if a[1] >= PROFILE_V3_STRESS_DB]
    return {
        "state": "analyzed",
        "median_removed": True,
        "dc_offset_removed": True,
        "peak_normalized": False,
        "relative_db_anchors": anchors,
        "stress_candidates": stress,
        "stress_threshold_db": PROFILE_V3_STRESS_DB,
        # 이 축이 무엇이 아닌지 프로필 안에 적어 둔다 — 소비자가 gain 으로 오해하면 안 된다.
        "not_a_gain_command": True,
    }


def _rhythm_axis(word_timings, speech_ms):
    """리듬·길이. 기존 ASR word timing 을 그대로 쓴다(새 정렬기 없음).

    한국어 음절 분해는 이 저장소에 없다. 그래서 **단어·발화 anchor 까지만** 지원하고
    상태를 `approximate` 로 밝힌다 — 음절 단위인 척하지 않는다.
    """
    if not word_timings:
        return {"state": "unsupported", "reason": "ASR_TIMING_ABSENT",
                "granularity": None}
    spans = [(float(w["start"]), float(w["end"])) for w in word_timings
             if float(w["end"]) > float(w["start"])]
    if len(spans) < 2:
        return {"state": "insufficient", "reason": "TOO_FEW_WORDS",
                "granularity": "word", "word_count": len(spans)}
    total = spans[-1][1] - spans[0][0]
    if total <= 0:
        return {"state": "insufficient", "reason": "ZERO_SPAN", "granularity": "word"}
    durations = [e - s for s, e in spans]
    mean_dur = sum(durations) / len(durations)
    ratios = [round(d / mean_dur, 3) for d in durations]
    # 발화 속도 변화 — 앞·뒤 절반의 단어당 시간 비.
    half = len(durations) // 2
    first = sum(durations[:half]) / max(1, half)
    second = sum(durations[half:]) / max(1, len(durations) - half)
    return {
        "state": "approximate",
        "granularity": "word",
        "why_approximate": "음절 분해기가 없어 단어 anchor 까지만 잰다",
        "word_count": len(spans),
        "duration_ratios": ratios,
        "position_anchors": [round((s - spans[0][0]) / total, 4) for s, _e in spans],
        "rate_change_ratio": round(second / first, 3) if first > 0 else None,
    }


def _pause_tail_axis(f0, rms, sr, hop_ms, pause_record, total_ms):
    """쉼과 말끝. 호흡은 검출기가 없으므로 무음과 같다고 말하지 않는다."""
    import numpy as np
    pauses = []
    for span in (pause_record.get("pause_spans_ms") or ()):
        a, b = float(span[0]), float(span[1])
        pauses.append({
            "start_norm": round(a / max(1.0, total_ms), 4),
            "end_norm": round(b / max(1.0, total_ms), 4),
            "duration_ms": int(round(b - a)),
        })
    voiced = np.nonzero((f0 > 0.0) & _active_mask(rms))[0]
    tail = {"state": "insufficient", "reason": "NO_VOICED_TAIL"}
    if voiced.size >= PROFILE_V3_MIN_VOICED_FRAMES:
        k = max(1, int(voiced.size * 0.2))
        last, first = voiced[-k:], voiced[:k]
        f_last, f_first = float(np.median(f0[last])), float(np.median(f0[first]))
        r_last = float(np.median(rms[last])), float(np.median(rms[first]))
        tail = {
            "state": "analyzed",
            "final_f0_delta_semitones": round(12.0 * math.log2(max(1e-9, f_last)
                                                               / max(1e-9, f_first)), 3),
            "final_energy_delta_db": round(20.0 * math.log10(max(1e-12, r_last[0])
                                                             / max(1e-12, r_last[1])), 2),
            "final_voiced_ms": int(round(k * hop_ms)),
        }
    return {
        "state": "analyzed" if pauses or tail["state"] == "analyzed" else "insufficient",
        "pauses": pauses,
        "pause_count": len(pauses),
        "final_voiced": tail,
        # 호흡은 에너지만으로 무음과 구분되지 않는다. 검출기가 생기기 전에는 없다고 말한다.
        "breath": {"state": "unsupported", "reason": "NO_BREATH_DETECTOR",
                   "note": "무음과 호흡을 같은 것으로 판정하지 않는다"},
    }


def _trajectory_axis(f0_anchors, energy_axis):
    """발화 전체를 0~1 로 놓고 본 움직임. **time-warp 를 실행하지 않는다** — 계획만 만든다."""
    if not f0_anchors:
        return {"state": "insufficient", "reason": "NO_F0_CURVE",
                "time_warp_plan": {"executed": False, "reason": "NO_CURVE"}}
    e_anchors = energy_axis.get("relative_db_anchors") or []

    def at(anchors, t):
        if not anchors:
            return None
        best = min(anchors, key=lambda a: abs(a[0] - t))
        return best[1]

    return {
        "state": "analyzed",
        "normalized_time": True,
        "start_mid_end": {
            "f0_semitones": [at(f0_anchors, 0.0), at(f0_anchors, 0.5), at(f0_anchors, 1.0)],
            "relative_db": [at(e_anchors, 0.0), at(e_anchors, 0.5), at(e_anchors, 1.0)],
        },
        "turning_points": _turning_points(f0_anchors),
        # 대상 대사에 이을 자리. 길이가 다른 대사에도 붙일 수 있게 정규화 좌표로만 둔다.
        "target_anchors": [a[0] for a in f0_anchors],
        "time_warp_plan": {
            "executed": False,
            "reason": "PHASE_E1_ANALYSIS_ONLY",
            "note": "적용 통로 결정 전까지 계획만 만든다(청취 승인 없이 production 금지)",
        },
    }


def analyze_profile_v3(signal, sr, source_id=None, source_sha256=None,
                       word_timings=None, reference_median_hz=None, transcript_chars=0,
                       source_kind="unknown"):
    """클립 하나 → 시간축 감정 프로필 v3.

    signal: mono float 배열. `sr`: 표본율.
    source_id/source_sha256: 어느 자산에서 나왔는지(**경로가 아니라 id 와 SHA**).
    word_timings: [{start, end}] 초 단위. 없으면 리듬 축이 unsupported 다(지어내지 않는다).
    reference_median_hz: 화자 기준 F0. 주면 그 기준으로 상대화한다(다른 화자의 연기를 옮길 때).
    source_kind: `SOURCE_KINDS` 중 하나. 호출부가 아는 사실이며 분석기가 추측하지 않는다.

    판정하지 않는다. 못 잰 축은 숫자를 내지 않는다.
    """
    import numpy as np
    import onset_continuity_metrics as ocm

    x = np.asarray(signal, dtype=np.float64)
    if x.ndim != 1:
        raise EmotionAcousticError("mono(1-D) only: ndim=%d" % x.ndim)
    # DC 를 먼저 뺀다 — 상대 에너지가 DC 오프셋에 흔들리면 안 된다.
    x = x - float(np.mean(x)) if x.size else x

    hop_ms = ocm.F0_TRACK_HOP_MS
    f0 = ocm.f0_track(x, sr)
    rms = ocm.frame_rms_track(x, sr)
    n = min(f0.size, rms.size)
    f0, rms = f0[:n], rms[:n]

    if source_kind not in SOURCE_KINDS:
        raise EmotionAcousticError("unknown source_kind")
    warnings = []
    if source_kind == "separated_stem":
        # 음악에서 뜯어낸 목소리다 — 반주 잔향이 남아 있을 수 있다는 사실을 프로필에 붙인다.
        warnings.append(WARN_SEPARATED_STEM)
    total_ms = 1000.0 * x.size / max(1, sr)
    if total_ms < 1000.0:
        warnings.append(WARN_SHORT_CLIP)
    if not word_timings:
        warnings.append(WARN_ASR_ABSENT)

    f0_axis, f0_anchors = _relative_f0_axis(f0, rms, reference_median_hz)
    if f0_axis.get("state") == "analyzed" and f0_axis["voiced_ratio"] < PROFILE_V3_LOW_VOICED_RATIO:
        warnings.append(WARN_LOW_VOICED_RATIO)
    energy_axis = _relative_energy_axis(rms)
    pause_rec = measure_pause(x, sr)
    rhythm_axis = _rhythm_axis(word_timings, pause_rec.get("speech_ms", 0))
    pause_axis = _pause_tail_axis(f0, rms, sr, hop_ms, pause_rec, total_ms)
    traj_axis = _trajectory_axis(f0_anchors, energy_axis)

    # 배경음·잔향 가능성 — 무음 구간의 에너지가 바닥에서 충분히 떨어지지 않으면 의심한다.
    if rms.size:
        floor = float(np.percentile(rms, 5))
        peak = float(np.percentile(rms, 95))
        if floor > 0 and peak > 0 and 20.0 * math.log10(peak / floor) < 25.0:
            warnings.append(WARN_BACKGROUND_OR_REVERB)

    axes = {
        "relative_f0": f0_axis["state"],
        "relative_energy": energy_axis["state"],
        "rhythm": rhythm_axis["state"],
        "pause_tail": pause_axis["state"],
        "trajectory": traj_axis["state"],
    }
    profile = {
        "schema": EMOTION_PROFILE_V3_SCHEMA,
        "profile_version": EMOTION_PROFILE_V3_VERSION,
        "axes": axes,
        "relative_f0": f0_axis,
        "relative_energy": energy_axis,
        "rhythm": rhythm_axis,
        "pause_tail": pause_axis,
        "trajectory": traj_axis,
        "provenance": {
            # 경로가 아니라 id 와 SHA 만 남긴다. 원문 대사는 어디에도 없다.
            "source_id": source_id,
            "source_sha256": source_sha256,
            "analyzer": "emotion_acoustic.analyze_profile_v3",
            "analyzer_version": EMOTION_PROFILE_V3_VERSION,
            "metrics_module": "onset_continuity_metrics",
            "params": {
                "frame_ms": ocm.F0_TRACK_FRAME_MS, "hop_ms": hop_ms,
                "f0_min_hz": ocm.F0_MIN_HZ, "f0_max_hz": ocm.F0_MAX_HZ,
                "anchors": PROFILE_V3_ANCHORS,
                "min_voiced_frames": PROFILE_V3_MIN_VOICED_FRAMES,
                "stress_db": PROFILE_V3_STRESS_DB,
            },
            "sample_rate": int(sr),
            "analysis_ms": int(round(total_ms)),
            "source_kind": source_kind,
            # 이 프로필을 그 감정의 "표준"으로 삼아도 되는가. 잔향 의심이 붙은 클립과
            # 출처를 모르는 클립은 기준이 되지 못한다(쓰지 못한다는 뜻은 아니다).
            "quality_baseline_eligible": quality_baseline_eligible(
                source_kind, sorted(set(warnings))),
            "warnings": sorted(set(warnings)),
        },
    }
    profile["profile_id"] = profile_v3_id(profile)
    return profile


def profile_v3_id(profile):
    """프로필 내용에서 나오는 불투명 id. 같은 입력이면 같은 값이다."""
    import hashlib
    body = {k: v for k, v in profile.items() if k != "profile_id"}
    prov = dict(body.get("provenance") or {})
    body = dict(body, provenance=prov)
    return "ep3_" + hashlib.sha256(
        _canonical_json(body).encode("utf-8")).hexdigest()[:16]


def _canonical_json(v):
    """결정적 직렬화(키 정렬·공백 없음). float 은 반올림된 값만 들어온다."""
    import json
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# ─────────────────────────────────────────────────────────────────────────────
# 9. 프로필 대조 — "이 후보가 요청한 감정처럼 들리는가" (PHASE E2)
#
#   축을 새로 만들지 않는다. 8절이 이미 낸 v3 프로필 두 개를 놓고 **거리**만 잰다.
#   비교 가능한 축만 점수에 들어가고, 못 잰 축은 0 점이 아니라 **제외**다(모르는 것을
#   나쁘다고 적으면 후보 순위가 자료 부족에 좌우된다).
#
#   여기서 만드는 것은 점수뿐이다. 어느 참조를 쓸지 정하는 것은 speaker_refs 의 몫이고,
#   모델에 무엇을 넘기는지와는 아무 관계가 없다.
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_MATCH_SCHEMA = "af-emotion-match/1"
EMOTION_MATCH_VERSION = 1

#: 축 가중치. F0 곡선과 전체 궤적이 감정 연기의 대부분을 지고, 강세·쉼이 보조한다.
#: 리듬은 단어 해상도까지만 재므로 애초에 낮다(게다가 approximate 감쇄를 또 받는다).
PROFILE_MATCH_WEIGHTS = {
    "relative_f0": 0.35,
    "trajectory": 0.30,
    "relative_energy": 0.15,
    "pause_tail": 0.15,
    "rhythm": 0.05,
}

#: approximate 축의 가중치 감쇄. 재긴 했으나 해상도가 낮다는 사실을 점수에 반영한다.
APPROXIMATE_WEIGHT_FACTOR = 0.25

#: 거리 → 유사도 환산 기준. 이만큼 차이 나면 유사도가 정확히 0.5 다.
MATCH_SCALE_SEMITONES = 3.0   # F0·궤적(반음)
MATCH_SCALE_DB = 4.0          # 상대 에너지(dB)
MATCH_SCALE_RATE = 0.30       # 리듬(앞뒤 속도비 차)

#: 축이 점수에서 빠진 이유(비민감 enum).
MATCH_AXIS_EXCLUDED = "excluded"
MATCH_EXCLUSION_REASONS = (
    "AXIS_NOT_MEASURED",     # 한쪽이라도 insufficient — 숫자가 없다
    "AXIS_UNSUPPORTED",      # 검출기가 없다(예: ASR 타이밍 부재)
    "AXIS_SHAPE_MISMATCH",   # 좌표 개수가 달라 같은 자리끼리 뺄 수 없다
)

_COMPARABLE_STATES = ("analyzed", "approximate")


def _similarity(distance):
    """거리(척도 단위) → 0~1 유사도. `distance == 1` 이면 0.5.

    지수가 아니라 `1/(1+d)` 인 이유는 큰 차이에서도 순위가 무너지지 않게 하기 위해서다 —
    유사도가 바닥에 눌리면 명백히 다른 두 후보가 같은 점수로 보인다.
    """
    d = max(0.0, float(distance))
    return 1.0 / (1.0 + d)


def _rms_delta(a, b):
    """같은 자리 좌표끼리의 RMS 차. 길이가 다르면 None(맞춰 늘이지 않는다)."""
    if not a or not b or len(a) != len(b):
        return None
    total = 0.0
    for pa, pb in zip(a, b):
        total += (float(pa[1]) - float(pb[1])) ** 2
    return math.sqrt(total / len(a))


def _axis_pair_state(target_axis, candidate_axis):
    """두 축을 함께 쓸 수 있는가. 못 쓰면 (None, 사유)."""
    ts = (target_axis or {}).get("state")
    cs = (candidate_axis or {}).get("state")
    for s in (ts, cs):
        if s == "unsupported":
            return None, "AXIS_UNSUPPORTED"
        if s not in _COMPARABLE_STATES:
            return None, "AXIS_NOT_MEASURED"
    # 한쪽이라도 approximate 면 축 전체를 approximate 로 본다(높은 쪽을 믿지 않는다).
    return ("approximate" if "approximate" in (ts, cs) else "analyzed"), None


def _distance_relative_f0(t, c):
    d = _rms_delta(t.get("semitone_anchors"), c.get("semitone_anchors"))
    if d is None:
        return None
    return d / MATCH_SCALE_SEMITONES


def _distance_relative_energy(t, c):
    d = _rms_delta(t.get("relative_db_anchors"), c.get("relative_db_anchors"))
    if d is None:
        return None
    return d / MATCH_SCALE_DB


def _distance_trajectory(t, c):
    """시작·중간·끝 F0 와 방향 전환 횟수. 곡선의 '모양'을 본다."""
    ta = ((t.get("start_mid_end") or {}).get("f0_semitones")) or []
    ca = ((c.get("start_mid_end") or {}).get("f0_semitones")) or []
    if len(ta) != 3 or len(ca) != 3 or any(v is None for v in ta + ca):
        return None
    sq = sum((float(x) - float(y)) ** 2 for x, y in zip(ta, ca)) / 3.0
    base = math.sqrt(sq) / MATCH_SCALE_SEMITONES
    # 방향 전환 횟수 차 — 한 번 차이를 0.5 반음쯤의 무게로 본다.
    turns = abs(len(t.get("turning_points") or []) - len(c.get("turning_points") or []))
    return base + (turns * 0.5) / MATCH_SCALE_SEMITONES


def _distance_pause_tail(t, c):
    """쉼의 개수와 말끝 처리. 둘 다 길이에 무관한 형태로 만든다."""
    tc, cc = int(t.get("pause_count") or 0), int(c.get("pause_count") or 0)
    denom = max(1, tc, cc)
    d_pause = abs(tc - cc) / float(denom)
    tt, ct = t.get("final_voiced") or {}, c.get("final_voiced") or {}
    if tt.get("state") == "analyzed" and ct.get("state") == "analyzed":
        d_tail = abs(float(tt["final_f0_delta_semitones"])
                     - float(ct["final_f0_delta_semitones"])) / MATCH_SCALE_SEMITONES
        return 0.5 * d_pause + 0.5 * d_tail
    # 말끝을 못 쟀으면 쉼만으로 판단한다(없는 값을 0 으로 채우지 않는다).
    return d_pause


def _distance_rhythm(t, c):
    tr, cr = t.get("rate_change_ratio"), c.get("rate_change_ratio")
    if tr is None or cr is None:
        return None
    return abs(float(tr) - float(cr)) / MATCH_SCALE_RATE


_AXIS_DISTANCE = {
    "relative_f0": _distance_relative_f0,
    "relative_energy": _distance_relative_energy,
    "rhythm": _distance_rhythm,
    "pause_tail": _distance_pause_tail,
    "trajectory": _distance_trajectory,
}


def compare_profiles_v3(target, candidate):
    """v3 프로필 두 개 → 축별 유사도와 종합 점수.

    target: 요청한 감정의 기준 프로필. candidate: 후보 참조에서 잰 프로필.
    둘 다 `analyze_profile_v3` 가 낸 모양이어야 한다.

    반환에는 **점수와 축 이름만** 담긴다 — 경로·표시 이름·대사가 들어갈 자리가 없다.
    비교할 축이 하나도 없으면 `score` 는 None 이다(0 이 아니다 — 0 은 '많이 다르다'는
    뜻이고, 여기서는 '모른다'가 사실이다).
    """
    if not isinstance(target, dict) or not isinstance(candidate, dict):
        raise EmotionAcousticError("profile dict required")
    axes, excluded = {}, []
    weighted, weight_total = 0.0, 0.0
    for axis in PROFILE_V3_AXES:
        t_axis, c_axis = target.get(axis) or {}, candidate.get(axis) or {}
        state, reason = _axis_pair_state(t_axis, c_axis)
        if state is None:
            excluded.append({"axis": axis, "reason": reason})
            continue
        distance = _AXIS_DISTANCE[axis](t_axis, c_axis)
        if distance is None:
            excluded.append({"axis": axis, "reason": "AXIS_SHAPE_MISMATCH"})
            continue
        weight = PROFILE_MATCH_WEIGHTS[axis]
        if state == "approximate":
            weight *= APPROXIMATE_WEIGHT_FACTOR
        sim = _similarity(distance)
        axes[axis] = {
            "state": state,
            "distance": round(float(distance), 4),
            "similarity": round(sim, 4),
            "weight": round(weight, 4),
        }
        if state == "approximate":
            axes[axis]["why_downweighted"] = "축 해상도가 낮아 가중치를 %.2f 배로 줄였다" % (
                APPROXIMATE_WEIGHT_FACTOR,)
        weighted += weight * sim
        weight_total += weight
    score = round(weighted / weight_total, 4) if weight_total > 0 else None
    return {
        "schema": EMOTION_MATCH_SCHEMA,
        "match_version": EMOTION_MATCH_VERSION,
        "score": score,
        "weight_total": round(weight_total, 4),
        "axes": axes,
        "axes_used": sorted(axes.keys()),
        "axes_excluded": excluded,
        "target_profile_id": target.get("profile_id"),
        "candidate_profile_id": candidate.get("profile_id"),
        # 이 값이 무엇이 아닌지 기록에 남긴다 — 점수는 참조 선택 근거일 뿐이고
        # 모델에 넘어가는 제어값이 아니다.
        "not_a_model_control": True,
    }
