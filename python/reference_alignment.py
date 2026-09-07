# -*- coding: utf-8 -*-
"""reference_alignment.py — 참조 오디오 구간과 ref_text 를 시간적으로 정확히 일치시키는 정책. 순수 로직.

왜 필요한가(2026-08-28 실측):
  ICL voice clone 은 (ref_audio, ref_text) 가 **같은 발화**를 가리킨다고 전제한다. 이 전제가
  깨지면 — 전사에는 있는데 오디오에는 없는 꼬리가 생기면 — talker 는 그 없는 말을 생성 구간
  맨 앞에서 먼저 발음한 뒤 타깃 문장을 시작한다(conditioning echo). 마커 통제실험에서
  참조 오디오에 없고 전사에만 있는 고유 문장이 출력 앞 2초에 5/5 재현됐다.

  사고의 직접 경위: 참조 구간을 14.0~23.0초 **고정 창**으로 잘랐는데 끝 23.0초가 발화
  한가운데였고, ref_text 는 그 창에 걸친 전사 세그먼트를 **통째로** 이어 붙였다. 화면에 보이는
  타임스탬프가 1초 단위라 "23초에서 끝난다"가 참인 줄 알았지만 실제 발화는 그 뒤까지 이어졌다.

정책(순서 그대로):
  · 구간에 **완전히 포함된** 세그먼트만 ref_text 에 넣는다.
  · 세그먼트가 경계를 걸치면 (A) 허용 길이 안에서 오디오 경계를 그 세그먼트 바깥의 무음까지
    **확장**하고, (B) 확장할 수 없으면 그 세그먼트를 ref_text 에서 **제외**하고 오디오 경계를
    직전(직후) 유효 무음으로 **당긴다**. 시작·끝 양쪽에 같은 규칙을 적용한다.
  · 유효한 완전 발화 구간을 만들 수 없으면 **실패**시킨다. 경고만 내고 통과시키지 않는다.

무엇을 하지 않는가(하드 요건):
  · 오디오를 편집하지 않는다. fade·앞부분 삭제·무음 삽입으로 증상을 덮지 않는다.
  · 모델·vendor 를 건드리지 않는다. 파일 I/O·네트워크가 없다(경계 계산은 호출부가 넘긴다).
  · 사용자의 전사 문장을 고쳐 쓰지 않는다 — **통째로 넣거나 통째로 뺀다**.
  · 거친 타임스탬프만으로 '일치'를 판정하지 않는다(_coarse_timestamps 가 fail-closed 로 막는다).
"""

from math import gcd  # noqa: F401  (의도적 미사용 — 해상도 판정은 배수 검사로 한다)

# ────────────────────────── 정책 상수 ──────────────────────────

# 기본값 = GPT-SoVITS 정책(3~10초). 호출부(reference_region.plan_aligned_region)는 엔진 정책의
# region_bounds 를 넘긴다 — 여기 숫자는 정책을 넘기지 않은 구 호출·테스트만 쓴다.
MIN_CLIP_SEC = 3.0
MAX_CLIP_SEC = 10.0
MIN_BOUNDARY_SILENCE_SEC = 0.20  # 경계로 쓸 수 있는 무음의 최소 길이. 이보다 짧은 틈은
                                 # 말 사이 숨이지 '문장이 끝난 자리'가 아니다.
EDGE_TOLERANCE_SEC = 0.02        # 부동소수·리샘플 오차 흡수용. 이보다 큰 침범은 침범으로 본다.
COARSE_STEP_SEC = 0.5            # 모든 경계가 이 값의 배수면 '거친 타임스탬프'로 보고 거부한다.

# 결정 사유 코드(문자열 메시지 대신 분기·로그용 안정 코드)
OK_AS_REQUESTED = "OK_AS_REQUESTED"
OK_EXTENDED_START = "OK_EXTENDED_START"
OK_EXTENDED_END = "OK_EXTENDED_END"
OK_EXCLUDED_HEAD_SEGMENT = "OK_EXCLUDED_HEAD_SEGMENT"
OK_EXCLUDED_TAIL_SEGMENT = "OK_EXCLUDED_TAIL_SEGMENT"

