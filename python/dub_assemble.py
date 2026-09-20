# -*- coding: utf-8 -*-
"""더빙 뒷단 - 줄별 소리를 자리에 놓고, 배경음 위에 얹고, 영상에 되붙인다.

앞의 두 파일과 역할이 겹치지 않는다.
  dub_timing.py   - **어디에 얼마나** 놓을지 정한다(숫자만).
  audio_fit.py    - 늘이기·음량 맞추기·덕킹 **부품**.
  이 파일         - 그 둘을 써서 실제 트랙과 영상 파일을 만든다.

원본 영상은 건드리지 않는다. 결과는 언제나 새 파일이다.

기획: doc/work-in-progress/video-dubbing.md
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audio_fit
from audio_fit import AudioFitError


class DubAssembleError(RuntimeError):
    """조립 중 실패. 사유를 문구로 담는다."""


def place_clips(clips, dest, total_sec):
    """줄별 소리를 각자의 시각에 놓아 **목소리 트랙 하나**를 만든다.

    clips - [{'path': 소리파일, 'start_sec': 놓을 시각}, ...]
    total_sec - 만들 트랙의 길이(보통 영상 길이).

    겹치는 자리는 더해진다 - 자리 맞추기가 겹치지 않게 주는 것이 전제다.
    소리들의 표본율이 다르면 **조용히 섞지 않고** 사유와 함께 실패한다.
    """
    try:
        import numpy as np
        import soundfile as sf
    except Exception as e:
        raise DubAssembleError('트랙을 만드는 데 필요한 것이 없습니다: %s' % e)
    if total_sec <= 0:
        raise DubAssembleError('트랙 길이는 0보다 커야 합니다: %r' % (total_sec,))

    rate, channels = None, 1
    loaded = []
    for c in clips:
        path = c['path']
        if not os.path.isfile(path):
            raise DubAssembleError('줄 소리 파일이 없습니다: %s' % os.path.basename(path))
        data, sr = sf.read(path, dtype='float32', always_2d=True)
        if rate is None:
            rate, channels = sr, data.shape[1]
        elif sr != rate:
            raise DubAssembleError(
                '줄마다 표본율이 다릅니다(%d 대 %d) - %s'
                % (rate, sr, os.path.basename(path)))
        elif data.shape[1] != channels:
            channels = max(channels, data.shape[1])
        loaded.append((float(c.get('start_sec') or 0.0), data))

    if rate is None:
        raise DubAssembleError('놓을 소리가 하나도 없습니다')

    bed = np.zeros((int(round(total_sec * rate)), channels), dtype='float32')
    clipped = 0
    for start_sec, data in loaded:
        if data.shape[1] < channels:
            data = np.repeat(data, channels, axis=1)
        a = max(0, int(round(start_sec * rate)))
        n = min(len(data), len(bed) - a)
        if n <= 0:
            clipped += 1
            continue
        if n < len(data):
            clipped += 1
        bed[a:a + n] += data[:n]

    peak = float(np.max(np.abs(bed))) if bed.size else 0.0
    scaled = 1.0
    if peak > 1.0:
        scaled = 1.0 / peak
        bed = bed * scaled
    sf.write(dest, bed, rate)
    return {'path': dest, 'sample_rate': rate, 'channels': channels,
            'total_sec': total_sec, 'placed': len(loaded),
            'trimmed': clipped, 'scaled': scaled}


def _slice_to_temp(path, start_sec, end_sec, work_dir, name):
    """원본의 한 구간만 떠서 임시 파일로. 음량을 재기 위한 것이다."""
    import soundfile as sf
    info = sf.info(path)
    rate = int(info.samplerate)
    a = max(0, int(round(start_sec * rate)))
    n = min(int(info.frames) - a, int(round((end_sec - start_sec) * rate)))
    if n <= 0:
        return None
    data, _ = sf.read(path, start=a, frames=n, dtype='float32', always_2d=True)
    out = os.path.join(work_dir, name)
    sf.write(out, data, rate)
    return out


def segment_loudness(path, start_sec, end_sec, work_dir):
    """원본의 그 구간이 얼마나 컸는지. **잴 수 없으면 None** - 지어내지 않는다.

    왜 구간마다 재는가: 원래 작게 말한 대목에서 새 목소리가 크게 나오면 바로 어색해진다.
    """
    try:
        tmp = _slice_to_temp(path, start_sec, end_sec, work_dir, 'seg-loud.wav')
        if tmp is None:
            return None
        try:
            return audio_fit.measure_loudness(tmp)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    except (AudioFitError, OSError):
        return None


def fit_one_line(src, dest, plan, *, target_lufs=None, work_dir=None, ffmpeg=None):
    """줄 하나를 자리에 맞게 손본다 - 길이를 맞추고, 필요하면 음량도 맞춘다.

    plan - dub_timing.plan_line 이 준 것. ratio 가 1이면 늘이지 않는다.
    target_lufs - 원본 그 구간의 음량. None 이면 음량은 건드리지 않는다.

    한 일을 전부 돌려준다 - 무엇을 했는지 모르는 결과를 내지 않는다.
    """
    work_dir = work_dir or os.path.dirname(dest)
    done = {'stretched': False, 'ratio': 1.0, 'loudness_matched': False,
            'loudness_note': ''}

    stage = src
    ratio = float(plan.get('ratio') or 1.0)
    if ratio > 1.0 + 1e-6:
        mid = os.path.join(work_dir, os.path.basename(dest) + '.stretch.wav')
        info = audio_fit.stretch_to(src, mid, plan['place_sec'], ffmpeg=ffmpeg)
        done['stretched'] = True
        done['ratio'] = info['ratio']
        done['clamped'] = info['clamped']
        stage = mid

    if target_lufs is None:
        if stage != dest:
            shutil.copyfile(stage, dest)
        done['loudness_note'] = '원본 음량을 재지 못해 그대로 두었습니다'
    else:
        try:
            info = audio_fit.match_loudness(stage, dest, float(target_lufs), ffmpeg=ffmpeg)
            done['loudness_matched'] = True
            done['gain_db'] = info['gain_db']
            if info['clamped']:
                done['loudness_note'] = '한계까지만 조절했습니다(%.1fdB)' % info['gain_db']
        except AudioFitError as e:
            # 음량을 못 맞춘다고 그 줄을 버리지 않는다. 소리는 남기고 사실만 적는다.
            if stage != dest:
                shutil.copyfile(stage, dest)
            done['loudness_note'] = str(e)

    if stage != src and stage != dest and os.path.isfile(stage):
        try:
            os.remove(stage)
        except OSError:
            pass
    return done


def mux_video(video_path, audio_path, dest, *, ffmpeg=None):
    """원본 영상에 새 소리를 붙여 **새 파일**로 낸다. 그림은 다시 만들지 않는다.

    ★원본 영상은 건드리지 않는다. 그림을 그대로 복사하므로 화질이 떨어지지 않고 빠르다.
    """
    if os.path.abspath(video_path) == os.path.abspath(dest):
        raise DubAssembleError('결과를 원본 영상 위에 덮어쓸 수 없습니다')
    try:
        audio_fit._run_ffmpeg([
            '-i', video_path, '-i', audio_path,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
            '-shortest', dest,
        ], ffmpeg=ffmpeg)
    except AudioFitError as e:
        raise DubAssembleError('영상에 소리를 붙이지 못했습니다: %s' % e)
    return {'path': dest, 'video_from': video_path, 'audio_from': audio_path}


def write_srt(lines, dest):
    """덤으로 나오는 한국어 자막. 만드는 과정에서 이미 나온 것이라 따로 비용이 없다."""
    def stamp(sec):
        sec = max(0.0, float(sec))
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = int(sec % 60)
        ms = int(round((sec - int(sec)) * 1000))
        if ms == 1000:
            s, ms = s + 1, 0
        return '%02d:%02d:%02d,%03d' % (h, m, s, ms)

    out = []
    n = 0
    for ln in lines:
        text = (ln.get('korean') or '').strip()
        if not text:
            continue
        n += 1
        out.append(str(n))
        out.append('%s --> %s' % (stamp(ln['start_sec']), stamp(ln['end_sec'])))
        out.append(text)
        out.append('')
    with open(dest, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    return {'path': dest, 'count': n}
