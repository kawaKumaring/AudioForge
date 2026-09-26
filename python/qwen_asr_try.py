# -*- coding: utf-8 -*-
"""Qwen3-ASR 로 전사해 보고 **정답지로 채점한다.**

왜(2026-09-21): 위스퍼 설정을 아무리 바꿔도 71.7~75.3% 안에서 움직이지 않았다.
설정이 아니라 모델이 한계였다. 2026 일본어 벤치마크에서 Qwen3-ASR-1.7B 가
글자 오류율 0.140 으로 1위였다(whisper-large-v3-turbo 0.184).

★파이썬 경로 손질이 필요하다
  ComfyUI 의 XTTS 노드가 `XTTS.pth` 로 자기 폴더를 **이 파이썬을 쓰는 모든 프로세스**의
  경로에 얹어 둔다. 그 폴더에 `model.py` 가 있어서, 어떤 꾸러미가 `import model` 하면
  엉뚱한 것이 잡힌다(nagisa 가 실제로 그렇게 한다).
  남의 설정을 지우지 않는다 — **이 실행에서만** 걷어낸다.

★2026-09-21 결론: **쓰지 않는다.** 노래 주 보컬로 재니 55.9% 로,
  지금 쓰는 whisper large-v3(73.1%)보다 한참 나빴다. 대화 벤치마크 1위였지만
  그 순위가 노래로 옮겨오지 않았다. 가중치는 격리 폴더로 옮겨 두었다
  (AudioForge\externals\_격리_사용안함_ASR모델). 다시 재려면 되돌려 놓아야 한다.
  자세한 것: doc/work-in-progress/asr-model-trials.md

이 파일은 **어떻게 쟀는지를 남기려고** 지운다. 기본 경로에서는 부르지 않는다.

실행:
  <앱파이썬> -X utf8 python/qwen_asr_try.py --audio <소리> --language ja [--reference <가사>]
"""
import argparse
import io
import os
import sys


def clean_path():
    """엉뚱한 모듈이 잡히는 경로를 이 실행에서만 걷어낸다."""
    removed = []
    for p in list(sys.path):
        low = p.replace('\\', '/').lower()
        if 'custom_nodes' in low:
            sys.path.remove(p)
            removed.append(p)
    # 이미 잘못 잡힌 것이 있으면 놓아 준다.
    for name in ('model', 'trainer', 'TTS'):
        sys.modules.pop(name, None)
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--language', default=None)
    ap.add_argument('--reference', default='')
    ap.add_argument('--model', default='Qwen/Qwen3-ASR-1.7B')
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    removed = clean_path()
    if removed:
        print('경로에서 걷어낸 자리 %d개(이 실행에서만)' % len(removed), flush=True)

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    print('모델 준비 중... (처음이면 내려받는다)', flush=True)
    from qwen_asr import Qwen3ASRModel
    model = Qwen3ASRModel.from_pretrained(args.model)

    # 이 모델은 'ja' 같은 줄임말이 아니라 **온전한 이름**을 받는다.
    LANG_NAME = {'ja': 'Japanese', 'ko': 'Korean', 'en': 'English', 'zh': 'Chinese',
                 'fr': 'French', 'de': 'German', 'es': 'Spanish', 'ru': 'Russian'}
    lang = args.language
    if lang:
        lang = LANG_NAME.get(lang.lower(), lang)
        if lang != args.language:
            print('언어 이름을 %s 로 바꿔 넘긴다' % lang, flush=True)

    print('전사 중...', flush=True)
    import time
    t0 = time.time()
    result = model.transcribe(args.audio, language=lang)
    took = time.time() - t0

    text = result if isinstance(result, str) else (
        result.get('text') if isinstance(result, dict) else str(result))
    print('끝났다 — %d자 · %.0f초' % (len(text or ''), took))

    if args.reference:
        import dub_eval
        ref = ''.join(t[0] for t in dub_eval.parse_lyrics(
            io.open(args.reference, encoding='utf-8').read()))
        score = dub_eval.cer(ref, text)
        print('★정확도 %.1f%% (정답 %d자 / 우리 %d자 · 바뀜 %d · 빠짐 %d · 더해짐 %d)'
              % (score['accuracy'], score['ref_chars'], score['hyp_chars'],
                 score['substitutions'], score['deletions'], score['insertions']))

    if args.out:
        with io.open(args.out, 'w', encoding='utf-8') as f:
            f.write(text or '')
        print('옮긴 글: %s' % args.out)


if __name__ == '__main__':
    main()
