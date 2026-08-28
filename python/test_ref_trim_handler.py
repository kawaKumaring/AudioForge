# -*- coding: utf-8 -*-
"""ref-trim **핸들러 실제 실행** 통합 회귀 — 테스트 안에서 동작을 재현하지 않는다.

separate.main() 을 실제 argv 로 부르고 emit 을 가로채 무엇이 나갔는지만 본다.
Whisper 는 reference_transcript.transcribe_reference 주입으로 대체(모델·GPU 불필요).
"""
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import separate            # noqa: E402
import reference_region as rr  # noqa: E402

SR = 24000


def _speech(sec, f0=180.0, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sec * SR)) / SR
    x = np.zeros_like(t)
    for k, a in enumerate((1.0, 0.5, 0.25), start=1):
        x += a * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, 6.28))
    x *= 0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t)
    return (0.3 * x / max(float(np.abs(x).max()), 1e-9)).astype("float32")


def _sil(sec):
    return np.zeros(int(sec * SR), dtype="float32")


class RefTrimHandlerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_handler_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.events = []
        self._real_emit = separate.emit
        separate.emit = lambda t, **k: self.events.append((t, k))
        self.addCleanup(lambda: setattr(separate, "emit", self._real_emit))
        # 최종 클립 전사를 주입 — 실제 Whisper 를 부르지 않는다.
        self._real_build = rr.build_reference_clip

        def build_with_stub(*a, **k):
            k.setdefault("transcribe_fn", lambda p: "가나다라마바사")
            return self._real_build(*a, **k)
        rr.build_reference_clip = build_with_stub
        self.addCleanup(lambda: setattr(rr, "build_reference_clip", self._real_build))
        self.out = os.path.join(self.tmp, "out")

    def _src(self, name, parts):
        p = os.path.join(self.tmp, name)
        sf.write(p, np.concatenate(parts), SR)
        return p

    def _run(self, src, start, dur):
        # 제품과 같은 호출 형태 — audio.ipc.ts 는 --config JSON 으로 부른다.
        import json
        cfg = os.path.join(self.tmp, "cfg.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mode": "ref-trim", "input": src, "output": self.out,
                       "regionStart": start, "regionDur": dur}, f)
        argv = ["separate.py", "--config", cfg]
        old = sys.argv
        sys.argv = argv
        try:
            separate.main()
        finally:
            sys.argv = old
        return self.events

    def _clip(self):
        return os.path.join(self.out, "reference_clip_24k.wav")

    def test_success_emits_effective_region_and_clip(self):
        src = self._src("ok.wav", [_sil(0.8), _speech(4.0), _sil(0.5),
                                   _speech(3.5, 200.0, 2), _sil(0.8)])
        ev = self._run(src, 0.4, 8.8)
        kinds = [t for t, _ in ev]
        self.assertIn("result", kinds, ev)
        _, payload = [e for e in ev if e[0] == "result"][0]
        m = payload["metrics"]
        self.assertTrue(m["ready"])
        self.assertEqual(m["blocking"], [])
        for key in ("requested_region", "effective_region", "snap", "validation"):
            self.assertIn(key, m, f"{key} 가 renderer 까지 전달돼야 한다")
        for key in ("start_sec", "end_sec", "dur_sec"):
            self.assertIn(key, m["effective_region"])
        self.assertTrue(os.path.exists(payload["clip_path"]))
        # 전사 원문이 응답에 실리면 안 된다
        self.assertNotIn("가나다라마바사", repr(payload))

    def test_no_safe_boundary_blocks_without_jumping(self):
        src = self._src("dense.wav", [_speech(12.0)])
        ev = self._run(src, 1.0, 7.0)
        kinds = [t for t, _ in ev]
        self.assertIn("error", kinds, ev)
        _, err = [e for e in ev if e[0] == "error"][0]
        self.assertEqual(err["code"], "REFERENCE_REGION_BLOCKED")
        self.assertTrue(err["blocking"])
        self.assertNotIn("clip_path", err)
        self.assertFalse(os.path.exists(self._clip()), "차단이면 임시 WAV 를 남기지 않는다")

    def test_far_request_does_not_jump_to_other_speech(self):
        """요청이 무음 후보에서 멀면 엉뚱한 구간으로 점프하지 않고 막힌다."""
        src = self._src("far.wav", [_sil(0.8), _speech(4.0), _sil(0.6),
                                    _speech(3.0, 200.0, 3), _sil(0.8),
                                    _speech(20.0, 150.0, 4)])
        ev = self._run(src, 20.0, 7.0)
        kinds = [t for t, _ in ev]
        self.assertIn("error", kinds, ev)
        _, err = [e for e in ev if e[0] == "error"][0]
        self.assertEqual(err["code"], "REFERENCE_REGION_BLOCKED")
        self.assertFalse(os.path.exists(self._clip()))

    def test_error_payload_carries_regions_for_reconfirm(self):
        src = self._src("dense2.wav", [_speech(12.0)])
        ev = self._run(src, 1.0, 7.0)
        _, err = [e for e in ev if e[0] == "error"][0]
        self.assertIn("requested_region", err)
        self.assertIn("effective_region", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
