# -*- coding: utf-8 -*-
"""따라부르기용 **짧고 깨끗한 참조 토막**을 고른다.

★왜 짧아야 하나 (2026-09-20 실측)
  변환기가 한 번에 처리하는 창은 대략 `30초 - 참조 길이` 다.
  참조를 25초 주면 남는 창이 5초뿐이라 4분 곡이 잘게 쪼개지고,
  이음매가 쌓여 뒤로 갈수록 무너진다. 8초면 토막이 훨씬 준다.
  **그래서 참조를 통째로 넘기면 안 된다.**

★왜 아무 데나 자르면 안 되나
  앞 8초가 무음이거나 숨소리면 변환기가 음색을 제대로 못 잡는다.
  소리가 이어지고 · 음높이 확신이 높고 · 급변이 적은 구간을 골라야 한다.

이 파일은 **고르고 자르기만** 한다. 변환도 분리도 하지 않는다.
판정(어디를 고를까)은 소리 없이도 검사할 수 있게 숫자만 받는 함수로 떼어 두었다.
"""
import os

WINDOW_SEC = 8.0
HOP_SEC = 0.5

# 창 안에서 목소리로 판정된 자리가 이만큼은 돼야 후보로 본다.
MIN_VOICED_RATIO = 0.4
# 이보다 크게 음높이가 튀면 '급변' 으로 센다(센트).
JUMP_CENTS = 200.0


class SongReferenceError(RuntimeError):
    """참조 토막을 고를 수 없는 상태."""


def window_score(voiced_ratio, confidence, jump_ratio):
    """구간 하나의 점수. **소리 없이도 검사할 수 있게** 숫자만 받는다.

    셋을 곱하는 이유: 하나라도 나쁘면 쓸 수 없는 구간이기 때문이다.
      · 소리가 끊기면 음색을 못 잡는다
      · 음높이 확신이 낮으면 애초에 목소리가 아닐 수 있다
      · 급변이 잦으면 한 사람의 평소 음색으로 보기 어렵다
    """
    return float(voiced_ratio) * float(confidence) * (1.0 - float(jump_ratio))


def best_window(scores, hop_sec=HOP_SEC):
    """점수들 중 가장 좋은 자리의 시작 초. 빈손이면 사유를 들고 실패한다."""
    usable = [(i, s) for i, s in enumerate(scores) if s is not None and s > 0]
    if not usable:
        raise SongReferenceError(
            '참조로 쓸 만한 구간을 찾지 못했습니다 — 목소리가 이어지는 토막이 없습니다.')
    return max(usable, key=lambda t: t[1])[0] * float(hop_sec)


def scan(path, window_sec=WINDOW_SEC, hop_sec=HOP_SEC):
    """소리를 읽어 구간마다 점수를 매긴다. 돌려주는 것은 (점수들, 전체 길이)."""
    import numpy as np
    import librosa

    y, sr = librosa.load(path, sr=16000, mono=True)
    total = len(y) / float(sr)
    if total <= window_sec:
        return [], total                      # 통째로 써도 짧다

    f, voiced, prob = librosa.pyin(y, fmin=70, fmax=1000, sr=sr, frame_length=1024)
    fps = sr / 256.0                          # pyin 기본 hop
    n = int(window_sec * fps)
    scores = []
    t = 0.0
    while t + window_sec <= total:
        a = int(t * fps)
        seg_f, seg_v, seg_p = f[a:a + n], voiced[a:a + n], prob[a:a + n]
        ok = seg_v & np.isfinite(seg_f)
        if ok.sum() < n * MIN_VOICED_RATIO:
            scores.append(None)               # 소리가 너무 없다
        else:
            cents = 1200.0 * np.log2(seg_f[ok] / 55.0)
            jump = (float(np.mean(np.abs(np.diff(cents)) > JUMP_CENTS))
                    if ok.sum() > 2 else 1.0)
            scores.append(window_score(ok.mean(), float(np.nanmean(seg_p[ok])), jump))
        t += hop_sec
    return scores, total


def cut(src, dest, seconds=WINDOW_SEC):
    """가장 깨끗한 구간을 잘라 낸다. 만들어진 경로를 돌려준다."""
    import librosa
    import soundfile as sf

    if not os.path.isfile(src):
        raise SongReferenceError('참조로 쓸 소리 파일이 없습니다: %s' % os.path.basename(src))
    scores, total = scan(src, seconds)
    start = 0.0 if not scores else best_window(scores)
    dur = min(float(seconds), total)

    y, sr = librosa.load(src, sr=None, mono=False)
    if getattr(y, 'ndim', 1) > 1:
        y = y.T
    seg = y[int(start * sr):int((start + dur) * sr)]
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or '.', exist_ok=True)
    sf.write(dest, seg, sr)
    return {'path': dest, 'start_sec': round(start, 2), 'seconds': round(dur, 2),
            'source_sec': round(total, 2)}
