# -*- coding: utf-8 -*-
"""**대사 계측대** — 시각과 글이 정확히 알려진 대사 음원을 만든다.

왜 만드는가(2026-09-24)
  최근 결론이 전부 같은 말로 끝났다 — "노래로만 쟀다. 대사로 재 봐야 안다."
  무음 스냅도, 배경음 걷어내기도, 자막 손질도 거기서 멈춰 있다.
  **막힌 것은 어느 기능 하나가 아니라 잴 자가 없는 것이다.**

  그런데 대사 재료에는 두 가지 문제가 있다.
    · 사용자 미디어는 함부로 쓸 수 없다
    · 진짜 영상은 **정답 시각을 모른다** — 오차를 재려면 참값이 있어야 한다

  그래서 **우리가 직접 만든다.** 줄마다 우리가 놓은 자리를 알고 있으니
  참값이 지어낸 것이 아니라 **설계상 정확하다.**

무엇이 정확한가 / 무엇이 아닌가
  정확하다 — 줄의 시작·끝 시각, 줄의 글자(우리가 쓴 것).
  아니다   — 실제 녹음의 방 울림·겹쳐 말하기·마이크 잡음.
             합성 목소리는 시작이 깨끗해서 **실제보다 후하게 나온다.**
             그래서 이 자로 낸 수치는 **상대 비교**에 쓴다(전후·설정 간).
             절대값을 실제 영상 성능이라고 말하지 않는다.

이 파일은 소리를 만들고 참값을 적는다. **판정하지 않는다.**
합성기는 밖에서 넣어 준다(synth_fn) — 그래서 모델 없이도 검사할 수 있다.
"""
import json
import os

# 줄 사이 빈 자리. 대사는 노래와 달리 여기가 진짜로 조용하다 —
# 무음 스냅이 듣는 것도 바로 이 자리다.
DEFAULT_SR = 24000
KOKORO_SR = 24000        # Kokoro 가 내놓는 표본율
KOKORO_LANG = 'a'        # 설치된 판에 한국어가 없다(위 SCRIPT 설명 참고)
# 목소리는 kokoro_compat 한 곳에서 고른다 — 엔진과 다른 것을 쓰면 결과가 갈린다.
LEAD_SEC = 0.6              # 맨 앞 여백
TRIM_DB = 40.0              # 합성 결과 앞뒤 정적을 이만큼 아래에서 잘라낸다
TRIM_PAD_SEC = 0.02         # 잘라낸 뒤 조금만 되돌려 둔다(자음 앞부분 보호)

# (글, 앞에 둘 빈 자리 초). 길이를 섞어 둔다 — 짧은 줄이 시각 오차에 더 약하다.
#
# ★왜 영어인가(2026-09-24): 설치된 Kokoro 에 **한국어가 없고**(a,b,e,f,h,i,p,j,z),
#   일본어는 pyopenjtalk 이 없어 안 된다. 새 의존성을 들이지 않기로 하고 영어로 간다.
#   시각을 재는 데는 말의 언어가 상관없다 — 참값은 우리가 놓은 자리다.
#   다만 **알아듣기 정확도는 영어가 가장 후하게 나온다.** 그 수치는 절대값으로 쓰지 않는다.
SCRIPT = (
    ("Hello there. The weather is really nice today.", 0.0),
    ("Yes, it certainly is.", 0.8),
    ("It rained all day yesterday, but this morning the sky cleared up completely.", 0.5),
    ("Then how about we go for a walk?", 1.2),
    ("Sounds good.", 0.4),
    ("Let us have lunch first and then take our time.", 0.9),
    ("Have you decided where to go?", 0.6),
    ("The riverside is quiet, so I think that would be pleasant.", 1.0),
    ("All right. Let us meet at one o'clock.", 0.7),
    ("Understood. See you later.", 0.5),
)


class BenchError(RuntimeError):
    """계측대를 만들 수 없다. 사유를 문구로 담는다."""


