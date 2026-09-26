# -*- coding: utf-8 -*-
"""텍스트 추출의 자막 쓰기 검사 — 모델도 소리도 쓰지 않는다. 글자와 시각만 본다.

왜 있는가(2026-09-22): 자막 만드는 자리가 둘(더빙·텍스트 추출)이었는데
텍스트 추출 쪽만 손질을 안 거치고 있었다. 이제 둘 다 subtitle_cues 를 지난다.
그 배선이 조용히 풀리지 않게 붙잡아 둔다.

실행: python -X utf8 python/test_transcribe_srt.py
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import subtitle_cues as sc
import transcribe_worker as tw


def _write(segments):
    d = tempfile.mkdtemp(prefix='af-srt-')
    path = os.path.join(d, 'out.srt')
    tw._write_srt(segments, path)
    with open(path, encoding='utf-8') as f:
        return f.read()


class Test자막_손질을_거친다(unittest.TestCase):
    def test_긴_줄이_나뉜다(self):
        """★예전엔 구간 하나가 자막 한 줄 그대로였다."""
        body = _write([{'start': 0.0, 'end': 5.0, 'text': '가' * 35}])
        lines = [l for l in body.split('\n') if l and '-->' not in l and not l.isdigit()]
        self.assertGreater(len(lines), 1, '나뉘지 않았다: %r' % body)
        for l in lines:
            self.assertLessEqual(len(l), sc.MAX_LINE_CHARS)

    def test_너무_짧은_자막이_늘어난다(self):
        body = _write([{'start': 0.0, 'end': 0.2, 'text': '짧다'},
                       {'start': 9.0, 'end': 10.0, 'text': '다음'}])
        first = [l for l in body.split('\n') if '-->' in l][0]
        end = first.split('-->')[1].strip()
        self.assertNotEqual(end, '00:00:00,200', '노출 시간을 늘리지 않았다')

    def test_시각_표기를_새로_짜지_않는다(self):
        """★59.9996초를 '00:00:60,000' 으로 찍던 버그를 되살리지 않는다."""
        body = _write([{'start': 59.9996, 'end': 62.0, 'text': '경계'}])
        self.assertIn('00:01:00,000', body)
        self.assertNotIn('00:00:60,000', body)


class Test글의_문자_종류에_맞춘다(unittest.TestCase):
    """★이 경로의 자막은 한국어가 아니라 **원래 말한 언어**다."""

    def test_영어는_넓은_상한을_쓴다(self):
        text = 'The wind comes over the hill and carries the sound of the sea'
        body = _write([{'start': 0.0, 'end': 6.0, 'text': text}])
        lines = [l for l in body.split('\n') if l and '-->' not in l and not l.isdigit()]
        longest = max(len(l) for l in lines)
        self.assertGreater(longest, sc.MAX_LINE_CHARS,
                           '영어에 한글 상한(20자)을 쓰면 문장이 두 동강 난다')
        self.assertLessEqual(longest, sc.LATIN_MAX_LINE_CHARS)

    def test_일본어는_좁은_상한을_쓴다(self):
        body = _write([{'start': 0.0, 'end': 6.0, 'text': '風' * 35}])
        lines = [l for l in body.split('\n') if l and '-->' not in l and not l.isdigit()]
        self.assertLessEqual(max(len(l) for l in lines), sc.MAX_LINE_CHARS)


class Test상한_고르기(unittest.TestCase):
    def test_한국어_일본어_중국어는_빽빽하다(self):
        for t in ('바람이 불어오는', '風が吹いてくる', '风吹过来了'):
            self.assertTrue(sc.is_dense_script(t), t)

    def test_영어는_빽빽하지_않다(self):
        self.assertFalse(sc.is_dense_script('The wind comes over the hill'))

    def test_고유명사_하나로는_뒤집히지_않는다(self):
        self.assertFalse(sc.is_dense_script(
            'We met in Tokyo and walked along the river until the evening came'))

    def test_빈_글은_넓은_상한(self):
        self.assertEqual(sc.pick_limits('')['max_chars'], sc.LATIN_MAX_LINE_CHARS)


class Test손질이_안_되어도_자막을_잃지_않는다(unittest.TestCase):
    def test_손질이_터져도_파일은_쓰인다(self):
        real = sc.build_cues

        def boom(*a, **k):
            raise RuntimeError('일부러 터뜨림')

        sc.build_cues = boom
        try:
            body = _write([{'start': 0.0, 'end': 2.0, 'text': '살아남아야 한다'}])
        finally:
            sc.build_cues = real
        self.assertIn('살아남아야 한다', body)
        self.assertIn('-->', body)

    def test_구간이_없으면_빈_파일(self):
        self.assertEqual(_write([]).strip(), '')


if __name__ == '__main__':
    unittest.main()
