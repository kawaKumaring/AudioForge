# -*- coding: utf-8 -*-
"""분할 예산과 생성 예산의 **단일 권위**.

왜 하나여야 하는가
------------------
예전에는 두 값이 따로 있었다. `generation_limit.max_segment_tokens()` 가 분할 상한(33)을,
`ABS_LIMIT`(256)이 생성 상한을 정했고 서로를 모르고 있었다. 그래서 분할 상한만 올리면
같은 입력이 생성 단계에서 `GENERATION_LIMIT_EXCEEDED` 로 실패했다 — 실측으로 확인한 결함이다.
여기서는 **예산 함수가 분할 상한을 낳는다.** 상한만 올리고 생성 예산은 그대로인 상태가
코드상 존재할 수 없다.

무엇을 함께 보는가
------------------
production tokens · 참조 조건(ICL 여부) · 예상 frame · reserve · 지원 tier ·
architecture headroom 을 한 번에 계산하고 `fits` 하나로 답한다.

예상 frame 의 근거
------------------
`FRAMES_PER_PRODUCTION_TOKEN` 은 vendor native ICL 실측 앵커다(250자 / production 191 token
-> 339 generated frame). 단일 표본 앵커이므로 회귀식으로 부르지 않고, 상한 쪽으로 여유를
두고 쓴다. 값이 갱신되면 provenance 를 함께 바꾼다.
"""
import math

import generation_limit

# 실측 앵커: vendor-icl-2/3 (250자, production 191 token -> 339 frame). 단일 표본이다.
FRAMES_PER_PRODUCTION_TOKEN = 1.984      # 자연 종료 실측 최대(sample4 572tok/1135frame)
FRAMES_ANCHOR_PROVENANCE = ("자연 종료 실측 4건 중 최대 비율: 191->339(1.775), 379->661(1.744), 563->1106(1.964), 572->1135(1.984). censored 관측 제외")

# 예상 frame 의 불확실성 여유. 상한 쪽으로만 둔다.
FRAME_UPPER_MARGIN = 1.25
RESERVE_FRAMES = 128

# 지원되는 생성 예산 단계. production 기본은 첫 tier 다.
BUDGET_TIERS = (256, 512, 768, 1024, 1536, 2048, 3072, 4096)

# talker architecture 상한(max_position_embeddings). prompt + generation 이 이 안에 있어야 한다.
ARCHITECTURE_LIMIT = 32768

# ── 참조 예산(출력 예산과 다른 축) ──────────────────────────────────────────
# Qwen3-TTS-12Hz: speech tokenizer 가 1초를 codec 12 frame 으로 만든다(모델 이름·tokenizer 규격).
CODEC_FRAMES_PER_SEC = 12.0
# 예전 고정값. controlled-prefix(legacy) 가 참조를 재발화할 때 필요한 프레임을 83 으로 못 박았는데,
# 이는 12Hz 에서 약 6.9초 참조를 **가정**한 값이었다(여유 예산이 아니라 참조 길이 가정). 실제 참조가
# 더 길면 예산이 모자라고, 짧으면 낭비다. 이제 예산은 실제 참조 codec 프레임 수로만 계산한다 — 기록용 상수.
LEGACY_REPLAY_FRAMES_ASSUMED = 83
LEGACY_REPLAY_ASSUMED_REF_SEC = round(LEGACY_REPLAY_FRAMES_ASSUMED / CODEC_FRAMES_PER_SEC, 2)


def estimate_ref_code_frames(duration_sec):
    """참조 길이(초) → codec 프레임 **추정**(모델 로딩 전 안내용). 예산 계산에는 쓰지 않는다 —
    예산은 모델의 speech tokenizer 가 실제로 낸 프레임 수(bridge._ref_code_frames)를 받는다."""
    if not isinstance(duration_sec, (int, float)) or duration_sec <= 0:
        return 0
    return int(math.ceil(float(duration_sec) * CODEC_FRAMES_PER_SEC))


