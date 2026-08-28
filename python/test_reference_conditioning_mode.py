# -*- coding: utf-8 -*-
"""참조 conditioning 모드(참조혼입 대응 PHASE 2) — 단일 권위 계약 테스트.

고정하는 계약:
  - resolve: 부재(None/'') → safe_xvector(안전 기본, legacy 세션 포함). 유효 2값 통과.
    잘못된 값 → 조용한 강등 없이 구조화 오류(INVALID_REFERENCE_CONDITIONING_MODE), 원시값 미포함.
  - synthesize 입구: high_quality_icl → fail-closed(ICL_BOUNDARY_POLICY_UNCONFIRMED, 모델/파싱 미진입,
    조용한 safe 대체 없음). 잘못된 값 → 구조화 오류.
  - safe_xvector 배선: 전 segment x_vector_only=True + ref_text 미전달(""), Whisper/정렬검증 호출 0,
    manual 전사는 보존되되 합성 조건 전달 0, job 내 모드 고정(자동 ICL fallback 0).
  - metadata 왕복: requested/effective/degraded/alignment/cut_sample/failure_code 키 상시 존재.
  - separate.py 배선: config 키 ttsReferenceConditioningMode → resolve → synthesize 명시 전달.
  - legacy 직접 호출(모드 미전달)은 기존 전사 기반 결정 그대로(기존 테스트 계약 보존).

GPU·Whisper 실모델 없음(run_job 대체).
"""
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe_worker  # noqa: E402
import tts_worker  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class ResolveModeTest(unittest.TestCase):
    def test_absent_resolves_to_safe(self):
        """부재(legacy 세션/구 config) → 안전 기본."""
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode(None), "safe_xvector")
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode(""), "safe_xvector")

    def test_valid_values_pass_through(self):
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode("safe_xvector"),
                         "safe_xvector")
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode("high_quality_icl"),
                         "high_quality_icl")

    def test_invalid_value_raises_structured_error(self):
        """조용한 강등 금지 — 계약 밖 값은 구조화 오류로 크게 실패한다."""
        for bad in ("icl", "SAFE_XVECTOR", "xvector", 1, True, ["safe_xvector"], {"m": 1}):
            with self.assertRaises(RuntimeError) as cm:
                tts_worker.resolve_reference_conditioning_mode(bad)
            payload = getattr(cm.exception, "error_payload", None)
            self.assertIsInstance(payload, dict, f"구조화 payload 필요: {bad!r}")
            self.assertEqual(payload["code"], "INVALID_REFERENCE_CONDITIONING_MODE")

    def test_invalid_payload_has_no_raw_value(self):
        """payload 에 원시값을 담지 않는다(타입 이름만 — 비민감 payload 규칙)."""
        secret = "C:/비밀/경로처럼_보이는_잘못된_값.wav"
        with self.assertRaises(RuntimeError) as cm:
            tts_worker.resolve_reference_conditioning_mode(secret)
        blob = json.dumps(cm.exception.error_payload, ensure_ascii=False)
        self.assertNotIn(secret, blob)
        self.assertNotIn("비밀", blob)
        self.assertEqual(cm.exception.error_payload.get("raw_type"), "str")


class SynthesizeGateTest(unittest.TestCase):
    """synthesize 입구 게이트 — 어떤 파싱/참조 준비/모델 작업보다 먼저 판정된다."""

    def setUp(self):
        self.events = []
        p = mock.patch.object(tts_worker, "emit",
                              new=lambda mt, **k: self.events.append((mt, k)))
        p.start()
        self.addCleanup(p.stop)

    def test_icl_fails_closed_before_anything(self):
        with self.assertRaises(RuntimeError) as cm:
            tts_worker.synthesize("no_such_ref.wav", "안녕하세요.", "no_such_dir",
                                  reference_conditioning_mode="high_quality_icl")
        payload = getattr(cm.exception, "error_payload", None)
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload["code"], "ICL_BOUNDARY_POLICY_UNCONFIRMED")
        # 사용자 안내: 경계 검증 확정 전 + 안전 모드 유도(조용한 대체가 아니라 명시 안내).
        self.assertIn("경계 검증", str(cm.exception))
        self.assertIn("안전 음성 복제", str(cm.exception))
        # 입구 차단 — status/progress 조차 나가기 전(파싱·참조 준비·모델 로딩 미진입).
        self.assertEqual(self.events, [])

    def test_invalid_mode_fails_closed_at_entry(self):
        with self.assertRaises(RuntimeError) as cm:
            tts_worker.synthesize("no_such_ref.wav", "안녕하세요.", "no_such_dir",
                                  reference_conditioning_mode="weird_mode")
        self.assertEqual(cm.exception.error_payload["code"],
                         "INVALID_REFERENCE_CONDITIONING_MODE")
        self.assertEqual(self.events, [])


