"""생성본을 **카드 순서대로 이어 붙여** 파일 하나로 만든다.

★이 파일이 지키는 것 (2026-09-27 지시)
  · 원본 생성본은 **읽기만** 한다. 어떤 경로에서도 덮어쓰지 않는다.
  · 말끝·호흡을 자르지 않는다. 발음을 겹치는 크로스페이드를 넣지 않는다.
    '경계 다듬기' 는 이음매에서 **딸깍 소리만 없애는 아주 짧은 기울기**다.
  · 무음을 자동으로 제거하지 않는다. 길이를 맞추려고 소리를 깎지 않는다.
  · 레이트·채널이 달라도 **재생 속도와 음높이가 바뀌지 않게** 맞춘다.
  · 피크를 넘기지 않는다. 음량 맞추기는 과하게 끌어올리지 않는다.

들어오는 계획(JSON):
  {"steps":[{"path":..., "gapBefore":초}, ...], "level":bool, "edges":bool, "output":경로}

돌려주는 것(JSON 한 줄): {"ok":true,"path":...,"seconds":...,"peak":...,"sampleRate":...}
"""
import json
import math
import os
import sys

# 이음매에서 딸깍 소리만 없앨 만큼. 말끝을 자르는 길이가 아니다.
EDGE_MS = 5.0
# 음량 맞추기가 한 조각을 끌어올릴 수 있는 최대치(dB). 과하게 키우면 숨소리까지 커진다.
MAX_BOOST_DB = 6.0
MAX_CUT_DB = 12.0
# 최종 피크 여유. 1.0 을 넘기면 깨진다.
PEAK_CEIL = 0.97


def _die(message, code="JOIN_FAILED"):
    sys.stdout.write(json.dumps({"ok": False, "error": message, "code": code}, ensure_ascii=False) + "\n")
    raise SystemExit(1)


def _rms(x):
    import numpy as np
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype="float64"))))


def _to_mono_or_keep(data, want_channels):
    """채널 수를 맞춘다. 모노→스테레오는 복제, 스테레오→모노는 평균."""
    import numpy as np
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    have = data.shape[1]
    if have == want_channels:
        return data
    if want_channels == 1:
        return np.mean(data, axis=1, keepdims=True)
    return np.repeat(data[:, :1], want_channels, axis=1)


def _resample(data, src_rate, dst_rate):
    """레이트를 맞춘다. **길이를 비율대로 늘리고 줄인다** — 속도·음높이가 바뀌지 않는다.

    선형 보간이다. 말소리를 이어 붙이는 데에는 충분하고, 무엇보다 예측 가능하다.
    """
    import numpy as np
    if src_rate == dst_rate or data.shape[0] == 0:
        return data
    ratio = float(dst_rate) / float(src_rate)
    n_out = int(round(data.shape[0] * ratio))
    if n_out <= 0:
        return data[:0]
    src_idx = np.linspace(0.0, data.shape[0] - 1.0, n_out)
    out = np.empty((n_out, data.shape[1]), dtype="float32")
    base = np.arange(data.shape[0], dtype="float64")
    for ch in range(data.shape[1]):
        out[:, ch] = np.interp(src_idx, base, data[:, ch].astype("float64")).astype("float32")
    return out


def _edge_shape(data, rate):
    """이음매의 아주 짧은 기울기. **말끝을 자르지 않는다** — 값만 0 에서 출발해 0 으로 닿는다."""
    import numpy as np
    n = int(round(rate * EDGE_MS / 1000.0))
    if n <= 1 or data.shape[0] < n * 2:
        return data
    ramp = np.linspace(0.0, 1.0, n, dtype="float32").reshape(-1, 1)
    data[:n] *= ramp
    data[-n:] *= ramp[::-1]
    return data


