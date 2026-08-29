# -*- coding: utf-8 -*-
"""controlled-prefix 정렬·절단의 **실행부**(부모 워커 소유).

왜 부모인가
  목표 대사의 위치는 파형만으로 특정할 수 없다(실측 — prefix_alignment §D). 텍스트로 먼저
  위치를 잡아야 하고 그러려면 ASR 이 필요한데, bridge 가 사는 qwen venv 에는 whisper 가 없다
  (설치하지 않는다). 그래서 bridge 는 자르지 않고 controlled-prefix **raw** 를 중간 산출물로
  남기고, whisper 가 있는 부모가 정렬·절단을 끝낸 뒤에야 chunk 가 확정된다.

GPU 직렬화
  이 모듈은 bridge subprocess 가 완전히 종료된 뒤에 호출된다(run_job 반환 이후). 그래서 Qwen 과
  whisper 가 같은 GPU 에 동시에 적재되는 순간이 없다 — 별도 락 없이 자연 직렬이다.

신호 순서(하나라도 어긋나면 자르지 않는다 — fail-closed)
  1) ASR 단어 타임스탬프 → 음절 스트림 [(unit, word_start_sec, word_end_sec)]
  2) 목표 대사 머리 3~5음절 anchor 가 그 스트림에서 **유일 매치**(중복/부재는 실패)
  3) anchor **이전**에 참조 전사 고유 3gram 이 실제로 있음(참조가 먼저 발화됐다는 확인)
  4) anchor 단어 시작 시각 기준 **좁은 창** 안에서만 파형 경계 규칙(prefix_alignment §D)
  5) cut < anchor 단어 시작, cut > tail_end, onset−cut ≥ 최소 여백 (4가 보증)
  전체 파형 탐색·고정 시간 절단·음절수 시간추정으로 대체하지 않는다. fade/crossfade 도 없다 —
  못 자르면 은폐하지 않고 실패로 알린다.

2차 경로 — 참조 꼬리 anchor(P1, 1차가 실패했을 때만)
  실측(보존 진단 20260829-053822-s0-c0): 목표 chunk 가 9음절뿐이고 ASR 오류가 그 **머리**
  (index 2 삭제 / 3 치환)에 몰리면 머리 anchor 는 원리적으로 못 잡는다 — 접두 n-gram 매치가
  n=1→3건, n=2→1건, n≥3→0건이었다. 반면 같은 스트림에서 참조 58음절의 재발화는 편집거리
  1/58 로 정확했고, **참조 마지막 단어 끝(8.58s)** 을 창 기준점으로 주면 같은 파형 규칙이
  ok=True(cut 209760 / onset 211080 / tail_end 207960 / lead 1320)로 풀렸다.
  그래서 1차가 실패한 뒤에만, 참조 전사의 **꼬리**가 스트림에서 유일 매치일 때 그 **끝점**을
  창 기준점으로 쓴다. 아래가 전부 충족될 때만이다(하나라도 어긋나면 예전처럼 실패):
    - 꼬리 문구가 **목표 대사에도** 나오면 안 된다(그러면 경계가 내용상 모호해진다)
    - 스트림 매치가 **정확히 하나**여야 한다(0=미검출, 2 이상=중복 → 실패)
    - 꼬리 뒤에 실제로 발화가 이어져야 한다(뒤따르는 음절이 anchor 최소 길이 이상)
    - 검출된 cut 이 참조 마지막 단어 끝보다 (여유 margin 이상) 앞이면 실패 — 참조 안을
      자르는 것이므로 잘라 봐야 잔여가 남는다
  임계값 완화·시간 고정 절단·fade 은폐는 여기에도 없다. 2차 경로가 실패하면 **1차의 사유
  코드**를 그대로 올린다(기존 계약 불변). 2차에서 무슨 일이 있었는지는 진단 수치가 말한다.

보안
  텍스트(참조 전사·목표 대사)는 **입력으로만** 받는다. 반환값·예외 메시지·요약 어디에도 담기지
  않는다(샘플 인덱스·dB·개수·비민감 enum 만). 경로도 반환하지 않는다.
"""
import os

import prefix_alignment as pa

