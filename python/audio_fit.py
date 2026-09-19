# -*- coding: utf-8 -*-
"""더빙 보정 부품 — 시간 조절·음량 맞추기·덕킹.

전부 이 장비의 ffmpeg 필터로 한다(8.1-full 에 rubberband·volume·sidechaincompress 가 있다).
새 모델·새 설치가 필요 없다.

이 파일은 **부품만** 담는다. '언제 늘이고 언제 포기하는가' 하는 판단은 자리 맞추기(다음 단계)의 몫이다.
여기에 판단을 넣으면 같은 규칙이 두 곳에 생긴다.

실패는 숨기지 않는다 — ffmpeg 이 실패하면 사유를 담아 AudioFitError 를 던진다.
한계에 걸려 요청대로 못 한 경우도 조용히 넘기지 않고 `clamped=True` 로 알린다.

기획: doc/work-in-progress/video-dubbing.md
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio_utils import find_ffmpeg


class AudioFitError(RuntimeError):
    """보정 중 실패. 사유를 문구로 담는다."""


def _run_ffmpeg(args, *, ffmpeg=None):
    exe = ffmpeg or find_ffmpeg()
    cmd = [exe, '-hide_banner', '-loglevel', 'error', '-y'] + list(args)
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        tail = (r.stderr or b'').decode('utf-8', 'replace').strip()[-400:]
        raise AudioFitError('ffmpeg 실패(%d): %s' % (r.returncode, tail))
    return r


def probe_duration(path: str) -> float:
    """음원 길이(초). 파일이 없거나 읽히지 않으면 사유와 함께 실패한다."""
    if not os.path.isfile(path):
        raise AudioFitError('파일이 없습니다: %s' % os.path.basename(path))
    try:
        import soundfile as sf
        info = sf.info(path)
        return float(info.frames) / float(info.samplerate)
    except AudioFitError:
        raise
    except Exception as e:
        raise AudioFitError('길이를 읽지 못했습니다: %s' % e)
