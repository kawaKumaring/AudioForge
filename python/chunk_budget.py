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


def max_production_tokens(reference_prefix_tokens=0, reference_replay_frames=0):
    """분할 상한 — 예산(fits)과 **실증된 종료 상한**의 더 작은 쪽이다.

    예산만으로는 부족하다. 예산에 들어와도 EOS 에 닿지 못하면 결과가 없다(goback 실측).
    그래서 두 조건을 함께 만족하는 값만 단일 호출로 허용한다. 상한만 올리고 생성 예산은
    그대로인 상태도, 예산만 보고 종료를 무시하는 상태도 코드상 존재할 수 없다.
    """
    return min(_max_budget_tokens(reference_prefix_tokens, reference_replay_frames),
               termination_ceiling())


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
TERMINATION_CEILING = {
    "production_tokens": 563,
    "provenance": {
        "token_definition": "production_tokens (assistant template 포함)",
        "conditioning_mode": "high_quality_icl (vendor native ref-code ICL)",
        "generation_tier": 1536,
        "verified_on": "2026-08-30",
        # 두 텍스트가 모두 자연 종료한 최대값을 쓴다. 한쪽만 성공한 값은 채택하지 않는다.
        "validated_runs": [
            {"run": "envelope-goback-576", "script_sha256_prefix": "goback prefix",
             "production_tokens": 563, "generated_iterations": 1106,
             "termination": "completed_before_limit"},
            {"run": "envelope-sample4-576", "script_sha256_prefix": "sample_4 prefix",
             "production_tokens": 572, "generated_iterations": 1135,
             "termination": "completed_before_limit"},
            {"run": "envelope-goback-384", "production_tokens": 379,
             "generated_iterations": 661, "termination": "completed_before_limit"},
        ],
        "largest_natural_termination": 563,
        "smallest_observed_failure": 1054,
        "failure_run": "goback-vendor-native-1 (EOS 없이 3072 iterations, censored)",
        "note": "563~1054 구간은 미측정이다. extrapolate 하지 않고 분할 대상으로 둔다.",
    },
}


def termination_ceiling():
    """자연 종료가 실증된 최대 production token. 이 위는 분할 대상이다."""
    return int(TERMINATION_CEILING["production_tokens"])


def terminates_safely(production_tokens):
    """이 chunk 하나가 자연 종료한다고 **실증된 범위** 안인가."""
    return int(production_tokens) <= termination_ceiling()