# ── fail-closed 사유 코드(비민감 enum — 상위가 그대로 error_payload 에 실을 수 있다) ──
# prefix_alignment 의 PREFIX_ALIGN_* / PREFIX_BOUNDARY_* 는 그대로 재사용하고, 여기서는
# '실행부에서만 생길 수 있는' 실패만 새로 정의한다.
REASON_EMPTY_TEXT = "ICL_ALIGN_EMPTY_TEXT"              # 참조 전사/목표 대사가 비었다
REASON_ASR_FAILED = "ICL_ALIGN_ASR_FAILED"              # 전사 호출/결과 타입 자체가 실패
REASON_ASR_NO_WORDS = "ICL_ALIGN_ASR_NO_WORDS"          # 단어 타임스탬프가 하나도 없다
REASON_AUDIO_UNREADABLE = "ICL_ALIGN_AUDIO_UNREADABLE"  # raw chunk 디코드/형태 이상
REASON_EMPTY_AFTER_CUT = "ICL_ALIGN_EMPTY_AFTER_CUT"    # 자르고 나면 남는 게 없다
REASON_TRIM_WRITE_FAILED = "ICL_ALIGN_TRIM_WRITE_FAILED"  # 절단본 기록/재검증 실패

# ── 2차 경로(참조 꼬리 anchor)의 사유 코드 — 셋을 구분해 둔다(어느 fail-closed 인지가 다르다) ──
# 이 코드들은 **예외로 올라가지 않는다**(1차 사유를 그대로 올린다는 기존 계약 유지). 진단
# 수치의 align_ref_tail_reason 으로만 남아 사후 분석이 원인을 구분할 수 있게 한다.
REASON_REF_TAIL_NOT_FOUND = "ICL_ALIGN_REF_TAIL_NOT_FOUND"      # 스트림에서 못 찾았다
REASON_REF_TAIL_AMBIGUOUS = "ICL_ALIGN_REF_TAIL_AMBIGUOUS"      # 스트림에 두 번 이상 나온다
REASON_REF_TAIL_IN_TARGET = "ICL_ALIGN_REF_TAIL_IN_TARGET"      # 목표 대사에도 같은 문구가 있다
REASON_REF_TAIL_NO_SPEECH_AFTER = "ICL_ALIGN_REF_TAIL_NO_SPEECH_AFTER"  # 꼬리 뒤 발화가 없다

# ── anchor 종류(비민감 enum) ──
# 대문자인 이유: 진단 JSON 은 icl_diagnostics._numbers_only 를 통과한 값만 남기고, 그 필터는
# '수치 또는 reason_code 계열(대문자·밑줄·숫자)' 만 통과시킨다. 개인정보 필터를 느슨하게 만드는
# 대신 값을 canonical 대문자로 둔다(의미는 각각 target_head / reference_tail).
ANCHOR_KIND_TARGET_HEAD = "TARGET_HEAD"
ANCHOR_KIND_REFERENCE_TAIL = "REFERENCE_TAIL"

# ── 최종 실패 단계(비민감 enum) — '어디까지 갔다가 멈췄는가' ──
STAGE_TEXT = "ALIGN_STAGE_TEXT"                         # 참조/목표 텍스트가 비었다
STAGE_ASR_STREAM = "ALIGN_STAGE_ASR_STREAM"             # 음절 스트림을 못 만들었다
STAGE_TARGET_HEAD_ANCHOR = "ALIGN_STAGE_TARGET_HEAD_ANCHOR"        # 1차 anchor 실패
STAGE_REFERENCE_TAIL_ANCHOR = "ALIGN_STAGE_REFERENCE_TAIL_ANCHOR"  # 2차 anchor 도 실패
STAGE_REF_TRIGRAM = "ALIGN_STAGE_REF_TRIGRAM"           # 참조 선행 확인 실패
STAGE_BOUNDARY = "ALIGN_STAGE_BOUNDARY"                 # 창 안 파형 경계 검출 실패
STAGE_CUT_GUARD = "ALIGN_STAGE_CUT_GUARD"               # 검출은 됐지만 절단 지점 안전조건 위반
STAGE_NONE = "ALIGN_STAGE_NONE"                         # 실패 없음(성공)

# 진단에 남길 목표 머리 n-gram 매치 개수의 최대 길이. anchor 후보는 3~5지만, 실측에서 결정적인
# 정보는 'n=1,2 는 맞는데 3부터 0' 이라는 붕괴 지점이었다 — 그래서 1부터 센다.
_HEAD_MATCH_MAX_UNITS = 5

