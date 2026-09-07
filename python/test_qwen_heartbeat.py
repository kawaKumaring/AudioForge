# -*- coding: utf-8 -*-
"""C1 — Qwen 모델 로딩 수명주기(heartbeat + stage + 기동 hard deadline) 테스트.

배경(구조적 결함): 브리지는 `emit(percent=10)` 직후 `from_pretrained()`가 반환할 때까지 stdout에
아무것도 쓰지 않았고, 부모는 마지막 stdout 이후 280s(_QWEN_INACTIVITY_SEC)면 자식을 죽였다.
콜드 로딩(첫 실행·큰 스냅샷·차가운 page cache)이 그 창을 넘기면 '정상이지만 느린 로딩'이 죽는다.
또한 '느린 로딩'과 '멈춘 로딩'을 구분할 방법이 없었다.

이 파일이 고정하는 계약:
  1) 로딩 중 heartbeat가 10~15s 간격으로 나간다(스레드 안전).
  2) stage 이벤트가 loading / loaded / generating 을 구분한다.
  3) heartbeat는 '비활성 timer'만 갱신한다.
  4) 별도의 유한한 기동 hard deadline이 있고 heartbeat가 그것을 연장하지 못한다.
  5) 280s를 그냥 키우지 않았다.
  6) 자동 재시도·자동 CPU 강등 없음(로딩 timeout은 OOM이 아니다).
  7) heartbeat가 계속 와도 기동 deadline을 넘기면 구조화 오류로 종료한다.
  8) stage=loaded 이후에는 기존 280s 무응답 계약이 그대로다.

GPU·torch·실모델 없음. 모든 타이밍은 주입된 clock/interval로 결정적이며 파일 전체가 1초 미만.
"""
import io
import json
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qwen_bridge  # noqa: E402

# 가짜 모델에는 vendor speech tokenizer 가 없다 — 참조 codec 프레임 측정기를 고정값(85 frame ≈ 7초)으로 대체.
# production 측정 실패는 예외(fail-closed)라 여기서만 바꿔 끼운다.
qwen_bridge.REF_FRAMES_MEASURER = lambda _model, _seg: 85
import tts_worker  # noqa: E402
import generation_limit as gl  # noqa: E402

# numpy/gpu_policy(=torch)는 모듈 import 시점 비용이 크다 — 필요한 테스트 안에서만 지연 import.


# ──────────────────────────────────────────────────────────────────────────────
# 브리지 측 — heartbeat 스레드 / emit 원자성
# ──────────────────────────────────────────────────────────────────────────────

class _Collector:
    """emit 대체 — (type, kwargs) 기록. 스레드에서 호출되므로 append(원자)만 쓴다."""

    def __init__(self):
        self.events = []

    def __call__(self, msg_type, **kw):
        self.events.append((msg_type, kw))

    def kinds(self, kind):
        return [kw for t, kw in self.events if t == kind]


class LoadHeartbeatTest(unittest.TestCase):
    """_load_with_heartbeat: 로딩 중에만 생존 신호를 보내고, 끝나면 확실히 멈춘다."""

    def test_heartbeat_emitted_during_load(self):
        c = _Collector()

        def slow_load():
            time.sleep(0.06)      # interval 0.01 → 대략 5회
            return "MODEL"

        out = qwen_bridge._load_with_heartbeat(slow_load, interval=0.01, emit_fn=c)
        self.assertEqual(out, "MODEL")
        beats = c.kinds("heartbeat")
        self.assertGreaterEqual(len(beats), 2, "로딩 중 heartbeat가 반복 emit돼야 한다")
        self.assertEqual([b["seq"] for b in beats], list(range(1, len(beats) + 1)),
                         "seq는 1부터 연속 증가")
        for b in beats:
            self.assertEqual(b["stage"], "loading")
            self.assertIsInstance(b["elapsed_sec"], float)

    def test_heartbeat_stops_after_loaded(self):
        c = _Collector()
        qwen_bridge._load_with_heartbeat(lambda: time.sleep(0.03), interval=0.01, emit_fn=c)
        n_after_load = len(c.kinds("heartbeat"))
        time.sleep(0.05)          # interval의 5배를 더 기다린다
        self.assertEqual(len(c.kinds("heartbeat")), n_after_load,
                         "load_fn 반환 후에는 heartbeat가 단 한 개도 더 나가면 안 된다")

    def test_heartbeat_stops_on_load_failure(self):
        c = _Collector()

        def boom():
            time.sleep(0.03)
            raise RuntimeError("load failed")

        with self.assertRaises(RuntimeError):
            qwen_bridge._load_with_heartbeat(boom, interval=0.01, emit_fn=c)
        n_after = len(c.kinds("heartbeat"))
        time.sleep(0.05)
        self.assertEqual(len(c.kinds("heartbeat")), n_after,
                         "예외 경로에서도 heartbeat 스레드는 정지·join 돼야 한다")

    def test_zero_heartbeat_when_load_is_instant(self):
        c = _Collector()
        qwen_bridge._load_with_heartbeat(lambda: "fast", interval=5.0, emit_fn=c)
        self.assertEqual(c.kinds("heartbeat"), [], "즉시 끝난 로딩은 heartbeat를 만들지 않는다")