FAIL_COARSE_TIMESTAMPS = "FAIL_COARSE_TIMESTAMPS"
FAIL_NO_SILENCE_BOUNDARY = "FAIL_NO_SILENCE_BOUNDARY"
FAIL_NO_COMPLETE_SEGMENT = "FAIL_NO_COMPLETE_SEGMENT"
FAIL_TOO_SHORT = "FAIL_TOO_SHORT"
FAIL_TOO_LONG = "FAIL_TOO_LONG"

_FAIL_MSG = {
    FAIL_COARSE_TIMESTAMPS: "전사 타임스탬프가 너무 거칠어(0.5초 단위) 실제 발화 경계를 알 수 없습니다. "
                            "파형/VAD 경계나 단어 단위 정렬이 필요합니다.",
    FAIL_NO_SILENCE_BOUNDARY: "말이 끊기지 않는 구간이라 참조로 쓸 수 있는 무음 경계가 없습니다.",
    FAIL_NO_COMPLETE_SEGMENT: "구간 안에 온전히 들어가는 발화가 하나도 없습니다.",
    FAIL_TOO_SHORT: "완전한 발화만 남기면 참조가 이 엔진의 허용 하한보다 짧아집니다.",
    FAIL_TOO_LONG: "완전한 발화를 담으려면 참조가 이 엔진의 허용 상한보다 길어집니다.",
}


class AlignmentError(ValueError):
    """생성 전 불변식 위반. 이 예외가 나면 합성을 시작하지 않는다(fail-closed)."""

    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else code)


# ────────────────────────── 입력 정규화 ──────────────────────────

def _norm_segments(segments):
    out = []
    for i, s in enumerate(segments or []):
        st, en = float(s["start"]), float(s["end"])
        if en <= st:
            continue
        out.append({"id": s.get("id", i), "start": st, "end": en,
                    "text": (s.get("text") or "").strip()})
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def _norm_silences(silences, min_len=MIN_BOUNDARY_SILENCE_SEC):
    """경계로 쓸 수 있는 무음만 남긴다. 짧은 틈은 문장 경계가 아니므로 후보에서 뺀다."""
    out = []
    for a, b in (silences or []):
        a, b = float(a), float(b)
        if b - a >= min_len:
            out.append((a, b))
    out.sort()
    return out


def _coarse_timestamps(segments, step=COARSE_STEP_SEC):
    """모든 세그먼트 경계가 step 의 배수인가. 그렇다면 실제 발화 경계를 담고 있지 않다."""
    vals = [v for s in segments for v in (s["start"], s["end"])]
    if len(vals) < 2:
        return False
    return all(abs(v / step - round(v / step)) < 1e-6 for v in vals)


def _cut_point(silence):
    """무음 구간의 한가운데 — 양쪽 발화에서 가장 멀리 떨어진 안전한 절단점."""
    a, b = silence
    return (a + b) / 2.0


USABLE_MIN_SEC = 0.05            # 절단점을 놓을 수 있는 무음의 최소 '쓸 수 있는' 폭


def _silence_after(silences, t):
    """t 이후로 쓸 수 있는 첫 무음 — t 를 **품고 있는** 무음도 포함하고, 그 경우 t 이후 부분만 돌려준다.

    전사기(Whisper 등)가 주는 세그먼트 끝은 뒤따르는 쉼 안쪽으로 조금 들어가 있는 일이 흔하다.
    'start >= t' 로만 찾으면 바로 그 쉼을 건너뛰고 한참 뒤의 쉼을 집어 확장이 불가능해진다
    (실측: 세그먼트 끝 23.60 이 쉼 23.48~23.72 안에 있어 다음 후보가 25.69 로 튀었다).
    반환값은 '쓸 수 있는 구간'이라 _cut_point 를 그대로 적용하면 안전한 절단점이 된다."""
    for a, b in silences:
        if b >= t - EDGE_TOLERANCE_SEC:
            lo = max(a, t - EDGE_TOLERANCE_SEC)
            if b - lo >= USABLE_MIN_SEC:
                return (lo, b)
    return None


