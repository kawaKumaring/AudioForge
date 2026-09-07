"""낱말 경계 구간 선택 계약 — 꽉 찬 음원을 열어 주되 '말 도중 자르기'는 그대로 막는다.

이 시험이 지키는 것은 두 문장이다.
  1) 무음이 0.2초 이상 이어지지 않는 음원도 참조 구간을 고를 수 있다.
  2) 그 완화가 안전 검사를 무력화하지 않는다 — 낱말 시각이 틀리면 여전히 차단된다.

두 번째가 이 파일의 존재 이유다. 첫 번째만 지키는 구현은 '전부 통과' 로도 만들 수 있다.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import soundfile as sf

import reference_region as rr
import reference_word_boundary as wb

SR = 24000
WORD_SEC = 0.45
LEAD_SEC = 0.6


def make_speech(gap_sec, n_words=40):
    """말토막 0.45초 + 틈 gap 초를 n번. (오디오, 정확한 낱말 시각) 을 함께 돌려준다.

    합성으로 만드는 이유: 낱말 시각의 '정답'을 아는 상태여야 틀린 시각을 넣은 경우와
    비교할 수 있다. 실제 전사기를 쓰면 정답이 없어 두 번째 문장을 시험할 수 없다."""
    rng = np.random.default_rng(7)
    parts = [np.zeros(int(SR * LEAD_SEC))]
    words = []
    cur = LEAD_SEC
    for _ in range(n_words):
        t = np.arange(int(SR * WORD_SEC)) / SR
        f0 = 120 + 20 * np.sin(2 * np.pi * 3 * t)
        s = 0.5 * np.sin(2 * np.pi * np.cumsum(f0) / SR) * (0.6 + 0.4 * np.sin(2 * np.pi * 7 * t))
        s *= np.minimum(1, np.minimum(t / 0.02, (WORD_SEC - t) / 0.02))
        parts.append(s)
        words.append((round(cur, 4), round(cur + WORD_SEC, 4)))
        cur += WORD_SEC
        parts.append(rng.normal(0, 1e-5, int(SR * gap_sec)))
        cur += gap_sec
    parts.append(np.zeros(int(SR * LEAD_SEC)))
    return np.concatenate(parts), words


def build(gap_sec, word_shift=0.0, n_words=40, req=(3.0, 7.0)):
    d = tempfile.mkdtemp()
    src = os.path.join(d, "src.wav")
    audio, words = make_speech(gap_sec, n_words)
    sf.write(src, audio, SR)
    shifted = [(round(a + word_shift, 4), round(b + word_shift, 4)) for a, b in words]

    def words_fn(_path, start, dur):
        return {"status": "ok",
                "words": [w for w in shifted if w[0] >= start - 1e-9 and w[1] <= start + dur + 1e-9]}

    return rr.build_reference_clip(
        src, req[0], req[1], os.path.join(d, "clip.wav"),
        transcribe_fn=lambda p: "가나다라마",
        transcribe_words_fn=words_fn, min_sec=3.0, max_sec=10.0)


class WordGapCandidates(unittest.TestCase):
    def test_gaps_between_words(self):
        gaps = wb.word_gaps([{"start": 0, "end": 0.4}, {"start": 0.5, "end": 0.9},
                             {"start": 0.92, "end": 1.3}, {"start": 1.5, "end": 1.9}])
        self.assertEqual(gaps, [(0.4, 0.5), (1.3, 1.5)])   # 0.02초 틈은 하한 미달로 버린다

    def test_overlapping_words_merge(self):
        # 전사기가 겹치는 시각을 줄 수 있다 — 겹침을 틈으로 착각하면 말 도중을 자른다.
        self.assertEqual(wb.word_gaps([{"start": 0, "end": 0.5}, {"start": 0.3, "end": 0.8},
                                       {"start": 1.0, "end": 1.4}]), [(0.8, 1.0)])

    def test_bad_entries_dropped(self):
        self.assertEqual(wb.word_gaps([{"start": 0, "end": 0.4}, {"start": "x", "end": 1},
                                       {"start": 2.0, "end": 1.0}, {"start": 1.0, "end": 1.4}]),
                         [(0.4, 1.0)])

    def test_coarse_timestamps_rejected(self):
        coarse = [{"start": i * 0.5, "end": i * 0.5 + 0.5} for i in range(8)]
        self.assertTrue(wb.coarse_word_timestamps(coarse))
        fine = [{"start": i * 0.5 + 0.03, "end": i * 0.5 + 0.44} for i in range(8)]
        self.assertFalse(wb.coarse_word_timestamps(fine))

    def test_too_few_words_is_not_coarse(self):
        # 낱말 두세 개로는 '전부 배수' 가 우연히 참이 된다 — 판정하지 않는다.
        self.assertFalse(wb.coarse_word_timestamps([{"start": 0.0, "end": 0.5},
                                                    {"start": 1.0, "end": 1.5}]))

    def test_pad_and_window(self):
        gaps = [(0.4, 0.5), (1.3, 1.7)]
        self.assertEqual(wb.pad_at(gaps, 0.45), 0.05)
        self.assertEqual(wb.pad_at(gaps, 1.5), 0.2)
        self.assertEqual(wb.pad_at(gaps, 3.0), 0.0)
        # 창은 여백에서 margin 을 뺀 값, 하한 0.03초, 상한은 넘긴 표준 창
        self.assertEqual(wb.edge_window_sec(0.05, max_window_sec=0.12), 0.03)
        self.assertEqual(wb.edge_window_sec(0.20, max_window_sec=0.12), 0.12)
        self.assertEqual(wb.edge_window_sec(0.12, max_window_sec=0.12), 0.10)


class PackedAudioOpens(unittest.TestCase):
    """무음이 0.2초 이상 없어 예전에는 전부 막혔던 경우."""

    def test_packed_gaps_now_pass(self):
        for gap in (0.06, 0.10, 0.16, 0.20):
            res = build(gap)
            with self.subTest(gap=gap):
                self.assertEqual(res["blocking"], [], "틈 {0}초가 막혔다".format(gap))
                self.assertTrue(res["ready"])
                self.assertTrue(res["word_boundary"]["used"])
                self.assertIn(wb.WARN_WORD_BOUNDARY_USED, res["warning_codes"])
                self.assertFalse(res["boundary"]["head_truncated"])
                self.assertFalse(res["boundary"]["tail_truncated"])

    def test_gap_below_floor_still_blocked(self):
        # 0.06초 미만은 경계 검사 창의 하한(0.03초 × 2)도 못 채운다 — 막는 것이 맞다.
        res = build(0.04)
        self.assertNotEqual(res["blocking"], [])
        self.assertIsNone(res["clip_path"])

    def test_silence_inserted_at_boundary(self):
        res = build(0.10)
        clip = res["clip_path"]
        self.assertIsNotNone(clip)
        d, sr = sf.read(clip, dtype="float64", always_2d=False)
        n = int(sr * rr.PAD_TARGET_SEC * 0.8)
        self.assertLess(float(np.max(np.abs(d[:n]))), 1e-3, "앞 경계가 무음이어야 한다")
        self.assertLess(float(np.max(np.abs(d[-n:]))), 1e-3, "뒤 경계가 무음이어야 한다")
        # 삽입한 무음이 길이 보고에 반영된다
        self.assertAlmostEqual(res["word_boundary"]["clip_duration_sec"],
                               res["effective_region"]["dur_sec"] + 2 * rr.PAD_TARGET_SEC, places=2)

    def test_padded_clip_passes_standard_boundary_check(self):
        # 무음을 넣은 최종 클립은 다른 경로가 쓰는 표준 창(0.12초)으로도 통과해야 한다.
        import reference_leakage as rl
        res = build(0.10)
        mono, sr = sf.read(res["clip_path"], dtype="float64", always_2d=False)
        b = rl.boundary_truncation(np.asarray(mono), sr)
        self.assertFalse(b["head_truncated"])
        self.assertFalse(b["tail_truncated"])


class SafetyNotWeakened(unittest.TestCase):
    """완화가 검사를 무력화하지 않는다 — 이 파일의 존재 이유."""

    def test_wrong_word_times_are_blocked(self):
        # 낱말 시각을 0.25초 밀면 '틈' 이 말 한가운데를 가리킨다.
        # 통과하면 참조에 반토막 낱말이 섞인다.
        res = build(0.10, word_shift=0.25)
        first = res["blocking"][0] if res["blocking"] else ""
        self.assertIn(first, (rr.BLOCK_HEAD_TRUNCATED, rr.BLOCK_TAIL_TRUNCATED),
                      "틀린 낱말 시각이 통과했다: {0} boundary={1}".format(
                          res["blocking"], res.get("boundary")))
        self.assertIsNone(res["clip_path"])

    def test_coarse_word_times_not_used(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "src.wav")
        audio, _ = make_speech(0.10)
        sf.write(src, audio, SR)
        res = rr.build_reference_clip(
            src, 3.0, 7.0, os.path.join(d, "clip.wav"),
            transcribe_fn=lambda p: "가나다라마",
            transcribe_words_fn=lambda p, a, dur: {
                "status": "ok", "words": [(i * 0.5, i * 0.5 + 0.5) for i in range(6, 30)]},
            min_sec=3.0, max_sec=10.0)
        self.assertNotEqual(res["blocking"], [])
        self.assertEqual(res["word_boundary"]["reason"], wb.BLOCK_COARSE_WORD_TIMES)

    def test_transcribe_failure_keeps_original_block(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, "src.wav")
        audio, _ = make_speech(0.10)
        sf.write(src, audio, SR)
        res = rr.build_reference_clip(
            src, 3.0, 7.0, os.path.join(d, "clip.wav"),
            transcribe_fn=lambda p: "가나다라마",
            transcribe_words_fn=lambda p, a, dur: {"status": "failed", "words": [],
                                                   "error_code": "TRANSCRIPTION_FAILED"},
            min_sec=3.0, max_sec=10.0)
        self.assertEqual(res["blocking"], [rr.BLOCK_SNAP_UNSATISFIABLE])
        self.assertFalse(res["word_boundary"]["used"])

    def test_silence_path_unchanged_when_silence_is_ample(self):
        # 이미 잘 되던 파일(넉넉한 무음)은 낱말 경로를 타지 않고 무음도 삽입되지 않는다.
        res = build(0.40)
        self.assertEqual(res["blocking"], [])
        self.assertNotIn("word_boundary", res)
        self.assertNotIn(wb.WARN_WORD_BOUNDARY_USED, res["warning_codes"])

    def test_thin_silence_margin_widened(self):
        # 0.24초 무음은 예전에 꼬리가 -40.92dBFS(임계 -40.0)로 아슬아슬하게 통과했다.
        # 창을 여백 안쪽으로 맞춘 뒤로는 여유가 커야 한다.
        res = build(0.24)
        self.assertEqual(res["blocking"], [])
        self.assertLess(res["boundary"]["tail_dbfs"], -60.0,
                        "꼬리 여유가 아직 좁다: {0}".format(res["boundary"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
