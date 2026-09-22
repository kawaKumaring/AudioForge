# -*- coding: utf-8 -*-
"""silence_snap.py 단위 검사 — 지어낸 신호만 쓴다. 모델도 사용자 소리도 쓰지 않는다.

실행: python -X utf8 python/test_silence_snap.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    HAVE_NP = True
except Exception:
    HAVE_NP = False

import silence_snap as ss


def tone(seconds, sr=16000, amp=0.5, freq=220.0):
    t = np.arange(int(sr * seconds)) / float(sr)
    return (np.sin(2 * np.pi * freq * t) * amp).astype(np.float64)


def quiet(seconds, sr=16000, amp=0.0):
    return np.full(int(sr * seconds), amp, dtype=np.float64)


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test크기_지도(unittest.TestCase):
    def test_조용한_곳과_큰_곳이_갈린다(self):
        y = np.concatenate([quiet(1.0), tone(1.0), quiet(1.0)])
        loud = ss.loudness_map(y, 16000)
        n = len(loud) // 3
        self.assertLess(loud[:n].mean(), 0.01)
        self.assertGreater(loud[n:2 * n].mean(), 0.2)

    def test_클릭음_하나가_기준을_망치지_않는다(self):
        """★최댓값으로 나누면 나머지가 전부 조용해진다. 상위 0.1% 값을 쓴다."""
        y = np.concatenate([quiet(0.5), tone(2.0, amp=0.3), quiet(0.5)])
        before = ss.loudness_map(y, 16000)
        spiked = y.copy()
        spiked[len(spiked) // 2] = 1.0        # 한 표본만 최대
        after = ss.loudness_map(spiked, 16000)
        self.assertAlmostEqual(before.mean(), after.mean(), delta=0.05,
                               msg='클릭음 하나에 기준이 흔들렸다')

    def test_한_칸이_이십밀리초다(self):
        loud = ss.loudness_map(tone(1.0), 16000)
        self.assertEqual(len(loud), 50)

    def test_실효값으로도_잴_수_있다(self):
        y = np.concatenate([quiet(0.5), tone(0.5), quiet(0.5)])
        rms = ss.loudness_map(y, 16000, reduce=ss.REDUCE_RMS)
        peak = ss.loudness_map(y, 16000, reduce=ss.REDUCE_PEAK)
        self.assertEqual(len(rms), len(peak))
        self.assertLess(rms.max(), peak.max() + 1e-9, '실효값이 봉우리보다 클 수 없다')

    def test_통째로_조용하면_전부_0이다(self):
        self.assertEqual(ss.loudness_map(quiet(1.0), 16000).max(), 0.0)

    def test_너무_짧으면_빈_것을_돌려준다(self):
        self.assertEqual(len(ss.loudness_map(np.zeros(3), 16000)), 0)


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test무음_구간(unittest.TestCase):
    def audio(self):
        # 0~1초 조용 / 1~2초 소리 / 2~3초 조용 / 3~4초 소리
        return np.concatenate([quiet(1.0), tone(1.0), quiet(1.0), tone(1.0)])

    def test_무음을_찾아낸다(self):
        s, e = ss.silence_spans(self.audio(), 16000)
        self.assertEqual(len(s), 2)
        self.assertAlmostEqual(s[0], 0.0, delta=0.06)
        self.assertAlmostEqual(e[0], 1.0, delta=0.06)
        self.assertAlmostEqual(s[1], 2.0, delta=0.06)

    def test_짧은_클릭은_무음을_조각내지_않는다(self):
        """★클릭 하나로 무음이 둘로 갈리면 밀어 붙일 경계가 사라진다."""
        y = np.concatenate([quiet(1.0), tone(1.0), quiet(1.0)])
        y[int(16000 * 1.5) + 8000: int(16000 * 1.5) + 8000 + 160] = 0.9  # 10밀리초 클릭
        s, e = ss.silence_spans(y, 16000)
        long_ones = [(a, b) for a, b in zip(s, e) if b - a > 0.5]
        self.assertTrue(long_ones, '클릭 때문에 긴 무음이 사라졌다: %r' % list(zip(s, e)))

    def test_녹음이_작아도_같게_동작한다(self):
        """★절대 문턱이면 여기서 무너진다. 우리 무음 게이트의 약점이다."""
        y = self.audio()
        s1, e1 = ss.silence_spans(y, 16000)
        s2, e2 = ss.silence_spans(y * 0.05, 16000)     # 26dB 작게
        self.assertEqual(len(s1), len(s2))
        self.assertAlmostEqual(s1[1], s2[1], delta=0.06)

    def test_내내_소리면_무음이_없다(self):
        s, e = ss.silence_spans(tone(2.0), 16000)
        self.assertEqual(len(s), 0)

    def test_아주_짧은_무음은_세지_않는다(self):
        y = np.concatenate([tone(1.0), quiet(0.04), tone(1.0)])
        s, _ = ss.silence_spans(y, 16000)
        self.assertEqual(len(s), 0)


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test시각_밀기(unittest.TestCase):
    def spans(self):
        # 무음: 0.0~1.0 그리고 2.0~3.0
        return np.array([0.0, 2.0]), np.array([1.0, 3.0])

    def test_시작이_무음_안이면_무음_끝으로_민다(self):
        """★알아듣기가 말보다 먼저 시작했다고 하는 대표 오류."""
        s, e = self.spans()
        a, b, what = ss.snap_span(0.4, 1.8, s, e, max_shift=None)
        self.assertEqual(what, 'start')
        self.assertAlmostEqual(a, 1.0)
        self.assertAlmostEqual(b, 1.8, msg='끝은 건드리지 않는다')

    def test_끝이_무음_안이면_무음_시작으로_당긴다(self):
        s, e = self.spans()
        a, b, what = ss.snap_span(1.2, 2.5, s, e, max_shift=None)
        self.assertEqual(what, 'end')
        self.assertAlmostEqual(b, 2.0)
        self.assertAlmostEqual(a, 1.2)

    def test_시작만_고치게_할_수_있다(self):
        s, e = self.spans()
        _, b, what = ss.snap_span(1.2, 2.5, s, e, keep_end=True, max_shift=None)
        self.assertEqual(what, '')
        self.assertAlmostEqual(b, 2.5)

    def test_최소_길이_아래로_줄이지_않는다(self):
        s, e = self.spans()
        a, b, _ = ss.snap_span(0.9, 1.05, s, e, min_dur=0.1)
        self.assertGreaterEqual(round(b - a, 6), 0.1 - 1e-9)

    def test_무음을_통째로_품으면_덜_삐져나온_쪽을_고친다(self):
        # 무음 2.0~3.0(1초). 시작이 0.05초 앞(5%), 끝이 0.5초 뒤(50%) → 시작을 고친다
        s, e = np.array([2.0]), np.array([3.0])
        a, b, what = ss.snap_span(1.95, 3.5, s, e, max_shift=None)
        self.assertEqual(what, 'start')
        self.assertAlmostEqual(a, 3.0)

    def test_양쪽_다_많이_삐져나오면_손대지_않는다(self):
        """★허용치를 넘으면 억지로 밀지 않는다 — 진짜 말이 들어 있다."""
        s, e = np.array([2.0]), np.array([2.2])
        a, b, what = ss.snap_span(1.0, 4.0, s, e)
        self.assertEqual(what, '')
        self.assertAlmostEqual(a, 1.0)
        self.assertAlmostEqual(b, 4.0)

    def test_무음이_둘_이상_들어_있으면_손대지_않는다(self):
        """★여러 말이 든 구간이다 — 어느 경계로 밀어야 할지 알 수 없다."""
        s, e = np.array([1.2, 2.2]), np.array([1.4, 2.4])
        _, _, what = ss.snap_span(1.0, 3.0, s, e)
        self.assertEqual(what, '')

    def test_무음이_없으면_그대로다(self):
        a, b, what = ss.snap_span(1.0, 2.0, np.zeros(0), np.zeros(0))
        self.assertEqual((a, b, what), (1.0, 2.0, ''))

    def test_이미_소리_위에_있으면_그대로다(self):
        s, e = self.spans()
        a, b, what = ss.snap_span(1.2, 1.8, s, e)
        self.assertEqual(what, '')


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test구간_전체에_적용(unittest.TestCase):
    def test_글을_건드리지_않는다(self):
        segs = [{'start': 0.4, 'end': 1.8, 'text': '안녕하세요'}]
        ss.snap_segments(segs, np.array([0.0]), np.array([1.0]))
        self.assertEqual(segs[0]['text'], '안녕하세요')

    def test_낱말_시각도_함께_민다(self):
        segs = [{'start': 0.4, 'end': 1.8, 'text': 'x',
                 'words': [{'word': 'a', 'start': 0.4, 'end': 1.2}]}]
        ss.snap_segments(segs, np.array([0.0]), np.array([1.0]), max_shift=None)
        self.assertAlmostEqual(segs[0]['words'][0]['start'], 1.0)

    def test_구간_차례를_흔들지_않는다(self):
        """★민 결과가 앞 구간과 엇갈리면 되돌린다 — 자막 차례가 깨진다."""
        segs = [{'start': 0.0, 'end': 2.5, 'text': 'a'},
                {'start': 1.0, 'end': 3.0, 'text': 'b'}]
        ss.snap_segments(segs, np.array([0.9]), np.array([1.1]))
        self.assertLessEqual(segs[0]['end'], segs[1]['end'])
        for s in segs:
            self.assertLessEqual(s['start'], s['end'])

    def test_한_일을_숫자로_돌려준다(self):
        segs = [{'start': 0.4, 'end': 1.8, 'text': 'x'}]
        info = ss.snap_segments(segs, np.array([0.0]), np.array([1.0]), max_shift=None)
        self.assertEqual(info['moved_start'], 1)
        self.assertGreater(info['median_shift'], 0.5)
        self.assertEqual(info['silences'], 1)

    def test_빈_목록도_터지지_않는다(self):
        info = ss.snap_segments([], np.zeros(0), np.zeros(0))
        self.assertEqual(info['moved_start'], 0)

    def test_낱말_시각이_없어도_터지지_않는다(self):
        segs = [{'start': 0.4, 'end': 1.8, 'words': [{'word': 'a'}]}]
        ss.snap_segments(segs, np.array([0.0]), np.array([1.0]))


@unittest.skipUnless(HAVE_NP, 'numpy 없음')
class Test이동_상한(unittest.TestCase):
    """★실측으로 붙인 빗장(2026-09-22).

    노래 한 곡(견줄 수 있는 구간 16개)으로 재 보니 상한이 없으면
    중앙 오차 490 → 400밀리초로 좋아지는데 **상위10%가 800 → 1290밀리초로 나빠졌다.**
    한 구간은 실제 소리가 139.04초에 시작하는데 말한 시각 139.14 를 139.84 로
    **0.8초나 지나쳐** 밀고 있었다 — 여린 시작을 무음으로 잘못 본 것이다.
    0.40초로 묶으면 중앙 490 → 460, 꼬리는 그대로였다.
    """

    def test_상한을_넘으면_밀지_않는다(self):
        s, e = np.array([0.0]), np.array([1.0])
        a, _, what = ss.snap_span(0.4, 1.8, s, e, max_shift=0.4)
        self.assertEqual(what, '', '0.6초를 밀려 했는데 상한 0.4초를 넘었다')
        self.assertAlmostEqual(a, 0.4)

    def test_상한_안이면_민다(self):
        s, e = np.array([0.0]), np.array([1.0])
        a, _, what = ss.snap_span(0.7, 1.8, s, e, max_shift=0.4)
        self.assertEqual(what, 'start')
        self.assertAlmostEqual(a, 1.0)

    def test_끝_밀기에도_상한이_걸린다(self):
        s, e = np.array([2.0]), np.array([3.0])
        _, b, what = ss.snap_span(1.2, 2.6, s, e, keep_end=False, max_shift=0.4)
        self.assertEqual(what, '', '0.6초를 당기려 했는데 상한을 넘었다')
        self.assertAlmostEqual(b, 2.6)

    def test_품은_무음에도_상한이_걸린다(self):
        s, e = np.array([2.0]), np.array([3.0])
        a, _, what = ss.snap_span(1.95, 3.5, s, e, max_shift=0.4)
        self.assertEqual(what, '', '1.05초를 밀려 했는데 상한을 넘었다')
        self.assertAlmostEqual(a, 1.95)

    def test_기본값이_상한을_켜_둔다(self):
        self.assertIsNotNone(ss.MAX_SHIFT_SEC)
        s, e = np.array([0.0]), np.array([1.0])
        _, _, what = ss.snap_span(0.4, 1.8, s, e)
        self.assertEqual(what, '', '기본으로 상한이 걸려 있어야 한다')

    def test_상한을_끄면_민다(self):
        s, e = np.array([0.0]), np.array([1.0])
        _, _, what = ss.snap_span(0.4, 1.8, s, e, max_shift=None)
        self.assertEqual(what, 'start')


if __name__ == '__main__':
    unittest.main()
