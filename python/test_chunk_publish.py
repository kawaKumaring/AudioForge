# -*- coding: utf-8 -*-
"""chunk 발행·join preview 계약 — 합성·GPU 0. 합성 파형만 쓴다."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import chunk_publish as cp
import local_assets as la

SR = 24000


def tone(sec, hz=200.0, amp=0.3):
    t = np.arange(int(sec * SR), dtype=np.float32) / SR
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def sil(sec):
    return np.zeros(int(sec * SR), dtype=np.float32)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af-cp-")
        self._e = {k: os.environ.get(k) for k in (cp.ENV, la.LOCAL_ROOT_ENV)}
        os.environ[la.LOCAL_ROOT_ENV] = self.tmp
        os.environ[cp.ENV] = "t-run"

    def tearDown(self):
        for k, v in self._e.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestDisabled(Base):
    def test_no_env_means_no_side_effect(self):
        os.environ.pop(cp.ENV, None)
        r = cp.ChunkRecorder()
        self.assertFalse(r.active)
        r.raw(0, tone(0.1), SR)
        r.aligned(0, tone(0.1), SR)
        r.final(0, tone(0.1), SR, 0, 0)
        self.assertIsNone(r.write("ok"))
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "artifacts", "generated", "t-run")))


class TestPublish(Base):
    def test_three_stages_and_dedup(self):
        r = cp.ChunkRecorder()
        raw = np.concatenate([tone(0.5, 150), tone(0.4, 300)])
        aligned = raw[int(0.5 * SR):]
        r.raw(0, raw, SR)
        r.aligned(0, aligned, SR)
        r.final(0, aligned, SR, 0, 0)          # aligned 와 동일 → 중복 저장 금지
        row = r.ordered()[0]
        self.assertIn("file", row["raw"])
        self.assertIn("file", row["aligned"])
        self.assertEqual(row["final"].get("same_as"), "aligned",
                         "동일 단계인데 WAV 를 중복 저장했다")
        self.assertFalse(os.path.isfile(os.path.join(r.root, "chunks", "chunk-000-final.wav")))

    def test_raw_is_separate_from_aligned_when_different(self):
        r = cp.ChunkRecorder()
        r.raw(0, tone(0.9), SR)
        r.aligned(0, tone(0.4), SR)
        row = r.ordered()[0]
        self.assertNotEqual(row["raw"]["sha256"], row["aligned"]["sha256"])
        for s in ("raw", "aligned"):
            self.assertTrue(os.path.isfile(os.path.join(r.root, row[s]["file"])))

    def test_atomic_no_part_files(self):
        r = cp.ChunkRecorder()
        r.raw(0, tone(0.2), SR)
        r.aligned(0, tone(0.2), SR)
        left = [f for _, _, fs in os.walk(r.root) for f in fs if f.endswith(".part")]
        self.assertEqual(left, [], "temp 파일이 남았다")

    def test_manifest_has_no_text_or_abs_path(self):
        r = cp.ChunkRecorder()
        r.raw(0, tone(0.2), SR)
        r.aligned(0, tone(0.2), SR)
        r.final(0, tone(0.2), SR, 0, 0)
        r.write("ok", final_arr=tone(0.2), sr=SR,
                extra={"text": "비밀 대사", "ttsText": "비밀", "cap": 54})
        blob = open(os.path.join(r.root, "manifest.json"), encoding="utf-8").read()
        self.assertNotIn("비밀", blob, "대사 원문이 manifest 에 들어갔다")
        self.assertNotIn(":\\", blob, "절대경로가 manifest 에 들어갔다")
        self.assertIn('"cap": 54', blob)


class TestJoins(Base):
    def _two_chunks(self, gap_sec):
        r = cp.ChunkRecorder()
        a = np.concatenate([tone(1.0), sil(0.2)])          # tail 무음 0.2s
        b = np.concatenate([sil(0.3), tone(1.0, 260)])      # lead 무음 0.3s
        gap = int(gap_sec * SR)
        final = np.concatenate([a, sil(gap_sec), b]) if gap else np.concatenate([a, b])
        r.raw(0, a, SR); r.aligned(0, a, SR); r.final(0, a, SR, 0, 0)
        r.raw(1, b, SR); r.aligned(1, b, SR)
        r.final(1, b, SR, len(a) + gap, gap, boundary_kind="period")
        return r, final, gap

    def test_join_preview_contains_actual_gap_only(self):
        r, final, gap = self._two_chunks(0.4)
        joins = r.build_joins(final, SR)
        self.assertEqual(len(joins), 1)
        j = joins[0]
        self.assertEqual(j["boundary_kind"], "period")
        self.assertAlmostEqual(j["app_gap_ms"], 400.0, delta=1)
        self.assertAlmostEqual(j["tail_silence_ms"], 200.0, delta=15)
        self.assertAlmostEqual(j["lead_silence_ms"], 300.0, delta=15)
        # 체감 간격 = 생성 tail + 앱 gap + 생성 lead
        self.assertAlmostEqual(j["perceived_gap_ms"], 900.0, delta=30)
        import soundfile as sf
        info = sf.info(os.path.join(r.root, j["preview"]))
        # 앞 1.5s + gap + 뒤 1.5s 인데 chunk 가 그보다 짧으면 있는 만큼만
        self.assertLessEqual(info.duration, 2 * cp.PREVIEW_SIDE_SEC + 0.4 + 0.01)
        self.assertGreater(info.duration, 0.4)

    def test_no_artificial_padding(self):
        r, final, _ = self._two_chunks(0.0)
        j = r.build_joins(final, SR)[0]
        self.assertEqual(j["app_gap_ms"], 0.0)
        self.assertAlmostEqual(j["perceived_gap_ms"], 500.0, delta=30)


class TestBoundaryKinds(unittest.TestCase):
    def test_classification(self):
        f = cp.classify_boundary
        self.assertEqual(f("가나다.", True, 0, False, None), "period")
        self.assertEqual(f("가나다?", True, 0, False, None), "question")
        self.assertEqual(f("가나다!", True, 0, False, None), "exclamation")
        self.assertEqual(f("가나다", True, 0, False, None), "internal_split")
        self.assertEqual(f("가나다.", False, 0, False, None), "line_break")
        self.assertEqual(f("가나다.", False, 1, False, None), "blank_line_paragraph")
        self.assertEqual(f("가나다.", False, 1, True, None), "emotion_change")
        self.assertEqual(f("가나다.", False, 1, True, 300), "explicit_pause")

    def test_kind_vocabulary_is_closed(self):
        for k in ("internal_split", "period", "question", "exclamation",
                  "same_line_sentence", "line_break", "blank_line_paragraph",
                  "emotion_change", "explicit_pause"):
            self.assertIn(k, cp.BOUNDARY_KINDS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
