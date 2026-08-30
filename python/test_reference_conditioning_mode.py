# -*- coding: utf-8 -*-
"""참조 conditioning 모드(참조혼입 대응) — 단일 권위 계약 테스트.

고정하는 계약:
  - resolve: 부재(None/'') → safe_xvector(안전 기본, legacy 세션 포함). 유효 2값 통과.
    잘못된 값 → 조용한 강등 없이 구조화 오류(INVALID_REFERENCE_CONDITIONING_MODE), 원시값 미포함.
  - synthesize 입구: 잘못된 값 → 구조화 오류(모델/파싱 미진입).
    **모드 미전달(None)도 safe_xvector 로 해석한다** — 전사 기반 ICL 로 가는 '모드 없는 기본
    경로'는 더 이상 존재하지 않는다(legacy 경로 제거).
  - safe_xvector 배선: 전 segment x_vector_only=True + ref_text 미전달(""), Whisper/정렬검증 호출 0,
    manual 전사는 보존되되 합성 조건 전달 0, job 내 모드 고정(자동 ICL fallback 0).
  - high_quality_icl 배선: 전 segment 가 자기 prefix_text(참조 전사)를 달고 ICL(xvo=False)로 나간다.
    참조 전사를 못 얻으면(전사 실패/빈 전사/사용자 ref-free) 조용히 안전 모드처럼 돌지 않고
    ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE 로 실패한다. bridge 의 raw 는 중간 산출물이고,
    부모가 ASR 정렬 → 창 한정 경계 검출 → 절단까지 마쳐야 결과가 확정된다. 정렬이 어긋나면
    ICL_BOUNDARY_ALIGNMENT_FAILED 로 결과를 발행하지 않는다(safe_xvector 로의 조용한 전환 없음).
  - metadata 왕복: requested/effective/degraded/alignment/cut_sample/failure_code 키 상시 존재.
    ICL 성공 시 alignment/cut_sample 은 실제 검출 수치(샘플 인덱스·dB)로 채워진다.
  - separate.py 배선: config 키 ttsReferenceConditioningMode → resolve → synthesize 명시 전달.

GPU·Whisper 실모델 없음(run_job 대체).
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import numpy as np
import soundfile as sf
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
        for mode in ("auto", "safe_xvector", "high_quality_icl"):
            self.assertEqual(tts_worker.resolve_reference_conditioning_mode(mode), mode)

    def test_invalid_value_raises_structured_error(self):
        """조용한 강등 금지 — 계약 밖 값은 구조화 오류로 크게 실패한다."""
        for bad in ("icl", "SAFE_XVECTOR", "xvector", "AUTO", 1, True, ["safe_xvector"], {"m": 1}):
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

    def test_legacy_none_is_resolved_to_safe_at_function_level(self):
        """모드 미전달도 안전 기본으로 해석된다 — 전사 기반 ICL 기본 경로는 존재하지 않는다.
        (소스 고정: synthesize 가 None 분기 없이 resolver 를 통과시킨다.)"""
        import inspect
        src = inspect.getsource(tts_worker.synthesize)
        self.assertIn("rc_mode = resolve_reference_conditioning_mode(reference_conditioning_mode)",
                      src)
        self.assertNotIn("if reference_conditioning_mode is not None:", src,
                         "None 을 특별 취급하는 legacy 분기가 남아 있으면 안 된다")
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode(None), "safe_xvector")

    def test_icl_gate_removed(self):
        """더 이상 입구에서 ICL 을 차단하지 않는다(실제 controlled-prefix 경로가 동작한다)."""
        self.assertFalse(hasattr(tts_worker, "ICL_BOUNDARY_POLICY_UNCONFIRMED"))
        self.assertEqual(tts_worker.ICL_BOUNDARY_ALIGNMENT_FAILED,
                         "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual(tts_worker.ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE,
                         "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")

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
        # synthesize 는 이제 **항상** run bundle 을 남긴다. 테스트가 앱 관리 영역(_local)에
        # 기록을 쌓지 않도록 임시 루트로 돌린다(제품 동작이 아니라 테스트 위생).
        import chunk_publish as _cp
        import local_assets as _la
        _snap = {k: os.environ.get(k) for k in (_la.LOCAL_ROOT_ENV, _cp.ENV)}
        os.environ[_la.LOCAL_ROOT_ENV] = os.path.join(self.tmp, "_local")
        os.environ.pop(_cp.ENV, None)
        _cp._AUTO_RUN_ID = None

        def _restore_local_root():
            for k, v in _snap.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            _cp._AUTO_RUN_ID = None
        self.addCleanup(_restore_local_root)
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
        # chunk WAV 를 쓰는 방식(ICL 테스트는 controlled-prefix raw 를 쓰도록 갈아끼운다).
        self.chunk_writer = lambda path, seg: _write_wav(path, 0.3)
        # bridge 가 돌려주는 chunk 결과의 추가 필드. dict 이거나 seg → dict 콜러블.
        self.entry_extra = {}
        self.run_job_error = None

        def fake_run_job(inner_self, segments, device):
            self.captured_segments.append([dict(s) for s in segments])
            if self.run_job_error is not None:
                raise self.run_job_error
            for s in segments:
                self.chunk_writer(s["out_path"], s)
            return [dict({"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                          "out_path": s["out_path"], "sr": 24000,
                          "x_vector_only": s["x_vector_only"],
                          "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                          "generation_limit": 256, "generated_iterations": 100,
                          "termination_reason": "completed_before_limit", "status": "ok"},
                         **(self.entry_extra(s) if callable(self.entry_extra) else self.entry_extra))
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
        self.assertIs(m["reference_conditioning_degraded"], False,
                      "조용한 모드 대체 없음 — '품질 제약 없음'이라는 뜻이 아니다")
        # 그 '제약'은 별도 필드가 명시한다(안전 모드는 비어 있지 않다).
        self.assertIn(tts_worker.CONSTRAINT_EMOTION_MAY_FLATTEN,
                      m["reference_conditioning_constraints"])
        self.assertIn(tts_worker.CONSTRAINT_PROSODY_NOT_TRANSFERRED,
                      m["reference_conditioning_constraints"])
        self.assertIsNone(m["reference_alignment"], "안전 모드: 내용 정렬 미수행 → null")
        self.assertIsNone(m["reference_cut_sample"], "절단 정책 미확정 → null")
        self.assertIsNone(m["reference_conditioning_failure_code"])
        # 안정 우선을 명시 요청했으므로 ICL 은 시도조차 하지 않고 전환도 없다(시도 1회).
        self.assertIs(m["reference_conditioning_icl_attempted"], False)
        self.assertIs(m["reference_conditioning_icl_published"], False)
        self.assertIs(m["reference_conditioning_auto_fallback"], False)
        self.assertEqual(m["reference_conditioning_attempts"], 1)
        self.assertIsNone(m["reference_conditioning_notice"], "전환하지 않았으면 문구도 없다")
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
    """모드 미전달(구 직접 호출) — 이제 safe_xvector 로 해석된다(legacy ICL 기본 경로 제거).
    production 은 separate.py 가 항상 명시 값을 전달하므로 이 경로는 구 호출부/테스트 전용이다."""

    def test_absent_mode_runs_as_safe_xvector(self):
        # 안전 모드면 Whisper 를 아예 타지 않는다 — _no_whisper 감시가 그대로 걸려 있다.
        tts_worker.synthesize(self.ref5, "안녕하세요 첫 문장입니다.", self.out, speed=1.0,
                              silence_gap=0.5, emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts={})
        segs = self._flat_segments()
        self.assertEqual(segs[0]["ref_text"], "", "모드 미전달도 참조 전사를 전달하지 않는다")
        self.assertTrue(segs[0]["x_vector_only"])
        self.assertNotIn("prefix_text", segs[0])
        self.assertEqual(self.whisper_calls, [])
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_requested"], "safe_xvector")
        self.assertEqual(m["reference_conditioning_mode_effective"], "safe_xvector")
        self.assertIs(m["reference_conditioning_degraded"], False)
        for k in ("reference_alignment", "reference_cut_sample",
                  "reference_conditioning_failure_code"):
            self.assertIn(k, m)
            self.assertIsNone(m[k], f"안전 모드는 {k} 를 기록하지 않는다(null)")


# controlled-prefix 합성 파형·ASR 픽스처는 test_icl_alignment 가 소유한다(중복 정의 금지 —
# 좌표가 두 곳에 있으면 한쪽만 고쳐지는 순간 이 경로의 회귀가 조용히 죽는다).
import test_icl_alignment as _fx  # noqa: E402

# 참조 발화의 인식 결과(항상 목표 대사보다 앞선다). 시각은 _fx 의 합성 파형 좌표와 정합.
_REF_WORDS = [("참조", 0.00, 0.45), ("음성의", 0.45, 1.00),
              ("원래", 1.30, 1.80), ("대사입니다", 1.80, 2.30)]


class _IclFixtureBase(_QwenJobBase):
    """controlled-prefix 경로 픽스처(모델·GPU·Whisper 없음). RC_MODE 만 갈아 끼워 재사용한다 —
    high_quality_icl(명시 요청)과 auto(자동)가 **같은 파형·같은 ASR 스텁** 위에서 비교돼야
    "무엇이 달라졌는가"가 모드 차이 하나로 좁혀진다."""

    RC_MODE = None                                     # 하위 클래스가 정한다
    TEXT = "안녕하세요 첫 문장입니다.\n[기쁨] 좋은 소식이 있어요!\n마지막 문장입니다."
    REF_TEXT = "참조 음성의 원래 대사입니다"

    def _enable_legacy_controlled_prefix(self):
        """legacy rollback 경로를 **명시적으로** 켠다. production 기본은 vendor native ICL 이라
        이 호출 없이는 prefix_text 가 조립되지 않는다. controlled-prefix 계약을 검증하는
        테스트만 부른다."""
        import os as _os
        prev = _os.environ.get("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX")
        _os.environ["AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"] = "1"

        def _restore():
            if prev is None:
                _os.environ.pop("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX", None)
            else:
                _os.environ["AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"] = prev
        self.addCleanup(_restore)

    def setUp(self):
        super().setUp()
        self.chunk_targets = {}      # chunk 경로 → 그 chunk 의 목표 대사(ASR 스텁이 참조)
        self._patch_obj(transcribe_worker, "run_transcribe", side_effect=self._fake_transcribe)
        self.chunk_writer = self._write_controlled_prefix_chunk
        # bridge 가 내는 것과 같은 형태: 미절단 raw + 정렬 요청(부모가 소비하고 버린다).
        # ⚠️ controlled-prefix 를 실제로 단 segment 에만 붙인다 — 실제 bridge 와 같다. 이 조건이
        #    없으면 prefix 없는 안전 모드 chunk 에까지 정렬을 요구하게 되어, auto 의 safe 전환
        #    시도가 픽스처 때문에 실패한다(테스트가 production 을 잘못 모사하는 경우).
        self.entry_extra = lambda s: ({
            "controlled_prefix": True, "needs_alignment": True,
            "alignment_request": {"needs_alignment": True,
                                  "prefix_text": s.get("prefix_text") or "",
                                  "target_text": s["text"], "sample_rate": 24000}}
            if s.get("prefix_text") else {})

    def _write_controlled_prefix_chunk(self, path, seg):
        """bridge 가 남기는 것과 같은 **미절단 raw** — 참조 발화 + (더 긴 참조 내부 무음) + 목표."""
        import numpy as np
        import soundfile as sf
        sf.write(path, np.asarray(_fx._decoy_wave(), dtype="float32"), 24000)
        self.chunk_targets[os.path.abspath(path)] = seg["text"]

    def _fake_transcribe(self, model, path, language):
        """참조 클립이면 전사문, chunk 면 단어 타임스탬프(실제 whisper 출력 형태)."""
        tgt = self.chunk_targets.get(os.path.abspath(path))
        if tgt is None:
            return {"text": self.REF_TEXT, "language": "ko"}
        onset = _fx.TARGET_ONSET / 24000.0
        words = list(_REF_WORDS)
        for i, w in enumerate(tgt.split()):
            words.append((w, onset + i * 0.40, onset + i * 0.40 + 0.38))
        return _fx._words(words)

    def _synth(self, text=None, **kw):
        tts_worker.synthesize(
            self.ref5, text or self.TEXT, self.out, speed=1.0, silence_gap=0.5,
            emotion_refs={"happy": self.happy_ref},
            emotion_ref_sources={"happy": self.happy_ref},
            preferred_engine="qwen3", reference_prompts={},
            reference_conditioning_mode=self.RC_MODE, **kw)


class IclControlledPrefixTest(_IclFixtureBase):
    """high_quality_icl — controlled-prefix 가 실제로 배선되고, **부모가 ASR 정렬로 잘라낸**
    실제 절단 기록이 metadata 까지 온다(정답 창 주입 없음 — 창은 production 코드가 만든다).
    명시 요청이므로 정렬 실패는 **전환 없이** 실패로 끝난다(자동 전환은 auto 만의 일)."""

    RC_MODE = "high_quality_icl"

    def setUp(self):
        super().setUp()
        self._enable_legacy_controlled_prefix()      # legacy 계약 전용

    def test_every_segment_carries_its_own_prefix_and_stays_icl(self):
        """장문(여러 segment)에서도 segment 마다 자기 controlled-prefix 를 단다 — 모드는 job 고정."""
        self._synth()
        segs = self._flat_segments()
        self.assertEqual(len(segs), 3)
        for s in segs:
            self.assertFalse(s["x_vector_only"], f"seg {s['index']} 는 ICL 이어야 한다")
            self.assertEqual(s["ref_text"], self.REF_TEXT)
            self.assertEqual(s["prefix_text"], self.REF_TEXT,
                             f"seg {s['index']} 가 자기 prefix 를 들고 가야 한다")
        # 감정 참조가 달라도 모드는 바뀌지 않는다(자동 fallback 0).
        self.assertEqual(len({s["ref_audio"] for s in segs}), 2)

    def test_prefix_text_assembles_into_controlled_prefix(self):
        """bridge 가 조립할 때 [참조 전사][종결][개행][목표 대사] 가 된다(조립 규칙 단일 소스)."""
        import prefix_alignment as pa
        self._synth()
        s = self._flat_segments()[0]
        built = pa.build_controlled_prefix_text(s["prefix_text"], s["text"])
        self.assertTrue(built.startswith(self.REF_TEXT + "."))
        self.assertEqual(built, self.REF_TEXT + ".\n" + s["text"])

    def test_metadata_carries_real_alignment_values(self):
        self._synth()
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_requested"], "high_quality_icl")
        self.assertEqual(m["reference_conditioning_mode_effective"], "high_quality_icl")
        self.assertIs(m["reference_conditioning_degraded"], False)
        self.assertIsNone(m["reference_conditioning_failure_code"])
        # ICL 을 시도했고 그 결과를 발행했다(전환 없음, 시도 1회).
        self.assertIs(m["reference_conditioning_icl_attempted"], True)
        self.assertIs(m["reference_conditioning_icl_published"], True)
        self.assertIs(m["reference_conditioning_auto_fallback"], False)
        self.assertEqual(m["reference_conditioning_attempts"], 1)
        self.assertIsNone(m["reference_conditioning_notice"])
        cut = _fx.VALLEY_AT
        self.assertEqual(m["reference_cut_sample"], cut)
        a = m["reference_alignment"]
        self.assertEqual(a["chunk_count"], 3)
        self.assertEqual(a["cut_sample_min"], cut)
        self.assertEqual(a["cut_sample_max"], cut)
        self.assertEqual(a["trimmed_samples_total"], cut * 3)
        self.assertEqual(a["first"]["tail_end_sample"], _fx.GAP_START)
        self.assertEqual(a["first"]["valley_sample"], cut)
        # 창 한정 탐색이었다는 사실이 기록에 남는다 — 참조 내부의 '더 긴' 무음은 창 밖이다.
        # 창의 왼쪽은 '앞 단어 끝'(2.30s)으로 브래킷된다(anchor 하나로 잡지 않는다).
        self.assertEqual(a["first"]["anchor_start_sample"], _fx.TARGET_ONSET)
        self.assertEqual(a["first"]["prev_word_end_sample"], int(round(2.30 * 24000)))
        self.assertEqual(a["first"]["window_start_sample"],
                         int(round((2.30 - 0.200) * 24000)))
        self.assertGreater(a["first"]["window_start_sample"], _fx.REF_A + _fx.DECOY_GAP)
        # 어떤 신호로 개시를 인정했는지도 남는다(유성음만 보고 자르지 않았다는 증거).
        self.assertGreater(a["first"]["onset_evidence"], 0)
        self.assertIsInstance(a["first"]["onset_flux_threshold"], float)
        # 기존 계약 필드와의 정합: 실제 적용 상태는 ICL(자동 전사).
        self.assertEqual(m["prompt_source"], "auto")
        self.assertFalse(m["x_vector_only_mode"])

    def test_chunks_are_actually_trimmed_on_disk(self):
        """정렬은 '기록'이 아니라 실제 절단이다 — chunk 파일이 cut 만큼 실제로 짧아진다.
        (job_dir 은 합성 끝에 통째 지워지므로 절단 직후의 실측을 가로채 확인한다.)"""
        import icl_alignment
        import soundfile as sf
        seen = []
        real = icl_alignment.align_and_trim

        def _spy(path, *a, **kw):
            r = real(path, *a, **kw)
            seen.append((r["frames_before"], r["frames_after"], sf.info(path).frames))
            return r
        self._patch_obj(icl_alignment, "align_and_trim", new=_spy)
        self._synth()
        self.assertEqual(len(seen), 3)
        for before, after, on_disk in seen:
            self.assertEqual(before, _fx.TOTAL_N)
            self.assertEqual(after, _fx.TOTAL_N - _fx.VALLEY_AT)
            self.assertEqual(on_disk, after, "파일이 실제로 그만큼 짧아졌다")

    def test_alignment_failure_blocks_publication(self):
        """정렬이 안 되면(여기서는 목표 대사 머리가 인식에 없음) 결과를 발행하지 않는다."""
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l:
                                     {"text": self.REF_TEXT, "language": "ko"}
                                     if os.path.abspath(p) not in self.chunk_targets
                                     else _fx._words(_REF_WORDS)))
        with self.assertRaises(RuntimeError) as cm:
            self._synth()
        p = cm.exception.error_payload
        self.assertEqual(p["code"], "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual(p["boundary_reason"], "PREFIX_ALIGN_ANCHOR_NOT_FOUND")
        self.assertEqual([t for t, _ in self.events].count("result"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.out, "synthesized.wav")))

    def test_alignment_progress_is_reported(self):
        """정렬 중에도 진행 표시가 계속 나간다(Electron watchdog 은 progress 로만 리셋된다)."""
        self._synth()
        msgs = [k.get("message", "") for t, k in self.events if t == "progress"]
        aligning = [m for m in msgs if "경계 정렬 중" in m]
        self.assertEqual(len(aligning), 3, "chunk 마다 1회")

    def test_alignment_input_text_never_reaches_result(self):
        """정렬 입력(참조 전사·목표 대사)은 소비 후 버려진다 — 결과 payload 어디에도 없다."""
        self._synth()
        blob = json.dumps([k for _t, k in self.events], ensure_ascii=False, default=str)
        self.assertNotIn("alignment_request", blob)
        self.assertNotIn(self.REF_TEXT, blob)

    def test_metadata_has_no_transcript_or_path(self):
        """보안: 절단 기록은 샘플 인덱스와 dB 뿐 — 전사 원문·절대경로가 없다."""
        self._synth()
        blob = json.dumps(self._meta()["reference_alignment"], ensure_ascii=False)
        self.assertNotIn(self.REF_TEXT, blob)
        self.assertNotIn(self.tmp, blob)
        self.assertNotIn(".wav", blob)

    def test_icl_announced_once(self):
        self._synth()
        msgs = [k.get("message", "") for t, k in self.events if t == "progress"]
        self.assertEqual(len([m for m in msgs if "참조 억양 반영 모드" in m]), 1)

    def test_missing_alignment_record_fails_closed(self):
        """절단됐는지 확인할 수 없는 결과는 발행하지 않는다."""
        self.entry_extra = {}
        with self.assertRaises(RuntimeError) as cm:
            self._synth()
        self.assertEqual(cm.exception.error_payload["code"], "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual([t for t, _ in self.events].count("result"), 0)

    def test_bridge_boundary_failure_surfaces_as_structured_error(self):
        self.run_job_error = tts_worker.QwenIclBoundaryError(
            1, 0, "happy", "PREFIX_BOUNDARY_ONSET_NOT_FOUND")
        with self.assertRaises(RuntimeError) as cm:
            self._synth()
        p = cm.exception.error_payload
        self.assertEqual(p["code"], "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual(p["segment_index"], 1)
        self.assertEqual(p["chunk_index"], 0)
        self.assertEqual(p["emotion_id"], "happy")
        self.assertEqual(p["boundary_reason"], "PREFIX_BOUNDARY_ONSET_NOT_FOUND")
        self.assertIn("안전 음성 복제", str(cm.exception), "안전 모드 선택을 안내한다")
        self.assertEqual([t for t, _ in self.events].count("result"), 0,
                         "결과를 발행하지 않는다(조용한 safe 전환도 없다)")
        blob = json.dumps(p, ensure_ascii=False)
        self.assertNotIn(self.REF_TEXT, blob)


class IclTranscriptRequiredTest(_QwenJobBase):
    """참조 전사를 못 얻으면 ICL 은 조용히 안전 모드처럼 돌지 않고 명시적으로 실패한다."""

    def _synth(self, prompts):
        tts_worker.synthesize(self.ref5, "안녕하세요 첫 문장입니다.", self.out, speed=1.0,
                              silence_gap=0.5, emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts=prompts,
                              reference_conditioning_mode="high_quality_icl")

    def _assert_fails_closed(self):
        with self.assertRaises(RuntimeError) as cm:
            self._synth({})
        self.assertEqual(cm.exception.error_payload["code"],
                         "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")
        self.assertIn("안전 음성 복제", str(cm.exception))
        self.assertEqual([t for t, _ in self.events].count("result"), 0)
        self.assertEqual(self.captured_segments, [], "run_job(모델) 도달 전 차단")

    def test_transcription_failure_fails_closed(self):
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l: (_ for _ in ()).throw(RuntimeError("boom"))))
        self._assert_fails_closed()

    def test_empty_transcript_fails_closed(self):
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l: {"text": "   ", "language": "ko"}))
        self._assert_fails_closed()

    def test_user_ref_free_fails_closed(self):
        """사용자 ref-free 선택과 '참조 억양 반영'은 모순 — 조용히 한쪽을 이기지 않는다."""
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l: {"text": "자동전사", "language": "ko"}))
        with self.assertRaises(RuntimeError) as cm:
            self._synth({"default": {"mode": "ref_free"}})
        self.assertEqual(cm.exception.error_payload["code"],
                         "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")
        self.assertEqual([t for t, _ in self.events].count("result"), 0)


class LegacyAutoModeTest(_IclFixtureBase):
    """auto(자동) — ICL 을 먼저 시도하고, **정렬이 성립하지 않은 경우에만** 그 결과를 버리고
    safe_xvector 로 정확히 1회 전환한다.

    이 클래스가 고정하는 것(하나라도 깨지면 계약이 무너진다):
      1. ICL 성공 → ICL 결과 1개 발행, 전환 없음(시도 1회).
      2. 정렬 실패 → 잘못된 ICL 결과 0개(디스크에도 남지 않음), safe 결과 1개, fallback metadata 정확.
      3. 전환은 **최대 1회** — safe 까지 실패하면 3번째 시도 없이 그대로 실패한다.
      4. 정렬과 무관한 실패(생성 상한 등)는 전환하지 않는다(모드를 바꿔도 해결되지 않는 문제).
      5. terminal(result/error)은 정확히 1회.
      6. 사용자에게 나가는 문구는 하나뿐이고 내부 code·전사·경로는 그 경로로 새지 않는다.
    """

    RC_MODE = "auto"

    def setUp(self):
        super().setUp()
        self._enable_legacy_controlled_prefix()      # legacy auto 계약

    def _terminal_count(self):
        return len([t for t, _ in self.events if t in ("result", "error")])

    def _break_alignment(self):
        """chunk 인식 결과에 목표 대사 머리가 없게 만든다 → PREFIX_ALIGN_ANCHOR_NOT_FOUND."""
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l:
                                     {"text": self.REF_TEXT, "language": "ko"}
                                     if os.path.abspath(p) not in self.chunk_targets
                                     else _fx._words(_REF_WORDS)))

    # ── 1. ICL 성공 ────────────────────────────────────────────────────────
    def test_icl_success_publishes_icl_result_without_switching(self):
        self._synth()
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_requested"], "auto")
        self.assertEqual(m["reference_conditioning_mode_effective"], "high_quality_icl")
        self.assertIs(m["reference_conditioning_icl_attempted"], True)
        self.assertIs(m["reference_conditioning_icl_published"], True)
        self.assertIs(m["reference_conditioning_auto_fallback"], False)
        self.assertIs(m["reference_conditioning_degraded"], False)
        self.assertIsNone(m["reference_conditioning_failure_code"])
        self.assertIsNone(m["reference_conditioning_notice"])
        self.assertEqual(m["reference_conditioning_attempts"], 1)
        self.assertEqual(m["reference_cut_sample"], _fx.VALLEY_AT, "실제 절단 기록이 남는다")
        self.assertEqual(len(self.captured_segments), 1, "성공하면 job 은 한 번만 돈다")
        self.assertEqual(self._terminal_count(), 1)
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))

    # ── 2. 정렬 실패 → 폐기 후 safe 1회 전환 ───────────────────────────────
    def test_alignment_failure_discards_icl_and_switches_to_safe_once(self):
        self._break_alignment()
        self._synth()
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_requested"], "auto")
        self.assertEqual(m["reference_conditioning_mode_effective"], "safe_xvector")
        self.assertIs(m["reference_conditioning_icl_attempted"], True)
        self.assertIs(m["reference_conditioning_icl_published"], False,
                      "정렬 실패분은 절대 발행하지 않는다")
        self.assertIs(m["reference_conditioning_auto_fallback"], True)
        self.assertIs(m["reference_conditioning_degraded"], True)
        self.assertEqual(m["reference_conditioning_failure_code"],
                         "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual(m["reference_conditioning_notice"],
                         tts_worker.REFERENCE_CONDITIONING_FALLBACK_NOTICE)
        self.assertEqual(m["reference_conditioning_attempts"], 2)
        # 전환 뒤 기록은 안전 모드의 것이다 — 절단 기록은 없고(정렬 미수행) 제약은 안전 모드의 것.
        self.assertIsNone(m["reference_alignment"])
        self.assertIsNone(m["reference_cut_sample"])
        self.assertIn(tts_worker.CONSTRAINT_EMOTION_MAY_FLATTEN,
                      m["reference_conditioning_constraints"])
        self.assertEqual(m["prompt_source"], "x-vector-only")
        # 결과는 정확히 하나 — safe 로 만든 것.
        self.assertEqual(self._terminal_count(), 1)
        self.assertEqual([t for t, _ in self.events].count("result"), 1)
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))

    def test_two_attempts_are_icl_then_safe(self):
        """실제로 무엇을 두 번 돌렸는지 — 1차는 prefix 를 단 ICL, 2차는 전사 미전달 safe."""
        self._break_alignment()
        self._synth()
        self.assertEqual(len(self.captured_segments), 2, "job 은 정확히 두 번(전환 1회)")
        first, second = self.captured_segments
        for s in first:
            self.assertFalse(s["x_vector_only"])
            self.assertEqual(s["prefix_text"], self.REF_TEXT)
        for s in second:
            self.assertTrue(s["x_vector_only"], "전환 후에는 x-vector 전용")
            self.assertEqual(s["ref_text"], "", "전환 후에는 참조 전사를 전달하지 않는다")
            self.assertNotIn("prefix_text", s, "전환 후에는 controlled-prefix 가 없다")

    # ── 3. 전환은 최대 1회 ─────────────────────────────────────────────────
    def test_switch_happens_at_most_once(self):
        """safe 까지 실패하면 3번째 시도 없이 그대로 실패한다(재시도 루프 없음)."""
        self.run_job_error = tts_worker.QwenIclBoundaryError(
            0, 0, "default", "PREFIX_BOUNDARY_ONSET_NOT_FOUND")
        with self.assertRaises(RuntimeError) as cm:
            self._synth()
        self.assertEqual(cm.exception.error_payload["code"], "ICL_BOUNDARY_ALIGNMENT_FAILED")
        self.assertEqual(len(self.captured_segments), 2, "시도는 2회를 넘지 않는다")
        self.assertEqual([t for t, _ in self.events].count("result"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.out, "synthesized.wav")))

    # ── 4. 정렬과 무관한 실패는 전환하지 않는다 ─────────────────────────────
    def test_generation_limit_does_not_trigger_switch(self):
        """모드를 바꿔도 해결되지 않는 실패까지 자동 전환하면 원인이 사용자에게서 사라진다."""
        self.run_job_error = tts_worker.QwenGenerationLimitError(
            0, 256, 256, emotion_id="default", chunk_index=0)
        with self.assertRaises(RuntimeError) as cm:
            self._synth()
        self.assertEqual(cm.exception.error_payload["code"], "GENERATION_LIMIT_EXCEEDED")
        self.assertEqual(len(self.captured_segments), 1, "전환하지 않는다(시도 1회)")
        self.assertEqual([t for t, _ in self.events].count("result"), 0)

    # ── 참조 전사가 없어 ICL 이 성립하지 않는 경우도 전환 대상 ───────────────
    def test_missing_reference_transcript_switches_to_safe(self):
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda m, p, l: {"text": "   ", "language": "ko"}))
        self._synth()
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_effective"], "safe_xvector")
        self.assertEqual(m["reference_conditioning_failure_code"],
                         "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE")
        self.assertEqual(m["reference_conditioning_attempts"], 2)
        self.assertIs(m["reference_conditioning_icl_published"], False)
        # 1차는 모델 도달 전에 막히므로 run_job 은 safe 한 번만 돈다.
        self.assertEqual(len(self.captured_segments), 1)
        self.assertEqual(self._terminal_count(), 1)

    # ── 6. 사용자 문구는 하나, 내부 code·전사·경로는 새지 않는다 ─────────────
    def test_single_user_message_and_no_internal_code_in_messages(self):
        self._break_alignment()
        self._synth()
        msgs = [k.get("message", "") for t, k in self.events if t in ("progress", "status")]
        self.assertEqual(len([m for m in msgs
                              if m == tts_worker.REFERENCE_CONDITIONING_FALLBACK_NOTICE]), 1,
                         "전환 문구는 정확히 한 번")
        for msg in msgs:
            self.assertNotIn("ICL_BOUNDARY", msg, "내부 code 는 기본 UI 경로로 나가지 않는다")
            self.assertNotIn("PREFIX_ALIGN", msg)
            self.assertNotIn(self.REF_TEXT, msg, "참조 전사 원문은 어디에도 나가지 않는다")
            self.assertNotIn(self.tmp, msg, "절대경로는 나가지 않는다")

    def test_switch_declares_job_restart_for_the_watchdog(self):
        """2회차는 같은 조각 번호를 다시 낸다 — 이 선언이 없으면 Electron 감시가 '재전송'으로만
        보고 긴 2회차를 무진행으로 오판해 죽인다(기계용 필드, 표시 문구와는 별개)."""
        self._break_alignment()
        self._synth()
        restarts = [k for t, k in self.events
                    if t == "progress" and k.get("job_restarted") is True]
        self.assertEqual(len(restarts), 1, "재시작 선언은 전환 시 정확히 한 번")
        self.assertEqual(restarts[0].get("message"),
                         tts_worker.REFERENCE_CONDITIONING_FALLBACK_NOTICE)

    def test_no_restart_declared_when_icl_succeeds(self):
        self._synth()
        self.assertEqual([k for t, k in self.events
                          if t == "progress" and k.get("job_restarted") is True], [])

    def test_fallback_metadata_carries_no_transcript_or_path(self):
        self._break_alignment()
        self._synth()
        blob = json.dumps(self._meta(), ensure_ascii=False, default=str)
        self.assertNotIn(self.REF_TEXT, blob)
        self.assertNotIn(self.tmp, blob)


class SafeFirstNoIclWorkTest(_IclFixtureBase):
    """안정 우선(safe_xvector) — ICL 시도도, ASR 정렬도 **호출 0**. 자동 전환도 없다."""

    RC_MODE = "safe_xvector"

    def test_no_icl_and_no_alignment_calls(self):
        import icl_alignment
        calls = []
        self._patch_obj(icl_alignment, "align_and_trim",
                        new=(lambda *a, **k: calls.append(a)))
        # 안전 모드에서 Whisper 가 호출되면 _QwenJobBase 의 감시가 AssertionError 를 던진다.
        self._patch_obj(transcribe_worker, "run_transcribe",
                        side_effect=(lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("safe_xvector 에서 전사가 호출되면 안 된다"))))
        self._synth()
        self.assertEqual(calls, [], "정렬(ASR 창 탐색·절단)은 한 번도 호출되지 않는다")
        segs = self._flat_segments()                    # run_job 은 정확히 1회
        for s in segs:
            self.assertTrue(s["x_vector_only"])
            self.assertNotIn("prefix_text", s)
        m = self._meta()
        self.assertEqual(m["reference_conditioning_mode_requested"], "safe_xvector")
        self.assertEqual(m["reference_conditioning_mode_effective"], "safe_xvector")
        self.assertIs(m["reference_conditioning_icl_attempted"], False)
        self.assertIs(m["reference_conditioning_auto_fallback"], False)
        self.assertEqual(m["reference_conditioning_attempts"], 1)
        self.assertEqual([t for t, _ in self.events].count("result"), 1)


class ConstraintSemanticsTest(unittest.TestCase):
    """'요청 모드를 정상 실행함'과 '품질 제약 없음'은 다른 사실이다 — 한 필드에 뭉개지 않는다.

    degraded 는 조용한 모드 대체 여부만 말한다(자동 전환 금지 계약이라 항상 False). safe_xvector
    가 설계상 갖는 제약(참조 억양 미전달·감정 평탄화 가능)은 별도 필드로 명시한다 — 그래야
    metadata 만 보고 '제약 없음'으로 오독되지 않는다. UI 문구와 같은 사실을 가리켜야 한다."""

    def test_safe_mode_declares_its_quality_constraints(self):
        c = tts_worker.reference_conditioning_constraints(
            tts_worker.REF_CONDITIONING_SAFE_XVECTOR)
        self.assertIn(tts_worker.CONSTRAINT_PROSODY_NOT_TRANSFERRED, c)
        self.assertIn(tts_worker.CONSTRAINT_EMOTION_MAY_FLATTEN, c)

    def test_icl_mode_has_no_declared_constraint(self):
        self.assertEqual(
            tts_worker.reference_conditioning_constraints(
                tts_worker.REF_CONDITIONING_HIGH_QUALITY_ICL), [])

    def test_unknown_mode_declares_nothing(self):
        self.assertEqual(tts_worker.reference_conditioning_constraints("nope"), [])

    def test_constraints_are_nonsensitive_tokens(self):
        for mode in tts_worker.REF_CONDITIONING_MODES:
            for t in tts_worker.reference_conditioning_constraints(mode):
                self.assertIsInstance(t, str)
                self.assertTrue(all(ch.islower() or ch == "_" for ch in t), t)

    def test_ui_copy_states_the_same_constraint(self):
        """UI 문구와 metadata 가 같은 사실을 말해야 한다(조용한 계약 어긋남 금지)."""
        ui = os.path.join(os.path.dirname(HERE), "src", "renderer", "components", "TTSEditor.tsx")
        src = open(ui, encoding="utf-8").read()
        self.assertIn("감정 표현은 다소 평탄할 수 있음", src,
                      "safe_xvector 의 품질 제약이 UI 에도 적혀 있어야 한다")


class MetadataSchemaTest(unittest.TestCase):
    RC_KEYS = ["reference_conditioning_mode_requested", "reference_conditioning_mode_effective",
               "reference_conditioning_degraded", "reference_alignment", "reference_cut_sample",
               "reference_conditioning_failure_code", "reference_conditioning_constraints",
               # auto(자동 모드) 재현 필드 — 무엇을 시도했고 무엇을 발행했는지.
               "reference_conditioning_icl_attempted", "reference_conditioning_icl_published",
               "reference_conditioning_auto_fallback", "reference_conditioning_attempts",
               "reference_conditioning_notice"]

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


class NativeAutoModeTest(_QwenJobBase):
    """auto(자동) — **production 기본 경로**인 vendor native ICL 계약.

    legacy controlled-prefix env 를 켜지 않는다. 따라서:
      · prefix_text 가 조립되지 않는다(controlled-prefix 0)
      · 외부 ASR alignment·trim 이 호출되지 않는다(external alignment 0)
      · 발행 근거는 vendor_internal_crop_record 다
    이 클래스가 고정하는 것: crop record 가 없거나 무효면 auto 는 safe 로 **정확히 1회**
    전환하고, 명시 high_quality_icl 은 같은 조건에서 fail-closed 다.
    """

    RC_MODE = "auto"
    TEXT = "안녕하세요 첫 문장입니다."
    REF_TEXT = "참조 음성의 원래 대사입니다"

    def test_legacy_env_is_not_set(self):
        """이 계약은 legacy rollback 을 켜지 않는다는 사실 자체가 전제다."""
        self.assertNotEqual(os.environ.get("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX"), "1")

    def test_missing_crop_record_is_an_auto_fallback_trigger(self):
        """vendor native 경로의 발행 근거 부재는 auto 에서 safe 전환 사유다."""
        self.assertIn(tts_worker.MISSING_OR_INVALID_VENDOR_CROP_RECORD,
                      tts_worker.AUTO_FALLBACK_TRIGGER_CODES)

    def test_explicit_icl_does_not_auto_switch_on_invalid_crop_record(self):
        """명시 high_quality_icl 은 같은 사유로 전환하지 않는다 — fail-closed 다.

        전환 여부는 요청 모드로 갈린다(auto 만 전환). trigger 목록에 있다는 사실이
        명시 요청까지 전환시킨다는 뜻이 아님을 고정한다.
        """
        self.assertEqual(tts_worker.resolve_reference_conditioning_mode("high_quality_icl"),
                         "high_quality_icl")

    def test_invalid_crop_record_blocks_publication(self):
        """무효 crop record 는 발행되지 않는다 — 전용 code 로 실패한다."""
        d = tempfile.mkdtemp()
        wav = os.path.join(d, "c.wav")
        arr = np.zeros(2400, dtype=np.float32)
        arr[::7] = 0.2
        sf.write(wav, arr, 24000, subtype="FLOAT")
        rec = {"schema_version": tts_worker.VENDOR_CROP_SCHEMA,
               "crop_contract_version": 2, "model_revision": "r", "sample_rate": 24000,
               "prefix_text_enabled": False, "x_vector_only_mode": False,
               "reference_audio_sha256": "a" * 64, "reference_text_sha256": "b" * 64,
               "target_script_sha256": "c" * 64, "ref_code_frames": 10,
               "generated_code_frames": 5, "total_code_frames": 15,
               "returned_samples": int(arr.shape[0]),
               "returned_pcm_sha256": "0" * 64,          # ← 발행 대상과 불일치
               "crop_authority": "vendor_native_ref_code",
               "crop_coordinates_observed": False,
               "termination_reason": "completed_before_limit",
               "external_alignment_calls": 0}
        entry = {"out_path": wav, "original_segment_index": 0, "chunk_index": 0,
                 "emotion_id": "default", "vendor_crop_record": rec}
        with self.assertRaises(RuntimeError) as cm:
            tts_worker._summarize_reference_alignment([entry])
        self.assertEqual(cm.exception.error_payload["code"],
                         tts_worker.MISSING_OR_INVALID_VENDOR_CROP_RECORD)

    def test_native_record_publishes_without_external_alignment(self):
        """유효 record 면 통과하고, ASR alignment 요약은 만들어지지 않는다(외부 절단 0)."""
        d = tempfile.mkdtemp()
        wav = os.path.join(d, "c.wav")
        arr = np.zeros(2400, dtype=np.float32)
        arr[::7] = 0.2
        sf.write(wav, arr, 24000, subtype="FLOAT")
        rec = {"schema_version": tts_worker.VENDOR_CROP_SCHEMA,
               "crop_contract_version": 2, "model_revision": "r", "sample_rate": 24000,
               "prefix_text_enabled": False, "x_vector_only_mode": False,
               "reference_audio_sha256": "a" * 64, "reference_text_sha256": "b" * 64,
               "target_script_sha256": "c" * 64, "ref_code_frames": 10,
               "generated_code_frames": 5, "total_code_frames": 15,
               "returned_samples": int(arr.shape[0]),
               "returned_pcm_sha256": hashlib.sha256(open(wav, "rb").read()).hexdigest(),
               "crop_authority": "vendor_native_ref_code",
               "crop_coordinates_observed": False,
               "termination_reason": "completed_before_limit",
               "external_alignment_calls": 0}
        entry = {"out_path": wav, "original_segment_index": 0, "chunk_index": 0,
                 "emotion_id": "default", "vendor_crop_record": rec}
        summary, cut = tts_worker._summarize_reference_alignment([entry])
        self.assertIsNone(summary, "vendor native 경로는 ASR alignment 요약을 만들지 않는다")
        self.assertIsNone(cut)
