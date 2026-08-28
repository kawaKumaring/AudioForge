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
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0, "pause_longest_ms": 0}

    ref = float(np.max(rms))
    if ref <= 0.0:
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0, "pause_longest_ms": 0}
    active = rms > (ref * ocm.SILENCE_REL_THRESHOLD)
    idx = np.nonzero(active)[0]
    if idx.size == 0:
        return {"speech_ms": 0, "pause_count": 0, "pause_total_ms": 0, "pause_longest_ms": 0}

    first, last = int(idx[0]), int(idx[-1])
    speech_ms = int(round((last - first + 1) * hop_ms))

    count = 0
    total = 0
    longest = 0
    run = 0
    for k in range(first, last + 1):
        if not active[k]:
            run += 1
        else:
            if run > 0:
                count += 1
                total += run
                longest = max(longest, run)
            run = 0
    # 마지막 활성 프레임에서 끝나므로 안쪽 run 은 항상 닫힌다(꼬리 처리 불필요).

    return {
        "speech_ms": speech_ms,
        "pause_count": int(count),
        "pause_total_ms": int(round(total * hop_ms)),
        "pause_longest_ms": int(round(longest * hop_ms)),
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
