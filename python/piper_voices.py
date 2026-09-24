# -*- coding: utf-8 -*-
"""내려받아 둔 **piper 목소리**를 찾는다.

왜 들였나(2026-09-24)
  한국어에는 **참조 목소리 없이 그냥 읽어 주는 엔진이 하나도 없었다.**
  Qwen3-TTS 도 GPT-SoVITS 도 참조 소리를 요구하고, 그 둘이 안 될 때 떨어질 자리인
  Kokoro 는 **모델에 한국어가 아예 없다**(언어를 등록해도 한국어 목소리가 없어
  엉뚱한 소리만 난다 — 코드로 확인했다).

  그래서 그 빈자리를 piper 로 메운다.
    · 완전히 이 컴퓨터 안에서 돈다(내려받은 뒤에는 인터넷이 필요 없다)
    · 참조 목소리가 필요 없다 — 목소리가 파일 안에 들어 있다
    · ONNX 라 **torch 를 건드리지 않는다**(합성 환경을 흔들 걱정이 없다)

무엇이 어디에 있나
  `externals/piper_voices/<아무 이름>/*.onnx` 와 같은 이름의 `*.onnx.json`.
  폴더 구조는 자유다 — **언어는 이름이 아니라 설정 파일에서 읽는다.**
  (내려받으면 `ko/ko_KR/kss/medium/...` 처럼 깊게 들어오기도 한다.)

이 파일은 **찾기만** 한다. 소리를 만들지 않고 모델을 열지도 않는다.
"""
import json
import os

# 여기 아래를 뒤진다. 환경변수로 바꿀 수 있다(검사·다른 설치 자리 대비).
VOICES_DIRNAME = 'piper_voices'
VOICES_ENV = 'AUDIOFORGE_PIPER_VOICES'


class PiperVoiceError(RuntimeError):
    """목소리를 찾을 수 없다. 사유를 문구로 담는다."""


def voices_root(repo_root=None):
    """목소리를 둔 자리. 없을 수도 있다 — 있는지는 부르는 쪽이 본다."""
    env = os.environ.get(VOICES_ENV)
    if env:
        return env
    if repo_root is None:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(repo_root, 'externals', VOICES_DIRNAME)


def _read_config(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def scan(root=None, repo_root=None):
    """있는 목소리를 전부 모은다. 못 읽는 것은 **조용히 건너뛴다**(목록이지 판정이 아니다).

    돌려주는 것: [{'name','lang','onnx','config','sample_rate'}, ...] 이름 순.
    """
    root = root or voices_root(repo_root)
    found = []
    if not os.path.isdir(root):
        return found
    for base, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith('.onnx'):
                continue
            onnx = os.path.join(base, fn)
            cfg_path = onnx + '.json'
            if not os.path.isfile(cfg_path):
                continue
            cfg = _read_config(cfg_path)
            if not cfg:
                continue
            lang = ((cfg.get('language') or {}).get('family')
                    or (cfg.get('language') or {}).get('code') or '')
            found.append({
                'name': fn[:-len('.onnx')],
                'lang': str(lang).split('_')[0].lower(),
                'onnx': onnx,
                'config': cfg_path,
                'sample_rate': int((cfg.get('audio') or {}).get('sample_rate') or 0),
            })
    found.sort(key=lambda v: v['name'])
    return found


def find(lang, root=None, repo_root=None):
    """그 언어의 목소리 하나. 없으면 None.

    여럿이면 **이름 순 첫 번째**를 고른다 — 같은 입력에 늘 같은 것이 나와야 한다.
    """
    want = (lang or '').split('-')[0].split('_')[0].lower()
    for v in scan(root, repo_root):
        if v['lang'] == want:
            return v
    return None


def check_language(lang, root=None, repo_root=None):
    """쓸 수 있으면 "" 를, 아니면 **사람이 읽을 수 있는 사유**를 돌려준다.

    ★Kokoro 에서 배운 것을 그대로 옮긴다 — 지원한다고 적어 두기만 하고
      실제로 되는지 보지 않으면, 구하러 온 사다리가 썩어 있어도 모른다.
    """
    root = root or voices_root(repo_root)
    if not os.path.isdir(root):
        return '내려받아 둔 piper 목소리가 없습니다(%s)' % root
    if find(lang, root, repo_root) is None:
        have = sorted(set(v['lang'] for v in scan(root, repo_root)))
        return ('piper 에 %s 목소리가 없습니다. 지금 있는 것: %s'
                % (lang, ', '.join(have) if have else '없음'))
    return ''
