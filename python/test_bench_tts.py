# -*- coding: utf-8 -*-
"""합성 속도 벤치의 계약 — **사용자 미디어를 쓰지 않는다**가 첫째다.

★왜(2026-09-25): 성능을 고치려면 같은 조건에서 두 번 잴 수 있어야 하는데,
  재려고 사용자 음원을 쓰면 규칙을 어기게 되고 조건도 매번 달라진다.
  그래서 참조 음성을 **만들어** 쓴다 — `bench_dialogue.py` 가 이미 쓴 길이다.

모델을 돌리지 않는다. 벤치가 무엇을 하기로 했는지만 본다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bench_tts  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class TestNoUserMedia(unittest.TestCase):
    def setUp(self):
        self.src = io.open(os.path.join(HERE, 'bench_tts.py'), encoding='utf-8').read()

    def test_참조를_만들어_쓴다(self):
        """사용자 음원을 고르는 통로가 없어야 한다."""
        self.assertIn('piper_voices', self.src, '참조를 만드는 길이 없다')
        for forbidden in ('showOpenDialog', 'input(', 'lastDir'):
            self.assertNotIn(forbidden, self.src, '사용자 파일을 받는 통로가 있다: %s' % forbidden)

    def test_대본은_우리가_쓴_것이다(self):
        self.assertTrue(bench_tts.SCRIPTS, '재료가 없다')
        for name, text in bench_tts.SCRIPTS.items():
            self.assertTrue(text.strip(), '%s: 대본이 비었다' % name)

    def test_길이가_다른_재료가_있다(self):
        """조각 수·생성 시간이 길이에 따라 어떻게 변하는지 보려면 둘 이상이어야 한다."""
        lens = sorted(len(t) for t in bench_tts.SCRIPTS.values())
        self.assertGreaterEqual(len(lens), 2)
        self.assertGreater(lens[-1], lens[0] * 2, '길이 차이가 너무 작아 기울기를 못 본다')


class TestReproducible(unittest.TestCase):
    """같은 조건에서 두 번 재려면 씨앗이 고정돼야 한다."""

    def setUp(self):
        self.src = io.open(os.path.join(HERE, 'bench_tts.py'), encoding='utf-8').read()

    def test_씨앗을_고정한다(self):
        self.assertIn('AUDIOFORGE_TTS_SEED', self.src, '씨앗을 고정하지 않으면 비교가 무의미하다')

    def test_앱과_같은_파이썬을_쓴다(self):
        """검사용 파이썬으로 재면 앱과 다른 결과가 나온다 — 이 저장소가 두 번 데인 곳이다."""
        self.assertIn('env.json', self.src)

    def test_결과_해시를_남긴다(self):
        """★속도만 재고 소리를 안 보면, 소리가 바뀐 개선을 개선으로 착각한다."""
        self.assertIn('sha256', self.src.lower())

    def test_찬_실행과_더운_실행을_나눈다(self):
        self.assertIn("'cold'", self.src, '첫 실행 여부를 남기지 않으면 캐시 효과가 결과에 섞인다')


class TestRecordsStayNonSensitive(unittest.TestCase):
    def test_본문을_기록에_넣지_않는다(self):
        """남기는 것은 수치와 해시뿐이다."""
        src = io.open(os.path.join(HERE, 'bench_tts.py'), encoding='utf-8').read()
        at = src.index('def run_once')
        body = src[at:src.index('def main')]
        self.assertNotIn("'text': text", body, '대본 본문을 기록에 넣는다')
        self.assertIn('out_name', body, '파일 이름만 남기는 자리가 없다')
        self.assertNotIn("'out_path'", body.split('return {')[-1],
                         '절대 경로를 기록에 넣는다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
