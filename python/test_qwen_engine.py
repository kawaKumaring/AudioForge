# -*- coding: utf-8 -*-
"""Qwen3 엔진 연동(Part 3) 모델 미로딩 단위 테스트 — 실제 Qwen/GPU 없이 unittest+mock.
라우팅 우선순위·(ref_text,x_vector_only) 정책·배치 경로(모델 1회)·run_job 실시간 파싱/오류·
batch-only 가드·세그먼트별 언어·속도 후 간격 보존을 검증. 실제 합성은 별도 스모크로 분리 보고.

테스트 격리(중요): mock.patch.stopall을 쓰지 않는다. 패처마다 addCleanup(patcher.stop)으로
정확히 자기 것만 해제하고, 전역 Qwen 캐시(_qwen_engine, _qwen_ref_text_cache)는 스냅샷 후 복원한다."""
import os
import sys
import subprocess
import tempfile
import shutil
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_worker
import runtime_paths
import reference_audio as ra


def _configure_test_roots():
    """available()/경로 해석이 주입된 root를 요구하므로 테스트용 managed root를 심는다."""
    runtime_paths.reset()
    runtime_paths.set_path_resolver(None)
    runtime_paths.configure({
        "schemaVersion": 2,
        "runtimeRoot": {"path": "C:/af_test/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": "C:/af_test/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": "C:/af_test/ch", "ownership": "audioforge-managed"},
    })
import reference_transcript as rt  # noqa: F401 (STATUS_OK 등 상수 사용 경로 확인용)
import transcribe_worker


def _write(path, seconds, sr=24000, amp=0.3):
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    sf.write(path, (amp * np.sin(2 * np.pi * 220 * t)).astype("float32"), sr)


class _QwenGlobalIsolation:
    """전역 Qwen 캐시 스냅샷/복원 믹스인 — 같은 프로세스의 다른 테스트에 상태가 새지 않게."""
    def _isolate_globals(self):
        snap_engine = tts_worker._qwen_engine
        snap_cache = dict(tts_worker._qwen_ref_text_cache)
        tts_worker._qwen_engine = None
        tts_worker._qwen_ref_text_cache.clear()

        def _restore():
            tts_worker._qwen_engine = snap_engine
            tts_worker._qwen_ref_text_cache.clear()
            tts_worker._qwen_ref_text_cache.update(snap_cache)
        self.addCleanup(_restore)

    def _patch(self, target, attr=None, **kw):
        """patcher.start() + addCleanup(patcher.stop). stopall 미사용."""
        p = mock.patch.object(target, attr, **kw) if attr else mock.patch(target, **kw)
        val = p.start()
        self.addCleanup(p.stop)
        return val

    def _silence_emit(self, log=None):
        self._patch(tts_worker, "emit", new=(lambda *a, **k: (log.append((a, k)) if log is not None else None)))


class _FakePopen:
    """run_job이 Popen.stdout를 스레드로 실시간 읽으므로, stdout/stderr를 라인 이터러블로 흉내낸다."""
    def __init__(self, out_lines, err_lines=(), returncode=0):
        self.stdout = iter(list(out_lines))
        self.stderr = iter(list(err_lines))
        self.returncode = returncode
        self.killed = False

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
        self.killed = True


class SelectJobEngineTest(_QwenGlobalIsolation, unittest.TestCase):
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()

    def _avail(self, val):
        self._patch(tts_worker.QwenTTSEngine, "available", new=(lambda self: val))
        tts_worker._qwen_engine = None  # available 재평가

    def test_preferred_qwen_available(self):
        self._avail(True)
        self.assertEqual(tts_worker._select_job_engine("아무 문장", "qwen3"), "qwen3")

    def test_preferred_qwen_unavailable_falls_back(self):
        self._avail(False)
        self.assertIsNone(tts_worker._select_job_engine("아무 문장", "qwen3"))

    def test_preferred_other_engine_uses_per_segment(self):
        self._avail(True)
        self.assertIsNone(tts_worker._select_job_engine("안녕하세요", "gptsovits"))

    def test_auto_korean_prefers_qwen(self):
        self._avail(True)
        self.assertEqual(tts_worker._select_job_engine("안녕하세요 반갑습니다", None), "qwen3")

    def test_auto_english_not_qwen(self):
        self._avail(True)
        self.assertIsNone(tts_worker._select_job_engine("hello world this is english", None))

    def test_auto_korean_unavailable_not_qwen(self):
        self._avail(False)
        self.assertIsNone(tts_worker._select_job_engine("안녕하세요", None))


