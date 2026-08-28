# -*- coding: utf-8 -*-
"""참조 구간/전사 정렬 정책 회귀 — 실제 사고 사례 + 경계 조작 사례. 모델·GPU 불필요.

무음 목록은 원본 vocals.wav 에서 실측한 값(20ms/10ms 프레임, -40dBFS, 0.20s 이상)이다.
세그먼트 경계는 화면 표시용 1초 단위가 아니라 실제 발화 경계 기준이다 —
그 둘을 혼동한 것이 이번 사고의 직접 원인이라 테스트도 그 구분을 지킨다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_alignment as ra  # noqa: E402

# 실측 무음 구간(초) — 0.20s 이상만
SILENCES = [(4.02, 4.50), (11.73, 12.00), (13.72, 14.22), (20.37, 20.60),
            (22.57, 22.83), (23.47, 23.73), (25.68, 26.07), (26.33, 26.60),
            (30.16, 30.47), (32.70, 33.43), (33.89, 34.14)]

# 14~23초 창에 걸친 발화 4개. 마지막 발화는 23.0 을 넘어 23.42 에서 끝난다(사고의 핵심).
SEGS_1423 = [
    {"id": "s1", "start": 14.22, "end": 16.10, "text": "첫 문장"},
    {"id": "s2", "start": 16.30, "end": 18.05, "text": "둘째 문장"},
    {"id": "s3", "start": 18.20, "end": 20.37, "text": "셋째 문장"},
    {"id": "s4", "start": 20.60, "end": 23.42, "text": "넷째 문장 끝"},
]


class EndCutReproTest(unittest.TestCase):
    """1. 끝이 발화 중간을 자르는 실제 사례(14~23초)."""

    def test_requested_end_splits_last_utterance(self):
        s4 = SEGS_1423[-1]
        self.assertLess(s4["start"], 23.0)
        self.assertGreater(s4["end"], 23.0)      # 23.0 이 발화 한가운데

    def test_policy_extends_end_and_includes_all(self):
        p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, SILENCES)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["reason"], ra.OK_EXTENDED_END)
        self.assertAlmostEqual(p["clip_end"], 23.60, places=3)   # (23.47,23.73) 한가운데
        self.assertEqual([s["id"] for s in p["included"]], ["s1", "s2", "s3", "s4"])
        self.assertEqual(p["excluded"], [])
        self.assertGreater(p["tail_silence_sec"], 0.0)
        self.assertGreater(p["head_silence_sec"], 0.0)
        ra.assert_alignment(p)

    def test_old_behaviour_would_have_violated_invariant(self):
        """보정 없이 14.0~23.0 을 그대로 쓰면 s4 가 구간을 넘는다 — 그것이 사고다."""
        bad = {"ok": True, "reason": "X", "clip_start": 14.0, "clip_end": 23.0,
               "included": [{"id": s["id"], "start": s["start"], "end": s["end"]}
                            for s in SEGS_1423],
               "excluded": [], "head_silence_sec": 0.22, "tail_silence_sec": -0.42}
        with self.assertRaises(ra.AlignmentError) as cm:
            ra.assert_alignment(bad)
        self.assertEqual(cm.exception.code, "SEGMENT_ENDS_AFTER_CLIP")


class StartCutTest(unittest.TestCase):
    """2. 시작이 발화 중간을 자르는 사례."""

    def test_start_inside_utterance_is_corrected(self):
        """15.0 은 s1(14.22~16.10) 한가운데다. 확장이든 제외든, 보정 뒤에는
        구간 시작을 걸치는 발화가 하나도 남지 않아야 한다."""
        p = ra.plan_reference_region(15.0, 20.485, SEGS_1423, SILENCES)
        self.assertTrue(p["ok"], p)
        self.assertIn(p["reason"], (ra.OK_EXTENDED_START, ra.OK_EXCLUDED_HEAD_SEGMENT))
        self.assertNotEqual(p["clip_start"], 15.0)          # 요청 그대로 두지 않는다
        for s in p["included"]:
            self.assertGreaterEqual(s["start"], p["clip_start"] - ra.EDGE_TOLERANCE_SEC)
            self.assertLessEqual(s["end"], p["clip_end"] + ra.EDGE_TOLERANCE_SEC)
        if p["reason"] == ra.OK_EXCLUDED_HEAD_SEGMENT:      # 제외했다면 문구도 빠져야 한다
            self.assertNotIn("s1", [s["id"] for s in p["included"]])
            self.assertNotIn("첫 문장", p["ref_text"])
        ra.assert_alignment(p)

    def test_start_excludes_head_segment_when_extension_too_long(self):
        """뒤로 확장하면 상한을 넘는 경우 — 걸친 발화를 빼고 시작을 '다음 유효 무음'까지 민다.

        s1 뒤(16.10~) 에는 0.20s 이상 무음이 없다. s1~s3 사이 틈은 전부 숨이지 문장 경계가
        아니므로, 정책이 고를 수 있는 다음 경계는 (20.37,20.60) 한가운데뿐이다.
        그 결과 s1·s2·s3 이 모두 빠지고 s4 만 남는다 — 짧아지더라도 '완전한 발화'가 우선이다."""
        p = ra.plan_reference_region(15.0, 23.60, SEGS_1423, SILENCES, max_sec=8.0)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["reason"], ra.OK_EXCLUDED_HEAD_SEGMENT)
        self.assertAlmostEqual(p["clip_start"], 20.485, places=3)
        self.assertEqual([s["id"] for s in p["included"]], ["s4"])
        self.assertEqual([s["id"] for s in p["excluded"]], ["s1", "s2", "s3"])
        self.assertNotIn("첫 문장", p["ref_text"])
        ra.assert_alignment(p)

    def test_start_extends_back_to_silence_when_length_allows(self):
        p = ra.plan_reference_region(15.0, 20.485, SEGS_1423, SILENCES, max_sec=10.0)
        self.assertEqual(p["reason"], ra.OK_EXTENDED_START)
        self.assertAlmostEqual(p["clip_start"], 13.97, places=3)   # (13.72,14.22) 한가운데
        self.assertEqual([s["id"] for s in p["included"]], ["s1", "s2", "s3"])


class ExtendEndTest(unittest.TestCase):
    """3. 끝을 확장해 전체 세그먼트를 포함할 수 있는 사례."""

    def test_extend_succeeds_within_max(self):
        segs = [{"id": "a", "start": 26.60, "end": 30.16, "text": "가"},
                {"id": "b", "start": 30.47, "end": 32.70, "text": "나"}]
        p = ra.plan_reference_region(26.60, 31.50, segs, SILENCES)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["reason"], ra.OK_EXTENDED_END)
        self.assertAlmostEqual(p["clip_end"], 33.065, places=3)   # (32.70,33.43) 한가운데
        self.assertEqual([s["id"] for s in p["included"]], ["a", "b"])
        ra.assert_alignment(p)


class ExcludeTailTest(unittest.TestCase):
    """4. 확장할 수 없어 마지막 세그먼트를 제외하는 사례."""

    def test_exclude_when_extension_exceeds_max(self):
        p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, SILENCES, max_sec=9.0)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["reason"], ra.OK_EXCLUDED_TAIL_SEGMENT)
        self.assertAlmostEqual(p["clip_end"], 20.485, places=3)   # (20.37,20.60) 한가운데
        self.assertEqual([s["id"] for s in p["included"]], ["s1", "s2", "s3"])
        self.assertEqual([s["id"] for s in p["excluded"]], ["s4"])
        self.assertNotIn("끝", p["ref_text"])                      # s4 문구가 남지 않는다
        ra.assert_alignment(p)


class FailClosedTest(unittest.TestCase):
    """5. 유효한 무음 경계가 없어 fail-closed 하는 사례."""

    def test_no_silence_fails_closed(self):
        p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, [])
        self.assertFalse(p["ok"])
        self.assertEqual(p["reason"], ra.FAIL_NO_SILENCE_BOUNDARY)
        self.assertIsNone(p["clip_start"])
        self.assertIsNone(p["clip_end"])
        self.assertEqual(p["ref_text"], "")
        with self.assertRaises(ra.AlignmentError):
            ra.assert_alignment(p)

    def test_too_short_after_correction_fails_closed(self):
        segs = [{"id": "x", "start": 20.60, "end": 23.42, "text": "하나"}]
        p = ra.plan_reference_region(20.60, 23.0, segs, SILENCES, max_sec=2.5)
        self.assertFalse(p["ok"])
        self.assertIn(p["reason"], (ra.FAIL_TOO_SHORT, ra.FAIL_NO_COMPLETE_SEGMENT,
                                    ra.FAIL_NO_SILENCE_BOUNDARY))
        with self.assertRaises(ra.AlignmentError):
            ra.assert_alignment(p)

    def test_coarse_timestamps_fail_closed(self):
        """1초 단위 표시값만으로는 '일치'를 판정하지 않는다 — 사고의 직접 원인."""
        coarse = [{"id": "c1", "start": 14.0, "end": 16.0, "text": "가"},
                  {"id": "c2", "start": 16.0, "end": 18.0, "text": "나"},
                  {"id": "c3", "start": 20.0, "end": 23.0, "text": "다"}]
        p = ra.plan_reference_region(14.0, 23.0, coarse, SILENCES)
        self.assertFalse(p["ok"])
        self.assertEqual(p["reason"], ra.FAIL_COARSE_TIMESTAMPS)
        with self.assertRaises(ra.AlignmentError):
            ra.assert_alignment(p)


class MultiSegmentTest(unittest.TestCase):
    """6. 여러 완전 세그먼트가 정상 연결되는 사례."""

    def test_three_complete_segments_join(self):
        p = ra.plan_reference_region(13.97, 20.485, SEGS_1423, SILENCES)
        self.assertTrue(p["ok"], p)
        self.assertEqual([s["id"] for s in p["included"]], ["s1", "s2", "s3"])
        self.assertEqual(p["ref_text"], "첫 문장 둘째 문장 셋째 문장")
        self.assertEqual(p["ref_text_chars"], len(p["ref_text"]))
        ra.assert_alignment(p)


class RefTextInvariantTest(unittest.TestCase):
    """7. ref_text 에 오디오에 없는 문장이 남지 않는다."""

    def test_ref_text_only_from_included(self):
        for max_sec in (9.0, 10.0):
            p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, SILENCES, max_sec=max_sec)
            self.assertTrue(p["ok"], p)
            texts = {s["id"]: s["text"] for s in SEGS_1423}
            inc = [texts[s["id"]] for s in p["included"]]
            self.assertEqual(p["ref_text"], " ".join(inc))
            for s in p["excluded"]:
                self.assertNotIn(texts[s["id"]], p["ref_text"])

    def test_every_ref_text_segment_is_inside_audio(self):
        p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, SILENCES, max_sec=9.0)
        for s in p["included"]:
            self.assertGreaterEqual(s["start"], p["clip_start"] - ra.EDGE_TOLERANCE_SEC)
            self.assertLessEqual(s["end"], p["clip_end"] + ra.EDGE_TOLERANCE_SEC)

    def test_excluded_ids_disjoint_from_included(self):
        p = ra.plan_reference_region(14.0, 23.0, SEGS_1423, SILENCES, max_sec=9.0)
        self.assertFalse({s["id"] for s in p["included"]} & {s["id"] for s in p["excluded"]})


class NoNeedlessChangeTest(unittest.TestCase):
    """8. 이미 정상인 참조는 건드리지 않는다(회귀)."""

    def test_already_aligned_region_is_unchanged(self):
        p = ra.plan_reference_region(13.97, 20.485, SEGS_1423, SILENCES)
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["reason"], ra.OK_AS_REQUESTED)
        self.assertEqual(p["actions"], [])
        self.assertAlmostEqual(p["clip_start"], 13.97, places=4)
        self.assertAlmostEqual(p["clip_end"], 20.485, places=4)

    def test_log_line_has_no_transcript_text(self):
        p = ra.plan_reference_region(13.97, 20.485, SEGS_1423, SILENCES)
        line = ra.format_plan_log(p)
        for s in SEGS_1423:
            self.assertNotIn(s["text"], line)
        self.assertIn("included=[s1,s2,s3]", line)



class WiredPathTest(unittest.TestCase):
    """배선 — detect_silences(실제 파형) + 정책 + 트림이 fail-closed 로 이어지는가."""

    def setUp(self):
        import tempfile, shutil
        self.tmp = tempfile.mkdtemp(prefix="af_align_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def _make(self, path, bursts, total_sec=26.0, sr=24000):
        """bursts=[(start,end)] 구간만 발화, 나머지는 무음인 합성 파일."""
        import numpy as np, soundfile as sf
        n = int(total_sec * sr)
        t = np.arange(n) / sr
        sig = np.zeros(n, dtype="float32")
        for a, b in bursts:
            i, j = int(a * sr), int(b * sr)
            seg = 0.3 * np.sin(2 * np.pi * 180 * t[i:j])
            seg *= (0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t[i:j]))
            sig[i:j] = seg.astype("float32")
        sf.write(path, sig, sr)
        return path

    def test_end_cut_request_is_corrected_and_clip_is_not_truncated(self):
        import reference_region as rr
        src = self._make(os.path.join(self.tmp, "src.wav"),
                         [(1.0, 5.0), (5.6, 9.5), (10.2, 14.4)])
        segs = [{"id": "a", "start": 1.0, "end": 5.0, "text": "가"},
                {"id": "b", "start": 5.6, "end": 9.5, "text": "나"},
                {"id": "c", "start": 10.2, "end": 14.4, "text": "다"}]
        out = os.path.join(self.tmp, "ref.wav")
        # 12.0 은 c(10.2~14.4) 한가운데 — 예전 경로면 그대로 잘렸을 요청
        path, plan = rr.build_aligned_reference(src, 1.0, 11.0, segs, out)
        self.assertTrue(os.path.exists(path))
        self.assertTrue(plan["ok"], plan)
        self.assertFalse(plan["clip_boundary_check"]["head_truncated"], plan)
        self.assertFalse(plan["clip_boundary_check"]["tail_truncated"], plan)
        for s in plan["included"]:
            self.assertLessEqual(s["end"], plan["clip_end"] + ra.EDGE_TOLERANCE_SEC)
        texts = {s["id"]: s["text"] for s in segs}
        for s in plan["excluded"]:
            self.assertNotIn(texts[s["id"]], plan["ref_text"])

    def test_no_silence_source_fails_closed_and_writes_no_clip(self):
        import reference_region as rr
        src = self._make(os.path.join(self.tmp, "dense.wav"), [(0.0, 26.0)])
        segs = [{"id": "a", "start": 0.0, "end": 12.3, "text": "가"},
                {"id": "b", "start": 12.3, "end": 25.7, "text": "나"}]
        out = os.path.join(self.tmp, "never.wav")
        with self.assertRaises(ra.AlignmentError):
            rr.build_aligned_reference(src, 2.0, 9.0, segs, out)
        self.assertFalse(os.path.exists(out))   # 실패하면 산출물을 남기지 않는다



class ClipTranscriptGateTest(unittest.TestCase):
    """9. 클립 자체를 다시 전사해 ref_text 와 음절 단위로 대조하는 통과 기준.

    실측값을 그대로 고정한다 — 사고 클립은 삭제 3(오디오에 없는 '입니다'가 ref_text 에 있었다),
    수정 클립은 삭제 0. 두 클립 모두 같은 자리에서 치환 2가 나오는데 그건 인식기 편차라
    실패로 세지 않는다."""

    def setUp(self):
        import korean_cer as kc
        self.ec = kc.edit_counts

    def test_accident_clip_is_rejected(self):
        ref = tuple("가나다라마바사입니다")
        clip = tuple("가나다라마바사")            # 오디오에 '입니다'가 없다
        v = ra.verify_clip_transcript(ref, clip, self.ec)
        self.assertEqual(v["deletions"], 3)
        self.assertEqual(v["timing_mismatch"], 3)
        self.assertFalse(v["aligned"])
        with self.assertRaises(ra.AlignmentError) as cm:
            ra.assert_clip_transcript(v)
        self.assertEqual(cm.exception.code, "CLIP_TEXT_TIMING_MISMATCH")

    def test_fixed_clip_passes(self):
        ref = tuple("가나다라마바사입니다")
        clip = tuple("가나다라마바사입니다")
        v = ra.verify_clip_transcript(ref, clip, self.ec)
        self.assertEqual(v["timing_mismatch"], 0)
        self.assertTrue(v["aligned"])
        self.assertTrue(ra.assert_clip_transcript(v))

    def test_substitution_only_is_warning_not_failure(self):
        """같은 자리에서 다르게 들린 것은 정렬 결함이 아니다 — 막으면 정상 참조까지 막힌다."""
        ref = tuple("가나다라마바사")
        clip = tuple("가나댜랴마바사")           # 같은 길이, 2음절 치환
        v = ra.verify_clip_transcript(ref, clip, self.ec)
        self.assertEqual(v["timing_mismatch"], 0)
        self.assertGreater(v["recognizer_variance"], 0)
        self.assertTrue(v["aligned"])
        self.assertTrue(ra.assert_clip_transcript(v))

    def test_extra_audio_not_in_ref_text_is_also_rejected(self):
        """반대 방향 — ref_text 에는 없는데 오디오에 있는 소리도 같은 현상을 만든다."""
        ref = tuple("가나다라")
        clip = tuple("가나다라마바")
        v = ra.verify_clip_transcript(ref, clip, self.ec)
        self.assertEqual(v["insertions"], 2)
        self.assertFalse(v["aligned"])
        with self.assertRaises(ra.AlignmentError):
            ra.assert_clip_transcript(v)


if __name__ == "__main__":
    unittest.main(verbosity=2)
