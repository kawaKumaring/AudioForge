"""controlled-prefix 조립·절단의 순수 계약(참조혼입 대응).

배경: 이 TTS 의 ICL(x_vector_only=false)은 참조 대사를 생성 head 에 재합성한다(conditioning echo
— 사용자 청취 확정). controlled-prefix 는 target 대사 앞에 참조 전사를 '의도적으로' 붙여 생성한 뒤,
목표 대사가 시작되는 파형 경계를 찾아 그 앞을 잘라내는 전략이다(사용자 승인: 언어로 인식되는
참조 혼입은 실사용 기준 제거됨).

이 모듈이 소유하는 것(전부 순수 함수 — 파일 I/O·모델·전사 호출 없음, stdlib 만):
  A) 텍스트 조립 : build_controlled_prefix_text — [참조 전사][문장 종결][개행][목표 대사]
  B) 파형 경계   : detect_prefix_boundary — tail_end/onset/valley 를 신호에서 찾아 cut 을 낸다
  C) 내용 정렬   : resolve_prefix_cut — 음절 스트림이 있을 때 쓰는 3-신호 교차검증
  D) 창 한정 탐색: detect_prefix_boundary_windowed — 텍스트로 특정한 지점 주변에서만 B 를 적용

★생성 경로가 쓰는 것은 D 다. B 를 파형 전체에 걸면 참조 발화 **내부**의 문장 간 무음을 목표
  onset 으로 오검출한다(§D 에 실측 수치). B 는 D 의 내부 규칙이자 창 단위 단위테스트용이다.

B 의 규칙(고정 offset 상수 금지 — 전부 신호에서 유도한다):
  1) 10ms 프레임 / 5ms 홉으로 RMS dBFS + spectral flux + zcr 를 잰다.
  2) noise floor = 전 프레임 RMS dBFS 의 10 퍼센타일.
  3) tail_end = RMS 가 floor+3dB 이하로 30ms(6프레임) 연속 유지되는 첫 프레임(참조 잔여 소멸점).
  4) onset = tail_end 이후, **지역 조용 기준**(지금까지 관측한 floor+8dB 이하 프레임들의 flux/db
     median) 대비 flux ≥ max(8×baseline_flux, 0.5) 이고 db ≥ baseline_db+12 이며 후속 3프레임이
     floor+10dB 이상(지속 상승)인 첫 프레임 = 목표 첫 음절 시작.
     ★전역 median 을 쓰면 발화 flux 가 섞여 임계가 부풀어 검출이 실패한다(실측 실패 사례).
       반드시 '조용한 프레임만' 모은 지역 기준이어야 한다.
  5) cut = [tail_end, onset) 구간의 최저 RMS valley.
  6) 안전 조건 tail_end < cut 그리고 (onset - cut) ≥ 20ms. 불충족이면 fail-closed(절단하지 않는다).
  fade/crossfade/S-curve 는 이 모듈에 없다 — 잔여를 은폐하지 않고, 못 자르면 실패로 알린다.

보안: 이 모듈은 음절 '단위'와 수치만 다룬다. 반환 dict 에 전사 전문·경로를 넣지 않는다
(단위 시퀀스는 호출자가 소유 — 여기서 이어붙여 문장으로 만들지 않는다).
"""
import cmath
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
    고르지 않는다(생성 경로가 쓰는 실제 절단 지점은 detect_prefix_boundary 가 낸다)."""
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
    """3-신호 종합 판정(선택적 교차검증). 절단하지 않고 후보와 사유만 돌려준다.

    생성 경로가 쓰는 절단 지점은 detect_prefix_boundary(파형만으로 판정)가 낸다. 이 함수는
    음절 스트림(인식 결과)이 있을 때 '참조가 실제로 먼저 발화됐는가'를 내용으로 덧대어 볼 때 쓴다.

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


# ══════════════════════════════════════════════════════════════════════════════
# A) controlled-prefix 텍스트 조립
# ══════════════════════════════════════════════════════════════════════════════

# 문장 종결로 인정하는 문자. 참조 전사가 종결부호 없이 끝나면 목표 대사와 한 문장으로 이어 읽혀
# 경계(무음)가 생기지 않는다 — 경계가 없으면 자를 지점도 없다. 그래서 종결을 '보장'한다.
SENTENCE_TERMINATORS = ".!?…。！？"
DEFAULT_TERMINATOR = "."
PREFIX_JOINER = "\n"


def ensure_sentence_terminated(text, terminator=DEFAULT_TERMINATOR):
    """끝에 문장 종결부호가 없으면 붙인다(이미 있으면 그대로). 앞뒤 공백은 정리한다."""
    t = (text or "").strip()
    if not t:
        return t
    return t if t[-1] in SENTENCE_TERMINATORS else t + terminator


def build_controlled_prefix_text(reference_text, target_text):
    """[참조 전사 전체][문장 종결][개행][실제 목표 대사] 한 덩어리로 조립.

    참조를 의도적으로 먼저 발화시키기 위한 생성용 텍스트다(사용자에게 보이는 대사가 아니다).
    둘 중 하나라도 비면 controlled-prefix 가 성립하지 않으므로 조용히 통과시키지 않고 ValueError.
    호출자는 참조 전사를 확보한 뒤에만 이 함수를 부른다."""
    ref = ensure_sentence_terminated(reference_text)
    tgt = (target_text or "").strip()
    if not ref:
        raise ValueError("controlled-prefix: 참조 전사가 비어 있다")
    if not tgt:
        raise ValueError("controlled-prefix: 목표 대사가 비어 있다")
    return ref + PREFIX_JOINER + tgt


