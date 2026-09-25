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


class TestRecordHasNoPaths(unittest.TestCase):
    """★3차 감사에서 내가 낸 결함(2026-09-25).

    이 벤치가 남기는 기록의 `stderr_tail` 에 **절대 경로가 그대로** 들어가고 있었다.
    파이썬 오류에는 사용자 입력 파일 경로도 실린다.
    그리고 위의 "본문을 기록에 넣지 않는다" 검사는 **그 칸을 보지 않았다** —
    못 보는 검사였다. 그래서 값이 아니라 **씻는 함수 자체**를 여기서 확인한다.

    ★재료를 글자로 조립한다: 역슬래시가 소스를 오가며 한 겹 먹혀
      검사 재료가 조용히 UNC 가 아니게 되는 일을 이미 겪었다.
    """

    def setUp(self):
        self.B = chr(92)

    def _p(self, *parts):
        return self.B.join(parts)

    def test_드라이브_경로는_이름만_남는다(self):
        t = bench_tts._no_paths('열 수 없음: ' + self._p('E:', '비밀작업', '면담.wav'))
        self.assertIn('면담.wav', t, '무슨 파일인지까지 지우면 진단이 안 된다')
        self.assertNotIn('비밀작업', t, '폴더가 남았다: %s' % t)

    def test_UNC_경로도_지운다(self):
        unc = self.B + self._p('', '사내서버', '공유', 'a.wav')
        t = bench_tts._no_paths('없음: ' + unc)
        self.assertNotIn('사내서버', t, '서버 이름이 남았다: %s' % t)
        self.assertIn('a.wav', t)

    def test_POSIX_경로도_지운다(self):
        t = bench_tts._no_paths('없음: /home/someone/비밀/b.wav')
        self.assertNotIn('someone', t, t)
        self.assertNotIn('비밀', t, t)
        self.assertIn('b.wav', t)

    def test_경로가_없으면_건드리지_않는다(self):
        t = '합성을 시작하지 못했습니다(GPU 메모리 부족)'
        self.assertEqual(bench_tts._no_paths(t), t)

    def test_빈_값도_견딘다(self):
        self.assertEqual(bench_tts._no_paths(''), '')
        self.assertIsNone(bench_tts._no_paths(None))

    def test_기록으로_나가는_칸이_전부_씻긴다(self):
        """어느 칸을 빠뜨리면 그 칸으로 샌다 — 빠뜨린 것이 바로 이번 결함이다."""
        src = io.open(os.path.join(HERE, 'bench_tts.py'), encoding='utf-8').read()
        at = src.index('def run_once')
        ret = src[src.index('return {', at):src.index('def main')]
        for field in ('stderr_tail', 'error'):
            line = [l for l in ret.split(chr(10)) if field in l]
            self.assertTrue(line, '%s 칸이 사라졌다' % field)
            self.assertIn('_no_paths', ' '.join(line), '%s 를 씻지 않고 적는다' % field)


# ★이 블록은 **파일 맨 끝**에 있어야 한다. 중간에 두면 아래 검사가
#   아직 만들어지지 않은 채 돌아 **조용히 빠진다**. 이 세션에서 이미 한 번 겪었고
#   방금 또 그랬다 — 새 검사 6건이 한 번도 안 돌 뻔했다.
if __name__ == '__main__':
    unittest.main(verbosity=2)
