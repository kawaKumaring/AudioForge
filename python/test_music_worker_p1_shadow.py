# -*- coding: utf-8 -*-
"""run_roformer_ensemble P1 shadow 배선 targeted 테스트.

실제 모델·GPU·오디오 파일·audio-separator·외부 API 없음 — 전부 monkeypatch.
합성 numpy `(C, N)` 배열과 모의 I/O(load/save/replace)만 사용한다.

검증 계약(coordinator 결정 반영):
  - off(env 미설정): 출력 완전 불변, music_p1_shadow emit 0.
  - shadow: 기존 0.5/0.5 결과만 저장(후보 미저장), 스템별 진단 수치 emit.
  - 미개선(정합) 입력: candidateEligible=False, 저장은 기존 평균 그대로.
  - shadow 계산 실패: 안전 진단 상태(P1_SHADOW_ERROR), 기존 음악 출력 유지.
  - "on"/잘못된 env 값: MUSIC_P1_NOT_CALIBRATED 명시(조용한 shadow 강등 금지),
    출력 불변.
  - shadow payload 는 고정 화이트리스트 수치만 (경로·샘플·파형·모델 로컬명 0).

실행: python python/test_music_worker_p1_shadow.py
"""
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import music_worker  # noqa: E402
import runtime_paths  # noqa: E402


def _configure_synth_roots(base):
    """separator_models 경로가 주입된 modelRoot 밑에서 해석되도록 synthetic managed root를 심는다.
    (roots 주입 계약: separate.py가 실행 시 하는 일을 테스트에서 재현.)"""
    runtime_paths.reset()
    runtime_paths.set_path_resolver(None)
    runtime_paths.configure({
        "schemaVersion": 2,
        "runtimeRoot": {"path": os.path.join(base, "rt"), "ownership": "audioforge-managed"},
        "modelRoot": {"path": os.path.join(base, "md"), "ownership": "audioforge-managed"},
        "cacheRoot": {"path": os.path.join(base, "ch"), "ownership": "audioforge-managed"},
    })


SHADOW_KEYS = {
    "type", "status", "offsetFrames", "polarity", "gain",
    "baselineError", "candidateError", "improvement",
    "candidateEligible", "elapsedMs",
}


def _tone(freq=440, sr=8000, dur=0.25, ch=2, amp=0.2, phase=0.0):
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


class _Harness:
    def __init__(self, a_map, b_map, sr_a=8000, sr_b=8000):
        self.emits = []
        self.saves = []
        self.replaces = []
        self.reg = {}
        self._tmpdirs = []
        self._a_out = self._materialize(a_map, sr_a)
        self._b_out = self._materialize(b_map, sr_b)

    def _materialize(self, which, sr):
        dd = tempfile.mkdtemp(prefix="af_stub_")
        self._tmpdirs.append(dd)
        out = {}
        for stem, arr in which.items():
            if arr is None:
                continue
            p = os.path.join(dd, f"{stem}.wav")
            with open(p, "wb") as f:
                f.write(b"stub")
            self.reg[p] = (arr, sr)
            out[stem] = p
        return out

    def _fake_run_one(self, model_name, wav_input, model_dir, work_dir, lo, hi):
        return dict(self._a_out if model_name == music_worker._ROFORMER_MODEL
                    else self._b_out)

    def _fake_load(self, path):
        return self.reg[path]

    def run(self, output_dir):
        def _emit(t, **k):
            self.emits.append({"type": t, **k})

        def _conv(_p):
            return os.path.join(tempfile.mkdtemp(prefix="af_in_"), "in.wav")

        with mock.patch.object(music_worker, "emit", _emit), \
             mock.patch.object(music_worker, "convert_to_wav", _conv), \
             mock.patch.object(music_worker, "_run_one_roformer", self._fake_run_one), \
             mock.patch.object(music_worker, "load_audio", self._fake_load), \
             mock.patch.object(music_worker, "save_audio",
                               lambda p, a, sr: self.saves.append((p, a, sr))), \
             mock.patch("os.makedirs", lambda *a, **k: None), \
             mock.patch("os.replace", lambda s, d: self.replaces.append((s, d))), \
             mock.patch.dict(sys.modules, {"audio_separator": mock.MagicMock()}):
            return music_worker.run_roformer_ensemble("dummy_input.wav", output_dir)

    def cleanup(self):
        for d in self._tmpdirs:
            shutil.rmtree(d, ignore_errors=True)

    def error_emits(self):
        return [e for e in self.emits if e["type"] == "error"]

    def shadow_emits(self):
        return [e for e in self.emits if e["type"] == "music_p1_shadow"]


