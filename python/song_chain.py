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


# ★주보컬/화음 가르기를 **기본으로 하지 않는다**(2026-09-26 사용자 청취).
#
#   두 사실이 모두 참이라 값을 고르기 어려웠다:
#     2026-09-20  겹친 화음을 그대로 넣으면 변환기가 두 음높이 사이에서 헤매
#                 기계음이 난다 — 그래서 이 단계를 넣었다.
#     2026-09-26  그런데 이 단계가 **말을 통째로 앗아간다.** 갈라내기 품질을
#                 셋(지금 모델·bleedless·앙상블)으로 바꿔 가며 확인했는데
#                 **셋 다 제대로 들리지 않았다.**
#
#   ★내 가설은 반증됐다 — "첫 갈라내기를 깨끗하게 하면 두 번째도 풀린다" 고 봤으나,
#     첫 단계 품질과 무관하게 이 단계가 말을 앗아갔다.
#
#   그래서 기본은 끔이다. **말을 잃는 것이 화음이 조금 섞이는 것보다 나쁘다.**
#   겹쳐 부른 곡에서는 켜야 할 수 있으므로 고를 수 있게 남겨 둔다.
SPLIT_LEAD_DEFAULT = False


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
    """두 음높이 사이의 반음 차."""
    if not from_hz or not to_hz:
        return 0.0
    return 12.0 * math.log2(float(to_hz) / float(from_hz))


# 음역이 이만큼 벌어지면 옥타브를 옮긴다. 반음 몇 개 차이로는 건드리지 않는다.
OCTAVE_GAP_SEMITONES = 5.0


def octave_shift(song_hz, voice_hz, *, threshold=OCTAVE_GAP_SEMITONES):
    """부를 높이를 **옥타브 단위로만** 옮긴다. 옮길 필요가 없으면 0.

    ★왜 필요한가 (2026-09-26, 사용자 신고 "목소리가 안 바뀌고 끅끅대며 숨소리만 난다")
      이 곡의 주보컬은 약 519Hz 인데 쓴 목소리의 평소 높이는 약 355Hz —
      **반 옥타브 넘게 위**다. 그 높이를 그대로 부르게 하면 변환기가 음색을 입히지
      못하고 힘만 쓴다. 숫자로 확인됐다(음색 거리, 작을수록 그 목소리에 가깝다):

          그대로 부르기   참조와 63.9 · 원본과 71.7   ← 거의 안 바뀜
          한 옥타브 내림  참조와 44.5 · 원본과 95.6   ← 확실히 바뀜

    ★왜 **옥타브 단위만** 인가
      옥타브는 같은 음이고 높이만 다르다. 그래서 반주와 부딪히지 않는다.
      5반음·7반음처럼 어중간하게 옮기면 **반주와 조가 어긋나 노래가 깨진다.**
      변환기에 '알아서 맞춤' 기능이 있지만 그것도 조를 바꿔 버린다 — 쓰지 않는다.
    """
    gap = semitones(voice_hz, song_hz)          # 목소리 기준으로 곡이 얼마나 높은가
    if abs(gap) < float(threshold):
        return 0
    return int(round(gap / 12.0)) * -12          # 곡을 목소리 쪽으로 끌어내린다


def median_pitch(path, seconds=90.0):
    """중앙 음높이(Hz). 음역을 맞추는 데만 쓴다."""
    import numpy as np
    import librosa
    y, sr = librosa.load(path, sr=16000, mono=True, duration=seconds)
    f, v, _ = librosa.pyin(y, fmin=70, fmax=1000, sr=sr, frame_length=1024)
    f = f[v & np.isfinite(f)]
    return float(np.median(f)) if len(f) else 0.0


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
                 separate_fn=None, convert_fn=None, run=subprocess.run,
                 pitch_fn=None, split_lead=SPLIT_LEAD_DEFAULT):
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

    return convert_from_vocals(
        vocals, inst, reference, work_dir, voice_name=voice_name, log=log,
        separate_fn=sep_fn, convert_fn=conv_fn, run=run,
        pitch_fn=pitch_fn, split_lead=split_lead)