# 절단본 임시 파일 접미사. chunk 와 **같은 디렉터리**(job_dir 내부)에 만들어 os.replace 가 동일
# 파일시스템 원자 이동이 되게 한다. 정상/오류 모두에서 지우고, 취소로 finally 를 못 타도
# job_dir 통째 정리에 함께 사라진다.
# (확장자는 .wav 로 끝나야 한다 — soundfile 은 파일명 확장자로 포맷을 정한다.)
_TRIM_TMP_SUFFIX = ".af-icl-trim.tmp.wav"


class IclAlignmentFailed(Exception):
    """정렬·절단 미확정 — 결과를 발행하지 않는다(fail-closed).

    보안: reason_code(enum)와 수치 detection 만 들고 다닌다. 대사·전사·경로 없음."""

    def __init__(self, reason_code, detection=None):
        self.reason_code = reason_code
        self.detection = detection if isinstance(detection, dict) else None
        super().__init__(f"ICL_ALIGNMENT_FAILED({reason_code})")


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def build_unit_stream(asr_result):
    """ASR 결과 → [(음절단위, word_start_sec, word_end_sec)].

    한 단어가 여러 음절이면 그 단어의 시작/끝 시각을 **각 음절이 그대로 공유**한다.
    음절 개수로 시각을 나눠 보간하지 않는다 — 음절수 시간추정은 금지된 대체 규칙이고,
    anchor 위치의 실제 정밀도는 '단어'다(그 사실을 좌표에 정직하게 남긴다).
    단어 텍스트/시각이 이상하면 그 단어만 건너뛴다(0.0 으로 위조하지 않는다)."""
    import korean_cer as kc
    out = []
    if not isinstance(asr_result, dict):
        return out
    for seg in (asr_result.get("segments") or []):
        if not isinstance(seg, dict):
            continue
        for w in (seg.get("words") or []):
            if not isinstance(w, dict):
                continue
            text = w.get("word")
            s, e = w.get("start"), w.get("end")
            if not isinstance(text, str) or not _finite(s) or not _finite(e):
                continue
            for u in kc.syllable_units(kc.normalize_text(text)):
                out.append((u, float(s), float(e)))
    return out


def select_reference_tail_anchor(ref_units, target_units, stream_units):
    """참조 전사의 **꼬리** 3~5단위를 골라 ASR 스트림에서 '유일 매치'를 찾는다(2차 경로).

    길이 3부터 5까지 올려 가며 처음으로 아래를 **동시에** 만족하는 길이를 채택한다:
      - 그 꼬리 문구가 **목표 대사에는 없다**(있으면 참조 끝인지 목표 안인지 내용상 가릴 수 없다)
      - 스트림에서 매치가 **정확히 하나**다(0=미검출, 2 이상=중복)
    실패 사유는 셋을 구분한다. 여러 길이가 서로 다른 이유로 막혔다면 '목표 중복 → 스트림 중복
    → 미검출' 순으로 보고한다(내용 차원의 모호함이 더 근본적인 차단 사유다).

    반환: {"ok", "reason_code", "length", "index"} — index 는 꼬리 **첫** 단위의 스트림 위치."""
    fail = {"ok": False, "reason_code": REASON_REF_TAIL_NOT_FOUND, "length": None, "index": None}
    if len(ref_units) < pa.ANCHOR_MIN_UNITS or not stream_units:
        return fail
    saw_in_target = False
    saw_ambiguous = False
    for n in range(pa.ANCHOR_MIN_UNITS, pa.ANCHOR_MAX_UNITS + 1):
        if n > len(ref_units):
            break
        tail = ref_units[-n:]
        if pa.find_matches(tail, target_units):
            saw_in_target = True      # 목표 대사에도 있는 문구 — 이 길이로는 경계를 못 가린다
            continue
        matches = pa.find_matches(tail, stream_units)
        if len(matches) == 1:
            return {"ok": True, "reason_code": pa.REASON_OK, "length": n, "index": matches[0]}
        if len(matches) > 1:
            saw_ambiguous = True
    fail["reason_code"] = (REASON_REF_TAIL_IN_TARGET if saw_in_target
                           else REASON_REF_TAIL_AMBIGUOUS if saw_ambiguous
                           else REASON_REF_TAIL_NOT_FOUND)
    return fail


