# -*- coding: utf-8 -*-
"""수동(manual) 참조 프롬프트 정렬 검증 회귀 — 실제 사고 config 3개를 fixture 로 쓴다.

fixture: E:/AudioForge_output/expressive-comparison/20260827-A2-emotion3/config_{happy,angry,sad}.json
  세 config 는 같은 reference_clip.wav(sha8 3759d489)를 가리키면서 원문 63자를 manual_text 로
  담고 있다. 클립은 9.000초에서 발화 도중 잘려 마지막 3음절이 오디오에 없다.
  → manual 이라는 이유로 정렬 검증을 건너뛰던 경로가 이 config 를 그대로 통과시켰다.

fixture 파일이 없는 환경(다른 PC 등)에서는 해당 테스트만 skip 하고, 정렬 판정 로직 자체는
합성 입력으로 항상 검증한다. 실제 전사(Whisper)는 부르지 않는다 — 주입으로 대체한다.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import korean_cer as kc          # noqa: E402
import reference_alignment as ra  # noqa: E402
import tts_worker as tw          # noqa: E402

FIXTURE_DIR = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
EMOTIONS = ("happy", "angry", "sad")
# 클립이 실제로 담고 있는 마지막 어절(측정값): 전사는 '...입니다' 까지 있지만 오디오에는 없다.
CLIP_MISSING_TAIL = "입니다"


def _load(emotion):
    p = os.path.join(FIXTURE_DIR, f"config_{emotion}.json")
    if not os.path.exists(p):
        raise unittest.SkipTest(f"fixture 없음: {p}")
    with open(p, encoding="utf-8") as f:      # 핸들 누수 금지 — 반드시 닫는다
        return json.load(f)


class ConfigFixtureTest(unittest.TestCase):
    """사고 config 자체의 사실을 고정한다 — 이 조건이 재현되면 반드시 막혀야 한다."""

    def test_all_three_share_one_clip_and_one_manual_text(self):
        seen_clip, seen_text, modes = set(), set(), set()
        for e in EMOTIONS:
            c = _load(e)
            pr = c["ttsReferencePrompts"]["default"]
            seen_clip.add(os.path.basename(c["ttsReferenceOverride"]))
            seen_text.add(pr["manual_text"])
            modes.add(pr["mode"])
        self.assertEqual(len(seen_clip), 1, "세 config 가 같은 참조를 써야 재현이 성립한다")
        self.assertEqual(len(seen_text), 1)
        self.assertEqual(modes, {"manual"})

    def test_manual_text_contains_tail_absent_from_audio(self):
        c = _load("happy")
        mt = c["ttsReferencePrompts"]["default"]["manual_text"]
        self.assertTrue(mt.strip().endswith(CLIP_MISSING_TAIL + "."))
        self.assertEqual(len(mt), 63)


class ManualAlignmentGateTest(unittest.TestCase):
    """정렬 판정 로직 — Whisper 없이 주입으로 검증한다."""

    def _verdict(self, manual, clip_asr):
        return ra.verify_clip_transcript(
            kc.syllable_units(kc.normalize_text(manual)),
            kc.syllable_units(kc.normalize_text(clip_asr)),
            kc.edit_counts)

    def test_accident_condition_is_blocked(self):
        """오디오에 없는 꼬리가 수동 전사에 있으면 통과시키지 않는다."""
        try:
            manual = _load("happy")["ttsReferencePrompts"]["default"]["manual_text"]
        except unittest.SkipTest:
            manual = "가나다라마바사입니다."
        clip_asr = manual.replace(CLIP_MISSING_TAIL + ".", "")   # 클립에는 꼬리가 없다
        v = self._verdict(manual, clip_asr)
        self.assertEqual(v["deletions"], len(CLIP_MISSING_TAIL))
        self.assertFalse(v["aligned"])
        with self.assertRaises(ra.AlignmentError):
            ra.assert_clip_transcript(v)

    def test_extended_audio_passes(self):
        """참조를 문장 끝까지 넓히면 통과한다(수정 방향 1)."""
        manual = "가나다라마바사입니다."
        v = self._verdict(manual, manual)
        self.assertTrue(v["aligned"])
        self.assertTrue(ra.assert_clip_transcript(v))

    def test_shrunk_manual_text_passes(self):
        """수동 전사를 오디오에 있는 만큼으로 줄여도 통과한다(수정 방향 2)."""
        clip_asr = "가나다라마바사"
        v = self._verdict(clip_asr, clip_asr)
        self.assertTrue(v["aligned"])

    def test_substitution_only_still_passes(self):
        v = self._verdict("가나다라마바사", "가나댜랴마바사")
        self.assertEqual(v["timing_mismatch"], 0)
        self.assertGreater(v["recognizer_variance"], 0)
        self.assertTrue(v["aligned"])


class ManualPathFailClosedTest(unittest.TestCase):
    """배선 — 수동 경로가 검증을 통과해야만 ref_text 를 돌려준다."""

    def setUp(self):
        tw._qwen_manual_verify_cache.clear()
        self.real = None

    def tearDown(self):
        if self.real is not None:
            tw._verify_manual_prompt_alignment = self.real
        tw._qwen_manual_verify_cache.clear()

    def _patch(self, fn):
        self.real = tw._verify_manual_prompt_alignment
        tw._verify_manual_prompt_alignment = fn

    def test_manual_branch_calls_verification(self):
        calls = []

        def fake(ref_audio, manual, emit_fn=None):
            calls.append((ref_audio, manual))
            return {"aligned": True}
        self._patch(fake)
        ov = {os.path.abspath("ref.wav"): {"mode": "manual", "manual_text": "가나다"}}
        out = tw._resolve_qwen_ref_text("ref.wav", ov, set())
        self.assertEqual(out, ("가나다", False))
        self.assertEqual(len(calls), 1, "수동 경로가 검증을 건너뛰면 안 된다")

    def test_misaligned_manual_blocks_generation(self):
        def fake(ref_audio, manual, emit_fn=None):
            raise tw.QwenReferenceMisalignedError(tw.REF_MANUAL_MISALIGNED, 0, 3, 2, 47, 44)
        self._patch(fake)
        ov = {os.path.abspath("ref.wav"): {"mode": "manual", "manual_text": "가나다"}}
        with self.assertRaises(tw.QwenReferenceMisalignedError) as cm:
            tw._resolve_qwen_ref_text("ref.wav", ov, set())
        self.assertEqual(cm.exception.reason_code, tw.REF_MANUAL_MISALIGNED)
        self.assertEqual(cm.exception.deletions, 3)

    def test_error_message_has_no_transcript_text(self):
        e = tw.QwenReferenceMisalignedError(tw.REF_MANUAL_MISALIGNED, 0, 3, 2, 47, 44)
        msg = str(e)
        for probe in ("버킷", "리스트", "입니다"):
            self.assertNotIn(probe, msg)
        self.assertIn("3", msg)

    def test_ref_free_mode_is_untouched(self):
        """ref-free 는 전사를 쓰지 않으므로 검증 대상이 아니다(회귀)."""
        called = []
        self._patch(lambda *a, **k: called.append(1))
        ov = {os.path.abspath("ref.wav"): {"mode": "ref_free", "manual_text": "가나다"}}
        out = tw._resolve_qwen_ref_text("ref.wav", ov, set())
        self.assertEqual(out, ("", True))
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
