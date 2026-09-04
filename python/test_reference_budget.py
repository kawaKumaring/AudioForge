# -*- coding: utf-8 -*-
"""참조 예산 — 고정 상수 83 대신 실제 유효 참조의 codec 프레임 수로 계산한다.

83 은 controlled-prefix(legacy) 가 참조를 재발화할 때 필요한 프레임을 '약 6.9초 참조' 로 가정한 값이었다
(12Hz × 6.9s ≈ 83). 여유 예산이 아니라 참조 길이 가정이다. vendor native ICL 은 재발화가 없어 replay 0 이지만
참조 codec 프레임과 전사 토큰이 prompt(입력 위치)를 차지한다 — 예전에는 이것을 0 으로 넣었다(과소 계산).
참조 예산과 출력 예산(tier)은 다른 축이다. 이 교정은 출력 상한·재시도 횟수를 늘리지 않는다.
"""
import io
import os
import re
import unittest

import chunk_budget as cb

HERE = os.path.dirname(os.path.abspath(__file__))


class ReferenceBudget(unittest.TestCase):
    def test_legacy_constant_meant_about_seven_second_reference(self):
        self.assertEqual(cb.LEGACY_REPLAY_FRAMES_ASSUMED, 83)
        self.assertEqual(cb.estimate_ref_code_frames(6.9), 83)       # 12Hz × 6.9s → 83: 예전 상수가 가정한 참조 길이
        self.assertAlmostEqual(cb.LEGACY_REPLAY_ASSUMED_REF_SEC, 6.92, places=2)
        self.assertEqual(cb.estimate_ref_code_frames(58.334), 701)     # 58.3초 원본 전체 = 약 700 frame
        self.assertEqual(cb.estimate_ref_code_frames(0), 0)

    def test_x_vector_reference_costs_nothing(self):
        rb = cb.reference_budget(True)
        self.assertEqual((rb["prefix_tokens"], rb["replay_frames"]), (0, 0))
        self.assertEqual(rb["mode"], "x_vector")

    def test_native_icl_uses_prompt_not_replay(self):
        rb = cb.reference_budget(False, ref_code_frames=85, ref_text_tokens=30)
        self.assertEqual(rb["mode"], "icl")
        self.assertEqual(rb["prefix_tokens"], 115)
        self.assertEqual(rb["replay_frames"], 0)

    def test_controlled_prefix_replays_actual_frames_not_83(self):
        short = cb.reference_budget(False, ref_code_frames=40, ref_text_tokens=10, controlled_prefix=True)
        long = cb.reference_budget(False, ref_code_frames=700, ref_text_tokens=200, controlled_prefix=True)
        self.assertEqual(short["replay_frames"], 40)
        self.assertEqual(long["replay_frames"], 700)
        self.assertEqual(long["mode"], "icl_controlled_prefix")

    def test_icl_without_measured_frames_is_refused(self):
        for bad in (None, 0, -5, 3.5, True):
            with self.assertRaises(ValueError):
                cb.reference_budget(False, ref_code_frames=bad)

    def test_long_reference_affects_budget_only_where_it_really_costs(self):
        # native ICL: 58초 참조(≈700 frame) 도 prompt 위치만 차지 → tier 는 그대로, headroom 만 줄어든다.
        base = cb.budget_for(100)
        icl = cb.reference_budget(False, ref_code_frames=700, ref_text_tokens=200)
        b = cb.budget_for(100, reference_prefix_tokens=icl["prefix_tokens"], reference_replay_frames=icl["replay_frames"])
        self.assertEqual(b["generation_limit"], base["generation_limit"])
        self.assertEqual(b["architecture_headroom"], base["architecture_headroom"] - 900)
        self.assertTrue(b["fits"])
        # controlled-prefix(legacy): 같은 참조를 재발화하면 생성 예산이 실제로 더 필요하다 — 83 으로는 부족했을 값.
        cp = cb.reference_budget(False, ref_code_frames=700, ref_text_tokens=200, controlled_prefix=True)
        c = cb.budget_for(100, reference_prefix_tokens=cp["prefix_tokens"], reference_replay_frames=cp["replay_frames"])
        self.assertGreater(c["required_frames"], cb.budget_for(100, reference_replay_frames=83)["required_frames"])
        self.assertGreater(c["generation_limit"], base["generation_limit"])

    def test_output_ceilings_unchanged_by_reference_budget(self):
        # 참조 예산 교정은 출력 상한(품질·종료 상한)이나 tier 목록을 바꾸지 않는다.
        self.assertEqual(cb.quality_operating_ceiling(), 379)
        self.assertEqual(cb.BUDGET_TIERS, (256, 512, 768, 1024, 1536, 2048, 3072, 4096))
        self.assertEqual(cb.safe_production_tokens(), 190)


class _Ids:
    def __init__(self, n):
        self.shape = (1, n)


class _Proc:
    def __call__(self, text, return_tensors="pt"):
        return {"input_ids": _Ids(len(text))}


class BridgeWiring(unittest.TestCase):
    def setUp(self):
        self.src = io.open(os.path.join(HERE, "qwen_bridge.py"), encoding="utf-8").read()

    def test_no_fixed_83_left_in_bridge_code(self):
        code = "\n".join(l for l in self.src.splitlines() if not l.strip().startswith("#"))
        self.assertIsNone(re.search(r"\b83\b", code))

    def test_generate_segment_and_plan_use_measured_reference_budget(self):
        self.assertIn("_rb = _reference_budget_for(model, proc, seg)", self.src)
        self.assertIn('reference_prefix_tokens=_rb["prefix_tokens"], reference_replay_frames=_rb["replay_frames"]', self.src)
        self.assertIn("plan = _build_chunk_plan(segments, builder, proc, _seg_cap)", self.src)
        self.assertIn('"reference_budget": g.get("reference_budget")', self.src)
        # 실측 실패는 추정값으로 열지 않는다.
        self.assertIn("ICL 예산을 추정값으로 열지 않는다", self.src)

    def test_build_chunk_plan_accepts_per_segment_cap(self):
        import qwen_bridge as qb
        segs = [{"index": 0, "text": "a" * 40, "emotion_id": "default"},
                {"index": 1, "text": "b" * 40, "emotion_id": "default"}]
        caps = {0: 100, 1: 15}
        plan = qb._build_chunk_plan(segs, lambda t: t, _Proc(), lambda seg: caps[seg["index"]])
        by_seg = {}
        for it in plan:
            by_seg.setdefault(it["seg"]["index"], []).append(it)
        self.assertEqual(len(by_seg[0]), 1)          # 상한 100 → 분할 없음
        self.assertGreaterEqual(len(by_seg[1]), 3)   # 상한 15 → 40자를 여러 조각으로
        self.assertTrue(all(len(it["text"]) <= 15 for it in by_seg[1]))
        # int 상한(구 호출)도 그대로 동작한다.
        plan_int = qb._build_chunk_plan(segs, lambda t: t, _Proc(), 100)
        self.assertEqual(len(plan_int), 2)


if __name__ == "__main__":
    unittest.main()
