# -*- coding: utf-8 -*-
"""RESEARCH / TEST-ONLY 프로토타입 — G2 비결정 생성 acceptance 통계 집계 형식.

★ NOT production. 실제 합성·GPU·모델·오디오 없음. **합성(synthetic) 수치 trial 레코드만** 입력받아
  (token bucket × mode × emotion routing)별 success/tail 통계와 Wilson CI를 집계한다.
  production 순수 함수(`generation_limit`)의 공식·경계만 read-only 재사용한다(수정 없음).

설계 근거는 `doc/research/tts-stochastic-acceptance.md`. 세 acceptance 분리(§1), bounded 규칙(§2),
보고 형식(§3), 표본/CI(§4)를 코드로 구현한 것. 이 모듈은 "형식/집계 계약"이며 실측 harness가 아니다.

trial 레코드 스키마(합성):
    {
      "mode": "icl" | "xvector",
      "emotion": "default" | "happy" | "sad" | "angry" | "calm",
      "prod_tokens": int (>0),          # production tokenize 후 길이
      "iters": int (>=0),               # 관측된 talker 반복(합성)
      "applied_limit": int (선택),       # 미지정 시 compute_max_new_tokens(prod_tokens)로 채움
      "safety_ok": bool (선택),          # generation_limit 시행에서 6계약 만족 여부(§1b)
      "prosody_ok": bool (선택),         # completed 시행에서 종단 산출 여부(§1c)
      "elapsed_s": float (선택),
      "seed": int | None (선택),
      "excluded": bool (선택),           # R4 사전정의 제외(GPU 포화 등). 집계 분모에서 빠지되 사유 필요.
      "exclude_reason": str (선택),
    }
"""
import math

import generation_limit as gl

ENVELOPE_SLOPE = 2.786   # calib3 정상 upper envelope: iter ≈ 2.786*tok - 5.1
ENVELOPE_INTERCEPT = -5.1
Z_95 = 1.959963984540054  # 표준정규 0.975 분위수


# ─────────────────────────── 통계 기본 ───────────────────────────

def wilson_interval(successes, n, z=Z_95):
    """이항 비율의 Wilson score 95% 신뢰구간. n=0이면 (0.0, 1.0)(정보 없음)."""
    if not isinstance(successes, int) or successes < 0:
        raise ValueError(f"successes must be non-negative int, got {successes!r}")
    if not isinstance(n, int) or n < 0:
        raise ValueError(f"n must be non-negative int, got {n!r}")
    if successes > n:
        raise ValueError(f"successes({successes}) > n({n})")
    if n == 0:
        return (0.0, 1.0)
    p = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    lo = max(0.0, center - half)
    hi = min(1.0, center + half)
    return (lo, hi)


def rule_of_three_upper(n):
    """0건 관측 시 95% 상한 ≈ 3/n. n=0이면 1.0(정보 없음)."""
    if not isinstance(n, int) or n < 0:
        raise ValueError(f"n must be non-negative int, got {n!r}")
    if n == 0:
        return 1.0
    return min(1.0, 3.0 / n)


def required_n_for_margin(margin, z=Z_95, p=0.5):
    """원하는 절대 margin E(최악 p=0.5 기본)로 비율 추정에 필요한 n = ceil(z^2*p(1-p)/E^2)."""
    if not (0 < margin < 1):
        raise ValueError(f"margin must be in (0,1), got {margin!r}")
    if not (0 <= p <= 1):
        raise ValueError(f"p must be in [0,1], got {p!r}")
    return math.ceil(z * z * p * (1 - p) / (margin * margin))


def required_n_for_upper_bound(target_upper):
    """tail을 0건으로 보여 '상한 <= target_upper'를 주장하려면 rule-of-three로 n >= ceil(3/target_upper)."""
    if not (0 < target_upper < 1):
        raise ValueError(f"target_upper must be in (0,1), got {target_upper!r}")
    return math.ceil(3.0 / target_upper)


# ─────────────────────────── 분류/버킷 ───────────────────────────

