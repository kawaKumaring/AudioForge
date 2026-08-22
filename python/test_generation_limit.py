# -*- coding: utf-8 -*-
"""생성 안전장치(계약 A) 경계 단위 테스트 — 실제 Qwen/GPU 없이 순수 로직 + mock.

검증(WIP §44):
  - compute_max_new_tokens: MIN/공식/ABS clamp, 단조성, 정상 calib 상한 초과(설계 여유), 입력 검증.
  - classify_termination: iters<limit→completed / iters==limit→generation_limit / 입력 검증.
  - bridge 안전 결정: _preflight_tokenizer(도구 부재→호환성 오류), _prod_tokens(실패→폴백 없음),
    talker step 카운터(RNG/logits 불변·멱등), iters<=0→통과 금지, generation_limit→구조화 오류.
  - run_job: GENERATION_LIMIT_EXCEEDED 오류코드 → QwenGenerationLimitError(정수 필드), 일반 오류와 구분.
  - _synthesize_qwen_job: 상한 도달 시 기존 synthesized.wav 원자 보존 + job_dir 정리 + 감정 ID만(전사·문장·경로 미포함).
  - metadata 3필드 집계: 최대 반복 세그먼트의 (상한, 반복, completed_before_limit) + 전사 전문 미포함.
"""
import os
import sys
import json
import subprocess
import tempfile
import shutil
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generation_limit as gl
import qwen_bridge
import tts_worker


