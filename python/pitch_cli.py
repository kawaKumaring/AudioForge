# -*- coding: utf-8 -*-
"""화면이 부르는 입구 — 음높이 곡선을 내주고, 손잡이를 먹여 소리를 만든다.

판단은 `pitch_shape.py`(빚기)와 `pitch_apply.py`(소리에 잇기)에 있다.
이 파일은 **부르고 결과를 JSON 으로 건네기만** 한다.

쓰는 법:
  <앱파이썬> pitch_cli.py curve   --audio A.wav --out r.json [--seconds 20]
  <앱파이썬> pitch_cli.py reshape --audio A.wav --dest B.wav --out r.json
                                  [--smooth 0.3] [--spread 1.5] [--shift 2]
  <앱파이썬> pitch_cli.py fit     --target T.wav --audio A.wav --out r.json

★곡선은 화면이 그릴 만큼만 줄여서 준다. 4분 곡이면 칸이 5만 개인데
  그대로 보내면 화면이 멈춘다. 줄이는 것은 **보여 주기 위해서만**이고,
  실제로 빚을 때는 줄이지 않은 값을 쓴다.
"""
import argparse
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pitch_apply  # noqa: E402
import pitch_shape  # noqa: E402

# 화면에 보낼 최대 점 개수. 이보다 많으면 솎아 낸다.
MAX_POINTS = 1200


def thin(times, values, limit=MAX_POINTS):
    """보여 주기 위해 솎아 낸다. **소리 없는 자리를 지우지 않는다** —
    지우면 화면에서 쉬는 자리가 사라져 이어진 것처럼 보인다."""
    n = len(values)
    if n <= limit:
        return list(times), list(values)
    step = n / float(limit)
    ts, vs = [], []
    i = 0.0
    while int(i) < n:
        j = int(i)
        k = min(n, int(i + step))
        chunk = values[j:k]
        live = [v for v in chunk if v and v > 0]
        # 한 칸이라도 소리가 없으면 그 사실을 남긴다(다수결이 아니라 **있는 그대로**).
        vs.append(sorted(live)[len(live) // 2] if len(live) > len(chunk) / 2 else 0.0)
        ts.append(times[j])
        i += step
    return ts, vs


def _write(out, payload):
    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False)


def cmd_curve(a):
    t, f = pitch_apply.curve(a.audio, seconds=a.seconds)
    ts, vs = thin(t, f)
    _write(a.out, {'ok': True, 'times': ts, 'hz': vs,
                   'frames': len(f), 'shown': len(vs)})


def cmd_reshape(a):
    knobs = {'smooth': a.smooth, 'spread': a.spread, 'shift': a.shift}
    r = pitch_apply.reshape(a.audio, a.dest, knobs, seconds=a.seconds)
    t, _ = pitch_apply.curve(a.audio, seconds=a.seconds)
    _, before = thin(t, r['before'])
    ts, after = thin(t, r['after'])
    _write(a.out, {'ok': True, 'path': r['path'], 'changed': r['changed'],
                   'times': ts, 'before': before, 'after': after})


def cmd_fit(a):
    knobs, score = pitch_apply.fit_knobs(a.target, a.audio, seconds=a.seconds)
    _write(a.out, {'ok': True, 'knobs': knobs, 'score': score})


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    c = sub.add_parser('curve');   c.set_defaults(fn=cmd_curve)
    c.add_argument('--audio', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--seconds', type=float, default=None)

    r = sub.add_parser('reshape'); r.set_defaults(fn=cmd_reshape)
    r.add_argument('--audio', required=True)
    r.add_argument('--dest', required=True)
    r.add_argument('--out', required=True)
    r.add_argument('--seconds', type=float, default=None)
    r.add_argument('--smooth', type=float, default=pitch_shape.NEUTRAL['smooth'])
    r.add_argument('--spread', type=float, default=pitch_shape.NEUTRAL['spread'])
    r.add_argument('--shift', type=float, default=pitch_shape.NEUTRAL['shift'])

    f = sub.add_parser('fit');     f.set_defaults(fn=cmd_fit)
    f.add_argument('--target', required=True)
    f.add_argument('--audio', required=True)
    f.add_argument('--out', required=True)
    f.add_argument('--seconds', type=float, default=None)

    a = ap.parse_args()
    try:
        a.fn(a)
    except Exception as e:
        # ★실패를 조용히 넘기지 않는다. 화면이 사유를 보여 줘야 한다.
        _write(a.out, {'ok': False, 'error': str(e)[:300]})
        raise


if __name__ == '__main__':
    main()
