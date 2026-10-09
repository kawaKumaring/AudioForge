# -*- coding: utf-8 -*-
"""장문 실행 기록(2026-10-09) — 조각별 발화 글 범위·실제 seed·조각 음원 지문, 실제 배치 행 기준 이음 기록.

모델·GPU 없이 기록기만 본다. 실행: python -X utf8 python/test_run_record_longform.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로
import json
import shutil
import tempfile
import unittest
from unittest import mock

import numpy as np

import chunk_publish
import tts_worker


class SourceRanges(unittest.TestCase):
    def test_조각을_발화_글_안에서_차례로_찾는다(self):
        seg = "첫 문장이다. 둘째 문장이다. 셋째."
        es = [{"original_segment_index": 0, "chunk_index": 0, "text": "첫 문장이다. "},
              {"original_segment_index": 0, "chunk_index": 1, "text": "둘째 문장이다. "},
              {"original_segment_index": 0, "chunk_index": 2, "text": "셋째."}]
        rs = tts_worker._chunk_source_ranges(es, {0: seg})
        self.assertEqual(["".join(seg[a:b]) for a, b in rs], [e["text"] for e in es])

    def test_찾지_못하면_None_추정하지_않는다(self):
        es = [{"original_segment_index": 0, "text": "없는 글"}, {"original_segment_index": 1, "text": "글"}]
        self.assertEqual(tts_worker._chunk_source_ranges(es, {0: "다른 글이다"}), [None, None])


class Recorder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_rr_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.rec = chunk_publish.ChunkRecorder(root=self.tmp)

    def _place(self, starts_lens_gaps, sr=24000):
        for g, (start, n, gap) in enumerate(starts_lens_gaps):
            self.rec.final(g, np.zeros(n, dtype=np.float32), sr, start, gap)

    def test_이음은_실제_배치_행에서_간격_겹침_포함(self):
        sr = 24000
        self._place([(0, 1000, 0), (1000, 500, 0), (1600, 400, 100)], sr)   # 셋째 앞 간격 100
        js = self.rec.build_joins(None, sr)
        self.assertEqual([j["right_start_sample"] for j in js], [1000, 1600])
        self.assertEqual([j["app_gap_samples"] for j in js], [0, 100])
        self.assertEqual([j["overlap_samples"] for j in js], [0, 0])
        self.assertTrue(all(j["basis"] == "final_placement_rows" and "preview" not in j for j in js))

    def test_겹침은_앞_끝이_뒤_시작을_넘은_만큼(self):
        self._place([(0, 1000, 0), (900, 500, 0)])
        self.assertEqual(self.rec.build_joins(None, 24000)[0]["overlap_samples"], 100)

    def test_배치_기록이_없으면_이음을_만들지_않는다(self):
        self.rec.note(0, x=1); self.rec.note(1, x=1)  # noqa: E702
        self.assertEqual(self.rec.build_joins(None, 24000), [])

    def test_결과_파일_표본_수와_마지막_끝을_나란히(self):
        self._place([(0, 1000, 0), (1000, 500, 0)])
        self.rec.result = {"frames": 1620}
        self.assertEqual(self.rec.placement_check(), {"last_chunk_end_sample": 1500, "output_frames": 1620, "after_last_chunk_samples": 120})
        self.rec.result = None
        self.assertIsNone(self.rec.placement_check())

    def test_조각_기록에_seed_범위_지문(self):
        wav = os.path.join(self.tmp, "c0.wav")
        with open(wav, "wb") as f:
            f.write(b"RIFFxxxx")
        es = [{"original_segment_index": 0, "chunk_index": 0, "text": "가나다. ", "out_path": wav, "applied_seed": 12345},
              {"original_segment_index": 0, "chunk_index": 1, "text": "라마.", "out_path": os.path.join(self.tmp, "없음.wav")}]
        with mock.patch.object(tts_worker, "_diag_stage", lambda *a, **k: None):
            tts_worker._run_record_entries(self.rec, es, seg_texts={0: "가나다. 라마."})
        r0, r1 = self.rec.ordered()
        self.assertEqual(r0["applied_seed"], 12345)
        self.assertEqual(r0["source_char_range"], [0, 5])
        self.assertEqual(len(r0["returned_wav_sha256"]), 64)
        self.assertNotIn("applied_seed", r1)              # 없는 값은 채우지 않는다
        self.assertNotIn("returned_wav_sha256", r1)
        self.assertEqual(r1["source_char_range"], [5, 8])


if __name__ == "__main__":
    unittest.main(verbosity=2)
