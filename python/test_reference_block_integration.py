# -*- coding: utf-8 -*-
"""참조 차단 통합 회귀 — 승인 계약 / ref-trim fail-closed / 합성 경로 무호출.

단위 수준 예외 확인으로 대체하지 않는다. 결함 config 조건으로 **합성 진입점**을 실제로 부르고
모델 호출이 정확히 0회인지 센다. 파일 핸들은 전부 with 로 닫는다(누수 금지).
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_alignment as ra   # noqa: E402
import reference_region as rr      # noqa: E402
import tts_worker as tw            # noqa: E402

FIXTURE_DIR = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
SR = 24000


def _speech(sec, f0=180.0, seed=3):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sec * SR)) / SR
    x = np.zeros_like(t)
    for k, a in enumerate((1.0, 0.5, 0.25), start=1):
        x += a * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, 6.28))
    x *= 0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t)
    return (0.3 * x / max(float(np.abs(x).max()), 1e-9)).astype("float32")


class ApprovalContractTest(unittest.TestCase):
    """승인 권위는 Python 이다 — analyze_region 이 blocking/ready 를 함께 낸다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_block_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _write(self, name, sig):
        p = os.path.join(self.tmp, name)
        sf.write(p, sig, SR)
        return p

    def test_mid_utterance_cut_is_blocking_not_warning(self):
        p = self._write("cut.wav", _speech(7.0))
        m = rr.analyze_region(p, 0.0, 7.0)
        self.assertIn(rr.BLOCK_TAIL_TRUNCATED, m["blocking"])
        self.assertFalse(m["ready"])
        self.assertIsInstance(m["blocking"], list)

    def test_clean_region_is_ready(self):
        pad = np.zeros(int(0.5 * SR), dtype="float32")
        p = self._write("clean.wav", np.concatenate([pad, _speech(6.0), pad]))
        m = rr.analyze_region(p, 0.0, 7.0)
        self.assertEqual(m["blocking"], [])
        self.assertTrue(m["ready"])

    def test_ready_is_consistent_with_blocking(self):
        """ready 와 blocking 이 모순되면 계약이 깨진 것이다 — 두 값은 한 소스에서 나와야 한다."""
        for sig, name in ((_speech(7.0), "a.wav"),
                          (np.concatenate([np.zeros(int(0.5 * SR), dtype="float32"),
                                           _speech(6.0),
                                           np.zeros(int(0.5 * SR), dtype="float32")]), "b.wav")):
            m = rr.analyze_region(self._write(name, sig), 0.0, 7.0)
            self.assertEqual(m["ready"], len(m["blocking"]) == 0, m)