class _Base(unittest.TestCase):
    def setUp(self):
        self.out_dir = tempfile.mkdtemp(prefix="af_out_")
        self._root_dir = tempfile.mkdtemp(prefix="af_root_")
        _configure_synth_roots(self._root_dir)
        self._h = None
        self._prev_env = os.environ.get(music_worker._P1_ENV)
        os.environ.pop(music_worker._P1_ENV, None)

    def tearDown(self):
        if self._h is not None:
            self._h.cleanup()
        shutil.rmtree(self.out_dir, ignore_errors=True)
        runtime_paths.reset()
        shutil.rmtree(self._root_dir, ignore_errors=True)
        if self._prev_env is None:
            os.environ.pop(music_worker._P1_ENV, None)
        else:
            os.environ[music_worker._P1_ENV] = self._prev_env

    def _set_mode(self, value):
        if value is None:
            os.environ.pop(music_worker._P1_ENV, None)
        else:
            os.environ[music_worker._P1_ENV] = value

    def _run(self, a_map, b_map, **kw):
        self._h = _Harness(a_map, b_map, **kw)
        return self._h.run(self.out_dir)

    def _matched_pair(self):
        va, vb = _tone(440), _tone(440, phase=0.03)
        ia, ib = _tone(110), _tone(110, phase=0.05)
        return ({"vocals": va, "instrumental": ia},
                {"vocals": vb, "instrumental": ib}, va, vb, ia, ib)


class OffModeUnchangedTest(_Base):
    def test_off_output_identical_and_no_shadow_emit(self):
        self._set_mode(None)  # 미설정 = off
        a, b, va, vb, ia, ib = self._matched_pair()
        tracks = self._run(a, b)
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(self._h.shadow_emits(), [])   # 진단 emit 없음
        self.assertEqual(len(tracks), 2)
        self.assertEqual(len(self._h.saves), 2)
        self.assertEqual(self._h.replaces, [])
        saved = {os.path.basename(p): arr for p, arr, _ in self._h.saves}
        for base, (x, y) in {"vocals.wav": (va, vb),
                             "instrumental.wav": (ia, ib)}.items():
            expected = (x + y) / 2.0
            got = saved[base]
            self.assertEqual(got.shape, expected.shape)
            self.assertEqual(got.dtype, expected.dtype)
            self.assertTrue(np.array_equal(got, expected))

    def test_off_explicit_value(self):
        self._set_mode("off")
        a, b, *_ = self._matched_pair()
        self._run(a, b)
        self.assertEqual(self._h.shadow_emits(), [])


class ShadowOutputUnchangedTest(_Base):
    def test_shadow_saves_plain_average_and_emits_metrics(self):
        self._set_mode("shadow")
        a, b, va, vb, ia, ib = self._matched_pair()
        tracks = self._run(a, b)
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(len(tracks), 2)
        # 출력은 기존 0.5/0.5 그대로(후보 미저장)
        self.assertEqual(len(self._h.saves), 2)
        self.assertEqual(self._h.replaces, [])
        saved = {os.path.basename(p): arr for p, arr, _ in self._h.saves}
        for base, (x, y) in {"vocals.wav": (va, vb),
                             "instrumental.wav": (ia, ib)}.items():
            expected = (x + y) / 2.0
            self.assertTrue(np.array_equal(saved[base], expected))
        # 스템 2개 → 진단 emit 2개, status OK
        sh = self._h.shadow_emits()
        self.assertEqual(len(sh), 2)
        for e in sh:
            self.assertEqual(e["status"], "OK")
            self.assertIn("offsetFrames", e)
            self.assertIn("baselineError", e)
            self.assertIn("candidateError", e)
            self.assertIn("improvement", e)
            self.assertIn("candidateEligible", e)
            self.assertIn("elapsedMs", e)

    def test_matched_input_candidate_not_eligible(self):
        # 완전 정합(동일 위상, offset 0) → 개선 없음 → candidateEligible False
        self._set_mode("shadow")
        v = _tone(440)
        i = _tone(110)
        self._run({"vocals": v.copy(), "instrumental": i.copy()},
                  {"vocals": v.copy(), "instrumental": i.copy()})
        sh = self._h.shadow_emits()
        self.assertEqual(len(sh), 2)
        for e in sh:
            self.assertEqual(e["status"], "OK")
            self.assertFalse(e["candidateEligible"])
            self.assertEqual(e["offsetFrames"], 0)
            self.assertEqual(e["polarity"], 1)