def _silence_before(silences, t):
    """t 이전으로 쓸 수 있는 마지막 무음 — t 를 품고 있으면 t 이전 부분만 돌려준다(위와 대칭)."""
    best = None
    for a, b in silences:
        if a <= t + EDGE_TOLERANCE_SEC:
            hi = min(b, t + EDGE_TOLERANCE_SEC)
            if hi - a >= USABLE_MIN_SEC:
                best = (a, hi)
        else:
            break
    return best


def _inside_silence(silences, t):
    """t 가 무음 구간 '안'에 있는가. 발화 시작점에 딱 붙은 경계는 안에 있는 것이 아니다."""
    for a, b in silences:
        if a + EDGE_TOLERANCE_SEC <= t <= b - EDGE_TOLERANCE_SEC:
            return (a, b)
    return None


def _straddles_end(seg, end):
    return seg["start"] < end - EDGE_TOLERANCE_SEC < seg["end"] - EDGE_TOLERANCE_SEC


def _straddles_start(seg, start):
    return seg["start"] + EDGE_TOLERANCE_SEC < start + EDGE_TOLERANCE_SEC < seg["end"]


def _contained(seg, start, end):
    return (seg["start"] >= start - EDGE_TOLERANCE_SEC
            and seg["end"] <= end + EDGE_TOLERANCE_SEC)


# ────────────────────────── 정책 본체 ──────────────────────────

