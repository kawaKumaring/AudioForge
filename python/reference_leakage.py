# -*- coding: utf-8 -*-
"""reference_leakage.py — 참조 음성 대사가 생성 음성에 섞이는 것(혼입)의 계측. 순수 numpy.

왜 이 모듈이 필요한가(2026-08-28 실측 근거):
  voice clone(ICL) 실행에서 사용자가 "생성 음성에 참조 대사가 들린다" 고 확정했는데,
  당시 검사(ASR 문자열의 4음절 이상 n-gram 비교)는 혼입 없음으로 판정했다. 그 검사는
    · 2~3음절짜리 짧은 조각을 못 본다
    · ASR 문자열만 봐서 파형이 그대로 복사된 경우를 전혀 못 본다
    · 애초에 '왜 섞였는지' 를 못 짚는다
  세 가지 모두를 놓쳤다. 그래서 혼입 경로를 셋으로 나눠 각각 다른 신호로 잰다.

세 검출기는 서로 대체재가 아니다 — 하나로 묶지 말 것:
  1) boundary_truncation()  참조 클립이 발화 도중에 잘렸는가.  ← 혼입의 '원인' 쪽
     ICL 은 (ref_text, ref_audio) 쌍이 같은 발화를 가리킨다고 전제한다. 클립이 말 도중에
     끊기면 전사에는 있는데 오디오에는 없는 꼬리가 생기고, talker 는 그 꼬리를 **생성 구간
     맨 앞에서 먼저 발음한 뒤** 타깃 문장을 시작한다. 실측에서 참조 클립은 무음 없이 9.000초
     경계에서 끊겼고(trailing_silence 0.000s), 생성물 머리 0.00~0.66s 가 참조 문장의 끝이었다.
  2) waveform_copy_scan()   생성 파형에 참조 파형이 그대로 복사됐는가(정규화 상호상관).
     prompt codec 슬라이싱이 어긋나면 참조 오디오가 그대로 남는다. 이건 ASR 로는 절대 안 잡히고
     교차상관에서만 드러난다. 같은 화자·다른 내용은 500 ms 창에서 0.5 를 넘지 않는 것으로 실측됐고
     (대조군 최대 0.49), 진짜 복사는 1.0 에 붙으므로 임계 0.90 은 넓은 여유를 둔 값이다.
  3) short_ngram_leaks()    ASR 문자열에 참조에만 있는 짧은(2~3음절) 조각이 있는가.
     4음절 이상만 보던 기존 검사의 사각지대를 그대로 메운다.

무엇을 하지 않는가(하드 요건):
  · 모델을 로드하지 않는다. ASR 은 호출부가 하고, 여기에는 **이미 만들어진 단위 배열**만 들어온다.
  · 파일 I/O·네트워크·서브프로세스가 없다. numpy 외 의존성이 없다.
  · 판정 결과에 전사 원문·경로·오디오 샘플을 담지 않는다. n-gram 조각은 '몇 개' 와 조각 문자열
    자체까지만 담는다(원문 복원 불가한 최소 단위).
  · 잘라내기·보정을 하지 않는다 — 서술(숫자/불리언)만 한다. 무엇을 할지는 호출부가 정한다.
"""

import numpy as np

# ────────────────────────── 계측 상수 ──────────────────────────

SPEECH_DBFS = -40.0              # 발화/무음 경계. audio_utils.trim_silence 와 같은 기준을 쓴다.
BOUNDARY_WINDOW_MS = 120.0       # 클립 경계에서 발화 여부를 보는 창. 한 음절보다 짧게 잡아
                                 # '말 도중 절단' 만 걸리고 자연스러운 여운은 안 걸리게 한다.

COPY_WINDOW_MS = 500.0           # 파형 복사 판정 창. 100 ms 는 같은 화자면 우연히 0.9 를 넘는다
                                 # (실측: 대조군 100 ms 최대 0.90, 500 ms 최대 0.49).
COPY_HOP_MS = 100.0
COPY_NCC_THRESHOLD = 0.90        # 이 이상이면 '그대로 복사' 로 본다. 실측 대조군 상한의 약 1.8배.

SHORT_NGRAM_SIZES = (2, 3)       # 기존 검사가 못 보던 짧은 조각 길이


def _rms_dbfs(x):
    """창 하나의 RMS(dBFS). 빈 배열/무음은 -120.0 으로 바닥을 친다(로그 발산 방지)."""
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return -120.0
    v = float(np.sqrt(np.mean(x * x)))
    return max(-120.0, 20.0 * float(np.log10(v))) if v > 0 else -120.0


def boundary_truncation(mono, sr, window_ms=BOUNDARY_WINDOW_MS, speech_dbfs=SPEECH_DBFS):
    """참조 클립이 시작/끝 경계에서 '말 도중' 인지 서술한다.

    tail_truncated=True 면 ICL 전제(전사 ⟷ 오디오 일치)가 깨질 수 있다는 신호다 — 전사가
    문장을 끝까지 적고 있으면 오디오에 없는 꼬리가 생기고, 그 꼬리가 생성물 앞에 붙는다.
    반대로 head_truncated 는 문장 중간부터 시작한 클립이라는 뜻이다.

    판정은 절단 '사실' 이 아니라 '경계 창이 발화 수준인가' 다 — 원본을 모르는 상태에서
    말 도중인지 아는 유일한 결정적 신호이며, 임계는 무음 정책과 같은 -40 dBFS 를 쓴다."""
    mono = np.asarray(mono, dtype=np.float64)
    if sr <= 0:
        raise ValueError("sr 은 양수여야 한다")
    n = max(1, int(round(sr * window_ms / 1000.0)))
    head_db = _rms_dbfs(mono[:n])
    tail_db = _rms_dbfs(mono[-n:]) if mono.size else -120.0
    return {
        "window_ms": float(window_ms),
        "speech_dbfs": float(speech_dbfs),
        "head_dbfs": round(head_db, 2),
        "tail_dbfs": round(tail_db, 2),
        "head_truncated": bool(head_db >= speech_dbfs),
        "tail_truncated": bool(tail_db >= speech_dbfs),
    }