def _write_wav(path, seconds, sr=24000, amp=0.3):
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    sf.write(path, (amp * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr)


class _QwenJobBase(unittest.TestCase):
    """Qwen 배치 경로 scaffold — run_job 대체 + segments 캡처(모델·GPU·Whisper 없음)."""

    def setUp(self):
        self.events = []
        p = mock.patch.object(tts_worker, "emit",
                              new=lambda mt, **k: self.events.append((mt, k)))
        p.start()
        self.addCleanup(p.stop)

        self._snap_cache = dict(tts_worker._qwen_ref_text_cache)
        tts_worker._qwen_ref_text_cache.clear()
        self.addCleanup(lambda: (tts_worker._qwen_ref_text_cache.clear(),
                                 tts_worker._qwen_ref_text_cache.update(self._snap_cache)))

        import reference_audio as ra
        self._orig_ra = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(lambda: (ra._analysis_cache.clear(),
                                 ra._analysis_cache.update(self._orig_ra)))
        self._snap_engine = tts_worker._qwen_engine
        self.addCleanup(lambda: setattr(tts_worker, "_qwen_engine", self._snap_engine))

        self.tmp = tempfile.mkdtemp(prefix="af_refcond_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.ref5 = os.path.join(self.tmp, "ref5.wav")
        _write_wav(self.ref5, 5.0)
        self.happy_ref = os.path.join(self.tmp, "happy4.wav")
        _write_wav(self.happy_ref, 4.0)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)

        self._patch("gpu_policy.select_device",
                    new=(lambda *a, **k: ("cuda", "여유 VRAM 5000/16000MB ≥ 4000MB → GPU (source=nvidia-smi)")))
        self._patch_obj(tts_worker.QwenTTSEngine, "available", new=(lambda self: True))

        self.captured_segments = []

        def fake_run_job(inner_self, segments, device):
            self.captured_segments.append([dict(s) for s in segments])
            for s in segments:
                _write_wav(s["out_path"], 0.3)
            return [{"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                     "out_path": s["out_path"], "sr": 24000, "x_vector_only": s["x_vector_only"],
                     "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                     "generation_limit": 256, "generated_iterations": 100,
                     "termination_reason": "completed_before_limit", "status": "ok"}
                    for s in segments]
        self._patch_obj(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job)

        # 안전 모드 불변식 감시: Whisper·정렬 검증이 호출되면 즉시 실패해야 한다.
        self.whisper_calls = []

        def _no_whisper(*a, **k):
            self.whisper_calls.append(a)
            raise AssertionError("safe_xvector 에서 Whisper 전사가 호출되면 안 된다")
        self._patch_obj(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))
        self._patch_obj(transcribe_worker, "run_transcribe", side_effect=_no_whisper)
        self.align_mock = self._patch_obj(tts_worker, "_verify_manual_prompt_alignment")

    def _patch(self, target, **kw):
        p = mock.patch(target, **kw)
        v = p.start()
        self.addCleanup(p.stop)
        return v

    def _patch_obj(self, target, attr=None, **kw):
        p = mock.patch.object(target, attr, **kw) if attr else mock.patch.object(
            tts_worker, target, **kw)
        v = p.start()
        self.addCleanup(p.stop)
        return v

    def _meta(self):
        for mt, k in self.events:
            if mt == "result":
                return k.get("metadata")
        return None

    def _flat_segments(self):
        self.assertEqual(len(self.captured_segments), 1, "run_job 은 정확히 1회(모델 1회 로딩)")
        return self.captured_segments[0]