def normal_envelope(prod_tokens):
    """calib3 정상 upper envelope 예측 iter = 2.786*tok - 5.1 (하한 0)."""
    if not isinstance(prod_tokens, int) or prod_tokens <= 0:
        raise ValueError(f"prod_tokens must be positive int, got {prod_tokens!r}")
    return max(0.0, ENVELOPE_SLOPE * prod_tokens + ENVELOPE_INTERCEPT)


def token_bucket(prod_tokens):
    """채택 chunk(tok<=33) 기준 버킷. B1=상한 MIN clamp 구간, B2=공식 구간, OVER=자동분할 대상."""
    if not isinstance(prod_tokens, int) or prod_tokens <= 0:
        raise ValueError(f"prod_tokens must be positive int, got {prod_tokens!r}")
    if prod_tokens > gl.max_segment_tokens():      # 33 초과 → 계약 B 자동분할 대상
        return "OVER"
    # 공식값이 MIN_LIMIT을 넘기 시작하는 최소 tok 경계로 B1/B2 구분.
    if gl.unclamped_limit(prod_tokens) <= gl.MIN_LIMIT:
        return "B1"
    return "B2"


def resolve_limit(rec):
    """레코드의 applied_limit(있으면 그대로, 없으면 공식으로 계산)."""
    if rec.get("applied_limit") is not None:
        return int(rec["applied_limit"])
    return gl.compute_max_new_tokens(int(rec["prod_tokens"]))


def classify_trial(rec):
    """termination_reason 판정 — production classify_termination 재사용(경계 iters==limit → generation_limit)."""
    limit = resolve_limit(rec)
    return gl.classify_termination(int(rec["iters"]), limit)


# ─────────────────────────── bounded 규칙(§2) 강제 ───────────────────────────

def cell_key(rec):
    return (token_bucket(int(rec["prod_tokens"])), rec["mode"], rec["emotion"])


def check_bounded(trials, plan):
    """R1~R3: 셀별 실제 시행 수(제외분 제외한 유효 시행)가 사전 등록 plan[n]과 정확히 같은지 검사.
    초과=재실행/추가 의심, 미달=조기중단 의심 → 예외. 계획에 없는 셀이 나와도 예외.
    plan: {(bucket, mode, emotion): n_cell}."""
    counts = {}
    for r in trials:
        if r.get("excluded"):
            if not r.get("exclude_reason"):
                raise ValueError("excluded trial은 exclude_reason 필수(R4 — 사유 없는 제외 금지)")
            continue
        k = cell_key(r)
        counts[k] = counts.get(k, 0) + 1
    problems = []
    for k, want in plan.items():
        got = counts.get(k, 0)
        if got != want:
            problems.append(f"{k}: 계획 {want} != 실제 {got}")
    for k in counts:
        if k not in plan:
            problems.append(f"{k}: 계획에 없는 셀 {counts[k]}건(사전 등록 위반)")
    if problems:
        raise AssertionError("bounded 위반(§2 R1-R3): " + "; ".join(problems))
    return True


# ─────────────────────────── 집계(§3) ───────────────────────────

def _summ_iters(values):
    if not values:
        return {"median": None, "p95": None, "max": None}
    s = sorted(values)
    n = len(s)

    def q(p):
        if n == 1:
            return float(s[0])
        idx = p * (n - 1)
        lo = int(math.floor(idx))
        hi = int(math.ceil(idx))
        if lo == hi:
            return float(s[lo])
        return s[lo] + (s[hi] - s[lo]) * (idx - lo)
    return {"median": q(0.5), "p95": q(0.95), "max": float(s[-1])}


