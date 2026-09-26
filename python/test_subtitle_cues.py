# -*- coding: utf-8 -*-
"""subtitle_cues.py 단위 검사 - 모델도 파일도 쓰지 않는다. 글자와 숫자만 본다.

실행: python -X utf8 python/test_subtitle_cues.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import subtitle_cues as sc


class Test줄_나누기(unittest.TestCase):
    def test_짧으면_한_줄_그대로(self):
        self.assertEqual(sc.wrap_text('안녕하세요'), ['안녕하세요'])

    def test_긴_글은_두_줄로_나눈다(self):
        lines = sc.wrap_text('가' * 35, max_chars=20)
        self.assertEqual(len(lines), 2)
        self.assertLessEqual(len(lines[0]), 20)

    def test_문법_경계에서_끊는다(self):
        """★낱말 가운데를 자르면 읽는 사람이 걸린다."""
        lines = sc.wrap_text('바람이 불어오는 언덕에서 우리는 오래 기다렸다', max_chars=14)
        self.assertGreater(len(lines), 1)
        self.assertFalse(lines[0].endswith('바'), '낱말 가운데를 잘랐다: %r' % lines)

    def test_공백에서라도_끊는다(self):
        lines = sc.wrap_text('abcdef ghijkl mnopqr stuvwx', max_chars=14)
        self.assertGreater(len(lines), 1)
        for l in lines[:-1]:
            self.assertFalse(l.endswith(' '))

    def test_두_줄을_넘기면_글자를_버리지_않고_붙인다(self):
        """★읽기 불편한 것보다 내용이 사라지는 것이 나쁘다."""
        src = '가' * 100
        lines = sc.wrap_text(src, max_chars=20, max_lines=2)
        self.assertEqual(''.join(lines).replace(' ', ''), src)

    def test_빈_글은_빈_결과다(self):
        self.assertEqual(sc.wrap_text(''), [])
        self.assertEqual(sc.wrap_text('   '), [])

    def test_여러_공백을_하나로_고른다(self):
        self.assertEqual(sc.wrap_text('가   나    다'), ['가 나 다'])


class Test읽는_속도(unittest.TestCase):
    def test_초당_글자_수를_잰다(self):
        self.assertAlmostEqual(sc.reading_speed('가나다라마', 1.0), 5.0)

    def test_길이가_0이면_잴_수_없다(self):
        self.assertIsNone(sc.reading_speed('가나다', 0.0))


class Test큐_만들기(unittest.TestCase):
    def rows(self):
        return [{'start': 0.0, 'end': 2.0, 'text': '첫 번째 줄입니다'},
                {'start': 3.0, 'end': 5.0, 'text': '두 번째 줄입니다'}]

    def test_줄마다_큐가_생긴다(self):
        cues = sc.build_cues(self.rows())
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]['start'], 0.0)

    def test_너무_짧은_큐를_늘린다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 0.2, 'text': '짧다'},
                              {'start': 5.0, 'end': 6.0, 'text': '다음'}])
        self.assertGreaterEqual(cues[0]['end'] - cues[0]['start'],
                                sc.MIN_DURATION_SEC - 1e-6)

    def test_시작이_0이_아니어도_제대로_늘린다(self):
        """★2026-09-24 2차 감사가 찾은 것 — **검사 재료가 전부 start=0 이라 지나갔다.**

        '늘릴 수 있는 가장 늦은 끝' 을 절대 시각이 아니라 **길이**로 계산하고 있었다.
        start=0 일 때만 두 공식의 값이 우연히 같아서 모든 검사가 통과했다.
        시작이 0이 아니면 짧은 자막이 **길이 0** 이 되어 화면에 아예 안 떴다.
        받아쓰기·더빙·교정본 자막 셋 다 같은 증상이었다.
        """
        cues = sc.build_cues([{'start': 5.0, 'end': 5.6, 'text': '네'},
                              {'start': 7.0, 'end': 9.0, 'text': '다음 문장입니다'}])
        self.assertAlmostEqual(cues[0]['end'] - cues[0]['start'], sc.MIN_DURATION_SEC, places=6)
        self.assertEqual(cues[0]['warnings'], [], '여유가 있으면 경고할 일이 없다')

    def test_시작이_0이_아니고_바짝_붙으면_그만큼만_늘린다(self):
        cues = sc.build_cues([{'start': 5.0, 'end': 5.6, 'text': '네'},
                              {'start': 5.9, 'end': 7.0, 'text': '바짝'}])
        got = cues[0]['end'] - cues[0]['start']
        self.assertGreater(got, 0.0, '길이 0 자막은 화면에 안 뜬다')
        self.assertAlmostEqual(cues[0]['end'], 5.9 - sc.MIN_GAP_SEC, places=6)
        self.assertTrue(cues[0]['warnings'])

    def test_늘리다가_다음_자막을_침범하지_않는다(self):
        """★겹치면 두 자막이 한꺼번에 뜬다."""
        cues = sc.build_cues([{'start': 0.0, 'end': 0.2, 'text': '짧다'},
                              {'start': 0.5, 'end': 2.0, 'text': '바로 다음'}])
        self.assertLessEqual(cues[0]['end'], cues[1]['start'] - sc.MIN_GAP_SEC + 1e-6)
        self.assertTrue(cues[0]['warnings'], '못 늘렸으면 그 사실을 남긴다')

    def test_너무_긴_큐를_줄인다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 30.0, 'text': '길다'}])
        self.assertLessEqual(cues[0]['end'] - cues[0]['start'], sc.MAX_DURATION_SEC + 1e-6)

    def test_큐끼리_겹치지_않는다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 4.0, 'text': '앞'},
                              {'start': 2.0, 'end': 5.0, 'text': '뒤'}])
        self.assertLessEqual(cues[0]['end'], cues[1]['start'] + 1e-6)

    def test_너무_빠르면_경고한다(self):
        """정확도가 아니라 이것 때문에 자동 자막이 읽기 힘들다."""
        cues = sc.build_cues([{'start': 0.0, 'end': 1.0, 'text': '가' * 40}])
        self.assertTrue(any('빠릅니다' in w for w in cues[0]['warnings']))

    def test_편하게_읽히면_경고가_없다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 4.0, 'text': '짧은 한 줄'}])
        self.assertEqual(cues[0]['warnings'], [])

    def test_빈_줄은_건너뛴다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 1.0, 'text': '  '},
                              {'start': 2.0, 'end': 4.0, 'text': '있다'}])
        self.assertEqual(len(cues), 1)

    def test_시각이_없으면_몇_번째인지_말한다(self):
        with self.assertRaises(sc.SubtitleCueError) as cm:
            sc.build_cues([{'start': 0.0, 'end': 1.0, 'text': '가'}, {'text': '나'}])
        self.assertIn('2번째', str(cm.exception))

    def test_빈_목록은_빈_결과다(self):
        self.assertEqual(sc.build_cues([]), [])


class Test요약과_내보내기(unittest.TestCase):
    def test_규칙을_못_지킨_수를_센다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 4.0, 'text': '편한 줄'},
                              {'start': 5.0, 'end': 6.0, 'text': '가' * 40}])
        s = sc.summarize(cues)
        self.assertEqual(s['cues'], 2)
        self.assertEqual(s['with_warnings'], 1)

    def test_자막_글에_줄이_그대로_들어간다(self):
        cues = sc.build_cues([{'start': 0.0, 'end': 4.0, 'text': '가' * 35}])
        body = sc.to_srt(cues, lambda t: '00:00:%06.3f' % t)
        self.assertIn('1\n', body)
        self.assertEqual(body.count('\n'.join(cues[0]['lines'])), 1)

    def test_시각_표기를_밖에서_받는다(self):
        """★같은 계산을 두 곳에 두지 않는다(2026-09-21 되풀이한 실수)."""
        marks = []
        sc.to_srt(sc.build_cues([{'start': 1.0, 'end': 3.0, 'text': '가'}]),
                  lambda t: marks.append(t) or 'X')
        self.assertEqual(marks, [1.0, 3.0])


if __name__ == '__main__':
    unittest.main()