def _alignment_diagnostics(tgt_units, ref_units, stream_units):
    """P2 — 비민감 정렬 진단(수치와 canonical enum 만).

    남기는 것: 스트림/목표/참조 음절 길이, 목표 머리 n-gram 매치 개수(n=1..5)와 최장 일치 길이,
    참조 꼬리 n-gram 매치 개수(n=3..5)와 최장 일치 길이.
    ★전사 원문·목표 대사·참조 대사·경로는 **어떤 형태로도** 담지 않는다 — 음절 자체를 남기지
    않고 '개수'만 남기는 것이 이 함수의 유일한 계약이다."""
    d = {"align_asr_units": len(stream_units),
         "align_target_units": len(tgt_units),
         "align_reference_units": len(ref_units)}
    head_longest = 0
    for n in range(1, _HEAD_MATCH_MAX_UNITS + 1):
        if n > len(tgt_units):
            break
        c = len(pa.find_matches(tgt_units[:n], stream_units))
        d["align_head_match_n%d" % n] = c
        if c > 0:
            head_longest = n
    d["align_head_longest_units"] = head_longest
    tail_longest = 0
    for n in range(pa.ANCHOR_MIN_UNITS, pa.ANCHOR_MAX_UNITS + 1):
        if n > len(ref_units):
            break
        c = len(pa.find_matches(ref_units[-n:], stream_units))
        d["align_ref_tail_match_n%d" % n] = c
        if c > 0:
            tail_longest = n
    d["align_ref_tail_longest_units"] = tail_longest
    return d


