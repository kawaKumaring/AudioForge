# -*- coding: utf-8 -*-
"""transcribe_worker Phase 1 additive 배선 테스트 — 합성 데이터만.

실제 음성·Whisper·GPU·soundfile·미디어·네트워크 없음. transcribe_worker 는
모듈 로드 시 torch 를 import 하지 않고(무거운 import 는 함수 내부), audio_utils
상단도 가볍다 → 합성 result dict + 임시 폴더로 순수 검증 가능하다.

⚠ 이것은 오디오 ASR 후처리 배선 테스트다. 이미지 OCR 과 무관하다.

검증(코디네이터 계약):
  - 기존 TXT/timestamps/SRT 출력 **바이트 불변**(legacy fmt_srt_time 절삭 유지).
  - canonical sidecar 이벤트: schemaVersion / segmentCount / timing·provenance·
    confidence·status 구조 / **결정적** 직렬화.
  - 전사 본문 0: 이벤트(sidecar/shadow/error)·summary 어디에도 segment/word text 없음.
  - sidecar 파일 0 (영속화 없음).
  - 0길이 세그먼트 production parity(무조건 유지) 가 canonical ingest 를 통과.
  - shadow: legacyKept/policyKept/guardTriggered/agreement/thresholdSnapshot 방출,
    실제 keep/drop 판정 미변경(관측 전용).
  - 오류 격리: sidecar payload 실패해도 TXT/SRT 생성됨 + unavailable 만 emit.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe_worker as tw
from audio_utils import fmt_time, fmt_srt_time
import asr_canonical as ac


CJK_KO = "안녕하세요 반갑습니다"
EN_NUM = "Hello world 2026 test 42"
JA = "こんにちは世界"


def _capture_events(fn, *a, **kw):
    """fn 실행 중 emit(stdout JSON 라인)을 파싱해 (반환값, [events]) 로."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        ret = fn(*a, **kw)
    events = []
    for line in buf.getvalue().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return ret, events


def _synthetic_result():
    # 2.3 종료 세그먼트로 절삭(,299) 규약을 고정. 0길이·빈 세그먼트 포함.
    return {
        "text": (CJK_KO + EN_NUM),
        "language": "ko",
        "segments": [
            {"start": 0.0, "end": 2.3, "text": " " + CJK_KO + " ",
             "no_speech_prob": 0.01, "avg_logprob": -0.12,
             "words": [{"word": "안녕하세요", "start": 0.0, "end": 1.1, "probability": 0.95},
                       {"word": "반갑습니다", "start": 1.1, "end": 2.3, "probability": 0.9}]},
            {"start": 2.3, "end": 2.3, "text": "네"},          # 0길이(유효)
            {"start": 2.3, "end": 4.0, "text": EN_NUM,
             "no_speech_prob": 0.03, "avg_logprob": -0.2},
        ],
    }


def _expected_files(result, base):
    """레거시 포맷 그대로의 기대 TXT/timestamps/SRT 문자열(바이트 불변 기준)."""
    txt = result["text"].strip()
    ts = "".join(
        f"[{fmt_time(s['start'])} → {fmt_time(s['end'])}] {s['text'].strip()}\n"
        for s in result["segments"])
    srt = "".join(
        f"{i}\n{fmt_srt_time(s['start'])} --> {fmt_srt_time(s['end'])}\n{s['text'].strip()}\n\n"
        for i, s in enumerate(result["segments"], 1))
    return txt, ts, srt


