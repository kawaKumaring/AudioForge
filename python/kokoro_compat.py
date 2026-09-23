# -*- coding: utf-8 -*-
"""Kokoro 를 불러올 수 있게 하는 **최소한의 덧대기.**

무엇이 깨져 있었나(2026-09-24 실측)
  앱 파이썬에서 `from kokoro import KPipeline` 이 **그냥 터진다.**
    1) `misaki` 가 `EspeakWrapper.set_data_path(...)` 를 부르는데
       설치된 phonemizer 3.3.0 에는 **그 함수가 없다**(AttributeError).
    2) 그걸 넘겨도 espeak 라이브러리가 자기 데이터 경로를 **만든 기계의 경로**
       (`D:/a/espeakng-loader/...`)로 들고 있어 `phontab` 을 못 찾는다.

  즉 **Kokoro 엔진은 지금 제품에서도 못 쓴다.** 계측대를 만들다 드러났다.

무엇을 하나
  · espeak 데이터 경로를 `espeakng_loader` 가 실제로 깔아 둔 자리로 환경변수에 알린다
  · 없어진 `set_data_path` 자리를 비어 있는 함수로 메운다(경로는 위에서 이미 알렸다)
  · 라이브러리 파일 자리도 loader 가 준 것으로 지정한다

★이 프로세스 안에서만 바뀐다. site-packages 파일을 고치지 않는다.
★`from kokoro import ...` **앞에** 불러야 한다.
★없어진 함수가 이미 있으면(판이 올라가면) 아무것도 하지 않는다 — 조용히 덮어쓰지 않는다.
"""
import os

_done = False


def ensure(strict=False):
    """Kokoro 를 부르기 전에 한 번. 돌려주는 것: 무엇을 했는지 문구(아무것도 안 했으면 '').

    strict=True 면 덧댈 수 없을 때 예외를 낸다. 기본은 조용히 넘어간다 —
    덧대기가 필요 없는 환경(정상 설치)에서 막지 않기 위해서다.
    """
    global _done
    if _done:
        return ''
    notes = []
    try:
        import espeakng_loader
    except Exception as e:
        if strict:
            raise RuntimeError('espeakng_loader 가 없습니다: %s' % e)
        return ''

    try:
        data = str(espeakng_loader.get_data_path())
        # espeak-ng 는 **데이터 폴더의 부모**를 본다(그 아래 espeak-ng-data 를 찾는다).
        parent = os.path.dirname(data)
        if parent and os.path.isdir(data):
            os.environ.setdefault('ESPEAK_DATA_PATH', parent)
            notes.append('데이터 경로 지정')
    except Exception as e:
        if strict:
            raise RuntimeError('espeak 데이터 경로를 정하지 못했습니다: %s' % e)

    try:
        from phonemizer.backend.espeak.wrapper import EspeakWrapper as W
    except Exception as e:
        if strict:
            raise RuntimeError('phonemizer 를 불러오지 못했습니다: %s' % e)
        _done = True
        return ' · '.join(notes)

    try:
        W.set_library(espeakng_loader.get_library_path())
        notes.append('라이브러리 지정')
    except Exception:
        pass                      # 이미 잘 잡혀 있으면 그대로 둔다

    if not hasattr(W, 'set_data_path'):
        # misaki 가 부르는 자리만 메운다. 경로는 위에서 환경변수로 이미 알렸다.
        W.set_data_path = classmethod(lambda cls, path: None)
        notes.append('없어진 set_data_path 메움')

    _done = True
    return ' · '.join(notes)

# ── 어떤 언어가 **실제로** 되는가 ─────────────────────────────────────────
#
# ★2026-09-24 실측: 우리 엔진이 "ko·ja·zh·en 을 지원한다" 고 적어 두었는데
#   **넷 중 셋이 사실이 아니었다.**
#     ko → 설치된 Kokoro 언어표에 **아예 없다**(a,b,e,f,h,i,p,j,z)
#     ja → pyopenjtalk 이 없어 터진다
#     zh → ordered_set 이 없어 터진다
#     en → 된다
#   한국어·일본어는 GPT-SoVITS 가 실패했을 때 **떨어질 자리**였고,
#   중국어는 **Kokoro 가 유일한 길**이었다. 즉 구하러 온 사다리가 썩어 있었다.
#   터지는 모양도 나빴다 — AssertionError / ModuleNotFoundError 라
#   무엇이 없는지 사람이 읽을 수 없다.

# 우리 언어 이름 → Kokoro 언어 글자
LANG_MAP = {"ko": "k", "ja": "j", "zh": "z", "en": "a"}
# 그 언어를 쓰려면 더 있어야 하는 부품
LANG_EXTRAS = {"j": ("pyopenjtalk",), "z": ("ordered_set",), "a": (), "k": ()}


def _installed_codes():
    from kokoro.pipeline import LANG_CODES
    return set(LANG_CODES)


def _has_module(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def available_languages(codes=None, has_module=None):
    """언어마다 (되는가, 사유). 조사하는 두 가지를 밖에서 넣을 수 있다(검사용).

    돌려주는 것: {"ko": (False, "..."), "en": (True, ""), ...}
    """
    if codes is None:
        try:
            codes = _installed_codes()
        except Exception as e:
            return dict((k, (False, "Kokoro 를 불러오지 못했습니다: %s" % e))
                        for k in LANG_MAP)
    if has_module is None:
        has_module = _has_module
    out = {}
    for lang, code in LANG_MAP.items():
        if code not in codes:
            out[lang] = (False, "설치된 Kokoro 가 이 언어를 담고 있지 않습니다")
            continue
        missing = [m for m in LANG_EXTRAS.get(code, ()) if not has_module(m)]
        if missing:
            out[lang] = (False, "이 언어에 필요한 %s 가 설치돼 있지 않습니다"
                                % ", ".join(missing))
            continue
        out[lang] = (True, "")
    return out


def check_language(lang, codes=None, has_module=None):
    """되면 "" 를, 안 되면 **사람이 읽을 수 있는 사유**를 돌려준다."""
    if lang not in LANG_MAP:
        return "Kokoro 가 다루지 않는 언어입니다: %s" % lang
    ok, why = available_languages(codes, has_module)[lang]
    return "" if ok else why