class SafeModeProductionTest(_QwenJobBase):
    TEXT = "안녕하세요 첫 문장입니다.\n[기쁨] 좋은 소식이 있어요!\n마지막 문장입니다."

    def _synth(self, **kw):
        tts_worker.synthesize(
            self.ref5, self.TEXT, self.out, speed=1.0, silence_gap=0.5,
            emotion_refs={"happy": self.happy_ref},
            emotion_ref_sources={"happy": self.happy_ref},
            preferred_engine="qwen3",
            reference_conditioning_mode="safe_xvector", **kw)

    def test_all_segments_forced_xvo_and_no_ref_text(self):
        """전 세그먼트(기본+감정, 자동분할 전 세그먼트 동일) xvo=True + ref_text 미전달."""
        self._synth(reference_prompts={})
        segs = self._flat_segments()
        self.assertEqual(len(segs), 3)
        for s in segs:
            self.assertTrue(s["x_vector_only"], f"seg {s['index']} 는 x_vector_only=True 여야 한다")
            self.assertEqual(s["ref_text"], "", f"seg {s['index']} 는 ref_text 미전달이어야 한다")
        # 감정 참조가 실제로 배정됐어도(참조 경로는 다르되) 모드는 job 전체 고정이다.
        refs = {s["ref_audio"] for s in segs}
        self.assertEqual(len(refs), 2, "기본+감정 두 참조가 실제로 쓰였다(모드 고정과 별개)")

    def test_no_whisper_and_no_alignment_calls(self):
        """전사 기반 ICL 결정 우회 — Whisper 0회, 수동 정렬 검증 0회."""
        self._synth(reference_prompts={})
        self.assertEqual(self.whisper_calls, [])
        self.align_mock.assert_not_called()

    def test_manual_prompt_preserved_but_not_transmitted(self):
        """manual 전사는 라이브러리 표시·검증용으로 보존되되 합성 조건 전달은 0."""
        manual = "이것은 수동 참조 전사문입니다"
        self._synth(reference_prompts={"default": {"manual_text": manual, "mode": "manual"}})
        segs = self._flat_segments()
        blob = json.dumps(segs, ensure_ascii=False)
        self.assertNotIn(manual, blob, "수동 전사가 vendor 세그먼트로 새면 안 된다")
        for s in segs:
            self.assertEqual(s["ref_text"], "")
            self.assertTrue(s["x_vector_only"])
        self.align_mock.assert_not_called()

    def test_no_icl_fallback_and_no_degraded_event(self):
        """안전 모드는 강등이 아니다 — tts_reference_degraded 0건, ICL 로 되돌아가는 세그먼트 0."""
        self._synth(reference_prompts={})
        kinds = [t for t, _ in self.events]
        self.assertEqual(kinds.count("tts_reference_degraded"), 0)
        self.assertTrue(all(s["x_vector_only"] for s in self._flat_segments()))

    def test_metadata_roundtrip(self):
        self._synth(reference_prompts={})
        m = self._meta()
        self.assertIsNotNone(m)
        self.assertEqual(m["reference_conditioning_mode_requested"], "safe_xvector")
        self.assertEqual(m["reference_conditioning_mode_effective"], "safe_xvector")
        self.assertIs(m["reference_conditioning_degraded"], False)
        self.assertIsNone(m["reference_alignment"], "안전 모드: 내용 정렬 미수행 → null")
        self.assertIsNone(m["reference_cut_sample"], "절단 정책 미확정 → null")
        self.assertIsNone(m["reference_conditioning_failure_code"])
        # 기존 계약 필드와의 정합: 실제 적용 상태는 x-vector-only 다.
        self.assertEqual(m["prompt_source"], "x-vector-only")
        self.assertTrue(m["x_vector_only_mode"])
        # 전사를 시도하지 않았으므로 C2 강등 요약은 전부 None(비었음 — '실패'가 아니다).
        self.assertIsNone(m["reference_prompt_degraded"])
        self.assertIsNone(m["reference_degrade_reason"])

    def test_safe_mode_announced_once(self):
        """안전 모드 사실이 progress 로 1회 명시된다(조용한 모드 아님)."""
        self._synth(reference_prompts={})
        msgs = [k.get("message", "") for t, k in self.events if t == "progress"]
        hits = [m for m in msgs if "안전 음성 복제" in m]
        self.assertEqual(len(hits), 1)


