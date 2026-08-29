# -*- coding: utf-8 -*-
"""dialogue_canonical 단위 테스트 — 합성 타임라인만(실제 음성·모델 없음).

검증 불변식:
  구간 유효성 / posterior 정규화 / 상태(OK·REVIEW·UNKNOWN) / overlap 다중 라벨 /
  500ms 미만 backchannel 보존 / 결정적 직렬화(정렬·고정 소수·재현) /
  RTTM·CTM 형식 / 프레임→세그먼트 빌더 / 단어 부착 / round-trip.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dialogue_canonical as dc


class PosteriorTest(unittest.TestCase):
    def test_normalize_sums_to_one(self):
        norm = dc.normalize_posterior({"A": 3.0, "B": 1.0})
        self.assertAlmostEqual(sum(norm.values()), 1.0)
        self.assertAlmostEqual(norm["A"], 0.75)

    def test_normalize_clamps_negative(self):
        norm = dc.normalize_posterior({"A": 2.0, "B": -1.0})
        self.assertEqual(norm["B"], 0.0)
        self.assertAlmostEqual(norm["A"], 1.0)

    def test_normalize_empty_and_zero(self):
        self.assertEqual(dc.normalize_posterior({}), {})
        self.assertEqual(dc.normalize_posterior({"A": 0.0, "B": 0.0}), {})


class StatusTest(unittest.TestCase):
    def test_empty_posterior_is_unknown(self):
        self.assertEqual(dc.classify_status(0.99, {}), dc.SegmentStatus.UNKNOWN)

    def test_thresholds(self):
        post = {"A": 1.0}
        self.assertEqual(dc.classify_status(0.10, post), dc.SegmentStatus.UNKNOWN)
        self.assertEqual(dc.classify_status(0.40, post), dc.SegmentStatus.REVIEW)
        self.assertEqual(dc.classify_status(0.90, post), dc.SegmentStatus.OK)


class SegmentValidityTest(unittest.TestCase):
    def test_negative_start_rejected(self):
        with self.assertRaises(ValueError):
            dc.DialogueSegment(start=-0.1, end=1.0)

    def test_end_before_start_rejected(self):
        with self.assertRaises(ValueError):
            dc.DialogueSegment(start=2.0, end=1.0)

    def test_duration_and_primary(self):
        seg = dc.make_segment(1.0, 2.5, posterior={"A": 0.8, "B": 0.2})
        self.assertAlmostEqual(seg.duration, 1.5)
        self.assertEqual(seg.primary_speaker(), "A")

    def test_primary_tie_is_lexicographic(self):
        seg = dc.make_segment(0.0, 1.0, posterior={"B": 0.5, "A": 0.5})
        self.assertEqual(seg.primary_speaker(), "A")


class BackchannelTest(unittest.TestCase):
    def test_short_segment_flagged(self):
        seg = dc.make_segment(0.0, 0.3, posterior={"A": 1.0})  # 300ms
        self.assertTrue(seg.is_backchannel)

    def test_boundary_500ms_is_not_backchannel(self):
        seg = dc.make_segment(0.0, 0.5, posterior={"A": 1.0})  # 정확히 500ms
        self.assertFalse(seg.is_backchannel)

    def test_backchannel_preserved_in_frame_builder(self):
        # A(1.0s) → B(0.2s backchannel) → A(1.0s), 100Hz
        fr = 100
        labels = [0] * 100 + [1] * 20 + [0] * 100
        segs = dc.build_segments_from_frames(labels, fr, ["화자 A", "화자 B"])
        # 3개 세그먼트 전부 보존 — 짧은 B 가 사라지지 않는다.
        self.assertEqual(len(segs), 3)
        self.assertEqual(dc.count_backchannels(segs), 1)
        mid = segs[1]
        self.assertTrue(mid.is_backchannel)
        self.assertEqual(mid.speakers, ("화자 B",))
        self.assertAlmostEqual(mid.duration, 0.2, places=6)


class OverlapTest(unittest.TestCase):
    def test_overlap_multi_label_from_posterior(self):
        seg = dc.make_segment(0.0, 1.0, posterior={"A": 0.55, "B": 0.45})
        self.assertTrue(seg.is_overlap)
        self.assertEqual(set(seg.speakers), {"A", "B"})
        self.assertEqual(seg.speakers[0], "A")  # 최상위 먼저

    def test_no_overlap_when_second_below_threshold(self):
        seg = dc.make_segment(0.0, 1.0, posterior={"A": 0.9, "B": 0.1})
        self.assertFalse(seg.is_overlap)
        self.assertEqual(seg.speakers, ("A",))

    def test_frame_builder_detects_overlap(self):
        fr = 100
        labels = [0] * 50
        # 두 화자가 팽팽한 구간 → overlap 다중 라벨.
        posts = [[0.5, 0.5]] * 50
        segs = dc.build_segments_from_frames(labels, fr, ["A", "B"], frame_posteriors=posts)
        self.assertEqual(len(segs), 1)
        self.assertTrue(segs[0].is_overlap)


class DeterministicSerializationTest(unittest.TestCase):
    def _sidecar(self):
        segs = [
            dc.make_segment(2.0, 3.0, posterior={"B": 1.0}),
            dc.make_segment(0.0, 1.0, posterior={"A": 0.7, "B": 0.3}),
            dc.make_segment(1.0, 1.2, posterior={"A": 1.0}),  # backchannel
        ]
        return dc.CanonicalSidecar(segments=segs, source={"z": "1", "a": "2"})

    def test_segments_sorted_by_time(self):
        sc = self._sidecar()
        starts = [s["start"] for s in sc.to_dict()["segments"]]
        self.assertEqual(starts, sorted(starts))

    def test_byte_identical_across_calls(self):
        sc = self._sidecar()
        self.assertEqual(sc.to_json(), sc.to_json())

    def test_insertion_order_independent(self):
        segs = [
            dc.make_segment(0.0, 1.0, posterior={"A": 1.0}),
            dc.make_segment(1.0, 2.0, posterior={"B": 1.0}),
        ]
        a = dc.CanonicalSidecar(segments=list(segs)).to_json()
        b = dc.CanonicalSidecar(segments=list(reversed(segs))).to_json()
        self.assertEqual(a, b)

    def test_schema_version_present(self):
        d = self._sidecar().to_dict()
        self.assertEqual(d["schema_version"], dc.SCHEMA_VERSION)
        self.assertEqual(d["schema"], dc.SCHEMA_ID)

    def test_fixed_decimals(self):
        seg = dc.make_segment(0.123456789, 1.0, posterior={"A": 1.0 / 3.0})
        d = seg.to_dict()
        self.assertEqual(d["start"], round(0.123456789, dc.TIME_DECIMALS))
        # posterior 정규화되어 단일 화자는 1.0
        self.assertEqual(d["posterior"]["A"], 1.0)

    def test_round_trip_json(self):
        sc = self._sidecar()
        again = dc.CanonicalSidecar.from_json(sc.to_json())
        self.assertEqual(sc.to_json(), again.to_json())

    def test_speakers_aggregated_sorted(self):
        sc = self._sidecar()
        self.assertEqual(sc.all_speakers(), ["A", "B"])


class RttmTest(unittest.TestCase):
    def test_overlap_emits_two_lines(self):
        sc = dc.CanonicalSidecar(segments=[
            dc.make_segment(0.0, 1.0, posterior={"A": 0.5, "B": 0.5}),
        ])
        rttm = sc.to_rttm(uri="clip")
        lines = rttm.strip().split("\n")
        self.assertEqual(len(lines), 2)
        for ln in lines:
            f = ln.split()
            self.assertEqual(f[0], "SPEAKER")
            self.assertEqual(f[1], "clip")
            self.assertEqual(f[3], "0.000")
            self.assertEqual(f[4], "1.000")

    def test_unknown_segment_emits_no_line(self):
        sc = dc.CanonicalSidecar(segments=[
            dc.DialogueSegment(start=0.0, end=1.0),  # 화자 없음
        ])
        self.assertEqual(sc.to_rttm(), "")

    def test_rttm_deterministic(self):
        sc = dc.CanonicalSidecar(segments=[
            dc.make_segment(1.0, 2.0, posterior={"B": 1.0}),
            dc.make_segment(0.0, 1.0, posterior={"A": 1.0}),
        ])
        self.assertEqual(sc.to_rttm(), sc.to_rttm())
        self.assertTrue(sc.to_rttm().index("0.000") < sc.to_rttm().index("1.000"))


class CtmWordTest(unittest.TestCase):
    def test_attach_by_center(self):
        segs = [
            dc.make_segment(0.0, 1.0, posterior={"A": 1.0}),
            dc.make_segment(1.0, 2.0, posterior={"B": 1.0}),
        ]
        words = [
            dc.WordToken("안녕", 0.1, 0.4),
            dc.WordToken("하세요", 1.2, 1.6),
        ]
        out = dc.attach_words(segs, words)
        self.assertEqual([w.text for w in out[0].words], ["안녕"])
        self.assertEqual([w.text for w in out[1].words], ["하세요"])

    def test_word_out_of_range_goes_to_nearest(self):
        segs = [dc.make_segment(1.0, 2.0, posterior={"A": 1.0})]
        out = dc.attach_words(segs, [dc.WordToken("끝", 5.0, 5.2)])
        self.assertEqual(len(out[0].words), 1)  # 버리지 않고 가장 가까운 곳

    def test_ctm_format_and_determinism(self):
        segs = [dc.make_segment(0.0, 2.0, posterior={"A": 1.0})]
        segs = dc.attach_words(segs, [
            dc.WordToken("b", 1.0, 1.5, confidence=0.9),
            dc.WordToken("a", 0.0, 0.5, confidence=0.8),
        ])
        sc = dc.CanonicalSidecar(segments=segs)
        ctm = sc.to_ctm(uri="clip")
        lines = ctm.strip().split("\n")
        self.assertEqual(len(lines), 2)
        # 시간순 정렬 → a 먼저
        self.assertIn(" a ", " " + lines[0] + " ")
        f = lines[0].split()
        self.assertEqual(f[0], "clip")
        self.assertEqual(f[2], "0.000")
        self.assertEqual(f[3], "0.500")
        self.assertEqual(sc.to_ctm(), sc.to_ctm())

    def test_word_round_trip(self):
        w = dc.WordToken("x", 0.1, 0.2, speaker="A", confidence=0.5)
        self.assertEqual(dc.WordToken.from_dict(w.to_dict()).to_dict(), w.to_dict())


class FrameBuilderTest(unittest.TestCase):
    def test_silence_skipped(self):
        labels = [-1] * 10 + [0] * 10 + [-1] * 10
        segs = dc.build_segments_from_frames(labels, 100, ["A"])
        self.assertEqual(len(segs), 1)
        self.assertAlmostEqual(segs[0].start, 0.1)
        self.assertAlmostEqual(segs[0].end, 0.2)

    def test_empty_input(self):
        self.assertEqual(dc.build_segments_from_frames([], 100, ["A"]), [])

    def test_bad_frame_rate(self):
        with self.assertRaises(ValueError):
            dc.build_segments_from_frames([0], 0, ["A"])

    def test_posterior_averaged_over_segment(self):
        labels = [0, 0, 0, 0]
        posts = [[0.9, 0.1], [0.7, 0.3], [0.9, 0.1], [0.7, 0.3]]
        segs = dc.build_segments_from_frames(labels, 100, ["A", "B"], frame_posteriors=posts)
        self.assertAlmostEqual(segs[0].posterior["A"], 0.8, places=6)
        self.assertAlmostEqual(segs[0].posterior["B"], 0.2, places=6)

    def test_two_speaker_alternation(self):
        # A B A B, 각 100프레임(1초)
        labels = [0] * 100 + [1] * 100 + [0] * 100 + [1] * 100
        segs = dc.build_segments_from_frames(labels, 100, ["A", "B"])
        self.assertEqual(len(segs), 4)
        self.assertEqual([s.primary_speaker() for s in segs], ["A", "B", "A", "B"])
        self.assertEqual(dc.count_backchannels(segs), 0)


class IntegrationSyntheticTest(unittest.TestCase):
    """합성 타임라인 전체 파이프라인: 프레임 → 세그먼트 → 단어부착 → 사이드카 직렬화."""

    def test_full_pipeline(self):
        fr = 100
        # A 1.0s, B 0.15s(backchannel), A 0.8s
        labels = [0] * 100 + [1] * 15 + [0] * 80
        posts = ([[0.95, 0.05]] * 100) + ([[0.2, 0.8]] * 15) + ([[0.9, 0.1]] * 80)
        segs = dc.build_segments_from_frames(labels, fr, ["화자 A", "화자 B"],
                                             frame_posteriors=posts)
        self.assertEqual(len(segs), 3)
        self.assertEqual(dc.count_backchannels(segs), 1)

        words = [
            dc.WordToken("여보세요", 0.2, 0.8, confidence=0.95),
            dc.WordToken("응", 1.02, 1.12, confidence=0.6),
            dc.WordToken("그래서", 1.2, 1.7, confidence=0.9),
        ]
        segs = dc.attach_words(segs, words)
        sc = dc.CanonicalSidecar(segments=segs, source={"tool": "synthetic"})

        # 직렬화 결정성.
        self.assertEqual(sc.to_json(), sc.to_json())
        # round-trip 동등.
        self.assertEqual(dc.CanonicalSidecar.from_json(sc.to_json()).to_json(), sc.to_json())
        # 화자 목록.
        self.assertEqual(sc.all_speakers(), ["화자 A", "화자 B"])
        # RTTM 라인 수 = 화자 라벨 총합(overlap 없으면 세그먼트 수).
        self.assertEqual(len(sc.to_rttm().strip().split("\n")), 3)
        # CTM 라인 수 = 단어 수.
        self.assertEqual(len(sc.to_ctm().strip().split("\n")), 3)
        # backchannel "응" 은 중간(B) 세그먼트에 부착되어 보존.
        mid = sc.sorted_segments()[1]
        self.assertTrue(mid.is_backchannel)
        self.assertIn("응", [w.text for w in mid.words])

        # 사이드카 dict 가 유효 JSON 인지.
        json.dumps(sc.to_dict())


if __name__ == "__main__":
    unittest.main(verbosity=2)