def reference_budget(x_vector_only, ref_code_frames=None, ref_text_tokens=0, controlled_prefix=False):
    """참조가 이 chunk 의 예산에 미치는 몫. **유효 참조(실제 모델에 넘기는 클립)** 기준이다.

    - x-vector(safe_xvector): 참조 codec/전사가 talker 입력에 들어가지 않는다 → prompt 0, replay 0.
    - vendor native ICL: 참조 codec 프레임 + 참조 전사 토큰이 **prompt(입력 위치)** 를 차지한다. 재발화는 없다
      (vendor 가 ref_code 를 prefix 로 주고 생성분만 돌려준다) → replay 0.
    - controlled-prefix(legacy opt-in): 모델이 참조 대사를 먼저 **재발화**하므로 생성 프레임이 참조 프레임만큼
      더 필요하다 → replay = 실제 참조 codec 프레임(고정 83 아님). prompt 도 같은 몫을 차지한다.
    ICL 인데 참조 프레임 수를 모르면 ValueError — 추정값으로 예산을 열지 않는다(fail-closed).
    """
    if x_vector_only:
        return {"mode": "x_vector", "prefix_tokens": 0, "replay_frames": 0,
                "ref_code_frames": 0, "ref_text_tokens": 0}
    if not isinstance(ref_code_frames, int) or isinstance(ref_code_frames, bool) or ref_code_frames <= 0:
        raise ValueError("ICL 참조 예산에는 실제 참조 codec 프레임 수(양의 정수)가 필요하다, got %r" % (ref_code_frames,))
    text_tok = max(0, int(ref_text_tokens or 0))
    return {"mode": "icl_controlled_prefix" if controlled_prefix else "icl",
            "prefix_tokens": ref_code_frames + text_tok,
            "replay_frames": ref_code_frames if controlled_prefix else 0,
            "ref_code_frames": ref_code_frames, "ref_text_tokens": text_tok}


#: 자연 종료 실측의 frame/token 비 **구간**. 예산에는 상한(FRAMES_PER_PRODUCTION_TOKEN)을
#: 쓰지만, "결과 음성이 몇 초인가" 는 한 값으로 답할 수 없어 구간으로 낸다.
#: 191->339(1.775) / 379->661(1.744) / 563->1106(1.964) / 572->1135(1.984). censored 관측 제외.
AUDIO_FRAMES_PER_PRODUCTION_TOKEN_RANGE = (1.744, 1.984)


def predict_audio_frames(production_tokens):
    """**결과 음성** frame 구간. 예산 여유(FRAME_UPPER_MARGIN)를 섞지 않는다 —
    그 여유는 '생성이 넘치지 않게' 하려는 값이지 길이 추정이 아니다."""
    if not isinstance(production_tokens, int) or production_tokens <= 0:
        raise ValueError("production_tokens must be positive int, got %r" % (production_tokens,))
    lo, hi = AUDIO_FRAMES_PER_PRODUCTION_TOKEN_RANGE
    return {"min": lo * production_tokens, "max": hi * production_tokens}


def predict_frames(production_tokens):
    """production token 으로 목표 발화 frame 을 추정한다. 상한 쪽 값을 함께 낸다."""
    if not isinstance(production_tokens, int) or production_tokens <= 0:
        raise ValueError("production_tokens must be positive int, got %r" % (production_tokens,))
    base = FRAMES_PER_PRODUCTION_TOKEN * production_tokens
    return {"low": base, "high": base * FRAME_UPPER_MARGIN}


def _tier_for(required_frames):
    """required 이상인 최소 tier. 어떤 tier 로도 못 담으면 None."""
    for t in BUDGET_TIERS:
        if t >= required_frames:
            return t
    return None


def budget_for(production_tokens, reference_prefix_tokens=0, reference_replay_frames=0):
    """이 chunk 하나를 생성할 수 있는가, 있다면 생성 예산은 얼마인가.

    reference_replay_frames 는 controlled-prefix(legacy) 처럼 참조를 **재발화** 하는 경로에서만
    0 이 아니다. vendor native ICL 은 참조를 재발화하지 않으므로 0 이다.
    """
    if not isinstance(production_tokens, int) or production_tokens <= 0:
        raise ValueError("production_tokens must be positive int, got %r" % (production_tokens,))
    frames = predict_frames(production_tokens)
    predicted_high = frames["high"] + max(0, reference_replay_frames)
    required = predicted_high + RESERVE_FRAMES
    tier = _tier_for(required)
    combined = production_tokens + max(0, reference_prefix_tokens)
    headroom = ARCHITECTURE_LIMIT - (combined + (tier or 0))
    fits = tier is not None and headroom >= 0
    reason = None
    if tier is None:
        reason = "no_tier_fits"
    elif headroom < 0:
        reason = "architecture_headroom"
    return {
        "production_tokens": production_tokens,
        "combined_prompt_tokens": combined,
        "predicted_frames": {"low": round(frames["low"], 1), "high": round(frames["high"], 1)},
        "reference_replay_frames": max(0, reference_replay_frames),
        "required_frames": round(required, 1),
        "reserve_frames": RESERVE_FRAMES,
        "generation_limit": tier,
        "architecture_headroom": headroom,
        "fits": fits,
        "reason": reason,
        "frames_anchor_provenance": FRAMES_ANCHOR_PROVENANCE,
    }