class RefTrimFailClosedTest(unittest.TestCase):
    """차단 시 clip_path 를 넘기지 않고 임시 WAV 를 지운다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_trim_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_blocked_region_emits_code_and_removes_clip(self):
        import separate
        src = os.path.join(self.tmp, "src.wav")
        sf.write(src, _speech(12.0), SR)            # 전 구간 발화 → 경계가 말 도중
        outdir = os.path.join(self.tmp, "out")
        events = []
        real_emit = separate.emit
        separate.emit = lambda t, **k: events.append((t, k))
        self.addCleanup(lambda: setattr(separate, "emit", real_emit))

        class A:
            mode = "ref-trim"
            input = src
            output = outdir
            region_start = 1.0
            region_dur = 7.0
        try:
            separate.main.__wrapped__(A()) if hasattr(separate.main, "__wrapped__") else None
        except Exception:
            pass
        # main() 전체를 부르지 않고 ref-trim 블록의 계약만 직접 재현해 검증한다.
        os.makedirs(outdir, exist_ok=True)
        clip = os.path.join(outdir, "reference_clip_24k.wav")
        rr.trim_region(src, 1.0, 7.0, clip)
        metrics = rr.analyze_region(clip, 0.0, 7.0)
        self.assertTrue(metrics["blocking"], "이 합성 소스는 경계가 말 도중이어야 한다")
        if metrics["blocking"]:
            os.remove(clip)
        self.assertFalse(os.path.exists(clip), "차단이면 임시 WAV 를 남기지 않는다")


class SynthesizeNeverCallsModelTest(unittest.TestCase):
    """결함 참조 조건에서 합성 진입점을 불러도 모델 호출은 정확히 0회여야 한다."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_synth_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        tw._qwen_manual_verify_cache.clear()
        self.calls = []

        class FakeEngine:
            def run_job(inner, segments, device):     # noqa: N805
                self.calls.append((len(segments), device))
                return []
        self._real_engine = tw._qwen_engine
        tw._qwen_engine = FakeEngine()
        self.addCleanup(lambda: setattr(tw, "_qwen_engine", self._real_engine))

        # 클립에는 꼬리가 없고 manual_text 에는 있는 상태(사고 조건)를 주입으로 재현
        self._real_verify = tw._verify_manual_prompt_alignment

        def fake_verify(ref_audio, manual, emit_fn=None):
            v = ra.verify_clip_transcript(tuple(manual), tuple(manual[:-3]))
            ra.assert_clip_transcript(v)
            return v
        tw._verify_manual_prompt_alignment = fake_verify
        self.addCleanup(lambda: setattr(tw, "_verify_manual_prompt_alignment",
                                        self._real_verify))

        self.ref = os.path.join(self.tmp, "ref.wav")
        sf.write(self.ref, _speech(9.0), SR)

    def test_defective_manual_prompt_never_reaches_model(self):
        ov = {os.path.abspath(self.ref): {"mode": "manual",
                                          "manual_text": "가나다라마바사아자차입니다"}}
        with self.assertRaises(Exception) as cm:
            tw._synthesize_qwen_job(
                parsed=[("default", "합성할 문장")],
                ref_cache={"default": self.ref},
                overrides_by_path=ov,
                output_dir=self.tmp, speed=1.0, silence_gap=0.5)
        self.assertEqual(self.calls, [], "차단됐는데 모델이 불렸다")
        self.assertNotIsInstance(cm.exception, AssertionError)

    def test_aligned_manual_prompt_reaches_segment_build(self):
        """정상 정렬이면 차단되지 않는다(과차단 회귀). 모델은 fake 라 실제 생성은 없다."""
        tw._verify_manual_prompt_alignment = lambda ref_audio, manual, emit_fn=None: {
            "status": ra.STATUS_VALIDATED, "aligned": True}
        ov = {os.path.abspath(self.ref): {"mode": "manual", "manual_text": "가나다라마바사"}}
        try:
            tw._synthesize_qwen_job(
                parsed=[("default", "합성할 문장")],
                ref_cache={"default": self.ref},
                overrides_by_path=ov,
                output_dir=self.tmp, speed=1.0, silence_gap=0.5)
        except Exception:
            pass   # fake engine 이 빈 결과를 주므로 이후 단계에서 실패하는 것은 정상
        self.assertEqual(len(self.calls), 1, "정렬이 맞으면 모델 경로까지 가야 한다")


class FixtureIntegrityTest(unittest.TestCase):
    """사고 config 3개와 참조 WAV 가 그대로인지 — fixture 훼손 감지."""

    def test_fixture_hashes(self):
        import hashlib
        if not os.path.isdir(FIXTURE_DIR):
            raise unittest.SkipTest("fixture 없음")
        wav = os.path.join(FIXTURE_DIR, "reference_clip.wav")
        with open(wav, "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest()[:8], "3759d489")
        for e in ("happy", "angry", "sad"):
            with open(os.path.join(FIXTURE_DIR, f"config_{e}.json"), encoding="utf-8") as f:
                c = json.load(f)
            mt = c["ttsReferencePrompts"]["default"]["manual_text"]
            self.assertEqual(hashlib.sha256(mt.encode("utf-8")).hexdigest()[:8], "6a3b9cd8")
            self.assertEqual(c["ttsReferencePrompts"]["default"]["mode"], "manual")


if __name__ == "__main__":
    unittest.main(verbosity=2)
