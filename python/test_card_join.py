# -*- coding: utf-8 -*-
"""생성본 이어 붙이기 — **원본을 건드리지 않고, 말끝을 자르지 않는가.**

2026-09-27 지시 4항 ⑥: "서로 다른 레이트/채널의 짧은 검사 WAV로
순서·간격·길이·클리핑·끝부분 보존을 자동 검사."
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import soundfile as sf

import card_join


def tone(path, seconds, rate, channels=1, freq=220.0, amp=0.5):
    n = int(rate * seconds)
    t = np.arange(n, dtype="float64") / float(rate)
    x = (amp * np.sin(2 * np.pi * freq * t)).astype("float32")
    data = np.repeat(x.reshape(-1, 1), channels, axis=1)
    sf.write(path, data, rate, subtype="PCM_16")
    return path


class JoinTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="cardjoin_")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def plan(self, steps, **over):
        p = {"steps": steps, "level": False, "edges": False,
             "output": os.path.join(self.dir, "out.wav")}
        p.update(over)
        return p

    def test_순서와_간격이_길이에_그대로_나온다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.5, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.3, 24000)
        r = card_join.join(self.plan([
            {"path": a, "gapBefore": 0},
            {"path": b, "gapBefore": 0.2},
        ]))
        self.assertTrue(r["ok"])
        # 0.5 + 0.2(빈 자리) + 0.3 = 1.0
        self.assertAlmostEqual(r["seconds"], 1.0, places=2)
        self.assertEqual(r["pieces"], 2)

    def test_레이트가_달라도_길이가_변하지_않는다(self):
        """★속도·음높이가 바뀌면 길이가 어긋난다. 길이로 그것을 잡는다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.5, 22050)
        b = tone(os.path.join(self.dir, "b.wav"), 0.5, 48000)
        r = card_join.join(self.plan([
            {"path": a, "gapBefore": 0},
            {"path": b, "gapBefore": 0},
        ]))
        self.assertAlmostEqual(r["seconds"], 1.0, places=2)
        self.assertEqual(r["sampleRate"], 48000, "높은 쪽으로 맞춰야 있던 소리를 잃지 않는다")

    def test_채널이_달라도_이어진다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, 24000, channels=1)
        b = tone(os.path.join(self.dir, "b.wav"), 0.4, 24000, channels=2)
        r = card_join.join(self.plan([
            {"path": a, "gapBefore": 0},
            {"path": b, "gapBefore": 0},
        ]))
        self.assertEqual(r["channels"], 2)
        self.assertAlmostEqual(r["seconds"], 0.8, places=2)

    def test_원본_생성본을_건드리지_않는다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.4, 24000, amp=0.1)
        before = [(p, os.path.getsize(p), open(p, "rb").read()) for p in (a, b)]
        card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                  {"path": b, "gapBefore": 0.1}], level=True, edges=True))
        for p, size, raw in before:
            self.assertEqual(os.path.getsize(p), size, "원본 크기가 바뀌었다")
            with open(p, "rb") as fh:
                self.assertEqual(fh.read(), raw, "원본 내용이 바뀌었다 — 읽기만 해야 한다")

    def test_끝부분을_자르지_않는다(self):
        """★경계 다듬기를 켜도 **길이는 그대로**다. 말끝을 깎아 맞추지 않는다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.5, 24000)
        plain = card_join.join(self.plan([{"path": a, "gapBefore": 0}]))
        shaped = card_join.join(self.plan([{"path": a, "gapBefore": 0}], edges=True,
                                          output=os.path.join(self.dir, "out2.wav")))
        self.assertAlmostEqual(plain["seconds"], shaped["seconds"], places=3)

    def test_소리를_겹치지_않는다(self):
        """간격 0 이어도 앞 조각의 끝과 뒤 조각의 시작이 **겹치지 않는다**(길이가 합과 같다)."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.5, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.5, 24000)
        r = card_join.join(self.plan([{"path": a, "gapBefore": 0}, {"path": b, "gapBefore": 0}]))
        self.assertAlmostEqual(r["seconds"], 1.0, places=3,
                              msg="겹쳤다면 합보다 짧아진다")

    def test_음량_맞추기가_피크를_넘기지_않는다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, 24000, amp=0.95)
        b = tone(os.path.join(self.dir, "b.wav"), 0.4, 24000, amp=0.05)
        r = card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}], level=True))
        self.assertLessEqual(r["peak"], card_join.PEAK_CEIL + 1e-3, "깨질 만큼 커졌다")

    def test_음량_맞추기가_작은_조각을_끌어올린다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, 24000, amp=0.5)
        b = tone(os.path.join(self.dir, "b.wav"), 0.4, 24000, amp=0.05)
        out = card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                        {"path": b, "gapBefore": 0}], level=True))["path"]
        data, rate = sf.read(out, dtype="float32", always_2d=True)
        half = data.shape[0] // 2
        first = float(np.sqrt(np.mean(np.square(data[:half], dtype="float64"))))
        second = float(np.sqrt(np.mean(np.square(data[half:], dtype="float64"))))
        self.assertGreater(second, 0.02, "작은 쪽이 그대로 묻혀 있다")
        self.assertLess(abs(20 * np.log10(first / max(second, 1e-9))), 12.0,
                        "음량 차이가 여전히 크다")

    def test_없는_파일은_조용히_건너뛰지_않는다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.3, 24000)
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": os.path.join(self.dir, "없다.wav"), "gapBefore": 0}]))

    def test_계획이_비면_만들지_않는다(self):
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([]))

    def test_같은_계획은_같은_결과다(self):
        """★미리듣기와 저장이 같은 계획을 쓰므로, 같은 계획은 같은 소리여야 한다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.3, 22050)
        b = tone(os.path.join(self.dir, "b.wav"), 0.3, 48000, channels=2)
        steps = [{"path": a, "gapBefore": 0}, {"path": b, "gapBefore": 0.15}]
        one = card_join.join(self.plan(steps, level=True, edges=True,
                                       output=os.path.join(self.dir, "one.wav")))["path"]
        two = card_join.join(self.plan(steps, level=True, edges=True,
                                       output=os.path.join(self.dir, "two.wav")))["path"]
        with open(one, "rb") as f1, open(two, "rb") as f2:
            self.assertEqual(f1.read(), f2.read(), "미리 들은 것과 저장한 것이 다르다")

    def test_다시_저장해도_이전_결과를_덮어쓰지_않는다(self):
        """저장 자리를 다르게 주면 앞의 것은 그대로 있다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.3, 24000)
        first = card_join.join(self.plan([{"path": a, "gapBefore": 0}],
                                         output=os.path.join(self.dir, "keep.wav")))["path"]
        size = os.path.getsize(first)
        card_join.join(self.plan([{"path": a, "gapBefore": 0}],
                                 output=os.path.join(self.dir, "other.wav")))
        self.assertEqual(os.path.getsize(first), size)


if __name__ == "__main__":
    unittest.main(verbosity=2)