# ══════════════════════════════════════════════════════════════════════════════
# B) 파형 자동 경계 검출(tail_end → onset → valley → cut)
# ══════════════════════════════════════════════════════════════════════════════

# ── 측정 파라미터(창/홉 — 절단 offset 이 아니다) ──
BOUNDARY_FRAME_SEC = 0.010        # 10ms 프레임
BOUNDARY_HOP_SEC = 0.005          # 5ms 홉

# ── 판정 임계(전부 noise floor 상대값 — 고정 시간 offset 은 하나도 없다) ──
NOISE_FLOOR_PERCENTILE = 10       # floor = 전 프레임 dBFS 의 10 퍼센타일
TAIL_END_MARGIN_DB = 3.0          # floor+3dB 이하가
TAIL_END_HOLD_FRAMES = 6          # 6프레임(=30ms) 연속이면 참조 잔여 소멸
QUIET_BASELINE_MARGIN_DB = 8.0    # floor+8dB 이하 = '조용한 프레임'(지역 기준 표본)
ONSET_FLUX_RATIO = 8.0            # flux ≥ 8 × baseline_flux 이고
ONSET_FLUX_ABS_MIN = 0.5          #   동시에 절대 최소치(정규화된 flux 단위) 이상
ONSET_DB_RISE = 12.0              # db ≥ baseline_db + 12dB
ONSET_SUSTAIN_FRAMES = 3          # 후속 3프레임이
ONSET_SUSTAIN_MARGIN_DB = 10.0    #   floor+10dB 이상(순간 스파이크 배제)
MIN_LEAD_SEC = 0.020              # cut → onset 최소 여백(첫 음절 삼킴 방지)

# ── 비유성 개시(마찰음·파열음)를 놓치지 않기 위한 보조 신호 ──────────────────────
# 유성음 개시만 보면 ㅅ/ㅎ/ㅊ 같은 첫 자음이 이미 시작된 뒤를 개시로 잡아 첫 음절을 삼킨다.
# 그래서 '스펙트럼 변화 증거'를 셋 중 하나로 받는다(전부 지역 조용 기준 상대값):
#   E1 광대역 flux 급등 / E2 고주파대 에너지 상승 / E3 zcr 상승
# 세 신호 중 하나면 되지만, **필수 조건**(광대역 dB 상승 + 지속 3프레임)은 항상 함께 만족해야
# 한다 — 실제 판별력은 필수 조건이 갖고, E1~E3 는 '느린 잡음 드리프트'와 '발화 개시'를 가른다.
ONSET_HB_HZ = 2000.0              # 이 위를 고주파대로 본다(마찰·파열 에너지가 실리는 대역)
ONSET_HB_RISE_DB = 10.0           # E2: 고주파대가 지역 조용 기준보다 10dB 이상 오르면 개시 증거
ONSET_ZCR_RATIO = 2.0             # E3: zcr 이 지역 조용 기준의 2배 이상이고
ONSET_ZCR_ABS_MIN = 0.15          #      동시에 절대 최소치 이상(디더 잡음의 zcr 요동 배제)
# E1 의 절대 하한을 상수로 두지 않는다. 창마다 잡음 바닥이 다르고, 실측상 실제 개시 flux 는
# 0.0034~0.52 로 두 자릿수 배 흩어져 있어 어떤 상수도 한쪽을 버린다. 대신 **그 창에서 실제로 관측된
# 무음 프레임 flux 의 최댓값**에 배수를 곱해 쓴다(지역 잡음 수준 대비 상대량).
ONSET_FLUX_NOISE_MARGIN = 3.0
ONSET_FLUX_EPS = 1e-4             # 완전 디지털 무음 창에서 임계가 0 이 되지 않게 하는 하한
# 어떤 증거로 개시를 인정했는지 비트마스크로 남긴다(요약은 '숫자만' 계약을 지킨다 — 문자열 금지).
EVIDENCE_FLUX = 1
EVIDENCE_HIGH_BAND = 2
EVIDENCE_ZCR = 4

# fail-closed 사유 코드(비민감 enum — 상위가 그대로 오류/metadata 에 실을 수 있다)
REASON_BOUNDARY_OK = "PREFIX_BOUNDARY_OK"
REASON_BOUNDARY_EMPTY_INPUT = "PREFIX_BOUNDARY_EMPTY_INPUT"
REASON_BOUNDARY_TAIL_END_NOT_FOUND = "PREFIX_BOUNDARY_TAIL_END_NOT_FOUND"
REASON_BOUNDARY_ONSET_NOT_FOUND = "PREFIX_BOUNDARY_ONSET_NOT_FOUND"
REASON_BOUNDARY_CUT_NOT_AFTER_TAIL = "PREFIX_BOUNDARY_CUT_NOT_AFTER_TAIL_END"
REASON_BOUNDARY_LEAD_TOO_SHORT = "PREFIX_BOUNDARY_LEAD_TOO_SHORT"

REASON_BOUNDARY_ONSET_OFF_ANCHOR = "PREFIX_BOUNDARY_ONSET_OFF_ANCHOR"
REASON_BOUNDARY_CUT_INSIDE_REFERENCE = "PREFIX_BOUNDARY_CUT_INSIDE_REFERENCE"