class ShadowEligibleTest(_Base):
    def test_offset_makes_candidate_eligible_without_changing_output(self):
        self._set_mode("shadow")
        sr = 8000
        va = _tone(300, sr=sr, dur=0.5)
        base_b = _tone(300, sr=sr, dur=0.5)
        shift = 10
        vb = np.zeros_like(base_b)
        vb[:, shift:] = base_b[:, :-shift]     # b 를 10샘플 지연
        ia = _tone(110, sr=sr, dur=0.5)
        ib = _tone(110, sr=sr, dur=0.5)
        self._run({"vocals": va, "instrumental": ia},
                  {"vocals": vb, "instrumental": ib})
        self.assertEqual(self._h.error_emits(), [])
        # 출력은 여전히 기존 0.5/0.5 (shadow 는 저장을 바꾸지 않음)
        saved = {os.path.basename(p): arr for p, arr, _ in self._h.saves}
        self.assertTrue(np.array_equal(saved["vocals.wav"], (va + vb) / 2.0))
        sh = {e_stem: e for e_stem, e in
              zip(["vocals", "instrumental"], self._h.shadow_emits())}
        # vocals 는 offset 존재 → eligible True, improvement > 0
        self.assertTrue(sh["vocals"]["candidateEligible"])
        self.assertNotEqual(sh["vocals"]["offsetFrames"], 0)
        self.assertGreater(sh["vocals"]["improvement"], 0.0)
        # instrumental 은 정합 → eligible False
        self.assertFalse(sh["instrumental"]["candidateEligible"])


class ShadowFailureIsolationTest(_Base):
    def test_shadow_compute_failure_does_not_block_music_output(self):
        self._set_mode("shadow")
        a, b, va, vb, ia, ib = self._matched_pair()
        # align_pair 가 예외를 던지도록 강제 → 진단 실패로 격리되어야 함
        import music_quality_p1
        with mock.patch.object(music_quality_p1, "align_pair",
                               side_effect=RuntimeError("boom")):
            tracks = self._run(a, b)
        # 음악 출력은 정상 유지
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(len(tracks), 2)
        self.assertEqual(len(self._h.saves), 2)
        saved = {os.path.basename(p): arr for p, arr, _ in self._h.saves}
        self.assertTrue(np.array_equal(saved["vocals.wav"], (va + vb) / 2.0))
        # 진단은 안전 상태로 emit
        sh = self._h.shadow_emits()
        self.assertTrue(sh)
        for e in sh:
            self.assertEqual(e["status"], "P1_SHADOW_ERROR")
            self.assertFalse(e["candidateEligible"])


class NotCalibratedTest(_Base):
    def _assert_not_calibrated_unchanged(self, a, b, va, vb, ia, ib):
        tracks = self._run(a, b)
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(len(tracks), 2)
        saved = {os.path.basename(p): arr for p, arr, _ in self._h.saves}
        self.assertTrue(np.array_equal(saved["vocals.wav"], (va + vb) / 2.0))
        self.assertTrue(np.array_equal(saved["instrumental.wav"], (ia + ib) / 2.0))
        sh = self._h.shadow_emits()
        self.assertEqual(len(sh), 1)   # 1회만 명시
        self.assertEqual(sh[0]["status"], "MUSIC_P1_NOT_CALIBRATED")
        self.assertFalse(sh[0]["candidateEligible"])

    def test_on_value_reports_not_calibrated(self):
        self._set_mode("on")
        a, b, va, vb, ia, ib = self._matched_pair()
        self._assert_not_calibrated_unchanged(a, b, va, vb, ia, ib)

    def test_bogus_value_reports_not_calibrated(self):
        self._set_mode("ENABLE_PLEASE")
        a, b, va, vb, ia, ib = self._matched_pair()
        self._assert_not_calibrated_unchanged(a, b, va, vb, ia, ib)


class ShadowPayloadWhitelistTest(_Base):
    def test_shadow_payload_has_no_sensitive_fields(self):
        self._set_mode("shadow")
        a, b, *_ = self._matched_pair()
        self._run(a, b)
        for e in self._h.shadow_emits():
            self.assertLessEqual(set(e.keys()), SHADOW_KEYS)
            for k, v in e.items():
                # 수치·상태만 — 배열/컨테이너 금지
                self.assertNotIsInstance(v, (list, tuple, dict, np.ndarray))
                if isinstance(v, str):
                    for token in ("/", "\\", ".wav", ":", "af_stub_", "af_out_",
                                  "roformer", "mel_band", ".ckpt"):
                        self.assertNotIn(token, v.lower(),
                                         f"{k} 값에 민감 토큰 {token!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
