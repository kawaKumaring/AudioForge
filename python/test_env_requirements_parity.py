# -*- coding: utf-8 -*-
"""꾸러미 목록이 **두 곳에서 갈라지지 않는지** 본다.

★왜 있는가(2026-09-24 감사)
  꾸러미 목록이 두 곳에 있다.
    · `python/requirements.txt` — 사람이 읽는 문서. **읽는 코드가 하나도 없다.**
    · `python/env_check.REQUIRED` — 설치기(`setup_env.py`)가 읽는 **실권.**

  같은 날 부품 셋을 들이면서 **문서 쪽만 고쳤다.** 그래서 새 PC 나 새로 만든 환경은
  그 셋이 빠진 채 "준비 끝" 을 보고하게 돼 있었다. 실권이 안 읽히는 쪽에 없다는 것을
  모르면 되풀이된다.

  목록을 하나로 합치는 것이 정답이겠으나, requirements.txt 는 사람이 판 번호를 적는
  자리이고 REQUIRED 는 불러오는 이름·쓰임새·등급을 적는 자리라 모양이 다르다.
  그래서 **합치는 대신 갈라지면 잡는다.**

실행: python -X utf8 python/test_env_requirements_parity.py
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import env_check

HERE = os.path.dirname(os.path.abspath(__file__))
REQ_PATH = os.path.join(HERE, 'requirements.txt')

# 판 번호·추가 기능 표기를 떼고 이름만 남긴다. 밑줄과 붙임표는 같은 것으로 본다
# (pip 은 'ordered_set' 과 'ordered-set' 을 같은 꾸러미로 친다).
_SPEC = re.compile(r'^\s*([A-Za-z0-9._-]+)')


def norm(name):
    return name.strip().lower().replace('_', '-')


def read_requirements(path=REQ_PATH):
    """문서 쪽 목록. 주석과 빈 줄은 뺀다."""
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            m = _SPEC.match(line)
            if m:
                out.append(norm(m.group(1)))
    return out


def required_names():
    """실권 쪽 목록(pip 이름만)."""
    return [norm(row[0]) for row in env_check.REQUIRED]


class Test두_목록이_갈라지지_않는다(unittest.TestCase):
    def test_문서에만_있는_것이_없다(self):
        """★문서에 적고 실권에 안 적으면 **설치되지 않는다.**

        2026-09-24 에 실제로 그랬다 — piper-tts·ordered_set·pyopenjtalk-plus 셋.
        """
        doc = set(read_requirements())
        real = set(required_names())
        only_doc = sorted(doc - real)
        self.assertEqual(only_doc, [],
                         '문서에만 있어 설치되지 않는다: %s' % ', '.join(only_doc))

    def test_실권에만_있는_것이_없다(self):
        """실권에 있는데 문서에 없으면 사람이 무엇을 쓰는지 알 수 없다.

        ★torch.hub 로도 받을 수 있는 것(silero-vad)은 예외다 — pip 로 반드시
          깔아야 하는 것이 아니라서 문서에 적지 않는다. 그 예외를 여기 적어 둔다.
        """
        hub_only = {norm(r[0]) for r in env_check.REQUIRED if r[3] == 'hub'}
        doc = set(read_requirements())
        real = set(required_names()) - hub_only
        only_real = sorted(real - doc)
        self.assertEqual(only_real, [],
                         '실권에만 있어 문서가 거짓이 된다: %s' % ', '.join(only_real))

    def test_밑줄과_붙임표를_같은_것으로_본다(self):
        self.assertEqual(norm('ordered_set'), norm('Ordered-Set'))

    def test_판_번호_표기를_떼어_낸다(self):
        self.assertEqual(_SPEC.match('torch>=2.11.0').group(1), 'torch')
        self.assertEqual(_SPEC.match('audio-separator').group(1), 'audio-separator')

    def test_목록이_비어_있지_않다(self):
        """★파일을 못 읽어 빈 목록이 되면 위 두 검사가 **거짓으로 통과**한다."""
        self.assertGreater(len(read_requirements()), 5)
        self.assertGreater(len(required_names()), 5)


class Test실권_목록의_모양(unittest.TestCase):
    def test_네_칸을_모두_채운다(self):
        for row in env_check.REQUIRED:
            self.assertEqual(len(row), 4, row)
            for cell in row:
                self.assertTrue(str(cell).strip(), row)

    def test_등급이_아는_값이다(self):
        for row in env_check.REQUIRED:
            self.assertIn(row[3], ('core', 'tts', 'hub'), row)

    def test_같은_꾸러미를_두_번_적지_않았다(self):
        names = required_names()
        self.assertEqual(len(names), len(set(names)), names)


if __name__ == '__main__':
    unittest.main()
