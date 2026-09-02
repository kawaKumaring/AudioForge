# -*- coding: utf-8 -*-
"""공용 마감 I2 — _boundary_gaps_from_plan 단위테스트.

파서 plan(A 소유 tts_grammar) → (parsed, gaps_before) 환산이 계약(추가3 경계 우선순위·합산 금지,
정정6 immediate|pause, 정정7 explicit override)을 지키는지 순수하게 검증한다.
numpy/soundfile 불요(import tts_worker는 stdlib만) — 시스템 python에서도 실행됨.

우선순위 구분을 명확히 하려고 silence_gap(0.3)·emotion pause(0.2)·explicit(0.5)를 전부 다른 값으로 쓴다.
대사 전문은 단언 입력에만 쓰고 로그로 출력하지 않는다(실패 메시지는 라벨/인덱스만).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_grammar as g   # noqa: E402
import tts_worker as w    # noqa: E402

SG = 0.3           # silence_gap(전역 기본 줄 경계)
EPMS = 200         # emotion_boundary_pause_ms = 0.2s


def gaps(raw, mode="pause"):
    plan = g.parse_tts_script(raw)["plan"]
    parsed, gb, _kinds = w._boundary_gaps_from_plan(plan, SG, mode, EPMS)
    return parsed, gb


class BoundaryGapsTest(unittest.TestCase):
    def test_two_plain_lines_line_silence_gap(self):
        # 레거시 줄단위 입력: 감정 없음, 줄 경계 = silence_gap(회귀 보존).
        parsed, gb = gaps("안녕하세요.\n반갑습니다.")
        self.assertEqual([e for e, _t, _sp in parsed], ["default", "default"])
        self.assertEqual(gb, [0.0, SG])

    def test_single_segment_no_leading_gap(self):
        parsed, gb = gaps("그냥 한 문장.")
        self.assertEqual(len(parsed), 1)
        self.assertEqual(gb, [0.0])

    def test_inline_emotion_change_pause_mode(self):
        # 같은 줄 인라인 감정 전환 = emotionBoundaryPause → pause 모드는 0.2, silence_gap(0.3) 아님.
        parsed, gb = gaps("[기쁨] 안녕 [명랑] 반가워", mode="pause")
        self.assertEqual([e for e, _t, _sp in parsed], ["happy", "cheerful"])
        self.assertEqual(gb, [0.0, EPMS / 1000.0])

    def test_inline_emotion_change_immediate_mode(self):
        # immediate → 감정 전환 경계 gap 0(합산·pause 없음).
        _, gb = gaps("[기쁨] 안녕 [명랑] 반가워", mode="immediate")
        self.assertEqual(gb, [0.0, 0.0])

    def test_explicit_pause_overrides_not_sums(self):
        # 명시적 [쉼 0.5] → explicitPause. 값은 0.5(명시)로 silence_gap(0.3)·emotion(0.2) 어느 것도 아니고
        # 두 값을 더한 것도 아니다(override, 합산 금지). 모드 무관.
        _, gb_p = gaps("A [쉼 0.5] B", mode="pause")
        _, gb_i = gaps("A [쉼 0.5] B", mode="immediate")
        self.assertEqual(gb_p, [0.0, 0.5])
        self.assertEqual(gb_i, [0.0, 0.5])

    def test_line_break_beats_emotion_change(self):
        # 감정이 '줄바꿈'에서 바뀌면 lineSilenceGap만 적용(감정 pause 추가 안 함) — 계약 추가3.
        # → gap = silence_gap(0.3), emotion pause(0.2) 아님. 우선순위 line > emotion 증명.
        parsed, gb = gaps("[기쁨] 첫째 줄.\n[슬픔] 둘째 줄.", mode="pause")
        self.assertEqual([e for e, _t, _sp in parsed], ["happy", "sad"])
        self.assertEqual(gb, [0.0, SG])

    def test_spoken_text_verbatim_no_restrip(self):
        # 파서 산출 spoken_text를 그대로 쓴다(재-strip 금지 — 정규화 단일 소스=A 파서).
        parsed, _ = gaps("[기쁨] 안녕하세요.")
        self.assertEqual(parsed[0][0], "happy")
        # 파서 spoken_text와 동일해야 함
        exp = g.parse_tts_script("[기쁨] 안녕하세요.")["plan"]["segments"][0]["spoken_text"]
        self.assertEqual(parsed[0][1], exp)

    def test_default_mode_args(self):
        # 기본 인자(pause, 200) — synthesize 기본값과 동일해야 한다.
        plan = g.parse_tts_script("[기쁨] 안녕 [명랑] 반가워")["plan"]
        _, gb, _ = w._boundary_gaps_from_plan(plan, SG)
        self.assertEqual(gb, [0.0, 0.2])


if __name__ == "__main__":
    unittest.main()