def trim_silence(y, sr, top_db=TRIM_DB, pad_sec=TRIM_PAD_SEC):
    """앞뒤 정적을 걷어낸다. **참값이 어긋나지 않게 하는 핵심 단계다.**

    합성 결과 앞에 정적이 붙어 있으면, 우리가 '2.0초에 놓았다' 고 적어도
    실제 말은 2.3초에 시작한다. 그러면 참값이 참값이 아니다.
    """
    import numpy as np
    y = np.asarray(y, dtype=np.float64)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if not y.size:
        return y
    peak = float(np.max(np.abs(y)))
    if peak <= 0:
        return y
    floor = peak * (10.0 ** (-top_db / 20.0))
    loud = np.flatnonzero(np.abs(y) >= floor)
    if not len(loud):
        return y
    pad = int(round(pad_sec * sr))
    a = max(0, int(loud[0]) - pad)
    b = min(len(y), int(loud[-1]) + pad + 1)
    return y[a:b]


def noise_bed(n, sr, seed=7, level=1.0):
    """배경음 흉내 — 낮은 웅웅거림 + 잔잔한 잡음. **결정적이다(같은 씨앗=같은 소리).**

    ★진짜 반주가 아니다. 갈라내기 성능을 이걸로 판정하면 안 된다.
      여기서의 쓰임은 '조용하지 않은 배경이 있을 때 시각이 어떻게 되는가' 뿐이다.
    """
    import numpy as np
    rng = np.random.default_rng(seed)
    t = np.arange(n) / float(sr)
    hum = (0.6 * np.sin(2 * np.pi * 110.0 * t)
           + 0.3 * np.sin(2 * np.pi * 220.0 * t)
           + 0.2 * np.sin(2 * np.pi * 330.0 * t))
    hiss = rng.normal(0.0, 0.25, n)
    bed = hum + hiss
    m = float(np.max(np.abs(bed))) or 1.0
    return (bed / m) * level


def mix_at_snr(speech, bed, snr_db):
    """말과 배경을 **정해진 크기 차이**로 섞는다. 돌려주는 것: 섞인 소리.

    크기는 말이 있는 자리에서만 잰다 — 빈 자리까지 세면 말이 실제보다 작게 잡힌다.
    """
    import numpy as np
    speech = np.asarray(speech, dtype=np.float64)
    bed = np.asarray(bed, dtype=np.float64)[:len(speech)]
    voiced = speech[np.abs(speech) > (np.max(np.abs(speech)) * 1e-3)]
    if not voiced.size or not bed.size:
        return speech
    s_rms = float(np.sqrt((voiced ** 2).mean()))
    b_rms = float(np.sqrt((bed ** 2).mean())) or 1e-9
    want = s_rms / (10.0 ** (snr_db / 20.0))
    mixed = speech + bed * (want / b_rms)
    peak = float(np.max(np.abs(mixed)))
    return mixed / peak * 0.95 if peak > 0.95 else mixed


def build(out_dir, synth_fn, *, sr=DEFAULT_SR, script=SCRIPT, lead_sec=LEAD_SEC):
    """대사 음원과 **참값**을 만든다.

    synth_fn(text, sr) -> 1차원 실수 배열(그 줄의 소리). 밖에서 넣는다 —
    모델 없이도 검사할 수 있게 하려는 것이다.

    돌려주는 것: {'audio': 배열, 'sr':, 'lines': [{'index','text','start','end'}...]}
    ★'start' 는 **우리가 놓은 자리**다. 앞 정적을 걷어낸 뒤 놓으므로 곧 말이 시작하는 자리다.
    """
    import numpy as np
    clips = []
    for text, _gap in script:
        y = synth_fn(text, sr)
        y = trim_silence(np.asarray(y, dtype=np.float64), sr)
        if not y.size:
            raise BenchError('합성 결과가 비었습니다: %r' % (text[:12],))
        clips.append(y)

    at = float(lead_sec)
    starts = []
    for (text, gap), y in zip(script, clips):
        at += float(gap)
        starts.append(at)
        at += len(y) / float(sr)
    total = int(round((at + lead_sec) * sr))

    bed = np.zeros(total, dtype=np.float64)
    lines = []
    for i, ((text, _gap), y, s) in enumerate(zip(script, clips, starts)):
        a = int(round(s * sr))
        bed[a:a + len(y)] += y
        lines.append({'index': i, 'text': text,
                      'start': round(s, 4), 'end': round(s + len(y) / sr, 4)})

    peak = float(np.max(np.abs(bed)))
    if peak > 0.95:
        bed = bed / peak * 0.95
    return {'audio': bed, 'sr': sr, 'lines': lines}