def plan_reference_region(requested_start, requested_end, segments, silences,
                          min_sec=MIN_CLIP_SEC, max_sec=MAX_CLIP_SEC,
                          source_duration=None):
    """요청 구간 + 전사 세그먼트 + 무음 목록 → 정렬이 보장된 구간과 ref_text 계획.

    반환 dict(로그에 그대로 남길 수 있는 사실만):
      ok, reason, requested_start/end, clip_start/end, included/excluded,
      ref_text, boundary_silences, tail_silence_sec, head_silence_sec, actions
    실패면 ok=False 이고 clip_start/end 는 None — 호출부는 생성하지 말아야 한다."""
    segs = _norm_segments(segments)
    sils = _norm_silences(silences)
    rs, re_ = float(requested_start), float(requested_end)
    actions = []

    def fail(code, detail=""):
        return {"ok": False, "reason": code, "message": _FAIL_MSG.get(code, code),
                "detail": detail, "requested_start": round(rs, 4), "requested_end": round(re_, 4),
                "clip_start": None, "clip_end": None, "included": [], "excluded":
                    [{"id": s["id"], "start": round(s["start"], 4), "end": round(s["end"], 4)}
                     for s in segs],
                "ref_text": "", "boundary_silences": {"head": None, "tail": None},
                "head_silence_sec": None, "tail_silence_sec": None, "actions": actions}

    if re_ - rs <= 0:
        return fail(FAIL_TOO_SHORT, "요청 구간 길이가 0 이하")
    if not segs:
        return fail(FAIL_NO_COMPLETE_SEGMENT, "세그먼트 없음")
    # ★ 이번 사고의 직접 원인 — 거친 타임스탬프로 '일치'를 판정하지 않는다.
    if _coarse_timestamps(segs):
        return fail(FAIL_COARSE_TIMESTAMPS,
                    "모든 세그먼트 경계가 0.5초 배수")

    start, end = rs, re_

    # ── 끝 경계 ──
    tail = next((s for s in segs if _straddles_end(s, end)), None)
    if tail is not None:
        cand = _silence_after(sils, tail["end"])
        if cand is not None and (_cut_point(cand) - start) <= max_sec + EDGE_TOLERANCE_SEC \
                and (source_duration is None or cand[1] <= source_duration + EDGE_TOLERANCE_SEC):
            end = _cut_point(cand)
            actions.append({"edge": "end", "action": "extend", "code": OK_EXTENDED_END,
                            "segment_id": tail["id"], "to": round(end, 4)})
        else:
            back = _silence_before(sils, tail["start"])
            if back is None:
                return fail(FAIL_NO_SILENCE_BOUNDARY, "끝 세그먼트 앞의 무음 없음")
            end = _cut_point(back)
            actions.append({"edge": "end", "action": "exclude", "code": OK_EXCLUDED_TAIL_SEGMENT,
                            "segment_id": tail["id"], "to": round(end, 4)})

    # ── 시작 경계 ──
    head = next((s for s in segs if _straddles_start(s, start)), None)
    if head is not None:
        cand = _silence_before(sils, head["start"])
        if cand is not None and (end - _cut_point(cand)) <= max_sec + EDGE_TOLERANCE_SEC \
                and _cut_point(cand) >= 0.0:
            start = _cut_point(cand)
            actions.append({"edge": "start", "action": "extend", "code": OK_EXTENDED_START,
                            "segment_id": head["id"], "to": round(start, 4)})
        else:
            fwd = _silence_after(sils, head["end"])
            if fwd is None:
                return fail(FAIL_NO_SILENCE_BOUNDARY, "시작 세그먼트 뒤의 무음 없음")
            start = _cut_point(fwd)
            actions.append({"edge": "start", "action": "exclude", "code": OK_EXCLUDED_HEAD_SEGMENT,
                            "segment_id": head["id"], "to": round(start, 4)})

    if end <= start:
        return fail(FAIL_TOO_SHORT, "경계 보정 후 구간이 사라짐")

    included = [s for s in segs if _contained(s, start, end)]
    if not included:
        return fail(FAIL_NO_COMPLETE_SEGMENT, "보정 후에도 완전 포함 세그먼트 없음")

    # 경계를 무음 '안'에 놓는다. 발화 시작점에 딱 붙은 경계는 세그먼트 논리로는 걸치지 않지만
    # 파형으로 보면 잘린 것이다 — 그 클립은 앞뒤에 여유 무음이 없어 ICL 프롬프트로 부적합하다.
    # (합성 신호 회귀에서 실제로 이 구멍이 잡혔다: 요청 시작이 발화 온셋과 정확히 같은 경우.)
    if _inside_silence(sils, start) is None:
        cand = _silence_before(sils, included[0]["start"])
        if cand is None:
            return fail(FAIL_NO_SILENCE_BOUNDARY, "시작 경계로 쓸 무음 없음")
        start = _cut_point(cand)
        actions.append({"edge": "start", "action": "snap", "code": OK_EXTENDED_START,
                        "to": round(start, 4)})
    if _inside_silence(sils, end) is None:
        cand = _silence_after(sils, included[-1]["end"])
        if cand is None:
            return fail(FAIL_NO_SILENCE_BOUNDARY, "끝 경계로 쓸 무음 없음")
        end = _cut_point(cand)
        actions.append({"edge": "end", "action": "snap", "code": OK_EXTENDED_END,
                        "to": round(end, 4)})
    included = [s for s in segs if _contained(s, start, end)]
    if not included:
        return fail(FAIL_NO_COMPLETE_SEGMENT, "경계 정렬 후 완전 포함 세그먼트 없음")

    # 제외 목록은 '최종 구간에 걸친 것'이 아니라 '요청 구간 또는 보정 구간에 닿았는데 못 들어간 것'
    # 기준으로 만든다. 경계를 당겨서 아예 밖으로 나간 세그먼트야말로 로그에 남아야 하는 것이다.
    span_lo, span_hi = min(rs, start), max(re_, end)
    inc_ids = {id(s) for s in included}
    excluded = [s for s in segs
                if id(s) not in inc_ids
                and s["end"] > span_lo + EDGE_TOLERANCE_SEC
                and s["start"] < span_hi - EDGE_TOLERANCE_SEC]

    dur = end - start
    if dur < min_sec - EDGE_TOLERANCE_SEC:
        return fail(FAIL_TOO_SHORT, f"{dur:.3f}s")
    if dur > max_sec + EDGE_TOLERANCE_SEC:
        return fail(FAIL_TOO_LONG, f"{dur:.3f}s")

    head_sil = _silence_before(sils, included[0]["start"])
    tail_sil = _silence_after(sils, included[-1]["end"])
    # reason 은 마지막 동작이 아니라 **가장 큰 동작**이다. 경계 스냅(무음 안으로 밀기)은
    # 세그먼트 제외·확장보다 사소하므로, 둘이 함께 일어나면 큰 쪽이 사유가 되어야 한다.
    codes = {a["code"] for a in actions}
    for c in (OK_EXCLUDED_TAIL_SEGMENT, OK_EXCLUDED_HEAD_SEGMENT,
              OK_EXTENDED_END, OK_EXTENDED_START):
        if c in codes:
            reason = c
            break
    else:
        reason = OK_AS_REQUESTED

    plan = {
        "ok": True, "reason": reason, "message": "",
        "requested_start": round(rs, 4), "requested_end": round(re_, 4),
        "clip_start": round(start, 4), "clip_end": round(end, 4),
        "clip_dur_sec": round(dur, 4),
        "included": [{"id": s["id"], "start": round(s["start"], 4), "end": round(s["end"], 4)}
                     for s in included],
        "excluded": [{"id": s["id"], "start": round(s["start"], 4), "end": round(s["end"], 4)}
                     for s in excluded],
        "ref_text": " ".join(s["text"] for s in included if s["text"]).strip(),
        "ref_text_chars": len(" ".join(s["text"] for s in included if s["text"]).strip()),
        "boundary_silences": {
            "head": [round(head_sil[0], 4), round(head_sil[1], 4)] if head_sil else None,
            "tail": [round(tail_sil[0], 4), round(tail_sil[1], 4)] if tail_sil else None},
        "head_silence_sec": round(included[0]["start"] - start, 4),
        "tail_silence_sec": round(end - included[-1]["end"], 4),
        "actions": actions,
    }
    assert_alignment(plan)      # 계획을 내보내기 전에 스스로 불변식을 건다
    return plan


