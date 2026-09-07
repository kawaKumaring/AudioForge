# -*- coding: utf-8 -*-
"""v1.4 화자 축이 지켜야 할 계약 — **구현 전에** 먼저 못 박는다.

왜 지금 쓰는가
--------------
v1.4 는 화자와 감정을 실제 생성 경로까지 잇는다. 그 과정에서 깨지기 쉬운 것이 두 가지다.

1. **기존 대본**. 화자 표기를 쓰지 않은 대본은 v1.3.0 과 한 바이트도 다르지 않아야 한다.
   파서 plan hash 가 곧 production parity 의 기준이라(renderer ↔ Python) 여기가 흔들리면
   합성이 `PARSER_PARITY_MISMATCH` 로 막힌다. 그래서 hash 자체를 고정한다.
2. **의도와 실행 계획의 분리**. 화자·감정은 사용자의 의도이고 chunk 는 실행 계획이다.
   예산이 바뀌어 chunk 가 더 갈려도 어느 chunk 가 누구의 말인지는 바뀌면 안 된다.

이 파일은 화자 문법이 아직 없는 상태에서도 전부 통과한다(그때 `speaker_id` 는 None 이다).
문법이 들어온 뒤에도 같은 단언이 성립해야 한다 — 그것이 이 파일의 목적이다.

새 의존성 0(stdlib unittest). 모델·GPU·오디오를 부르지 않는다.
"""
import json
import os
import unittest

import chunk_budget as cb
import input_analysis as ia
import script_plan as sp
import text_segmenter as ts
import tts_grammar as tg

LF = chr(10)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRAMMAR_PINNED = os.path.join(REPO_ROOT, "src", "shared", "ttsGrammar.parity-hashes.json")

# 화자 표기가 없는 대본들. v1.4 작업 중 이 목록의 결과가 달라지면 기존 사용자에게 영향이 간다.
LEGACY_SCRIPTS = (
    "그냥 대사입니다.",
    "[기쁨] 안녕하세요.",
    "[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋아요.",
    "[기쁨] 첫 문장. [쉼 0.5] 둘째 문장.",
    "[기쁨] 첫째 줄." + LF + "[슬픔] 둘째 줄.",
    "첫 문단." + LF + LF + "둘째 문단.",
)


