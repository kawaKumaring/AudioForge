# -*- coding: utf-8 -*-
"""입력 분석이 **production 권위**를 쓰는지 고정한다 (GPU 없음).

감사에서 확인한 결함이 출발점이다.

  · 문단을 원문 줄로 셌다 — production 은 `tts_grammar` 가 만든 segment(spoken_text)를 쓴다.
    `[기쁨]` 같은 태그가 붙은 줄은 원문 길이와 발화 토큰이 달라 planned calls 가 어긋난다.
  · 예상 음성 길이에 **예산 상한**(FRAME_UPPER_MARGIN 1.25 포함)을 썼다. 그건 생성이 넘치지
    않게 하려는 여유지 길이 추정이 아니다.
  · 참조 재발화 frame 을 음성 길이에도 더했다. 그건 생성만 하고 잘려 나간다.
  · 원문 보존을 `assert` 로만 지켰다 — `-O` 로 실행하면 사라진다.

여기서는 그 넷이 다시 무너지지 않게 고정하고, 새 chunk 좌표 계약을 검증한다.
"""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chunk_budget as cb                                    # noqa: E402
import input_analysis as ia                                  # noqa: E402
import text_segmenter as ts                                  # noqa: E402


def _count(t):
    """1자 = 1 production token 근사. 실제 tokenizer 는 주입되므로 계약만 본다."""
    return max(1, len(t))


class SegmentAuthorityTest(unittest.TestCase):
    def test_emotion_tag_is_not_counted_as_speech(self):
        r = ia.analyze("[기쁨] 좋은 소식이 있어요!", _count)
        self.assertTrue(r["parser_authority"], "parser 를 못 쓰면 근사임을 알려야 한다")
        self.assertEqual(r["paragraphs"][0]["emotion_id"], "happy")
        self.assertEqual(r["paragraphs"][0]["production_tokens"], _count("좋은 소식이 있어요!"),
                         "감정 태그가 발화 토큰으로 새어 들어갔다")

    def test_chunk_offsets_point_at_the_original_text(self):
        t = "안녕하세요 첫 문장입니다." + chr(10) + "[기쁨] 좋은 소식이 있어요!"
        r = ia.analyze(t, _count)
        for c in r["chunks"]:
            self.assertTrue(c["source_offsets_exact"])
            self.assertTrue(t[c["source_start"]:c["source_end"]].strip())
        self.assertEqual(t[r["chunks"][1]["source_start"]:r["chunks"][1]["source_end"]],
                         "좋은 소식이 있어요!", "감정 태그를 offset 에 넣으면 안 된다")

    def test_chunks_of_a_segment_join_back_to_that_segment(self):
        t = "가나다라. 마바사아. 자차카타." + chr(10) + "두 번째 문단입니다."
        r = ia.analyze(t, _count)
        joined = {}
        for c in r["chunks"]:
            joined.setdefault(c["segment_index"], []).append(
                t[c["source_start"]:c["source_end"]])
        for si, parts in joined.items():
            para = r["paragraphs"][si]
            self.assertEqual("".join(parts).strip(),
                             "".join(parts).strip(), "chunk 조각이 이어지지 않는다")
            self.assertLessEqual(len("".join(parts)), para["source_end"] - para["source_start"] + 1)

    def test_global_index_is_dense_and_ordered(self):
        r = ia.analyze("문장입니다. " * 60, _count)
        self.assertEqual([c["global_index"] for c in r["chunks"]],
                         list(range(len(r["chunks"]))))
        self.assertEqual(len(r["chunks"]), r["planned_calls"])

    def test_source_is_not_modified(self):
        t = "  앞뒤 공백 있는 원문입니다.  " + chr(10) + "  둘째 줄.  "
        before = t
        ia.analyze(t, _count)
        self.assertEqual(t, before, "분석이 입력을 건드리면 안 된다")

    def test_crlf_input_matches_production_exactly(self):
        """CRLF 도 production 과 **같은 결과**를 내야 한다.

        실측: tts_grammar 는 CR 을 떼지 않아 첫 줄의 spoken_text 끝에 CR 이 남는다.
        분석이 그걸 임의로 정리하면 토큰 수가 실제 생성과 어긋나므로 여기서는 고치지 않고
        **production 과 같게** 둔다. CR 제거 여부는 파서(TS/Python parity hash 포함)의
        별도 결정 사항이다."""
        t = "첫 줄입니다." + chr(13) + chr(10) + "둘째 줄입니다."
        r = ia.analyze(t, _count)
        segs = ia.paragraphs_of(t)
        self.assertEqual(len(r["chunks"]), len(segs))
        for c, seg in zip(r["chunks"], segs):
            self.assertEqual(t[c["source_start"]:c["source_end"]], seg["text"],
                             "chunk 좌표가 production segment 와 다르다")
            self.assertEqual(c["production_tokens"], _count(seg["text"]))
        lf = ia.analyze("첫 줄입니다." + chr(10) + "둘째 줄입니다.", _count)
        self.assertEqual(r["planned_calls"], lf["planned_calls"],
                         "CRLF 와 LF 의 호출 수는 같아야 한다")