class ResolveQwenRefTextTest(_QwenGlobalIsolation, unittest.TestCase):
    """(ref_text, x_vector_only) 3조건 회귀:
    - 명시적 ref-free → ("", True)
    - 수동/자동 전사(비어있지 않음) → (text, False)  # ICL
    - 자동 전사 실패/빈 결과 → ("", True)  # x-vector-only 강등"""
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_qwen_")
        self.ref = os.path.join(self.tmp, "ref.wav")
        with open(self.ref, "wb") as _f:
            _f.write(b"dummy")
        self.ap = os.path.abspath(self.ref)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _mock_whisper(self, result, counter):
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))

        def ft(m, p, l):
            counter.append(1)
            return result
        self._patch(transcribe_worker, "run_transcribe", side_effect=ft)

    def test_manual_icl_no_whisper(self):
        c = []
        self._mock_whisper({"text": "자동전사", "language": "ko"}, c)
        ov = {self.ap: {"manual_text": "수동문", "mode": "manual"}}
        txt, xvo = tts_worker._resolve_qwen_ref_text(self.ref, ov, set())
        self.assertEqual((txt, xvo), ("수동문", False))
        self.assertEqual(c, [], "수동이면 Whisper 미호출")

    def test_ref_free_x_vector_only(self):
        c = []
        self._mock_whisper({"text": "자동전사", "language": "ko"}, c)
        ov = {self.ap: {"mode": "ref_free"}}
        txt, xvo = tts_worker._resolve_qwen_ref_text(self.ref, ov, set())
        self.assertEqual((txt, xvo), ("", True))
        self.assertEqual(c, [], "ref-free면 Whisper 미호출")

    def test_auto_ok_is_icl_and_caches(self):
        c = []
        self._mock_whisper({"text": "자동전사", "language": "ko"}, c)
        r1 = tts_worker._resolve_qwen_ref_text(self.ref, {}, set())
        r2 = tts_worker._resolve_qwen_ref_text(self.ref, {}, set())
        self.assertEqual(r1, ("자동전사", False))
        self.assertEqual(r2, ("자동전사", False))
        self.assertEqual(len(c), 1, "동일 파일 전사 1회(캐시)")

    def test_auto_empty_transcript_degrades_to_x_vector(self):
        c = []
        self._mock_whisper({"text": "   ", "language": "ko"}, c)  # 빈/공백 → 강등
        txt, xvo = tts_worker._resolve_qwen_ref_text(self.ref, {}, set())
        self.assertEqual((txt, xvo), ("", True))


class RunJobRealtimeTest(_QwenGlobalIsolation, unittest.TestCase):
    """run_job이 Popen stdout를 실시간으로 읽어 result '이전에' progress를 emit하는지 + 오류/예외 처리."""
    def setUp(self):
        self._isolate_globals()
        self.log = []
        self._silence_emit(self.log)
        # run_job이 venv/모델 경로를 주입된 root에서 해석하므로 synthetic root 구성(Popen은 mock).
        _configure_test_roots()
        self.addCleanup(runtime_paths.reset)
        self.eng = tts_worker.QwenTTSEngine()
        self.seg = [{"index": 0, "text": "t", "ref_audio": "r", "ref_text": "x",
                     "x_vector_only": False, "language_name": "Korean", "out_path": "a.wav"}]

    def test_progress_emitted_before_result(self):
        out = ['{"type":"progress","percent":30,"message":"합성 중... (1/1)"}\n',
               '{"type":"result","segments":[{"index":0,"out_path":"a.wav","sr":24000,'
               '"x_vector_only":false}],"success":true}\n']
        fp = _FakePopen(out)
        self._patch(subprocess, "Popen", return_value=fp)
        # _validate_seg_out은 실제 파일 검사 → 우회(파싱/순서만 검증)
        self._patch(tts_worker.QwenTTSEngine, "_validate_seg_out",
                    new=staticmethod(lambda seg_out, segments: seg_out))
        res = self.eng.run_job(self.seg, "cpu")
        self.assertEqual(res[0]["index"], 0)
        kinds = [a[0] for a, k in self.log]
        self.assertIn("progress", kinds, "세그먼트 진행률이 실시간 emit돼야 함")
        # progress가 반환(result 처리) 전에 로그에 남아야 한다
        self.assertTrue(any(a[0] == "progress" for a, k in self.log))

    def test_error_line_raises(self):
        fp = _FakePopen(['{"type":"error","message":"boom"}\n'])
        self._patch(subprocess, "Popen", return_value=fp)
        with self.assertRaises(RuntimeError):
            self.eng.run_job(self.seg, "cpu")

    def test_returncode_failure_raises(self):
        fp = _FakePopen(["not-json\n"], err_lines=["traceback\n"], returncode=1)
        self._patch(subprocess, "Popen", return_value=fp)
        with self.assertRaises(RuntimeError):
            self.eng.run_job(self.seg, "cpu")

    def test_popen_exception_raises(self):
        self._patch(subprocess, "Popen", side_effect=OSError("no exe"))
        with self.assertRaises(RuntimeError):
            self.eng.run_job(self.seg, "cpu")

    def test_batch_only_guard(self):
        with self.assertRaises(RuntimeError):
            self.eng.synthesize_segment("t", "r", "default", 1.0, "o")