class _RecordingStdout:
    """write() 호출 단위를 그대로 기록 — 라인 원자성 검증용."""

    def __init__(self):
        self.writes = []

    def write(self, s):
        self.writes.append(s)
        return len(s)

    def flush(self):
        pass


class EmitAtomicityTest(unittest.TestCase):
    """print()는 본문과 '\\n'을 따로 write 하므로 스레드가 섞이면 JSON 라인이 깨진다.
    heartbeat 스레드를 도입한 이상 emit은 '락 아래 단일 write'여야 한다."""

    def test_emit_is_line_atomic_under_threads(self):
        fake = _RecordingStdout()
        p = mock.patch.object(sys, "stdout", fake)
        p.start()
        try:
            def worker(tag):
                for i in range(50):
                    qwen_bridge.emit("heartbeat", stage="loading", seq=i, tag=tag)

            threads = [threading.Thread(target=worker, args=(f"t{n}",)) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        finally:
            p.stop()

        self.assertEqual(len(fake.writes), 200, "emit 1회 = write 1회여야 한다(본문+개행 분리 금지)")
        for w in fake.writes:
            self.assertTrue(w.endswith("\n"))
            self.assertEqual(w.count("\n"), 1, "라인 내부에 개행이 섞이면 안 된다")
            self.assertEqual(json.loads(w)["type"], "heartbeat")


# ──────────────────────────────────────────────────────────────────────────────
# 브리지 측 — 생성 구간에는 heartbeat가 없다(요구사항 8의 발생지 고정)
# ──────────────────────────────────────────────────────────────────────────────

class _Ids:
    def __init__(self, n):
        self.shape = (1, n)


class _ProcLen:
    def __call__(self, text=None, return_tensors=None):
        return {"input_ids": _Ids(len(text))}


class _FakeModel:
    def generate_voice_clone(self, text=None, language=None, ref_audio=None, ref_text=None,
                             x_vector_only_mode=False, max_new_tokens=None):
        import numpy as np
        qwen_bridge._COUNTER["n"] = 50
        return [np.zeros(240, dtype=np.float32)], 24000


class NoHeartbeatDuringGenerationTest(unittest.TestCase):
    def test_no_heartbeat_during_generation(self):
        import shutil
        import tempfile
        tmp = tempfile.mkdtemp(prefix="af_hb_gen_")
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        seg = {"index": 0, "text": "짧은 문장", "ref_audio": "r.wav", "ref_text": "rt",
               "x_vector_only": False, "language_name": "Korean", "emotion_id": "default",
               "out_path": os.path.join(tmp, "segment_qwen_001.wav")}
        c = _Collector()
        proc = _ProcLen()
        plan = qwen_bridge._build_chunk_plan([seg], lambda t: t, proc, gl.max_segment_tokens())
        with mock.patch.object(qwen_bridge, "emit", new=c):
            qwen_bridge._generate_plan(_FakeModel(), plan, lambda t: t, proc, 1)
        self.assertEqual(c.kinds("heartbeat"), [],
                         "생성 구간은 heartbeat를 만들지 않는다 — 280s 무응답 계약 보존")


# ──────────────────────────────────────────────────────────────────────────────
# 부모 측 — run_job 이중 시계
# ──────────────────────────────────────────────────────────────────────────────

class _StepClock:
    """호출마다 step초씩 전진하는 결정적 clock. 실제 sleep 없이 분/시간 규모를 시뮬레이션한다."""

    def __init__(self, step=5.0):
        self.step = step
        self.t = 0.0
        self.calls = 0

    def __call__(self):
        self.calls += 1
        v = self.t
        self.t += self.step
        return v


class _BlockingLines:
    """지정한 라인들을 먼저 내주고, 그 다음 __next__에서 block_sec 동안 멈춘 뒤 스트림을 닫는다.
    → 부모의 q.get(timeout=...)이 실제로 Empty를 맞도록 만드는 최소 장치(50~400ms)."""

    def __init__(self, lines, block_sec=0.4):
        self._it = iter(list(lines))
        self._block = block_sec

    def __iter__(self):
        return self

    def __next__(self):
        try:
            return next(self._it)
        except StopIteration:
            time.sleep(self._block)
            raise


class _FakePopen:
    """run_job이 Popen.stdout/stderr를 스레드로 실시간 읽으므로 라인 이터러블로 흉내낸다."""

    def __init__(self, out_lines, err_lines=(), returncode=0):
        self.stdout = out_lines if hasattr(out_lines, "__next__") else iter(list(out_lines))
        self.stderr = iter(list(err_lines))
        self.returncode = returncode
        self.killed = False
        self.pid = None

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


def _line(**kw):
    return json.dumps(kw, ensure_ascii=False) + "\n"


class _RunJobHarness(unittest.TestCase):
    """run_job을 실제 프로세스 없이 구동하기 위한 공통 setUp."""

    def setUp(self):
        import subprocess
        self.log = []
        p = mock.patch.object(tts_worker, "emit",
                              new=lambda mt, **k: self.log.append((mt, k)))
        p.start()
        self.addCleanup(p.stop)
        # 트리 kill은 taskkill 서브프로세스를 띄우므로 fake의 kill()만 쓰도록 대체
        pk = mock.patch.object(tts_worker, "_kill_proc_tree", new=lambda pr: pr.kill())
        pk.start()
        self.addCleanup(pk.stop)
        self.subprocess = subprocess
        self.eng = tts_worker.QwenTTSEngine()
        self.seg = [{"index": 0, "text": "t", "ref_audio": "r", "ref_text": "x",
                     "x_vector_only": False, "language_name": "Korean", "out_path": "a.wav"}]

    def _popen(self, fp):
        p = mock.patch.object(self.subprocess, "Popen", return_value=fp)
        p.start()
        self.addCleanup(p.stop)
        return fp

    def _progress(self):
        return [k for t, k in self.log if t == "progress"]


class StartupDeadlineTest(_RunJobHarness):
    def test_heartbeat_refreshes_inactivity_only(self):
        """heartbeat가 계속 오면 무응답 timeout에는 걸리지 않고 정상 완주한다."""
        lines = [_line(type="stage", stage="loading", attn="sdpa", attempt=1, device="cuda:0")]
        lines += [_line(type="heartbeat", stage="loading", seq=i, elapsed_sec=float(i * 12))
                  for i in range(1, 41)]
        lines += [_line(type="stage", stage="loaded", attn="sdpa", attempt=1, dtype="bfloat16"),
                  _line(type="result",
                        segments=[{"index": 0, "out_path": "a.wav", "sr": 24000}], success=True)]
        fp = self._popen(_FakePopen(lines))
        vp = mock.patch.object(tts_worker.QwenTTSEngine, "_validate_seg_out",
                               new=staticmethod(lambda seg_out, segments: seg_out))
        vp.start()
        self.addCleanup(vp.stop)
        # 40 heartbeat × 2 clock call × 5s = 400s 경과 — 무응답 280s를 훨씬 넘지만 죽지 않아야 한다.
        res = self.eng.run_job(self.seg, "cpu", inactivity_sec=280,
                               startup_deadline_sec=100000, monotonic=_StepClock(5.0))
        self.assertEqual(res[0]["index"], 0)
        self.assertFalse(fp.killed, "heartbeat가 도착하는 동안에는 자식을 죽이지 않는다")

    def test_forwarded_load_percent_monotonic_and_below_25(self):
        """heartbeat → progress 변환(Electron watchdog 유지용)의 percent 규칙.
        브리지가 로딩 완료 시 percent=25를 쓰므로 그 아래에서만, 되돌아가지 않고 움직여야 한다."""
        lines = [_line(type="stage", stage="loading", attn="sdpa", attempt=1, device="cuda:0")]
        lines += [_line(type="heartbeat", stage="loading", seq=i, elapsed_sec=float(i * 12))
                  for i in range(1, 41)]
        lines += [_line(type="stage", stage="loaded", attn="sdpa", attempt=1, dtype="bfloat16"),
                  _line(type="progress", percent=25, message="모델 로딩 완료"),
                  _line(type="result",
                        segments=[{"index": 0, "out_path": "a.wav", "sr": 24000}], success=True)]
        self._popen(_FakePopen(lines))
        vp = mock.patch.object(tts_worker.QwenTTSEngine, "_validate_seg_out",
                               new=staticmethod(lambda seg_out, segments: seg_out))
        vp.start()
        self.addCleanup(vp.stop)
        self.eng.run_job(self.seg, "cpu", inactivity_sec=280,
                         startup_deadline_sec=100000, monotonic=_StepClock(5.0))

        pcts = [p["percent"] for p in self._progress()]
        self.assertTrue(len(pcts) >= 41, "heartbeat마다 progress가 전달돼야 Electron watchdog가 산다")
        self.assertEqual(pcts, sorted(pcts), "percent는 단조 비감소여야 한다")
        load_pcts = pcts[:-1]   # 마지막은 브리지가 보낸 percent=25 (로딩 완료 신호)
        self.assertTrue(all(v < 25 for v in load_pcts),
                        f"로딩 중 percent는 항상 25 미만이어야 한다: max={max(load_pcts)}")
        self.assertGreaterEqual(min(load_pcts), tts_worker._QWEN_LOAD_PCT_MIN)
        self.assertEqual(max(load_pcts), tts_worker._QWEN_LOAD_PCT_MAX)

    def test_startup_deadline_not_extended_by_heartbeats(self):
        """heartbeat가 끊임없이 와도 기동 hard deadline을 넘기면 구조화 오류로 종료(요구사항 7)."""
        lines = [_line(type="stage", stage="loading", attn="sdpa", attempt=1, device="cuda:0")]
        lines += [_line(type="heartbeat", stage="loading", seq=i, elapsed_sec=float(i * 12))
                  for i in range(1, 201)]
        fp = self._popen(_FakePopen(lines))
        with self.assertRaises(tts_worker.QwenLoadTimeoutError) as cm:
            self.eng.run_job(self.seg, "cpu", inactivity_sec=280,
                             startup_deadline_sec=600, monotonic=_StepClock(5.0))
        e = cm.exception
        self.assertEqual(e.error_payload["code"], "QWEN_LOAD_TIMEOUT")
        self.assertEqual(e.error_payload["deadline_sec"], 600)
        self.assertGreaterEqual(e.error_payload["elapsed_sec"], 600)
        self.assertGreaterEqual(e.error_payload["heartbeats_seen"], 40,
                                "kill 시점까지 heartbeat가 계속 도착하고 있었음을 고정")
        self.assertEqual(e.error_payload["last_stage"], "loading")
        self.assertTrue(fp.killed, "기동 deadline 초과 시 자식 트리를 종료한다")

    def test_startup_deadline_fires_on_silence_not_inactivity(self):
        """완전 무출력이고 기동 deadline이 무응답보다 짧으면 QWEN_LOAD_TIMEOUT으로 판정한다
        (wait=min(무응답, 기동잔량) 이라 어느 축이 터졌는지 구분이 필요하다)."""
        fp = self._popen(_FakePopen(_BlockingLines([], block_sec=0.25)))
        with self.assertRaises(tts_worker.QwenLoadTimeoutError):
            self.eng.run_job(self.seg, "cpu", inactivity_sec=10, startup_deadline_sec=0.05)
        self.assertTrue(fp.killed)

    def test_inactivity_contract_unchanged_after_loaded(self):
        """stage=loaded 이후에는 기존 무응답 계약 그대로 — 문구·동작 불변, code만 덧붙는다."""
        fp = self._popen(_FakePopen(_BlockingLines(
            [_line(type="stage", stage="loaded", attn="sdpa", attempt=1, dtype="bfloat16")],
            block_sec=0.25)))
        with self.assertRaises(RuntimeError) as cm:
            self.eng.run_job(self.seg, "cpu", inactivity_sec=0.1, startup_deadline_sec=60)
        e = cm.exception
        self.assertNotIsInstance(e, tts_worker.QwenLoadTimeoutError)
        self.assertEqual(str(e), "Qwen 무응답 0.1s 초과 — 프로세스 종료")
        self.assertEqual(e.error_payload["code"], "QWEN_NO_RESPONSE")
        self.assertEqual(e.error_payload["last_stage"], "loaded")
        self.assertTrue(fp.killed)

    def test_eager_retry_is_visible(self):
        """sdpa → eager 재시도(두 번째 전체 로딩)가 한 번의 느린 로딩과 구분돼야 한다."""
        lines = [_line(type="stage", stage="loading", attn="sdpa", attempt=1, device="cuda:0"),
                 _line(type="heartbeat", stage="loading", seq=1, elapsed_sec=12.0),
                 _line(type="stage", stage="loading", attn="eager", attempt=2, device="cuda:0"),
                 _line(type="stage", stage="loaded", attn="eager", attempt=2, dtype="bfloat16"),
                 _line(type="result",
                       segments=[{"index": 0, "out_path": "a.wav", "sr": 24000}], success=True)]
        self._popen(_FakePopen(lines))
        vp = mock.patch.object(tts_worker.QwenTTSEngine, "_validate_seg_out",
                               new=staticmethod(lambda seg_out, segments: seg_out))
        vp.start()
        self.addCleanup(vp.stop)
        self.eng.run_job(self.seg, "cpu", monotonic=_StepClock(5.0))
        msgs = [p["message"] for p in self._progress()]
        self.assertTrue(any("재시도" in m for m in msgs),
                        "attempt>1 로딩은 사용자에게 보이는 신호를 남긴다")


class ConstantsAndPolicyTest(unittest.TestCase):
    def test_constants_not_merely_raised(self):
        """280을 그냥 키워서 해결하지 않았음을 영구 고정한다(요구사항 5)."""
        self.assertEqual(tts_worker._QWEN_INACTIVITY_SEC, 280,
                         "생성 구간 무응답 계약은 280 그대로여야 한다")
        d = tts_worker._QWEN_STARTUP_DEADLINE_SEC
        self.assertIsInstance(d, int)
        self.assertNotEqual(d, 280, "기동 deadline은 무응답 timeout과 다른 축이다")
        self.assertGreater(d, 280)
        self.assertLess(d, 3600, "기동 deadline은 유한하고 유계여야 한다(무한 대기 금지)")

    def test_load_pct_window_below_bridge_loaded_percent(self):
        self.assertLess(tts_worker._QWEN_LOAD_PCT_MIN, tts_worker._QWEN_LOAD_PCT_MAX)
        self.assertLess(tts_worker._QWEN_LOAD_PCT_MAX, 25,
                        "브리지의 '로딩 완료' percent=25 아래에 머물러야 percent가 역행하지 않는다")

    def test_load_timeout_is_not_oom_and_not_retried(self):
        """로딩 timeout은 CUDA OOM이 아니므로 상위의 CPU 1회 재시도 분기에 걸리지 않는다
        (자동 재시도·자동 CPU 강등·모델 재다운로드 금지 — 요구사항 6)."""
        import gpu_policy
        e = tts_worker.QwenLoadTimeoutError(601, 600, 49, "loading")
        self.assertFalse(gpu_policy.is_cuda_oom(e))
        self.assertIsInstance(e, RuntimeError)
        self.assertNotIsInstance(e, tts_worker.QwenGenerationLimitError)

    def test_load_timeout_payload_has_no_paths_or_text(self):
        e = tts_worker.QwenLoadTimeoutError(601, 600, 49, "loading")
        blob = json.dumps(e.error_payload, ensure_ascii=False)
        for bad in ("/", "\\", ".wav", ".safetensors"):
            self.assertNotIn(bad, blob, f"오류 payload에 경로 흔적 금지: {bad}")
        self.assertEqual(set(e.error_payload) - {"code", "last_stage"},
                         {"elapsed_sec", "deadline_sec", "heartbeats_seen"})


class BridgeStageContractTest(unittest.TestCase):
    """브리지가 실제로 쓰는 stage 문자열 집합을 고정한다(부모 파서와 한 쌍)."""

    def test_stage_strings(self):
        with io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "qwen_bridge.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('emit("stage", stage="loading"', src)
        self.assertIn('emit("stage", stage="loaded"', src)
        self.assertIn('emit("stage", stage="generating"', src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
