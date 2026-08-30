# -*- coding: utf-8 -*-
"""테스트가 앱 관리 영역(`_local`)에 기록을 쌓지 않게 격리한다.

TTS 합성은 이제 **모든 실행에서** run bundle 을 남긴다(진단 스위치와 무관). 그래서 합성 경로를
도는 테스트는 아무 조치가 없으면 실제 `_local/artifacts/runs/` 에 번들을 만든다. 제품 동작으로는
옳지만 테스트가 사용자 폴더를 건드리는 것은 옳지 않다.

쓰는 법 — 모듈 최상단 훅 두 개만 붙인다.

    from _local_isolation import setUpModule, tearDownModule   # noqa: F401
"""
import os
import shutil
import tempfile

import chunk_publish as _cp
import local_assets as _la

_STATE = {}


def setUpModule():
    _STATE["tmp"] = tempfile.mkdtemp(prefix="af_local_iso_")
    _STATE["env"] = {k: os.environ.get(k) for k in (_la.LOCAL_ROOT_ENV, _cp.ENV)}
    _STATE["auto"] = _cp._AUTO_RUN_ID
    os.environ[_la.LOCAL_ROOT_ENV] = _STATE["tmp"]
    os.environ.pop(_cp.ENV, None)
    _cp._AUTO_RUN_ID = None


def tearDownModule():
    for k, v in (_STATE.get("env") or {}).items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    _cp._AUTO_RUN_ID = _STATE.get("auto")
    if _STATE.get("tmp"):
        shutil.rmtree(_STATE["tmp"], ignore_errors=True)
    _STATE.clear()
