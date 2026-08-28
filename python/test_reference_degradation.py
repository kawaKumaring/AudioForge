# -*- coding: utf-8 -*-
"""C2 — 참조 전사 실패의 가시화(데이터 계약) 테스트.

배경: reference_transcript.transcribe_reference()는 status + error_code + error_message 를
전부 구조화해 돌려주는데, Qwen 경로의 _resolve_qwen_ref_text()는 status 만 읽고 나머지를 버렸다.
그래서 전사가 실패해도 사용자에게는 스쳐 지나가는 progress 한 줄뿐이었고, 실행은 조용히
낮은 품질(x-vector-only)로 계속됐다. 실패가 합성 실패보다 앞서면 metadata 조차 남지 않는다.

이 파일이 고정하는 계약:
  - 강등 사유가 sink 요약과 tts_reference_degraded 이벤트로 표면화된다.
  - x-vector-only 능력 자체는 그대로다(없애는 게 아니라 보이게 만드는 변경).
  - (ref_text, x_vector_only) 2-tuple 반환 arity 불변.
  - 보안: 경로·전사 전문·예외 메시지가 어디에도 실리지 않는다.

UI는 별도 커밋 — 여기서는 데이터 계약만 검증한다. GPU·Whisper 실모델 없음.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe_worker  # noqa: E402
import tts_worker  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self._snap_cache = dict(tts_worker._qwen_ref_text_cache)
        tts_worker._qwen_ref_text_cache.clear()
        self.addCleanup(self._restore)
        self.events = []
        p = mock.patch.object(tts_worker, "emit",
                              new=lambda mt, **k: self.events.append((mt, k)))
        p.start()
        self.addCleanup(p.stop)
        self.tmp = tempfile.mkdtemp(prefix="af_refdeg_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.ref = os.path.join(self.tmp, "ref.wav")
        with open(self.ref, "wb") as f:
            f.write(b"dummy")
        self.ap = os.path.abspath(self.ref)

    def _restore(self):
        tts_worker._qwen_ref_text_cache.clear()
        tts_worker._qwen_ref_text_cache.update(self._snap_cache)

    def _patch(self, target, attr=None, **kw):
        p = mock.patch.object(target, attr, **kw) if attr else mock.patch(target, **kw)
        v = p.start()
        self.addCleanup(p.stop)
        return v

    def _whisper(self, result=None, raises=None):
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))

        def ft(m, p, l):
            if raises is not None:
                raise raises
            return result
        self._patch(transcribe_worker, "run_transcribe", side_effect=ft)

    def _degraded_events(self):
        return [k for t, k in self.events if t == "tts_reference_degraded"]

    def _resolve(self, sink, overrides=None, emotion_id="default"):
        return tts_worker._resolve_qwen_ref_text(
            self.ref, overrides or {}, set(), degrade_sink=sink, emotion_id=emotion_id)


class DegradeRecordTest(_Base):
    def test_failed_transcript_records_reason(self):
        self._whisper(raises=RuntimeError("whisper exploded"))
        sink = []
        out = self._resolve(sink)
        self.assertEqual(out, ("", True), "강등 동작 자체는 그대로 — x-vector-only 유지")
        self.assertEqual(len(sink), 1)
        r = sink[0]
        self.assertTrue(r["degraded"])
        self.assertEqual(r["reason_code"], "TRANSCRIPTION_FAILED")
        self.assertEqual(r["transcript_status"], "failed")
        self.assertEqual(r["model"], "small")
        self.assertEqual(r["prompt_source"], "x-vector-only")

    def test_empty_transcript_records_reason(self):
        self._whisper(result={"text": "   ", "language": "ko"})
        sink = []
        self.assertEqual(self._resolve(sink), ("", True))
        self.assertEqual(sink[0]["reason_code"], "EMPTY_TRANSCRIPT")
        self.assertEqual(sink[0]["transcript_status"], "empty")

    def test_user_ref_free_records_reason(self):
        self._whisper(result={"text": "자동전사", "language": "ko"})
        sink = []
        out = self._resolve(sink, overrides={self.ap: {"mode": "ref_free"}})
        self.assertEqual(out, ("", True))
        self.assertEqual(sink[0]["reason_code"], "REF_FREE_USER")
        self.assertEqual(sink[0]["transcript_status"], "user_ref_free")
        self.assertTrue(sink[0]["degraded"], "사용자 선택도 '낮은 품질 경로'라는 사실은 남긴다")

    def test_ok_transcript_records_not_degraded(self):
        self._whisper(result={"text": "자동전사", "language": "ko"})
        sink = []
        self.assertEqual(self._resolve(sink), ("자동전사", False))
        self.assertEqual(len(sink), 1)
        self.assertFalse(sink[0]["degraded"])
        self.assertIsNone(sink[0]["reason_code"])
        self.assertEqual(sink[0]["transcript_status"], "ok")
        self.assertEqual(self._degraded_events(), [], "정상 전사는 강등 이벤트를 내지 않는다")

    def test_manual_records_not_degraded(self):
        # 수동도 정렬 검증을 거치므로(2026-08-28 계약) 클립 전사가 수동 문장과 맞아야 통과한다.
        tts_worker._qwen_manual_verify_cache.clear()
        self._whisper(result={"text": "수동문", "language": "ko"})
        sink = []
        out = self._resolve(sink, overrides={self.ap: {"manual_text": "수동문", "mode": "manual"}})
        self.assertEqual(out, ("수동문", False))
        self.assertFalse(sink[0]["degraded"])
        self.assertEqual(sink[0]["transcript_status"], "manual")

    def test_status_not_ok_without_error_code_falls_back(self):
        """status는 비-ok인데 error_code가 없으면 조용히 None으로 두지 않고 보수적 코드를 쓴다."""
        import reference_transcript as rt
        fake = rt.ReferenceTranscript(source_path=self.ref, status="failed", text="",
                                      language=None, model_name="small", error_code=None)
        self._patch(rt, "transcribe_reference", new=(lambda p, m="small": fake))
        sink = []
        self.assertEqual(self._resolve(sink), ("", True))
        self.assertEqual(sink[0]["reason_code"], "TRANSCRIPT_UNAVAILABLE")

    def test_return_arity_is_still_two_tuple(self):
        """반환 arity를 바꾸면 기존 호출부·회귀 테스트가 전부 깨진다 — 2-tuple 고정."""
        self._whisper(result={"text": "자동전사", "language": "ko"})
        out = tts_worker._resolve_qwen_ref_text(self.ref, {}, set())
        self.assertIsInstance(out, tuple)
        self.assertEqual(len(out), 2)

    def test_sink_is_optional(self):
        """degrade_sink 없이 호출해도(기존 호출 형태) 예외 없이 동작한다."""
        self._whisper(raises=RuntimeError("boom"))
        self.assertEqual(tts_worker._resolve_qwen_ref_text(self.ref, {}, set()), ("", True))


class DegradeSecurityTest(_Base):
    def test_record_has_no_path_or_text(self):
        """reference_transcript.transcribe_reference 는 error_message 에 str(e)[:300] 을 담는다.
        FileNotFoundError 같은 예외는 거기에 전체 경로가 들어가므로 절대 옮기면 안 된다."""
        secret = os.path.join(self.tmp, "비밀_참조_음성.wav")
        self._whisper(raises=FileNotFoundError(f"[Errno 2] No such file: {secret}"))
        sink = []
        self._resolve(sink)
        blob = json.dumps(sink, ensure_ascii=False)
        self.assertNotIn(secret, blob)
        self.assertNotIn("비밀_참조_음성", blob)
        self.assertNotIn(self.tmp, blob)
        self.assertNotIn("Errno", blob)
        for bad in ("error_message", "source_path", "text", "transcript", "path"):
            self.assertNotIn(bad, sink[0], bad)

    def test_event_has_no_path_or_text(self):
        secret = os.path.join(self.tmp, "비밀_참조_음성.wav")
        self._whisper(raises=FileNotFoundError(f"[Errno 2] No such file: {secret}"))
        self._resolve([])
        evs = self._degraded_events()
        self.assertEqual(len(evs), 1)
        blob = json.dumps(evs, ensure_ascii=False)
        self.assertNotIn(secret, blob)
        self.assertNotIn("Errno", blob)
        self.assertEqual(set(evs[0]),
                         {"emotion_id", "prompt_source", "degraded_to", "reason_code",
                          "transcript_status", "model"})
        self.assertEqual(evs[0]["degraded_to"], "x_vector_only")

    def test_transcript_text_never_in_record(self):
        self._whisper(result={"text": "이것은 참조 전사 전문입니다", "language": "ko"})
        sink = []
        self._resolve(sink)
        self.assertNotIn("이것은 참조 전사 전문입니다", json.dumps(sink, ensure_ascii=False))


class DegradeCacheTest(_Base):
    def test_cache_hit_still_records(self):
        """같은 참조를 쓰는 두 번째 감정도 집계돼야 한다 — 캐시 적중이 요약을 삼키면 안 된다."""
        calls = []
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))

        def ft(m, p, l):
            calls.append(1)
            raise RuntimeError("boom")
        self._patch(transcribe_worker, "run_transcribe", side_effect=ft)

        sink = []
        warned = set()
        for emo in ("default", "happy"):
            tts_worker._resolve_qwen_ref_text(self.ref, {}, warned,
                                              degrade_sink=sink, emotion_id=emo)
        self.assertEqual(len(calls), 1, "동일 파일 전사는 1회(캐시)")
        self.assertEqual(len(sink), 2, "캐시 적중이어도 요약은 감정마다 남는다")
        self.assertEqual([r["emotion_id"] for r in sink], ["default", "happy"])
        self.assertTrue(all(r["degraded"] for r in sink))
        self.assertEqual(len(self._degraded_events()), 1, "이벤트는 참조·사유당 1회")


class SummarizeTest(unittest.TestCase):
    def _rec(self, emo, degraded, reason, status, model="small"):
        return tts_worker._ref_record(emo, "x-vector-only" if degraded else "auto",
                                      degraded, reason, status, model)

    def test_empty_records_all_none(self):
        m = tts_worker._summarize_ref_degradation([], "default")
        self.assertEqual(set(m), {"reference_prompt_degraded", "reference_degrade_reason",
                                  "reference_transcript_status", "reference_transcript_model",
                                  "reference_degraded_emotions"})
        self.assertTrue(all(v is None for v in m.values()))

    def test_default_reference_is_representative(self):
        recs = [self._rec("default", True, "TRANSCRIPTION_FAILED", "failed"),
                self._rec("happy", False, None, "ok")]
        m = tts_worker._summarize_ref_degradation(recs, "default")
        self.assertTrue(m["reference_prompt_degraded"])
        self.assertEqual(m["reference_degrade_reason"], "TRANSCRIPTION_FAILED")
        self.assertEqual(m["reference_transcript_status"], "failed")
        self.assertEqual(m["reference_transcript_model"], "small")
        self.assertEqual(m["reference_degraded_emotions"], ["default"])

    def test_healthy_run_reports_not_degraded(self):
        recs = [self._rec("default", False, None, "ok")]
        m = tts_worker._summarize_ref_degradation(recs, "default")
        self.assertFalse(m["reference_prompt_degraded"])
        self.assertIsNone(m["reference_degrade_reason"])
        self.assertEqual(m["reference_transcript_status"], "ok")
        self.assertIsNone(m["reference_degraded_emotions"])

    def test_non_default_degradation_still_surfaced(self):
        recs = [self._rec("default", False, None, "ok"),
                self._rec("angry", True, "EMPTY_TRANSCRIPT", "empty")]
        m = tts_worker._summarize_ref_degradation(recs, "default")
        self.assertTrue(m["reference_prompt_degraded"])
        self.assertEqual(m["reference_degrade_reason"], "EMPTY_TRANSCRIPT")
        self.assertEqual(m["reference_degraded_emotions"], ["angry"])

    def test_degraded_emotions_sorted_unique(self):
        recs = [self._rec("b", True, "EMPTY_TRANSCRIPT", "empty"),
                self._rec("a", True, "EMPTY_TRANSCRIPT", "empty"),
                self._rec("b", True, "EMPTY_TRANSCRIPT", "empty")]
        m = tts_worker._summarize_ref_degradation(recs, "default")
        self.assertEqual(m["reference_degraded_emotions"], ["a", "b"])


class MetadataSchemaTest(unittest.TestCase):
    C2_KEYS = ["reference_prompt_degraded", "reference_degrade_reason",
               "reference_transcript_status", "reference_transcript_model",
               "reference_degraded_emotions"]

    def test_keys_in_schema(self):
        for k in self.C2_KEYS:
            self.assertIn(k, tts_worker._METADATA_KEYS, k)

    def test_absent_values_are_none_not_missing(self):
        m = tts_worker._build_tts_metadata(actual_engine="qwen3")
        for k in self.C2_KEYS:
            self.assertIn(k, m)
            self.assertIsNone(m[k])

    def test_no_sensitive_key_names_introduced(self):
        m = tts_worker._build_tts_metadata()
        for bad in ("transcript", "text", "spoken_text", "tts_text", "dialogue", "abspath",
                    "reference_transcript", "error_message", "source_path"):
            self.assertNotIn(bad, m, bad)


def _write_wav(path, seconds, sr=24000, amp=0.3):
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    sf.write(path, (amp * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr)


class MetadataEndToEndTest(_Base):
    """synthesize() 전 구간을 태워서 참조 프롬프트 결정이 result metadata까지 도달하는지 본다.
    모델은 로딩하지 않는다(run_job 대체) — GPU·Qwen 없음.

    ※ 참조 conditioning 모드 계약 이후: 전사 기반 결정을 타는 유일한 모드는 high_quality_icl 이고,
      그 모드에서 전사를 못 얻으면 낮은 품질로 계속 가지 않고 fail-closed 로 끝난다. 그래서
      '강등된 채 결과가 나오는' 경로는 더 이상 존재하지 않는다 — 여기서는 강등 신호(이벤트/sink)가
      그대로 나가고 결과는 발행되지 않는다는 더 강한 계약을 고정한다. 강등 기록의 형태 자체는
      DegradeRecordTest / SummaryTest 가 단위로 계속 고정한다."""

    def setUp(self):
        super().setUp()
        import reference_audio as ra
        self._orig_ra = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(lambda: (ra._analysis_cache.clear(),
                                 ra._analysis_cache.update(self._orig_ra)))
        self._snap_engine = tts_worker._qwen_engine
        self.addCleanup(lambda: setattr(tts_worker, "_qwen_engine", self._snap_engine))

        self.ref5 = os.path.join(self.tmp, "ref5.wav")
        _write_wav(self.ref5, 5.0)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)

        self._patch("gpu_policy.select_device",
                    new=(lambda *a, **k: ("cuda", "여유 VRAM 5000/16000MB ≥ 4000MB → GPU (source=nvidia-smi)")))
        self._patch(tts_worker.QwenTTSEngine, "available", new=(lambda self: True))

        self.reached_run_job = []

        def fake_run_job(inner_self, segments, device):
            self.reached_run_job.append(len(segments))
            for s in segments:
                _write_wav(s["out_path"], 0.3)
            out = []
            for s in segments:
                e = {"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                     "out_path": s["out_path"], "sr": 24000, "x_vector_only": s["x_vector_only"],
                     "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                     "generation_limit": 256, "generated_iterations": 100,
                     "termination_reason": "completed_before_limit", "status": "ok"}
                if s.get("prefix_text"):   # controlled-prefix 를 잘라낸 사실(샘플 인덱스·dB)
                    e["reference_alignment"] = {
                        "sample_rate": 24000, "noise_floor_dbfs": -64.52,
                        "tail_end_sample": 2640, "valley_sample": 4200, "onset_sample": 5040,
                        "cut_sample": 4200, "valley_dbfs": -90.38, "lead_samples": 840}
                    e["reference_cut_sample"] = 4200
                    e["controlled_prefix"] = True
                out.append(e)
            return out
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job)

    def _synth_icl(self, prompts=None):
        tts_worker.synthesize(self.ref5, "안녕하세요 첫 문장입니다.", self.out, speed=1.0,
                              silence_gap=0.5, emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts=prompts if prompts is not None else {},
                              reference_conditioning_mode="high_quality_icl")

    def _meta(self):
        for mt, k in self.events:
            if mt == "result":
                return k.get("metadata")
        return None

    def test_transcript_failure_signals_then_fails_closed(self):
        """전사 실패 — 강등 신호는 그대로 나가되, 낮은 품질 결과를 발행하지 않는다."""
        self._whisper(raises=RuntimeError("whisper exploded"))
        with self.assertRaises(RuntimeError) as cm:
            self._synth_icl()
        # 강등 사유는 여전히 사용자가 볼 수 있는 신호로 나간다(사유 코드·모델명 그대로).
        evs = self._degraded_events()
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["reason_code"], "TRANSCRIPTION_FAILED")
        self.assertEqual(evs[0]["transcript_status"], "failed")
        self.assertEqual(evs[0]["model"], "small")
        self.assertEqual(evs[0]["emotion_id"], "default")
        # 결과는 없다 — 요청한 모드와 다른 품질을 무신호로 주지 않는다.
        self.assertEqual(cm.exception.error_payload["code"], "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")
        self.assertIsNone(self._meta())
        self.assertEqual(self.reached_run_job, [], "모델 도달 전 차단")
        # 보안: 오류 payload 에 경로·전사·예외 메시지가 없다
        blob = json.dumps(cm.exception.error_payload, ensure_ascii=False)
        for bad in ("whisper exploded", self.tmp, ".wav"):
            self.assertNotIn(bad, blob)

    def test_metadata_none_when_not_degraded(self):
        self._whisper(result={"text": "자동전사문장", "language": "ko"})
        self._synth_icl()
        m = self._meta()
        self.assertFalse(m["reference_prompt_degraded"])
        self.assertIsNone(m["reference_degrade_reason"])
        self.assertEqual(m["reference_transcript_status"], "ok")
        self.assertIsNone(m["reference_degraded_emotions"])
        self.assertEqual(m["prompt_source"], "auto")
        self.assertEqual([t for t, _ in self.events].count("tts_reference_degraded"), 0)
        # 전사가 확보됐으므로 controlled-prefix 가 실제로 잘렸고 그 수치가 남는다.
        self.assertEqual(m["reference_cut_sample"], 4200)
        self.assertEqual(m["reference_alignment"]["first"]["tail_end_sample"], 2640)
        # 보안 회귀: 어떤 메타 값에도 전사 전문이 들어가지 않는다
        self.assertNotIn("자동전사문장", json.dumps(m, ensure_ascii=False))

    def test_user_ref_free_signals_then_fails_closed(self):
        """사용자 ref-free 선택도 강등 기록은 남기되, ICL 요청과 모순이므로 결과를 내지 않는다."""
        self._whisper(result={"text": "자동전사문장", "language": "ko"})
        with self.assertRaises(RuntimeError) as cm:
            self._synth_icl({"default": {"mode": "ref_free"}})
        evs = self._degraded_events()
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["reason_code"], "REF_FREE_USER")
        self.assertEqual(evs[0]["transcript_status"], "user_ref_free")
        self.assertEqual(cm.exception.error_payload["code"], "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")
        self.assertIsNone(self._meta())

    def test_safe_mode_needs_no_transcript_and_still_produces_result(self):
        """대비: 안전 모드는 전사를 아예 시도하지 않으므로 같은 조건에서도 결과가 나온다."""
        self._whisper(raises=RuntimeError("whisper exploded"))
        tts_worker.synthesize(self.ref5, "안녕하세요 첫 문장입니다.", self.out, speed=1.0,
                              silence_gap=0.5, emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts={}, reference_conditioning_mode="safe_xvector")
        m = self._meta()
        self.assertIsNotNone(m)
        self.assertEqual(m["prompt_source"], "x-vector-only")
        self.assertTrue(m["x_vector_only_mode"])
        self.assertEqual(self._degraded_events(), [], "전사를 시도하지 않았으므로 강등이 아니다")
        self.assertIsNone(m["reference_alignment"])
        self.assertIsNone(m["reference_cut_sample"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
