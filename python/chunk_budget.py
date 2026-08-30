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
FRAMES_PER_PRODUCTION_TOKEN = 339.0 / 191.0
FRAMES_ANCHOR_PROVENANCE = "vendor-icl-2/3 (250 chars, production 191 tok -> 339 frames)"

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
    """`fits` 를 만족하는 최대 production token 수 — **분할 상한은 여기서 파생된다.**

    분할 상한을 따로 두지 않으므로, 상한만 올리고 생성 예산은 그대로인 상태가 생길 수 없다.
    """
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
