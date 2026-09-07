"""낱말 경계 기반 구간 후보 — 꽉 찬 음원에서도 참조 구간을 고르기 위한 두 번째 길.

왜 필요한가(2026-09-08 실측)
────────────────────────────
지금까지 참조 구간의 경계는 **0.2초 이상 이어지는 무음** 한가운데에서만 골랐다. 그래서 말이
쉼 없이 이어지는 음원은 후보가 아예 없어 `REGION_SNAP_RANGE_UNSATISFIABLE` 로 막혔다.
합성 음원으로 재현한 값(말토막 0.45초 + 틈 n초 반복, 40회):

    틈 0.06 / 0.10 / 0.16 / 0.20 초 → 감지된 무음 2개(앞뒤 여백뿐) → 전부 차단
    틈 0.24 초                      → 통과. 단 꼬리 경계가 -40.92 dBFS (임계 -40.0 에서 0.9dB)
    틈 0.30 초 이상                 → 여유롭게 통과

즉 실질 하한은 상수에 적힌 0.20초가 아니라 **약 0.24초**이고, 그 값에서도 여유가 1dB 미만이다.
막히는 이유도 '무음을 못 찾아서'가 아니라 **경계 검사 창이 0.12초**여서 한가운데를 자르면
여백이 창보다 좁기 때문이다(0.24초 무음 → 여백 0.12초, 딱 창 크기).

무음이 꼭 있어야 하는 진짜 이유
────────────────────────────
소리(딸깍) 때문이 아니다. 만든 클립을 **다시 전사해 원문과 대조**하기 때문이다
(`reference_alignment.verify_clip_transcript`). 낱말이 반토막 나면 그 대조가 깨진다.
그러니 필요한 것은 '무음'이 아니라 **낱말이 잘리지 않은 경계**다. 전사기는 이미
`word_timestamps=True` 로 낱말 단위 시각을 내주고 있었는데(`transcribe_worker.run_transcribe`)
참조 경로가 그것을 버리고 문장만 쓰고 있었다.

경계 검사를 느슨하게 하는 것이 아니다
────────────────────────────
낱말 틈은 0.06~0.15초로 좁아서 0.12초 창으로는 말이 섞여 들어온다. 그래서 검사 창을
**확보한 여백 크기**로 맞추되 0.03초를 하한으로 둔다. 이것이 검사를 무력화하지 않는다는 것도
실측했다(임계 -40dBFS, 같은 합성 음원):

    창 20ms  낱말 틈 자름 -99.6dBFS 통과 / 말 도중 자름 -12.6dBFS 차단
    창 30ms              -100.1dBFS 통과 /             -13.6dBFS 차단
    창 50ms              -100.3dBFS 통과 /             -15.3dBFS 차단
    창 80ms               -16.6dBFS 차단 /             -16.4dBFS 차단  ← 여백을 넘어선 창

말과 무음의 차이가 25dB 이상이므로 작은 창도 '말 도중'을 그대로 잡아낸다. 창을 여백보다 크게
잡는 것만이 오판(멀쩡한 경계를 차단)을 만든다.

이 모듈이 하지 않는 것
────────────────────────────
· 전사 원문을 담지 않는다 — 낱말의 **시각만** 다룬다. 대사 글자는 이 모듈을 통과하지 않는다.
· 자르지 않는다. 후보와 여백만 계산한다(자르기·무음 삽입은 reference_region 의 몫).
"""

import math

# 낱말 사이 틈으로 인정할 최소 폭. 이보다 좁으면 경계 검사 창의 하한(0.03초 × 2)도 못 채운다.
MIN_GAP_SEC = 0.06
# 경계 검사 창의 하한. 위 실측표의 근거 — 0.03초 창도 말 도중을 25dB 차이로 잡는다.
MIN_EDGE_WINDOW_SEC = 0.03
# 낱말 시각이 전부 이 값의 배수면 '거친 타임스탬프'로 보고 후보로 쓰지 않는다.
# reference_alignment.COARSE_STEP_SEC 과 같은 취지의 방어다(표시용 반올림 시각을 근거로 삼지 않기).
COARSE_STEP_SEC = 0.5
# 판정에 필요한 최소 낱말 수. 두세 개로는 '전부 배수' 가 우연히 참이 된다.
COARSE_MIN_WORDS = 6

