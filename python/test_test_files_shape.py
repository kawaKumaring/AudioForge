# -*- coding: utf-8 -*-
"""검사 파일 자체의 모양 — **조용히 안 도는 검사**를 막는다.

★왜(2026-09-25 3차 감사): 같은 함정을 이 저장소에서 **세 번** 겪었다.

  `if __name__ == "__main__": unittest.main()` 을 파일 **중간**에 두면,
  그 뒤에 정의한 검사들은 아직 만들어지지 않은 채 `unittest.main()` 이 돌아
  **조용히 빠진다.** 게이트는 발견(discovery) 방식이라 전부 돌기 때문에
  아무도 눈치채지 못하고, 그 파일 하나를 손으로 돌려 보는 사람에게만 안 보인다.

  세 번이나 겪고도 계속 생긴 이유는 **막는 검사가 없었기 때문**이다.
  고친 것보다 다시 안 생기게 하는 것이 중요하다.

  실제 피해: 새로 쓴 검사 6건이 한 번도 돌지 않은 채 "통과" 로 보였다.
"""
import io
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
NL = chr(10)


def _test_files():
    for name in sorted(os.listdir(HERE)):
        if name.startswith('test_') and name.endswith('.py'):
            yield name


class TestMainBlockIsLast(unittest.TestCase):
    def test_main_블록_뒤에_검사가_없다(self):
        bad = []
        for name in _test_files():
            lines = io.open(os.path.join(HERE, name), encoding='utf-8',
                            errors='replace').read().split(NL)
            at = None
            for i, l in enumerate(lines):
                if l.startswith('if __name__ =='):
                    at = i                      # 여러 개면 마지막 것
            if at is None:
                continue
            after = [lines[i] for i in range(at, len(lines))
                     if lines[i].startswith('class ') or lines[i].startswith('def test')]
            if after:
                bad.append('%s — 뒤에 %d개' % (name, len(after)))
        self.assertEqual(bad, [], NL.join(
            ['main 블록 뒤에 정의한 검사는 **직접 실행할 때 조용히 빠진다.**',
             '블록을 파일 맨 끝으로 옮기세요:'] + bad))


class TestGuardSeesEverything(unittest.TestCase):
    """★이 검사가 눈이 멀면 위 검사도 무의미하다."""

    def test_검사_파일을_실제로_찾는다(self):
        n = len(list(_test_files()))
        self.assertGreater(n, 100, '검사 파일을 %d개밖에 못 찾았다 — 경로가 틀렸다' % n)

    def test_스스로도_규칙을_지킨다(self):
        """이 파일의 main 블록도 맨 끝이어야 한다 — 규칙을 만든 쪽이 어기면 안 된다."""
        lines = io.open(os.path.join(HERE, 'test_test_files_shape.py'),
                        encoding='utf-8').read().split(NL)
        at = max(i for i, l in enumerate(lines) if l.startswith('if __name__ =='))
        after = [l for l in lines[at:] if l.startswith('class ') or l.startswith('def test')]
        self.assertEqual(after, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
