# -*- coding: utf-8 -*-
"""dub_lines.py 단위 검사 - 모델도 파일도 쓰지 않는다. 숫자와 글자만 본다.

실행: python -X utf8 python/test_dub_lines.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_lines as dl


def seg(start, end, text, words=None):
    return {'start': start, 'end': end, 'text': text, 'words': words or []}


class Test문장_끝_알아보기(unittest.TestCase):
    def test_부호로_끝나면_문장이_끝난_것이다(self):
        for t in ('안녕하세요.', 'こんにちは。', 'What?', '정말!', '그래서…'):
            self.assertTrue(dl.ends_sentence(t), t)

    def test_부호가_없으면_모르는_것으로_본다(self):
        """★없다고 '안 끝났다' 고 단정하지 않는다 - 틈으로 판단하게 넘긴다."""
        self.assertFalse(dl.ends_sentence('風が表で呼んでいる'))
        self.assertFalse(dl.ends_sentence(''))
        self.assertFalse(dl.ends_sentence('   '))


class Test이어_붙이기(unittest.TestCase):
    def test_한중일은_띄우지_않는다(self):
        self.assertEqual(dl.join_text('風が', '呼んでいる'), '風が呼んでいる')
        self.assertEqual(dl.join_text('바람이', '분다'), '바람이분다')

    def test_서양_글자는_한_칸_띄운다(self):
        self.assertEqual(dl.join_text('the wind', 'is calling'), 'the wind is calling')

    def test_한쪽이_비면_나머지를_그대로_돌려준다(self):
        self.assertEqual(dl.join_text('', 'abc'), 'abc')
        self.assertEqual(dl.join_text('abc', ''), 'abc')


class Test묶기(unittest.TestCase):
    def test_바짝_붙은_조각은_한_줄이_된다(self):
        """★이것이 이 파일이 있는 이유다. 조각을 따로 번역하면 없는 말을 지어낸다."""
        rows = dl.merge_segments([
            seg(0.0, 2.0, '風が表で'),
            seg(2.1, 4.0, '呼んでいる'),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['text'], '風が表で呼んでいる')
        self.assertEqual(rows[0]['start'], 0.0)
        self.assertEqual(rows[0]['end'], 4.0)
        self.assertEqual(rows[0]['parts'], [0, 1])

    def test_크게_쉬면_끊는다(self):
        rows = dl.merge_segments([
            seg(0.0, 2.0, '前の話'),
            seg(5.0, 7.0, '次の話'),
        ])
        self.assertEqual(len(rows), 2)
        self.assertIn('쉬었다', rows[0]['break_reason'])

    def test_문장부호로_끝나면_붙어_있어도_끊는다(self):
        rows = dl.merge_segments([
            seg(0.0, 2.0, 'こんにちは。'),
            seg(2.05, 4.0, 'さようなら'),
        ])
        self.assertEqual(len(rows), 2)
        self.assertIn('문장이 끝났다', rows[0]['break_reason'])

    def test_너무_길어지면_끊는다(self):
        rows = dl.merge_segments([seg(i * 2.0, i * 2.0 + 1.9, 'あ') for i in range(10)],
                                 max_sec=6.0)
        self.assertGreater(len(rows), 1)
        for r in rows:
            self.assertLessEqual(r['end'] - r['start'], 6.0 + 1e-6)

    def test_글자가_너무_많아져도_끊는다(self):
        rows = dl.merge_segments([seg(i * 1.0, i * 1.0 + 0.9, 'あ' * 20) for i in range(5)],
                                 max_chars=45)
        self.assertGreater(len(rows), 1)
        for r in rows:
            self.assertLessEqual(len(r['text']), 45 + 20)

    def test_왜_끊었는지_남긴다(self):
        """조용히 묶지 않는다 - 나중에 되짚을 수 있어야 한다."""
        rows = dl.merge_segments([
            seg(0.0, 2.0, 'あ'), seg(5.0, 6.0, 'い'), seg(6.1, 7.0, 'う'),
        ])
        self.assertTrue(all(r['break_reason'] for r in rows))

    def test_낱말_시각을_이어_붙인다(self):
        rows = dl.merge_segments([
            seg(0.0, 2.0, 'あ', [{'start': 0.0, 'end': 1.0, 'word': 'あ'}]),
            seg(2.1, 4.0, 'い', [{'start': 2.1, 'end': 3.0, 'word': 'い'}]),
        ])
        self.assertEqual(len(rows[0]['words']), 2, '어절 자리 맞추기의 재료다')

    def test_빈_목록은_빈_결과다(self):
        self.assertEqual(dl.merge_segments([]), [])

    def test_하나만_있으면_그대로_나온다(self):
        rows = dl.merge_segments([seg(1.0, 3.0, 'ただいま')])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['parts'], [0])

    def test_시각이_없으면_몇_번째인지_말한다(self):
        with self.assertRaises(dl.DubLinesError) as cm:
            dl.merge_segments([seg(0.0, 1.0, 'あ'), {'text': 'い'}])
        self.assertIn('2번째', str(cm.exception))


class Test실제_모양(unittest.TestCase):
    """2026-09-20 실측한 모양을 그대로 흉내 낸다 - 문장부호가 하나도 없는 가사."""

    def build(self):
        rows, t = [], 0.0
        for i in range(12):
            dur = 3.6
            rows.append(seg(t, t + dur, 'あいうえお' * 2))
            t += dur + (0.2 if i % 2 == 0 else 0.9)   # 틈이 번갈아 좁고 넓다
        return rows

    def test_조각이_절반쯤으로_줄어든다(self):
        before = self.build()
        after = dl.merge_segments(before)
        self.assertLess(len(after), len(before))
        s = dl.summarize(before, after)
        self.assertGreater(s['merged_lines'], 0)
        self.assertGreater(s['after_median_chars'], s['before_median_chars'])

    def test_묶어도_한계를_넘지_않는다(self):
        after = dl.merge_segments(self.build())
        for r in after:
            self.assertLessEqual(r['end'] - r['start'], dl.MAX_MERGED_SEC + 1e-6)
            self.assertLessEqual(len(r['text']), dl.MAX_MERGED_CHARS + 20)

    def test_시각이_뒤로만_간다(self):
        """묶은 줄이 서로 겹치거나 거꾸로 가면 안 된다."""
        after = dl.merge_segments(self.build())
        for a, b in zip(after, after[1:]):
            self.assertLessEqual(a['end'], b['start'] + 1e-6)
            self.assertLess(a['start'], a['end'])


if __name__ == '__main__':
    unittest.main()
