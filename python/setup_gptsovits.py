#!/usr/bin/env python3
"""GPT-SoVITS(한국어 TTS) 셋업 스크립트 — 재현용.

externals/gptsovits_venv와 pretrained_models는 gitignore 대상(수 GB)이라
버전 관리에서 빠진다. 이 스크립트가 새 환경에서 셋업을 재현한다:

  1. python-mecab-ko 설치 (프리빌트 휠 — MSVC 빌드 불필요)
  2. jieba_fast → jieba shim 생성 (중국어 프론트엔드용, C 빌드 회피)
  3. eunjeon → python-mecab-ko shim 생성 (한국어 g2p용, MSVC 빌드 회피)
  4. v2 사전학습 모델 다운로드 (~1GB, HuggingFace lj1995/GPT-SoVITS)

전제: externals/gptsovits_venv (torch/transformers/g2pk2 등 설치됨),
      externals/GPT-SoVITS (repo clone).

사용법:
  python setup_gptsovits.py            # 전체
  python setup_gptsovits.py --no-models  # shim/패키지만 (모델 다운로드 생략)
"""

import argparse
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = os.path.join(BASE, "externals", "gptsovits_venv", "Scripts", "python.exe")
SOVITS = os.path.join(BASE, "externals", "GPT-SoVITS")
SITE = os.path.join(BASE, "externals", "gptsovits_venv", "Lib", "site-packages")

JIEBA_FAST_INIT = '''\
"""jieba_fast shim -> jieba (C 확장 빌드 회피). setup_gptsovits.py가 생성."""
import jieba as _jieba
from jieba import *  # noqa: F401,F403
setLogLevel = _jieba.setLogLevel
cut = _jieba.cut
lcut = _jieba.lcut
load_userdict = _jieba.load_userdict
Tokenizer = _jieba.Tokenizer
dt = _jieba.dt
'''

JIEBA_FAST_POSSEG = '''\
"""jieba_fast.posseg shim -> jieba.posseg."""
from jieba.posseg import *  # noqa: F401,F403
import jieba.posseg as _posseg
cut = _posseg.cut
lcut = _posseg.lcut
POSTokenizer = _posseg.POSTokenizer
dt = _posseg.dt
'''

EUNJEON_INIT = '''\
"""eunjeon shim -> python-mecab-ko (MSVC 빌드 회피). setup_gptsovits.py가 생성.
g2pk2가 쓰는 건 mecab.pos(text) -> [(surface, tag), ...] 뿐."""
from mecab import MeCab as _MeCab


class Mecab:
    def __init__(self, dicpath=None, *args, **kwargs):
        self._m = _MeCab()

    def pos(self, text, *args, **kwargs):
        return self._m.pos(text)

    def morphs(self, text, *args, **kwargs):
        return self._m.morphs(text)

    def nouns(self, text, *args, **kwargs):
        return self._m.nouns(text)
'''


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  생성: {os.path.relpath(path, BASE)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-models", action="store_true", help="모델 다운로드 생략")
    args = ap.parse_args()

    if not os.path.exists(VENV_PY):
        print(f"[오류] venv Python 없음: {VENV_PY}")
        return 1
    if not os.path.isdir(SOVITS):
        print(f"[오류] GPT-SoVITS repo 없음: {SOVITS}")
        return 1

    print("1. python-mecab-ko 설치 (프리빌트 휠)...")
    r = subprocess.run([VENV_PY, "-m", "pip", "install", "--only-binary", ":all:",
                        "python-mecab-ko"])
    if r.returncode != 0:
        print("[오류] python-mecab-ko 설치 실패")
        return 1

    print("2. jieba_fast shim 생성...")
    _write(os.path.join(SITE, "jieba_fast", "__init__.py"), JIEBA_FAST_INIT)
    _write(os.path.join(SITE, "jieba_fast", "posseg.py"), JIEBA_FAST_POSSEG)

    print("3. eunjeon shim 생성...")
    _write(os.path.join(SITE, "eunjeon", "__init__.py"), EUNJEON_INIT)

    if args.no_models:
        print("모델 다운로드 생략 (--no-models). shim/패키지 셋업 완료.")
        return 0

    print("4. v2 사전학습 모델 다운로드 (~1GB)...")
    dl = (
        "from huggingface_hub import snapshot_download;"
        "snapshot_download(repo_id='lj1995/GPT-SoVITS',"
        "local_dir='GPT_SoVITS/pretrained_models',"
        "allow_patterns=['chinese-roberta-wwm-ext-large/*','chinese-hubert-base/*',"
        "'gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt',"
        "'gsv-v2final-pretrained/s2G2333k.pth'])"
    )
    env = dict(os.environ, HF_HUB_DISABLE_SYMLINKS_WARNING="1")
    r = subprocess.run([VENV_PY, "-X", "utf8", "-c", dl], cwd=SOVITS, env=env)
    if r.returncode != 0:
        print("[오류] 모델 다운로드 실패")
        return 1

    print("5. fast_langdetect 모델 다운로드 (일본어/중국어 언어 구분용, ~131MB)...")
    # 일본어/중국어 텍스트는 GPT-SoVITS의 LangSegmenter가 fast_langdetect로
    # ja/zh를 구분한다. lid.176.bin이 없으면 일본어/중국어 합성이 크래시.
    # (한국어/영어는 이 모델 불필요)
    cache = os.path.join(SOVITS, "GPT_SoVITS", "pretrained_models", "fast_langdetect")
    os.makedirs(cache, exist_ok=True)
    dst = os.path.join(cache, "lid.176.bin")
    if os.path.exists(dst) and os.path.getsize(dst) > 1e8:
        print("  이미 존재.")
    else:
        dl2 = (
            "import urllib.request;"
            "urllib.request.urlretrieve("
            "'https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin',"
            f"r'{dst}')"
        )
        r = subprocess.run([VENV_PY, "-X", "utf8", "-c", dl2])
        if r.returncode != 0:
            print("  [경고] fast_langdetect 다운로드 실패 — 한국어/영어는 정상, 일본어/중국어만 영향")

    print("\n완료. python smoke_test.py --tts <참조음성.wav> 로 검증하세요.")
    print("참고: 일본어 출력/참조는 pyopenjtalk 필요 (프리빌트 휠 없음 → VS Build Tools 빌드).")
    print("      한국어/영어/중국어 출력은 빌드 없이 동작.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