_BOUNDARY_RESULT_KEYS = (
    "ok", "reason_code", "sample_rate", "frame_samples", "hop_samples", "frame_count",
    "noise_floor_dbfs", "tail_end_sample", "onset_sample", "valley_sample", "cut_sample",
    "valley_dbfs", "lead_samples",
    # 진단용 관측값(수치만) — 실패 사후 분석이 파형 없이도 가능해야 한다.
    "onset_dbfs", "onset_flux", "onset_zcr", "onset_hb_dbfs", "onset_evidence",
    "onset_flux_threshold", "baseline_dbfs", "quiet_frame_count",
)


def _high_band_bin(fft_size, sample_rate, hb_hz):
    """hb_hz 이상을 덮는 첫 FFT bin. bin 폭 = sample_rate/fft_size."""
    if sample_rate <= 0 or fft_size <= 0:
        return 0
    return max(1, int(math.ceil(hb_hz * fft_size / float(sample_rate))))


def _empty_boundary_result(reason_code, sample_rate=None):
    r = {k: None for k in _BOUNDARY_RESULT_KEYS}
    r["ok"] = False
    r["reason_code"] = reason_code
    r["sample_rate"] = sample_rate
    return r


def frame_geometry(n_samples, sample_rate, frame_sec=BOUNDARY_FRAME_SEC, hop_sec=BOUNDARY_HOP_SEC):
    """(win, hop, frame_count). 프레임 i 는 샘플 [i*hop, i*hop+win) 를 덮고, 좌표 대표값은 i*hop."""
    win = max(1, int(round(frame_sec * sample_rate)))
    hop = max(1, int(round(hop_sec * sample_rate)))
    count = 0 if n_samples < win else 1 + (n_samples - win) // hop
    return win, hop, count


def frame_levels_dbfs(waveform, sample_rate, frame_sec=BOUNDARY_FRAME_SEC,
                      hop_sec=BOUNDARY_HOP_SEC):
    """프레임별 RMS dBFS 목록. 제곱 누적합으로 O(N) — 전 구간을 재도 값싸다."""
    n = len(waveform)
    win, hop, count = frame_geometry(n, sample_rate, frame_sec, hop_sec)
    if count <= 0:
        return []
    acc = 0.0
    cum = [0.0] * (n + 1)
    for i in range(n):
        x = float(waveform[i])
        acc += x * x
        cum[i + 1] = acc
    out = []
    for i in range(count):
        s = i * hop
        mean_sq = (cum[s + win] - cum[s]) / win
        out.append(dbfs(math.sqrt(mean_sq) if mean_sq > 0.0 else 0.0))
    return out


def percentile(values, pct):
    """nearest-rank 퍼센타일(보간 없음 — 실제 관측값 하나를 고른다). 빈 입력은 None."""
    if not values:
        return None
    s = sorted(values)
    idx = int(math.ceil(pct / 100.0 * len(s))) - 1
    return s[min(max(idx, 0), len(s) - 1)]


def median(values):
    """중앙값. 빈 입력은 None(0.0 으로 위조하지 않는다 — 호출자가 부재를 안다)."""
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    m = n // 2
    return s[m] if n % 2 else 0.5 * (s[m - 1] + s[m])


def _next_pow2(n):
    p = 1
    while p < n:
        p <<= 1
    return p


def _fft(buf):
    """제자리 iterative radix-2 Cooley-Tukey. len(buf) 는 2 의 거듭제곱이어야 한다."""
    n = len(buf)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            buf[i], buf[j] = buf[j], buf[i]
    size = 2
    while size <= n:
        step = cmath.exp(complex(0.0, -2.0 * math.pi / size))
        half = size >> 1
        for start in range(0, n, size):
            w = complex(1.0, 0.0)
            for k in range(start, start + half):
                u = buf[k]
                v = buf[k + half] * w
                buf[k] = u + v
                buf[k + half] = u - v
                w *= step
        size <<= 1
    return buf


def _hann(n):
    if n == 1:
        return [1.0]
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


def _magnitude_spectrum(waveform, start, win, window, win_gain, fft_size):
    """진폭 정규화된 half spectrum: m[k] = 2|X[k]| / sum(window).

    정규화를 이렇게 두는 이유: 진폭 A 의 정현파 하나면 그 bin 의 m 이 대략 A 가 되어 flux 가
    '진폭 단위'로 읽힌다. 광대역 발화(rms r)는 sum_k m[k] ≈ r·sqrt(3K) 규모라, ONSET_FLUX_ABS_MIN
    (0.5)은 대략 rms -32dBFS 이상의 발화 개시에서만 넘어간다 — 잡음 바닥에서는 넘지 못한다."""
    buf = [complex(float(waveform[start + i]) * window[i], 0.0) for i in range(win)]
    if fft_size > win:
        buf.extend([complex(0.0, 0.0)] * (fft_size - win))
    _fft(buf)
    half = fft_size // 2 + 1
    return [2.0 * abs(buf[k]) / win_gain for k in range(half)]


