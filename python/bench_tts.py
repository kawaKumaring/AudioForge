# -*- coding: utf-8 -*-
"""합성 속도 실측 — **사용자 미디어를 쓰지 않는다.**

★왜 이 벤치가 필요한가(2026-09-25)
  실사용 로그에 완료된 합성이 5건뿐이라(중앙 71초) 개선 항목을 고를 수 없었다.
  그리고 고친 뒤 "나아졌다" 를 말하려면 **같은 조건에서 두 번 잴 수 있어야** 한다.

★참조 음성을 어디서 얻나
  사용자 음원은 쓰지 않는다. 앱이 들고 있는 한국어 엔진(piper)은 **참조가 필요 없어**
  대본만으로 소리를 만든다. 그것을 Qwen 의 참조로 쓴다.
  같은 대본·같은 엔진이면 매번 같은 참조가 나오므로 조건이 고정된다.
  `bench_dialogue.py` 가 이미 쓴 방식(합성한 소리로 실측)과 같은 길이다.

★찬 실행과 더운 실행을 나눠 잰다
  저장소에 남은 기록 2건에서 첫 실행만 유난히 느렸다(생성 밖 47초 vs 12초).
  한 번만 재면 그 차이가 결과에 섞인다. **연속 2회**를 한 묶음으로 본다.

쓰는 법:
    python bench_tts.py --out <폴더> [--repeat 2] [--seed 12345] [--label 기준선]

남기는 것: 단계별 소요와 결과 음성의 해시. **대사 본문·절대 경로는 적지 않는다.**
"""
import argparse
import glob
import hashlib
import io
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# 재는 재료. 길이를 달리해 **조각 수에 따른 변화**를 볼 수 있게 한다.
SCRIPTS = {
    'short': '안녕하세요. 오늘 날씨가 참 좋네요.',
    'long': (
        '안녕하세요. 오늘은 새로 만든 기능을 소개하려고 합니다. '
        '먼저 소리를 불러오고, 목소리를 고른 다음, 대본을 넣으면 됩니다. '
        '만드는 동안 진행 상황이 보이고, 언제든 멈출 수 있습니다. '
        '다 만들면 결과를 들어 보고 마음에 드는 것만 골라 내보내면 됩니다.'
    ),
    # ★조각이 여러 개로 갈리는 재료(2026-09-25). 안전 생산 토큰이 190 이라
    #   앞의 둘은 한 조각으로 끝났고, 그래서 '조각마다 반복되는 준비' 항목이
    #   측정에 드러나지 않았다. 조각 수에 비례하는 비용을 보려면 이것이 필요하다.
    'multi': (
        '안녕하세요. 오늘은 새로 만든 기능을 소개하려고 합니다. '
        '먼저 소리를 불러오고, 목소리를 고른 다음, 대본을 넣으면 됩니다. '
        '만드는 동안 진행 상황이 보이고, 언제든 멈출 수 있습니다. '
        '다 만들면 결과를 들어 보고 마음에 드는 것만 골라 내보내면 됩니다. '
        '설정은 작업마다 따로 기억하므로 다음에 열었을 때 같은 자리에서 이어 할 수 있습니다. '
        '문장이 길면 알아서 나누어 만들고, 나눈 자리를 자연스럽게 이어 붙입니다. '
        '만든 소리가 마음에 들지 않으면 그 문장만 다시 만들 수도 있습니다. '
        '여러 사람이 말하는 대본이라면 사람마다 다른 목소리를 지정할 수 있습니다. '
        '작업이 끝나면 어디에 무엇을 저장했는지 화면에 알려 드립니다. '
        '궁금한 점이 있으면 설정 화면 아래쪽의 도움말을 살펴보시기 바랍니다.'
    ),
}

# 참조로 쓸 소리의 대본. Qwen 은 참조의 **글자도** 함께 받으므로 같이 돌려준다.
REF_TEXT = '이것은 목소리를 흉내 내기 위한 참조 소리입니다.'


