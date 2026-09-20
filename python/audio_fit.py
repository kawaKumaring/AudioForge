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


# rubberband 가 감당하는 범위. 이 밖은 소리가 무너진다.
# ★이 값은 '자연스러움의 한계'가 아니다 — 그것은 사람이 듣고 정하며 자리 맞추기 단계가 쓴다.
STRETCH_MIN_RATIO = 0.5
STRETCH_MAX_RATIO = 2.0

# rubberband 설정 — **기본값 그대로 쓴다(2026-09-20 확정).**
#
# 후보 셋을 만들어 견주었다: 기본값(레벨 5) / 시작음 처리 끔(레벨 3) / 거기에 위상 독립까지(레벨 2).
#   귀  — 셋이 구별되지 않았다.
#   숫자 — 1.10배에서 음높이가 기본값 -8.9센트, 레벨 3 +41.3센트, 레벨 2 +35.0센트 움직였다.
#          기본값이 가장 안 흔들린다.
# 귀와 숫자가 같은 방향이므로 **바꿀 근거가 없다.** 빈 사전이 곧 기본값이다.
#
# 남은 결: 높은 가성 구간에서만 옅은 울림이 진해진다(낮은 음은 티가 적다). 이것은 위상 보코더가
# 숨소리 섞인 높은 음을 늘일 때 나오는 것이라 이 설정들로는 줄지 않는다. 제대로 고치려면 다른
# 엔진(R3)이 필요하고 이 장비에 없다 — 실제 영상을 돌려 보고 거슬리면 그때 다시 본다.
RUBBERBAND_DEFAULT_OPTS = {}


def stretch_to(src: str, dest: str, target_sec: float, *, ffmpeg=None, rb_options=None) -> dict:
    """음높이를 지키며 길이를 target_sec 에 맞춘다.

    ratio > 1 이면 빠르게(짧게), < 1 이면 느리게(길게).
    한계를 넘는 요구는 **한계까지만** 하고 `clamped=True` 로 알린다 — 조용히 포기하지 않는다.

    `rb_options` 로 rubberband 설정을 덮어쓴다(예: {'transients': 'smooth', 'detector': 'soft'}).
    주지 않으면 RUBBERBAND_DEFAULT_OPTS 를 쓴다.
    """
    if not target_sec or target_sec <= 0:
        raise AudioFitError('목표 길이는 0보다 커야 합니다: %r' % (target_sec,))
    src_sec = probe_duration(src)
    want = src_sec / target_sec
    ratio = max(STRETCH_MIN_RATIO, min(STRETCH_MAX_RATIO, want))
    clamped = abs(ratio - want) > 1e-9
    opts = dict(RUBBERBAND_DEFAULT_OPTS)
    if rb_options:
        opts.update(rb_options)
    parts = ['tempo=%.6f' % ratio] + ['%s=%s' % (k, v) for k, v in sorted(opts.items())]
    _run_ffmpeg(['-i', src, '-filter:a', 'rubberband=' + ':'.join(parts), dest], ffmpeg=ffmpeg)
    return {
        'rb_options': opts,
        'ratio': ratio,
        'requested_ratio': want,
        'clamped': clamped,
        'src_sec': src_sec,
        'target_sec': target_sec,
        'out_sec': probe_duration(dest),
    }


# 방송에서 쓰는 통합 음량 기준. 0.4초보다 짧은 소리는 이 방식으로 잴 수 없다.
LOUDNESS_MIN_SEC = 0.4
LOUDNESS_MAX_GAIN_DB = 12.0


def measure_loudness(path: str):
    """통합 음량(LUFS). **잴 수 없으면 None** — 없는 값을 지어내지 않는다."""
    if probe_duration(path) < LOUDNESS_MIN_SEC:
        return None
    try:
        import numpy as np
        import pyloudnorm as pyln
        import soundfile as sf
    except Exception as e:
        raise AudioFitError('음량을 재는 데 필요한 것이 없습니다: %s' % e)
    data, rate = sf.read(path)
    meter = pyln.Meter(rate)
    value = float(meter.integrated_loudness(data))
    if not np.isfinite(value):
        return None
    return value


def match_loudness(src: str, dest: str, target_lufs: float, *,
                   max_gain_db: float = LOUDNESS_MAX_GAIN_DB, ffmpeg=None) -> dict:
    """src 의 음량을 target_lufs 에 맞춰 dest 로 쓴다.

    한계를 넘는 증폭·감쇠는 **한계까지만** 하고 `clamped=True` 로 알린다.
    잴 수 없는 소리(너무 짧음)는 사유와 함께 실패한다 — 손대지 않고 넘기면 조용히 어긋난다.
    """
    before = measure_loudness(src)
    if before is None:
        raise AudioFitError('음량을 잴 수 없습니다(%.2f초 — %.1f초 이상 필요)'
                            % (probe_duration(src), LOUDNESS_MIN_SEC))
    want = target_lufs - before
    gain = max(-max_gain_db, min(max_gain_db, want))
    clamped = abs(gain - want) > 1e-9
    _run_ffmpeg(['-i', src, '-filter:a', 'volume=%.3fdB' % gain, dest], ffmpeg=ffmpeg)
    return {
        'before_lufs': before,
        'after_lufs': measure_loudness(dest),
        'gain_db': gain,
        'requested_gain_db': want,
        'clamped': clamped,
    }


# 덕킹 기본값. 방송에서 쓰는 보통 값에서 출발한다 — 들어 보고 조정할 수 있게 인자로 연다.
DUCK_THRESHOLD = 0.03
DUCK_RATIO = 8.0
DUCK_ATTACK_MS = 20.0
DUCK_RELEASE_MS = 300.0


def duck(bg: str, voice: str, dest: str, *, threshold: float = DUCK_THRESHOLD,
         ratio: float = DUCK_RATIO, attack_ms: float = DUCK_ATTACK_MS,
         release_ms: float = DUCK_RELEASE_MS, ffmpeg=None) -> dict:
    """말하는 동안 배경음을 눌러(덕킹) 목소리와 섞는다.

    돌려주는 `ducked_bg_path` 는 **목소리를 섞기 전의 배경음**이다 — 검사와 진단이
    '정말 낮아졌는가' 를 섞인 소리가 아니라 배경음만 보고 확인할 수 있게 함께 낸다.
    """
    ducked_bg = os.path.splitext(dest)[0] + '.bg.wav'
    graph = (
        '[1:a]asplit=2[sc][v];'
        '[0:a][sc]sidechaincompress='
        'threshold=%.5f:ratio=%.3f:attack=%.1f:release=%.1f[bgd];'
        '[bgd]asplit=2[bgout][bgmix];'
        '[bgmix][v]amix=inputs=2:normalize=0[mix]'
        % (threshold, ratio, attack_ms, release_ms)
    )
    _run_ffmpeg([
        '-i', bg, '-i', voice, '-filter_complex', graph,
        '-map', '[mix]', dest,
        '-map', '[bgout]', ducked_bg,
    ], ffmpeg=ffmpeg)
    return {
        'ducked_bg_path': ducked_bg,
        'threshold': threshold,
        'ratio': ratio,
        'attack_ms': attack_ms,
        'release_ms': release_ms,
        'out_sec': probe_duration(dest),
    }

