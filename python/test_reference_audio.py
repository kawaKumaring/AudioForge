# -*- coding: utf-8 -*-
"""참조 음성 분석/판정(2B) 테스트 — 실제 TTS 모델·ffmpeg 설치 없이 통과.

- 분석/판정: 합성 WAV(soundfile+numpy)로 각 issue code를 재현.
- ffmpeg 경로: subprocess.run / find_ffmpeg를 mock(실제 ffmpeg 불필요).
- GPT 게이트: invalid 참조에서 engine.load/Whisper/subprocess가 0회임을 확인(모델 미로딩).
- 전역 monkeypatch/cache는 mock.patch + addCleanup / tearDown에서 원상 복원.

실행:
  python python/test_reference_audio.py
  python -m unittest discover -s python -p "test_reference_audio.py"
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
import reference_audio as ra  # noqa: E402
import tts_worker  # noqa: E402


def _write(path, seconds, sr=24000, channels=1, content="sine",
           amp=0.3, clip_frac=0.0, silence_tail_frac=0.0):
    """합성 WAV 생성. content='sine'|'silence'. clip_frac/silence_tail_frac로 품질 케이스 조성."""
    import numpy as np
    import soundfile as sf
    n = int(round(seconds * sr))
    if content == "silence" or n == 0:
        data = np.zeros(max(n, 0), dtype="float32")
    else:
        t = np.arange(n) / sr
        data = (amp * np.sin(2 * np.pi * 220.0 * t)).astype("float32")
    if silence_tail_frac > 0 and n > 0:
        k = int(n * (1.0 - silence_tail_frac))
        data[k:] = 0.0
    if clip_frac > 0 and n > 0:
        m = max(1, int(n * clip_frac))
        data[:m] = 1.0  # full-scale → 클리핑
    if channels == 2:
        data = np.stack([data, data], axis=1)
    sf.write(path, data, sr)


class FakeCompleted:
    def __init__(self, returncode, stderr=b""):
        self.returncode = returncode
        self.stderr = stderr


class ReferenceAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_ref_test_")
        # 기존 전역 분석 캐시를 스냅샷했다가 종료 후 원상 복원(같은 프로세스 다른 테스트 격리)
        self._orig_cache = dict(ra._analysis_cache)
        ra._analysis_cache.clear()
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.addCleanup(self._restore_cache)

    def _restore_cache(self):
        ra._analysis_cache.clear()
        ra._analysis_cache.update(self._orig_cache)

    def _p(self, name):
        return os.path.join(self.tmp, name)

    def _assess(self, path):
        return ra.assess_reference_file(path, ra.GPTSOVITS_POLICY)

    def _codes(self, issues):
        return [i.code for i in issues]

    # ── 구조적 ─────────────────────────────────────────────────────────
    def test_file_not_found(self):
        a = self._assess(self._p("nope.wav"))
        self.assertFalse(a.valid)
        self.assertIn(ra.FILE_NOT_FOUND, self._codes(a.errors))

    def test_corrupted_wav(self):
        p = self._p("bad.wav")
        with open(p, "wb") as f:
            f.write(b"NOT_A_REAL_WAV_FILE" * 10)
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.DECODE_FAILED, self._codes(a.errors))

    def test_empty_wav(self):
        p = self._p("empty.wav")
        _write(p, 0.0)
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.EMPTY_AUDIO, self._codes(a.errors))

    # ── 길이 정책 (경계 포함) ──────────────────────────────────────────
    def test_normal_8s_mono_valid(self):
        p = self._p("ok8.wav")
        _write(p, 8.0)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")
        self.assertEqual(a.errors, [])
        self.assertEqual(a.warnings, [])
        self.assertTrue(a.analysis.quality_scanned)

    def test_too_short_299(self):
        p = self._p("s299.wav")
        _write(p, 2.99)
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.TOO_SHORT, self._codes(a.errors))

    def test_exactly_3s_valid(self):
        p = self._p("s300.wav")
        _write(p, 3.0)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")
        self.assertAlmostEqual(a.analysis.duration_sec, 3.0, places=4)

    def test_exactly_10s_valid(self):
        p = self._p("s1000.wav")
        _write(p, 10.0)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")
        self.assertAlmostEqual(a.analysis.duration_sec, 10.0, places=4)

    def test_too_long_1001_skips_full_scan(self):
        p = self._p("s1001.wav")
        _write(p, 10.01)
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.TOO_LONG, self._codes(a.errors))
        # TOO_LONG은 품질 전체 스캔을 생략해야 함(수십 분 낭비 방지)
        self.assertFalse(a.analysis.quality_scanned)

    # ── 품질 정책 ──────────────────────────────────────────────────────
    def test_full_silence_near_silent(self):
        p = self._p("sil.wav")
        _write(p, 5.0, content="silence")
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.NEAR_SILENT, self._codes(a.errors))

    def test_half_silence_warning_but_valid(self):
        p = self._p("half.wav")
        _write(p, 8.0, silence_tail_frac=0.5)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")  # 길이 OK, 근무음 아님
        self.assertIn(ra.HIGH_SILENCE_RATIO, self._codes(a.warnings))

    def test_small_clipping_warning(self):
        p = self._p("clip_small.wav")
        _write(p, 8.0, clip_frac=0.002)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")
        self.assertIn(ra.CLIPPING_DETECTED, self._codes(a.warnings))

    def test_severe_clipping_error(self):
        p = self._p("clip_bad.wav")
        _write(p, 8.0, clip_frac=0.06)
        a = self._assess(p)
        self.assertFalse(a.valid)
        self.assertIn(ra.SEVERE_CLIPPING, self._codes(a.errors))

    def test_stereo_warning(self):
        p = self._p("stereo.wav")
        _write(p, 8.0, channels=2)
        a = self._assess(p)
        self.assertTrue(a.valid, f"errors={self._codes(a.errors)}")
        self.assertIn(ra.MULTI_CHANNEL, self._codes(a.warnings))

    # ── 직렬화 ─────────────────────────────────────────────────────────
    def test_json_serializable(self):
        p = self._p("j.wav")
        _write(p, 8.0)
        a = self._assess(p)
        s = json.dumps(a.to_dict(), ensure_ascii=False)
        d = json.loads(s)
        self.assertEqual(d["engine"], "gptsovits")
        self.assertIn("analysis", d)
        self.assertIn("duration_sec", d["analysis"])

    # ── 캐시 ───────────────────────────────────────────────────────────
    def test_cache_reuse_same_file(self):
        p = self._p("cache.wav")
        _write(p, 8.0)
        ra.clear_analysis_cache()
        calls = []
        orig = ra.analyze_reference

        def counting(path, quality_scan=True):
            calls.append((path, quality_scan))
            return orig(path, quality_scan=quality_scan)

        with mock.patch.object(ra, "analyze_reference", counting):
            ra.analyze_reference_cached(p, quality_scan=True)
            ra.analyze_reference_cached(p, quality_scan=True)
        self.assertEqual(len(calls), 1, "동일 파일 재사용 시 1회만 분석")

    def test_cache_invalidated_on_mtime_change(self):
        p = self._p("cache2.wav")
        _write(p, 8.0)
        ra.clear_analysis_cache()
        calls = []
        orig = ra.analyze_reference

        def counting(path, quality_scan=True):
            calls.append(1)
            return orig(path, quality_scan=quality_scan)

        with mock.patch.object(ra, "analyze_reference", counting):
            ra.analyze_reference_cached(p, quality_scan=True)
            st = os.stat(p)
            os.utime(p, (st.st_atime + 100, st.st_mtime + 100))  # mtime 변경
            ra.analyze_reference_cached(p, quality_scan=True)
        self.assertEqual(len(calls), 2, "파일 변경 시 캐시 무효화 → 재분석")

    # ── 스캔 중 예외 → DECODE_FAILED (정상 통과 금지) ──────────────────
    def test_scan_exception_is_decode_failed(self):
        p = self._p("scanfail.wav")
        _write(p, 8.0)  # 메타데이터는 정상, 블록 스캔만 실패시킴
        ra.clear_analysis_cache()
        import soundfile as sf
        with mock.patch.object(sf, "blocks", side_effect=RuntimeError("scan boom")):
            a = ra.assess_reference_file(p, ra.GPTSOVITS_POLICY)
        self.assertFalse(a.valid, "스캔 실패가 valid로 통과하면 안 됨")
        self.assertIn(ra.DECODE_FAILED, self._codes(a.errors))
        self.assertFalse(a.analysis.readable)

    # ── synthesize: 기본 참조 준비 후 감정 참조 준비 실패 시 임시폴더 정리 ──
    def test_synthesize_cleans_tmp_on_emotion_prep_failure(self):
        emo_bad = self._p("bad_emotion.mp3")
        with open(emo_bad, "wb") as f:
            f.write(b"x")
        out = os.path.join(self.tmp, "synout")
        os.makedirs(out, exist_ok=True)
        created = []

        def fake_prepare(path):
            if path == emo_bad:
                raise RuntimeError("emotion prep boom")
            d = tempfile.mkdtemp(prefix="af_syn_default_")
            created.append(d)
            wav = os.path.join(d, "ref.wav")
            _write(wav, 4.0)
            return wav, d

        with mock.patch.object(tts_worker, "_prepare_ref", side_effect=fake_prepare), \
             mock.patch.object(tts_worker, "emit", lambda *a, **k: None):
            with self.assertRaises(RuntimeError):
                tts_worker.synthesize("default_ref", "[기쁨] 문장입니다.", out,
                                      emotion_refs={"happy": emo_bad})

        self.assertTrue(created, "기본 참조 임시폴더가 생성돼야 테스트가 유효")
        for d in created:
            self.assertFalse(os.path.exists(d), "감정 준비 실패 시 기본 임시폴더가 정리돼야 함")

    # ── GPT 게이트: invalid 참조 → 모델 로딩 0회 ───────────────────────
    def test_invalid_ref_blocks_model_loading(self):
        short = self._p("short2s.wav")
        _write(short, 2.0)  # TOO_SHORT
        out = self._p("out.wav")
        eng = tts_worker.GPTSoVITSEngine()

        load_calls, text_calls = [], []
        eng.load = lambda *a, **k: load_calls.append(1)
        # 전사 진입도 없어야 함(assessment가 먼저 차단) — 새 구조화 메서드로 확인
        eng._get_ref_prompt = lambda *a, **k: text_calls.append(1)

        # subprocess.run이 호출되면 즉시 드러나게(assessment가 먼저 막아야 함)
        with mock.patch.object(subprocess, "run",
                               side_effect=AssertionError("subprocess.run 호출됨(모델 로딩)")):
            with self.assertRaises(RuntimeError):
                eng.synthesize_segment("텍스트", short, "default", 1.0, out)

        self.assertEqual(load_calls, [], "invalid 참조에서 load 호출 금지")
        self.assertEqual(text_calls, [], "invalid 참조에서 Whisper 전사 호출 금지")
        self.assertFalse(os.path.exists(out), "출력 생성 금지")


class PrepareRefFfmpegTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_prep_test_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _p(self, name):
        return os.path.join(self.tmp, name)

    def test_wav_passthrough(self):
        p = self._p("ref.wav")
        _write(p, 4.0)
        out, tmp = tts_worker._prepare_ref(p)
        self.assertEqual(out, p)
        self.assertIsNone(tmp)

    def test_missing_input_raises(self):
        with self.assertRaises(RuntimeError):
            tts_worker._prepare_ref(self._p("nope.mp3"))

    def test_non_wav_without_ffmpeg_raises(self):
        mp3 = self._p("in.mp3")
        with open(mp3, "wb") as f:
            f.write(b"fake mp3 bytes")
        with mock.patch.object(tts_worker, "find_ffmpeg", lambda: None):
            with self.assertRaises(RuntimeError):
                tts_worker._prepare_ref(mp3)

    def test_ffmpeg_failure_returncode_raises(self):
        mp3 = self._p("in2.mp3")
        with open(mp3, "wb") as f:
            f.write(b"fake mp3 bytes")
        with mock.patch.object(tts_worker, "find_ffmpeg", lambda: "ffmpeg"), \
             mock.patch.object(subprocess, "run",
                               return_value=FakeCompleted(1, b"ffmpeg boom stderr")):
            with self.assertRaises(RuntimeError) as ctx:
                tts_worker._prepare_ref(mp3)
        self.assertIn("boom", str(ctx.exception))

    def test_ffmpeg_subprocess_exception_cleans_tmp(self):
        mp3 = self._p("in4.mp3")
        with open(mp3, "wb") as f:
            f.write(b"fake mp3 bytes")
        orig_mkdtemp = tempfile.mkdtemp
        made = []

        def rec_mkdtemp(*a, **k):
            d = orig_mkdtemp(*a, **k)
            made.append(d)
            return d

        with mock.patch.object(tts_worker, "find_ffmpeg", lambda: "ffmpeg"), \
             mock.patch.object(tempfile, "mkdtemp", side_effect=rec_mkdtemp), \
             mock.patch.object(subprocess, "run", side_effect=OSError("exec not found")):
            with self.assertRaises(RuntimeError):
                tts_worker._prepare_ref(mp3)
        self.assertTrue(made)
        for d in made:
            self.assertFalse(os.path.exists(d), "subprocess 예외 후 임시폴더 정리")

    def test_ffmpeg_success_mock(self):
        mp3 = self._p("in3.mp3")
        with open(mp3, "wb") as f:
            f.write(b"fake mp3 bytes")

        def fake_run(cmd, capture_output=False, **kw):
            out_path = cmd[-1]
            _write(out_path, 1.0)  # 변환 결과 WAV 생성
            return FakeCompleted(0, b"")

        with mock.patch.object(tts_worker, "find_ffmpeg", lambda: "ffmpeg"), \
             mock.patch.object(subprocess, "run", side_effect=fake_run):
            out, tmp = tts_worker._prepare_ref(mp3)
        try:
            self.assertTrue(os.path.exists(out))
            self.assertGreater(os.path.getsize(out), 0)
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
