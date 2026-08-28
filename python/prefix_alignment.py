"""controlled-prefix 절단의 순수 정렬 계약(참조혼입 대응 PHASE 2 골격).

배경: Qwen3-TTS ICL 은 참조 대사를 생성 head 에 재합성한다(conditioning echo — 사용자 청취 확정).
controlled-prefix 는 target 대사 앞에 참조 전사를 '의도적으로' 붙여 생성한 뒤, 내용 정렬로
prefix 구간을 절단하는 고품질 후보 전략이다. **절단 정책(최종 pre-roll/offset)은 사용자 청취로
아직 확정되지 않았다** — 그래서 이 모듈은:

  - 절단을 실행하지 않는다(생성 경로 배선 없음, 파일 I/O 없음, Whisper 호출 없음).
  - 고정 offset 상수를 두지 않는다. pre-roll 선택은 '후보 나열 + 계약 판정' 형태로만 제공하고,
    최종 정책은 PHASE 3 에서 주입된다.
  - 입력은 전부 순수 데이터다: 음절 단위 스트림 [(unit, start_sec, end_sec), ...],
    파형은 float 시퀀스(+ sample rate). stdlib 만 사용한다(numpy/soundfile 불요).

3-신호 계약(전부 충족해야 ok — 하나라도 빠지면 fail-closed):
  s1  target anchor(3~5 단위)가 음절 스트림에서 '유일하게' 매치된다.
  s2  anchor 이전 구간에 '참조에만 있는'(target 에 없는) 3gram 이 1개 이상 존재한다
      — prefix(참조 대사)가 실제로 발화됐다는 내용 증거.
  s3  anchor 이전에 파형 dip(RMS ≤ RMS_DIP_DBFS)이 존재하고, 그 dip 끝에서 자르면
      cut 직후가 유성음(발화)이다 — 무음 한복판이나 발화 한복판을 자르지 않는다.

보안: 이 모듈은 음절 '단위'와 수치만 다룬다. 반환 dict 에 전사 전문·경로를 넣지 않는다
(단위 시퀀스는 호출자가 소유 — 여기서 이어붙여 문장으로 만들지 않는다).
"""
import math

# ── 계약 수치(임계값 — 절단 offset 이 아니다) ──
RMS_DIP_DBFS = -28.0      # s3: dip 판정 RMS 임계(dBFS)
VOICED_MIN_DBFS = -26.0   # s3: cut 직후 '유성음' 판정 임계(dip 보다 확실히 큰 에너지)
ANCHOR_MIN_UNITS = 3      # s1: anchor 최소 단위 수
ANCHOR_MAX_UNITS = 5      # s1: anchor 최대 단위 수
_DBFS_FLOOR = -120.0      # log 안정 하한(완전 무음)

# fail-closed 사유 코드(구조화 — 상위가 그대로 metadata/오류에 실을 수 있는 비민감 enum)
REASON_OK = "PREFIX_ALIGN_OK"
REASON_EMPTY_INPUT = "PREFIX_ALIGN_EMPTY_INPUT"
REASON_ANCHOR_NOT_FOUND = "PREFIX_ALIGN_ANCHOR_NOT_FOUND"
REASON_ANCHOR_AMBIGUOUS = "PREFIX_ALIGN_ANCHOR_AMBIGUOUS"
REASON_NO_REF_TRIGRAM = "PREFIX_ALIGN_NO_REF_TRIGRAM"
REASON_NO_DIP = "PREFIX_ALIGN_NO_DIP"
REASON_CUT_NOT_VOICED = "PREFIX_ALIGN_CUT_NOT_VOICED"


def rms(samples):
    """제곱평균제곱근. 빈 입력은 0.0(예외 없음 — 판정은 dbfs 임계가 한다)."""
    n = len(samples)
    if n == 0:
        return 0.0
    return math.sqrt(sum(float(x) * float(x) for x in samples) / n)


def dbfs(value):
    """선형 진폭(0~1) → dBFS. 0/음수는 하한(_DBFS_FLOOR)으로 — log 도메인 오류를 만들지 않는다."""
    if value is None or value <= 0.0:
        return _DBFS_FLOOR
    return max(_DBFS_FLOOR, 20.0 * math.log10(value))


# ── s1: anchor 유일 매치 ──────────────────────────────────────────────────────