def assert_alignment(plan):
    """생성 전 강제 불변식. 하나라도 어기면 AlignmentError — 합성을 시작하지 않는다.

    경고로 끝내지 않는 이유: 경고는 무시되고, 무시된 경고 하나가 이번 사고 전체다."""
    if not plan.get("ok"):
        raise AlignmentError(plan.get("reason", "UNKNOWN"), plan.get("detail", ""))
    cs, ce = plan["clip_start"], plan["clip_end"]
    if cs is None or ce is None or ce <= cs:
        raise AlignmentError("INVALID_CLIP_BOUNDS", f"{cs}~{ce}")
    inc = plan["included"]
    if not inc:
        raise AlignmentError(FAIL_NO_COMPLETE_SEGMENT, "included 비어 있음")
    for s in inc:
        if s["start"] < cs - EDGE_TOLERANCE_SEC:
            raise AlignmentError("SEGMENT_STARTS_BEFORE_CLIP", f"id={s['id']}")
        if s["end"] > ce + EDGE_TOLERANCE_SEC:
            raise AlignmentError("SEGMENT_ENDS_AFTER_CLIP", f"id={s['id']}")
    if plan["head_silence_sec"] < -EDGE_TOLERANCE_SEC:
        raise AlignmentError("FIRST_UTTERANCE_CUT", "첫 발화가 구간 시작보다 앞")
    if plan["tail_silence_sec"] < -EDGE_TOLERANCE_SEC:
        raise AlignmentError("LAST_UTTERANCE_CUT", "마지막 발화가 구간 끝을 넘음")
    inc_ids = {s["id"] for s in inc}
    for s in plan["excluded"]:
        if s["id"] in inc_ids:
            raise AlignmentError("EXCLUDED_ALSO_INCLUDED", f"id={s['id']}")
    return True


