# -*- coding: utf-8 -*-
"""실제 최대치(true peak) 측정 + 앞보기 리미터 — 소리가 정한 최대치를 넘지 않게 **미리** 살짝 줄인다.

흡수 출처(2026-10-16, MIT/Apache): SoundCraft
  - `crates/dsp/src/meter.rs` — 4배 다상(polyphase) windowed-sinc 보간으로 샘플 사이의 최대치를 잰다.
  - `crates/dsp/src/plugins/dynamics.rs` Maximizer — 필요한 이득을 앞보기 창에서 최소값으로 잡고(min-hold),
    같은 길이 이동평균으로 부드럽게 한 뒤, 신호보다 먼저 이득을 낮춘다.
  여기서는 실시간 플러그인이 아니라 **파일 전체를 한 번에** 처리하므로 지연선 대신 앞쪽을 미리 본다.

★왜 잘라내기(clip)가 아닌가: 넘는 샘플만 1.0 으로 자르면 파형이 각져 '찌직' 소리가 난다.
  리미터는 넘기 직전 1.5ms 동안 이득을 매끄럽게 낮췄다가 천천히(해제 시간) 되돌린다.
★보증: 결과의 실제 최대치는 ceiling 을 넘지 않는다(마지막에 재서 넘으면 그만큼 한 번 더 낮춘다).
  ceiling 아래인 소리는 **바뀌지 않는다**(이득 1.0 그대로).

numpy 만 쓴다(앱 파이썬에 scipy 가 없다).
"""
import numpy as np

CEILING_DBTP = -1.0      # 배포용 음성의 흔한 상한(SoundCraft Maximizer 기본 −0.3dB 보다 여유 있게)
LOOKAHEAD_MS = 1.5       # SoundCraft MAX_LOOKAHEAD_MS
RELEASE_MS = 50.0        # SoundCraft Maximizer release 기본
OVERSAMPLE = 4
_TAPS_PER_PHASE = 12
_BLOCK = 32              # 해제 곡선을 계산하는 단위(약 0.7ms @44.1k) — 이득은 이 사이를 직선으로 잇는다


class LimiterError(ValueError):
    """처리할 수 없는 입력(빈 소리·숫자가 아닌 값)."""


def db_to_lin(db):
    return float(10.0 ** (db / 20.0))


def lin_to_db(v):
    return float(20.0 * np.log10(max(float(v), 1e-12)))


def _as_2d(x):
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 1:
        a = a[:, None]
    if a.ndim != 2 or a.shape[0] == 0:
        raise LimiterError('소리가 비어 있습니다')
    if not np.all(np.isfinite(a)):
        raise LimiterError('소리에 숫자가 아닌 값(NaN·무한대)이 있습니다')
    return a


def _phase_filters():
    """4배 보간용 저역 통과 필터를 다상으로 나눈다(Hann 창 sinc, 차단 = 원래 나이퀴스트)."""
    n = OVERSAMPLE * _TAPS_PER_PHASE
    t = (np.arange(n) - (n - 1) / 2.0) / OVERSAMPLE
    h = np.sinc(t) * np.hanning(n)
    h = h / h.sum() * OVERSAMPLE
    return [h[p::OVERSAMPLE] for p in range(OVERSAMPLE)]


_PHASES = _phase_filters()


def _true_peak_env(a):
    """원래 샘플마다 '그 샘플과 다음 샘플 사이' 실제 최대치(채널 중 최대) — 길이 = 샘플 수."""
    env = np.abs(a).max(axis=1)
    half = _TAPS_PER_PHASE // 2
    for ch in range(a.shape[1]):
        x = a[:, ch]
        for f in _PHASES:
            y = np.convolve(x, f, mode='full')[half - 1: half - 1 + x.size]
            np.maximum(env, np.abs(y), out=env)
    return env


def true_peak(x):
    """실제 최대치(선형). 샘플 사이에 숨은 최대치까지 본다(4배 보간)."""
    return float(_true_peak_env(_as_2d(x)).max())


def _moving_min_ahead(g, n):
    """m[i] = min(g[i .. i+n]) — 앞을 내다본 최소."""
    if n <= 0:
        return g.copy()
    pad = np.concatenate([g, np.full(n, g[-1])])
    return np.lib.stride_tricks.sliding_window_view(pad, n + 1).min(axis=1)


