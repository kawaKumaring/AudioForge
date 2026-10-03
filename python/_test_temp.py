"""검사용 임시 자리 — **C 드라이브로 가지 않고, 끝나면 치운다** (test/_temp-root.mjs 의 파이썬 짝).

★왜 (2026-09-30 실측): 게이트가 띄운 파이썬 검사는 게이트의 임시 자리를 물려받지만, 검사 파일을
  **단독으로** 돌리면 시스템 임시 폴더(C)로 갔다. C 에 AudioForge 검사 잔해가 13,879개(570MB) 쌓여 있었다.
★쓰는 법: 검사 파일의 **첫 import** 로 `import _test_temp  # noqa: F401` — tempfile 이 자리를 정하기 전에.
  - 부모(게이트·node 검사)가 정해 준 자리(`AF_TEST_RUN_DIR`)가 있으면 그대로 쓴다 — 지우는 것은 부모 몫.
  - 없으면 `_local/tmp/r<pid>` 를 만들어 쓰고, 끝날 때 지운다. `AF_KEEP_TEST_TEMP=1` 이면 남긴다.
  ★죽은 실행의 폴더 청소는 node 쪽(_temp-root.mjs)만 한다 — 윈도우 파이썬의 os.kill(pid, 0) 은
    '있는가' 가 아니라 **그 프로세스를 끝낸다**(문서화된 동작).
"""
import atexit
import os
import shutil
import tempfile

_BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '_local', 'tmp')
_inherited = os.environ.get('AF_TEST_RUN_DIR') or ''

if _inherited and os.path.normcase(os.path.dirname(os.path.abspath(_inherited))) == os.path.normcase(_BASE) \
        and os.path.isdir(_inherited):
    RUN_DIR = _inherited
else:
    RUN_DIR = os.path.join(_BASE, 'r%d' % os.getpid())
    # 같은 번호의 옛 폴더는 죽은 실행의 것이다(번호는 산 프로세스끼리만 겹치지 않는다).
    shutil.rmtree(RUN_DIR, ignore_errors=True)
    os.makedirs(RUN_DIR, exist_ok=True)
    os.environ['AF_TEST_RUN_DIR'] = RUN_DIR
    if os.environ.get('AF_KEEP_TEST_TEMP') == '1':
        open(os.path.join(RUN_DIR, '.keep'), 'w').close()
    else:
        atexit.register(shutil.rmtree, RUN_DIR, True)

for _k in ('TEMP', 'TMP', 'TMPDIR'):
    os.environ[_k] = RUN_DIR
tempfile.tempdir = RUN_DIR
