# -*- coding: utf-8 -*-
"""본보기가 파이썬과 어긋나지 않았는가.

★왜 양쪽을 다 묶나
  화면 쪽에도 같은 빚기 계산이 있다(손잡이를 움직일 때마다 파이썬을 부르면 끊기므로).
  둘이 갈라지면 **사람이 보고 맞춘 모양과 소리에 먹는 모양이 달라진다** —
  맞췄다고 생각하고 전곡을 뽑았는데 딴 소리가 나오는 것이 최악이다.

  화면 쪽은 본보기에 맞춰 검사한다. 그런데 본보기만 있고 이 검사가 없으면,
  파이썬을 고쳤을 때 **본보기가 낡은 채로 남아** 화면 쪽만 옛 답을 지키게 된다.
  그래서 이 파일이 "본보기는 지금 파이썬과 같다" 를 지킨다.

  본보기를 다시 만들려면: `_local/fixture_gen.py`
"""
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pitch_shape as ps  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, '..', 'test', 'fixtures', 'pitch-shape-vectors.json')


def _cases():
    with io.open(VECTORS, encoding='utf-8') as f:
        return json.load(f)['cases']


class TestVectorsMatchPython(unittest.TestCase):
    def test_본보기를_읽는다(self):
        n = len(_cases())
        self.assertGreaterEqual(n, 30, '본보기를 %d개밖에 못 읽었다 — 검사가 눈이 멀었다' % n)

    def test_환산이_본보기와_같다(self):
        for c in _cases():
            got = ps.to_semitones(c['hz'])
            for i, (g, w) in enumerate(zip(got, c['semitones'])):
                if w is None or g is None:
                    self.assertEqual(g, w, '%s[%d] 소리 있음/없음이 갈린다' % (c['name'], i))
                else:
                    self.assertAlmostEqual(g, w, places=6,
                                           msg='%s[%d]' % (c['name'], i))

    def test_빚은_곡선이_본보기와_같다(self):
        for c in _cases():
            got = ps.apply_knobs(ps.to_semitones(c['hz']), c['knobs'])
            self.assertEqual(len(got), len(c['shaped']), '%s 칸 수가 다르다' % c['name'])
            for i, (g, w) in enumerate(zip(got, c['shaped'])):
                if w is None or g is None:
                    self.assertEqual(g, w, '%s[%d] 소리 있음/없음이 갈린다' % (c['name'], i))
                else:
                    self.assertAlmostEqual(
                        g, w, places=6,
                        msg='%s %s [%d] — 본보기가 낡았다면 다시 만들어라'
                            % (c['name'], c['knobs'], i))

    def test_겹침_점수가_본보기와_같다(self):
        for c in _cases():
            got = ps.similarity(ps.to_semitones(c['hz']), c['shaped'])
            self.assertAlmostEqual(got, c['similarity'], places=6, msg=c['name'])


class TestBothSidesExist(unittest.TestCase):
    """★한쪽이 사라지면 묶을 것이 없어진다."""

    def test_화면_쪽_구현이_있다(self):
        p = os.path.join(HERE, '..', 'src', 'shared', 'pitchShape.ts')
        self.assertTrue(os.path.isfile(p), '화면 쪽 빚기 구현이 없다')

    def test_화면_쪽_검사가_본보기를_쓴다(self):
        p = os.path.join(HERE, '..', 'src', 'shared', 'pitchShape.crosscheck.test.ts')
        self.assertTrue(os.path.isfile(p), '두 구현을 묶는 검사가 없다')
        with io.open(p, encoding='utf-8') as f:
            self.assertIn('pitch-shape-vectors.json', f.read(),
                          '화면 쪽 검사가 본보기를 안 본다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