class ValidateSegOutTest(_QwenGlobalIsolation, unittest.TestCase):
    """chunk 계약(§2) 검증: 경로 job_dir 내부·original_segment_index 연속·chunk_index 완전·chunk_count 일치·
    status=ok·존재/0바이트/sr/finite. 단일/다중 chunk 정상 + 각 위반 차단."""
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_qwenval_")   # = job_dir
        self.other = tempfile.mkdtemp(prefix="af_qwenval_out_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.addCleanup(lambda: shutil.rmtree(self.other, ignore_errors=True))

    def _segs(self, n):
        return [{"index": i, "out_path": os.path.join(self.tmp, f"segment_qwen_{i + 1:03d}.wav")}
                for i in range(n)]

    def _expected(self, osi, ci):
        return os.path.join(self.tmp, f"segment_qwen_{osi + 1:03d}_c{ci:03d}.wav")

    def _chunk(self, osi, ci, cc, write=True, path=None, status="ok"):
        p = path or self._expected(osi, ci)
        if write:
            _write(p, 0.2)
        return {"original_segment_index": osi, "chunk_index": ci, "chunk_count": cc, "out_path": p,
                "sr": 24000, "x_vector_only": False, "emotion_id": "default", "production_tokens": 20,
                "generation_limit": 256, "generated_iterations": 100,
                "termination_reason": "completed_before_limit", "status": status}

    def _val(self, seg_out, n):
        return tts_worker.QwenTTSEngine._validate_seg_out(seg_out, self._segs(n))

    def test_ok_single_chunk(self):
        out = self._val([self._chunk(0, 0, 1)], 1)
        self.assertEqual(out[0]["original_segment_index"], 0)

    def test_ok_multi_chunk(self):
        self._val([self._chunk(0, 0, 3), self._chunk(0, 1, 3), self._chunk(0, 2, 3)], 1)

    def test_missing_chunk_raises(self):
        with self.assertRaises(RuntimeError):   # cc=2 인데 ci=1 없음
            self._val([self._chunk(0, 0, 2)], 1)

    def test_dup_chunk_raises(self):
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 2), self._chunk(0, 0, 2)], 1)

    def test_chunk_count_mismatch_raises(self):
        with self.assertRaises(RuntimeError):   # 같은 seg 인데 cc 다름
            self._val([self._chunk(0, 0, 2), self._chunk(0, 1, 3)], 1)

    def test_missing_original_segment_raises(self):
        with self.assertRaises(RuntimeError):   # segment 2개인데 osi=0만
            self._val([self._chunk(0, 0, 1)], 2)

    def test_path_escape_raises(self):
        bad = os.path.join(self.other, "x_c000.wav")   # job_dir 밖
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, path=bad)], 1)

    def test_bad_status_raises(self):
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, status="generation_limit")], 1)

    def test_zero_byte_raises(self):
        p = os.path.join(self.tmp, "segment_qwen_001_c000.wav")
        with open(p, "wb"):  # 0바이트
            pass
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, write=False, path=p)], 1)

    # ── P0-2 경로 정확 일치 ──
    def test_wrong_basename_raises(self):
        bad = os.path.join(self.tmp, "wrong_name.wav")   # job_dir 내부지만 결정적 규칙 위반
        _write(bad, 0.2)
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, write=False, path=bad)], 1)

    def test_cross_segment_path_raises(self):
        # seg0의 chunk인데 out_path가 seg1의 chunk 경로 → 기대 경로 불일치
        cross = os.path.join(self.tmp, "segment_qwen_002_c000.wav")
        _write(cross, 0.2)
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, write=False, path=cross)], 2)

    def test_realpath_escape_raises(self):
        # .. 로 job_dir 밖을 가리키면 realpath 기준 기대 경로와 불일치
        escaped = os.path.join(self.tmp, "..", os.path.basename(self.other), "segment_qwen_001_c000.wav")
        _write(escaped, 0.2)
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, write=False, path=escaped)], 1)

    # ── P0-3 sr/채널 일관성 ──
    def _write_sr(self, path, sr, stereo=False):
        import numpy as np
        import soundfile as sf
        n = int(0.2 * sr)
        t = np.arange(n) / sr
        mono = (0.3 * np.sin(2 * np.pi * 220 * t)).astype("float32")
        data = np.stack([mono, mono], axis=1) if stereo else mono
        sf.write(path, data, sr)

    def test_metadata_sr_mismatch_raises(self):
        p = self._expected(0, 0)
        self._write_sr(p, 24000)
        e = self._chunk(0, 0, 1, write=False, path=p)
        e["sr"] = 48000            # 위조된 metadata sr
        with self.assertRaises(RuntimeError):
            self._val([e], 1)

    def test_chunk_sr_mismatch_raises(self):
        p0 = self._expected(0, 0)
        p1 = self._expected(0, 1)
        self._write_sr(p0, 24000)
        self._write_sr(p1, 48000)
        e0 = self._chunk(0, 0, 2, write=False, path=p0); e0["sr"] = 24000
        e1 = self._chunk(0, 1, 2, write=False, path=p1); e1["sr"] = 48000
        with self.assertRaises(RuntimeError):
            self._val([e0, e1], 1)

    def test_stereo_chunk_raises(self):
        p = self._expected(0, 0)
        self._write_sr(p, 24000, stereo=True)
        with self.assertRaises(RuntimeError):
            self._val([self._chunk(0, 0, 1, write=False, path=p)], 1)


