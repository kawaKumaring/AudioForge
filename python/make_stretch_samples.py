# -*- coding: utf-8 -*-
"""시간 조절 배율 견본 — 한계선을 **듣고** 정하기 위한 측정 스크립트.

제품 코드가 아니다. 저장소 fixture 음성으로 여러 배율의 견본을 만들고,
길이가 정확한지·음높이가 유지되는지를 숫자로 재서 함께 적는다.
'자연스러운가' 는 사람이 듣고 판단한다 — 이 스크립트는 판단하지 않는다.

실행:
  python -X utf8 python/make_stretch_samples.py [나갈폴더]
기본 나갈 폴더: _local/artifacts/dubbing/stretch-samples  (저장소에 올라가지 않는다)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import librosa

import audio_fit

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
RATIOS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7]


def median_f0(path):
    y, sr = librosa.load(path, sr=16000, mono=True)
    f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr)
    return float(np.median(f0))


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        REPO, '_local', 'artifacts', 'dubbing', 'stretch-samples')
    os.makedirs(out_dir, exist_ok=True)

    src_sec = audio_fit.probe_duration(FIXTURE)
    base_f0 = median_f0(FIXTURE)
    lines = ['원본 %.3f초 · 음높이 중앙값 %.1fHz' % (src_sec, base_f0), '']

    for r in RATIOS:
        dest = os.path.join(out_dir, 'x%.2f.wav' % r)
        info = audio_fit.stretch_to(FIXTURE, dest, src_sec / r)
        f0 = median_f0(dest)
        cents = 1200.0 * np.log2(f0 / base_f0)
        lines.append(
            '%.2f배  길이 %.3f초(목표 %.3f초, 오차 %+.0fms)  음높이 %+.1f센트  %s'
            % (r, info['out_sec'], info['target_sec'],
               (info['out_sec'] - info['target_sec']) * 1000.0, cents,
               os.path.basename(dest)))

    report = os.path.join(out_dir, 'measurements.txt')
    with open(report, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    print('\n견본과 측정값: %s' % out_dir)
    print('★어느 배율까지 자연스러운지는 **들어 보고** 정한다. 이 스크립트는 판단하지 않는다.')


if __name__ == '__main__':
    main()
