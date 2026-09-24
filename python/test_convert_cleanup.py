# -*- coding: utf-8 -*-
"""변환이 **실패해도 사용자 원본 사본을 남기지 않는지** 본다.

★왜 있는가(2026-09-24 2차 감사)
  `convert_to_wav` 는 원본을 통째로 임시 폴더에 복사한 뒤 ffmpeg 를 돌린다.
  예전에는 ffmpeg 가 실패하면 **바로 raise** 했고 정리 코드는 raise 뒤에 있어
  한 번도 실행되지 않았다. 호출부 여섯 곳도 이 함수가 값을 돌려준 **뒤에**
  try 를 열기 때문에 호출부 정리도 닿지 않았다.

  결과: 코덱이 안 맞거나 파일이 깨질 때마다 **원본과 바이트가 같은 사본**이
  공용 임시 폴더에 쌓였다. 더빙은 **영상 파일을 통째로** 이 함수에 넣는다.

  사용자 소리·영상을 함부로 남기지 않는 것이 이 저장소의 최우선 원칙이라
  이것은 용량 문제가 아니라 **원칙 문제**다.

실행: python -X utf8 python/test_convert_cleanup.py
"""
import glob
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import audio_utils

HAS_FFMPEG = bool(audio_utils.find_ffmpeg())


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg 없음')
class Test변환_실패_뒤처리(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.gettempdir()
        self.before = set(glob.glob(os.path.join(self.tmp, 'audioforge_*')))
        self.work = tempfile.mkdtemp(prefix='af-cleanup-test-')

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def leaked(self):
        return set(glob.glob(os.path.join(self.tmp, 'audioforge_*'))) - self.before

    def test_변환이_실패하면_아무것도_남기지_않는다(self):
        bad = os.path.join(self.work, 'broken.wav')
        with open(bad, 'wb') as f:
            f.write(b'this is not audio at all' * 100)
        with self.assertRaises(Exception):
            audio_utils.convert_to_wav(bad)
        left = self.leaked()
        self.assertEqual(left, set(),
                         '실패 뒤 남은 임시 폴더: %s' % sorted(left))

    def test_입력이_아예_없어도_남기지_않는다(self):
        missing = os.path.join(self.work, '없는파일.wav')
        with self.assertRaises(Exception):
            audio_utils.convert_to_wav(missing)
        self.assertEqual(self.leaked(), set())

    def test_성공하면_결과가_임시_폴더_안에_남는다(self):
        """★성공 갈래까지 지우면 결과를 잃는다 — 지우는 것은 실패했을 때뿐이다."""
        import numpy as np
        import soundfile as sf
        src = os.path.join(self.work, 'ok.wav')
        sf.write(src, np.zeros(1600, dtype='float32'), 16000)
        out = audio_utils.convert_to_wav(src)
        try:
            self.assertTrue(os.path.isfile(out), '결과가 있어야 한다')
            # 원본 사본은 지워지고 변환 결과만 남는다.
            self.assertEqual(sorted(os.listdir(os.path.dirname(out))), ['converted.wav'])
        finally:
            shutil.rmtree(os.path.dirname(out), ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