class OutputByteInvarianceTest(unittest.TestCase):
    def setUp(self):
        tw._whisper_cache["name"] = "large-v3"

    def test_txt_timestamps_srt_bytes_unchanged(self):
        result = _synthetic_result()
        exp_txt, exp_ts, exp_srt = _expected_files(result, "clip")
        with tempfile.TemporaryDirectory() as d:
            _capture_events(tw._save_transcription, dict(result, segments=list(result["segments"])),
                            "clip.wav", d, True, False, "clip")
            with open(os.path.join(d, "clip.txt"), encoding="utf-8") as f:
                self.assertEqual(f.read(), exp_txt)
            with open(os.path.join(d, "clip_timestamps.txt"), encoding="utf-8") as f:
                self.assertEqual(f.read(), exp_ts)
            with open(os.path.join(d, "clip.srt"), encoding="utf-8") as f:
                srt = f.read()
                self.assertEqual(srt, exp_srt)
        # legacy 절삭 유지 증거: 2.3 → ,299 (반올림 아님). 빈/0길이 cue 도 그대로.
        self.assertIn("00:00:02,299", srt)
        self.assertNotIn("00:00:02,300", srt)
        self.assertEqual(srt.count(" --> "), 3)   # sanitizer 미적용(cue 제거·재번호 없음)

    def test_no_sidecar_or_extra_file_created(self):
        result = _synthetic_result()
        with tempfile.TemporaryDirectory() as d:
            _capture_events(tw._save_transcription, result, "clip.wav", d, True, False, "clip")
            names = sorted(os.listdir(d))
        self.assertEqual(names, ["clip.srt", "clip.txt", "clip_timestamps.txt"])
        # .json 사이드카 등 어떤 canonical 산출물도 없다(영속화 보류).
        self.assertFalse(any(n.endswith(".json") for n in names))


class SidecarEventTest(unittest.TestCase):
    def setUp(self):
        tw._whisper_cache["name"] = "large-v3"

    def _emit(self, result):
        with tempfile.TemporaryDirectory() as d:
            _, events = _capture_events(
                tw._save_transcription, result, "clip.wav", d, False, False, "clip")
        return [e for e in events if e.get("type") == "asrTranscriptSidecar"]

    def test_sidecar_structure(self):
        ev = self._emit(_synthetic_result())
        self.assertEqual(len(ev), 1)
        p = ev[0]
        self.assertEqual(p["schemaVersion"], ac.SCHEMA_VERSION)
        self.assertEqual(p["schema"], ac.SCHEMA_ID)
        self.assertEqual(p["segmentCount"], 3)
        # provenance: 모델·task·게이트 파라미터.
        self.assertEqual(p["provenance"]["model"], "large-v3")
        self.assertEqual(p["provenance"]["task"], "transcribe")
        self.assertIn("rms_threshold", p["provenance"])
        # timing·confidence·status 구조(정렬됨).
        segs = p["segments"]
        starts = [s["start"] for s in segs]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all("confidence" in s and "status" in s for s in segs))
        self.assertTrue(all("start" in s and "end" in s for s in segs))
        # word 타임스탬프 구조는 남기되 본문은 없음.
        w0 = segs[0]["words"][0]
        self.assertIn("start", w0)
        self.assertIn("probability", w0)
        self.assertNotIn("text", w0)
        self.assertNotIn("word", w0)

    def test_sidecar_deterministic(self):
        a = self._emit(_synthetic_result())[0]
        b = self._emit(_synthetic_result())[0]
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False))

    def test_zero_length_segment_survives_ingest(self):
        # 0길이(end==start) 세그먼트가 canonical ingest 를 통과해 sidecar 에 존재.
        p = self._emit(_synthetic_result())[0]
        zero = [s for s in p["segments"] if abs(s["start"] - s["end"]) < 1e-9]
        self.assertTrue(zero)   # production parity: 유효 입력으로 보존

    def test_no_transcript_body_anywhere_in_events(self):
        # 이벤트(sidecar/shadow/error) 어디에도 전사 본문(segment/word text)이 없다.
        result = _synthetic_result()
        with tempfile.TemporaryDirectory() as d:
            _, events = _capture_events(
                tw._save_transcription, result, "clip.wav", d, False, False, "clip")
        blob = json.dumps(events, ensure_ascii=False)
        for body in (CJK_KO, EN_NUM, "안녕하세요", "반갑습니다", "네", "Hello", "world"):
            self.assertNotIn(body, blob, f"본문 유출: {body!r}")