class LegacyDirectCallTest(_QwenJobBase):
    """모드 미전달(legacy 직접 호출) — 기존 전사 기반 결정 그대로(회귀 보존).
    production 은 separate.py 가 항상 명시 값을 전달하므로 이 경로에 오지 않는다."""

    def test_legacy_call_keeps_transcript_based_icl(self):
        # legacy 경로는 Whisper 를 실제로 탄다 — 성공 전사로 대체.
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l: {"text": "자동전사문장", "language": "ko"}))
        tts_worker.synthesize(self.ref5, "안녕하세요 첫 문장입니다.", self.out, speed=1.0,
                              silence_gap=0.5, emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts={})
        segs = self._flat_segments()
        self.assertEqual(segs[0]["ref_text"], "자동전사문장", "legacy 호출은 기존 ICL 결정 그대로")
        self.assertFalse(segs[0]["x_vector_only"])
        m = self._meta()
        for k in ("reference_conditioning_mode_requested", "reference_conditioning_mode_effective",
                  "reference_conditioning_degraded", "reference_alignment",
                  "reference_cut_sample", "reference_conditioning_failure_code"):
            self.assertIn(k, m)
            self.assertIsNone(m[k], f"legacy 호출은 {k} 를 기록하지 않는다(null)")


class MetadataSchemaTest(unittest.TestCase):
    RC_KEYS = ["reference_conditioning_mode_requested", "reference_conditioning_mode_effective",
               "reference_conditioning_degraded", "reference_alignment", "reference_cut_sample",
               "reference_conditioning_failure_code"]

    def test_keys_in_schema(self):
        for k in self.RC_KEYS:
            self.assertIn(k, tts_worker._METADATA_KEYS, k)

    def test_absent_values_are_none_not_missing(self):
        m = tts_worker._build_tts_metadata(actual_engine="qwen3")
        for k in self.RC_KEYS:
            self.assertIn(k, m)
            self.assertIsNone(m[k])


class SeparateWiringTest(unittest.TestCase):
    """separate.py 배선 계약 — config 키 → resolve → synthesize 명시 전달(소스 고정)."""

    def setUp(self):
        with open(os.path.join(HERE, "separate.py"), "r", encoding="utf-8") as f:
            self.src = f.read()

    def test_config_key_parsed_without_local_default(self):
        """키 부재는 None 으로 두고 해석은 tts_worker 단일 소유(separate 가 기본값을 만들지 않는다)."""
        self.assertRegex(self.src,
                         r"config\.get\(\s*[\"']ttsReferenceConditioningMode[\"']\s*,\s*None\s*\)")

    def test_resolver_is_called_before_synthesize(self):
        self.assertIn("resolve_reference_conditioning_mode", self.src)
        self.assertLess(self.src.index("resolve_reference_conditioning_mode("),
                        self.src.index("_synth_out = synthesize("),
                        "resolve 는 synthesize 호출보다 앞서야 한다(모델 미로딩 차단)")

    def test_mode_passed_explicitly_to_synthesize(self):
        self.assertRegex(self.src, r"reference_conditioning_mode\s*=\s*_rc_mode")


class PromptSourceRegressionTest(unittest.TestCase):
    """기존 계약 불변 확인 — 참조 라이브러리/미리듣기가 쓰는 순수 헬퍼는 그대로다."""

    def test_prompt_source_for_unchanged(self):
        ref = os.path.abspath("r.wav")
        self.assertEqual(tts_worker._prompt_source_for(ref, {}, True), "x-vector-only")
        self.assertEqual(tts_worker._prompt_source_for(
            ref, {ref: {"manual_text": "수동"}}, False), "manual")
        self.assertEqual(tts_worker._prompt_source_for(ref, {}, False), "auto")


if __name__ == "__main__":
    unittest.main(verbosity=2)