# ── interim safety gate (임시 기준) ──────────────────────────────────────────
# 아래 세 수치는 **최종 검증된 기준이 아니다.** 정상 발화의 ASR 삽입·삭제·치환 분포와
# 실제 위험 경계 사례를 모아 조율하기 전까지의 잠정값이다. 조율 전에는 '통과'를
# '안전함'으로 읽지 말 것 — 판정은 validated / warning / blocked 로 나누고,
# 판단 근거가 부족한 입력은 STATUS_UNKNOWN 으로 남긴다.
BOUNDARY_UNITS = 5              # 머리·꼬리로 보는 음절 수. 혼입은 경계에서 생긴다.
MAX_INTERNAL_SUB_RATE = 0.20    # 내부 치환 비율이 이보다 크면 '같은 발화'로 보지 않는다.
MIN_INTERNAL_SUB_TO_BLOCK = 3   # 비율만 쓰면 짧은 문장에서 치환 2개도 막힌다 — 절대 하한을 함께 건다.

STATUS_UNKNOWN = "unknown"      # 너무 짧거나 근거가 부족해 판정할 수 없음(통과 아님)
STATUS_VALIDATED = "validated"
STATUS_BLOCKED = "blocked"
STATUS_WARN = "warning"

REF_BOUNDARY_MISMATCH = "REF_BOUNDARY_MISMATCH"          # 머리/꼬리 불일치 — 하드 실패
REF_NOT_SAME_UTTERANCE = "REF_NOT_SAME_UTTERANCE"        # 내부 치환 과다 — 하드 실패
REF_INTERNAL_VARIANCE = "REF_INTERNAL_VARIANCE"          # 경계 무관 내부 편차 — 경고