class QwenBatchPathTest(_QwenGlobalIsolation, unittest.TestCase):
    """synthesize()가 Qwen 배치 경로로 라우팅되고, run_job 1회로 전 문장 처리(모델 미로딩 mock).
    세그먼트별 언어·속도 후 간격 보존·임시파일 정리도 함께 검증."""
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_qwenjob_")
        self.ref = os.path.join(self.tmp, "ref5.wav")
        _write(self.ref, 5.0)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self._orig_ra = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.addCleanup(lambda: (ra._analysis_cache.clear(), ra._analysis_cache.update(self._orig_ra)))
        # gpu_policy는 CPU 고정(장치 선택 자체는 gpu_policy 테스트에서 검증)
        self._patch("gpu_policy.select_device", new=(lambda *a, **k: ("cpu", "test")))
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))
        self._patch(transcribe_worker, "run_transcribe",
                    side_effect=(lambda m, p, l: {"text": "자동전사", "language": "ko"}))
        self._patch(tts_worker.QwenTTSEngine, "available", new=(lambda self: True))

    def _fake_run_job_writer(self, sink):
        def fake_run_job(inner_self, segments, device):
            sink.append({"n": len(segments), "device": device,
                         "langs": [s["language_name"] for s in segments],
                         "xvo": [s["x_vector_only"] for s in segments],
                         "ref_texts": [s["ref_text"] for s in segments]})
            for s in segments:
                _write(s["out_path"], 0.3)
            return [{"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                     "out_path": s["out_path"], "sr": 24000, "x_vector_only": s["x_vector_only"],
                     "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                     "generation_limit": 256, "generated_iterations": 100,
                     "termination_reason": "completed_before_limit", "status": "ok"} for s in segments]
        return fake_run_job

    def test_routes_to_qwen_batch_once_and_per_segment_language(self):
        calls = []
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=self._fake_run_job_writer(calls))
        text = "안녕하세요 첫 문장입니다.\nThis is an English sentence here."
        tts_worker.synthesize(self.ref, text, self.out, speed=1.0, silence_gap=0.5,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        self.assertEqual(len(calls), 1, "run_job은 작업당 1회(모델 1회 로딩)")
        self.assertEqual(calls[0]["n"], 2)
        self.assertEqual(calls[0]["device"], "cpu")
        self.assertEqual(calls[0]["langs"], ["Korean", "English"], "세그먼트별 언어 감지 전달")
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))
        # 실행별 임시폴더·세그먼트 정리 확인
        self.assertEqual([f for f in os.listdir(self.out) if f.startswith("segment_qwen_")], [])
        self.assertEqual([f for f in os.listdir(self.out) if f.startswith(".qwen-job-")], [],
                         "실행별 임시폴더(.qwen-job-*)가 정리돼야 함")

    def test_speed_preserves_user_silence_gap(self):
        calls = []
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=self._fake_run_job_writer(calls))
        # atempo는 실제 ffmpeg 대신 입력을 복사(속도 파이프라인이 세그먼트별로 도는지 + gap 유지 검증)
        atempo_hits = []

        def fake_atempo(inp, speed):
            atempo_hits.append((inp, speed))
            out = inp.replace(".wav", f"_x{speed:.2f}.wav")
            shutil.copyfile(inp, out)
            return out
        self._patch(tts_worker, "_atempo_segment", new=fake_atempo)
        gaps_seen = []
        real_concat = tts_worker._concat_with_boundaries

        def spy_concat(paths, gaps_before, out_path):
            gaps_seen.append(list(gaps_before))
            return real_concat(paths, gaps_before, out_path)
        self._patch(tts_worker, "_concat_with_boundaries", new=spy_concat)

        text = "첫 문장입니다.\n둘째 문장입니다."   # 2개 원본 segment(각 1 chunk)
        tts_worker.synthesize(self.ref, text, self.out, speed=1.5, silence_gap=0.75,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        self.assertEqual(len(atempo_hits), 2, "속도는 최종 결합본이 아니라 세그먼트별로 적용")
        self.assertTrue(all(abs(s - 1.5) < 1e-9 for _, s in atempo_hits))
        # 첫 항목 gap 0, 원 segment 경계(0→1)에 사용자 silence_gap 0.75
        self.assertEqual(gaps_seen, [[0.0, 0.75]], "원 segment 경계에 사용자 silence_gap 유지")
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))

    def test_long_emotion_ref_blocks_with_emotion_id(self):
        # 감정 참조가 10초 초과 → 감정 ID·파일 포함 오류, run_job(모델 로딩) 미도달
        long_ref = os.path.join(self.tmp, "happy_long.wav")
        _write(long_ref, 12.0)
        called = []
        self._patch(tts_worker.QwenTTSEngine, "run_job",
                    new=(lambda self, *a, **k: called.append(1) or []))
        with self.assertRaises(RuntimeError) as cm:
            tts_worker.synthesize(self.ref, "[기쁨] 문장입니다.", self.out, emotion_refs={"happy": long_ref},
                                  preferred_engine="qwen3", reference_prompts={})
        msg = str(cm.exception)
        self.assertIn("happy", msg)   # 감정 ID 명시
        self.assertIn("10초", msg)    # 구간 선택 안내
        self.assertEqual(called, [], "긴 감정 참조는 run_job(모델) 도달 전 차단")

    def test_invalid_ref_blocks_before_run_job(self):
        short = os.path.join(self.tmp, "short2s.wav")
        _write(short, 2.0)  # TOO_SHORT
        called = []
        self._patch(tts_worker.QwenTTSEngine, "run_job",
                    new=(lambda self, *a, **k: called.append(1) or []))
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(short, "안녕하세요 문장.", self.out, emotion_refs={},
                                  preferred_engine="qwen3", reference_prompts={})
        self.assertEqual(called, [], "부적합 참조는 run_job(모델) 도달 전 차단")