def _write_wav(path, seconds=0.3, sr=24000, amp=0.3):
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    sf.write(path, (amp * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr)


# ─────────────────────────── compute_max_new_tokens ───────────────────────────

class ComputeMaxNewTokensTest(unittest.TestCase):
    def test_floor_min_limit(self):
        # 아주 짧은 문장 → 공식값이 MIN 아래여도 MIN_LIMIT로 바닥(단, tok>0).
        self.assertEqual(gl.compute_max_new_tokens(1), gl.MIN_LIMIT)
        # 2.9*tok+160 == 200 근처 경계(tok≈13.8)에서 MIN 유지.
        self.assertEqual(gl.compute_max_new_tokens(13), gl.MIN_LIMIT)

    def test_formula_midrange(self):
        import math
        for tok in (20, 50, 120, 200, 300):
            expected = min(max(math.ceil(gl.SLOPE * tok + gl.BASE), gl.MIN_LIMIT), gl.ABS_LIMIT)
            self.assertEqual(gl.compute_max_new_tokens(tok), expected)

    def test_cap_abs_limit(self):
        # 큰 tok → ABS_LIMIT(256) 상한. 2.9*tok+160 이 256을 넘는 지점(tok>=34)부터 clamp.
        self.assertEqual(gl.compute_max_new_tokens(10000), gl.ABS_LIMIT)
        self.assertEqual(gl.compute_max_new_tokens(34), gl.ABS_LIMIT)   # 2.9*34+160=258.6→259>256→256
        self.assertEqual(gl.compute_max_new_tokens(33), gl.ABS_LIMIT)   # 2.9*33+160=255.7→256 (경계, 미clamp)
        self.assertEqual(gl.ABS_LIMIT, 256)

    def test_monotonic_nondecreasing(self):
        prev = -1
        for tok in range(1, 600, 7):
            cur = gl.compute_max_new_tokens(tok)
            self.assertGreaterEqual(cur, prev)
            prev = cur

    def test_normal_envelope_below_cap_accepted_range(self):
        # 채택되는 chunk 범위(tok ≤ max_segment_tokens=33)에서 동적 상한이 정상 envelope(2.786*tok−5.1) 위(헤드룸).
        import math
        for tok in range(1, gl.max_segment_tokens() + 1):
            envelope = math.ceil(2.786 * tok - 5.1)
            cap = gl.compute_max_new_tokens(tok)
            self.assertGreater(cap, envelope,
                               f"tok={tok}: 상한 {cap} 이 정상 envelope {envelope} 이하 — 헤드룸 없음")
        # 채택 최대(33 tok)에서 정상 iter≈2.786*33≈92 이고 상한 256 → 넉넉한 헤드룸.
        self.assertGreater(gl.ABS_LIMIT, math.ceil(2.786 * gl.max_segment_tokens()))

    def test_input_validation(self):
        for bad in (0, -1, -1000):        # 0 이하 거부
            with self.assertRaises(ValueError):
                gl.compute_max_new_tokens(bad)
        for bad in (1.5, "10", None, True, False,
                    float("nan"), float("inf"), float("-inf")):  # bool/비정수/NaN/inf 거부
            with self.assertRaises(ValueError):
                gl.compute_max_new_tokens(bad)


# ─────────────────────────── classify_termination ───────────────────────────

class ClassifyTerminationTest(unittest.TestCase):
    def test_below_limit_completed(self):
        self.assertEqual(gl.classify_termination(0, 200), "completed_before_limit")
        self.assertEqual(gl.classify_termination(199, 200), "completed_before_limit")
        self.assertEqual(gl.classify_termination(183, 1024), "completed_before_limit")

    def test_at_limit_is_generation_limit(self):
        # 경계: iters == limit → 상한 도달(잘림 대상).
        self.assertEqual(gl.classify_termination(200, 200), "generation_limit")
        self.assertEqual(gl.classify_termination(256, 256), "generation_limit")

    def test_255_256_257_at_abs(self):
        # ABS=256 기준 255·256·257 성격
        self.assertEqual(gl.classify_termination(255, 256), "completed_before_limit")
        self.assertEqual(gl.classify_termination(256, 256), "generation_limit")
        self.assertEqual(gl.classify_termination(257, 256), "generation_limit")

    def test_above_limit_is_generation_limit(self):
        self.assertEqual(gl.classify_termination(1025, 1024), "generation_limit")

    def test_input_validation(self):
        with self.assertRaises(ValueError):
            gl.classify_termination(-1, 200)
        with self.assertRaises(ValueError):
            gl.classify_termination(1.5, 200)
        with self.assertRaises(ValueError):
            gl.classify_termination(None, 200)
        with self.assertRaises(ValueError):
            gl.classify_termination(10, 0)      # limit>0
        with self.assertRaises(ValueError):
            gl.classify_termination(10, -5)


# ─────────────────────────── Policy B 경계(자동분할/차단 임계) ───────────────────────────

class PolicyBBoundaryTest(unittest.TestCase):
    def test_max_segment_tokens(self):
        # ⌊(256-160)/2.9⌋ = ⌊33.10⌋ = 33
        self.assertEqual(gl.max_segment_tokens(), 33)

    def test_unclamped_limit_boundary(self):
        self.assertEqual(gl.unclamped_limit(33), 256)   # ceil(2.9*33+160)=ceil(255.7)=256 == ABS
        self.assertEqual(gl.unclamped_limit(34), 259)   # ceil(258.6)=259 > ABS

    def test_segment_exceeds_limit(self):
        # unclamped == ABS → 허용(초과 아님) / > ABS → 초과(분할·차단 대상)
        self.assertFalse(gl.segment_exceeds_limit(33))          # ==256 허용
        self.assertTrue(gl.segment_exceeds_limit(34))           # 259>256 차단
        self.assertFalse(gl.segment_exceeds_limit(1))
        self.assertFalse(gl.segment_exceeds_limit(gl.max_segment_tokens()))
        self.assertTrue(gl.segment_exceeds_limit(gl.max_segment_tokens() + 1))

    def test_accepted_chunk_never_clamped_below_unclamped(self):
        # 채택 chunk(tok<=33)는 compute == unclamped (clamp가 잘라내지 않음).
        for tok in range(1, gl.max_segment_tokens() + 1):
            self.assertEqual(gl.compute_max_new_tokens(tok),
                             max(gl.unclamped_limit(tok), gl.MIN_LIMIT))


# ─────────────────────────── bridge 안전 결정 ───────────────────────────

class _FakeIds:
    def __init__(self, n):
        self.shape = (1, n)


class _FakeProc:
    def __init__(self, n=None, raises=False):
        self.n = n
        self.raises = raises

    def __call__(self, text=None, return_tensors=None):
        if self.raises:
            raise RuntimeError("processor boom")
        return {"input_ids": _FakeIds(self.n)}


class BridgePreflightTest(unittest.TestCase):
    def test_missing_build_assistant_text_is_compat_error(self):
        model = mock.Mock(spec=["processor"])   # _build_assistant_text 없음
        model.processor = _FakeProc(7)
        with self.assertRaises(RuntimeError) as cm:
            qwen_bridge._preflight_tokenizer(model)
        self.assertIn("TTS_COMPAT", str(cm.exception))

    def test_missing_processor_is_compat_error(self):
        model = mock.Mock(spec=["_build_assistant_text"])
        model._build_assistant_text = lambda t: t
        with self.assertRaises(RuntimeError) as cm:
            qwen_bridge._preflight_tokenizer(model)
        self.assertIn("TTS_COMPAT", str(cm.exception))

    def test_prod_tokens_ok(self):
        builder = lambda t: "<|im_start|>assistant\n" + t
        self.assertEqual(qwen_bridge._prod_tokens(builder, _FakeProc(11), "안녕"), 11)

    def test_prod_tokens_failure_no_fallback(self):
        builder = lambda t: t
        with self.assertRaises(RuntimeError) as cm:
            qwen_bridge._prod_tokens(builder, _FakeProc(raises=True), "x")
        self.assertIn("TTS_COMPAT", str(cm.exception))

    def test_prod_tokens_zero_is_error(self):
        builder = lambda t: t
        with self.assertRaises(RuntimeError):
            qwen_bridge._prod_tokens(builder, _FakeProc(0), "x")


class _FakeTalker:
    def __init__(self):
        self.calls = []

    def generate(self, *a, **k):
        self.calls.append(k)
        return "codes"


class _FakeInner:
    def __init__(self):
        self.talker = _FakeTalker()


class _FakeModel:
    def __init__(self):
        self.model = _FakeInner()


class TalkerCounterTest(unittest.TestCase):
    def setUp(self):
        try:
            import transformers  # noqa: F401
        except Exception:
            self.skipTest("transformers 미설치 — 카운터 계측 테스트는 venv에서만")
        qwen_bridge._COUNTER["n"] = 0

    def test_counter_appended_and_rng_invariant(self):
        m = _FakeModel()
        qwen_bridge._install_talker_counter(m)
        m.model.talker.generate(stopping_criteria=None)
        sc = m.model.talker.calls[-1]["stopping_criteria"]
        self.assertGreaterEqual(len(sc), 1, "counting StoppingCriteria가 주입돼야 함")
        crit = sc[-1]
        # RNG/logits 불변: scores 를 무시하고 항상 False, 호출마다 +1.
        qwen_bridge._COUNTER["n"] = 0
        self.assertFalse(crit(object(), None))
        self.assertFalse(crit(object(), object()))       # scores 값이 달라도 동일 동작
        self.assertEqual(qwen_bridge._COUNTER["n"], 2)

    def test_install_is_idempotent(self):
        m = _FakeModel()
        qwen_bridge._install_talker_counter(m)
        qwen_bridge._install_talker_counter(m)   # 두 번째는 무동작(멱등)
        m.model.talker.generate(stopping_criteria=None)
        sc = m.model.talker.calls[-1]["stopping_criteria"]
        n_counters = sum(1 for c in sc if type(c).__name__ == "_StepCounter")
        self.assertEqual(n_counters, 1, "멱등 — 카운터는 하나만")


class _FakeGenModel:
    """generate_voice_clone 호출 kwargs를 기록하고, talker 반복을 sim_iters로 흉내낸다(_COUNTER 세팅)."""
    def __init__(self, sim_iters):
        self.sim_iters = sim_iters
        self.received = None

    def generate_voice_clone(self, text=None, language=None, ref_audio=None, ref_text=None,
                             x_vector_only_mode=False, max_new_tokens=None):
        self.received = {"max_new_tokens": max_new_tokens, "x_vector_only_mode": x_vector_only_mode,
                         "ref_text": ref_text, "language": language}
        qwen_bridge._COUNTER["n"] = self.sim_iters   # talker step 수 흉내
        return ["wav-placeholder"], 24000


def _seg(text="문장", xvo=False, ref_text="ref", lang="Korean"):
    return {"index": 0, "text": text, "ref_audio": "r.wav", "ref_text": ref_text,
            "x_vector_only": xvo, "language_name": lang, "emotion_id": "default",
            "out_path": "o.wav"}


class GenerateSegmentContractTest(unittest.TestCase):
    def setUp(self):
        self.builder = lambda t: "<|im_start|>assistant\n" + t
        qwen_bridge._COUNTER["n"] = 0

    def test_max_new_tokens_forwarded_from_prod_tokens(self):
        # prod_tokens=30(채택 범위) → seg_limit=compute(30) 가 generate_voice_clone(max_new_tokens=)로 전달.
        m = _FakeGenModel(sim_iters=100)
        out = qwen_bridge._generate_segment(m, _seg(), self.builder, _FakeProc(30))
        self.assertEqual(m.received["max_new_tokens"], gl.compute_max_new_tokens(30))
        self.assertEqual(out["generation_limit"], gl.compute_max_new_tokens(30))
        self.assertEqual(out["generated_iterations"], 100)
        self.assertEqual(out["termination_reason"], "completed_before_limit")

    def test_xvector_mode_forwards_empty_ref_text(self):
        m = _FakeGenModel(sim_iters=50)
        qwen_bridge._generate_segment(m, _seg(xvo=True, ref_text="무시돼야함"), self.builder, _FakeProc(30))
        self.assertTrue(m.received["x_vector_only_mode"])
        self.assertEqual(m.received["ref_text"], "")   # x-vector-only → ref_text 무시

    def test_offbyone_boundary(self):
        limit = gl.compute_max_new_tokens(30)
        for delta, expect in ((-1, "completed_before_limit"), (0, "generation_limit"),
                              (1, "generation_limit")):
            m = _FakeGenModel(sim_iters=limit + delta)
            self.assertEqual(
                qwen_bridge._generate_segment(m, _seg(), self.builder, _FakeProc(30))["termination_reason"],
                expect, f"iters=limit{delta:+d}")

    def test_counter_zero_is_compat_error(self):
        # 계측값 0 → 안전장치 확인 불가 → 성공 처리 금지(호환성 오류).
        m = _FakeGenModel(sim_iters=0)
        with self.assertRaises(RuntimeError) as cm:
            qwen_bridge._generate_segment(m, _seg(), self.builder, _FakeProc(30))
        self.assertIn("TTS_COMPAT", str(cm.exception))


# ─────────────────────────── run_job 오류코드 ───────────────────────────

class _FakePopen:
    def __init__(self, out_lines, err_lines=(), returncode=0):
        self.stdout = iter(list(out_lines))
        self.stderr = iter(list(err_lines))
        self.returncode = returncode

        class _Stdin:
            def write(self, *_a):
                pass

            def close(self):
                pass
        self.stdin = _Stdin()

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        pass


class RunJobLimitErrorTest(unittest.TestCase):
    def setUp(self):
        self._p = mock.patch.object(tts_worker, "emit", new=lambda *a, **k: None)
        self._p.start(); self.addCleanup(self._p.stop)
        self.tmp = tempfile.mkdtemp(prefix="af_gl_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.eng = tts_worker.QwenTTSEngine()
        self.seg = [{"index": 0, "text": "x", "ref_audio": "r", "ref_text": "",
                     "x_vector_only": True, "language_name": "Korean",
                     "out_path": os.path.join(self.tmp, "o0.wav")}]

    def test_generation_limit_error_code_raises_typed(self):
        line = json.dumps({"type": "error", "code": "GENERATION_LIMIT_EXCEEDED",
                           "segment_index": 0, "emotion_id": "happy",
                           "generated_iterations": 1024, "generation_limit": 1024}) + "\n"
        with mock.patch.object(subprocess, "Popen", return_value=_FakePopen([line], returncode=1)):
            with self.assertRaises(tts_worker.QwenGenerationLimitError) as cm:
                self.eng.run_job(self.seg, "cpu")
        self.assertEqual(cm.exception.segment_index, 0)
        self.assertEqual(cm.exception.generation_limit, 1024)
        self.assertEqual(cm.exception.generated_iterations, 1024)
        self.assertEqual(cm.exception.emotion_id, "happy")

    def test_generic_error_is_plain_runtime(self):
        line = json.dumps({"type": "error", "message": "boom"}) + "\n"
        with mock.patch.object(subprocess, "Popen", return_value=_FakePopen([line], returncode=1)):
            with self.assertRaises(RuntimeError) as cm:
                self.eng.run_job(self.seg, "cpu")
        self.assertNotIsInstance(cm.exception, tts_worker.QwenGenerationLimitError)


# ─────────────────────────── _synthesize_qwen_job 보존/집계 ───────────────────────────

class _FakeAssess:
    valid = True
    errors = ()


class SynthJobSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_gljob_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.ref = os.path.join(self.tmp, "ref.wav"); _write_wav(self.ref, 5.0)
        self.out = os.path.join(self.tmp, "out"); os.makedirs(self.out)
        self._patches = [
            mock.patch.object(tts_worker, "emit", new=lambda *a, **k: None),
            mock.patch("gpu_policy.select_device", new=lambda *a, **k: ("cpu", "test cpu")),
            mock.patch("reference_audio.assess_reference_file", new=lambda *a, **k: _FakeAssess()),
            mock.patch.object(tts_worker, "_resolve_qwen_ref_text", new=lambda *a, **k: ("", True)),
        ]
        for p in self._patches:
            p.start(); self.addCleanup(p.stop)

    def _job_dirs(self):
        return [d for d in os.listdir(self.out) if d.startswith(".qwen-job-")]

    def test_generation_limit_preserves_existing_and_cleans_up(self):
        final = os.path.join(self.out, "synthesized.wav")
        sentinel = b"OLD-GOOD-OUTPUT"
        with open(final, "wb") as f:
            f.write(sentinel)

        def boom(inner_self, segments, device):
            raise tts_worker.QwenGenerationLimitError(0, 1024, 1024)

        with mock.patch.object(tts_worker.QwenTTSEngine, "run_job", new=boom):
            with self.assertRaises(RuntimeError) as cm:
                tts_worker._synthesize_qwen_job(
                    [("default", "안녕하세요 비밀문장입니다")], {"default": self.ref},
                    {}, self.out, 1.0, 0.5, 0.0)
        msg = str(cm.exception)
        self.assertIn("GENERATION_LIMIT_EXCEEDED", msg)
        self.assertIn("default", msg)                 # 감정 ID는 노출
        self.assertNotIn("비밀문장", msg)               # 문장 본문은 미포함
        self.assertNotIn(os.path.abspath(self.ref), msg)  # 전체 경로 미포함
        # 원자 보존: 기존 synthesized.wav 무손상
        with open(final, "rb") as f:
            self.assertEqual(f.read(), sentinel)
        # job_dir 정리
        self.assertEqual(self._job_dirs(), [], "job_dir 이 정리돼야 함")

    def _run_with_segmeta(self, per_seg):
        """per_seg: {index: (iters, limit)}. fake run_job으로 chunk 형식 seg_out(1 chunk/seg) 반환 → info 산출."""
        def fake_run_job(inner_self, segments, device):
            outs = []
            for s in segments:
                _write_wav(s["out_path"], 0.3)
                it, lim = per_seg[s["index"]]
                outs.append({"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                             "out_path": s["out_path"], "sr": 24000,
                             "x_vector_only": s["x_vector_only"], "emotion_id": s.get("emotion_id"),
                             "production_tokens": 20, "generation_limit": lim, "generated_iterations": it,
                             "termination_reason": "completed_before_limit", "status": "ok"})
            return outs
        parsed = [("default", f"문장 {i} 입니다") for i in range(len(per_seg))]
        with mock.patch.object(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job):
            final_path, info = tts_worker._synthesize_qwen_job(
                parsed, {"default": self.ref}, {}, self.out, 1.0, 0.5, 0.0)
        return final_path, info

    def test_metadata_representative_by_ratio(self):
        # 대표 = iters/limit 비율 최대(최대 iters 와 다르게 설계):
        #   seg0 180/1024=0.176 (최대 iters지만 비율 낮음)  seg1 150/200=0.75(대표)  seg2 175/1000=0.175
        final_path, info = self._run_with_segmeta({0: (180, 1024), 1: (150, 200), 2: (175, 1000)})
        self.assertEqual(info["generated_iterations"], 150)   # 대표 세그먼트(seg1)의 iters
        self.assertEqual(info["generation_limit"], 200)       # 동일 세그먼트의 limit(한 쌍)
        self.assertEqual(info["termination_reason"], "completed_before_limit")
        self.assertTrue(os.path.exists(final_path))
        meta = tts_worker._build_tts_metadata(**info)
        for k in ("generation_limit", "generated_iterations", "termination_reason"):
            self.assertIn(k, meta)

    def test_metadata_ratio_tie_prefers_earliest(self):
        # 동률 비율(0.5) → 가장 앞 세그먼트(index 0) 선택: seg0 100/200, seg1 200/400.
        _fp, info = self._run_with_segmeta({0: (100, 200), 1: (200, 400)})
        self.assertEqual(info["generation_limit"], 200)
        self.assertEqual(info["generated_iterations"], 100)

    # ── 계약 B: 다중 chunk 통합 ──
    def _fake_multichunk(self, plan):
        """plan: {original_segment_index: chunk_count}. job_dir 내부에 chunk WAV 쓰고 chunk 형식 반환."""
        def fake_run_job(inner_self, segments, device):
            outs = []
            jobdir = os.path.dirname(segments[0]["out_path"])
            for s in segments:
                osi = s["index"]
                cc = plan[osi]
                for ci in range(cc):
                    p = os.path.join(jobdir, f"segment_qwen_{osi + 1:03d}_c{ci:03d}.wav")
                    _write_wav(p, 0.2)
                    outs.append({"original_segment_index": osi, "chunk_index": ci, "chunk_count": cc,
                                 "out_path": p, "sr": 24000, "x_vector_only": s["x_vector_only"],
                                 "emotion_id": s.get("emotion_id"), "production_tokens": 20 + ci,
                                 "generation_limit": 256, "generated_iterations": 90 + ci,
                                 "termination_reason": "completed_before_limit", "status": "ok"})
            return outs
        return fake_run_job

    def test_multichunk_internal_gap_zero_external_silence(self):
        # 원본 seg0 → 3 chunk, seg1 → 1 chunk. 내부 gap 0, seg0→seg1 경계만 silence_gap(0.5).
        gaps_seen = []
        real = tts_worker._concat_with_boundaries

        def spy(paths, gaps_before, out_path):
            gaps_seen.append(list(gaps_before))
            return real(paths, gaps_before, out_path)
        with mock.patch.object(tts_worker.QwenTTSEngine, "run_job", new=self._fake_multichunk({0: 3, 1: 1})), \
                mock.patch.object(tts_worker, "_concat_with_boundaries", new=spy):
            parsed = [("default", "첫째 줄입니다"), ("default", "둘째 줄입니다")]
            final_path, info = tts_worker._synthesize_qwen_job(
                parsed, {"default": self.ref}, {}, self.out, 1.0, 0.5, 0.0)
        self.assertEqual(gaps_seen, [[0.0, 0.0, 0.0, 0.5]])   # 내부 0×3, 경계 0.5
        self.assertTrue(os.path.exists(final_path))
        gc = info["generation_chunks"]
        self.assertEqual(len(gc), 4)
        self.assertEqual([c["chunk_count"] for c in gc], [3, 3, 3, 1])
        self.assertEqual([(c["original_segment_index"], c["chunk_index"]) for c in gc],
                         [(0, 0), (0, 1), (0, 2), (1, 0)])
        self.assertEqual(self._job_dirs(), [])

    def test_generation_limit_chunk_preserves_and_reports_chunk(self):
        final = os.path.join(self.out, "synthesized.wav")
        sentinel = b"OLD-GOOD-" + b"x" * 8
        with open(final, "wb") as f:
            f.write(sentinel)

        def boom(inner_self, segments, device):
            raise tts_worker.QwenGenerationLimitError(0, 256, 256, "default", 1)  # chunk_index=1

        with mock.patch.object(tts_worker.QwenTTSEngine, "run_job", new=boom):
            with self.assertRaises(RuntimeError) as cm:
                tts_worker._synthesize_qwen_job(
                    [("default", "비밀 문장입니다")], {"default": self.ref}, {}, self.out, 1.0, 0.5, 0.0)
        msg = str(cm.exception)
        self.assertIn("GENERATION_LIMIT_EXCEEDED", msg)
        self.assertIn("조각 1", msg)         # chunk index 노출
        self.assertIn("default", msg)
        self.assertNotIn("비밀", msg)         # 문장 본문 미포함
        with open(final, "rb") as f:
            self.assertEqual(f.read(), sentinel)   # 원자 보존
        self.assertEqual(self._job_dirs(), [])

    def test_text_segment_too_long_surface_and_preserve(self):
        final = os.path.join(self.out, "synthesized.wav")
        sentinel = b"KEEP-ME-" + b"y" * 8
        with open(final, "wb") as f:
            f.write(sentinel)

        def toolong(inner_self, segments, device):
            raise tts_worker.QwenTextSegmentTooLongError(0, 500, 33, "happy")

        with mock.patch.object(tts_worker.QwenTTSEngine, "run_job", new=toolong):
            with self.assertRaises(RuntimeError) as cm:
                tts_worker._synthesize_qwen_job(
                    [("happy", "아주 긴 비밀 문장 원문")], {"default": self.ref, "happy": self.ref},
                    {}, self.out, 1.0, 0.5, 0.0)
        msg = str(cm.exception)
        self.assertIn("TEXT_SEGMENT_TOO_LONG", msg)
        self.assertIn("안전한 단일 합성 길이", msg)   # 정확 문구
        self.assertIn("happy", msg)
        self.assertIn("500", msg)
        self.assertIn("33", msg)
        self.assertNotIn("비밀", msg)                 # 대사 본문 미포함
        with open(final, "rb") as f:
            self.assertEqual(f.read(), sentinel)
        self.assertEqual(self._job_dirs(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
