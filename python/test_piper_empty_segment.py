# -*- coding: utf-8 -*-
"""기본 목소리(piper) — 읽을 소리가 없는 토막에서 죽지 않는다.

★2026-09-30 사용자 신고("기본음성 … 안 된다")를 재현해 찾았다.
  기호만 있는 줄(◆◇◆ · …… · ─── · “”)이 따로 토막이 되면 piper 가 소리를 한 조각도 내지 않고,
  형식이 정해지지 않은 채 소리 파일을 닫다가 "# channels not specified" 로 덩이 전체가 죽었다.
  소설의 장면 구분 줄이 이 모양이다.

실제 piper 목소리로 본다 — 모형으로는 이 결함이 보이지 않는다(형식을 정하는 것이 piper 안이다).
목소리가 설치되지 않은 환경에서는 건너뛴다.
"""
import os
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import piper  # noqa: F401
    import piper_voices as pv
    HAVE = pv.find("ko") is not None
except Exception:
    HAVE = False


@unittest.skipUnless(HAVE, "piper 한국어 목소리가 없는 환경")
class Test읽을_소리가_없는_토막(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tts_worker
        cls.engine = tts_worker.PiperEngine()
        cls.engine.load()
        cls.dir = tempfile.mkdtemp(prefix="audioforge_piper_empty_")

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.dir, ignore_errors=True)

    def _say(self, name, text):
        out = os.path.join(self.dir, name + ".wav")
        self.engine.synthesize_segment(text, None, None, 1.0, out)
        with wave.open(out, "rb") as r:
            return r.getnframes() / float(r.getframerate()), r.getnchannels()

    def test_기호만_있는_토막은_죽지_않고_짧게_쉰다(self):
        for i, text in enumerate(["◆◇◆", "……", "───", "“”"]):
            sec, ch = self._say("empty%d" % i, text)
            self.assertEqual(ch, 1, text)
            self.assertAlmostEqual(sec, self.engine.EMPTY_PAUSE_SEC, delta=0.02, msg=text)

    def test_말이_있는_토막은_예전처럼_소리가_난다(self):
        sec, ch = self._say("plain", "그는 문을 열었다.")
        self.assertEqual(ch, 1)
        self.assertGreater(sec, 0.5, "말이 있는데 쉼만 났다 — 형식을 먼저 정한 것이 소리를 막았다")


if __name__ == "__main__":
    unittest.main()