def app_python():
    """앱이 쓰는 파이썬. 검사에서 쓰는 것과 갈라지면 결과가 달라진다."""
    cfg = os.path.join(ROOT, 'externals', 'env.json')
    try:
        with io.open(cfg, encoding='utf-8') as f:
            p = (json.load(f) or {}).get('python')
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    return sys.executable


def make_reference(out_dir):
    """참조 음성을 **만든다**. 사용자 파일을 열지 않는다."""
    import piper_voices
    dest = os.path.join(out_dir, 'bench-reference.wav')
    if os.path.isfile(dest):
        return dest
    why = piper_voices.check_language('ko')
    if why:
        raise SystemExit('한국어 엔진으로 참조를 만들 수 없습니다 — %s' % why)
    meta = piper_voices.find('ko')
    from piper import PiperVoice
    voice = PiperVoice.load(meta['onnx'], config_path=meta['config'])
    import wave
    with wave.open(dest, 'wb') as w:
        voice.synthesize_wav(REF_TEXT, w)
    return dest


def _no_paths(text):
    """경로의 **폴더 부분만** 지운다 — 파일 이름은 남긴다.

    ★왜 여기 또 있나(2026-09-25 3차 감사)
      이 벤치가 남기는 기록에 `stderr_tail` 로 **절대 경로가 그대로** 들어가고 있었다.
      파이썬 오류에는 사용자 입력 파일 경로도 실릴 수 있다.
      그리고 내가 넣은 "본문을 기록에 넣지 않는다" 검사는 **그 칸을 보지 않았다.**

      같은 규칙이 `src/main/services/log-scrub.ts` 에 있지만 그것은 TypeScript 라
      파이썬에서 부를 수 없다. 규칙이 짧아 여기 다시 적되, **같은 말을 한다**는 것을
      검사로 묶어 둔다(둘이 갈라지면 한쪽만 고치는 사고가 난다).
    """
    import re
    B = chr(92)                      # 역슬래시 한 글자
    if not text:
        return text
    out = str(text)
    seg = "[^" + B + B + "/:" + B + "s'" + chr(34) + "<>|*?]+"
    for pat in (
        r"[A-Za-z]:[" + B + B + "/](?:" + seg + "[" + B + B + "/])*(" + seg + ")",
        r"[" + B + B + "]{2}(?:" + seg + "[" + B + B + "/])+(" + seg + ")",
        r"/(?:" + seg + "/)+(" + seg + ")",
    ):
        for _ in range(4):
            nxt = re.sub(pat, r"\1", out)
            if nxt == out:
                break
            out = nxt
    return out


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def _newest_manifests(since):
    """이 실행이 남긴 기록 파일. 시작 시각 뒤에 만들어진 것만 본다."""
    try:
        import local_assets
        runs = os.path.join(local_assets.local_root(), 'artifacts', 'runs')
    except Exception:
        return []
    out = []
    try:
        for name in os.listdir(runs):
            mf = os.path.join(runs, name, 'manifest.json')
            if os.path.isfile(mf):
                out.append((os.path.getmtime(mf), mf))
    except Exception:
        return []
    out.sort()
    return [mf for _t, mf in out[-1:]]