def _ncc_scan(win, hay):
    """win 을 hay 위에서 모든 지연에 대해 미끄러뜨린 정규화 상호상관의 (최대 절댓값, 지연).

    분자는 FFT 상호상관, 분모는 hay 의 이동 에너지 × win 에너지 — 창마다 재계산하지 않는다.
    파형이 그대로 복사됐으면 그 지연에서 1.0 이 나온다(진폭 배율에는 불변)."""
    n = win.size
    m = hay.size
    if n == 0 or m < n:
        return 0.0, -1
    size = 1
    while size < m + n:
        size <<= 1
    corr = np.fft.irfft(np.fft.rfft(hay, size) * np.conj(np.fft.rfft(win, size)), size)
    corr = corr[:m - n + 1]                       # 지연 k 에서 sum_i hay[i+k]*win[i]
    cum = np.concatenate(([0.0], np.cumsum(hay * hay)))
    den = np.sqrt(cum[n:] - cum[:-n]) * np.sqrt(float(np.dot(win, win)))
    den = np.where(den <= 1e-12, np.inf, den)
    r = np.abs(corr / den)
    i = int(np.argmax(r))
    return float(r[i]), i


def waveform_copy_scan(generated, reference, sr,
                       window_ms=COPY_WINDOW_MS, hop_ms=COPY_HOP_MS,
                       ncc_threshold=COPY_NCC_THRESHOLD, silence_dbfs=SPEECH_DBFS):
    """생성 파형의 각 창이 참조 파형 어딘가와 그대로 일치하는지 훑는다.

    무음 창은 건너뛴다 — 무음끼리는 상관이 의미 없고 위양성만 만든다.
    hits 에는 임계를 넘은 창의 '위치와 값' 만 담는다(샘플은 담지 않는다)."""
    generated = np.asarray(generated, dtype=np.float64)
    reference = np.asarray(reference, dtype=np.float64)
    if sr <= 0:
        raise ValueError("sr 은 양수여야 한다")
    n = max(1, int(round(sr * window_ms / 1000.0)))
    hop = max(1, int(round(sr * hop_ms / 1000.0)))

    hits = []
    peak = 0.0
    peak_at = -1.0
    peak_lag = -1.0
    scanned = 0
    for s in range(0, max(generated.size - n + 1, 0), hop):
        w = generated[s:s + n]
        if w.size < n or _rms_dbfs(w) < silence_dbfs:
            continue
        scanned += 1
        val, lag = _ncc_scan(w, reference)
        if val > peak:
            peak, peak_at, peak_lag = val, s / sr, lag / sr
        if val >= ncc_threshold:
            hits.append({"out_sec": round(s / sr, 3), "ncc": round(val, 4),
                         "ref_sec": round(lag / sr, 3)})
    return {
        "window_ms": float(window_ms), "hop_ms": float(hop_ms),
        "ncc_threshold": float(ncc_threshold),
        "scanned_windows": scanned,
        "peak_ncc": round(peak, 4),
        "peak_out_sec": round(peak_at, 3) if peak_at >= 0 else None,
        "peak_ref_sec": round(peak_lag, 3) if peak_lag >= 0 else None,
        "hit_count": len(hits),
        "hits": hits,
        "copy_detected": bool(hits),
    }


def _ngrams(units, n):
    units = tuple(units)
    if n <= 0 or len(units) < n:
        return set()
    return {"".join(units[i:i + n]) for i in range(len(units) - n + 1)}


def short_ngram_leaks(reference_units, target_units, asr_units, sizes=SHORT_NGRAM_SIZES):
    """ASR 결과에 '참조에는 있고 타깃에는 없는' 짧은 조각이 몇 개 들어왔는지 센다.

    타깃에도 있는 조각은 뺀다 — 그건 정상 출력이지 혼입이 아니다. 흔한 조사·어미가 통째로
    걸리는 것을 줄이려고 조각 길이는 호출부가 정하되 기본은 2·3음절이다(기존 검사가 4음절
    이상만 봐서 놓친 구간). 단위 배열은 korean_cer.syllable_units / jamo_units 결과를 그대로 받는다."""
    ref = tuple(reference_units)
    tgt = tuple(target_units)
    asr = tuple(asr_units)
    per_size = {}
    total = 0
    for n in sizes:
        found = sorted((_ngrams(asr, n) & _ngrams(ref, n)) - _ngrams(tgt, n))
        per_size[str(n)] = {"count": len(found), "items": found}
        total += len(found)
    return {"sizes": [int(n) for n in sizes], "total": total,
            "per_size": per_size, "leak_detected": total > 0}
