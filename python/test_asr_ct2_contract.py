"""faster-whisper 경로의 **계약** — 부르는 쪽이 엔진을 몰라도 되는가.

여기서 보는 것은 딱 넷이다. 정확도는 보지 않는다(한 파일로 정확도를 말할 수 없다).
  1) 반환 모양이 기존 경로와 같은가 — text·language·segments·words
  2) 시간 정보가 말이 되는가 — 단조 증가, 구간 안에 단어가 들어 있다
  3) 실패를 숨기지 않는가 — 환경·모델이 없으면 사유를 들고 실패한다
  4) 기본 선택이 보존되는가 — 고르지 않으면 기존 경로로 간다

실행: <앱 파이썬> -X utf8 python/test_asr_ct2_contract.py
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import transcribe_worker as tw   # noqa: E402


def _fake_bridge_payload():
    """다리가 돌려주는 모양 — 실제 실행에서 받은 것과 같은 구조."""
    return {
        "text": "첫 문장입니다. 둘째 문장입니다.",
        "language": "ko",
        "segments": [
            {"id": 0, "seek": 0, "start": 0.0, "end": 2.5, "text": "첫 문장입니다.",
             "tokens": [], "temperature": 0.0, "avg_logprob": -0.2,
             "compression_ratio": 1.1, "no_speech_prob": 0.01,
             "words": [{"start": 0.0, "end": 1.2, "word": "첫", "probability": 0.9},
                       {"start": 1.2, "end": 2.5, "word": "문장입니다.", "probability": 0.9}]},
            {"id": 1, "seek": 0, "start": 2.5, "end": 5.0, "text": "둘째 문장입니다.",
             "tokens": [], "temperature": 0.0, "avg_logprob": -0.3,
             "compression_ratio": 1.2, "no_speech_prob": 0.02,
             "words": [{"start": 2.5, "end": 3.8, "word": "둘째", "probability": 0.9},
                       {"start": 3.8, "end": 5.0, "word": "문장입니다.", "probability": 0.9}]},
        ],
        "_run": {"engine": "faster-whisper", "engineVersion": "1.2.1", "ct2Version": "4.8.2",
                 "device": "cuda", "computeType": "float16", "beamSize": 1, "batchSize": 1,
                 "loadSec": 3.4, "transcribeSec": 11.4, "audioDurationSec": 18.56,
                 "languageProbability": 0.99, "segmentCount": 2},
    }


class FakeProc:
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


class ReturnShape(unittest.TestCase):
    """1·2 — 반환 모양과 시간 정보."""

    def _run(self, emits):
        payload = _fake_bridge_payload()

        def fake_run(cmd, **kw):
            # --out 자리에 결과를 써 준다(실제 다리와 같은 방식).
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            return FakeProc(0)

        with mock.patch.object(tw, "_ct2_paths", return_value=("py.exe", "model_dir")), \
             mock.patch("subprocess.run", side_effect=fake_run), \
             mock.patch.object(tw, "_filter_silent_segments", side_effect=lambda r, p: r), \
             mock.patch.object(tw, "emit", side_effect=lambda t, **k: emits.append((t, k))):
            return tw.run_transcribe_ct2("a.wav", "ko")

    def test_shape_matches_existing_path(self):
        emits = []
        r = self._run(emits)
        # 기존 경로가 내주던 열쇠가 전부 있다 — 부르는 쪽(TXT·SRT·번역)이 그대로 쓴다.
        self.assertEqual(set(["text", "language", "segments"]) - set(r), set())
        self.assertNotIn("_run", r, "실행 기록은 결과에 섞이지 않는다(따로 보고한다)")
        self.assertEqual(r["language"], "ko")
        for s in r["segments"]:
            for key in ("start", "end", "text", "words", "no_speech_prob", "avg_logprob"):
                self.assertIn(key, s, f"세그먼트에 {key} 가 있어야 SRT·게이트가 돈다")

    def test_time_information_is_sane(self):
        r = self._run([])
        segs = r["segments"]
        for s in segs:
            self.assertLessEqual(s["start"], s["end"])
            for w in s["words"]:
                self.assertLessEqual(w["start"], w["end"])
                # 단어는 제 구간 안에 있어야 한다(문장 클릭 재생이 이 값을 쓴다).
                self.assertGreaterEqual(round(w["start"], 3), round(s["start"], 3) - 0.001)
                self.assertLessEqual(round(w["end"], 3), round(s["end"], 3) + 0.001)
        for i in range(len(segs) - 1):
            self.assertLessEqual(segs[i]["end"], segs[i + 1]["start"] + 0.001)

    def test_run_record_is_reported(self):
        emits = []
        self._run(emits)
        rec = dict(next(k for t, k in emits if t == "asrRun"))
        # 실행 엔진·장치·정밀도·배치·시간을 기록한다 — 나중에 무엇으로 돌았는지 가릴 수 있게.
        for key in ("engine", "device", "computeType", "beamSize", "batchSize",
                    "loadSec", "transcribeSec", "audioDurationSec"):
            self.assertIn(key, rec)
        self.assertEqual(rec["engine"], "faster-whisper")
        self.assertEqual(rec["device"], "cuda")
        self.assertEqual(rec["computeType"], "float16")

    def test_silence_gate_still_runs(self):
        """무음 오인식 방지를 **조용히 빼지 않는다.**"""
        seen = {}

        def fake_run(cmd, **kw):
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(_fake_bridge_payload(), f, ensure_ascii=False)
            return FakeProc(0)

        def gate(result, path):
            seen["called"] = True
            return result

        with mock.patch.object(tw, "_ct2_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=fake_run), \
             mock.patch.object(tw, "_filter_silent_segments", side_effect=gate), \
             mock.patch.object(tw, "emit"):
            tw.run_transcribe_ct2("a.wav", "ko")
        self.assertTrue(seen.get("called"), "새 엔진 결과도 같은 무음 게이트를 지나야 한다")


class FailuresAreNotHidden(unittest.TestCase):
    """3 — 실패를 숨기거나 몰래 다른 길로 가지 않는다."""

    def test_missing_venv_says_so(self):
        with mock.patch("os.path.isfile", return_value=False):
            with self.assertRaises(tw.FasterWhisperUnavailable) as cm:
                tw._ct2_paths("large-v3")
        self.assertIn("ASR_CT2_VENV_MISSING", str(cm.exception))

    def test_missing_model_says_so(self):
        # venv 는 있고 모델만 없다.
        real = os.path.isfile

        def only_python(p):
            return p.endswith("python.exe")

        with mock.patch("os.path.isfile", side_effect=only_python):
            with self.assertRaises(tw.FasterWhisperUnavailable) as cm:
                tw._ct2_paths("large-v3")
        msg = str(cm.exception)
        self.assertIn("ASR_CT2_MODEL_MISSING", msg)
        self.assertIn("자동 다운로드는 하지 않습니다", msg)
        self.assertTrue(real(__file__))

    def test_bridge_failure_raises_with_reason(self):
        def failing(cmd, **kw):
            return FakeProc(1, "", "RuntimeError: Library cublas64_12.dll is not found")

        with mock.patch.object(tw, "_ct2_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=failing), \
             mock.patch.object(tw, "emit"):
            with self.assertRaises(RuntimeError) as cm:
                tw.run_transcribe_ct2("a.wav", "ko")
        m = str(cm.exception)
        self.assertIn("ASR_CT2_FAILED", m)
        self.assertIn("cublas", m, "왜 실패했는지가 사유에 남아야 한다")
        self.assertNotIn("faster-whisper 대신", m)

    def test_no_silent_cpu_fallback(self):
        """장치를 몰래 CPU 로 바꾸지 않는다 — 언제나 cuda 로 부른다."""
        sent = {}

        def capture(cmd, **kw):
            sent["cmd"] = cmd
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w", encoding="utf-8") as f:
                json.dump(_fake_bridge_payload(), f, ensure_ascii=False)
            return FakeProc(0)

        with mock.patch.object(tw, "_ct2_paths", return_value=("py.exe", "d")), \
             mock.patch("subprocess.run", side_effect=capture), \
             mock.patch.object(tw, "_filter_silent_segments", side_effect=lambda r, p: r), \
             mock.patch.object(tw, "emit"):
            tw.run_transcribe_ct2("a.wav", "ko")
        cmd = sent["cmd"]
        self.assertIn("cuda", cmd)
        self.assertNotIn("cpu", cmd)
        self.assertIn("--compute-type", cmd)
        self.assertEqual(cmd[cmd.index("--compute-type") + 1], "float16")


class DefaultIsPreserved(unittest.TestCase):
    """4 — 고르지 않으면 기존 경로다."""

    def test_default_engine_uses_existing_path(self):
        calls = []
        with mock.patch.object(tw, "_get_whisper_model", side_effect=lambda n: calls.append(("load", n))), \
             mock.patch.object(tw, "run_transcribe", side_effect=lambda m, a, l: calls.append(("old", a)) or {}), \
             mock.patch.object(tw, "run_transcribe_ct2", side_effect=AssertionError("새 경로가 불렸다")), \
             mock.patch.object(tw, "_save_transcription", return_value={"text": ""}), \
             mock.patch.object(tw, "emit"):
            tw.transcribe_file("a.wav", "out")            # asr_engine 미지정
        self.assertTrue(any(c[0] == "old" for c in calls))

    def test_explicit_choice_uses_new_path(self):
        with mock.patch.object(tw, "run_transcribe_ct2", return_value={"text": "x"}) as new, \
             mock.patch.object(tw, "_get_whisper_model", side_effect=AssertionError("기존 모델을 올렸다")), \
             mock.patch.object(tw, "_save_transcription", return_value={"text": "x"}), \
             mock.patch.object(tw, "emit"):
            tw.transcribe_file("a.wav", "out", asr_engine="faster-whisper")
        self.assertEqual(new.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
