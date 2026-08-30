# -*- coding: utf-8 -*-
"""줄 끝 정규화 계약 — CRLF·단독 CR 은 대본의 내용이 아니다 (GPU 없음).

Windows 에서 붙여넣은 CRLF 의 CR 이 spoken_text 에 남으면 tokenizer 결과, source offset,
chunk 계획, 실제 발화, LF 입력과의 시간 예측이 모두 갈라진다(실측). 그래서 **공용 parser
입력 경계**에서 정규화한다.

여기서 고정하는 것:
  · 정규화는 파서 입구에서만 일어나고 사용자 원문 문자열은 어디서도 바뀌지 않는다
  · 밖으로 나가는 offset 은 **원문 좌표**다(정규화 좌표가 새면 한 글자씩 밀린다)
  · LF·CRLF·단독 CR 이 같은 spoken text·토큰·chunk 계획·plan SHA 를 만든다
  · 원문 SHA 는 원본 기준, 정규화 SHA 는 정규화본 기준으로 분리된다
  · 다중 문단·빈 줄·astral 문자에서도 offset 이 밀리지 않는다
"""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import input_analysis as ia                                   # noqa: E402
import tts_grammar as tg                                      # noqa: E402

CR = chr(13)
LF = chr(10)


def _count(t):
    return max(1, len(t))


def _variants(lf_text):
    """같은 대본의 세 표기. 내용은 같고 줄 끝만 다르다."""
    return {
        "lf": lf_text,
        "crlf": lf_text.replace(LF, CR + LF),
        "cr": lf_text.replace(LF, CR),
    }


BASE = ("첫 줄입니다." + LF + "[기쁨] 둘째 줄입니다." + LF + LF
        + "셋째 줄입니다. 넷째 문장도 같은 줄." + LF + "다섯째 줄입니다.")


class NormalizationMapTest(unittest.TestCase):
    def test_lf_input_is_untouched(self):
        norm, u16, cp = tg.normalize_line_endings(BASE)
        self.assertEqual(norm, BASE)
        self.assertEqual(u16[0], 0)
        self.assertEqual(u16[-1], len(BASE))
        self.assertEqual(cp[-1], len(BASE))

    def test_crlf_map_points_back_at_the_original(self):
        src = BASE.replace(LF, CR + LF)
        norm, u16, cp = tg.normalize_line_endings(src)
        self.assertNotIn(CR, norm)
        self.assertEqual(norm, BASE)
        # 정규화본의 모든 문자가 원문에서 같은 문자를 가리킨다(줄 끝은 LF↔CR 대응).
        for n_idx, ch in enumerate(norm):
            s_idx = cp[n_idx]
            self.assertLess(s_idx, len(src))
            self.assertEqual(src[s_idx] if ch != LF else LF,
                             src[s_idx] if ch != LF else LF)
        self.assertEqual(len(u16), len(norm) + 1)

    def test_lone_cr_becomes_lf_without_changing_length(self):
        src = "가" + CR + "나"
        norm, u16, _cp = tg.normalize_line_endings(src)
        self.assertEqual(norm, "가" + LF + "나")
        self.assertEqual(u16[-1], len(src))

    def test_astral_characters_do_not_shift_the_map(self):
        src = "가" + chr(0x1F600) + CR + LF + "나"
        norm, u16, cp = tg.normalize_line_endings(src)
        self.assertEqual(norm, "가" + chr(0x1F600) + LF + "나")
        # 원문 UTF-16 총 길이: 가(1) + emoji(2) + CR(1) + LF(1) + 나(1) = 6.
        # map 은 UTF-16 단위로 색인하므로 code point 길이로 인덱싱하면 안 된다.
        self.assertEqual(u16[-1], 6)
        self.assertEqual(len(u16), 5 + 1, "정규화본 UTF-16 길이 + 끝 경계")
        self.assertEqual(cp[-1], len(src))
        # emoji 다음 문자(LF)의 원문 위치는 emoji 를 2 단위로 건너뛴 3 이다.
        self.assertEqual(u16[3], 3)

    def test_source_string_is_not_modified(self):
        src = BASE.replace(LF, CR + LF)
        before = src
        tg.normalize_line_endings(src)
        tg.parse_tts_script(src)
        self.assertEqual(src, before, "정규화가 입력 문자열을 건드리면 안 된다")


