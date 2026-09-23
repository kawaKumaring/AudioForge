# -*- coding: utf-8 -*-
"""asr_repetition.py 단위 검사 - 모델도 파일도 소리도 쓰지 않는다. 글자만 본다.

실행: python -X utf8 python/test_asr_repetition.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import asr_repetition as ar


class Test낱말_되풀이(unittest.TestCase):
    def test_같은_낱말이_여섯_번_이어지면_하나만_남긴다(self):
        got, n = ar.collapse_word_runs('보세요 URL URL URL URL URL URL 끝')
        self.assertEqual(got, '보세요 URL 끝')
        self.assertEqual(n, 5)

    def test_둘레_문장부호가_달라도_같은_것으로_본다(self):
        """★"URL", "url," , "URL." 이 따로 세어지면 고리를 못 잡는다."""
        got, _ = ar.collapse_word_runs('URL, URL. url URL, URL URL')
        self.assertEqual(got, 'URL,')

    def test_다섯_번은_남긴다(self):
        """수사적 반복을 죽이지 않는다."""
        src = '아니 아니 아니 아니 아니'
        got, n = ar.collapse_word_runs(src)
        self.assertEqual(got, src)
        self.assertEqual(n, 0)

    def test_문장부호만_있는_조각은_같은_것으로_세지_않는다(self):
        src = '. . . . . . 끝'
        got, _ = ar.collapse_word_runs(src)
        self.assertEqual(got, src)

    def test_짧은_글은_건드리지_않는다(self):
        self.assertEqual(ar.collapse_word_runs('안녕 안녕'), ('안녕 안녕', 0))


class Test글자_되풀이(unittest.TestCase):
    def test_여러_낱말_구절이_되풀이되면_하나만_남긴다(self):
        """★낱말 훑기는 이걸 못 잡는다 - 잇따른 같은 낱말이 없다."""
        src = 'thanks for watching ' * 6
        got, n = ar.collapse_char_runs(src)
        self.assertEqual(got, 'thanks for watching')
        self.assertGreater(n, 0)

    def test_띄어쓰기_없는_글도_잡는다(self):
        """★일본어·중국어는 split() 이 한 덩어리라 낱말 훑기가 통하지 않는다."""
        got, _ = ar.collapse_char_runs('ありがとう' * 6)
        self.assertEqual(got, 'ありがとう')

    def test_한_글자_늘인_소리는_지우지_않는다(self):
        """"우와아아아아아아" 의 '아' 는 되풀이가 아니라 늘인 소리다."""
        src = '우와아아아아아아'
        got, n = ar.collapse_char_runs(src)
        self.assertEqual(got, src)
        self.assertEqual(n, 0)

    def test_다섯_번은_남긴다(self):
        src = '가나' * 5
        self.assertEqual(ar.collapse_char_runs(src), (src, 0))

    def test_예순자를_넘는_단위는_보지_않는다(self):
        # ★재료 고르기가 까다롭다. 한 글자를 늘여 만든 긴 단위('가'×61)는
        #   그 안에 이미 2자 되풀이가 들어 있어 길이 상한을 시험하지 못한다.
        #   안에 되풀이가 없는 62자를 쓴다.
        unit = ''.join(chr(0xAC00 + i * 7) for i in range(70))   # 서로 다른 70자
        self.assertGreater(len(unit), ar.MAX_UNIT_CHARS)
        src = unit * 6
        got, n = ar.collapse_char_runs(src)
        self.assertEqual(n, 0, '긴 단위를 잡으면 멀쩡한 글을 지운다: %r' % got[:40])


class Test두_훑기를_함께(unittest.TestCase):
    def test_구간이_통째로_고리여도_고친다(self):
        """★만들다가 걷어낸 빗장이 이 경우를 막고 있었다.

        2026-09-22: "너무 많이 지우면 손대지 않는다" 는 비율 빗장을 뒀다가
        **구간 하나가 통째로 반복인 경우가 바로 고쳐야 할 경우**임을 깨닫고 뺐다.
        """
        got, n = ar.collapse('가나' * 10)
        self.assertEqual(got, '가나')
        self.assertGreater(n, 0)

    def test_되풀이가_없으면_공백도_건드리지_않는다(self):
        """★2026-09-24 계측대에서 드러난 결함.

        collapse_word_runs 가 늘 " ".join 으로 다시 엮는 탓에, 되풀이가 하나도 없어도
        앞뒤 공백이 사라졌다. 알아듣기 구간은 앞에 공백이 붙어 오므로
        **모든 구간이 "고쳤다" 로 세어졌다**(11구간 중 7구간, 구간당 1자).
        진단 숫자가 거짓이 되고 부탁하지 않은 손질이 끼어든다.
        """
        src = ' Hello there. The weather is nice. '
        self.assertEqual(ar.collapse(src), (src, 0))

    def test_여러_공백도_되풀이가_없으면_그대로다(self):
        src = '가   나    다'
        self.assertEqual(ar.collapse(src), (src, 0))

    def test_고칠_것이_있으면_그때는_다듬는다(self):
        got, n = ar.collapse(' 보세요 URL URL URL URL URL URL 끝 ')
        self.assertEqual(got, '보세요 URL 끝')
        self.assertGreater(n, 0)

    def test_멀쩡한_글은_그대로다(self):
        src = '오늘 날씨가 참 좋네요. 같이 걸을까요?'
        self.assertEqual(ar.collapse(src), (src, 0))

    def test_빈_글은_그대로다(self):
        self.assertEqual(ar.collapse(''), ('', 0))
        self.assertEqual(ar.collapse('   '), ('   ', 0))

    def test_없는_값도_터지지_않는다(self):
        self.assertEqual(ar.collapse(None), (None if False else '', 0))


class Test구간에_걸친_반복은_세기만(unittest.TestCase):
    """★노래의 후렴은 진짜로 이어질 수 있다. 재 보지 않은 것을 지우지 않는다."""

    def test_여섯_구간이_같으면_알린다(self):
        segs = [{'text': '라라라'} for _ in range(6)]
        rows = ar.scan_segment_runs(segs)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['count'], 6)
        self.assertEqual(rows[0]['from'], 0)

    def test_알리기만_하고_지우지_않는다(self):
        segs = [{'text': '라라라'} for _ in range(8)]
        before = [s['text'] for s in segs]
        ar.scan_segment_runs(segs)
        self.assertEqual([s['text'] for s in segs], before, '세기만 해야 한다')

    def test_다섯_구간은_알리지_않는다(self):
        segs = [{'text': '후렴'} for _ in range(5)]
        self.assertEqual(ar.scan_segment_runs(segs), [])

    def test_빈_구간은_묶지_않는다(self):
        segs = [{'text': ''} for _ in range(8)]
        self.assertEqual(ar.scan_segment_runs(segs), [])


class Test결과에_적용(unittest.TestCase):
    def result(self):
        return {
            'text': '',
            'segments': [
                {'start': 0.0, 'end': 2.0, 'text': ' 안녕하세요 '},
                {'start': 2.0, 'end': 4.0, 'text': ' URL URL URL URL URL URL '},
                {'start': 4.0, 'end': 6.0, 'text': ' 잘 가요 '},
            ],
        }

    def test_구간_안의_반복만_줄인다(self):
        r = self.result()
        info = ar.apply(r)
        self.assertEqual(info['segments_fixed'], 1)
        self.assertGreater(info['chars_removed'], 0)
        self.assertEqual(r['segments'][1]['text'], 'URL')
        self.assertEqual(r['segments'][0]['text'], ' 안녕하세요 ', '건드리지 않은 구간은 그대로')

    def test_고친_것이_있으면_전체_글을_다시_만든다(self):
        r = self.result()
        ar.apply(r)
        self.assertIn('URL', r['text'])
        self.assertIn('안녕하세요', r['text'])

    def test_고칠_것이_없으면_전체_글을_건드리지_않는다(self):
        r = {'text': '원래 있던 글', 'segments': [{'text': '멀쩡하다'}]}
        info = ar.apply(r)
        self.assertEqual(info['segments_fixed'], 0)
        self.assertEqual(r['text'], '원래 있던 글')

    def test_시각을_건드리지_않는다(self):
        """★시각이 흔들리면 자막과 더빙 자리가 전부 어긋난다."""
        r = self.result()
        before = [(s['start'], s['end']) for s in r['segments']]
        ar.apply(r)
        self.assertEqual([(s['start'], s['end']) for s in r['segments']], before)

    def test_구간이_없어도_터지지_않는다(self):
        self.assertEqual(ar.apply({})['segments_fixed'], 0)
        self.assertEqual(ar.apply({'segments': []})['cross_segment_runs'], [])


if __name__ == '__main__':
    unittest.main()
