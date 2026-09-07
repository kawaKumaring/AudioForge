# -*- coding: utf-8 -*-
"""엔진별 참조 정책이 합성 경로에 올바르게 배선됐는지(소스 계약).

- GPT-SoVITS 경로(_assess_ref): 벤더 필수 조건 GPTSOVITS_POLICY 그대로.
- Qwen 경로(_synthesize_qwen_job 게이트): QWEN3_POLICY — 길이 차단 없음, 권장 밖은 경고, 인물 참조도 처리 가능 검사.
- 화면(separate.py ref-analyze/ref-trim)과 합성이 같은 resolve 규칙(auto → Qwen 런타임 유무)을 쓴다.
"""
import io
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def _read(name):
    return io.open(os.path.join(HERE, name), encoding="utf-8").read()


def _between(src, start_marker, end_marker):
    s = src.index(start_marker)
    e = src.index(end_marker, s)
    return src[s:e]


class WorkerWiring(unittest.TestCase):
    def setUp(self):
        self.src = _read("tts_worker.py")

    def test_gptsovits_gate_keeps_vendor_policy(self):
        block = _between(self.src, "    def _assess_ref(self, ref_audio):", "    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):\n        # 실제 모델")
        self.assertIn("assess_reference_file(ref_audio, GPTSOVITS_POLICY)", block)

    def test_qwen_gate_uses_qwen_policy_without_length_block(self):
        block = _between(self.src, "def _synthesize_qwen_job(", "def _prepare_ref(ref_path):")
        self.assertIn("assess_reference_file(ref, QWEN3_POLICY)", block)
        self.assertNotIn("GPTSOVITS_POLICY", block)
        self.assertNotIn("10초를 초과합니다", block)
        self.assertNotIn('e.code == "TOO_LONG"', block)
        # 권장 범위 밖은 경고(progress)로만 — 예외를 만들지 않는다.
        self.assertIn("OUTSIDE_RECOMMENDED_LENGTH", block)
        gate = _between(block, "_gate_targets = [", "import tempfile")
        self.assertIn('emit("progress", percent=7', gate)
        self.assertNotIn("raise RuntimeError(f\"{who}({base})", gate)
        # 인물 참조·인물 감정 참조도 같은 처리 가능 검사를 받는다.
        self.assertIn('getattr(ref_table, "speaker_refs", None)', gate)
        self.assertIn('getattr(ref_table, "speaker_emotion_refs", None)', gate)
        # 처리 불가는 계속 차단.
        self.assertIn('raise RuntimeError(f"참조 음성 부적합(Qwen): {who} {base} — {codes}")', gate)

    def test_run_header_records_reference_policy(self):
        self.assertIn("reference_policy=QWEN3_POLICY.describe()", self.src)


class ScreenAndWorkerShareResolution(unittest.TestCase):
    def test_separate_uses_reference_audio_resolver(self):
        sep = _read("separate.py")
        self.assertIn("_ra.resolve_policy_engine(preferred, qwen_ok)", sep)
        self.assertIn("_get_qwen_engine().available()", sep)

    def test_resolver_matches_auto_engine_selection_rule(self):
        # tts_worker._select_job_engine: auto 는 Qwen 가용 시 qwen3. 정책 해석도 같은 축(가용 여부)으로 갈린다.
        import reference_audio as ra
        self.assertEqual(ra.resolve_policy_engine("auto", True), "qwen3")
        self.assertEqual(ra.resolve_policy_engine("auto", False), "gptsovits")


if __name__ == "__main__":
    unittest.main()