def _moving_mean_behind(m, n):
    """s[i] = mean(m[i-n .. i]) — 앞은 m[0] 으로 채운다. 각 항이 i 이후 n 샘플 안의 최소라서 s[i] ≤ g[i] 가 성립한다."""
    if n <= 0:
        return m.copy()
    pad = np.concatenate([np.full(n, m[0]), m])
    c = np.concatenate([[0.0], np.cumsum(pad)])
    return (c[n + 1:] - c[:-(n + 1)]) / (n + 1)


def limit(x, sr, *, ceiling_db=CEILING_DBTP, lookahead_ms=LOOKAHEAD_MS, release_ms=RELEASE_MS):
    """x(샘플×채널 또는 1차원)를 실제 최대치 ceiling_db 아래로. (결과, 정보) 를 돌려준다.

    채널은 같은 이득을 쓴다(스테레오 위치가 흔들리지 않게 — SoundCraft 스테레오 링크).
    결과는 입력과 같은 모양·float32.
    """
    if not sr or sr <= 0:
        raise LimiterError('표본율이 올바르지 않습니다')
    a = _as_2d(x)
    one_d = np.asarray(x).ndim == 1
    ceiling = db_to_lin(ceiling_db)
    env = _true_peak_env(a)
    tp_before = float(env.max())
    info = {'true_peak_before_dbtp': lin_to_db(tp_before), 'ceiling_dbtp': float(ceiling_db),
            'max_reduction_db': 0.0, 'limited': False}
    if tp_before <= ceiling:
        info['true_peak_after_dbtp'] = info['true_peak_before_dbtp']
        out = a.astype(np.float32)
        return (out[:, 0] if one_d else out), info

    need = np.minimum(1.0, ceiling / np.maximum(env, 1e-12))       # 샘플마다 필요한 이득
    look = max(1, int(round(sr * lookahead_ms / 1000.0)))
    smooth = _moving_mean_behind(_moving_min_ahead(need, look), look)   # ≤ need, 넘기 전에 미리 내려감

    # 해제 — 내려간 이득을 천천히 되돌린다(블록 단위 한 극 필터, 위로만 느리게).
    nb = int(np.ceil(smooth.size / _BLOCK))
    pad = np.concatenate([smooth, np.full(nb * _BLOCK - smooth.size, smooth[-1])])
    bmin = pad.reshape(nb, _BLOCK).min(axis=1)
    coef = float(np.exp(-_BLOCK / (sr * release_ms / 1000.0)))
    rel = np.empty(nb)
    cur = 1.0
    for i in range(nb):
        b = bmin[i]
        cur = b if b < cur else b + (cur - b) * coef
        rel[i] = cur
    centers = np.arange(nb) * _BLOCK + (_BLOCK - 1) / 2.0
    gain = np.minimum(np.interp(np.arange(smooth.size), centers, rel), smooth)

    y = a * gain[:, None]
    tp_after = true_peak(y)
    if tp_after > ceiling:                     # 보간·근사로 남은 미세 초과 — 한 번 더 고르게 낮춘다
        y *= ceiling / tp_after
        gain *= ceiling / tp_after
        tp_after = true_peak(y)
    info.update({'true_peak_after_dbtp': lin_to_db(tp_after),
                 'max_reduction_db': -lin_to_db(float(gain.min())), 'limited': True})
    out = y.astype(np.float32)
    return (out[:, 0] if one_d else out), info


def limit_file(src, dest=None, **kw):
    """파일을 읽어 limit 하고 같은 형식(subtype)으로 쓴다. dest 가 없으면 제자리(임시본 → 바꾸기)."""
    import os
    import soundfile as sf
    data, sr = sf.read(src, always_2d=True, dtype='float64')
    sub = sf.info(src).subtype
    y, info = limit(data, sr, **kw)
    dest = dest or src
    tmp = dest + '.limit.part'
    sf.write(tmp, y, sr, subtype=sub, format='WAV' if dest.lower().endswith('.wav') else None)
    os.replace(tmp, dest)
    return info