def find_matches(needle, hay):
    """부분수열 정확 일치 시작 인덱스 전부. needle 이 비면 [](공허 매치를 만들지 않는다)."""
    n = len(needle)
    if n == 0 or n > len(hay):
        return []
    needle = list(needle)
    return [i for i in range(len(hay) - n + 1) if list(hay[i:i + n]) == needle]


def select_unique_anchor(target_units, stream_units):
    """target 머리에서 3~5단위 anchor 를 골라 스트림에서 '유일 매치'를 찾는다.

    길이 3부터 5까지 시도해 처음으로 유일해지는 길이를 채택한다(짧을수록 매치가 흔하고,
    길수록 인식 편차에 취약하므로 유일해지는 최소 길이가 균형점이다).
    반환: {"ok", "reason_code", "length", "index"} — index 는 스트림에서 anchor 첫 단위 위치."""
    if len(target_units) < ANCHOR_MIN_UNITS or not stream_units:
        return {"ok": False, "reason_code": REASON_EMPTY_INPUT, "length": None, "index": None}
    saw_ambiguous = False
    for n in range(ANCHOR_MIN_UNITS, ANCHOR_MAX_UNITS + 1):
        if n > len(target_units):
            break
        matches = find_matches(target_units[:n], stream_units)
        if len(matches) == 1:
            return {"ok": True, "reason_code": REASON_OK, "length": n, "index": matches[0]}
        if len(matches) > 1:
            saw_ambiguous = True
    return {"ok": False,
            "reason_code": REASON_ANCHOR_AMBIGUOUS if saw_ambiguous else REASON_ANCHOR_NOT_FOUND,
            "length": None, "index": None}


# ── s2: anchor 이전 참조 고유 3gram ───────────────────────────────────────────

def _trigrams(units):
    return {tuple(units[i:i + 3]) for i in range(len(units) - 2)}


def unique_ref_trigrams(ref_units, target_units):
    """참조에는 있고 target 에는 없는 3gram 집합 — prefix 발화의 내용 지문."""
    return _trigrams(ref_units) - _trigrams(target_units)


def ref_trigram_hits_before(stream_units, anchor_index, ref_units, target_units):
    """anchor '이전'(3gram 전체가 anchor_index 앞에서 끝나는 위치)에서 참조 고유 3gram 매치 수."""
    uniq = unique_ref_trigrams(ref_units, target_units)
    if not uniq or anchor_index is None:
        return 0
    hits = 0
    for p in range(max(0, anchor_index - 2)):
        if p + 3 <= anchor_index and tuple(stream_units[p:p + 3]) in uniq:
            hits += 1
    return hits


# ── s3: 파형 dip + cut 직후 유성음 ────────────────────────────────────────────

def frame_dbfs(waveform, sample_rate, win_sec=0.020, hop_sec=0.010):
    """프레임별 (t_start_sec, dbfs). 창/홉은 측정 파라미터(절단 offset 아님)."""
    if sample_rate <= 0 or not waveform:
        return []
    win = max(1, int(win_sec * sample_rate))
    hop = max(1, int(hop_sec * sample_rate))
    out = []
    for start in range(0, max(1, len(waveform) - win + 1), hop):
        seg = waveform[start:start + win]
        out.append((start / sample_rate, dbfs(rms(seg))))
    return out


def find_dips(waveform, sample_rate, threshold_dbfs=RMS_DIP_DBFS,
              win_sec=0.020, hop_sec=0.010):
    """RMS ≤ threshold 인 연속 프레임 구간을 dip 로 병합.
    반환: [{"start_sec","end_sec","min_dbfs"}] (시간 오름차순)."""
    frames = frame_dbfs(waveform, sample_rate, win_sec, hop_sec)
    dips = []
    cur = None
    for t, level in frames:
        if level <= threshold_dbfs:
            if cur is None:
                cur = {"start_sec": t, "end_sec": t + win_sec, "min_dbfs": level}
            else:
                cur["end_sec"] = t + win_sec
                cur["min_dbfs"] = min(cur["min_dbfs"], level)
        elif cur is not None:
            dips.append(cur)
            cur = None
    if cur is not None:
        dips.append(cur)
    return dips


