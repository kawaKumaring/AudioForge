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

보안
  텍스트(참조 전사·목표 대사)는 **입력으로만** 받는다. 반환값·예외 메시지·요약 어디에도 담기지
  않는다(샘플 인덱스·dB·개수만). 경로도 반환하지 않는다.
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


def plan_cut(prefix_text, target_text, asr_result, waveform, sample_rate,
             lead_sec=pa.ANCHOR_WINDOW_LEAD_SEC, trail_sec=pa.ANCHOR_WINDOW_TRAIL_SEC):
    """신호 1~5를 순서대로 통과시킨 뒤 전역 좌표 detection 을 돌려준다(순수 — I/O 없음).

    waveform 은 float 시퀀스(list). 실패는 IclAlignmentFailed(reason_code, detection)."""
    import korean_cer as kc
    tgt_units = kc.syllable_units(kc.normalize_text(target_text or ""))
    ref_units = kc.syllable_units(kc.normalize_text(prefix_text or ""))
    if not tgt_units or not ref_units:
        raise IclAlignmentFailed(REASON_EMPTY_TEXT)

    stream = build_unit_stream(asr_result)
    if not stream:
        raise IclAlignmentFailed(REASON_ASR_NO_WORDS)
    stream_units = [s[0] for s in stream]

    # s1 — 목표 대사 머리 anchor 가 유일 매치여야 한다(중복이면 어느 쪽인지 모른다 → 실패).
    anchor = pa.select_unique_anchor(tgt_units, stream_units)
    if not anchor["ok"]:
        raise IclAlignmentFailed(anchor["reason_code"])

    # s2 — anchor 이전에 참조 고유 3gram 이 실제로 나타나야 한다(참조가 먼저 발화됐다는 확인).
    #      이게 없으면 '앞을 잘라낼 참조'가 있다는 전제 자체가 확인되지 않은 것이다.
    hits = pa.ref_trigram_hits_before(stream_units, anchor["index"], ref_units, tgt_units)
    if hits < 1:
        raise IclAlignmentFailed(pa.REASON_NO_REF_TRIGRAM)

    anchor_start_sec = stream[anchor["index"]][1]
    # 목표 첫 단어 **직전** 발화의 끝. 목표 대사 앞 무음은 정의상 [prev_end, anchor_start] 안에
    # 있으므로, 이 둘로 창을 브래킷하면 이웃 문장 경계를 후보로 삼을 수 없다(창이 왼쪽으로
    # 미끄러져 조용히 다른 곳을 자르던 실측 결함의 차단막). 없으면 None — 그때는 lead_sec 로
    # 되돌아간다(추측으로 만들어 내지 않는다).
    # 같은 단어의 앞 음절은 건너뛴다(음절은 단어 시각을 공유한다) — '앞선 다른 단어'의 끝이어야
    # 브래킷이 의미를 갖는다.
    prev_word_end_sec = None
    for j in range(anchor["index"] - 1, -1, -1):
        if stream[j][1] < anchor_start_sec:
            prev_word_end_sec = float(stream[j][2])
            break

    # s3 — 그 좁은 창 안에서만 파형 규칙. 창 밖 무음은 후보가 될 수 없다.
    det = pa.detect_prefix_boundary_windowed(waveform, sample_rate, anchor_start_sec,
                                             lead_sec=lead_sec, trail_sec=trail_sec,
                                             prev_word_end_sec=prev_word_end_sec)
    det["anchor_units"] = int(anchor["length"])     # 수치만(어떤 음절인지는 담지 않는다)
    det["ref_trigram_hits"] = int(hits)
    if not det.get("ok"):
        raise IclAlignmentFailed(det.get("reason_code"), det)
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

    return {"cut_sample": int(cut), "summary": pa.boundary_summary(det),
            "frames_before": int(data.size), "frames_after": int(trimmed.size),
            "sample_rate": int(sr)}