def frame_onset_signals(waveform, sample_rate, frame_sec=BOUNDARY_FRAME_SEC,
                        hop_sec=BOUNDARY_HOP_SEC, hb_hz=None):
    """프레임별 (flux, zcr, high_band_dbfs) 를 앞에서부터 하나씩 내는 generator.

    generator 인 이유: onset 을 찾으면 그 뒤 프레임의 FFT 는 필요 없다. 앞부분만 계산하고 멈춘다.
    flux = Σ_k max(0, m_t[k] − m_{t−1}[k]) (half-wave rectified spectral flux, 첫 프레임은 0.0).
    zcr  = 프레임 내 부호 변화 비율.
    high_band_dbfs = hb_hz 이상 bin 진폭 합의 dB. 마찰음/파열음은 유성음보다 **먼저** 이 대역에서
      올라온다 — 유성음 개시만 보는 판정이 첫 자음을 삼키지 않게 하는 독립 신호다.

    세 신호를 함께 내는 이유는 '어떤 개시는 flux 로, 어떤 개시는 고주파/zcr 로 드러나기' 때문이다
    (실측: 같은 생성물 안 무음 뒤 개시 10건의 flux 는 0.0034~0.156 으로 두 자릿수 배 차이가 난다 —
     단일 절대 임계로는 나눌 수 없다)."""
    n = len(waveform)
    win, hop, count = frame_geometry(n, sample_rate, frame_sec, hop_sec)
    if count <= 0:
        return
    window = _hann(win)
    win_gain = sum(window) or 1.0
    fft_size = _next_pow2(win)
    hb_bin = _high_band_bin(fft_size, sample_rate, ONSET_HB_HZ if hb_hz is None else hb_hz)
    prev = None
    for i in range(count):
        s = i * hop
        mag = _magnitude_spectrum(waveform, s, win, window, win_gain, fft_size)
        flux = 0.0 if prev is None else sum(
            (a - b) for a, b in zip(mag, prev) if a > b)
        prev = mag
        changes = 0
        for k in range(s + 1, s + win):
            if (waveform[k] >= 0.0) != (waveform[k - 1] >= 0.0):
                changes += 1
        hb = dbfs(sum(mag[hb_bin:])) if hb_bin < len(mag) else _DBFS_FLOOR
        yield flux, (changes / (win - 1) if win > 1 else 0.0), hb


def frame_spectral_signals(waveform, sample_rate, frame_sec=BOUNDARY_FRAME_SEC,
                           hop_sec=BOUNDARY_HOP_SEC):
    """frame_onset_signals 의 (flux, zcr) 2-tuple 뷰(기존 호출자 호환)."""
    for flux, zcr, _hb in frame_onset_signals(waveform, sample_rate, frame_sec, hop_sec):
        yield flux, zcr