def is_voiced_after(waveform, sample_rate, cut_sec, probe_sec=0.120,
                    min_dbfs=VOICED_MIN_DBFS):
    """cut 직후 probe 창의 RMS 가 유성음 임계 이상인가(자른 뒤 실제 발화가 이어지는가)."""
    if sample_rate <= 0:
        return False
    start = max(0, int(cut_sec * sample_rate))
    end = min(len(waveform), start + max(1, int(probe_sec * sample_rate)))
    if end <= start:
        return False
    return dbfs(rms(waveform[start:end])) >= min_dbfs


def evaluate_cut_candidates(waveform, sample_rate, anchor_start_sec,
                            threshold_dbfs=RMS_DIP_DBFS, win_sec=0.020, hop_sec=0.010,
                            probe_sec=0.120, voiced_min_dbfs=VOICED_MIN_DBFS):
    """anchor 이전에서 시작하는 dip 를 후보로 나열하고 계약 판정만 붙인다(선택하지 않는다).

    각 후보: {"dip": {...}, "voiced_after_dip_end": bool, "ok": bool}
    유성음 확인은 dip 끝(dip["end_sec"])을 기준으로 한다 — dip 안 어느 지점에서 자를지는
    PHASE 3 정책이 정한다(여기서 offset 을 고르지 않는다)."""
    if anchor_start_sec is None:
        return []
    out = []
    for dip in find_dips(waveform, sample_rate, threshold_dbfs, win_sec, hop_sec):
        if dip["start_sec"] >= anchor_start_sec:
            continue  # anchor 이후의 dip 는 prefix 절단 후보가 아니다
        voiced = is_voiced_after(waveform, sample_rate, dip["end_sec"], probe_sec, voiced_min_dbfs)
        out.append({"dip": dip, "voiced_after_dip_end": voiced, "ok": voiced})
    return out


# ── 종합 판정(fail-closed) ────────────────────────────────────────────────────

def resolve_prefix_cut(target_units, ref_units, stream, waveform, sample_rate, **kw):
    """3-신호 종합 판정. 절단하지 않고 후보와 사유만 돌려준다(최종 선택은 PHASE 3 주입).

    입력:
      target_units : target 대사의 음절 단위 시퀀스
      ref_units    : 참조 전사의 음절 단위 시퀀스
      stream       : 생성 결과의 (unit, start_sec, end_sec) 시퀀스(정렬된 인식 스트림)
      waveform     : float 시퀀스(-1~1), sample_rate: Hz
      kw           : 측정 파라미터 override(threshold_dbfs/win_sec/hop_sec/probe_sec/voiced_min_dbfs)

    반환(항상 같은 형태 — 비민감):
      {"ok": bool, "reason_code": str, "anchor": {...}|None, "anchor_start_sec": float|None,
       "ref_trigram_hits": int, "candidates": [...]}
    어떤 신호든 빠지면 ok=False(fail-closed). 최종 cut 위치 필드는 존재하지 않는다."""
    result = {"ok": False, "reason_code": REASON_EMPTY_INPUT, "anchor": None,
              "anchor_start_sec": None, "ref_trigram_hits": 0, "candidates": []}
    if not target_units or not ref_units or not stream or not waveform or sample_rate <= 0:
        return result

    stream_units = [s[0] for s in stream]

    # s1 — anchor 유일 매치
    anchor = select_unique_anchor(target_units, stream_units)
    result["anchor"] = anchor
    if not anchor["ok"]:
        result["reason_code"] = anchor["reason_code"]
        return result
    anchor_start_sec = float(stream[anchor["index"]][1])
    result["anchor_start_sec"] = anchor_start_sec

    # s2 — anchor 이전 참조 고유 3gram ≥ 1
    hits = ref_trigram_hits_before(stream_units, anchor["index"], ref_units, target_units)
    result["ref_trigram_hits"] = hits
    if hits < 1:
        result["reason_code"] = REASON_NO_REF_TRIGRAM
        return result

    # s3 — anchor 이전 dip + cut 후 유성음
    candidates = evaluate_cut_candidates(waveform, sample_rate, anchor_start_sec, **kw)
    result["candidates"] = candidates
    if not candidates:
        result["reason_code"] = REASON_NO_DIP
        return result
    if not any(c["ok"] for c in candidates):
        result["reason_code"] = REASON_CUT_NOT_VOICED
        return result

    result["ok"] = True
    result["reason_code"] = REASON_OK
    return result
