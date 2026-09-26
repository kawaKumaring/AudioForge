# -*- coding: utf-8 -*-
"""따라부르기 사슬 — 곡 하나를 끝까지 돌린다.

    소리 꺼내기 → 반주/보컬 분리 → 주보컬/화음 분리 → 주보컬만 변환 → 합치기

변환 한 칸은 `song_voice.py` 가 맡는다. 이 파일은 **그 부품이 무엇인지 모른다** —
나중에 모델을 갈아 끼울 때 여기를 손대지 않기 위해서다(2026-09-26 사용자 결정).

★이 사슬은 새로 설계한 것이 아니다. 2026-09-20 에 네 곡을 실제로 변환해 내고
  사용자 청취로 검증된 순서를 그대로 옮긴 것이다. 임의로 줄이거나 바꾸지 않는다.
"""
import json
import math
import os
import re
import subprocess

import song_voice

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEPARATOR_DIR = os.path.join(ROOT, 'externals', 'separator_models')

# 두 분리 단계에서 쓰는 모델. 둘 다 앱 externals 에 이미 있다.
VOCAL_MODEL_KEY = 'model_bs_roformer_ep_317_sdr_12.9755'    # 반주 ↔ 보컬
KARAOKE_MODEL_KEY = 'karaoke_aufr33_viperx'                  # 주보컬 ↔ 화음

# ★참조는 **짧아야 한다**(2026-09-20 실측).
#   변환기의 처리 창은 대략 `30초 - 참조 길이` 다. 그래서 긴 참조를 주면 창이
#   쪼그라들고 곡이 잘게 토막 난다 — 4분 곡 기준:
#       참조 25초 → 창 5초  → 토막 51개
#       참조  8초 → 창 22초 → 토막 12개
#   토막이 많을수록 이음매가 늘어 소리가 거칠어진다.
CONVERTER_WINDOW_SEC = 30.0
REF_MAX_SEC = 12.0


class SongChainError(RuntimeError):
    """사슬을 돌릴 수 없는 상태. 사유를 문구에 담는다."""


# ── 순수 계산 — 소리도 파일도 건드리지 않는다 ──────────────────────────────

def segment_window_sec(ref_sec, *, total=CONVERTER_WINDOW_SEC):
    """참조 길이로 정해지는 처리 창. **왜 짧아야 하는지를 숫자로 보이게** 한다."""
    return max(0.0, float(total) - float(ref_sec))


def segment_count(song_sec, ref_sec, *, total=CONVERTER_WINDOW_SEC):
    """곡이 몇 토막으로 잘릴지. 창이 0 이하면 돌릴 수 없다."""
    w = segment_window_sec(ref_sec, total=total)
    if w <= 0:
        raise SongChainError('참조가 너무 길어 처리 창이 남지 않습니다(%.0f초).' % ref_sec)
    return int(math.ceil(float(song_sec) / w))


def pick_by_last_tag(files, want):
    """파일 이름의 **마지막 꼬리표**로 고른다. 없으면 None.

    ★2026-09-20 실제 사고 — 이 규칙이 이 사슬에서 가장 비싼 교훈이다.
      2단계 산출물의 이름은 1단계 꼬리표를 **그대로 물려받는다**:

          source_(Vocals)_..._(Instrumental)_..._karaoke.wav   ← 화음
          source_(Vocals)_..._(Vocals)_..._karaoke.wav         ← 주 보컬

      "이름에 (vocals) 가 들어 있는가" 로 고르면 **둘 다 걸린다.**
      그래서 앞의 것(화음)이 주 보컬로 잡혔고, **네 곡 전부 화음을 변환했다.**
      겹쳐 부른 목소리가 섞여 있으면 변환기가 두 음높이 사이에서 헤매
      기계음이 튀어나온다. 사용자가 한 시간을 버렸다.

      숫자로도 갈린다 — 주보컬의 좌우 차이 0.06~0.17, 화음 층 0.41~1.03.
    """
    want = str(want).strip('()').lower()
    for f in files:
        tags = re.findall(r'\(([^()]+)\)', os.path.basename(f))
        if tags and tags[-1].lower() == want:
            return f
    return None


def semitones(from_hz, to_hz):
    """두 음높이 사이의 반음 차. 기록에만 쓴다 — 조를 옮기지는 않는다."""
    if not from_hz or not to_hz:
        return 0.0
    return 12.0 * math.log2(float(to_hz) / float(from_hz))


# ── 바깥 일을 하는 칸들 — 전부 갈아 끼울 수 있게 인자로 연다 ────────────────

def _ffmpeg():
    return os.environ.get('AUDIOFORGE_FFMPEG') or 'ffmpeg'


def run_ffmpeg(args, *, run=subprocess.run):
    r = run([_ffmpeg(), '-hide_banner', '-loglevel', 'error', '-y'] + list(args),
            capture_output=True)
    if getattr(r, 'returncode', 1) != 0:
        tail = getattr(r, 'stderr', b'') or b''
        if isinstance(tail, bytes):
            tail = tail.decode('utf-8', 'replace')
        raise SongChainError('소리 다루기가 실패했습니다 — %s' % tail.strip()[-300:])


def extract_audio(video, dest, *, run=subprocess.run):
    """영상에서 소리만 꺼낸다. 이미 있으면 다시 하지 않는다."""
    if os.path.isfile(dest):
        return dest
    run_ffmpeg(['-i', video, '-vn', '-ac', '2', '-ar', '44100', dest], run=run)
    return dest