def verify_clip_transcript(ref_units, clip_asr_units, edit_counts_fn=None):
    """클립 ASR 과 ref_text 를 음절 단위로 맞추되 **편집 위치**까지 본다.

    왜 위치가 필요한가: '삽입+삭제 0, 치환 무제한 허용' 은 길이만 같으면 전혀 다른 문장도
    통과시킨다. 실제 혼입은 문장 **머리·꼬리**가 어긋날 때 생기므로, 경계 불일치는 막고
    내부 인식기 편차는 통과시키되 그 양이 과하면 '같은 발화가 아님'으로 막는다.

    edit_counts_fn 은 총량 보고용(선택). 위치 판정은 difflib 로 결정적으로 한다."""
    import difflib
    ref = tuple(ref_units)
    clip = tuple(clip_asr_units)
    n = len(ref)
    b = min(BOUNDARY_UNITS, max(n // 3, 1))

    if n < 3 or not clip:
        # 근거가 부족하면 '통과' 로 떨어뜨리지 않는다. 호출부가 사용자 재확인을 받아야 한다.
        return {"status": STATUS_UNKNOWN, "reason_code": None,
                "ref_syllables": n, "clip_asr_syllables": len(clip),
                "insertions": 0, "deletions": 0, "substitutions": 0,
                "boundary_units": b, "boundary_mismatches": [], "mismatch_where": [],
                "internal_substitutions": 0, "internal_sub_rate": 0.0,
                "head_coverage": 0.0, "tail_coverage": 0.0,
                "timing_mismatch": 0, "aligned": False, "recognizer_variance": 0}

    ins = dele = sub = 0
    boundary_hits, internal_sub = [], 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=list(ref), b=list(clip)).get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            ins += (j2 - j1)
        elif tag == "delete":
            dele += (i2 - i1)
        else:
            sub += max(i2 - i1, j2 - j1)
        at_head = i1 < b
        at_tail = i2 > n - b
        if at_head or at_tail:
            boundary_hits.append({"tag": tag, "ref_from": i1, "ref_to": i2,
                                  "where": "head" if at_head else "tail"})
        elif tag == "replace":
            internal_sub += (i2 - i1)

    internal_rate = internal_sub / max(n, 1)
    if boundary_hits:
        status, code = STATUS_BLOCKED, REF_BOUNDARY_MISMATCH
    elif internal_sub >= MIN_INTERNAL_SUB_TO_BLOCK and internal_rate > MAX_INTERNAL_SUB_RATE:
        status, code = STATUS_BLOCKED, REF_NOT_SAME_UTTERANCE
    elif ins or dele or sub:
        status, code = STATUS_WARN, REF_INTERNAL_VARIANCE
    else:
        status, code = STATUS_VALIDATED, None

    out = {
        "status": status, "reason_code": code,
        "ref_syllables": n, "clip_asr_syllables": len(clip),
        "insertions": ins, "deletions": dele, "substitutions": sub,
        "boundary_units": b,
        "boundary_mismatches": boundary_hits,
        "mismatch_where": sorted({h["where"] for h in boundary_hits}) or (["middle"] if (ins or dele or sub) else []),
        "internal_substitutions": internal_sub,
        "internal_sub_rate": round(internal_rate, 4),
        "head_coverage": round(1.0 - sum(1 for h in boundary_hits if h["where"] == "head") / max(b, 1), 4),
        "tail_coverage": round(1.0 - sum(1 for h in boundary_hits if h["where"] == "tail") / max(b, 1), 4),
        # 하위호환 — 예전 필드명을 쓰는 호출부가 있다.
        "timing_mismatch": ins + dele,
        "aligned": status != STATUS_BLOCKED,
        "recognizer_variance": internal_sub,
    }
    if edit_counts_fn is not None:
        ec = edit_counts_fn(ref, clip)
        out["edit_counts_total"] = int(ec.substitutions + ec.deletions + ec.insertions)
    return out


def assert_clip_transcript(verdict):
    """클립 전사 대조가 어긋나면 생성 전에 실패시킨다(fail-closed)."""
    if verdict.get("status") == STATUS_BLOCKED:
        raise AlignmentError(
            verdict.get("reason_code") or "CLIP_TEXT_MISMATCH",
            f"where={','.join(verdict.get('mismatch_where') or []) or '-'} "
            f"ins={verdict['insertions']} del={verdict['deletions']} sub={verdict['substitutions']} "
            f"internal_sub_rate={verdict['internal_sub_rate']} "
            f"(ref {verdict['ref_syllables']}음절 vs 클립 {verdict['clip_asr_syllables']}음절)")
    return True


def format_plan_log(plan):
    """로그 한 줄 묶음(수치·ID만. 전사 원문은 담지 않는다)."""
    inc = ",".join(str(s["id"]) for s in plan.get("included", [])) or "-"
    exc = ",".join(str(s["id"]) for s in plan.get("excluded", [])) or "-"
    if not plan.get("ok"):
        return (f"reference-align FAIL reason={plan.get('reason')} "
                f"requested={plan.get('requested_start')}~{plan.get('requested_end')} "
                f"excluded=[{exc}]")
    bs = plan.get("boundary_silences", {})
    return (f"reference-align OK reason={plan['reason']} "
            f"requested={plan['requested_start']}~{plan['requested_end']} "
            f"clip={plan['clip_start']}~{plan['clip_end']} ({plan['clip_dur_sec']}s) "
            f"included=[{inc}] excluded=[{exc}] "
            f"head_silence={plan['head_silence_sec']}s tail_silence={plan['tail_silence_sec']}s "
            f"boundary_head={bs.get('head')} boundary_tail={bs.get('tail')} "
            f"ref_text_chars={plan['ref_text_chars']} actions={len(plan['actions'])}")