# 안전 목표 = 품질 운영 상한의 절반. 근거: 정상 종료한 chunk 들은 512 tier 에서 218~235 반복(≈ 150 production
# token, 상한 379 의 40%)에 EOS 에 닿았고, 상한 실패 4건은 모두 상한 직전까지 채운 chunk 에서 났다(2026-09-04
# run 기록). 절반이면 문장·절 경계에서 먼저 끊어 폭주 노출 길이를 줄인다. hard 상한은 그대로다.
SAFE_FRACTION_OF_QUALITY_CEILING = 0.5
SAFE_PRODUCTION_TOKENS_FLOOR = 32


def safe_production_tokens():
    # 문장·절 경계에서 미리 끊는 안전 목표(soft). hard 상한(max_production_tokens) 보다 작다.
    return max(SAFE_PRODUCTION_TOKENS_FLOOR,
               int(round(quality_operating_ceiling() * SAFE_FRACTION_OF_QUALITY_CEILING)))


def max_production_tokens(reference_prefix_tokens=0, reference_replay_frames=0):
    """분할 상한 = min(예산 fits, 종료 상한, 품질 운영 상한).

    세 축이 각각 다른 것을 말한다 — 예산은 "생성 예산 안에 들어오는가", 종료 상한은
    "EOS 에 닿는가", 품질 상한은 "끝까지 들을 만한가" 다. 종료했다고 품질이 유지되는 것은
    아니다(563 실측). 그래서 planner 는 셋 중 가장 보수적인 값을 쓴다.

    예산만으로는 부족하다. 예산에 들어와도 EOS 에 닿지 못하면 결과가 없다(goback 실측).
    그래서 두 조건을 함께 만족하는 값만 단일 호출로 허용한다. 상한만 올리고 생성 예산은
    그대로인 상태도, 예산만 보고 종료를 무시하는 상태도 코드상 존재할 수 없다.
    """
    return min(_max_budget_tokens(reference_prefix_tokens, reference_replay_frames),
               termination_ceiling(), quality_operating_ceiling())


def _max_budget_tokens(reference_prefix_tokens=0, reference_replay_frames=0):
    """예산(fits) 만 보는 상한. 종료 안전성은 보지 않는다 — 호출자가 결합한다."""
    lo, hi, best = 1, 1, None
    # 상한을 지수적으로 넓힌 뒤 이분 탐색한다(tier 가 유한하므로 반드시 수렴한다).
    while budget_for(hi, reference_prefix_tokens, reference_replay_frames)["fits"]:
        best, lo, hi = hi, hi, hi * 2
        if hi > 1 << 20:
            break
    if best is None:
        return 0
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if budget_for(mid, reference_prefix_tokens, reference_replay_frames)["fits"]:
            best, lo = mid, mid
        else:
            hi = mid
    return best


def legacy_max_segment_tokens():
    """이관 확인용 — 예전 고정 분할 상한. production 경로에서는 쓰지 않는다."""
    return generation_limit.max_segment_tokens()