class AvailablePreflightTest(_QwenGlobalIsolation, unittest.TestCase):
    """available()은 venv만으로 True 금지 — qwen_tts 패키지 설치 흔적까지 요구."""
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        _configure_test_roots()
        self.addCleanup(runtime_paths.reset)

    def test_available_requires_qwen_pkg(self):
        eng = tts_worker.QwenTTSEngine()
        pkg = eng._qwen_pkg_dir_path()
        with mock.patch.object(os.path, "exists", lambda p: True), \
             mock.patch.object(os.path, "getsize", lambda p: 100):
            # 패키지 dir 없음(venv만 남음) → False
            with mock.patch.object(os.path, "isdir", lambda p: p != pkg):
                self.assertFalse(eng.available(), "패키지 제거 시 available=False여야 함")
            # 패키지 dir + 스냅샷 존재 → True
            with mock.patch.object(os.path, "isdir", lambda p: True):
                self.assertTrue(eng.available())


class AtempoCleanupTest(_QwenGlobalIsolation, unittest.TestCase):
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_atempo_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_partial_output_cleaned_on_failure(self):
        import audio_utils
        inp = os.path.join(self.tmp, "seg.wav")
        _write(inp, 0.3)
        out = inp.replace(".wav", "_x1.50.wav")

        def fake_run(cmd, **kw):
            # ffmpeg가 부분 파일을 만든 뒤 실패(returncode!=0)하는 상황 재현
            with open(out, "wb") as f:
                f.write(b"partial-not-a-real-wav")

            class P:
                pass
            p = P()
            p.returncode = 1
            p.stderr = b"ffmpeg boom"
            p.stdout = b""
            return p
        self._patch(audio_utils, "find_ffmpeg", new=(lambda: "ffmpeg"))
        self._patch(subprocess, "run", side_effect=fake_run)
        with self.assertRaises(RuntimeError):
            tts_worker._atempo_segment(inp, 1.5)
        self.assertFalse(os.path.exists(out), "실패 시 부분 atempo 출력이 정리돼야 함")