def detect_prefix_boundary(waveform, sample_rate, frame_sec=BOUNDARY_FRAME_SEC,
                           hop_sec=BOUNDARY_HOP_SEC,
                           onset_flux_abs_min=ONSET_FLUX_ABS_MIN):
    """생성물에서 '목표 대사 시작 직전'의 절단 지점을 신호만으로 찾는다(모듈 docstring B 규칙).

    onset_flux_abs_min: E1(flux) 의 절대 하한. 숫자를 주면 그 값을 쓰고(전역 탐색 기본 0.5),
    **None 이면 그 창에서 관측된 무음 flux 최댓값×ONSET_FLUX_NOISE_MARGIN 으로 유도**한다.
    §D 의 창 한정 탐색은 None 을 넘긴다 — 창마다 잡음 바닥이 다르고, 상수 하한은 실측상
    실제 개시의 다수(같은 표본 10건 중 8건)를 놓치기 때문이다.

    반환(성공/실패 모두 같은 형태 — 상위가 그대로 기록 가능, 전사·경로 없음):
      {"ok", "reason_code", "sample_rate", "frame_samples", "hop_samples", "frame_count",
       "noise_floor_dbfs", "tail_end_sample", "onset_sample", "valley_sample", "cut_sample",
       "valley_dbfs", "lead_samples"}
    ok=False 면 절대 자르지 말 것(fail-closed) — 사유는 reason_code 가 말한다."""
    if not waveform or not isinstance(sample_rate, int) or sample_rate <= 0:
        return _empty_boundary_result(REASON_BOUNDARY_EMPTY_INPUT,
                                      sample_rate if isinstance(sample_rate, int) else None)
    win, hop, count = frame_geometry(len(waveform), sample_rate, frame_sec, hop_sec)
    dbs = frame_levels_dbfs(waveform, sample_rate, frame_sec, hop_sec)
    if count <= 0 or not dbs:
        return _empty_boundary_result(REASON_BOUNDARY_EMPTY_INPUT, sample_rate)

    res = _empty_boundary_result(REASON_BOUNDARY_EMPTY_INPUT, sample_rate)
    res["frame_samples"] = win
    res["hop_samples"] = hop
    res["frame_count"] = count
    floor = percentile(dbs, NOISE_FLOOR_PERCENTILE)
    res["noise_floor_dbfs"] = round(floor, 2)

    # (3) tail_end — floor+3dB 이하가 30ms 연속 유지되는 첫 프레임
    tail_thr = floor + TAIL_END_MARGIN_DB
    tail_end = None
    run = 0
    for i, level in enumerate(dbs):
        if level <= tail_thr:
            run += 1
            if run >= TAIL_END_HOLD_FRAMES:
                tail_end = i - TAIL_END_HOLD_FRAMES + 1
                break
        else:
            run = 0
    if tail_end is None:
        res["reason_code"] = REASON_BOUNDARY_TAIL_END_NOT_FOUND
        return res
    res["tail_end_sample"] = tail_end * hop

    # (4) onset — 필수(광대역 dB 상승 + 지속) + 스펙트럼 변화 증거 1개 이상(E1/E2/E3).
    #     모든 임계는 '지금까지 관측한 조용한 프레임'이라는 지역 기준 상대값이다.
    quiet_thr = floor + QUIET_BASELINE_MARGIN_DB
    sustain_thr = floor + ONSET_SUSTAIN_MARGIN_DB
    quiet_flux = []
    quiet_db = []
    quiet_zcr = []
    quiet_hb = []
    onset = None
    obs = None
    for i, (flux, zcr, hb) in enumerate(frame_onset_signals(waveform, sample_rate,
                                                            frame_sec, hop_sec)):
        level = dbs[i]
        if i > tail_end:
            base_flux = median(quiet_flux)
            base_db = median(quiet_db)
            base_zcr = median(quiet_zcr)
            base_hb = median(quiet_hb)
            if base_flux is None:
                base_flux = 0.0
            if base_db is None:
                base_db = floor
            # E1 절대 하한: 명시값이 있으면 그것(전역 탐색), 없으면 **이 창의 무음 flux 최댓값**×배수.
            if onset_flux_abs_min is None:
                noise_abs = max(quiet_flux) * ONSET_FLUX_NOISE_MARGIN if quiet_flux else 0.0
                abs_min = max(noise_abs, ONSET_FLUX_EPS)
            else:
                abs_min = onset_flux_abs_min
            flux_thr = max(ONSET_FLUX_RATIO * base_flux, abs_min)
            # 필수 조건 — 이게 실제 판별력을 갖는다(느린 잡음 드리프트는 여기서 걸린다).
            if level >= base_db + ONSET_DB_RISE:
                ev = 0
                if flux >= flux_thr:
                    ev |= EVIDENCE_FLUX
                if base_hb is not None and hb >= base_hb + ONSET_HB_RISE_DB:
                    ev |= EVIDENCE_HIGH_BAND   # 비유성 개시(마찰·파열)를 잡는 독립 신호
                if (base_zcr is not None and zcr >= max(ONSET_ZCR_RATIO * base_zcr,
                                                        ONSET_ZCR_ABS_MIN)):
                    ev |= EVIDENCE_ZCR
                if ev:
                    last = i + ONSET_SUSTAIN_FRAMES
                    if last < count and all(dbs[i + k] >= sustain_thr
                                            for k in range(1, ONSET_SUSTAIN_FRAMES + 1)):
                        onset = i
                        obs = (level, flux, zcr, hb, ev, flux_thr, base_db, len(quiet_flux))
                        break
        # 지역 기준 갱신은 '판정 뒤'에 — 현재 프레임이 자기 임계를 만들지 않게 한다.
        if level <= quiet_thr:
            quiet_flux.append(flux)
            quiet_db.append(level)
            quiet_zcr.append(zcr)
            quiet_hb.append(hb)
    if onset is None:
        res["quiet_frame_count"] = len(quiet_flux)
        res["reason_code"] = REASON_BOUNDARY_ONSET_NOT_FOUND
        return res
    res["onset_sample"] = onset * hop
    (res["onset_dbfs"], res["onset_flux"], res["onset_zcr"], res["onset_hb_dbfs"],
     res["onset_evidence"], res["onset_flux_threshold"], res["baseline_dbfs"],
     res["quiet_frame_count"]) = (round(obs[0], 2), round(obs[1], 5), round(obs[2], 4),
                                  round(obs[3], 2), int(obs[4]), round(obs[5], 5),
                                  round(obs[6], 2), obs[7])

    # (5) cut = [tail_end, onset) 최저 RMS valley(동률이면 가장 이른 프레임)
    valley = tail_end
    for i in range(tail_end, onset):
        if dbs[i] < dbs[valley]:
            valley = i
    res["valley_sample"] = valley * hop
    res["valley_dbfs"] = round(dbs[valley], 2)
    res["cut_sample"] = valley * hop
    res["lead_samples"] = (onset - valley) * hop

    # (6) 안전 조건 — 못 지키면 자르지 않는다. cut_sample 은 지우고(절단 지점을 내지 않는다)
    #     valley/onset 등 관측값은 남긴다(왜 실패했는지 사후에 볼 수 있어야 한다).
    if not (tail_end < valley):
        res["cut_sample"] = None
        res["reason_code"] = REASON_BOUNDARY_CUT_NOT_AFTER_TAIL
        return res
    if res["lead_samples"] < int(round(MIN_LEAD_SEC * sample_rate)):
        res["cut_sample"] = None
        res["reason_code"] = REASON_BOUNDARY_LEAD_TOO_SHORT
        return res

    res["ok"] = True
    res["reason_code"] = REASON_BOUNDARY_OK
    return res