BLOCK_NO_WORD_BOUNDARY = "REGION_NO_WORD_BOUNDARY"
BLOCK_COARSE_WORD_TIMES = "REGION_COARSE_WORD_TIMES"
WARN_WORD_BOUNDARY_USED = "REGION_WORD_BOUNDARY_USED"


def normalize_words(words):
    """[{start,end}, ...] → 시각순으로 정리된 [(start, end), ...]. 이상한 항목은 버린다."""
    out = []
    for w in words or []:
        try:
            a = float(w["start"] if isinstance(w, dict) else w[0])
            b = float(w["end"] if isinstance(w, dict) else w[1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if not (math.isfinite(a) and math.isfinite(b)) or b <= a:
            continue
        out.append((round(a, 4), round(b, 4)))
    out.sort()
    return out


def coarse_word_timestamps(words, step=COARSE_STEP_SEC, min_words=COARSE_MIN_WORDS):
    """낱말 시각이 전부 step 의 배수인가 — 그렇다면 실제 정렬이 아니라 반올림된 표시용 값이다."""
    ws = normalize_words(words)
    if len(ws) < min_words:
        return False
    for a, b in ws:
        for t in (a, b):
            if abs(t / step - round(t / step)) > 1e-6:
                return False
    return True


def word_gaps(words, min_gap_sec=MIN_GAP_SEC):
    """이어지는 낱말 사이의 틈 [(a, b), ...]. 겹치는 낱말은 이어 붙여 하나로 본다.

    앞뒤 바깥(첫 낱말 앞·마지막 낱말 뒤)은 넣지 않는다 — 그 구간의 길이를 이 함수가 모르고,
    무음 경로가 이미 다루는 자리이기 때문이다."""
    ws = normalize_words(words)
    out = []
    if not ws:
        return out
    cur_end = ws[0][1]
    for a, b in ws[1:]:
        if a - cur_end >= min_gap_sec:
            out.append((round(cur_end, 4), round(a, 4)))
        cur_end = max(cur_end, b)
    return out


def pad_at(gaps, cut, tol=1e-6):
    """절단점 cut 이 속한 틈에서 양쪽으로 확보되는 여백(초). 어느 틈에도 없으면 0.0.

    경계 검사 창을 이 값으로 맞춘다 — 여백보다 큰 창을 쓰면 멀쩡한 경계를 차단한다(위 실측표)."""
    for a, b in gaps:
        if a - tol <= cut <= b + tol:
            return round(max(0.0, min(cut - a, b - cut)), 4)
    return 0.0


EDGE_MARGIN_SEC = 0.02   # 창이 여백에 딱 맞으면 안 된다. 무음 감지 경계는 근사값이기 때문이다.


def edge_window_sec(pad_sec, min_window_sec=MIN_EDGE_WINDOW_SEC, max_window_sec=None,
                    margin_sec=EDGE_MARGIN_SEC):
    """여백 pad_sec 안에 **완전히 들어가는** 경계 검사 창(초). 하한 0.03초, 상한은 표준 창.

    왜 여백에서 margin 을 빼는가(2026-09-08 실측): 0.24초 무음 한가운데를 자르면 여백이
    0.12초 = 표준 창과 같아지는데, 그때 꼬리 경계가 -40.92dBFS 로 임계(-40.0)에서 0.9dB
    차이였다. 무음 감지가 20ms 프레임·-45dBFS 근사이므로 여백의 양 끝에는 잔여 에너지가 있다.
    창이 여백에 딱 맞으면 그 잔여를 물어 **멀쩡한 경계를 차단**한다. 조금 안쪽만 본다."""
    w = max(float(min_window_sec), float(pad_sec) - float(margin_sec))
    if max_window_sec is not None:
        w = min(w, float(max_window_sec))
    return round(w, 4)