class AtomicFinalReplaceTest(_QwenGlobalIsolation, unittest.TestCase):
    """최종 출력은 임시 WAV→검증→os.replace로만 교체. 실패/검증실패 시 기존 synthesized.wav 불변."""
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_atomic_")
        self.ref = os.path.join(self.tmp, "ref7.wav")
        _write(self.ref, 7.0)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self.final = os.path.join(self.out, "synthesized.wav")
        self._orig_ra = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.addCleanup(lambda: (ra._analysis_cache.clear(), ra._analysis_cache.update(self._orig_ra)))
        self._patch("gpu_policy.select_device", new=(lambda *a, **k: ("cpu", "test")))
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))
        self._patch(transcribe_worker, "run_transcribe",
                    side_effect=(lambda m, p, l: {"text": "자동전사", "language": "ko"}))
        self._patch(tts_worker.QwenTTSEngine, "available", new=(lambda self: True))

        def fake_run_job(inner_self, segments, device):
            for s in segments:
                _write(s["out_path"], 0.3)
            return [{"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                     "out_path": s["out_path"], "sr": 24000, "x_vector_only": s["x_vector_only"],
                     "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                     "generation_limit": 256, "generated_iterations": 100,
                     "termination_reason": "completed_before_limit", "status": "ok"} for s in segments]
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job)

    def _preexisting_final(self):
        marker = b"OLD-SYNTHESIZED-CONTENT-DO-NOT-TOUCH"
        with open(self.final, "wb") as f:
            f.write(marker)
        return marker

    def _job_dirs_left(self):
        # 실행별 임시폴더(.qwen-job-*) 잔존 여부 — Python finally가 지워야 함
        return [f for f in os.listdir(self.out) if f.startswith(".qwen-job-")]

    def test_existing_final_preserved_on_concat_failure(self):
        marker = self._preexisting_final()

        def raise_concat(paths, gaps_before, out_path):
            with open(out_path, "wb") as f:  # 부분 pending 생성 후 예외
                f.write(b"partial")
            raise RuntimeError("concat boom")
        self._patch(tts_worker, "_concat_with_boundaries", new=raise_concat)
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                                  emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        with open(self.final, "rb") as f:
            self.assertEqual(f.read(), marker, "concat 실패 시 기존 synthesized.wav 불변")
        self.assertEqual(self._job_dirs_left(), [], "실행별 임시폴더 정리")

    def test_existing_final_preserved_on_validation_failure(self):
        marker = self._preexisting_final()

        def zero_byte_concat(paths, gaps_before, out_path):
            with open(out_path, "wb"):  # 0바이트 pending → 검증 실패
                pass
        self._patch(tts_worker, "_concat_with_boundaries", new=zero_byte_concat)
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                                  emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        with open(self.final, "rb") as f:
            self.assertEqual(f.read(), marker, "검증 실패 시 기존 synthesized.wav 불변")
        self.assertEqual(self._job_dirs_left(), [], "실행별 임시폴더 정리")

    def test_success_replaces_final_atomically(self):
        self._preexisting_final()
        tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        import soundfile as sf
        d, sr = sf.read(self.final)
        self.assertGreater(len(d), 0)
        self.assertEqual(int(sr), 24000)
        self.assertEqual(self._job_dirs_left(), [], "성공 후 실행별 임시폴더 없음")
        self.assertEqual([f for f in os.listdir(self.out) if f.startswith("segment_qwen_")], [])

    def test_atempo_failure_cleans_job_dir_and_preserves_final(self):
        marker = self._preexisting_final()
        self._patch(tts_worker, "_atempo_segment",
                    new=(lambda inp, speed: (_ for _ in ()).throw(RuntimeError("속도 적용 실패"))))
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.5, silence_gap=0.5,
                                  emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        with open(self.final, "rb") as f:
            self.assertEqual(f.read(), marker, "atempo 실패 시 기존 synthesized.wav 불변")
        self.assertEqual(self._job_dirs_left(), [], "atempo 실패에도 실행별 임시폴더 정리")


