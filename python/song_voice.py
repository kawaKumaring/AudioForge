# -*- coding: utf-8 -*-
"""노래 목소리 바꾸기 — **변환 한 단계만** 맡는 부품.

따라부르기 사슬은 이렇다:

    소리 꺼내기 → 반주/보컬 분리 → 주보컬/화음 분리 → **주보컬만 변환** → 합치기

이 파일은 그중 **굵게 표시한 한 칸**만 한다. 분리도 합치기도 하지 않는다.

★왜 한 칸만 떼어 놓았나 (2026-09-26 사용자 결정)
  "따라부르기를 앱에 들인다. 나중에 더 좋은 모델이 생기면 제거하면 된다."
  갈아 끼울 것을 알고 만드는 것이므로 **경계를 두껍게** 둔다.
  사슬의 나머지는 변환기가 무엇인지 몰라야 하고, 모델을 바꿀 때
  **이 파일 하나만** 손대면 되어야 한다.

  그래서 이 파일 밖에서는 변환기의 이름도, 인자도, 파이썬 경로도 알지 못한다.

★왜 바깥 파이썬을 부르나
  변환기는 앱 파이썬과 **판이 맞지 않는다**(의존 꾸러미가 서로 어긋난다).
  같은 프로세스에 올릴 수 없어 별도 해석기를 불러 쓴다.
  앱이 이미 바깥 파이썬을 가리켜 쓰는 방식과 같은 꼴이며, 새 방식이 아니다.

★경로를 코드에 박지 않는다
  `audio.ipc.ts` 가 적어 둔 원칙을 그대로 따른다 —
  **"연결은 '추측' 이 아니라 '기록' 이어야 한다."**
  특정 PC 의 절대경로를 코드에 두면 그 PC 에서만 맞고, 다른 데서는 조용히 틀린다.
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, 'externals', 'env.json')

# 기록을 찾는 순서. 환경변수가 먼저인 것은 검사·일회성 실행에서 갈아 끼우기 위해서다.
PYTHON_ENV = 'AUDIOFORGE_SINGING_PYTHON'
SCRIPT_ENV = 'AUDIOFORGE_SINGING_SCRIPT'
PYTHON_KEY = 'singing_python'
SCRIPT_KEY = 'singing_script'

# ★청취로 정해진 값이다. 새로 고르지 않는다(2026-09-20, 네 곡).
#   · steps 40   - 100 보다 40 이 자연스러웠다.
#   · f0 조건화  - 원곡의 음높이를 따라간다. **가락이 남는 이유가 이것이다.**
#   · 자동 조옮김 끔 - 곡의 조를 임의로 옮기지 않는다.
DIFFUSION_STEPS = 40
F0_CONDITION = True
AUTO_F0_ADJUST = False


class SongVoiceError(RuntimeError):
    """변환을 할 수 없는 상태. 사유와 **고치는 방법**을 문구에 담는다."""


def _recorded(env_name, key):
    """환경변수 → externals/env.json 순서로 기록을 찾는다. 없으면 빈 문자열."""
    v = os.environ.get(env_name, '')
    if v:
        return v
    try:
        with open(ENV_FILE, encoding='utf-8') as f:
            return json.load(f).get(key, '') or ''
    except (OSError, ValueError):
        return ''


def converter():
    """변환기 연결 정보. 기록이 없거나 파일이 없으면 **사유를 들고** 실패한다."""
    py = _recorded(PYTHON_ENV, PYTHON_KEY)
    sc = _recorded(SCRIPT_ENV, SCRIPT_KEY)
    missing = []
    if not py:
        missing.append('해석기(%s 또는 env.json 의 "%s")' % (PYTHON_ENV, PYTHON_KEY))
    if not sc:
        missing.append('변환 스크립트(%s 또는 env.json 의 "%s")' % (SCRIPT_ENV, SCRIPT_KEY))
    if missing:
        raise SongVoiceError(
            '노래 목소리 변환기가 연결되어 있지 않습니다 — ' + ' · '.join(missing) +
            ' 를 기록하세요.')
    for what, p in (('해석기', py), ('변환 스크립트', sc)):
        if not os.path.isfile(p):
            # ★경로를 통째로 싣지 않는다 — 기록에 남는 문구다(폴더는 개인정보다).
            raise SongVoiceError(
                '기록된 %s 를 찾지 못했습니다: %s — 연결을 다시 기록하세요.'
                % (what, os.path.basename(p)))
    return {'python': py, 'script': sc}


def convert_args(source, reference, out_dir, *, conv=None):
    """실제로 던질 명령줄. **검사가 눈으로 볼 수 있게** 따로 뺀다."""
    c = conv or converter()
    return [c['python'], '-X', 'utf8', c['script'],
            '--source', source, '--target', reference, '--output', out_dir,
            '--diffusion-steps', str(DIFFUSION_STEPS),
            '--f0-condition', str(F0_CONDITION),
            '--auto-f0-adjust', str(AUTO_F0_ADJUST)]


def convert_vocal(source, reference, out_dir, *, run=subprocess.run, conv=None,
                  log=None):
    """주보컬 하나를 참조 목소리로 바꾼다. 만들어진 파일 경로를 돌려준다.

    source    - 바꿀 주보컬(화음이 섞이지 않은 것). **이 조건은 부르는 쪽이 지킨다.**
    reference - 목표 목소리 파일.
    out_dir   - 결과가 놓일 폴더.

    ★실패를 조용히 넘기지 않는다. 변환기가 멈추면 사유를 들고 올라간다 —
      이 저장소가 반복해서 데인 자리다.
    """
    if not os.path.isfile(source):
        raise SongVoiceError('바꿀 목소리 파일이 없습니다: %s' % os.path.basename(source))
    if not os.path.isfile(reference):
        raise SongVoiceError('참조 목소리 파일이 없습니다: %s' % os.path.basename(reference))
    os.makedirs(out_dir, exist_ok=True)
    before = set(os.listdir(out_dir))

    args = convert_args(source, reference, out_dir, conv=conv)
    if log:
        log('노래 목소리 변환 시작 — %s' % os.path.basename(source))
    r = run(args, capture_output=True)
    if getattr(r, 'returncode', 1) != 0:
        tail = (getattr(r, 'stderr', b'') or b'')
        if isinstance(tail, bytes):
            tail = tail.decode('utf-8', 'replace')
        raise SongVoiceError('목소리 변환이 실패했습니다 — %s' % tail.strip()[-300:])

    made = [n for n in os.listdir(out_dir) if n not in before and n.lower().endswith('.wav')]
    if not made:
        # ★끝났다고 말하는데 결과가 없는 경우. 조용히 성공으로 넘기면 다음 칸이 빈손을 받는다.
        raise SongVoiceError('변환기가 끝났다고 했지만 만들어진 소리가 없습니다.')
    made.sort()
    out = os.path.join(out_dir, made[-1])
    if log:
        log('노래 목소리 변환 끝남 — %s' % made[-1])
    return out
