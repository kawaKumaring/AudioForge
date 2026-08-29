"""Qwen talker 생성 안전장치 — segment별 동적 max_new_tokens 상한(계약 A, 공통 256 확정).

과다생성은 mode 무관 비결정적 장시간 tail이다(x-vector 정상 조건에서도 관측). ICL 오디오-전사 불일치는
이전 통제 실험에서 위험을 크게 높였으나 필요·충분조건은 아니다. 따라서 안전장치는 모든 Qwen segment에 적용한다.

동적 상한 = ceil(SLOPE*prod_tokens + BASE), [MIN_LIMIT, ABS_LIMIT]로 clamp.
근거:
  - SLOPE/BASE 는 calib3 정상 upper envelope(iter ≈ 2.786*tok − 5.1) 위에 margin을 둔 후보 공식(아직
    "최종 production 공식"으로 단정하지 않음 — timing·holdout 통과로 확정).
  - ABS_LIMIT=256: GPU/CPU 타이밍 실측으로 확정한 공통 상한.
      · per-segment 생성은 blocking 단일 호출이라 그 사이 stdout 없음 → production 비활성 timeout 280s 기준은
        '한 세그먼트 생성 시간'. 안전 조건: overhead_bound + L*spi_upper < 280.
      · CPU worst-observed spi=0.763 s/iter(이상치 포함, 임의 제외 안 함; 전형 0.51~0.59는 별도 표기),
        overhead_bound=50.8s → predicted(256)≈246s. 최소 기준(<250s) 충족, 단 margin 34s로 '경고' 후보임을
        근거에 그대로 남긴다. 실측 CPU mismatch@256 iters=151s(margin 129s)로 운영상은 더 안전. GPU@256≈158s.
      · device별 상한은 재현성·오류 설명 복잡성으로 채택하지 않음(공통 256).
  - MIN_LIMIT=200: 짧은 문장 고정 overhead + 여유(정상 짧은 문장 iter는 수십, 관측 최대 88).
prod_tokens는 production `_build_assistant_text` 적용 후 tokenizer 길이(qwen_bridge에서 계산해 전달).
termination_reason: talker_iters < limit → completed_before_limit / >= limit → generation_limit(잘림·폐기).
completed_before_limit은 codec EOS 직접 관측이 아니라 '동적 상한 전 자연 반환'이라는 운영 상태만 의미한다.

자동 분할(계약 B)과의 관계: 채택되는 chunk는 prod_tokens ≤ MAX_SEGMENT_TOKENS(=⌊(ABS-BASE)/SLOPE⌋=33)로
유지되어 동적 상한이 clamp 없이 온전한 헤드룸(≤ABS)을 갖는다. 이를 초과하는 줄은 자동 분할하고, 더는 못 나누면
TEXT_SEGMENT_TOO_LONG으로 실패한다(호출부/브리지 책임).
"""
import math

SLOPE = 2.9
BASE = 160
MIN_LIMIT = 200
ABS_LIMIT = 256


def compute_max_new_tokens(prod_tokens):
    """production token 수 → segment별 동적 max_new_tokens 상한.
    입력 검증(조용한 폴백 없음): bool 거부, 비정수(float/NaN/inf/str 등) 거부, 0 이하 거부.
    production에서 prod_tokens는 항상 양수(_build_assistant_text 래퍼만으로도 수 토큰) — 0 이하는 계산 경로 이상."""
    if isinstance(prod_tokens, bool) or not isinstance(prod_tokens, int):
        raise ValueError(f"prod_tokens must be a positive int (bool/float/NaN/inf 거부), got {prod_tokens!r}")
    if prod_tokens <= 0:
        raise ValueError(f"prod_tokens must be > 0, got {prod_tokens!r}")
    cap = math.ceil(SLOPE * prod_tokens + BASE)
    if cap < MIN_LIMIT:
        cap = MIN_LIMIT
    if cap > ABS_LIMIT:
        cap = ABS_LIMIT
    return cap


def unclamped_limit(prod_tokens):
    """clamp 이전 동적 상한 ceil(SLOPE*tok+BASE). Policy B/자동분할 경계 판정용(ABS 초과 여부)."""
    if isinstance(prod_tokens, bool) or not isinstance(prod_tokens, int):
        raise ValueError(f"prod_tokens must be a positive int, got {prod_tokens!r}")
    if prod_tokens <= 0:
        raise ValueError(f"prod_tokens must be > 0, got {prod_tokens!r}")
    return math.ceil(SLOPE * prod_tokens + BASE)


def max_segment_tokens():
    """단일 세그먼트가 clamp 없이 허용되는 최대 production token 수 = ⌊(ABS_LIMIT-BASE)/SLOPE⌋.
    unclamped_limit(tok) <= ABS_LIMIT 인 최대 tok. ABS=256·SLOPE=2.9·BASE=160 → 33."""
    return math.floor((ABS_LIMIT - BASE) / SLOPE)


def segment_exceeds_limit(prod_tokens):
    """이 세그먼트의 unclamped 동적 상한이 ABS_LIMIT을 초과하는가(=자동분할/차단 대상). 경계: ==ABS는 허용."""
    return unclamped_limit(prod_tokens) > ABS_LIMIT


def classify_termination(generated_iterations, limit):
    """생성 반복 수와 상한으로 종료 상태 판정.
    generated_iterations >= limit → 'generation_limit'(상한 도달, 결과 폐기 대상)
    generated_iterations < limit  → 'completed_before_limit'(상한 전 자연 반환).
    counter 미측정(None) → 조용히 정상 처리하지 않고 예외(호환성 오류는 호출부가 판단)."""
    if not isinstance(generated_iterations, int) or generated_iterations < 0:
        raise ValueError(f"generated_iterations must be non-negative int, got {generated_iterations!r}")
    if not isinstance(limit, int) or limit <= 0:
        raise ValueError(f"limit must be positive int, got {limit!r}")
    return "generation_limit" if generated_iterations >= limit else "completed_before_limit"