def run_once(py, ref_wav, text, work, seed):
    """앱과 **같은 통로**로 한 번 돌린다(separate.py --config)."""
    os.makedirs(work, exist_ok=True)
    cfg = {
        'mode': 'tts',
        'input': ref_wav,
        'output': work,
        'ttsText': text,
        'ttsEngine': 'qwen3',
        'ttsReferenceOverride': ref_wav,
        'ttsReferencePrompts': {
            'default': {'manualText': REF_TEXT, 'promptLang': 'ko', 'mode': 'manual'},
        },
    }
    cfg_path = os.path.join(work, 'config.json')
    with io.open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)

    env = dict(os.environ)
    env['AUDIOFORGE_TTS_SEED'] = str(seed)
    env['PYTHONIOENCODING'] = 'utf-8'
    t0 = time.monotonic()
    proc = subprocess.run(
        [py, '-X', 'utf8', os.path.join(HERE, 'separate.py'), '--config', cfg_path],
        capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    wall = round(time.monotonic() - t0, 2)

    stages, result, err = {}, None, None
    for line in (proc.stdout or '').splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get('type') == 'result':
            result = m
        elif m.get('type') == 'error':
            err = m.get('message')
    # 기록 파일에서 단계별 소요를 읽는다(본문·경로는 읽지 않는다).
    # ★실행 기록은 작업 폴더가 아니라 앱이 정한 자리에 쌓인다 — 거기서 **가장 새 것**을 본다.
    for mf in _newest_manifests(t0):
        try:
            with io.open(mf, encoding='utf-8') as f:
                man = json.load(f)
        except Exception:
            continue
        for row in (man.get('stage_elapsed') or []):
            stages[row.get('stage')] = row.get('elapsed_sec')
        gen = [c.get('elapsed_sec') for c in (man.get('chunks') or [])
               if isinstance(c.get('elapsed_sec'), (int, float))]
        if gen:
            stages['generate_sum'] = round(sum(gen), 3)
            stages['chunks'] = len(gen)
    out_wav = None
    if result:
        for k in ('output_path', 'path'):
            if isinstance(result.get(k), str) and os.path.isfile(result[k]):
                out_wav = result[k]
                break
    if out_wav is None:
        cands = sorted(glob.glob(os.path.join(work, '**', '*.wav'), recursive=True),
                       key=os.path.getmtime)
        cands = [c for c in cands if os.path.basename(c) != os.path.basename(ref_wav)]
        out_wav = cands[-1] if cands else None
    return {
        'wall_sec': wall,
        'exit': proc.returncode,
        'error': _no_paths(err),
        'stages': stages,
        'out_sha256': sha(out_wav) if out_wav else None,
        'out_name': os.path.basename(out_wav) if out_wav else None,
        # ★폴더를 지우고 적는다. 여기 오는 것은 우리가 쓴 문장이 아니라 파이썬 오류다.
        'stderr_tail': [_no_paths(l) for l in (proc.stderr or '').strip().splitlines()[-3:]],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='결과를 남길 폴더')
    ap.add_argument('--repeat', type=int, default=2, help='대본마다 연속 몇 회(찬/더운 구분)')
    ap.add_argument('--seed', type=int, default=12345)
    ap.add_argument('--label', default='')
    ap.add_argument('--only', default='', help='한 대본만 (short|long)')
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    ref = make_reference(a.out)
    print('참조 소리 준비됨 (%d 바이트)' % os.path.getsize(ref), flush=True)

    py = app_python()
    rows = []
    names = [a.only] if a.only else list(SCRIPTS)
    for name in names:
        for i in range(a.repeat):
            work = os.path.join(a.out, 'run-%s-%d' % (name, i + 1))
            print('--- %s %d/%d 돌리는 중…' % (name, i + 1, a.repeat), flush=True)
            r = run_once(py, ref, SCRIPTS[name], work, a.seed)
            r['script'] = name
            r['attempt'] = i + 1
            r['cold'] = (i == 0)
            rows.append(r)
            print('    벽시계 %.2f초 | 단계 %s | 나감 %s'
                  % (r['wall_sec'], r['stages'], r['exit']), flush=True)
            if r['error']:
                print('    오류:', r['error'], flush=True)

    out = {'label': a.label, 'seed': a.seed, 'rows': rows}
    dest = os.path.join(a.out, 'bench-%s.json' % (a.label or 'run'))
    with io.open(dest, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('기록:', os.path.basename(dest))


if __name__ == '__main__':
    main()
