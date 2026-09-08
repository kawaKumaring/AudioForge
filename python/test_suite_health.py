"""검사기 자신의 건강 검사 — '통과도 실패도 아닌' 시험 파일을 막는다.

왜 이 파일이 있는가(2026-09-08)
────────────────────────────
python/test_*.py 110개 중 **27개가 import 단계에서 죽어 있었다.** 앱이 쓰는 파이썬
(python_embeded)은 `._pth` 정책 때문에 스크립트 폴더를 sys.path 에 넣지 않는다. 그래서
`import reference_audio` 같은 줄이 ModuleNotFoundError 로 터지고, 그 파일의 시험은
한 건도 실행되지 않았다. 실행되지 않은 시험은 통과가 아니다 — 그런데 사람이 보기에는
'실패 목록에 없는' 상태라 안전해 보인다. 이것이 오늘 세 번 반복된 같은 종류의 사고다.
(감정 정의 드리프트 가드가 대상 파일 이동 뒤 계속 실패만 하던 것, 게이트의 '합성 1회' 가
실제로는 시작 후 취소였던 것, 완주 검사가 자산 미지정 시 통과처럼 종료하던 것.)

보강 후 실측: 27개 파일이 되살아나 **549건**이 실제로 실행됐고 전부 통과했다.

여기서 막는 두 가지
────────────────────────────
1) 로컬 모듈을 import 하면서 sys.path 보강이 없는 시험 파일 → 그 파일은 반드시 죽는다.
2) 소스를 현재 폴더 기준 이름으로 여는 시험 → python/ 안에서 부를 때만 통과한다
   (실측: test_qwen_watchdog 등 4건이 `open("tts_worker.py")` 로 그러했다).
"""
import glob
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

LOCAL_MODULES = {os.path.basename(p)[:-3] for p in glob.glob(os.path.join(HERE, "*.py"))}
# 이 파일은 스스로를 검사 대상에서 뺀다 — 위 설명이 금지 모양을 **예시로** 적고 있어
# 자기 자신을 위반으로 잡는다. 문법 분석까지 하지 않고 문자열로 훑는 값을 대신 치르는 자리다.
SELF = os.path.basename(os.path.abspath(__file__))
TEST_FILES = [p for p in sorted(glob.glob(os.path.join(HERE, "test_*.py")))
              if os.path.basename(p) != SELF]
IMPORT_RE = re.compile(r"^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", re.M)
# 현재 폴더 기준으로 소스 파일을 여는 모양. os.path.join(...) 으로 감싼 것은 걸리지 않는다.
BARE_OPEN_RE = re.compile(r"""open\(\s*["'][A-Za-z_][A-Za-z0-9_]*\.py["']""")


class SuiteHealth(unittest.TestCase):
    def test_files_exist(self):
        self.assertGreater(len(TEST_FILES), 50, "시험 파일 목록을 읽지 못했다")

    def test_every_test_file_can_import_local_modules(self):
        broken = []
        for p in TEST_FILES:
            with open(p, encoding="utf-8") as fh:
                src = fh.read()
            if "sys.path.insert" in src:
                continue
            used = sorted(set(IMPORT_RE.findall(src)) & LOCAL_MODULES)
            if used:
                broken.append("{0} -> {1}".format(os.path.basename(p), ",".join(used[:3])))
        self.assertEqual(broken, [], "sys.path 보강 없이 로컬 모듈을 import 한다(이 파일들은 실행되지 않는다):\n  "
                                     + "\n  ".join(broken))

    def test_no_cwd_relative_source_reads(self):
        bad = []
        for p in TEST_FILES:
            with open(p, encoding="utf-8") as fh:
                src = fh.read()
            for m in BARE_OPEN_RE.finditer(src):
                line = src.count("\n", 0, m.start()) + 1
                bad.append("{0}:{1}".format(os.path.basename(p), line))
        self.assertEqual(bad, [], "현재 폴더 기준으로 소스를 연다(python/ 밖에서 부르면 실패):\n  "
                                  + "\n  ".join(bad))


if __name__ == "__main__":
    unittest.main(verbosity=2)
