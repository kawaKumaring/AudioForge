# -*- coding: utf-8 -*-
"""빚은 곡선을 **소리에 되돌린다** — 손잡이와 소리를 잇는 자리.

`pitch_shape.py` 는 숫자만 빚는다. 이 파일이 그것을 실제 소리로 만든다.
갈라 둔 이유는 빚는 규칙을 GPU 없이 검사하기 위해서다.

★왜 입력을 고치나 (2026-09-26 실측으로 확인)
  변환기에 3반음 올린 소리를 넣었더니 결과도 **정확히 3.00반음** 올라왔다.
  입력의 음높이가 그대로 통과한다는 뜻이다. 그래서 결과물을 사후에 손보는 것보다
  **입력을 고쳐 넣는 쪽**이 맞다 — 변환기가 고쳐진 곡선을 그대로 따라간다.

  이것을 화면 만들기 전에 확인했다. 통과하지 않았다면 손잡이는 돌아가는데 소리는
  안 변하는, 연결되지 않은 계기판을 만들 뻔했다.

★소리를 한 번 되합성하는 값을 치른다
  음높이만 갈아 끼우려면 소리를 분해했다 다시 합쳐야 한다. 공짜가 아니다.
  그래서 **손잡이를 안 돌리면 되합성도 하지 않는다**(아래 `reshape` 참고).
"""
import os

import pitch_shape

# 분석 간격(밀리초). 촘촘할수록 곡선이 세밀하지만 느리다.
FRAME_MS = 5.0
ANALYZE_SR = 32000


class PitchApplyError(RuntimeError):
    """소리에 되돌릴 수 없는 상태."""


def _load(path, sr=ANALYZE_SR, seconds=None):
    import librosa
    import numpy as np
    if not os.path.isfile(path):
        raise PitchApplyError('소리 파일이 없습니다: %s' % os.path.basename(path))
    y, got = librosa.load(path, sr=sr, mono=True, duration=seconds)
    if len(y) == 0:
        raise PitchApplyError('소리가 비어 있습니다: %s' % os.path.basename(path))
    return np.asarray(y, dtype='float64'), got


def curve(path, *, seconds=None):
    """보여 주기 위한 음높이 곡선. (시각들, Hz들) — 소리 없는 자리는 0.

    ★화면이 이것을 그린다. 그리는 것과 빚는 것이 **같은 값**이어야 한다 —
      다르면 사람이 보고 맞춘 것과 실제로 먹는 것이 어긋난다.
    """
    import pyworld
    y, sr = _load(path, seconds=seconds)
    f0, t = pyworld.harvest(y, sr, frame_period=FRAME_MS)
    return [float(x) for x in t], [float(x) for x in f0]


def reshape(path, dest, knobs=None, *, seconds=None):
    """손잡이를 먹여 새 소리를 만든다.

    돌려주는 것: `{'path', 'before', 'after', 'changed'}`.
    **빚은 곡선을 함께 돌려준다** — 화면이 그것을 그리고, 검사가 그것을 확인한다.

    ★되합성한 소리를 다시 분석해 확인하려 하면 안 된다(2026-09-26에 그렇게 짜서
      헛되이 헤맸다). 그건 내 계산이 아니라 **분석기를 시험하는 것**이고,
      분석기는 되합성된 소리에서 다른 값을 낸다. 약속은 곡선으로 확인한다.

    ★손잡이를 안 돌렸으면 되합성하지 않는다. 공짜가 아닌 일을 헛되이 치르지 않는다.
    """
    k = dict(pitch_shape.NEUTRAL)
    k.update(knobs or {})
    if k == pitch_shape.NEUTRAL:
        _, f0 = curve(path, seconds=seconds)
        return {'path': path, 'before': f0, 'after': list(f0), 'changed': False}

    import numpy as np
    import pyworld
    import soundfile as sf

    y, sr = _load(path, seconds=seconds)
    f0, t = pyworld.harvest(y, sr, frame_period=FRAME_MS)
    sp = pyworld.cheaptrick(y, f0, t, sr)
    ap = pyworld.d4c(y, f0, t, sr)

    shaped = pitch_shape.to_hz(
        pitch_shape.apply_knobs(pitch_shape.to_semitones(f0), k))
    new_f0 = np.asarray(shaped, dtype='float64')
    # ★소리가 없던 자리는 끝까지 없어야 한다. 빚다가 살아나면 없던 소리를 만든다.
    new_f0[np.asarray(f0) <= 0] = 0.0

    w = pyworld.synthesize(new_f0, sp, ap, sr, frame_period=FRAME_MS)
    peak = float(np.max(np.abs(w))) if len(w) else 0.0
    if peak > 1.0:
        w = w / peak * 0.98
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or '.', exist_ok=True)
    sf.write(dest, w, sr)
    return {'path': dest, 'before': [float(x) for x in f0],
            'after': [float(x) for x in new_f0], 'changed': True}


def fit_knobs(target_path, current_path, *, seconds=None):
    """원본에 가까워지도록 손잡이를 프로그램이 맞춘다. (손잡이, 점수).

    사람이 이어받아 돌릴 수 있는 **같은 손잡이**를 돌려준다.
    """
    _, a = curve(target_path, seconds=seconds)
    _, b = curve(current_path, seconds=seconds)
    n = min(len(a), len(b))
    if n == 0:
        raise PitchApplyError('견줄 곡선이 없습니다.')
    return pitch_shape.auto_fit(pitch_shape.to_semitones(a[:n]),
                                pitch_shape.to_semitones(b[:n]))