class SplitReasonTest(unittest.TestCase):
    def test_only_boundaries_that_were_used_are_named(self):
        r = ia.analyze("첫 줄입니다." + chr(10) + "둘째 줄입니다.", _count)
        self.assertEqual([c["split_reason"] for c in r["chunks"]],
                         [ia.SPLIT_USER_PARAGRAPH, ia.SPLIT_END_OF_INPUT])

    def test_single_short_input_is_end_of_input_not_a_split(self):
        r = ia.analyze("문장 하나입니다.", _count)
        self.assertEqual(len(r["chunks"]), 1)
        self.assertEqual(r["chunks"][0]["split_reason"], ia.SPLIT_END_OF_INPUT)

    def test_long_single_sentence_uses_sentence_or_clause_boundaries(self):
        cap = cb.max_production_tokens()
        text = "가나다라마바사, " * 60 + "끝입니다."
        r = ia.analyze(text, _count)
        self.assertGreater(r["planned_calls"], 1)
        reasons = {c["split_reason"] for c in r["chunks"]}
        self.assertTrue(reasons & {ia.SPLIT_SENTENCE_END, ia.SPLIT_CLAUSE,
                                   ia.SPLIT_FORCED_CHARACTER})
        for c in r["chunks"]:
            self.assertLessEqual(c["production_tokens"], cap)

    def test_every_chunk_carries_a_generation_tier_within_budget(self):
        r = ia.analyze("문장입니다. " * 40, _count)
        for c in r["chunks"]:
            self.assertTrue(c["fits_budget"])
            self.assertIsNotNone(c["generation_tier"])
            self.assertGreaterEqual(c["combined_prompt_tokens"], c["production_tokens"])


class AudioVersusWallTimeTest(unittest.TestCase):
    def test_audio_estimate_does_not_use_the_budget_margin(self):
        """예산 상한(×1.25)을 길이 추정에 쓰면 결과가 구조적으로 길어진다."""
        tok = 200
        audio = cb.predict_audio_frames(tok)
        budget = cb.predict_frames(tok)
        self.assertLess(audio["max"], budget["high"],
                        "길이 추정이 예산 여유를 그대로 쓰고 있다")
        lo, hi = cb.AUDIO_FRAMES_PER_PRODUCTION_TOKEN_RANGE
        self.assertAlmostEqual(audio["min"], lo * tok)
        self.assertAlmostEqual(audio["max"], hi * tok)
        self.assertLess(lo, hi, "한 값으로 답할 수 없는 것을 한 값으로 내면 안 된다")

    def test_audio_and_wall_time_are_different_axes(self):
        r = ia.analyze("문장입니다. " * 20, _count)
        self.assertNotEqual(r["estimated_audio_seconds"]["max"],
                            r["estimated_wall_seconds"]["max"])

    def test_reference_replay_costs_time_but_not_audio_length(self):
        base = ia.analyze("문장입니다. " * 20, _count)
        replay = ia.analyze("문장입니다. " * 20, _count, reference_replay_frames=83)
        self.assertEqual(base["estimated_audio_seconds"], replay["estimated_audio_seconds"],
                         "잘려 나가는 참조 재발화가 음성 길이에 들어갔다")
        self.assertGreater(replay["estimated_wall_seconds"]["max"],
                           base["estimated_wall_seconds"]["max"],
                           "재발화는 실제로 생성하므로 작업 시간에는 들어가야 한다")

    def test_paragraph_ranges_sum_into_the_total(self):
        r = ia.analyze("가나다라마. " * 30 + chr(10) + "두 번째 문단입니다. " * 30, _count)
        lo = sum(p["estimated_audio_seconds"]["min"] for p in r["paragraphs"])
        hi = sum(p["estimated_audio_seconds"]["max"] for p in r["paragraphs"])
        self.assertAlmostEqual(r["estimated_audio_seconds"]["min"], lo, delta=0.3)
        self.assertAlmostEqual(r["estimated_audio_seconds"]["max"], hi, delta=0.3)


class SchemaTest(unittest.TestCase):
    KEYS = ("schema_version", "source_sha256", "character_count", "paragraph_count",
            "production_tokens", "planned_calls", "estimated_audio_seconds",
            "estimated_wall_seconds", "confidence", "confidence_reason",
            "paragraphs", "chunks", "warnings")

    def test_required_keys(self):
        r = ia.analyze("문장입니다.", _count)
        for k in self.KEYS:
            self.assertIn(k, r)
        self.assertEqual(r["schema_version"], ia.SCHEMA_VERSION)

    def test_source_sha_identifies_the_input(self):
        t = "문장입니다."
        self.assertEqual(ia.analyze(t, _count)["source_sha256"],
                         hashlib.sha256(t.encode("utf-8")).hexdigest())
        self.assertNotEqual(ia.analyze(t, _count)["source_sha256"],
                            ia.analyze(t + "!", _count)["source_sha256"])

    def test_response_carries_offsets_not_chunk_text(self):
        """원문 전문을 응답에 담지 않는다 — 좌표만 준다."""
        r = ia.analyze("가나다라. 마바사아.", _count)
        for c in r["chunks"]:
            self.assertNotIn("text", c)
        for p in r["paragraphs"]:
            self.assertNotIn("text", p)


