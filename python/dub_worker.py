# -*- coding: utf-8 -*-
"""더빙 앞단 실행기 - dub_pipeline 의 네 단계에 **실제 일**을 끼워 넣는다.

순서·이어 하기·멈춤 판단은 전부 dub_pipeline.py 에 있다. 이 파일은 그 자리에
기존 워커를 불러다 놓는 배선일 뿐이다 - 판단을 여기에 또 쓰면 규칙이 두 곳에 생긴다.

실행:
  python -X utf8 python/dub_worker.py --video <영상> --out <폴더> [--force]

산출물(<폴더> 안):
  source.wav       영상에서 꺼낸 소리
  vocals.wav       갈라낸 목소리          background.wav  갈라낸 배경음
  transcript.json  알아들은 것(낱말 시각 포함)
  lines.json       줄마다 원문과 한국어

★번역은 **로컬 고정**이다. 구글(네트워크)은 dub_pipeline 이 막는다.
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_pipeline as dp
from audio_utils import emit

# 배경음은 보컬을 뺀 나머지 전부를 합친 것이다.
BACKGROUND_STEMS = ('drums', 'bass', 'other')


def _step_audio(ctx):
    """1. 영상에서 소리를 꺼낸다."""
    from audio_utils import convert_to_wav
    emit('progress', percent=4, message='영상에서 소리 꺼내는 중...')
    tmp = convert_to_wav(ctx['video_path'])
    dest = os.path.join(ctx['out_dir'], 'source.wav')
    try:
        shutil.copyfile(tmp, dest)
    finally:
        # convert_to_wav 는 임시 폴더를 만든다. 남기지 않는다.
        try:
            os.remove(tmp)
            os.rmdir(os.path.dirname(tmp))
        except OSError:
            pass


# ★첫 갈라내기 모델 — **사용자 청취로 정했다**(2026-09-26).
#   같은 곡을 셋으로 갈라 들려 드렸다: 지금 모델 · bleedless · 앙상블.
#   "2_bleedless 이것이 더 괜찮게 들린다" 는 판단을 받았다.
#   이름의 bleedless 는 **다른 소리가 새어 드는 것을 줄인 판**이라는 뜻이고,
#   신고 증상(갈라낸 보컬이 찢어진다)이 바로 그 새어 듦이었다.
#
#   ★한 곡으로 정한 값이다. 다른 곡에서 나쁘면 바꾼다 — 숫자로는 가릴 수 없고
#     귀로만 갈린다(2026-09-26에 품질 지표를 여섯 가지 써 봤고 전부 빗나갔다).
BLEEDLESS_MODEL = 'mel_band_roformer_kim_ft2_bleedless_unwa.ckpt'


def _separate_tracks(src, stem_dir):
    """보컬을 갈라낸다. **좋은 분리기를 먼저** 쓰고, 안 되면 물러선다.

    ★2026-09-20 사용자 청취에서 확정: 갈라낸 보컬이 지저분하면 그 지저분함이
      뒤의 모든 단계로 그대로 간다(합성에 기계음이 섞이고 음높이도 흔들린다).
      RoFormer 는 보컬 SDR 이 Demucs 보다 뚜렷이 높고 **이미 설치돼 있다** —
      쓰지 않을 이유가 없었는데 처음에 Demucs 를 골랐다. 그 선택을 되돌린다.
    """
    from music_worker import run_music_separation, run_roformer_separation
    for model, tag in ((BLEEDLESS_MODEL, 'bleedless'), (None, 'roformer')):
        try:
            tracks = (run_roformer_separation(src, stem_dir, model) if model
                      else run_roformer_separation(src, stem_dir))
            if tracks:
                return tracks, tag
        except Exception as e:
            emit('progress', message='%s 분리기를 쓰지 못했습니다: %s' % (tag, e))
    emit('progress', message='좋은 분리기를 쓰지 못해 기본 분리기로 갑니다')
    tracks = run_music_separation(src, stem_dir)
    return tracks, 'demucs'


def _step_separate(ctx):
    """2. 보컬과 배경음을 갈라낸다."""
    import numpy as np
    import soundfile as sf

    stem_dir = os.path.join(ctx['out_dir'], 'stems')
    os.makedirs(stem_dir, exist_ok=True)
    emit('progress', percent=10, message='보컬과 배경음 갈라내는 중...')
    tracks, engine = _separate_tracks(os.path.join(ctx['out_dir'], 'source.wav'), stem_dir)
    if not tracks:
        raise dp.DubPipelineError('보컬을 갈라내지 못했습니다')

    by_name = dict((t['name'], t['path']) for t in tracks)
    if 'vocals' not in by_name:
        raise dp.DubPipelineError('갈라낸 것 중에 보컬이 없습니다: %s'
                                  % ', '.join(sorted(by_name)))
    shutil.copyfile(by_name['vocals'], os.path.join(ctx['out_dir'], 'vocals.wav'))

    # RoFormer 는 반주를 통째로 준다 — 합칠 것이 없다.
    if 'instrumental' in by_name:
        emit('progress', percent=38, message='배경음 저장 중... (%s)' % engine)
        shutil.copyfile(by_name['instrumental'],
                        os.path.join(ctx['out_dir'], 'background.wav'))
        return

    emit('progress', percent=38, message='배경음 합치는 중...')
    mix, rate = None, None
    for name in BACKGROUND_STEMS:
        path = by_name.get(name)
        if not path or not os.path.isfile(path):
            continue
        data, sr = sf.read(path, dtype='float32', always_2d=True)
        if mix is None:
            mix, rate = data, sr
        elif sr != rate:
            raise dp.DubPipelineError('갈라낸 조각들의 표본율이 다릅니다(%d vs %d)' % (rate, sr))
        else:
            n = min(len(mix), len(data))
            mix = mix[:n] + data[:n]
    if mix is None:
        raise dp.DubPipelineError('배경음으로 쓸 조각이 하나도 없습니다')
    # 합치면 넘칠 수 있다. 넘칠 때만 줄인다 - 아니면 원래 크기를 그대로 둔다.
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 1.0:
        mix = mix / peak
        emit('progress', percent=40, message='배경음이 넘쳐 %.2f배로 줄였습니다' % (1.0 / peak))
    sf.write(os.path.join(ctx['out_dir'], 'background.wav'), mix, rate)


def _step_transcribe(ctx):
    """3. 갈라낸 목소리에 대고 알아듣는다. 배경음이 빠져 있어 더 정확하다."""
    from transcribe_worker import _get_whisper_model, run_transcribe
    emit('progress', percent=45, message='말 알아듣는 중...')
    model = _get_whisper_model(ctx.get('whisper_model') or 'large-v3')
    result = run_transcribe(model, os.path.join(ctx['out_dir'], 'vocals.wav'),
                            ctx.get('language'))

    segments = []
    for s in (result.get('segments') or []):
        text = (s.get('text') or '').strip()
        if not text:
            continue
        segments.append({
            'start': float(s.get('start') or 0.0),
            'end': float(s.get('end') or 0.0),
            'text': text,
            'words': [{'start': float(w.get('start') or 0.0),
                       'end': float(w.get('end') or 0.0),
                       'word': (w.get('word') or '').strip()}
                      for w in (s.get('words') or [])],
        })
    if not segments:
        raise dp.DubPipelineError(
            '말이 하나도 잡히지 않았습니다 - 음악이나 소리만 있는 영상일 수 있습니다')

    # 조각난 구간을 문장 단위로 묶는다.
    # ★왜 여기인가(2026-09-20 실측): 알아듣기가 낸 36개 구간 중 문장부호로 끝나는 것이 **0개**,
    #   글자 수 중앙 11자였다. 그 조각을 하나씩 번역에 넘기면 모델이 **없는 말을 지어내** 끝을 맺는다.
    #   묶은 채로 한 줄로 둔다 - 더빙 줄이 알아듣기의 나눔을 따라야 할 이유가 없고,
    #   묶으면 자리도 넓어져 늘이기가 덜 필요해진다.
    import dub_lines
    merged = dub_lines.merge_segments(segments)
    info = dub_lines.summarize(segments, merged)
    emit('progress', percent=68,
         message='조각 %d줄을 문장 %d줄로 묶었습니다(글자 %d→%d자)'
                 % (info['before'], info['after'],
                    info['before_median_chars'], info['after_median_chars']))

    payload = {'language': result.get('language') or 'unknown',
               'segments': merged, 'raw_segments': segments, 'merge': info}
    with open(os.path.join(ctx['out_dir'], 'transcript.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _step_translate(ctx):
    """4. 한국어로 옮긴다. 줄을 한꺼번에 넘겨 앞뒤 문맥을 살린다."""
    from transcribe_worker import (
        set_translate_model, set_translate_style, translate_segments_to_korean)
    with open(os.path.join(ctx['out_dir'], 'transcript.json'), encoding='utf-8') as f:
        data = json.load(f)
    segments = data['segments']
    lang = data.get('language') or 'unknown'

    # ctx['backend'] 는 dub_pipeline 이 이미 걸러 준 값이다. 여기서 다시 고르지 않는다.
    set_translate_model(ctx['backend'])
    # 더빙은 자막과 요구가 다르다 - 말투를 하나로 묶고, 원문보다 길어지지 않게 한다.
    set_translate_style(mode='dub', register=ctx.get('register'))
    emit('progress', percent=72, message='%s→한국어 번역 중... (%d줄)' % (lang, len(segments)))
    korean = translate_segments_to_korean([s['text'] for s in segments], lang)
    if len(korean) != len(segments):
        raise dp.DubPipelineError('번역 결과의 줄 수가 다릅니다(%d 대 %d)'
                                  % (len(korean), len(segments)))

    lines = []
    for i, (seg, ko) in enumerate(zip(segments, korean)):
        lines.append({'index': i, 'start': seg['start'], 'end': seg['end'],
                      'source': seg['text'], 'korean': (ko or '').strip(),
                      'words': seg['words']})
    empty = [ln['index'] for ln in lines if not ln['korean']]
    # ★임시본 → 확정 → 이름 바꾸기. 쓰다 끊기면 잘린 파일이 남는데,
    #   이 파일 하나에 원문·시각·번역·낱말 시각이 전부 들어 있어 통째로 잃는다.
    #   게다가 잘린 파일도 '번역 끝남' 으로 세어져 되돌릴 길이 막혔다(2026-09-24 2차 감사).
    _final = os.path.join(ctx['out_dir'], 'lines.json')
    _tmp = _final + '.tmp'
    with open(_tmp, 'w', encoding='utf-8') as f:
        json.dump({'language': lang, 'backend': ctx['backend'],
                   'lines': lines, 'empty_indexes': empty}, f,
                  ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(_tmp, _final)
    if empty:
        # 멈추지는 않는다 - 사용자가 그 줄만 손보면 된다. 다만 조용히 넘기지도 않는다.
        emit('progress', percent=88,
             message='번역이 비어 있는 줄이 %d개 있습니다 - 목록에서 손보시면 됩니다' % len(empty))


def real_steps():
    """실제 일을 하는 단계 함수들. 검사는 이 대신 가짜를 끼운다."""
    return {'audio': _step_audio, 'separate': _step_separate,
            'transcribe': _step_transcribe, 'translate': _step_translate}


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description='더빙 앞단 실행기')
    ap.add_argument('--video', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--translate', default=dp.DEFAULT_TRANSLATE_BACKEND)
    ap.add_argument('--whisper-model', default='large-v3')
    ap.add_argument('--language', default=None, help='없으면 자동 감지')
    ap.add_argument('--register', default='', choices=['', 'casual', 'polite'],
                    help='번역 말투 - 반말(casual) / 존댓말(polite) / 지정 안 함')
    ap.add_argument('--force', action='store_true', help='처음부터 다시 한다')
    args = ap.parse_args(argv)

    def say(kind, **kw):
        if kind == 'skip':
            emit('progress', message='%s: 지난 결과를 씁니다' % kw.get('label'))
        elif kind == 'start':
            emit('progress', message='%s 시작' % kw.get('label'))
        elif kind == 'reset':
            emit('progress', message='처음부터 다시 합니다 - %s' % kw.get('reason'))

    try:
        result = dp.run_front(args.video, args.out, steps=real_steps(),
                              translate_backend=args.translate,
                              force=args.force, on_event=say,
                              extra={'whisper_model': args.whisper_model,
                                     'language': args.language,
                                     'register': args.register})
    except dp.DubPipelineError as e:
        emit('error', message=str(e))
        return 1
    emit('complete', out_dir=result['out_dir'],
         skipped=result['skipped'], ran=result['ran'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
