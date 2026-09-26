# -*- coding: utf-8 -*-
"""더빙 내보내기 - 줄별 소리를 받아 자리를 정하고, 배경음에 얹어, 영상으로 낸다.

앞단(dub_worker)이 끝나고 줄마다 한국어 소리를 만든 뒤에 부른다.

  줄 길이 재기 → 자리 계산(dub_timing) → 줄마다 손보기(dub_assemble)
  → 목소리 트랙 만들기 → 배경음 덕킹(audio_fit) → 영상에 붙이기 → 자막

실행:
  python -X utf8 python/dub_render.py --work <작업폴더> --takes <takes.json>
                                      --video <원본영상> --dest <결과영상>

takes.json - {"0": "줄0.wav", "1": "줄1.wav", ...} 줄 번호와 만든 소리의 짝.
★원본 영상은 건드리지 않는다. 결과는 언제나 새 파일이다.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audio_fit
import dub_assemble as da
import dub_timing as dt
from audio_utils import emit


class DubRenderError(RuntimeError):
    """내보내기 중 실패. 사유를 문구로 담는다."""


def collect_lines(lines, takes, *, probe=audio_fit.probe_duration):
    """줄 목록과 만든 소리를 짝지어 자리 계산에 넣을 형태로 만든다.

    소리가 없는 줄은 **빼지 않고 따로 알린다** - 조용히 사라지면 결과에서 그 대사만
    없어지고 아무도 이유를 모른다.

    돌려주는 것: (자리 계산에 넣을 목록, 짝지은 줄 정보, 소리가 없는 줄 번호들)
    """
    ready, missing = [], []
    for ln in lines:
        idx = int(ln['index'])
        path = takes.get(str(idx), takes.get(idx))
        if not path or not os.path.isfile(path):
            missing.append(idx)
            continue
        try:
            spoken = float(probe(path))
        except Exception as e:
            raise DubRenderError('%d번째 줄의 소리를 읽지 못했습니다: %s' % (idx + 1, e))
        ready.append({'index': idx, 'start': float(ln['start']), 'end': float(ln['end']),
                      'spoken_sec': spoken, 'path': path,
                      'korean': ln.get('korean') or ''})
    ready.sort(key=lambda r: r['start'])
    timing_input = [{'start': r['start'], 'end': r['end'], 'spoken_sec': r['spoken_sec']}
                    for r in ready]
    return timing_input, ready, missing


def render(work_dir, takes, video_path, dest, *, max_ratio=dt.MAX_RATIO,
           match_loudness=True, ffmpeg=None, on_progress=None):
    """앞단 결과 + 줄별 소리 → 더빙된 영상 한 편."""
    say = on_progress or (lambda pct, msg: None)

    background = os.path.join(work_dir, 'background.wav')
    vocals = os.path.join(work_dir, 'vocals.wav')
    lines_json = os.path.join(work_dir, 'lines.json')
    for p in (background, vocals, lines_json):
        if not os.path.isfile(p):
            raise DubRenderError('앞단 결과가 없습니다: %s - 먼저 앞단을 끝내세요'
                                 % os.path.basename(p))
    with open(lines_json, encoding='utf-8') as f:
        lines = json.load(f)['lines']

    say(5, '줄 길이 재는 중...')
    timing_input, ready, missing = collect_lines(lines, takes)
    if not ready:
        raise DubRenderError('놓을 소리가 하나도 없습니다 - 줄마다 소리를 먼저 만드세요')

    media_sec = audio_fit.probe_duration(background)
    plans = dt.plan_lines(timing_input, media_sec=media_sec, max_ratio=max_ratio)

    say(15, '줄마다 자리에 맞추는 중...')
    fit_dir = os.path.join(work_dir, 'fitted')
    os.makedirs(fit_dir, exist_ok=True)
    clips, report = [], []
    for row, plan in zip(ready, plans):
        target = None
        if match_loudness:
            target = da.segment_loudness(vocals, row['start'], row['end'], fit_dir)
        out = os.path.join(fit_dir, 'line-%04d.wav' % row['index'])
        done = da.fit_one_line(row['path'], out, plan,
                               target_lufs=target, work_dir=fit_dir, ffmpeg=ffmpeg)
        clips.append({'path': out, 'start_sec': plan['place_start']})
        report.append({
            'index': row['index'], 'status': plan['status'],
            'ratio': round(plan['ratio'], 4),
            'overflow_sec': round(plan['overflow_sec'], 3),
            'place_start': round(plan['place_start'], 3),
            'borrowed_before_sec': round(plan['borrowed_before_sec'], 3),
            'borrowed_after_sec': round(plan['borrowed_after_sec'], 3),
            'pushed_sec': round(plan['pushed_sec'], 3),
            'reason': plan['reason'],
            'loudness_matched': done['loudness_matched'],
            'loudness_note': done['loudness_note'],
            'korean': row['korean'],
        })

    say(55, '목소리 트랙 만드는 중...')
    voice = os.path.join(work_dir, 'voice.wav')
    track = da.place_clips(clips, voice, media_sec)

    say(70, '배경음 위에 얹는 중...')
    mixed = os.path.join(work_dir, 'mixed.wav')
    audio_fit.duck(background, voice, mixed, ffmpeg=ffmpeg)

    say(85, '영상에 붙이는 중...')
    da.mux_video(video_path, mixed, dest, ffmpeg=ffmpeg)

    say(95, '자막 쓰는 중...')
    srt = da.write_srt(
        [{'start_sec': r['place_start'],
          'end_sec': r['place_start'] + p['place_sec'],
          'korean': r['korean']}
         for r, p in zip(report, plans)],
        os.path.splitext(dest)[0] + '.ko.srt')

    summary = dt.summarize(plans)
    summary['missing_indexes'] = missing
    summary['trimmed'] = track['trimmed']
    return {'video': dest, 'audio': mixed, 'voice': voice, 'srt': srt['path'],
            'summary': summary, 'lines': report}


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description='더빙 내보내기')
    ap.add_argument('--work', required=True, help='앞단 결과 폴더')
    ap.add_argument('--takes', required=True, help='줄 번호와 소리 파일의 짝(JSON 파일)')
    ap.add_argument('--video', required=True)
    ap.add_argument('--dest', required=True)
    ap.add_argument('--max-ratio', type=float, default=dt.MAX_RATIO)
    ap.add_argument('--no-loudness', action='store_true', help='구간 음량 맞추기를 끈다')
    args = ap.parse_args(argv)

    try:
        with open(args.takes, encoding='utf-8') as f:
            takes = json.load(f)
        if not isinstance(takes, dict):
            raise DubRenderError('takes 파일은 {줄번호: 소리파일} 형태여야 합니다')
        result = render(args.work, takes, args.video, args.dest,
                        max_ratio=args.max_ratio,
                        match_loudness=not args.no_loudness,
                        on_progress=lambda pct, msg: emit('progress', percent=pct,
                                                          message=msg))
    except (DubRenderError, da.DubAssembleError, dt.DubTimingError,
            audio_fit.AudioFitError) as e:
        emit('error', message=str(e))
        return 1
    except Exception as e:                                   # 예상 못 한 것도 삼키지 않는다
        emit('error', message='내보내기 중 예상 못 한 오류: %s' % e)
        return 1

    s = result['summary']
    report_path = os.path.join(args.work, 'render-report.json')
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    emit('complete', video=result['video'], srt=result['srt'],
         report=report_path, total=s['total'], fit=s['fit'],
         stretched=s['stretched'], over=s['over'],
         missing=len(s['missing_indexes']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