class ResolveReferenceInputTest(unittest.TestCase):
    """override(확정 파생 클립) 수명 — 만료 시 원본으로 조용히 폴백하지 않고 명확히 실패."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_refin_")
        self.clip = os.path.join(self.tmp, "reference_clip_24k.wav")
        with open(self.clip, "wb") as f:
            f.write(b"x")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def test_empty_override_uses_input(self):
        self.assertEqual(tts_worker.resolve_reference_input("", "orig.wav"), "orig.wav")
        self.assertEqual(tts_worker.resolve_reference_input(None, "orig.wav"), "orig.wav")

    def test_existing_override_used(self):
        self.assertEqual(tts_worker.resolve_reference_input(self.clip, "orig.wav"), self.clip)

    def test_missing_override_raises_no_fallback(self):
        missing = os.path.join(self.tmp, "gone.wav")
        with self.assertRaises(RuntimeError) as cm:
            tts_worker.resolve_reference_input(missing, "orig.wav")
        self.assertIn("만료", str(cm.exception))  # 원본으로 폴백하지 않음


class MetadataHelperTest(unittest.TestCase):
    """P1-1 재현 메타데이터 헬퍼 — 고정 형태·source 파싱·prompt_source·전사 요약(비민감)."""
    def test_build_metadata_full_shape(self):
        m = tts_worker._build_tts_metadata(actual_engine="qwen3")
        for k in tts_worker._METADATA_KEYS:
            self.assertIn(k, m)
        self.assertEqual(m["actual_engine"], "qwen3")
        # 전사 '전문' 키는 존재하지 않는다(언어/길이/해시만)
        self.assertNotIn("reference_transcript", m)

    def test_parse_device_source(self):
        self.assertEqual(tts_worker._parse_device_source("여유 VRAM 5000/16000MB ≥ 4000MB → GPU (source=nvidia-smi)"), "nvidia-smi")
        self.assertEqual(tts_worker._parse_device_source("... (source=torch.mem_get_info)"), "torch.mem_get_info")
        self.assertIn("측정실패", tts_worker._parse_device_source("nvidia-smi 측정 실패(부재/timeout/파싱) → 보수적 CPU"))

    def test_prompt_source_for(self):
        ref = os.path.abspath("r.wav")
        self.assertEqual(tts_worker._prompt_source_for(ref, {}, True), "x-vector-only")
        self.assertEqual(tts_worker._prompt_source_for(ref, {ref: {"manual_text": "수동"}}, False), "manual")
        self.assertEqual(tts_worker._prompt_source_for(ref, {}, False), "auto")

    def test_transcript_meta_no_fulltext(self):
        lang, n, sha = tts_worker._transcript_meta("안녕하세요 테스트입니다")
        self.assertEqual(lang, "ko")
        self.assertEqual(n, len("안녕하세요 테스트입니다"))
        self.assertEqual(len(sha), 8)
        self.assertNotIn("안녕", sha)  # 해시는 전문을 노출하지 않음
        self.assertEqual(tts_worker._transcript_meta(""), (None, 0, None))


class MetadataEmitQwenTest(_QwenGlobalIsolation, unittest.TestCase):
    """Qwen 배치 경로가 result에 재현 메타데이터를 emit하고, 전사 전문은 담기지 않음을 검증."""
    def setUp(self):
        self._isolate_globals()
        self.events = []
        self._patch(tts_worker, "emit", new=(lambda mt, **k: self.events.append((mt, k))))
        self.tmp = tempfile.mkdtemp(prefix="af_meta_")
        self.ref = os.path.join(self.tmp, "ref5.wav"); _write(self.ref, 5.0)
        self.out = os.path.join(self.tmp, "out"); os.makedirs(self.out)
        self._orig_ra = dict(ra._analysis_cache); ra._analysis_cache.clear()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.addCleanup(lambda: (ra._analysis_cache.clear(), ra._analysis_cache.update(self._orig_ra)))
        self._patch("gpu_policy.select_device",
                    new=(lambda *a, **k: ("cuda", "여유 VRAM 5000/16000MB ≥ 4000MB → GPU (source=nvidia-smi)")))
        self._patch(transcribe_worker, "_get_whisper_model", new=(lambda n: ("m", n)))
        self._patch(transcribe_worker, "run_transcribe",
                    side_effect=(lambda m, p, l: {"text": "자동전사문장", "language": "ko"}))
        self._patch(tts_worker.QwenTTSEngine, "available", new=(lambda self: True))

        def fake_run_job(inner_self, segments, device):
            for s in segments:
                _write(s["out_path"], 0.3)
            return [{"original_segment_index": s["index"], "chunk_index": 0, "chunk_count": 1,
                     "out_path": s["out_path"], "sr": 24000, "x_vector_only": s["x_vector_only"],
                     "emotion_id": s.get("emotion_id"), "production_tokens": 20,
                     "generation_limit": 256, "generated_iterations": 100,
                     "termination_reason": "completed_before_limit", "status": "ok"} for s in segments]
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job)

        # speed!=1.0 경로의 ffmpeg 의존 제거 — atempo를 복사로 대체(메타데이터만 검증)
        def fake_atempo(inp, speed):
            out = inp.replace(".wav", f"_x{speed:.2f}.wav"); shutil.copyfile(inp, out); return out
        self._patch(tts_worker, "_atempo_segment", new=fake_atempo)

    def _result_meta(self):
        for mt, k in self.events:
            if mt == "result":
                return k.get("metadata")
        return None

    def test_qwen_result_metadata(self):
        tts_worker.synthesize(self.ref, "안녕하세요 첫 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        meta = self._result_meta()
        self.assertIsNotNone(meta, "result에 metadata가 있어야 함")
        self.assertEqual(meta["actual_engine"], "qwen3")
        self.assertEqual(meta["requested_engine"], "qwen3")
        self.assertEqual(meta["device"], "cuda:0")
        self.assertEqual(meta["device_selection_source"], "nvidia-smi")
        self.assertEqual(meta["prompt_source"], "auto")  # 자동 전사 → ICL
        self.assertEqual(meta["x_vector_only_mode"], False)
        self.assertEqual(meta["reference_transcript_language"], "ko")
        self.assertEqual(meta["reference_transcript_len"], len("자동전사문장"))
        self.assertEqual(len(meta["reference_transcript_sha8"]), 8)
        self.assertEqual(meta["output_sample_rate"], 24000)
        self.assertFalse(meta["speed_postprocessed"])
        self.assertFalse(meta["seed_supported"])
        self.assertIsInstance(meta["elapsed_seconds"], (int, float))
        # 보안: 어떤 메타 값에도 전사 '전문'이 들어가지 않는다
        blob = _json_dumps(meta)
        self.assertNotIn("자동전사문장", blob)

    def test_ref_free_prompt_source_metadata(self):
        ap = os.path.abspath(self.ref)
        tts_worker.synthesize(self.ref, "안녕하세요 문장.", self.out, speed=1.5, silence_gap=0.5,
                              emotion_refs={}, preferred_engine="qwen3",
                              reference_prompts={"default": {"mode": "ref_free"}})
        meta = self._result_meta()
        self.assertEqual(meta["prompt_source"], "x-vector-only")
        self.assertTrue(meta["x_vector_only_mode"])
        self.assertTrue(meta["speed_postprocessed"])  # speed 1.5


def _json_dumps(o):
    import json
    return json.dumps(o, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
