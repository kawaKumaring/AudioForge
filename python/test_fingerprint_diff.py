# -*- coding: utf-8 -*-
"""설치 지문이 어긋났을 때 **사실대로 말하는가.**

★왜(2026-09-25 실제 사고)
  사용자가 잘 쓰던 앱이 갑자기 "환경 점검: 미비" 를 띄우고 **4GiB 재설치**를 요구했다.
  실제로 일어난 일은 일본어 지원 패키지 **3개가 정당하게 추가**된 것이었고,
  기록만 갱신하면 30초에 끝나는 상황이었다.

  그런데 화면은 두 가지를 잘못했다.
    1. 개수가 114 → **117 로 늘었는데** "패키지가 삭제·변경되었습니다" 라고 말했다.
       늘어난 것과 사라진 것은 **다른 일**인데 같은 말로 덮었다.
    2. 화면에 보이는 선택지가 **전체 재설치뿐**이었다. `verify --relink` 라는
       싼 길이 도구에 이미 있었는데 **보이지 않으면 없는 것과 같다.**

  사용자는 "손상됐구나" 로 읽고 내려받기를 시작했다.

★이 검사가 지키는 것: **모르는 것을 아는 척하지 않기.**
  옛 기록에는 이름이 없다(개수만). 그때는 방향만 말하고 단정하지 않아야 한다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app_runtime as rt  # noqa: E402


def rec(n, names=None):
    d = {"sha256": "a" * 64, "distributions": n}
    if names is not None:
        d["names"] = ["%s.dist-info" % x for x in names]
    return d


class TestTellsTheTruth(unittest.TestCase):
    def test_늘기만_했으면_사라졌다고_말하지_않는다(self):
        """★이번 사고 그 자체."""
        d = rt.fingerprint_diff(
            rec(2, ["torch-2.11.0", "numpy-2.1.0"]),
            rec(5, ["torch-2.11.0", "numpy-2.1.0", "pyopenjtalk_plus-0.4.1",
                    "sudachipy-0.7.0", "sudachidict_core-20260723.1"]))
        self.assertEqual(d["removed"], [], "사라진 것이 없는데 있다고 한다")
        self.assertEqual(len(d["added"]), 3)
        self.assertIn("늘어난 것", d["text"])
        self.assertNotIn("삭제", d["text"], "늘었는데 삭제라고 말한다")
        self.assertIn("손상이 아닐 수 있습니다", d["text"],
                      "재설치를 피할 수 있다는 것을 말하지 않는다")

    def test_무엇이_늘었는지_이름을_말한다(self):
        d = rt.fingerprint_diff(rec(1, ["torch-2.11.0"]),
                                rec(2, ["torch-2.11.0", "pyopenjtalk_plus-0.4.1"]))
        self.assertIn("pyopenjtalk_plus", d["text"], "무엇이 늘었는지 말하지 않는다')")
        self.assertIn("0.4.1", d["text"], "판 번호를 말하지 않는다")

    def test_진짜로_사라졌으면_그렇게_말한다(self):
        d = rt.fingerprint_diff(rec(2, ["torch-2.11.0", "numpy-2.1.0"]),
                                rec(1, ["torch-2.11.0"]))
        self.assertEqual(d["added"], [])
        self.assertIn("사라진 것", d["text"])
        self.assertNotIn("손상이 아닐 수 있습니다", d["text"],
                         "진짜 손상인데 괜찮다고 말한다")

    def test_양쪽_다_바뀌면_둘_다_말한다(self):
        d = rt.fingerprint_diff(rec(2, ["torch-2.11.0", "numpy-2.1.0"]),
                                rec(2, ["torch-2.11.0", "scipy-1.14.0"]))
        self.assertIn("늘어난 것", d["text"])
        self.assertIn("사라진 것", d["text"])

    def test_목록이_같은데_지문이_다르면_파이썬을_지목한다(self):
        d = rt.fingerprint_diff(rec(1, ["torch-2.11.0"]), rec(1, ["torch-2.11.0"]))
        self.assertIn("파이썬", d["text"])

    # ★옛 기록에는 이름이 없다 — 그때 단정하면 또 같은 사고가 난다.
    def test_옛_기록이면_모른다고_말한다(self):
        d = rt.fingerprint_diff(rec(114), rec(117))
        self.assertIn("늘었습니다", d["text"])
        self.assertIn("알 수 없습니다", d["text"], "모르는 것을 아는 척한다")
        self.assertEqual(d["added"], [])


class TestRecordKeepsNames(unittest.TestCase):
    """이름을 기록하지 않으면 위 검사가 전부 무의미해진다."""

    def test_지문에_이름이_들어간다(self):
        import io
        src = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'app_runtime.py'), encoding='utf-8').read()
        at = src.index('def venv_fingerprint')
        body = src[at:src.index('def fingerprint_diff')]
        self.assertIn('"names"', body, '이름을 기록하지 않는다')

    def test_이름은_비민감하다(self):
        """패키지 이름과 판 번호뿐이어야 한다 — 경로가 들어가면 기록으로 샌다."""
        import io
        src = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'app_runtime.py'), encoding='utf-8').read()
        at = src.index('def distribution_list')
        body = src[at:src.index('def venv_fingerprint')]
        self.assertIn('os.listdir(site)', body, '목록이 파일 이름이 아닌 다른 것을 담는다')
        self.assertNotIn('os.path.join(site', body, '경로를 담을 수 있다')


class TestCheapPathIsShown(unittest.TestCase):
    """★해결책이 있어도 **보이지 않으면 없는 것과 같다.**"""

    def test_사라진_것이_없으면_재설치_전에_알린다(self):
        import io
        src = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'app_env_installer.py'), encoding='utf-8').read()
        self.assertIn('repairable_by_relink', src, '싼 길을 판단하지 않는다')
        self.assertIn('verify --relink', src, '싼 길을 화면에 보여 주지 않는다')

    def test_판단을_본체가_실제로_내린다(self):
        import io
        src = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'app_runtime.py'), encoding='utf-8').read()
        self.assertIn('repairable_by_relink', src, '본체가 그 값을 내놓지 않는다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