def separate(src, out_dir, model_key):
    """두 갈래로 가른다. **이름을 바꾸지 않는다** — 꼬리표가 판별 근거다.

    ★앱의 음악 분리 경로(`music_worker.run_roformer_separation`)를 그대로 쓰지 않는
      이유가 이것이다. 그쪽은 결과를 `vocals.wav` 로 **이름을 바꿔** 저장한다.
      두 단계를 이어 붙이는 이 사슬에서는 그 순간 꼬리표가 사라져,
      위에 적은 사고를 다시 부른다.
    """
    from audio_separator.separator import Separator
    os.makedirs(out_dir, exist_ok=True)
    sep = Separator(model_file_dir=SEPARATOR_DIR, output_dir=out_dir,
                    output_format='WAV')
    filename = None
    for _fam, models in sep.list_supported_model_files().items():
        for name, info in models.items():
            if model_key in str(name) or model_key in str(info):
                filename = info if isinstance(info, str) else info.get('filename')
                break
        if filename:
            break
    if not filename:
        raise SongChainError('분리 모델을 찾지 못했습니다: %s' % model_key)
    sep.load_model(model_filename=filename)
    return [os.path.join(out_dir, m) for m in sep.separate(src)]


def _cached_or(out_dir, make):
    """이미 만들어 둔 단계가 있으면 다시 돌리지 않는다 — 분리는 비싸다."""
    if os.path.isdir(out_dir) and os.listdir(out_dir):
        return [os.path.join(out_dir, f) for f in sorted(os.listdir(out_dir))]
    return make()


def mix(sources, dest, *, run=subprocess.run):
    """여러 소리를 한 벌로 섞는다. 음량이 튀지 않게 끝에 한계선을 둔다."""
    if not sources:
        raise SongChainError('섞을 소리가 없습니다')
    args = []
    for s in sources:
        args += ['-i', s]
    chain = ''.join('[%d:a]' % i for i in range(len(sources)))
    args += ['-filter_complex',
             '%samix=inputs=%d:normalize=0[m];'
             '[m]alimiter=level_in=1:level_out=0.95[o]' % (chain, len(sources)),
             '-map', '[o]', dest]
    run_ffmpeg(args, run=run)
    return dest


# ── 사슬 ────────────────────────────────────────────────────────────────

def convert_song(video, reference, work_dir, *, voice_name='목소리',
                 ref_sec=None, song_sec=None, log=None,
                 separate_fn=None, convert_fn=None, run=subprocess.run):
    """곡 하나를 끝까지. 만들어진 것들의 경로를 돌려준다.

    ★단계마다 **결과가 없으면 거기서 멈춘다.** 빈손을 다음 칸에 넘기지 않는다 —
      그러면 어디서 틀어졌는지 알 수 없게 된다.
    """
    say = log or (lambda _m: None)
    sep_fn = separate_fn or separate
    conv_fn = convert_fn or song_voice.convert_vocal
    os.makedirs(work_dir, exist_ok=True)

    # ★참조가 길면 여기서 막는다. 돌리고 나서 "거칠다" 고 알아채면 몇 십 분을 버린다.
    if ref_sec is not None and float(ref_sec) > REF_MAX_SEC:
        n = segment_count(song_sec or 240.0, ref_sec)
        raise SongChainError(
            '참조 목소리가 깁니다(%.0f초). 처리 창이 %.0f초로 줄어 곡이 토막 %d개로 갈립니다 — '
            '%.0f초 이하로 잘라 주세요.'
            % (ref_sec, segment_window_sec(ref_sec), n, REF_MAX_SEC))

    say('소리 꺼내는 중')
    source = extract_audio(video, os.path.join(work_dir, 'source.wav'), run=run)

    say('반주와 보컬 가르는 중')
    d1 = os.path.join(work_dir, '1_반주분리')
    files1 = _cached_or(d1, lambda: sep_fn(source, d1, VOCAL_MODEL_KEY))
    vocals = pick_by_last_tag(files1, 'Vocals')
    inst = pick_by_last_tag(files1, 'Instrumental')
    if not vocals or not inst:
        raise SongChainError('반주 분리 결과를 찾지 못했습니다(%d개).' % len(files1))

    # ★이 단계를 건너뛰면 겹친 목소리가 변환기에 들어가 기계음이 난다. 반드시 거친다.
    say('주 보컬과 화음 가르는 중')
    d2 = os.path.join(work_dir, '2_주보컬분리')
    files2 = _cached_or(d2, lambda: sep_fn(vocals, d2, KARAOKE_MODEL_KEY))
    lead = pick_by_last_tag(files2, 'Vocals')
    harm = pick_by_last_tag(files2, 'Instrumental')
    if not lead or not harm:
        raise SongChainError('주 보컬 분리 결과를 찾지 못했습니다(%d개).' % len(files2))

    say('목소리 바꾸는 중')
    made = conv_fn(lead, reference, os.path.join(work_dir, '3_변환'), log=log)
    converted = os.path.join(work_dir, '바뀐주보컬_%s.wav' % voice_name)
    os.replace(made, converted)

    say('합치는 중')
    plain = mix([inst, converted],
                os.path.join(work_dir, '완성_화음없이_%s.wav' % voice_name), run=run)
    withharm = mix([inst, harm, converted],
                   os.path.join(work_dir, '완성_원래화음같이_%s.wav' % voice_name), run=run)

    out = {'주보컬만': converted, '화음없이': plain, '원래화음같이': withharm}
    note = {'쓴 목소리': voice_name, '음높이': '원곡 그대로(조를 옮기지 않음)',
            '되풀이 단계': song_voice.DIFFUSION_STEPS, '만든 것': out}
    with open(os.path.join(work_dir, '쓴목소리.json'), 'w', encoding='utf-8') as f:
        json.dump(note, f, ensure_ascii=False, indent=2)
    say('끝남')
    return out
