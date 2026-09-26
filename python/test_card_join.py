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

    def test_길이를_줄이거나_샘플을_버리지_않는다(self):
        """★경계 다듬기를 켜도 **길이는 그대로**다. 길이를 맞추려고 뒤를 잘라내지 않는다.

        ★이 검사가 말하지 **않는** 것(2026-09-27 검수 4항):
          길이가 같다는 것은 말끝·호흡이 들리는 대로 보존된다는 뜻이 **아니다.**
          5ms 기울기는 경계의 진폭을 낮춘다 — 그 크기는 아래 검사에서 수치로 고정한다.
        """
        a = tone(os.path.join(self.dir, "a.wav"), 0.5, 24000)
        plain = card_join.join(self.plan([{"path": a, "gapBefore": 0}]))
        shaped = card_join.join(self.plan([{"path": a, "gapBefore": 0}], edges=True,
                                          output=os.path.join(self.dir, "out2.wav")))
        self.assertAlmostEqual(plain["seconds"], shaped["seconds"], places=3)

    # ── 경계 다듬기가 실제로 무엇을 하는가 (2026-09-27 검수 4항) ──────────────
    def test_경계_다듬기를_끄면_소리가_그대로다(self):
        """★끄면 **한 샘플도 바뀌지 않는다.** 보존을 원하면 이것이 확실한 길이다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, 24000)
        out = card_join.join(self.plan([{"path": a, "gapBefore": 0}]))["path"]
        src, _ = sf.read(a, dtype="float32", always_2d=True)
        got, _ = sf.read(out, dtype="float32", always_2d=True)
        self.assertEqual(src.shape, got.shape)
        self.assertTrue(np.array_equal(src, got), "끄면 바뀌는 곳이 없어야 한다")

    def test_경계_다듬기는_끝_5ms_의_진폭을_낮춘다(self):
        """★'길이가 같으니 말끝이 보존된다' 는 말은 **사실이 아니다.**

        말소리가 경계까지 차 있으면 그 5ms 는 0 을 향해 내려간다. 그 크기를 수치로 남긴다
        (검수 재현값: 끝 5ms 의 RMS 0.5 → 약 0.2893, 선형 기울기의 이론값 1/sqrt(3)≈0.577배).
        이 검사는 **감쇠가 있다는 사실**을 고정한다. 들리는지 여부는 사람이 판단한다.
        """
        rate = 24000
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, rate, amp=0.5)
        out = card_join.join(self.plan([{"path": a, "gapBefore": 0}], edges=True))["path"]
        src, _ = sf.read(a, dtype="float32", always_2d=True)
        got, _ = sf.read(out, dtype="float32", always_2d=True)
        n = int(round(rate * card_join.EDGE_MS / 1000.0))
        rms = lambda x: float(np.sqrt(np.mean(np.square(x, dtype="float64"))))
        self.assertLess(rms(got[-n:]), rms(src[-n:]) * 0.75, "끝 5ms 가 낮아지지 않았다")
        self.assertGreater(rms(got[-n:]), rms(src[-n:]) * 0.4, "감쇠가 이론값보다 훨씬 크다")
        # ★5ms 밖은 손대지 않는다 — 말끝을 통째로 줄이는 처리가 아니다.
        self.assertTrue(np.allclose(got[n:-n], src[n:-n], atol=1e-6),
                        "경계 밖의 소리가 바뀌었다")

    def test_무음으로_끝나는_조각은_다듬어도_들리는_부분이_그대로다(self):
        """끝이 이미 조용하면 기울기를 걸어도 바뀌는 값이 없다 — 경계 종류를 나눠 본다."""
        rate = 24000
        a = tone(os.path.join(self.dir, "a.wav"), 0.4, rate, amp=0.5)
        data, _ = sf.read(a, dtype="float32", always_2d=True)
        n = int(round(rate * card_join.EDGE_MS / 1000.0))
        data[-n * 2:] = 0.0                       # 끝 10ms 를 무음으로
        quiet = os.path.join(self.dir, "quiet-tail.wav")
        sf.write(quiet, data, rate, subtype="PCM_16")
        out = card_join.join(self.plan([{"path": quiet, "gapBefore": 0}], edges=True))["path"]
        src, _ = sf.read(quiet, dtype="float32", always_2d=True)
        got, _ = sf.read(out, dtype="float32", always_2d=True)
        # 끝 경계만 본다 — 앞 경계에도 같은 기울기가 걸리므로 조각 전체를 비교하면 뜻이 흐려진다.
        self.assertTrue(np.allclose(got[-n * 2:], src[-n * 2:], atol=1e-6),
                        "무음 경계에서는 바뀌는 값이 없어야 한다")

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

    # ── 입력 위에 저장하지 않는다 (2026-09-27 검수 1항 [P1]) ──────────────────
    def test_출력을_입력_생성본으로_지정하면_거부한다(self):
        """★재현된 결함: A+B 를 이으면서 저장 자리를 A 로 고르니 A 가 0.25초→0.5초가 됐다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.25, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.25, 24000)
        raw = open(a, "rb").read()
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}], output=a))
        with open(a, "rb") as fh:
            self.assertEqual(fh.read(), raw, "거절했는데도 입력이 바뀌었다")

    def test_대소문자만_다른_이름도_거부한다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.25, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.25, 24000)
        raw = open(a, "rb").read()
        alias = os.path.join(self.dir, "A.WAV")
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}], output=alias))
        with open(a, "rb") as fh:
            self.assertEqual(fh.read(), raw)

    def test_상대_경로로_돌아와도_거부한다(self):
        a = tone(os.path.join(self.dir, "a.wav"), 0.25, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.25, 24000)
        raw = open(a, "rb").read()
        alias = os.path.join(self.dir, "sub", "..", "a.wav")
        os.makedirs(os.path.join(self.dir, "sub"), exist_ok=True)
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}], output=alias))
        with open(a, "rb") as fh:
            self.assertEqual(fh.read(), raw)

    def test_임시_자리가_입력과_겹쳐도_거부한다(self):
        """`<출력>.part` 에 쓴 뒤 자리를 바꾸므로 임시 자리도 입력을 덮을 수 있다."""
        made = tone(os.path.join(self.dir, "tmp.wav"), 0.25, 24000)
        a = os.path.join(self.dir, "out.wav.part")   # 확장자가 없으므로 만든 뒤 이름만 바꾼다
        os.rename(made, a)
        b = tone(os.path.join(self.dir, "b.wav"), 0.25, 24000)
        raw = open(a, "rb").read()
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}],
                                     output=os.path.join(self.dir, "out.wav")))
        with open(a, "rb") as fh:
            self.assertEqual(fh.read(), raw)

    def test_오류로_끝나도_입력_바이트가_그대로다(self):
        """없는 파일 때문에 죽는 경로에서도 입력은 손대지 않는다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.3, 24000)
        raw = open(a, "rb").read()
        with self.assertRaises(SystemExit):
            card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": os.path.join(self.dir, "없다.wav"), "gapBefore": 0}]))
        with open(a, "rb") as fh:
            self.assertEqual(fh.read(), raw)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "out.wav.part")),
                         "쓰다 만 임시 파일이 남았다")

    def test_같은_폴더의_다른_이름에는_저장할_수_있다(self):
        """입력 옆이라는 이유로 막지는 않는다 — 막는 것은 **같은 파일**이다."""
        a = tone(os.path.join(self.dir, "a.wav"), 0.25, 24000)
        b = tone(os.path.join(self.dir, "b.wav"), 0.25, 24000)
        r = card_join.join(self.plan([{"path": a, "gapBefore": 0},
                                      {"path": b, "gapBefore": 0}],
                                     output=os.path.join(self.dir, "최종.wav")))
        self.assertTrue(r["ok"])

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