def plan_cut(prefix_text, target_text, asr_result, waveform, sample_rate,
             lead_sec=pa.ANCHOR_WINDOW_LEAD_SEC, trail_sec=pa.ANCHOR_WINDOW_TRAIL_SEC):
    """신호 1~5를 순서대로 통과시킨 뒤 전역 좌표 detection 을 돌려준다(순수 — I/O 없음).

    1차는 목표 머리 anchor(기존 경로 그대로). 실패했을 때만 2차로 참조 꼬리 anchor 를 쓴다.
    2차도 실패하면 **1차의 사유 코드**를 올린다(기존 계약 불변).

    waveform 은 float 시퀀스(list). 실패는 IclAlignmentFailed(reason_code, detection) —
    detection 에는 언제나 P2 진단 수치(align_*)가 함께 실린다."""
    import korean_cer as kc
    tgt_units = kc.syllable_units(kc.normalize_text(target_text or ""))
    ref_units = kc.syllable_units(kc.normalize_text(prefix_text or ""))
    if not tgt_units or not ref_units:
        raise IclAlignmentFailed(REASON_EMPTY_TEXT,
                                 {"align_stage": STAGE_TEXT,
                                  "align_target_units": len(tgt_units),
                                  "align_reference_units": len(ref_units),
                                  "align_asr_units": 0})

    stream = build_unit_stream(asr_result)
    if not stream:
        raise IclAlignmentFailed(REASON_ASR_NO_WORDS,
                                 {"align_stage": STAGE_ASR_STREAM,
                                  "align_target_units": len(tgt_units),
                                  "align_reference_units": len(ref_units),
                                  "align_asr_units": 0})
    stream_units = [s[0] for s in stream]
    diag = _alignment_diagnostics(tgt_units, ref_units, stream_units)

    # s1 — 목표 대사 머리 anchor 가 유일 매치여야 한다(중복이면 어느 쪽인지 모른다 → 실패).
    anchor = pa.select_unique_anchor(tgt_units, stream_units)
    if anchor["ok"]:
        anchor_kind = ANCHOR_KIND_TARGET_HEAD
        anchor_units = int(anchor["length"])
        anchor_index = int(anchor["index"])
        anchor_start_sec = float(stream[anchor_index][1])
        trigram_limit = anchor_index
        # 목표 첫 단어 **직전** 발화의 끝. 목표 대사 앞 무음은 정의상 [prev_end, anchor_start]
        # 안에 있으므로, 이 둘로 창을 브래킷하면 이웃 문장 경계를 후보로 삼을 수 없다(창이
        # 왼쪽으로 미끄러져 조용히 다른 곳을 자르던 실측 결함의 차단막). 없으면 None — 그때는
        # lead_sec 로 되돌아간다(추측으로 만들어 내지 않는다).
        # 같은 단어의 앞 음절은 건너뛴다(음절은 단어 시각을 공유한다) — '앞선 다른 단어'의
        # 끝이어야 브래킷이 의미를 갖는다.
        prev_word_end_sec = None
        for j in range(anchor_index - 1, -1, -1):
            if stream[j][1] < anchor_start_sec:
                prev_word_end_sec = float(stream[j][2])
                break
        ref_tail_end_sec = None
    else:
        # ── 2차 경로: 참조 꼬리 anchor. 1차가 실패했을 때만, 그리고 전부 확실할 때만. ──
        tail = select_reference_tail_anchor(ref_units, tgt_units, stream_units)
        diag["align_ref_tail_reason"] = tail["reason_code"]
        if not tail["ok"]:
            diag["align_stage"] = STAGE_REFERENCE_TAIL_ANCHOR
            raise IclAlignmentFailed(anchor["reason_code"], diag)
        anchor_index = int(tail["index"]) + int(tail["length"]) - 1   # 꼬리의 **마지막** 단위
        # 꼬리 뒤에 실제로 발화가 이어졌는가. 참조만 말하고 끝난 생성물이면 자를 이유가 없다.
        if len(stream) - (anchor_index + 1) < pa.ANCHOR_MIN_UNITS:
            diag["align_ref_tail_reason"] = REASON_REF_TAIL_NO_SPEECH_AFTER
            diag["align_stage"] = STAGE_REFERENCE_TAIL_ANCHOR
            raise IclAlignmentFailed(anchor["reason_code"], diag)
        anchor_kind = ANCHOR_KIND_REFERENCE_TAIL
        anchor_units = int(tail["length"])
        # 기준점은 참조 마지막 단위의 **끝** 시각이다(실측에서 이 값으로 경계가 풀렸다).
        anchor_start_sec = float(stream[anchor_index][2])
        ref_tail_end_sec = anchor_start_sec
        # 창의 왼쪽 브래킷은 쓰지 않는다 — 기준점 자체가 이미 '참조의 끝'이라 prev_word_end 로
        # 다시 브래킷하면 실측에서 성공한 창과 달라진다. 대신 아래에서 같은 뜻의 안전 조건
        # (cut 이 참조 안으로 들어가지 않을 것)을 직접 검사한다.
        prev_word_end_sec = None
        trigram_limit = anchor_index + 1

    diag["align_anchor_kind"] = anchor_kind
    diag["align_anchor_units"] = anchor_units
    diag["align_anchor_stream_index"] = anchor_index
    diag["align_anchor_time_sec"] = round(anchor_start_sec, 4)

    # s2 — 기준점 이전에 참조 고유 3gram 이 실제로 나타나야 한다(참조가 먼저 발화됐다는 확인).
    #      이게 없으면 '앞을 잘라낼 참조'가 있다는 전제 자체가 확인되지 않은 것이다.
    #      (2차 경로에서는 꼬리 자체가 그 증거라 limit 이 꼬리 끝 다음이다.)
    hits = pa.ref_trigram_hits_before(stream_units, trigram_limit, ref_units, tgt_units)
    diag["align_ref_trigram_hits"] = int(hits)
    if hits < 1:
        diag["align_stage"] = STAGE_REF_TRIGRAM
        raise IclAlignmentFailed(pa.REASON_NO_REF_TRIGRAM, diag)

    # s3 — 그 좁은 창 안에서만 파형 규칙. 창 밖 무음은 후보가 될 수 없다.
    det = pa.detect_prefix_boundary_windowed(waveform, sample_rate, anchor_start_sec,
                                             lead_sec=lead_sec, trail_sec=trail_sec,
                                             prev_word_end_sec=prev_word_end_sec)
    det["anchor_units"] = anchor_units              # 수치만(어떤 음절인지는 담지 않는다)
    det["ref_trigram_hits"] = int(hits)
    det.update(diag)
    if not det.get("ok"):
        det["align_stage"] = STAGE_BOUNDARY
        raise IclAlignmentFailed(det.get("reason_code"), det)

    # s4(2차 경로 전용) — cut 이 참조 마지막 단어 끝보다 (margin 이상) 앞이면 참조 안을 자르는
    #   것이다. 잘라 봐야 참조 잔여가 남으므로 자르지 않는다(1차 경로의 CUT_INSIDE_REFERENCE 와
    #   같은 뜻·같은 여유값을 쓴다).
    if ref_tail_end_sec is not None:
        limit = int(round((ref_tail_end_sec - pa.PREV_WORD_END_MARGIN_SEC) * sample_rate))
        if not (isinstance(det.get("cut_sample"), int) and det["cut_sample"] >= limit):
            det["ok"] = False
            det["cut_sample"] = None
            det["reason_code"] = pa.REASON_BOUNDARY_CUT_INSIDE_REFERENCE
            det["align_stage"] = STAGE_CUT_GUARD
            raise IclAlignmentFailed(det["reason_code"], det)

    det["align_stage"] = STAGE_NONE
    return det


