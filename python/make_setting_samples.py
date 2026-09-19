# -*- coding: utf-8 -*-
"""시간 조절 **설정** 견본 — 말소리에 맞는 rubberband 설정을 고르기 위한 측정 스크립트.

왜 필요한가(2026-09-20): 기본 설정으로 만든 견본에서 1.1배부터 음질 변화가 들렸다.
rubberband 의 기본값은 범용(레벨 5)이고, 공식 문서에는 **말소리·보컬용 권장이 없다** —
피아노(레벨 1)와 드럼(레벨 6)만 적혀 있다. 그래서 문서에 적힌 지렛대 중
'시작음 처리'와 '위상 결합'을 끄는 레벨 2·3만 후보로 좁혔다.

공식 문서의 레벨 표(breakfastquay.com/rubberband/usage.txt):
  레벨 2 = --no-transients --no-lamination   → ffmpeg: transients=smooth : phase=independent
  레벨 3 = --no-transients                   → ffmpeg: transients=smooth
  레벨 5 = 기본값(지금 쓰는 것)

★이 스크립트는 판단하지 않는다. 어느 쪽이 나은지는 사람이 듣고 정한다.
★R3(Finer) 엔진은 문서가 보컬에 권하지만 ffmpeg 에서 고를 수 없다 — 별도 설치가 필요하다.

실행:
  python -X utf8 python/make_setting_samples.py [나갈폴더]
기본 나갈 폴더: _local/artifacts/dubbing/setting-samples  (저장소에 올라가지 않는다)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import librosa

import audio_fit

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')

# (이름, 설명, ffmpeg rubberband 설정)
SETTINGS = [
    ('A_기본', '지금 쓰는 것(레벨 5 · 범용)', {}),
    ('B_시작음끔', '레벨 3 — 시작음 처리를 끈다', {'transients': 'smooth'}),
    ('C_시작음끔_위상독립', '레벨 2 — 거기에 위상 결합까지 끈다',
     {'transients': 'smooth', 'phase': 'independent'}),
]
RATIOS = [1.10, 1.30]


def median_f0(path):
    y, sr = librosa.load(path, sr=16000, mono=True)
    f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr)
    return float(np.median(f0))


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        REPO, '_local', 'artifacts', 'dubbing', 'setting-samples')
    os.makedirs(out_dir, exist_ok=True)

    src_sec = audio_fit.probe_duration(FIXTURE)
    base_f0 = median_f0(FIXTURE)
    lines = ['원본 %.3f초 · 음높이 중앙값 %.1fHz' % (src_sec, base_f0), '']
    for name, desc, _ in SETTINGS:
        lines.append('%s = %s' % (name, desc))
    lines.append('')

    for ratio in RATIOS:
        for name, _desc, opts in SETTINGS:
            dest = os.path.join(out_dir, '%s_x%.2f.wav' % (name, ratio))
            info = audio_fit.stretch_to(FIXTURE, dest, src_sec / ratio, rb_options=opts)
            f0 = median_f0(dest)
            cents = 1200.0 * np.log2(f0 / base_f0)
            lines.append(
                '%.2f배 %-22s 길이 %.3f초(오차 %+.0fms) 음높이 %+.1f센트  %s'
                % (ratio, name, info['out_sec'],
                   (info['out_sec'] - info['target_sec']) * 1000.0, cents,
                   os.path.basename(dest)))
        lines.append('')

    report = os.path.join(out_dir, 'measurements.txt')
    with open(report, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    print('견본과 측정값: %s' % out_dir)
    print('★같은 배율끼리 A·B·C 를 견주어 듣는다. 이 스크립트는 판단하지 않는다.')


if __name__ == '__main__':
    main()