def load_plan(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def join(plan):
    import numpy as np
    import soundfile as sf

    steps = plan.get("steps") or []
    if not steps:
        _die("이어 붙일 것이 없습니다.", "JOIN_EMPTY")
    out_path = plan.get("output") or ""
    if not out_path:
        _die("저장할 자리를 알 수 없습니다.", "JOIN_NO_OUTPUT")

    pieces = []
    rates, chans = [], []
    for s in steps:
        p = s.get("path") or ""
        if not os.path.isfile(p):
            _die("생성본 파일을 찾지 못했습니다: %s" % os.path.basename(p), "JOIN_MISSING_TAKE")
        try:
            data, rate = sf.read(p, dtype="float32", always_2d=True)
        except Exception as e:
            _die("생성본을 읽지 못했습니다(%s): %s" % (os.path.basename(p), e), "JOIN_READ_FAILED")
        if data.shape[0] == 0:
            _die("빈 생성본이 있습니다: %s" % os.path.basename(p), "JOIN_EMPTY_TAKE")
        pieces.append({"data": data, "rate": int(rate), "gap": float(s.get("gapBefore") or 0.0)})
        rates.append(int(rate))
        chans.append(data.shape[1])

    # 가장 높은 레이트로 맞춘다 — 낮추면 있던 소리를 잃는다.
    target_rate = max(rates)
    target_ch = max(chans)

    normed = []
    for pc in pieces:
        d = _to_mono_or_keep(pc["data"], target_ch)
        d = _resample(d, pc["rate"], target_rate)
        normed.append({"data": d, "gap": pc["gap"]})

    # 음량 맞추기 — 조각별 RMS 를 가운데값 쪽으로 당긴다. **과하게 키우지 않는다.**
    if plan.get("level"):
        levels = [_rms(x["data"]) for x in normed]
        usable = [v for v in levels if v > 1e-6]
        if len(usable) >= 2:
            target = float(np.median(usable))
            for x, v in zip(normed, levels):
                if v <= 1e-6:
                    continue
                db = 20.0 * math.log10(target / v)
                db = max(-MAX_CUT_DB, min(MAX_BOOST_DB, db))
                if abs(db) > 0.05:
                    x["data"] = x["data"] * float(10.0 ** (db / 20.0))

    if plan.get("edges"):
        for x in normed:
            x["data"] = _edge_shape(np.array(x["data"], dtype="float32", copy=True), target_rate)

    # 붙인다 — 조각 앞의 빈 자리는 **무음**이다. 소리를 겹치지 않는다.
    chunks = []
    for i, x in enumerate(normed):
        if i > 0 and x["gap"] > 0:
            n = int(round(target_rate * x["gap"]))
            if n > 0:
                chunks.append(np.zeros((n, target_ch), dtype="float32"))
        chunks.append(x["data"].astype("float32", copy=False))
    joined = np.concatenate(chunks, axis=0) if chunks else np.zeros((0, target_ch), dtype="float32")

    # 피크가 넘으면 통째로 낮춘다(조각마다 다르게 깎으면 음량이 출렁인다).
    peak = float(np.max(np.abs(joined))) if joined.size else 0.0
    if peak > PEAK_CEIL:
        joined = joined * (PEAK_CEIL / peak)
        peak = PEAK_CEIL

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    # ★새 파일에만 쓴다. 원본 생성본은 위에서 읽기만 했다.
    tmp = out_path + ".part"
    # 임시 이름(.part)에는 확장자 단서가 없으므로 형식을 명시한다 —
    # 반쯤 쓰다 만 파일이 최종 이름으로 보이지 않게 하는 것이 .part 의 목적이다.
    sf.write(tmp, joined, target_rate, subtype="PCM_16", format="WAV")
    os.replace(tmp, out_path)

    return {
        "ok": True, "path": out_path,
        "seconds": round(joined.shape[0] / float(target_rate), 3),
        "peak": round(peak, 4),
        "sampleRate": target_rate, "channels": target_ch,
        "pieces": len(normed),
    }


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--plan":
        _die("계획 파일이 필요합니다(--plan <경로>).", "JOIN_NO_PLAN")
    try:
        plan = load_plan(sys.argv[2])
    except Exception as e:
        _die("계획을 읽지 못했습니다: %s" % e, "JOIN_BAD_PLAN")
    result = join(plan)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