# ══════════════════════════════════════════════════════════════════════════════
# D) 텍스트(ASR) 정렬로 좁힌 창 안에서만 B 규칙을 적용한다
# ══════════════════════════════════════════════════════════════════════════════
#
# 왜 창이 필요한가(실측 근거 — 추정 아님):
#   controlled-prefix 생성물 **전체**에 B 규칙을 걸면 목표 대사가 아니라 '참조 발화 내부의 문장 간
#   무음'이 먼저 걸린다. 실측 표본(12.88s 생성물)에서 전역 탐색은 cut=20880(0.87s) / onset=22920 을
#   내고 ok=True 로 반환했다 — 실제 목표 대사는 9.5s 부근이다. 조용히 잘못 잘랐다는 뜻이다.
#   '가장 긴 침묵' 같은 파형-only 대체 규칙도 실패한다. 같은 표본의 무음 길이 순위:
#     3.185s=255ms  >  10.530s=170ms  >  9.345s=165ms(진짜 경계)  >  0.830s=115ms
#   참조 내부 무음이 진짜 경계보다 길다. 즉 파형만으로는 원리적으로 구분되지 않는다.
#   → 목표 위치는 **텍스트(ASR 정렬)** 로 먼저 특정하고, 파형 규칙은 그 좁은 창에서만 쓴다.
#     창 밖의 무음은 후보가 될 수 없다.
#
# ── 창은 '신뢰할 anchor 범위'로 만든다(고정 절단 offset 이 아니다) ──────────────
#
# ★이 창의 근거는 **ASR 단어 타임스탬프의 불확실성**이다. 초기 구현은 표본 하나에서 관측된
#   오차(+30ms) 를 사실상 상한으로 보고 trail 을 150ms 로 뒀는데, 그건 '오차가 작다'가 아니라
#   '이 한 번은 작았다'였다. 같은 표본에서 anchor 시각만 실측 오차 범위로 흔들면 판정이 세 구간
#   으로 갈린다(실측):
#     오차 +50~+125ms  → PREFIX_BOUNDARY_CUT_AFTER_ANCHOR  (정답 cut 인데 anchor 를 정확한
#                        상한으로 취급해 거부했다 — 판정 규칙 자체의 결함)
#     오차 +150~+230ms → PREFIX_BOUNDARY_ONSET_NOT_FOUND   (실제 개시가 창 뒤로 밀려 나갔다)
#     오차 ≥ +300ms    → **조용히 잘못 자름**(창 전체가 앞 무음으로 미끄러져 0.57s 앞을 cut)
#   세 번째가 가장 위험하다 — 실패로 알리지도 않는다.
#
# 그래서 규칙을 이렇게 바꾼다:
#   (1) 불확실성을 상수 하나로 **명시**한다: ASR_WORD_TOLERANCE_SEC.
#   (2) 창의 오른쪽은 anchor + 그 불확실성(+지속 판정 여유). 오른쪽 확장은 안전하다 —
#       onset 은 tail_end 이후 첫 자격 프레임이라, 창을 뒤로 넓혀도 이미 찾은 개시는 안 바뀌고
#       '못 찾던 개시'만 창 안으로 들어온다.
#   (3) 창의 왼쪽은 **anchor 하나가 아니라 두 관측으로 브래킷**한다. 목표 첫 단어 직전의 무음은
#       정의상 '참조 마지막 단어의 끝'과 '목표 첫 단어의 시작' 사이에 있다. 그래서 왼쪽은
#       prev_word_end − PREV_WORD_END_MARGIN_SEC 로 잡는다. 왼쪽 확장은 안전하지 않다(실측:
#       lead 를 0.8s 로 넓히자 0.57s 앞의 다른 개시를 골랐다) — 브래킷이 그 미끄러짐을 막는다.
#       실측 표본에서 prev_word_end=9.22s, 오검출 개시=8.930s 라 margin 0.20s 면 확실히 밖이다.
#   (4) anchor 는 상한이 아니라 **불확실성을 가진 기준점**으로 쓴다: 찾은 개시가 anchor 에서
#       불확실성 이상 떨어져 있으면 다른 곳을 본 것이므로 fail-closed(ONSET_OFF_ANCHOR).
#
# 실측 근거(같은 표본, 무음(≥50ms) 뒤 발화 개시 10건에서 ASR 단어 시작과의 어긋남):
#   잘 대응된 건들 -5 / +20 / +30ms, 대응이 애매한 건들까지 포함하면 ±수백 ms.
#   400ms 는 관측 최대치 급을 덮으면서, 브래킷 덕분에 이웃 문장으로 넘어가지는 못하는 폭이다.
ASR_WORD_TOLERANCE_SEC = 0.400
PREV_WORD_END_MARGIN_SEC = 0.200
# 지속 판정 3프레임(+15ms)과 프레임 길이(10ms)까지 창에 담기 위한 여유.
_SUSTAIN_SPAN_SEC = BOUNDARY_FRAME_SEC + ONSET_SUSTAIN_FRAMES * BOUNDARY_HOP_SEC

# prev_word_end 를 모를 때의 기본 폭(브래킷 없이 anchor 하나로만 만들 때).
ANCHOR_WINDOW_LEAD_SEC = 0.350
ANCHOR_WINDOW_TRAIL_SEC = ASR_WORD_TOLERANCE_SEC + _SUSTAIN_SPAN_SEC
# 브래킷이 있어도 왼쪽은 이 범위를 벗어나지 않는다 — prev_word_end 자체가 크게 틀렸을 때
# 창이 이웃 문장까지 미끄러지지 않게 하는 안전대.
WINDOW_MAX_LOOKBACK_SEC = 0.600
WINDOW_MIN_LOOKBACK_SEC = 0.120
# 창은 tail_end(30ms 유지) → valley → onset(+지속 3프레임=15ms) 를 담을 수 있어야 의미가 있다.
WINDOW_MIN_SEC = 0.120