# ── 종료 안전 상한(termination ceiling) ────────────────────────────────────────
# 예산에 들어온다고 단일 호출이 **끝난다는** 보장은 없다. goback 1054 token 은 예산
# (tier 3072) 안이었는데도 EOS 없이 limit 에 닿았다(LONGFORM_SINGLE_CALL_TERMINATION_UNSAFE).
# 그 3072 iterations 는 censored 관측이므로 frame/token 앵커 학습에 넣지 않는다.
#
# 따라서 예산과 별개로 **실증된 종료 상한**이 필요하다. 아래 값은 자연 종료가 확인된
# 최대 production token 이며, 확인되지 않은 구간은 extrapolate 하지 않고 분할 대상이다.
# ① 기술적 상한 — EOS 자연 종료가 확인된 최대값. 모델의 절대 한계가 아니다.
TERMINATION_CEILING_PRODUCTION_TOKENS = 563
TERMINATION_CEILING = {
    "production_tokens": TERMINATION_CEILING_PRODUCTION_TOKENS,
    "provenance": {
        "token_definition": "production_tokens (assistant template 포함)",
        "conditioning_mode": "high_quality_icl (vendor native ref-code ICL)",
        "generation_tier": 1536,
        "verified_on": "2026-08-30",
        "validated_runs": [
            {"run": "envelope-goback-576", "production_tokens": 563,
             "generated_iterations": 1106, "termination": "completed_before_limit"},
            {"run": "envelope-sample4-576", "production_tokens": 572,
             "generated_iterations": 1135, "termination": "completed_before_limit"},
            {"run": "envelope-goback-384", "production_tokens": 379,
             "generated_iterations": 661, "termination": "completed_before_limit"},
        ],
        "largest_natural_termination": 563,
        "smallest_observed_failure": 1054,
        "failure_run": "goback-vendor-native-1 (EOS 없이 3072 iterations, censored)",
        "note": ("종료 가능성만 말한다. 563 은 사용자 청취에서 goback 이 무너졌으므로 "
                 "production 단일 호출 허용 근거로 쓰지 않는다."),
    },
}

# ② 품질 운영 상한 — production planner 가 실제로 쓰는 보수적 상한.
#    563 은 종료했지만 goback 에서 약 52s 이후 기계적 울림·말끝 끊김, 1:24 이후 gain 감소가
#    청취로 확인됐다(QUALITY_FAIL_LONGFORM_DRIFT). 같은 범위에서 sample_4 572 는 온전했으므로
#    "563 이상이면 항상 붕괴" 도 아니다 — CONTENT_OR_STOCHASTIC_LONGFORM_QUALITY_DRIFT.
#    그래서 두 대본이 **모두 청취 통과한** 379 를 운영 상한으로 삼는다.
QUALITY_OPERATING_CEILING_PRODUCTION_TOKENS = 379
QUALITY_OPERATING_CEILING = {
    "production_tokens": QUALITY_OPERATING_CEILING_PRODUCTION_TOKENS,
    "provenance": {
        "token_definition": "production_tokens (assistant template 포함)",
        "conditioning_mode": "high_quality_icl (vendor native ref-code ICL)",
        "model_revision": "5d83992436eae1d760afd27aff78a71d676296fc",
        "parser_version": 2,
        "verified_on": "2026-08-30",
        "listening_passed": [
            {"run": "envelope-goback-384", "production_tokens": 379,
             "verdict": "QUALITY_PASS", "seconds": 52.8},
            {"run": "envelope-sample4-576", "production_tokens": 572,
             "verdict": "QUALITY_PASS", "seconds": 90.7},
        ],
        "listening_failed": [
            {"run": "envelope-goback-576", "production_tokens": 563,
             "verdict": "QUALITY_FAIL_LONGFORM_DRIFT",
             "onset_sec": 52, "tint_sec": 67, "gain_drop_sec": 84},
        ],
        "state": "CONTENT_OR_STOCHASTIC_LONGFORM_QUALITY_DRIFT",
        "raise_policy": ("복수 대본·복수 실행에서 청취 통과가 누적될 때만 상향 검토한다. "
                         "자동 계측으로 올리지 않는다."),
    },
}


def quality_operating_ceiling():
    """production planner 가 쓰는 보수적 상한. 청취 통과가 근거다."""
    return int(QUALITY_OPERATING_CEILING_PRODUCTION_TOKENS)


def termination_ceiling():
    """자연 종료가 실증된 최대 production token. 이 위는 분할 대상이다."""
    return int(TERMINATION_CEILING["production_tokens"])


def terminates_safely(production_tokens):
    """이 chunk 하나가 자연 종료한다고 **실증된 범위** 안인가."""
    return int(production_tokens) <= termination_ceiling()