def _count(s):
    """테스트용 토크나이저(모델 로딩 금지). 실제 분할 규칙은 production 것을 쓴다."""
    return max(1, len(s or "") // 2)


class LegacyScriptUnchangedTest(unittest.TestCase):
    """화자 문법을 쓰지 않은 대본은 v1.3.0 과 같은 계획을 낸다."""

    def test_parser_plan_hash_is_pinned(self):
        """`ttsGrammar.parity-hashes.json` 은 renderer 와 Python 이 같이 보는 고정값이다.

        화자 축을 넣으면서 hash 입력에 필드를 무조건 더하면 이 단언이 깨진다. 그때는
        **화자 표기가 있는 대본에서만** 입력이 달라지도록 고쳐야 한다(조용히 재생성 금지).
        """
        with open(GRAMMAR_PINNED, encoding="utf-8") as f:
            pinned = json.load(f)
        legacy = [t for t in pinned if "화자" not in t and "speaker" not in t]
        self.assertGreaterEqual(len(legacy), 10, "고정 대상이 너무 적으면 헛돈다")
        bad = []
        for text in legacy:
            got = tg.parse_tts_script(text)
            if not got.get("ok"):
                continue                      # 구조화 오류 case 는 hash 대상이 아니다
            if got["plan"]["full_sha256"] != pinned[text]:
                bad.append("len=%d" % len(text))
        self.assertEqual(bad, [], "화자 표기가 없는 대본의 plan hash 가 달라졌다: %s" % bad)

    def test_no_speaker_directive_means_no_speaker_field_value(self):
        for text in LEGACY_SCRIPTS:
            st = sp.build_structure(text)
            self.assertTrue(all(u["speaker_id"] is None for u in st["utterances"]), text)

    def test_analysis_numbers_come_from_the_plan_not_a_second_pass(self):
        """분석 응답의 축 개수가 계획의 배열 길이와 같다(화면이 다시 세지 않는 근거)."""
        for text in LEGACY_SCRIPTS:
            r = ia.analyze(text, _count)
            p = r["plan"]
            self.assertEqual(r["source_paragraph_count"], len(p["source_paragraphs"]), text)
            self.assertEqual(r["segment_count"], len(p["utterances"]), text)
            self.assertEqual(r["planned_calls"], len(p["chunks"]), text)


class IntentVersusExecutionTest(unittest.TestCase):
    """화자·감정은 의도, chunk 는 실행 계획. chunk 가 갈려도 의도는 그대로다."""

    def _analyze_with_cap(self, text, cap_tokens):
        """예산만 바꿔 같은 대본을 다시 계획한다 — 의도가 흔들리는지 보려면 이것이 필요하다."""
        real = cb.max_production_tokens
        cb.max_production_tokens = lambda **kw: cap_tokens
        try:
            return ia.analyze(text, _count)
        finally:
            cb.max_production_tokens = real

    def test_every_chunk_belongs_to_exactly_one_utterance(self):
        text = ("[기쁨] 첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다." + LF + LF
                + "[슬픔] 다른 문단의 문장입니다. 또 한 문장입니다.")
        r = self._analyze_with_cap(text, 8)          # 일부러 작게 — 자동 분할을 일으킨다
        plan = r["plan"]
        self.assertGreater(len(plan["chunks"]), len(plan["utterances"]), "분할이 일어나야 한다")
        by_index = {u["index"]: u for u in plan["utterances"]}
        for c in plan["chunks"]:
            self.assertIn(c["segment_index"], by_index, "chunk 가 없는 발화를 가리킨다")

    def test_chunk_split_does_not_change_speaker_or_emotion_intent(self):
        text = ("[기쁨] 첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다." + LF + LF
                + "[슬픔] 다른 문단의 문장입니다. 또 한 문장입니다.")
        loose = self._analyze_with_cap(text, 10_000)  # 한 발화 = 한 묶음
        tight = self._analyze_with_cap(text, 8)       # 발화가 여러 묶음으로 갈린다
        self.assertGreater(len(tight["plan"]["chunks"]), len(loose["plan"]["chunks"]))

        def intent(res):
            return [(u["index"], u["speaker_id"], u["emotion_id"], u["source_start"],
                     u["source_end"], u["boundary_kind"])
                    for u in res["plan"]["utterances"]]

        self.assertEqual(intent(loose), intent(tight),
                         "예산이 바뀌었을 뿐인데 화자·감정·좌표가 달라졌다")
        # 감정 구간도 chunk 수와 무관해야 한다.
        self.assertEqual(loose["plan"]["emotions"], tight["plan"]["emotions"])

    def test_chunk_rows_carry_the_axes_they_belong_to(self):
        """chunk 행은 자기가 속한 문단·발화를 둘 다 들고 있어야 한다.

        화자별 참조를 고를 때 chunk 하나만 보고도 누구의 말인지 알 수 있어야 한다 —
        이 연결이 없으면 생성 단계에서 대본을 다시 해석하는 길이 열린다.
        """
        text = "[기쁨] 첫 문장입니다." + LF + LF + "[슬픔] 둘째 문단입니다."
        plan = ia.analyze(text, _count)["plan"]
        for c in plan["chunks"]:
            self.assertIsNotNone(c["source_paragraph_index"])
            self.assertIsInstance(c["segment_index"], int)


class ProductionFlattenTest(unittest.TestCase):
    """생성 경로가 계획을 어디서 좁히는지 — v1.4 가 넓혀야 하는 지점을 고정한다."""

    def test_boundary_gaps_from_plan_is_the_single_narrowing_point(self):
        """`_boundary_gaps_from_plan` 이 계획을 (감정, 대사) 로 좁힌다.

        오늘 생성 경로는 이 두 값만 본다. 화자를 실제로 잇는다는 것은 **이 지점을 넓히는**
        일이며, 새 planner 나 두 번째 파서를 만드는 일이 아니다. 함수 이름과 반환 모양을
        여기에 못 박아, 다른 곳에 비슷한 변환이 생기면 드러나게 한다.
        """
        import tts_worker as tw
        self.assertTrue(hasattr(tw, "_boundary_gaps_from_plan"))
        plan = tg.parse_tts_script("[기쁨] 안녕하세요." + LF + "[슬픔] 둘째 줄.")["plan"]
        parsed, gaps, kinds = tw._boundary_gaps_from_plan(plan, 0.5)
        self.assertEqual(len(parsed), len(plan["segments"]))
        self.assertEqual(len(gaps), len(parsed))
        self.assertEqual(len(kinds), len(parsed))
        for row, seg in zip(parsed, plan["segments"]):
            # 오늘의 모양: (emotion_id, spoken_text). 화자가 들어오면 여기가 넓어진다.
            self.assertEqual(row[0], seg["emotion_id"] or "default")
            self.assertEqual(row[1], seg["spoken_text"])

    def test_source_text_is_read_by_exactly_one_parser(self):
        """대본 해석 경로가 하나뿐인지 — 소비자가 각자 파싱하면 계획이 갈라진다."""
        calls = []
        real = tg.parse_tts_script

        def counting(raw, resolve_emotion=None):
            calls.append(len(raw or ""))
            return real(raw, resolve_emotion)

        tg.parse_tts_script = counting
        try:
            ia.analyze("[기쁨] 안녕하세요." + LF + LF + "[슬픔] 둘째 문단.", _count)
        finally:
            tg.parse_tts_script = real
        self.assertEqual(len(calls), 1)

    def test_planner_authority_stays_with_the_splitter(self):
        """미리보기의 묶음 수 == 실제 splitter 의 묶음 수. 이 등식이 v1.4 에서도 유지돼야 한다."""
        text = "[기쁨] 첫 문장입니다. 두 번째 문장입니다." + LF + LF + "[슬픔] 둘째 문단입니다."
        cap = cb.max_production_tokens()
        total = 0
        for u in ia.paragraphs_of(text):
            tok = _count(u["text"])
            total += 1 if tok <= cap else len(ts.split_for_generation(u["text"], _count, cap))
        self.assertEqual(ia.analyze(text, _count)["planned_calls"], total)


class SpeakerAxisShapeTest(unittest.TestCase):
    """화자 축의 자리와 이름. 구현 전에는 비어 있어야 하고, 구현 뒤에도 이름이 같아야 한다."""

    def test_utterance_carries_a_speaker_slot(self):
        st = sp.build_structure("[기쁨] 안녕하세요.")
        self.assertIn("speaker_id", st["utterances"][0],
                      "발화가 화자 칸을 들고 있어야 chunk 가 갈려도 연결이 유지된다")

    def test_speaker_slot_is_part_of_the_structure_hash(self):
        """화자가 hash 입력에 있어야 화면과 생성의 화자 배정이 어긋나면 드러난다."""
        self.assertIn("speaker_id", sp._HASH_UTTERANCE_KEYS)

    def test_speaker_axis_is_declared_before_it_exists(self):
        st = sp.build_structure("[기쁨] 안녕하세요.")
        self.assertTrue("speakers" in st or "speakers" in sp.RESERVED_AXES,
                        "축 이름은 구현 전에도 정해져 있어야 한다")

    def test_plan_never_duplicates_the_script_text(self):
        secret = "이것은 대사 원문입니다"
        st = sp.build_structure("[기쁨] " + secret)
        self.assertNotIn(secret, json.dumps(st, ensure_ascii=False),
                         "계획은 좌표·길이·SHA 만 들고 다닌다")


if __name__ == "__main__":
    unittest.main()