REASON_BOUNDARY_WINDOW_INVALID = "PREFIX_BOUNDARY_WINDOW_INVALID"
REASON_BOUNDARY_CUT_AFTER_ANCHOR = "PREFIX_BOUNDARY_CUT_AFTER_ANCHOR"

# 창 결과에만 붙는 좌표 키(전역 좌표). _BOUNDARY_RESULT_KEYS 는 건드리지 않는다 —
# 전역 탐색 결과와 창 결과를 형태로 구분할 수 있어야 한다.
WINDOW_RESULT_KEYS = ("window_start_sample", "window_end_sample", "anchor_start_sample",
                      "prev_word_end_sample", "anchor_offset_samples")

_GLOBALIZED_KEYS = ("tail_end_sample", "onset_sample", "valley_sample", "cut_sample")


def _finite_sec(v):
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and v == v and abs(v) != float("inf") and v >= 0.0)


def alignment_window_samples(anchor_start_sec, sample_rate, n_samples,
                             lead_sec=ANCHOR_WINDOW_LEAD_SEC,
                             trail_sec=ANCHOR_WINDOW_TRAIL_SEC,
                             prev_word_end_sec=None):
    """anchor 단어 시작(+ 있으면 앞 단어 끝)으로 탐색 창을 만든다(파형 범위로 클램프).

    prev_word_end_sec 가 있으면 왼쪽을 그것으로 브래킷한다: 목표 첫 단어 직전의 무음은 정의상
    '참조 마지막 단어의 끝'과 '목표 첫 단어의 시작' 사이에 있으므로, 그보다 더 앞은 볼 이유가
    없다(그 앞을 보면 이웃 문장 경계를 고를 수 있다 — 실측 오검출의 원인). 브래킷 결과는
    [anchor-WINDOW_MAX_LOOKBACK, anchor-WINDOW_MIN_LOOKBACK] 로 클램프한다.
    prev_word_end_sec 가 없거나 anchor 이후면 lead_sec 로 되돌아간다(기존 동작).

    반환: {"ok","reason_code","window_start_sample","window_end_sample","anchor_start_sample",
           "prev_word_end_sample"}.
    창이 파형 밖이거나 WINDOW_MIN_SEC 보다 짧으면 ok=False — 넓혀서 구제하지 않는다."""
    r = {"ok": False, "reason_code": REASON_BOUNDARY_WINDOW_INVALID,
         "window_start_sample": None, "window_end_sample": None, "anchor_start_sample": None,
         "prev_word_end_sample": None}
    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
        return r
    if not isinstance(n_samples, int) or n_samples <= 0:
        return r
    if not _finite_sec(anchor_start_sec):
        return r
    anchor = int(round(float(anchor_start_sec) * sample_rate))
    if anchor <= 0 or anchor > n_samples:
        return r   # anchor 가 파형 맨 앞/밖 — 그 앞을 볼 여지가 없다

    lookback = int(round(lead_sec * sample_rate))
    if _finite_sec(prev_word_end_sec):
        r["prev_word_end_sample"] = int(round(float(prev_word_end_sec) * sample_rate))
        # ASR 이 앞 단어의 끝을 anchor 뒤로 보고하는 경우(단조성이 깨진 인식 결과)는 anchor 로
        # 클램프한다 — 창을 넓히는 쪽으로 해석하지 않는다(넓히면 이웃 경계가 후보가 된다).
        prev = min(int(round(float(prev_word_end_sec) * sample_rate)), anchor)
        bracket = anchor - (prev - int(round(PREV_WORD_END_MARGIN_SEC * sample_rate)))
        lookback = min(max(bracket, int(round(WINDOW_MIN_LOOKBACK_SEC * sample_rate))),
                       int(round(WINDOW_MAX_LOOKBACK_SEC * sample_rate)))
    ws = max(0, anchor - lookback)
    we = min(n_samples, anchor + int(round(trail_sec * sample_rate)))
    if we - ws < int(round(WINDOW_MIN_SEC * sample_rate)):
        return r
    r.update(ok=True, reason_code=REASON_BOUNDARY_OK, window_start_sample=ws,
             window_end_sample=we, anchor_start_sample=anchor)
    return r


