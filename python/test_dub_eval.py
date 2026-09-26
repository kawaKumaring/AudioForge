# -*- coding: utf-8 -*-
"""dub_eval.py 단위 검사 - 사용자 가사도 모델도 쓰지 않는다. 지어낸 글자만 쓴다.

실행: python -X utf8 python/test_dub_eval.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_eval as de


def lyrics(rows):
    """(원문, 발음, 뜻) 묶음을 가사 파일 모양으로 만든다."""
    out = []
    for j, p, m in rows:
        out += [j, '', p, '', m, '']
    return '\n'.join(out)


class Test가사_가르기(unittest.TestCase):
    def test_원문_발음_뜻_세_줄씩_읽는다(self):
        t = lyrics([('あいうえお', '아이우에오', '가나다라'),
                    ('かきくけこ', '카키쿠케코', '마바사아')])
        rows = de.parse_lyrics(t)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][0], 'あいうえお')
        self.assertEqual(rows[0][2], '가나다라')

    def test_머리말이_섞여_있어도_건너뛴다(self):
        t = '노래 제목\n\n' + lyrics([('あいうえお', '아이우에오', '가나다라')])
        self.assertEqual(len(de.parse_lyrics(t)), 1)

    def test_모양이_아니면_빈_결과다(self):
        self.assertEqual(de.parse_lyrics('한국어만 있는 글\n또 한 줄'), [])
        self.assertEqual(de.parse_lyrics(''), [])


class Test뜻_줄_고르기(unittest.TestCase):
    """★잘못 고르면 번역 점수가 통째로 헛것이 된다. 숫자로 고른다."""

    def build(self, n=10):
        rows = []
        for i in range(n):
            j = 'あ' * (4 + i)                 # 원문 길이가 들쭉날쭉
            p = '아' * (4 + i)                 # 발음은 원문을 바짝 따라간다
            m = '뜻' * (6 if i % 2 else 12)    # 뜻은 따라가지 않는다
            rows.append((j, p, m))
        return de.parse_lyrics(lyrics(rows))

    def test_원문을_덜_따라가는_쪽을_뜻으로_본다(self):
        which, c1, c2 = de.pick_meaning_column(self.build())
        self.assertEqual(which, 2)
        self.assertGreater(c1, c2, '발음이 원문을 더 따라간다')

    def test_순서가_바뀌어_있어도_찾는다(self):
        rows = []
        for i in range(10):
            j = 'あ' * (4 + i)
            m = '뜻' * (6 if i % 2 else 12)
            p = '아' * (4 + i)
            rows.append((j, m, p))            # 뜻이 먼저 온 경우
        which, _, _ = de.pick_meaning_column(de.parse_lyrics(lyrics(rows)))
        self.assertEqual(which, 1)

    def test_짝이_너무_적으면_가릴_수_없다고_말한다(self):
        few = de.parse_lyrics(lyrics([('あ', '아', '뜻')]))
        with self.assertRaises(de.DubEvalError):
            de.pick_meaning_column(few)


class Test오류율(unittest.TestCase):
    def test_똑같으면_100퍼센트다(self):
        r = de.cer('안녕하세요', '안녕하세요')
        self.assertEqual(r['cer'], 0.0)
        self.assertEqual(r['accuracy'], 100.0)

    def test_공백과_문장부호는_틀린_것으로_세지_않는다(self):
        """뜻이 같은데 부호만 다른 것을 틀렸다고 하면 안 된다."""
        r = de.cer('안녕하세요, 반갑습니다.', '안녕하세요 반갑습니다')
        self.assertEqual(r['cer'], 0.0)

    def test_바뀜_빠짐_더해짐을_나눠_센다(self):
        r = de.cer('가나다라', '가나마라바')
        self.assertEqual(r['substitutions'], 1)
        self.assertEqual(r['insertions'], 1)
        self.assertEqual(r['deletions'], 0)

    def test_아예_다르면_정확도가_낮다(self):
        self.assertLess(de.cer('가나다라마', 'ABCDE')['accuracy'], 10.0)

    def test_정답지가_비면_잴_수_없다고_말한다(self):
        with self.assertRaises(de.DubEvalError):
            de.cer('   ', '무언가')


class Test한꺼번에_재기(unittest.TestCase):
    def test_알아듣기와_번역을_함께_돌려준다(self):
        rows = [('あ' * (4 + i), '아' * (4 + i), '뜻' * (6 if i % 2 else 12))
                for i in range(10)]
        t = lyrics(rows)
        asr = ''.join(r[0] for r in rows)          # 완벽하게 알아들었다고 치고
        ko = ''.join(r[2] for r in rows)           # 번역도 정답과 같다고 치고
        out = de.evaluate(t, asr, ko)
        self.assertEqual(out['pairs'], 10)
        self.assertEqual(out['meaning_column'], 2)
        self.assertEqual(out['asr']['accuracy'], 100.0)
        self.assertEqual(out['translation']['accuracy'], 100.0)
        self.assertLess(out['translation_other_column']['accuracy'], 100.0,
                        '반대쪽으로 재면 낮아야 - 고른 근거가 된다')

    def test_가사를_못_가르면_사유와_함께_실패한다(self):
        with self.assertRaises(de.DubEvalError):
            de.evaluate('아무 모양도 아닌 글', '무언가')


if __name__ == '__main__':
    unittest.main()
