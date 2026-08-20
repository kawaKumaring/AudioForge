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
import reference_audio as ra
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
    def setUp(self):
        self._isolate_globals()
        self._silence_emit()
        self.tmp = tempfile.mkdtemp(prefix="af_qwenval_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _seg(self, i):
        p = os.path.join(self.tmp, f"s{i}.wav")
        return {"index": i, "out_path": p}, p

    def test_ok(self):
        (s0, p0) = self._seg(0)
        _write(p0, 0.2)
        out = tts_worker.QwenTTSEngine._validate_seg_out(
            [{"index": 0, "out_path": p0}], [s0])
        self.assertEqual(out[0]["index"], 0)

    def test_missing_index_raises(self):
        (s0, p0), (s1, p1) = self._seg(0), self._seg(1)
        _write(p0, 0.2)
        with self.assertRaises(RuntimeError):
            tts_worker.QwenTTSEngine._validate_seg_out([{"index": 0, "out_path": p0}], [s0, s1])

    def test_zero_byte_raises(self):
        (s0, p0) = self._seg(0)
        with open(p0, "wb"):  # 0바이트
            pass
        with self.assertRaises(RuntimeError):
            tts_worker.QwenTTSEngine._validate_seg_out([{"index": 0, "out_path": p0}], [s0])


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
            return [{"index": s["index"], "out_path": s["out_path"], "sr": 24000,
                     "x_vector_only": s["x_vector_only"]} for s in segments]
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
        # 세그먼트 임시파일 정리
        leftovers = [f for f in os.listdir(self.out) if f.startswith("segment_qwen_")]
        self.assertEqual(leftovers, [], "세그먼트 임시파일은 정리돼야 함")

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
        gap_seen = []
        real_concat = tts_worker._concat_with_silence

        def spy_concat(paths, out_path, gap):
            gap_seen.append(gap)
            return real_concat(paths, out_path, gap)
        self._patch(tts_worker, "_concat_with_silence", new=spy_concat)

        text = "첫 문장입니다.\n둘째 문장입니다."
        tts_worker.synthesize(self.ref, text, self.out, speed=1.5, silence_gap=0.75,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        self.assertEqual(len(atempo_hits), 2, "속도는 최종 결합본이 아니라 세그먼트별로 적용")
        self.assertTrue(all(abs(s - 1.5) < 1e-9 for _, s in atempo_hits))
        self.assertEqual(gap_seen, [0.75], "결합 시 사용자 silence_gap 유지")
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))

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

    def test_available_requires_qwen_pkg(self):
        eng = tts_worker.QwenTTSEngine()
        pkg = eng._qwen_pkg_dir
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
            return [{"index": s["index"], "out_path": s["out_path"], "sr": 24000,
                     "x_vector_only": s["x_vector_only"]} for s in segments]
        self._patch(tts_worker.QwenTTSEngine, "run_job", new=fake_run_job)

    def _preexisting_final(self):
        marker = b"OLD-SYNTHESIZED-CONTENT-DO-NOT-TOUCH"
        with open(self.final, "wb") as f:
            f.write(marker)
        return marker

    def _no_pending_left(self):
        return [f for f in os.listdir(self.out) if f.startswith(".synthesized.pending")]

    def test_existing_final_preserved_on_concat_failure(self):
        marker = self._preexisting_final()

        def raise_concat(paths, out_path, gap):
            with open(out_path, "wb") as f:  # 부분 pending 생성 후 예외
                f.write(b"partial")
            raise RuntimeError("concat boom")
        self._patch(tts_worker, "_concat_with_silence", new=raise_concat)
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                                  emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        with open(self.final, "rb") as f:
            self.assertEqual(f.read(), marker, "concat 실패 시 기존 synthesized.wav 불변")
        self.assertEqual(self._no_pending_left(), [], "임시 pending 정리")

    def test_existing_final_preserved_on_validation_failure(self):
        marker = self._preexisting_final()

        def zero_byte_concat(paths, out_path, gap):
            with open(out_path, "wb"):  # 0바이트 pending → 검증 실패
                pass
        self._patch(tts_worker, "_concat_with_silence", new=zero_byte_concat)
        with self.assertRaises(RuntimeError):
            tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                                  emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        with open(self.final, "rb") as f:
            self.assertEqual(f.read(), marker, "검증 실패 시 기존 synthesized.wav 불변")
        self.assertEqual(self._no_pending_left(), [], "임시 pending 정리")

    def test_success_replaces_final_atomically(self):
        self._preexisting_final()
        tts_worker.synthesize(self.ref, "한 문장입니다.", self.out, speed=1.0, silence_gap=0.5,
                              emotion_refs={}, preferred_engine="qwen3", reference_prompts={})
        import soundfile as sf
        d, sr = sf.read(self.final)
        self.assertGreater(len(d), 0)
        self.assertEqual(int(sr), 24000)
        self.assertEqual(self._no_pending_left(), [], "성공 후 pending 없음")
        self.assertEqual([f for f in os.listdir(self.out) if f.startswith("segment_qwen_")], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