def detect_prefix_boundary_windowed(waveform, sample_rate, anchor_start_sec,
                                    lead_sec=ANCHOR_WINDOW_LEAD_SEC,
                                    trail_sec=ANCHOR_WINDOW_TRAIL_SEC,
                                    frame_sec=BOUNDARY_FRAME_SEC, hop_sec=BOUNDARY_HOP_SEC,
                                    onset_flux_abs_min=None,
                                    prev_word_end_sec=None,
                                    anchor_tolerance_sec=ASR_WORD_TOLERANCE_SEC):
    """B 규칙(tail_end→onset→valley)을 **창 안에서만** 적용하고 좌표를 전역으로 환산한다.

    좌표 변환: 창은 로컬 인덱스를 낸다 → global = window_start_sample + local. 성공/실패 모두
    환산해 사후 확인이 항상 전역 좌표로 가능하게 한다. noise floor·지역 조용 기준도 창 안에서만
    산출되므로, 창 밖의 무음(참조 발화 내부 등)은 어떤 신호에도 기여하지 않는다.

    onset_flux_abs_min=None(기본): E1 의 절대 하한을 창의 무음 flux 에서 유도한다(상수 금지).

    anchor 취급(★변경): anchor 단어 시작은 **정확한 상한이 아니라 불확실성을 가진 기준점**이다.
    - 첫 음절(마찰음·파열음 포함) 보존은 cut < 검출된 음향 onset − MIN_LEAD 로 보장한다.
      이건 detect_prefix_boundary 가 신호에서 직접 낸 값이라 ASR 오차의 영향을 받지 않는다.
    - anchor 는 '같은 곳을 봤는가'를 검사하는 데만 쓴다: |onset − anchor| > 허용 오차면
      다른 개시를 본 것이므로 자르지 않는다(ONSET_OFF_ANCHOR).
    - cut 이 anchor + 허용 오차보다도 뒤면 여전히 거부한다(CUT_AFTER_ANCHOR).
    (예전 규칙 `cut < anchor` 는 ASR 이 개시보다 이르게 보고한 정상 표본을 거부했다 — 실측에서
     오차 +50~+125ms 구간이 통째로 CUT_AFTER_ANCHOR 로 떨어졌다.)

    반환: detect_prefix_boundary 와 같은 키 + WINDOW_RESULT_KEYS. ok=False 면 자르지 않는다."""
    n = 0 if waveform is None else len(waveform)
    win = alignment_window_samples(anchor_start_sec, sample_rate, n, lead_sec, trail_sec,
                                   prev_word_end_sec=prev_word_end_sec)
    if not win["ok"]:
        res = _empty_boundary_result(win["reason_code"],
                                     sample_rate if isinstance(sample_rate, int) else None)
        for k in WINDOW_RESULT_KEYS:
            res[k] = win.get(k)
        return res
    ws = win["window_start_sample"]
    we = win["window_end_sample"]
    anchor = win["anchor_start_sample"]
    res = detect_prefix_boundary(list(waveform[ws:we]), sample_rate, frame_sec, hop_sec,
                                 onset_flux_abs_min=onset_flux_abs_min)
    for k in _GLOBALIZED_KEYS:
        if isinstance(res.get(k), int):
            res[k] = ws + res[k]
    res["window_start_sample"] = ws
    res["window_end_sample"] = we
    res["anchor_start_sample"] = anchor
    res["prev_word_end_sample"] = win.get("prev_word_end_sample")
    res["anchor_offset_samples"] = (res["onset_sample"] - anchor
                                    if isinstance(res.get("onset_sample"), int) else None)
    if not res["ok"]:
        return res
    tol = int(round(max(0.0, anchor_tolerance_sec) * sample_rate))
    if abs(res["anchor_offset_samples"]) > tol:
        res["ok"] = False
        res["cut_sample"] = None
        res["reason_code"] = REASON_BOUNDARY_ONSET_OFF_ANCHOR
        return res
    if not (isinstance(res["cut_sample"], int) and res["cut_sample"] < anchor + tol):
        res["ok"] = False
        res["cut_sample"] = None
        res["reason_code"] = REASON_BOUNDARY_CUT_AFTER_ANCHOR
        return res
    # cut 은 '인식된 참조 발화 안'으로 들어가면 안 된다. 들어갔다면 anchor 가 크게 틀려 창이
    # 통째로 앞 발화로 미끄러진 것이다 — 이때 잘라 봐야 참조 잔여가 남는다. 자르지 않는다.
    # (창 왼쪽 브래킷은 클램프된 값을 쓰지만, 이 검사는 **원래 보고된** prev_word_end 로 한다.)
    if _finite_sec(prev_word_end_sec):
        limit = int(round((float(prev_word_end_sec) - PREV_WORD_END_MARGIN_SEC) * sample_rate))
        if res["cut_sample"] < limit:
            res["ok"] = False
            res["cut_sample"] = None
            res["reason_code"] = REASON_BOUNDARY_CUT_INSIDE_REFERENCE
    return res


def boundary_summary(detection):
    """metadata 용 축약(샘플 인덱스와 dB 만 — 전사 원문·경로·시간 문자열 없음)."""
    if not isinstance(detection, dict):
        return None
    out = {
        "sample_rate": detection.get("sample_rate"),
        "noise_floor_dbfs": detection.get("noise_floor_dbfs"),
        "tail_end_sample": detection.get("tail_end_sample"),
        "valley_sample": detection.get("valley_sample"),
        "onset_sample": detection.get("onset_sample"),
        "cut_sample": detection.get("cut_sample"),
        "valley_dbfs": detection.get("valley_dbfs"),
        "lead_samples": detection.get("lead_samples"),
    }
    # 어떤 신호로 개시를 인정했는지(수치·enum 만) — '유성음만 보고 자르지 않았다'는 사후 증거.
    for k in ("onset_dbfs", "onset_flux", "onset_zcr", "onset_hb_dbfs", "onset_evidence",
              "onset_flux_threshold", "baseline_dbfs", "quiet_frame_count"):
        if detection.get(k) is not None:
            out[k] = detection[k]
    # 창 탐색이었다면 '어디만 봤는지'도 남긴다 — 전역 탐색이 아니었다는 사실이 기록으로 남아야
    # 한다(수치만, 여전히 비민감). 전역 탐색 결과에는 이 키들이 아예 없다.
    for k in WINDOW_RESULT_KEYS:
        if detection.get(k) is not None:
            out[k] = detection[k]
    return out
