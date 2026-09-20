# -*- coding: utf-8 -*-
"""더빙 줄 소리 만들기 — 앞단이 낸 줄마다 한국어 소리를 만든다.

화면이 하는 일과 **같은 경로**를 명령줄에서도 돌릴 수 있게 한 것이다.
그래야 화면 없이 처음부터 끝까지 한 번 돌려 볼 수 있다.

  python -X utf8 python/dub_speak.py --work <작업폴더> [--voice <목소리>] [--limit N]

--voice 를 주지 않으면 **영상 속 목소리**(갈라낸 보컬)에서 깨끗한 구간을 떠서 쓴다 —
인물은 그대로 두고 언어만 바꾸는 길이다.

만든 소리는 <작업폴더>/takes/line-NNNN.wav 에 쌓이고 takes.json 이 함께 쓰인다.
그 파일을 dub_render.py 에 그대로 넘기면 영상이 나온다.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audio_fit

HERE = os.path.dirname(os.path.abspath(__file__))
SEPARATE = os.path.join(HERE, 'separate.py')

# 참조로 쓸 구간의 길이. 너무 짧으면 목소리를 못 잡고, 너무 길면 섞인다.
REF_SEC = 8.0


class DubSpeakError(RuntimeError):
    pass


def pick_reference_span(lines):
    """참조로 쓸 구간을 고른다 — **가장 긴 대사 구간**.

    왜 가장 긴 구간인가: 참조는 한 사람의 목소리가 끊기지 않고 이어지는 토막이 좋다.
    대사 구간은 전사가 '여기서 말했다' 고 표시한 자리이므로 무음·반주만 있는 곳을 피할 수 있다.
    너무 길면 여러 소리가 섞이므로 REF_SEC 에서 자른다.
    """
    usable = [x for x in (lines or [])
              if float(x.get('end', 0)) - float(x.get('start', 0)) > 0]
    if not usable:
        raise DubSpeakError('참조로 쓸 대사 구간이 없습니다')
    best = max(usable, key=lambda x: float(x['end']) - float(x['start']))
    start = float(best['start'])
    dur = min(REF_SEC, max(2.0, float(best['end']) - start))
    return start, dur


def build_reference_from_vocals(work_dir, lines):
    """갈라낸 보컬에서 고른 구간을 떠서 참조 파일로 만든다."""
    vocals = os.path.join(work_dir, 'vocals.wav')
    if not os.path.isfile(vocals):
        raise DubSpeakError('갈라낸 목소리가 없습니다: vocals.wav')
    start, dur = pick_reference_span(lines)
    dest = os.path.join(work_dir, 'voice-ref.wav')
    audio_fit._run_ffmpeg(['-ss', '%.3f' % start, '-t', '%.3f' % dur,
                           '-i', vocals, '-ac', '1', dest])
    return dest, start, dur


def _config_for(voice_path, ref_clip, text, out_dir):
    """줄 하나를 만드는 설정. 화면이 보내는 것과 같은 값이다."""
    return {
        'mode': 'tts',
        'input': voice_path,
        'output': out_dir,
        'ttsText': text,
        'ttsSpeed': 1.0,
        'ttsSilenceGap': 0.5,
        'ttsPitch': 0.0,
        'ttsEngine': 'auto',
        'ttsSpeakerMode': 'single',
        'ttsReferenceOverride': ref_clip,
        'ttsTailMode': 'auto',
        'ttsTailPaddingMs': 120,
        'ttsTailFadeMs': 8,
    }


def _newest_new_wav(out_dir, before):
    """이번에 새로 생긴 소리 파일. 없으면 조용히 넘기지 않고 사유와 함께 멈춘다."""
    made = [f for f in os.listdir(out_dir)
            if f.lower().endswith('.wav') and f not in before]
    if not made:
        raise DubSpeakError('합성은 끝났는데 소리 파일이 없습니다')
    made.sort(key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    return os.path.join(out_dir, made[-1])


def _write_config(cfg):
    fd, cfg_path = tempfile.mkstemp(suffix='.json', prefix='af-dubspeak-')
    os.close(fd)
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)
    return cfg_path


class InProcessSpeaker(object):
    """한 프로세스 안에서 여러 줄을 만든다 — **합성 모델을 한 번만 읽는다.**

    왜 이렇게 하는가(2026-09-20 실측): 줄마다 프로세스를 새로 띄우면 줄 하나에 43초가 걸리는데
    그중 대부분이 모델 읽기다. 36줄이면 25분이 넘는다. 더빙은 줄이 수십~수백 개다.
    tts_worker 의 엔진 캐시(`_engine_cache`)는 **프로세스 안에서** 모델을 기억하므로,
    같은 프로세스에서 이어 부르면 두 번째 줄부터 읽기가 사라진다.

    ★separate.py 는 한 줄도 고치지 않는다. 모든 합성이 지나는 길이라 건드리지 않는 것이 맞다.
      다만 그쪽 모듈 전역(_RUN)이 '한 번 끝내면 잠기는' 구조라 매번 처음 상태로 되돌려 준다.
      되돌릴 값을 여기에 적어 두지 않고 **아무것도 돌기 전의 값을 떠서** 쓴다 —
      그래야 나중에 _RUN 에 항목이 늘어도 이 코드가 조용히 어긋나지 않는다.
    """

    def __init__(self):
        import copy
        import separate
        self._sep = separate
        self._copy = copy
        self._pristine = copy.deepcopy(separate._RUN)

    def speak(self, cfg, out_dir, log_path):
        os.makedirs(out_dir, exist_ok=True)
        before = set(os.listdir(out_dir))
        cfg_path = _write_config(cfg)
        argv = sys.argv
        self._sep._RUN.clear()
        self._sep._RUN.update(self._copy.deepcopy(self._pristine))
        try:
            sys.argv = ['separate.py', '--config', cfg_path]
            with open(log_path, 'a', encoding='utf-8') as log:
                old_out, sys.stdout = sys.stdout, log
                try:
                    self._sep.main()
                except SystemExit as e:
                    # 실패를 성공으로 바꾸지 않는다. 사유는 기록에 남아 있다.
                    if e.code not in (0, None):
                        raise DubSpeakError('합성이 코드 %s 로 끝났습니다(기록: %s)'
                                            % (e.code, os.path.basename(log_path)))
                finally:
                    sys.stdout = old_out
        finally:
            sys.argv = argv
            try:
                os.remove(cfg_path)
            except OSError:
                pass
        return _newest_new_wav(out_dir, before)


def speak_line(voice_path, ref_clip, text, out_dir, python_exe=None):
    """줄 하나를 **별도 프로세스**로 만든다. 느리지만 가장 안전한 길이다."""
    cfg = _config_for(voice_path, ref_clip, text, out_dir)
    cfg_path = _write_config(cfg)
    before = set(os.listdir(out_dir)) if os.path.isdir(out_dir) else set()
    try:
        r = subprocess.run([python_exe or sys.executable, '-X', 'utf8', SEPARATE,
                            '--config', cfg_path], capture_output=True)
        if r.returncode != 0:
            tail = (r.stderr or b'').decode('utf-8', 'replace').strip()[-400:]
            raise DubSpeakError('합성 실패(%d): %s' % (r.returncode, tail))
    finally:
        try:
            os.remove(cfg_path)
        except OSError:
            pass
    made = [f for f in os.listdir(out_dir)
            if f.lower().endswith('.wav') and f not in before]
    if not made:
        raise DubSpeakError('합성은 끝났는데 소리 파일이 없습니다')
    made.sort(key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    return os.path.join(out_dir, made[-1])


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description='더빙 줄 소리 만들기')
    ap.add_argument('--work', required=True)
    ap.add_argument('--voice', default='', help='없으면 영상 속 목소리를 쓴다')
    ap.add_argument('--limit', type=int, default=0, help='앞의 N줄만(시험용)')
    ap.add_argument('--python', default='', help='줄마다 프로세스를 띄울 때 쓸 파이썬')
    ap.add_argument('--per-process', action='store_true',
                    help='줄마다 프로세스를 새로 띄운다(느리다). 한 프로세스 방식이 막힐 때만.')
    args = ap.parse_args(argv)

    with open(os.path.join(args.work, 'lines.json'), encoding='utf-8') as f:
        lines = json.load(f)['lines']
    todo = [x for x in lines if (x.get('korean') or '').strip()]
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        raise DubSpeakError('만들 줄이 없습니다 — 번역이 비어 있습니다')

    if args.voice:
        voice_path, ref_clip = args.voice, args.voice
        print('목소리: 고른 파일')
    else:
        ref_clip, s, d = build_reference_from_vocals(args.work, lines)
        voice_path = ref_clip
        print('목소리: 영상 속 목소리 — %.1f초 자리에서 %.1f초를 떴다' % (s, d))

    takes_dir = os.path.join(args.work, 'takes')
    os.makedirs(takes_dir, exist_ok=True)
    scratch = os.path.join(args.work, 'speak-tmp')
    os.makedirs(scratch, exist_ok=True)

    speaker = None
    log_path = os.path.join(args.work, 'speak-log.txt')
    if not args.per_process:
        speaker = InProcessSpeaker()
        print('합성 모델을 한 번만 읽는다(자세한 기록: speak-log.txt)')
    else:
        print('줄마다 프로세스를 새로 띄운다 — 모델을 매번 읽으므로 느리다')

    takes = {}
    started = time.time()
    for i, ln in enumerate(todo):
        idx = int(ln['index'])
        text = ln['korean'].strip()
        at = time.time()
        if speaker is not None:
            made = speaker.speak(_config_for(voice_path, ref_clip, text, scratch),
                                 scratch, log_path)
        else:
            made = speak_line(voice_path, ref_clip, text, scratch, args.python or None)
        dest = os.path.join(takes_dir, 'line-%04d.wav' % idx)
        shutil.move(made, dest)
        takes[str(idx)] = dest
        print('  %d/%d  %d번째 줄 · %d자 · 소리 %.1f초 · 만드는 데 %.0f초'
              % (i + 1, len(todo), idx + 1, len(text),
                 audio_fit.probe_duration(dest), time.time() - at),
              flush=True)

    takes_path = os.path.join(args.work, 'takes.json')
    with open(takes_path, 'w', encoding='utf-8') as f:
        json.dump(takes, f, ensure_ascii=False, indent=2)
    shutil.rmtree(scratch, ignore_errors=True)
    print('%d줄 · %.0f초 걸렸다' % (len(takes), time.time() - started))
    print('짝 파일: %s' % takes_path)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (DubSpeakError, audio_fit.AudioFitError) as e:
        print('멈춤: %s' % e, file=sys.stderr)
        sys.exit(1)