class ParserParityTest(unittest.TestCase):
    def test_three_line_endings_produce_the_same_plan(self):
        plans = {}
        for k, t in _variants(BASE).items():
            r = tg.parse_tts_script(t)
            self.assertTrue(r["ok"], k)
            plans[k] = r["plan"]
        self.assertEqual(plans["lf"]["full_sha256"], plans["crlf"]["full_sha256"])
        self.assertEqual(plans["lf"]["full_sha256"], plans["cr"]["full_sha256"])
        for k in ("crlf", "cr"):
            self.assertEqual([s["spoken_text"] for s in plans[k]["segments"]],
                             [s["spoken_text"] for s in plans["lf"]["segments"]])
            for s in plans[k]["segments"]:
                self.assertNotIn(CR, s["spoken_text"], "CR 이 발화 텍스트에 남았다")

    def test_offsets_are_source_coordinates_not_normalized_ones(self):
        for k, t in _variants(BASE).items():
            with self.subTest(k):
                plan = tg.parse_tts_script(t)["plan"]
                for s in plan["segments"]:
                    o = s["offset"]
                    got = t[o["ui_start_utf16"]:o["ui_end_utf16"]]
                    self.assertNotIn(CR, got, "원문 조각에 CR 이 들어갔다")
                    self.assertIn(s["spoken_text"], got,
                                  "offset 이 발화 구간을 가리키지 않는다")

    def test_multi_paragraph_offsets_do_not_drift_by_one(self):
        """CRLF 는 줄마다 한 글자가 더 있다 — 누적되면 뒤 문단이 통째로 밀린다."""
        lf, crlf = BASE, BASE.replace(LF, CR + LF)
        a = tg.parse_tts_script(lf)["plan"]["segments"]
        b = tg.parse_tts_script(crlf)["plan"]["segments"]
        self.assertEqual(len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            self.assertEqual(lf[x["offset"]["ui_start_utf16"]:x["offset"]["ui_end_utf16"]],
                             crlf[y["offset"]["ui_start_utf16"]:y["offset"]["ui_end_utf16"]],
                             "segment %d 좌표가 밀렸다" % i)


class AnalysisParityTest(unittest.TestCase):
    def test_plan_is_identical_across_line_endings(self):
        base = None
        for k, t in _variants(BASE).items():
            r = ia.analyze(t, _count)
            shape = (r["source_paragraph_count"], r["segment_count"], r["planned_calls"],
                     r["production_tokens"], r["estimated_audio_seconds"],
                     r["estimated_wall_seconds"], r["normalized_sha256"],
                     [c["production_tokens"] for c in r["chunks"]],
                     [c["split_reason"] for c in r["chunks"]])
            if base is None:
                base = shape
            else:
                self.assertEqual(shape, base, "%s 표기가 다른 계획을 만든다" % k)

    def test_raw_and_normalized_sha_are_separate(self):
        lf = ia.analyze(BASE, _count)
        crlf = ia.analyze(BASE.replace(LF, CR + LF), _count)
        self.assertNotEqual(lf["source_sha256"], crlf["source_sha256"],
                            "원문 SHA 는 입력 그대로여야 stale 판정이 된다")
        self.assertEqual(lf["normalized_sha256"], crlf["normalized_sha256"])
        self.assertEqual(lf["source_sha256"],
                         hashlib.sha256(BASE.encode("utf-8")).hexdigest())
        self.assertEqual(lf["source_sha256"], lf["normalized_sha256"],
                         "LF 입력은 원문과 정규화본이 같다")

    def test_chunk_offsets_slice_the_original_input(self):
        for k, t in _variants(BASE).items():
            with self.subTest(k):
                r = ia.analyze(t, _count)
                for c in r["chunks"]:
                    got = t[c["source_start"]:c["source_end"]]
                    self.assertNotIn(CR, got)
                    self.assertTrue(got.strip())

    def test_source_paragraph_offsets_slice_the_original_input(self):
        for k, t in _variants(BASE).items():
            with self.subTest(k):
                r = ia.analyze(t, _count)
                for p in r["source_paragraphs"]:
                    got = t[p["source_start"]:p["source_end"]]
                    self.assertNotIn(CR, got)
                    self.assertEqual(len(got), p["chars"])


class ThreeAxesTest(unittest.TestCase):
    """문단(Enter) · 대사 구간(parser segment) · 생성 묶음(model call)은 다른 축이다."""

    def test_emotion_tag_does_not_inflate_paragraph_count(self):
        one_line = "[기쁨] 첫 문장입니다. [슬픔] 둘째 문장입니다."
        r = ia.analyze(one_line, _count)
        self.assertEqual(r["source_paragraph_count"], 1,
                         "감정 태그로 갈린 구간을 문단으로 세면 안 된다")
        self.assertGreater(r["segment_count"], 1, "parser 는 실제로 두 구간을 만든다")
        self.assertEqual(r["planned_calls"], r["segment_count"])

    def test_blank_line_relationship_is_preserved(self):
        t = "첫 줄." + LF + LF + LF + "둘째 줄."
        r = ia.analyze(t, _count)
        self.assertEqual(r["source_paragraph_count"], 2)
        self.assertEqual(r["source_paragraphs"][0]["blank_lines_before"], 0)
        self.assertEqual(r["source_paragraphs"][1]["blank_lines_before"], 2,
                         "연속 빈 줄 관계가 사라졌다")

    def test_every_chunk_links_both_axes(self):
        t = "첫 줄입니다." + LF + "[기쁨] 둘째 줄. [슬픔] 셋째 문장."
        r = ia.analyze(t, _count)
        for c in r["chunks"]:
            self.assertIsNotNone(c["source_paragraph_index"])
            self.assertLess(c["source_paragraph_index"], r["source_paragraph_count"])
            self.assertLess(c["segment_index"], r["segment_count"])

    def test_counts_are_not_aliased_into_one_number(self):
        t = "[기쁨] 한 줄에 두 감정. [슬픔] 두 번째."
        r = ia.analyze(t, _count)
        self.assertEqual(r["paragraph_count"], r["source_paragraph_count"],
                         "paragraph_count 는 사용자 문단 축이어야 한다")
        self.assertNotEqual(r["source_paragraph_count"], r["segment_count"],
                            "이 입력에서는 두 축이 실제로 달라야 한다")


if __name__ == "__main__":
    unittest.main()
