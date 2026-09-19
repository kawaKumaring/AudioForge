# -*- coding: utf-8 -*-
"""audio_fit.py 단위 검사 — 저장소 fixture 음성과 합성 신호만 쓴다(사용자 미디어 미사용).

실행: python -X utf8 python/test_audio_fit.py
  ★`-m unittest python/...` 는 이 파이썬에서 'No module named python' 으로 죽는다.
    게이트(scripts/python-tests.mjs)도 파일을 직접 돌린다.

의존이 없으면(soundfile·numpy·librosa) 해당 검사를 **건너뛰고 그 사실을 남긴다.**
건너뛴 것을 통과로 주장하지 않는다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')

try:
    import soundfile as sf
    import numpy as np
    HAVE_SF = True
except Exception:
    HAVE_SF = False

try:
    import librosa            # 음높이 확인에만 쓴다
    HAVE_LIBROSA = True
except Exception:
    HAVE_LIBROSA = False

import audio_fit


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestProbeDuration(unittest.TestCase):
    def test_길이를_초로_돌려준다(self):
        sec = audio_fit.probe_duration(FIXTURE)
        self.assertGreater(sec, 1.0)
        self.assertLess(sec, 60.0)

    def test_없는_파일은_사유와_함께_실패한다(self):
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.probe_duration(os.path.join(REPO, 'no-such-file.wav'))


if __name__ == '__main__':
    unittest.main()
