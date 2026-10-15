"""발음을 자르지 않는 연결 보조 규칙. 화자/잡음 분류기가 아니다."""
import numpy as np


def active_rms(data, sr):
    """20ms 창 중 -60dBFS 및 최고 창 대비 -35dB 이상만 음량 추정에 사용.
    신호 자체는 바꾸지 않는다. 채널을 평균해 위상 상쇄시키지 않는다.
    """
    x = np.asarray(data, dtype=np.float64)
    if not x.size:
        return 0.0
    if x.ndim == 1:
        x = x[:, None]
    hop = max(1, round(sr * .02))
    energies = np.array([np.mean(x[i:i+hop] ** 2) for i in range(0, len(x), hop)])
    lengths = np.array([min(hop, len(x)-i) for i in range(0, len(x), hop)])
    gate = max(1e-6, float(energies.max()) * 10 ** (-35 / 10))
    keep = energies >= gate
    if not keep.any():
        return 0.0
    return float(np.sqrt(np.average(energies[keep], weights=lengths[keep])))


def quiet_edge(data, sr, *, onset=False):
    """2ms 전부 -60dBFS 이하일 때만 영점으로 연결. 발화 후보는 그대로 둔다.
    샘플 수/순서 불변. 작은 호흡도 바뀔 수 있어 적용 여부를 반환한다.
    """
    x = np.asarray(data)
    n = min(len(x)//2, max(1, round(sr * .002)))
    if n < 2:
        return x, False
    edge = x[:n] if onset else x[-n:]
    if not np.all(np.isfinite(edge)) or np.max(np.abs(edge)) > .001:
        return x, False
    if not np.any(edge):
        return x, False
    out = x.copy()
    ramp = np.linspace(0., 1., n, dtype=np.float32)
    if x.ndim == 2:
        ramp = ramp[:, None]
    if onset:
        out[:n] *= ramp
    else:
        out[-n:] *= ramp[::-1]
    return out, True


def peak_safe(data):
    """과대 진폭만 전체 동일 배율로 줄임. 압축·클리핑·주파수 보정 없음."""
    x = np.asarray(data)
    peak = float(np.max(np.abs(x))) if x.size else 0.
    gain = .97 / peak if peak > .97 else 1.
    return (x * gain if gain < 1. else x), gain


def has_active_tail(data, sr, window_ms=20):
    """끝창에 -60dBFS를 넘는 샘플이 있으면 감쇠하지 않는다.
    발음 완전성 판정이 아니라 보수적인 후처리 보호 조건이다.
    """
    x = np.asarray(data)
    n = min(len(x), max(1, round(sr * window_ms / 1000)))
    return bool(n and (not np.all(np.isfinite(x[-n:])) or
                      np.max(np.abs(x[-n:])) > .001))