def write(out_dir, made, *, snr_db=None, seed=7):
    """만든 것을 파일로. 배경음을 섞으려면 snr_db 를 준다.

    돌려주는 것: {'audio_path':, 'truth_path':, 'snr_db':}
    """
    import numpy as np
    import soundfile as sf
    os.makedirs(out_dir, exist_ok=True)
    y = np.asarray(made['audio'], dtype=np.float64)
    name = 'speech'
    if snr_db is not None:
        y = mix_at_snr(y, noise_bed(len(y), made['sr'], seed=seed), float(snr_db))
        name = 'mixed_snr%d' % int(round(snr_db))
    ap = os.path.join(out_dir, name + '.wav')
    sf.write(ap, y.astype('float32'), made['sr'])
    tp = os.path.join(out_dir, 'truth.json')
    with open(tp, 'w', encoding='utf-8') as f:
        json.dump({'sr': made['sr'], 'lines': made['lines']}, f,
                  ensure_ascii=False, indent=2)
    return {'audio_path': ap, 'truth_path': tp, 'snr_db': snr_db}


def kokoro_synth(text, sr=DEFAULT_SR, _cache={}):
    """실제 합성기 — Kokoro. **참조 목소리가 필요 없어 사용자 재료를 쓰지 않는다.**

    ★ComfyUI 쪽 경로 오염을 걷어낸다(맨 import 가 엉뚱한 곳으로 가는 함정).
    ★Kokoro 는 앱 환경에서 그냥 터진다 — kokoro_compat 이 그 자리를 메운다.
    """
    import sys
    if not _cache:
        sys.path[:] = [q for q in sys.path
                       if "custom_nodes" not in q.replace(chr(92), "/")]
        # ★임베디드 파이썬(._pth)은 스크립트 폴더를 경로에 넣지 않는다 — 직접 넣는다.
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import kokoro_compat
        kokoro_compat.ensure(strict=True)
        from kokoro import KPipeline
        _cache["p"] = KPipeline(lang_code=KOKORO_LANG)
        _cache["voice"] = kokoro_compat.default_voice(KOKORO_LANG)
    import numpy as np
    parts = [a for _, _, a in _cache["p"](text, voice=_cache["voice"], speed=1.0)]
    if not parts:
        raise BenchError("합성이 아무것도 내놓지 않았습니다")
    y = np.concatenate([np.asarray(a, dtype=np.float64).reshape(-1) for a in parts])
    if sr != KOKORO_SR:
        import librosa
        y = librosa.resample(y, orig_sr=KOKORO_SR, target_sr=sr)
    return y


def main():
    import argparse
    ap = argparse.ArgumentParser(description='대사 계측대를 만든다(사용자 재료 미사용)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--snr', type=float, default=None,
                    help='배경음을 섞을 크기 차이(dB). 주지 않으면 말만 낸다')
    args = ap.parse_args()
    made = build(args.out, kokoro_synth)
    info = write(args.out, made, snr_db=args.snr)
    print('줄 %d개 · 길이 %.1f초' % (len(made['lines']),
                                     len(made['audio']) / made['sr']))
    print('소리   %s' % info['audio_path'])
    print('참값   %s' % info['truth_path'])


if __name__ == '__main__':
    main()
