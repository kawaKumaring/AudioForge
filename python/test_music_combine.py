# -*- coding: utf-8 -*-
"""두 모델 결과를 합치는 방식 — **평균이냐, 주파수별로 고르느냐.**

★왜 고르는 길을 넣었나 (2026-09-26, UVR 구현을 읽고)
  평균은 한쪽에만 나타난 것(= 그 모델의 오류)을 **절반으로 줄일 뿐 없애지 못한다.**
  UVR 은 주파수 칸마다 **작은 쪽**을 고른다 — 한쪽에만 크게 나타난 것은
  그 모델의 오류일 가능성이 높으므로 버려진다.
  사용자 신고가 "찢어진다"(= artifact) 이므로 기제가 맞는다.

★이 검사가 유난히 모양을 따지는 이유
  처음 구현에서 **축을 돌려 넣었다가 채널이 0인 빈 결과**를 얻었다.
  UVR 안의 다른 자리가 `.T` 를 쓰기에 따라 했는데, **그쪽 입력이 (샘플, 채널)** 이라
  그랬던 것이다. 맥락을 안 보고 형태만 베낀 실수다.
  소리로 확인하지 않았으면 조용히 빈 소리를 저장했을 것이다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import music_worker as mw  # noqa: E402


def _two(channels=2, n=44100 * 2, sr=44100):
    """검사용 두 소리. 한쪽에만 **튀는 잡음**을 심는다 — 그것이 버려져야 한다."""
    import numpy as np
    t = np.arange(n) / float(sr)
    base = np.vstack([np.sin(2 * np.pi * 220 * t) * 0.3 for _ in range(channels)])
    a = base.copy()
    b = base.copy()
    # a 에만 짧고 큰 잡음 — 한쪽 모델의 오류를 흉내 낸다
    a[:, n // 2: n // 2 + 400] += 0.9
    return a.astype('float32'), b.astype('float32')


class TestShapeIsKept(unittest.TestCase):
    """★채널이 사라지면 소리가 통째로 빈다. 실제로 그렇게 만들었다가 잡았다."""

    def test_채널_수가_유지된다(self):
        for ch in (1, 2):
            a, b = _two(channels=ch)
            for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
                r = mw.combine_two(a, b, mode)
                self.assertEqual(r.shape[0], ch,
                                 '%s: 채널이 %d → %d 로 바뀌었다' % (mode, ch, r.shape[0]))

    def test_길이가_크게_줄지_않는다(self):
        """되돌릴 때 한두 샘플은 어긋난다. 그러나 **토막 나면 안 된다.**"""
        a, b = _two()
        for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
            r = mw.combine_two(a, b, mode)
            self.assertGreater(r.shape[-1], a.shape[-1] * 0.99,
                               '%s: 길이가 %d → %d 로 줄었다' % (mode, a.shape[-1], r.shape[-1]))

    def test_유한한_값만_나온다(self):
        import numpy as np
        a, b = _two()
        for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
            r = mw.combine_two(a, b, mode)
            self.assertTrue(bool(np.all(np.isfinite(r))), '%s: NaN/Inf 가 나왔다' % mode)


class TestMinSpecDropsOneSidedNoise(unittest.TestCase):
    """★이 방식을 넣은 이유 그 자체 — 한쪽에만 있는 것을 버리는가."""

    def test_한쪽에만_있는_잡음이_평균보다_덜_남는다(self):
        import numpy as np
        a, b = _two()
        n = a.shape[-1]
        lo, hi = n // 2 - 200, n // 2 + 600      # 잡음을 심은 자리 언저리
        avg = mw.combine_two(a, b, mw.COMBINE_AVG)[:, lo:hi]
        mns = mw.combine_two(a, b, mw.COMBINE_MIN_SPEC)[:, lo:hi]
        pa = float(np.max(np.abs(avg)))
        pm = float(np.max(np.abs(mns)))
        self.assertLess(pm, pa,
                        '작은 쪽 고르기가 한쪽 잡음을 평균보다 더 남긴다: %.3f >= %.3f'
                        % (pm, pa))


class TestRealCallPath(unittest.TestCase):
    """★검사는 **제품이 쓰는 길**로 들어가야 한다.

      처음 검사는 numpy 배열을 직접 만들어 넣어 통과했다. 그런데 제품은 앱의
      `load_audio` 를 쓰고, 그것은 **torch 텐서**를 돌려준다.
      스펙트럼 함수는 numpy 만 받으므로 **실제로 돌리자마자 터졌다.**
      검사가 다른 길로 들어가면 통과가 아무것도 보장하지 않는다.
    """

    def test_텐서를_넣어도_된다(self):
        import torch
        a, b = _two()
        ta, tb = torch.from_numpy(a), torch.from_numpy(b)
        for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
            r = mw.combine_two(ta, tb, mode)
            self.assertEqual(r.shape[0], a.shape[0], '%s: 채널이 바뀌었다' % mode)

    def test_받은_형식_그대로_돌려준다(self):
        """형식이 바뀌면 부르는 쪽이 조용히 깨진다."""
        import numpy as np, torch
        a, b = _two()
        for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
            self.assertIsInstance(mw.combine_two(a, b, mode), np.ndarray,
                                  '%s: numpy 를 넣었는데 다른 것이 나온다' % mode)
            got = mw.combine_two(torch.from_numpy(a), torch.from_numpy(b), mode)
            self.assertTrue(hasattr(got, 'detach'),
                            '%s: 텐서를 넣었는데 텐서가 아닌 것이 나온다' % mode)

    def test_저장까지_간다(self):
        """★마지막까지 가 봐야 안다 — 여기서 터졌다."""
        import tempfile, torch
        from audio_utils import save_audio
        a, b = _two()
        d = tempfile.mkdtemp(prefix='afmc-')
        for mode in (mw.COMBINE_AVG, mw.COMBINE_MIN_SPEC):
            r = mw.combine_two(torch.from_numpy(a), torch.from_numpy(b), mode)
            out = os.path.join(d, '%s.wav' % mode)
            save_audio(out, r, 44100)
            self.assertTrue(os.path.isfile(out), '%s: 저장되지 않았다' % mode)

class TestDefaultUnchanged(unittest.TestCase):
    """★잘 쓰이고 있는 음악 분리를 말없이 바꾸지 않는다."""

    def test_기본은_평균이다(self):
        self.assertEqual(mw.COMBINE_DEFAULT, mw.COMBINE_AVG,
                         '기본을 바꾸면 음악 분리 결과가 말없이 달라진다')

    def test_모르는_이름은_평균으로_간다(self):
        import numpy as np
        a, b = _two()
        r = mw.combine_two(a, b, '없는방식')
        self.assertTrue(np.allclose(r, (a + b) / 2.0),
                        '모르는 값에 엉뚱한 일을 한다')

    def test_고를_수_있는_길이_열려_있다(self):
        import inspect
        self.assertIn('combine',
                      inspect.signature(mw.run_roformer_ensemble).parameters,
                      '앙상블에서 방식을 고를 수 없다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