def convert_from_vocals(vocals, instrumental, reference, work_dir, *,
                        voice_name='목소리', log=None,
                        separate_fn=None, convert_fn=None, run=subprocess.run,
                        pitch_fn=None, split_lead=SPLIT_LEAD_DEFAULT):
    """**이미 갈라 둔 보컬**로 이어서 한다. 갈라내기를 두 번 하지 않기 위한 문이다.

    ★왜 이 문이 생겼나 (2026-09-26)
      더빙과 따라부르기는 **앞뒤가 같고 가운데만 다른 한 기능**이다.
      그런데 나는 둘을 따로 만들어, 더빙이 이미 갈라 둔 보컬이 있는데도
      따라부르기가 **같은 갈라내기를 다시** 하게 해 놓았다.
      사용자 지적으로 드러났다 — "음원을 대체 몇 번을 불러내야 하는가".

      이제 더빙 앞단이 만든 `vocals.wav` · `background.wav` 를 그대로 받는다.
    """
    say = log or (lambda _m: None)
    sep_fn = separate_fn or separate
    conv_fn = convert_fn or song_voice.convert_vocal
    os.makedirs(work_dir, exist_ok=True)
    for what, p in (('보컬', vocals), ('반주', instrumental), ('참조 목소리', reference)):
        if not p or not os.path.isfile(p):
            raise SongChainError('%s 파일이 없습니다: %s'
                                 % (what, os.path.basename(p or '')))
    inst = instrumental

    # ★두 번째 가르기는 **곡에 따라 독이 된다.**
    #
    #   2026-09-20: 겹쳐 부른 화음이 섞인 채로 변환기에 넣으면 두 음높이 사이에서
    #     헤매 기계음이 난다 — 그래서 이 단계를 넣었다.
    #   2026-09-26: 그런데 어떤 곡에서는 이 단계가 **말을 통째로 앗아간다.**
    #     사용자 청취로 확인됐다 — 반주만 걷어낸 보컬에는 말이 있는데, 한 번 더
    #     가른 '주보컬' 에는 없었다. 결과는 숨소리만 헐떡이는 소리였다.
    #
    #   둘 다 참이다. 그래서 **고를 수 있게** 두고, 무엇을 골랐는지 기록에 남긴다.
    #   신호 지표로는 어느 쪽인지 가려내지 못했다(다섯 가지로 재 봤고 전부 실패).
    #   지금 이것을 가릴 수 있는 것은 **귀뿐**이다.
    lead, harm = vocals, None
    if split_lead:
        say('주 보컬과 화음 가르는 중')
        d2 = os.path.join(work_dir, '2_주보컬분리')
        files2 = _cached_or(d2, lambda: sep_fn(vocals, d2, KARAOKE_MODEL_KEY))
        lead = pick_by_last_tag(files2, 'Vocals')
        harm = pick_by_last_tag(files2, 'Instrumental')
        if not lead or not harm:
            raise SongChainError('주 보컬 분리 결과를 찾지 못했습니다(%d개).' % len(files2))
    else:
        say('주 보컬 가르기를 건너뛴다 — 보컬 전체를 그대로 바꾼다')

    # ★음역을 맞춘다 — 안 맞추면 음색이 아예 안 입혀진다(위 octave_shift 참고).
    shift, song_hz, voice_hz = 0, 0.0, 0.0
    if pitch_fn is not False:
        pf = pitch_fn or median_pitch
        song_hz, voice_hz = pf(lead), pf(reference)
        shift = octave_shift(song_hz, voice_hz)
        if shift:
            say('음역이 %.1f반음 벌어져 %d옥타브 내려 부른다'
                % (semitones(voice_hz, song_hz), abs(shift) // 12))

    say('목소리 바꾸는 중')
    made = conv_fn(lead, reference, os.path.join(work_dir, '3_변환'), log=log,
                   semitones=shift)
    converted = os.path.join(work_dir, '바뀐주보컬_%s.wav' % voice_name)
    os.replace(made, converted)

    say('합치는 중')
    plain = mix([inst, converted],
                os.path.join(work_dir, '완성_화음없이_%s.wav' % voice_name), run=run)
    out = {'주보컬만': converted, '화음없이': plain}
    # 화음을 따로 갈라낸 때만 '원래 화음까지' 를 만들 수 있다.
    if harm:
        out['원래화음같이'] = mix(
            [inst, harm, converted],
            os.path.join(work_dir, '완성_원래화음같이_%s.wav' % voice_name), run=run)
    note = {'쓴 목소리': voice_name,
            '곡 주보컬 음높이Hz': round(song_hz), '목소리 음높이Hz': round(voice_hz),
            '옮긴 옥타브': (shift // 12) if shift else 0,
            '음높이': ('옥타브만 옮김 — 음은 그대로라 반주와 어긋나지 않는다'
                     if shift else '원곡 그대로'),
            '주보컬 가르기': '했음' if split_lead else '건너뜀',
            '되풀이 단계': song_voice.DIFFUSION_STEPS, '만든 것': out}
    with open(os.path.join(work_dir, '쓴목소리.json'), 'w', encoding='utf-8') as f:
        json.dump(note, f, ensure_ascii=False, indent=2)
    say('끝남')
    return out