def align_and_trim(wav_path, prefix_text, target_text, transcribe_fn,
                   lead_sec=pa.ANCHOR_WINDOW_LEAD_SEC, trail_sec=pa.ANCHOR_WINDOW_TRAIL_SEC):
    """controlled-prefix raw chunk 를 정렬·절단해 **제자리에서** 확정한다.

    성공했을 때만 파일이 바뀐다: 같은 디렉터리 temp 에 절단본을 쓰고, 재오픈 검증(mono·finite·
    non-empty·sr·프레임 수·subtype)을 통과한 뒤에야 os.replace 한 번으로 교체한다. 어느 단계든
    실패하면 temp 를 지우고 예외 — raw 는 손대지 않은 채 남는다(부분 절단본을 만들지 않는다).

    transcribe_fn(path) → whisper result dict(word_timestamps 포함). 주입식이라 테스트가 ASR 을
    대체할 수 있다(정답 '창'을 주입하는 게 아니라 인식 결과를 준다 — 창은 언제나 여기서 만든다).

    반환(비민감): {"cut_sample", "summary", "frames_before", "frames_after", "sample_rate"}."""
    import numpy as np
    import soundfile as sf

    try:
        data, sr = sf.read(wav_path, dtype="float32")
        subtype = sf.info(wav_path).subtype
    except Exception:
        raise IclAlignmentFailed(REASON_AUDIO_UNREADABLE) from None
    data = np.asarray(data)
    if data.ndim != 1 or data.size == 0 or not np.all(np.isfinite(data)):
        raise IclAlignmentFailed(REASON_AUDIO_UNREADABLE)
    if not (isinstance(int(sr), int) and int(sr) > 0):
        raise IclAlignmentFailed(REASON_AUDIO_UNREADABLE)

    try:
        asr = transcribe_fn(wav_path)
    except Exception:
        # 예외 문구에 경로가 실릴 수 있어 원문을 옮기지 않는다(사유 코드만).
        raise IclAlignmentFailed(REASON_ASR_FAILED) from None
    if not isinstance(asr, dict):
        raise IclAlignmentFailed(REASON_ASR_FAILED)

    det = plan_cut(prefix_text, target_text, asr, data.tolist(), int(sr),
                   lead_sec=lead_sec, trail_sec=trail_sec)
    cut = det.get("cut_sample")
    if not (isinstance(cut, int) and 0 < cut < int(data.size)):
        # 창 안에서 ok 가 났는데 전역 좌표가 파형 밖이면 좌표 환산이 깨진 것 — 조용히 통과 금지.
        raise IclAlignmentFailed(pa.REASON_BOUNDARY_WINDOW_INVALID, det)
    trimmed = data[cut:]
    if trimmed.size == 0:
        raise IclAlignmentFailed(REASON_EMPTY_AFTER_CUT, det)

    tmp = wav_path + _TRIM_TMP_SUFFIX
    try:
        try:
            sf.write(tmp, trimmed, int(sr), subtype=subtype)
            rd, rd_sr = sf.read(tmp, dtype="float32")
            info = sf.info(tmp)
        except Exception:
            raise IclAlignmentFailed(REASON_TRIM_WRITE_FAILED, det) from None
        rd = np.asarray(rd)
        if (rd.ndim != 1 or rd.size != trimmed.size or int(rd_sr) != int(sr)
                or int(info.samplerate) != int(sr) or info.subtype != subtype
                or not np.all(np.isfinite(rd))):
            raise IclAlignmentFailed(REASON_TRIM_WRITE_FAILED, det)
        os.replace(tmp, wav_path)   # 이 시점에만 chunk 가 바뀐다(원자적)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    summary = pa.boundary_summary(det)
    # P2 진단(align_*)을 요약에도 싣는다 — 성공했을 때 '어떤 anchor 로 잘렸는가'가 기록에 남아야
    # 사후에 1차/2차 경로를 구분할 수 있다. 값은 수치이거나 canonical 대문자 enum 뿐이다.
    for k in sorted(det):
        if k.startswith("align_") and det[k] is not None:
            summary[k] = det[k]
    return {"cut_sample": int(cut), "summary": summary,
            "frames_before": int(data.size), "frames_after": int(trimmed.size),
            "sample_rate": int(sr)}
