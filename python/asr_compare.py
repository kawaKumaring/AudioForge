# -*- coding: utf-8 -*-
"""알아듣기 설정 비교 — 정답지 없이 견주는 방법.

사용자 질문(2026-09-21): 영상/음성의 언어 인식율을 올릴 방법.

정답지(사람이 받아쓴 원고)가 없으면 '맞았다' 를 직접 잴 수 없다. 대신 둘을 쓴다.

  1. **모델 자신의 확신도** — 위스퍼가 구간마다 남기는 avg_logprob / no_speech_prob.
     0 에 가까울수록 확신한다. 설정끼리 견주는 대리 지표로 쓸 수 있다.
  2. **설정끼리의 일치도** — 서로 다른 설정이 같은 말을 내놓으면 맞을 가능성이 높다.
     갈라지는 자리가 의심 구간이다.

★둘 다 '정확도' 자체가 아니다. **견주기 위한 대리 지표**다. 이 점을 숫자와 함께 늘 적는다.

실행:
  <앱파이썬> -X utf8 python/asr_compare.py --audio <소리파일> [--language ja]
"""
import argparse
import difflib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def run(audio, language, **opts):
    """한 설정으로 전사한다. 기존 경로를 쓰되 해독 설정만 덮어쓴다."""
    from transcribe_worker import _get_whisper_model, _norm_lang, _filter_silent_segments
    model = _get_whisper_model(opts.pop('model_name', 'large-v3'))
    kw = dict(language=_norm_lang(language), task='transcribe', verbose=False,
              condition_on_previous_text=False, word_timestamps=True,
              hallucination_silence_threshold=2.0)
    kw.update(opts)
    result = model.transcribe(audio, **kw)
    return _filter_silent_segments(result, audio)


def stats(result):
    segs = [s for s in (result.get('segments') or []) if (s.get('text') or '').strip()]
    if not segs:
        return {'segments': 0}
    lp = [float(s.get('avg_logprob', 0.0)) for s in segs]
    ns = [float(s.get('no_speech_prob', 0.0)) for s in segs]
    text = ''.join((s.get('text') or '').strip() for s in segs)
    return {
        'segments': len(segs),
        'chars': len(text),
        'confidence': sum(lp) / len(lp),          # 0 에 가까울수록 확신
        'silence_doubt': sum(ns) / len(ns),       # 낮을수록 '말이 있다' 고 본다
        'low_confidence_ratio': 100.0 * sum(1 for x in lp if x < -0.6) / len(lp),
        'text': text,
    }


def agreement(a, b):
    """두 결과가 얼마나 같은 말을 했는가(0~100)."""
    if not a or not b:
        return 0.0
    return 100.0 * difflib.SequenceMatcher(None, a, b).ratio()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True, nargs='+',
                    help='견줄 소리 파일들(예: 보컬 전체 / 주 보컬)')
    ap.add_argument('--labels', nargs='*', default=None)
    ap.add_argument('--language', default=None)
    ap.add_argument('--reference', default='', help='가사 파일(있으면 진짜 정확도를 잰다)')
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    ref_text = None
    if args.reference:
        import dub_eval
        ref_text = ''.join(t[0] for t in dub_eval.parse_lyrics(
            io.open(args.reference, encoding='utf-8').read()))
        print('정답지 %d자 — 대리 지표가 아니라 **실제 정확도**를 잰다' % len(ref_text))

    labels = args.labels or [os.path.basename(a) for a in args.audio]
    settings = [
        ('large-v3 (지금)', {}),
        ('large-v3-turbo', {'model_name': 'large-v3-turbo'}),
        ('large-v2', {'model_name': 'large-v2'}),
        ('medium', {'model_name': 'medium'}),
        ('v3 + 앞문맥·알려줌', {'condition_on_previous_text': True,
                                'initial_prompt': '日本語の歌詞です。'}),
        ('turbo + 앞문맥·알려줌', {'model_name': 'large-v3-turbo',
                                   'condition_on_previous_text': True,
                                   'initial_prompt': '日本語の歌詞です。'}),
    ]

    rows = []
    for audio, label in zip(args.audio, labels):
        for sname, opts in settings:
            print('돌리는 중: %s · %s' % (label, sname), flush=True)
            st = stats(run(audio, args.language, **dict(opts)))
            st['audio'] = label
            st['setting'] = sname
            if ref_text:
                import dub_eval
                st['score'] = dub_eval.cer(ref_text, st.get('text') or '')
            rows.append(st)
            line = ('   구간 %d · 글자 %d · 확신도 %.3f · 확신낮은줄 %.0f%%'
                    % (st['segments'], st['chars'], st['confidence'],
                       st['low_confidence_ratio']))
            if 'score' in st:
                line += '  ★정확도 %.1f%%' % st['score']['accuracy']
            print(line, flush=True)

    print()
    print('설정끼리 얼마나 같은 말을 했는가')
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            print('   %-22s ↔ %-22s  %.1f%%'
                  % ('%s/%s' % (rows[i]['audio'][:8], rows[i]['setting']),
                     '%s/%s' % (rows[j]['audio'][:8], rows[j]['setting']),
                     agreement(rows[i].get('text'), rows[j].get('text'))))
    print()
    print('★확신도와 일치도는 정확도 자체가 아니라 **견주기 위한 대리 지표**다.')

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        print('자세한 것: %s' % args.out)


if __name__ == '__main__':
    main()