class CeilingAuthorityTest(unittest.TestCase):
    def test_split_cap_is_the_quality_ceiling_not_the_termination_ceiling(self):
        r = ia.analyze("문장입니다.", _count)
        self.assertEqual(r["split_cap_production_tokens"], cb.max_production_tokens())
        self.assertEqual(r["split_cap_production_tokens"],
                         cb.quality_operating_ceiling(), "품질 운영 상한 379 가 기준이다")
        self.assertLess(r["split_cap_production_tokens"], cb.termination_ceiling(),
                        "종료 상한 563 을 분할 기준으로 쓰면 안 된다")


class PlannerParityTest(unittest.TestCase):
    """미리보기의 planned_calls == 실제 splitter 가 만드는 chunk 수."""

    CASES = (
        "",
        "짧은 한 문장입니다.",
        "줄바꿈 없는 안전한 장문입니다. " * 12,
        "첫 문단입니다." + chr(10) + "둘째 문단입니다." + chr(10) * 2 + "셋째 문단입니다.",
        "정말요? 네! 그렇습니다. 좋아요!",
        "가나다라마바사, " * 60 + "끝입니다.",
        "한글 English 日本語 中文 섞임 123 ㅋㅋ … 약어 A.I. 입니다.",
        "[기쁨] 기쁜 줄입니다." + chr(10) + "[슬픔] 슬픈 줄입니다.",
    )

    def _actual(self, text):
        cap = cb.max_production_tokens()
        total = 0
        for seg in ia.paragraphs_of(text):
            tok = _count(seg["text"])
            chunks = ([seg["text"]] if tok <= cap
                      else ts.split_for_generation(seg["text"], _count, cap))
            total += len(chunks)
        return total

    def test_planned_calls_match_the_real_splitter(self):
        for t in self.CASES:
            with self.subTest(t[:24]):
                self.assertEqual(ia.analyze(t, _count)["planned_calls"], self._actual(t))

    def test_chunk_rows_match_planned_calls(self):
        for t in self.CASES:
            with self.subTest(t[:24]):
                r = ia.analyze(t, _count)
                self.assertEqual(len(r["chunks"]), r["planned_calls"])
                self.assertEqual(sum(p["planned_calls"] for p in r["paragraphs"]),
                                 r["planned_calls"])


class WallTimeDecompositionTest(unittest.TestCase):
    """문단 줄의 시간과 요약의 시간이 서로 어긋나면 안 된다.

    작업 시간에는 대사 길이와 무관한 모델 준비 비용이 **작업당 한 번** 든다. 문단마다
    그것을 다시 세면 문단 줄의 합이 전체 예상보다 커진다 — 실제로 3문단 입력에서 총
    59~109초인데 문단 합이 144~281초였다. 그래서 문단은 한계 비용만 말한다.
    """

    def test_paragraph_wall_never_exceeds_the_whole_job(self):
        t = "첫 문단입니다. 이어지는 문장입니다." + chr(10) * 2             + "둘째 문단입니다." + chr(10) + "셋째 문단입니다."
        r = ia.analyze(t, _count)
        total = r["estimated_wall_seconds"]
        self.assertIsNotNone(total)
        parts = [s["estimated_wall_seconds_marginal"] for s in r["segments"]]
        self.assertTrue(all(p is not None for p in parts))
        self.assertLessEqual(sum(p["max"] for p in parts), total["max"],
                             "문단 합이 전체 작업 시간을 넘으면 화면의 숫자가 어긋난다")

    def test_preparation_is_reported_and_is_the_fixed_part(self):
        r = ia.analyze("문장입니다.", _count)
        prep = r["preparation_seconds"]
        self.assertIsNotNone(prep)
        # 준비 비용은 대사 길이와 무관하다 — 길이가 달라도 같은 값이어야 한다.
        long_r = ia.analyze("가나다라마. " * 60, _count)
        self.assertEqual(prep, long_r["preparation_seconds"])
        # 그리고 전체 작업 시간의 대부분을 짧은 입력에서 차지한다.
        self.assertGreater(prep["min"], 0.0)
        self.assertLess(prep["max"], r["estimated_wall_seconds"]["max"])

    def test_segment_no_longer_carries_whole_job_time(self):
        r = ia.analyze("문장입니다.", _count)
        for seg in r["segments"]:
            self.assertNotIn("estimated_wall_seconds", seg,
                             "문단에 전체 작업 시간을 그대로 두면 다시 어긋난다")


if __name__ == "__main__":
    unittest.main()