def aggregate(trials, plan=None):
    """§3 보고 형식으로 집계. plan을 주면 먼저 check_bounded로 R1~R3 강제.
    반환: {cell_key: {n, completed, generation_limit, other_error, success_rate, success_ci,
                      tail_rate, tail_ci, tail_upper_if_zero, safety_correct, safety_total,
                      safety_correct_rate, prosody_ok, prosody_total, iters(median/p95/max),
                      max_margin}}"""
    if plan is not None:
        check_bounded(trials, plan)
    cells = {}
    for r in trials:
        if r.get("excluded"):
            continue
        k = cell_key(r)
        c = cells.setdefault(k, {
            "n": 0, "completed": 0, "generation_limit": 0, "other_error": 0,
            "safety_correct": 0, "safety_total": 0,
            "prosody_ok": 0, "prosody_total": 0,
            "_iters": [], "_max_margin": 0.0,
        })
        c["n"] += 1
        reason = r.get("termination_reason") or classify_trial(r)
        if reason == "completed_before_limit":
            c["completed"] += 1
            c["_iters"].append(int(r["iters"]))
            if "prosody_ok" in r:
                c["prosody_total"] += 1
                if r["prosody_ok"]:
                    c["prosody_ok"] += 1
        elif reason == "generation_limit":
            c["generation_limit"] += 1
            c["_iters"].append(int(r["iters"]))
            c["safety_total"] += 1
            if r.get("safety_ok"):
                c["safety_correct"] += 1
        else:
            c["other_error"] += 1
        env = normal_envelope(int(r["prod_tokens"]))
        if env > 0:
            c["_max_margin"] = max(c["_max_margin"], int(r["iters"]) / env)

    out = {}
    for k, c in cells.items():
        n = c["n"]
        comp, tail = c["completed"], c["generation_limit"]
        succ_ci = wilson_interval(comp, n)
        tail_ci = wilson_interval(tail, n)
        out[k] = {
            "n": n, "completed": comp, "generation_limit": tail, "other_error": c["other_error"],
            "success_rate": (comp / n) if n else None, "success_ci": succ_ci,
            "tail_rate": (tail / n) if n else None, "tail_ci": tail_ci,
            "tail_upper_if_zero": rule_of_three_upper(n) if tail == 0 else None,
            "safety_correct": c["safety_correct"], "safety_total": c["safety_total"],
            "safety_correct_rate": (c["safety_correct"] / c["safety_total"]) if c["safety_total"] else None,
            "prosody_ok": c["prosody_ok"], "prosody_total": c["prosody_total"],
            "iters": _summ_iters(c["_iters"]),
            "max_margin": c["_max_margin"],
        }
    return out


def format_report(agg):
    """집계 dict → 사람이 읽는 표 문자열(도구 출력용; 산문 보고엔 쓰지 않음)."""
    header = ("cell(bucket|mode|emotion)         n  comp tail  err | "
              "success[95% CI]           tail[95% CI]              med   p95   max  margin  safety")
    lines = [header, "-" * len(header)]
    for k in sorted(agg):
        c = agg[k]
        cell = "|".join(str(x) for x in k)
        it = c["iters"]
        med = "-" if it["median"] is None else f"{it['median']:.0f}"
        p95 = "-" if it["p95"] is None else f"{it['p95']:.0f}"
        mx = "-" if it["max"] is None else f"{it['max']:.0f}"
        sc = f"[{c['success_ci'][0]:.3f}, {c['success_ci'][1]:.3f}]"
        if c["generation_limit"] == 0:
            tc = f"[0, {c['tail_upper_if_zero']:.3f}(3/n)]"
        else:
            tc = f"[{c['tail_ci'][0]:.3f}, {c['tail_ci'][1]:.3f}]"
        safety = ("n/a" if c["safety_total"] == 0
                  else f"{c['safety_correct']}/{c['safety_total']}={c['safety_correct_rate']:.3f}")
        lines.append(
            f"{cell:<33} {c['n']:>2} {c['completed']:>4} {c['generation_limit']:>4} "
            f"{c['other_error']:>4} | {c['success_rate']:.3f} {sc:<22} "
            f"{c['tail_rate']:.3f} {tc:<22} {med:>4} {p95:>5} {mx:>5} "
            f"{c['max_margin']:>5.2f}x  {safety}")
    lines.append("주석: 분모=사전 등록 n(R3, 재실행 대체 없음). 수치는 합성/실측 구분 태그 필수.")
    return "\n".join(lines)