class SidecarFailureIsolationTest(unittest.TestCase):
    def setUp(self):
        tw._whisper_cache["name"] = "large-v3"

    def test_payload_failure_does_not_block_outputs(self):
        result = _synthetic_result()
        orig = tw._asr_sidecar_payload
        tw._asr_sidecar_payload = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom /secret/path.wav"))
        try:
            with tempfile.TemporaryDirectory() as d:
                _, events = _capture_events(
                    tw._save_transcription, result, "clip.wav", d, True, False, "clip")
                # TXT/SRT 는 정상 생성.
                self.assertTrue(os.path.exists(os.path.join(d, "clip.txt")))
                self.assertTrue(os.path.exists(os.path.join(d, "clip.srt")))
        finally:
            tw._asr_sidecar_payload = orig
        err = [e for e in events if e.get("type") == "asrTranscriptSidecarError"]
        self.assertEqual(len(err), 1)
        self.assertEqual(err[0].get("status"), "unavailable")
        # 오류 이벤트에 traceback·경로·예외 메시지 없음.
        blob = json.dumps(err, ensure_ascii=False)
        self.assertNotIn("boom", blob)
        self.assertNotIn("secret", blob)
        self.assertNotIn(".wav", blob)


class SilenceShadowTest(unittest.TestCase):
    def test_shadow_counts_emitted_and_agree(self):
        rms = [0.11, 0.0001, 0.11, 0.12]
        durs = [1.0, 1.0, 1.0, 1.0]
        legacy_raw_kept = sum(1 for r, dd in zip(rms, durs)
                              if dd <= 0 or r >= ac.DEFAULT_RMS_THRESHOLD)  # =3
        ret, events = _capture_events(
            tw._emit_silence_shadow, rms, durs, legacy_raw_kept, ac.DEFAULT_RMS_THRESHOLD)
        self.assertIsNone(ret)   # 관측 전용 — 반환값 없음(결정 미변경)
        ev = [e for e in events if e.get("type") == "asrSilenceShadow"]
        self.assertEqual(len(ev), 1)
        p = ev[0]
        self.assertEqual(p["segmentCount"], 4)
        self.assertEqual(p["legacyKept"], 3)
        self.assertEqual(p["policyKept"], 3)
        self.assertFalse(p["guardTriggered"])
        self.assertTrue(p["agreement"])
        self.assertAlmostEqual(p["thresholdSnapshot"], ac.DEFAULT_RMS_THRESHOLD)

    def test_shadow_guard_parity(self):
        rms = [0.0001] * 8 + [0.11] * 2
        durs = [1.0] * 10
        raw_kept = 2   # 8 무음 drop, 2 유지 → guard(<40%) 발동
        _, events = _capture_events(
            tw._emit_silence_shadow, rms, durs, raw_kept, ac.DEFAULT_RMS_THRESHOLD)
        p = [e for e in events if e.get("type") == "asrSilenceShadow"][0]
        self.assertTrue(p["guardTriggered"])
        self.assertEqual(p["policyKept"], 10)     # 가드 → 전부 유지
        self.assertEqual(p["legacyKept"], 10)
        self.assertTrue(p["agreement"])

    def test_shadow_zero_length_parity(self):
        rms = [None, 0.11, 0.11]
        durs = [0.0, 1.0, 1.0]
        raw_kept = 3   # 0길이 무조건 유지 + 2 발화 유지
        _, events = _capture_events(
            tw._emit_silence_shadow, rms, durs, raw_kept, ac.DEFAULT_RMS_THRESHOLD)
        p = [e for e in events if e.get("type") == "asrSilenceShadow"][0]
        self.assertEqual(p["policyKept"], 3)
        self.assertTrue(p["agreement"])
        self.assertFalse(p["guardTriggered"])

    def test_shadow_does_not_mutate_threshold(self):
        before = ac.DEFAULT_RMS_THRESHOLD
        _capture_events(tw._emit_silence_shadow, [0.1, 0.0001], [1.0, 1.0], 1,
                        ac.DEFAULT_RMS_THRESHOLD)
        self.assertEqual(ac.DEFAULT_RMS_THRESHOLD, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
