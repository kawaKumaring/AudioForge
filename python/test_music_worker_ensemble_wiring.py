# -*- coding: utf-8 -*-
"""run_roformer_ensemble P0 무결성 배선 targeted 테스트.

실제 모델·GPU·오디오 파일·audio-separator·외부 API 없음 — 전부 monkeypatch.
합성 numpy `(C, N)` 배열과 모의 I/O(load/save/replace)만 사용한다.

검증 계약:
  - 정합 입력: 기존 0.5/0.5 평균과 dtype·shape·값 바이트 동일 (min slice no-op).
  - sr / channel / frame 불일치: MUSIC_ENSEMBLE_SHAPE_MISMATCH 명시 오류 후 return [].
  - NaN/Inf: MUSIC_ENSEMBLE_NON_FINITE 명시 오류 후 return [].
  - single-model fallback·자동 재시도 없음 (os.replace 는 pb 부재 스템에만, 무결성 실패엔 0).
  - 실패 시 부분 출력 없음 + 기존 산출물 원자 보존 (phase-2 진입 전 중단).
  - 오류 payload 는 고정 화이트리스트 필드만 (경로·샘플·파일명·자유 metrics 없음).

실행:
  python python/test_music_worker_ensemble_wiring.py
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


ALLOWED_ERROR_KEYS = {
    "type", "code", "message", "reason",
    "sampleRateA", "sampleRateB", "channelsA", "channelsB",
    "framesA", "framesB", "finiteA", "finiteB",
}


def _tone(freq=440, sr=8000, dur=0.2, ch=2, amp=0.2, phase=0.0):
    n = int(sr * dur)
    t = np.arange(n) / sr
    sig = (amp * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)
    return np.tile(sig, (ch, 1))


class _Harness:
    """run_roformer_ensemble 를 합성 데이터로 구동하고 emit/save/replace 를 포착.

    a_map / b_map: {"vocals": ndarray|None, "instrumental": ndarray|None}
    파일은 실제 임시 경로에 placeholder 로 만들어 os.path.exists 만 통과시키고,
    실제 배열은 load_audio 모의가 레지스트리에서 돌려준다.
    """

    def __init__(self, a_map, b_map, sr_a=8000, sr_b=8000):
        self.emits = []
        self.saves = []      # (path, ndarray, sr)
        self.replaces = []   # (src, dst)
        self.reg = {}        # path -> (ndarray, sr)
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


class _Base(unittest.TestCase):
    def setUp(self):
        self.out_dir = tempfile.mkdtemp(prefix="af_out_")
        self._root_dir = tempfile.mkdtemp(prefix="af_root_")
        _configure_synth_roots(self._root_dir)
        self._h = None

    def tearDown(self):
        if self._h is not None:
            self._h.cleanup()
        shutil.rmtree(self.out_dir, ignore_errors=True)
        runtime_paths.reset()
        shutil.rmtree(self._root_dir, ignore_errors=True)

    def _run(self, a_map, b_map, **kw):
        self._h = _Harness(a_map, b_map, **kw)
        return self._h.run(self.out_dir)


class MatchedOutputTest(_Base):
    def test_matched_equals_plain_half_half_and_no_fallback(self):
        va, vb = _tone(440), _tone(440, phase=0.5)
        ia, ib = _tone(110), _tone(110, phase=0.9)
        tracks = self._run({"vocals": va, "instrumental": ia},
                           {"vocals": vb, "instrumental": ib})
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(len(tracks), 2)
        # save 2회, replace 0회 (single-model fallback 없음)
        self.assertEqual(len(self._h.saves), 2)
        self.assertEqual(self._h.replaces, [])
        saved = {os.path.basename(p): arr for p, arr, _sr in self._h.saves}
        for base, (a, b) in {"vocals.wav": (va, vb),
                             "instrumental.wav": (ia, ib)}.items():
            expected = (a + b) / 2.0            # min slice no-op 기준선
            got = saved[base]
            self.assertEqual(got.shape, expected.shape)
            self.assertEqual(got.dtype, expected.dtype)
            self.assertTrue(np.array_equal(got, expected))


class ShapeMismatchTest(_Base):
    def _assert_shape_error(self, err):
        self.assertEqual(err["code"], "MUSIC_ENSEMBLE_SHAPE_MISMATCH")
        self.assertLessEqual(set(err.keys()), ALLOWED_ERROR_KEYS)

    def test_sample_rate_mismatch(self):
        v = _tone(440)
        tracks = self._run({"vocals": v.copy(), "instrumental": _tone(110)},
                           {"vocals": v.copy(), "instrumental": _tone(110)},
                           sr_a=8000, sr_b=16000)
        self.assertEqual(tracks, [])
        errs = self._h.error_emits()
        self.assertEqual(len(errs), 1)
        self._assert_shape_error(errs[0])
        self.assertEqual(errs[0]["sampleRateA"], 8000)
        self.assertEqual(errs[0]["sampleRateB"], 16000)
        self.assertEqual(errs[0]["channelsA"], errs[0]["channelsB"])
        self.assertEqual(errs[0]["framesA"], errs[0]["framesB"])
        self.assertEqual(self._h.saves, [])
        self.assertEqual(self._h.replaces, [])

    def test_channel_mismatch(self):
        tracks = self._run(
            {"vocals": _tone(440, ch=2), "instrumental": _tone(110, ch=2)},
            {"vocals": _tone(440, ch=1), "instrumental": _tone(110, ch=1)})
        self.assertEqual(tracks, [])
        errs = self._h.error_emits()
        self.assertEqual(len(errs), 1)
        self._assert_shape_error(errs[0])
        self.assertEqual(errs[0]["channelsA"], 2)
        self.assertEqual(errs[0]["channelsB"], 1)
        self.assertEqual(self._h.saves, [])

    def test_frame_mismatch(self):
        tracks = self._run(
            {"vocals": _tone(440, dur=0.20), "instrumental": _tone(110, dur=0.20)},
            {"vocals": _tone(440, dur=0.25), "instrumental": _tone(110, dur=0.25)})
        self.assertEqual(tracks, [])
        errs = self._h.error_emits()
        self.assertEqual(len(errs), 1)
        self._assert_shape_error(errs[0])
        self.assertNotEqual(errs[0]["framesA"], errs[0]["framesB"])
        self.assertEqual(self._h.saves, [])
        self.assertEqual(self._h.replaces, [])


class NonFiniteTest(_Base):
    def test_nan_surfaces_as_non_finite_error(self):
        bad = _tone(440)
        bad[0, 5] = np.nan
        tracks = self._run({"vocals": bad, "instrumental": _tone(110)},
                           {"vocals": _tone(440), "instrumental": _tone(110)})
        self.assertEqual(tracks, [])
        errs = self._h.error_emits()
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0]["code"], "MUSIC_ENSEMBLE_NON_FINITE")
        self.assertLessEqual(set(errs[0].keys()), ALLOWED_ERROR_KEYS)
        # non-finite 경로도 사용자 표시 message + code 둘 다 존재
        self.assertIsInstance(errs[0].get("message"), str)
        self.assertTrue(errs[0]["message"].strip(), "message는 비어있지 않은 문자열")
        self.assertFalse(errs[0]["finiteA"])
        self.assertTrue(errs[0]["finiteB"])
        self.assertEqual(self._h.saves, [])
        self.assertEqual(self._h.replaces, [])

    def test_inf_in_second_model(self):
        bad = _tone(110)
        bad[1, 3] = np.inf
        tracks = self._run({"vocals": _tone(440), "instrumental": _tone(110)},
                           {"vocals": _tone(440), "instrumental": bad})
        self.assertEqual(tracks, [])
        errs = self._h.error_emits()
        self.assertEqual(errs[0]["code"], "MUSIC_ENSEMBLE_NON_FINITE")
        self.assertTrue(errs[0]["finiteA"])
        self.assertFalse(errs[0]["finiteB"])


class AtomicityTest(_Base):
    def test_no_partial_output_and_existing_preserved_on_failure(self):
        # 기존 산출물(이전 실행 결과)을 output_dir 에 미리 둔다.
        prior = os.path.join(self.out_dir, "vocals.wav")
        with open(prior, "wb") as f:
            f.write(b"PRIOR-RESULT-BYTES")
        # vocals 는 정합(원래라면 기록 대상)이지만 instrumental 이 frame 불일치 →
        # phase-1 에서 중단, phase-2 기록 진입 전. vocals 도 기록되면 안 된다.
        tracks = self._run(
            {"vocals": _tone(440, dur=0.20), "instrumental": _tone(110, dur=0.20)},
            {"vocals": _tone(440, dur=0.20), "instrumental": _tone(110, dur=0.25)})
        self.assertEqual(tracks, [])
        # 부분 출력 없음: save_audio·os.replace 한 번도 호출 안 됨
        self.assertEqual(self._h.saves, [])
        self.assertEqual(self._h.replaces, [])
        # 기존 산출물 원자 보존
        with open(prior, "rb") as f:
            self.assertEqual(f.read(), b"PRIOR-RESULT-BYTES")
        # 새 파일 미생성 (instrumental.wav 없음)
        self.assertFalse(os.path.exists(os.path.join(self.out_dir, "instrumental.wav")))


class PayloadWhitelistTest(_Base):
    def test_error_payload_has_no_sensitive_fields(self):
        tracks = self._run(
            {"vocals": _tone(440, dur=0.20), "instrumental": _tone(110, dur=0.20)},
            {"vocals": _tone(440, dur=0.25), "instrumental": _tone(110, dur=0.25)})
        self.assertEqual(tracks, [])
        err = self._h.error_emits()[0]
        # 화이트리스트 밖 키 없음
        self.assertLessEqual(set(err.keys()), ALLOWED_ERROR_KEYS)
        # 사용자 표시용 message + 구조화 code 둘 다 존재(renderer message+code 계약)
        self.assertIn("message", err)
        self.assertIsInstance(err["message"], str)
        self.assertTrue(err["message"].strip(), "message는 비어있지 않은 문자열")
        self.assertIn("code", err)
        self.assertTrue(str(err["code"]).startswith("MUSIC_ENSEMBLE_"))
        # 값에 경로·파일명·파형/샘플 배열 없음
        for k, v in err.items():
            self.assertNotIsInstance(v, (list, tuple, dict, np.ndarray))
            if isinstance(v, str):
                for token in ("/", "\\", ".wav", ":", "af_stub_", "af_out_"):
                    self.assertNotIn(token, v, f"{k} 값에 민감 토큰 {token!r}")


class MoveBranchTest(_Base):
    def test_single_model_missing_stem_uses_move_not_integrity_fallback(self):
        # b 가 instrumental 스템 자체를 생성하지 못함(=기존 불완전-출력 경로).
        # 무결성 실패가 아니라 pb 부재 → 기존 os.replace(move) 경로. 오류 없음.
        tracks = self._run(
            {"vocals": _tone(440), "instrumental": _tone(110)},
            {"vocals": _tone(440), "instrumental": None})
        self.assertEqual(self._h.error_emits(), [])
        self.assertEqual(len(tracks), 2)
        names = {t["name"] for t in tracks}
        self.assertEqual(names, {"vocals", "instrumental"})
        # vocals 는 두 모델 평균(save), instrumental 은 단일 모델 move(replace)
        self.assertEqual(len(self._h.saves), 1)
        self.assertEqual(len(self._h.replaces), 1)
        self.assertTrue(self._h.saves[0][0].endswith("vocals.wav"))
        self.assertTrue(self._h.replaces[0][1].endswith("instrumental.wav"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
