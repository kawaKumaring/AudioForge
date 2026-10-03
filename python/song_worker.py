# -*- coding: utf-8 -*-
"""노래 변환 — 화면이 부를 수 있는 **한 줄 진입점**.

★사슬을 다시 만들지 않는다. `song_chain` 이 이미 하는 일을 그대로 부른다.
  이 파일이 더하는 것은 셋뿐이다:
    · 명령줄 인자를 받는 것
    · 단계 글월을 **진행률 JSON** 으로 옮기는 것(`audio_utils.emit`, 더빙과 같은 규약)
    · 참조 토막을 준비하고 **어디를 썼는지** 결과에 담는 것

★원본을 건드리지 않는다. 원곡도 목소리도 **읽기만** 한다.
  참조 토막은 작업 폴더 안에 새로 만든다.

★준비에 실패하면 **거기서 멈춘다.** 다른 목소리로 슬쩍 바꾸지 않는다(2026-09-27 지시 2).

사용:
  python song_worker.py --source <원곡> --voice <목소리> --work <작업폴더>
                        --request-id <식별자> [--split-lead]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio_utils import emit          # noqa: E402
import song_chain                     # noqa: E402
import song_reference                 # noqa: E402
import song_voice                     # noqa: E402

# 단계 글월 → 진행률. 실제로 걸리는 시간에 맞춰 나눴다(2026-09-26 실측:
# 꺼내기 0.3초 · 반주/보컬 28초 · 주보컬/화음 13초 · 변환 102초 · 합치기 0.5초).
STAGE_PERCENT = (
    ('소리 꺼내는 중', 4),
    ('반주와 보컬 가르는 중', 10),
    ('주 보컬과 화음 가르는 중', 30),
    ('주 보컬 가르기를 건너뛴다', 30),
    ('음역이', 36),
    ('목소리 바꾸는 중', 40),
    ('합치는 중', 92),
    ('끝남', 98),
)

# 영상으로 보는 확장자. 이 목록 밖은 소리 파일로 보고 그대로 쓴다.
VIDEO_EXT = ('.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.ts', '.mpg', '.mpeg')


def is_video(path):
    return os.path.splitext(str(path or ''))[1].lower() in VIDEO_EXT


def percent_for(message):
    """이 단계 글월이 뜻하는 진행률. 모르는 글월이면 None(진행률을 건드리지 않는다)."""
    for head, pct in STAGE_PERCENT:
        if message.startswith(head):
            return pct
    return None


def prepare_reference(voice_path, work_dir, req_id, say):
    """참조 토막을 만든다. **원본은 읽기만** 한다.

    ★긴 파일도 그대로 받는다(2026-09-27 지시 2). 자르는 것은 우리 몫이다 —
      변환기의 처리 창이 `30초 - 참조 길이` 라, 긴 참조를 그대로 주면 곡이 토막 난다.
    ★어디를 썼는지 돌려준다. 결과 기록에 남기기 위해서다.
    """
    say('목소리에서 참조 토막 고르는 중')
    src = voice_path
    if is_video(voice_path):
        # 영상이면 소리부터 꺼낸다. 꺼낸 것은 작업 폴더 안에만 둔다.
        src = song_chain.extract_audio(
            voice_path, os.path.join(work_dir, 'voice_source.wav'))
    dest = os.path.join(work_dir, '참조_%s.wav' % req_id[:8])
    cut = song_reference.cut(src, dest, seconds=song_reference.WINDOW_SEC)
    whole = float(cut.get('source_sec') or 0) <= song_reference.WINDOW_SEC
    return {
        'clipPath': cut['path'],
        'fromPath': voice_path,          # ★사용자가 고른 **원본** 경로를 남긴다
        'startSec': float(cut.get('start_sec') or 0.0),
        'durationSec': float(cut.get('seconds') or 0.0),
        'sourceSec': float(cut.get('source_sec') or 0.0),
        'wholeFile': bool(whole),
        'extractedFrom': src if src != voice_path else '',
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--voice', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--request-id', required=True)
    ap.add_argument('--split-lead', action='store_true')
    a = ap.parse_args()

    req = a.request_id

    def say(message):
        pct = percent_for(message)
        if pct is None:
            emit('progress', message=message, clientRequestId=req)
        else:
            emit('progress', percent=pct, message=message, clientRequestId=req)

    try:
        for what, p in (('원곡', a.source), ('목소리', a.voice)):
            if not p or not os.path.isfile(p):
                raise song_chain.SongChainError(
                    '%s 파일을 찾지 못했습니다: %s' % (what, os.path.basename(p or '')))
        os.makedirs(a.work, exist_ok=True)

        emit('progress', percent=1, message='준비 중', clientRequestId=req)
        ref = prepare_reference(a.voice, a.work, req, say)

        made = song_chain.convert_song(
            a.source, ref['clipPath'], a.work,
            voice_name=os.path.splitext(os.path.basename(a.voice))[0][:30] or '목소리',
            ref_sec=ref['durationSec'], log=say, split_lead=a.split_lead)

        note = {}
        note_path = os.path.join(a.work, '쓴목소리.json')
        if os.path.isfile(note_path):
            try:
                with open(note_path, encoding='utf-8') as f:
                    note = json.load(f)
            except Exception:
                note = {}

        # ★결과 화면이 원곡과 변환본을 견주어 들으려면 **디코딩 가능한 원곡 소리**가 필요하다.
        #   영상이면 사슬이 꺼내 둔 `source.wav` 가 그것이고, 음원이면 같은 자리에 복사돼 있다.
        source_audio = os.path.join(a.work, 'source.wav')
        result = {
            'clientRequestId': req,
            'mixPath': made.get('화음없이', ''),
            'sourceAudioPath': source_audio if os.path.isfile(source_audio) else a.source,
            'vocalPath': made.get('주보컬만', ''),
            'workDir': a.work,
            'reference': ref,
            'settings': {
                'splitLead': bool(a.split_lead),
                'diffusionSteps': song_voice.DIFFUSION_STEPS,
                'refMaxSec': song_chain.REF_MAX_SEC,
                # 사슬이 남긴 음높이·옥타브 기록을 그대로 싣는다.
                'chainNote': note,
            },
        }
        if made.get('원래화음같이'):
            result['withHarmonyPath'] = made['원래화음같이']
        if not result['mixPath'] or not os.path.isfile(result['mixPath']):
            raise song_chain.SongChainError('결과 음원을 찾지 못했습니다.')

        emit('progress', percent=100, message='끝남', clientRequestId=req)
        emit('result', clientRequestId=req, song=result)
        return 0
    except song_voice.SongVoiceError as e:
        emit('error', message=str(e), code='SONG_CONVERT_FAILED', clientRequestId=req)
        return 1
    except song_reference.SongReferenceError as e:
        emit('error', message=str(e), code='SONG_REFERENCE_FAILED', clientRequestId=req)
        return 1
    except song_chain.SongChainError as e:
        emit('error', message=str(e), code='SONG_CHAIN_FAILED', clientRequestId=req)
        return 1
    except Exception as e:                       # noqa: BLE001 - 사유를 잃지 않는다
        emit('error', message='%s: %s' % (type(e).__name__, e),
             code='SONG_FAILED', clientRequestId=req)
        return 1


if __name__ == '__main__':
    sys.exit(main())
