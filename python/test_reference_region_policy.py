# -*- coding: utf-8 -*-
"""구간 추천·판정·확정·ref-analyze 응답이 엔진 정책 하나에서 길이 조건을 파생하는지.

GPT-SoVITS 정책: 예전과 같은 3~10초 차단. Qwen3 정책: 길이 차단 없음, 권장(3~10초) 밖은 경고 코드.
화면이 허용한 구간을 생성 직전에 다른 상수가 거부하는 일이 없도록, 같은 정책 객체가 모든 단계에 들어간다.
"""
import io
import os
import re
import shutil
import tempfile
import unittest

import numpy as np
import soundfile as sf

import reference_audio as ra
import reference_region as rr

SR = 24000


def _tone(sec):
    return (0.3 * np.sin(2 * np.pi * 180 * np.arange(int(sec * SR)) / SR)).astype("float32")


def _safe_long(path, speech_blocks=(6.0, 6.0), gap=1.0):
    """무음 1초 | 발화 | 무음 1초 | 발화 | 무음 1초 … — 무음 중심이 안전 경계가 된다."""
    parts = [np.zeros(int(gap * SR), dtype="float32")]
    for b in speech_blocks:
        parts.append(_tone(b))
        parts.append(np.zeros(int(gap * SR), dtype="float32"))
    sf.write(path, np.concatenate(parts), SR)
    return path


class RegionPolicyDerivation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_region_pol_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        # 0.5 → 7.5 → 14.5 초에 무음 중심(안전 경계). 전체 15초.
        self.src15 = _safe_long(os.path.join(self.tmp, "s15.wav"))
        # 30초짜리: 발화 28초 한 덩어리(3~10초 안전 경계 쌍 없음).
        self.src30 = _safe_long(os.path.join(self.tmp, "s30.wav"), speech_blocks=(28.0,))

    # ── analyze_region ───────────────────────────────────────────────────────
    def test_analyze_region_gptsovits_blocks_over_10s(self):
        m = rr.analyze_region(self.src15, 0.5, 14.0, policy=ra.GPTSOVITS_POLICY)
        self.assertIn(rr.BLOCK_TOO_LONG, m["blocking"])
        self.assertFalse(m["in_range"])
        self.assertEqual(m["policy_engine"], "gptsovits")

    def test_analyze_region_qwen3_allows_over_10s_with_warning(self):
        m = rr.analyze_region(self.src15, 0.5, 14.0, policy=ra.QWEN3_POLICY)
        self.assertNotIn(rr.BLOCK_TOO_LONG, m["blocking"])
        self.assertTrue(m["in_range"])
        self.assertFalse(m["in_recommended"])
        self.assertIn(rr.WARN_OUTSIDE_RECOMMENDED, m["warning_codes"])
        self.assertTrue(m["ready"])
        self.assertEqual(m["required_range"], [None, None])

    def test_analyze_region_default_policy_is_gptsovits(self):
        # 정책을 넘기지 않은 구 호출 = 예전 동작 그대로(3~10초 차단).
        self.assertIn(rr.BLOCK_TOO_LONG, rr.analyze_region(self.src15, 0.5, 14.0)["blocking"])
        self.assertIn(rr.BLOCK_TOO_SHORT, rr.analyze_region(self.src15, 1.0, 2.9)["blocking"])

    def test_analyze_region_qwen3_short_is_warning_not_block(self):
        m = rr.analyze_region(self.src15, 1.0, 2.0, policy=ra.QWEN3_POLICY)
        self.assertNotIn(rr.BLOCK_TOO_SHORT, m["blocking"])
        self.assertIn(rr.WARN_OUTSIDE_RECOMMENDED, m["warning_codes"])

    # ── build_reference_clip(확정) ─────────────────────────────────────────
    def test_confirm_14s_region_gptsovits_blocked_qwen3_ready(self):
        out_g = os.path.join(self.tmp, "g.wav")
        g = rr.build_reference_clip(self.src15, 0.5, 14.0, out_g, transcribe_fn=lambda _p: "확인",
                                    policy=ra.GPTSOVITS_POLICY)
        self.assertFalse(g["ready"])
        self.assertTrue(g["blocking"])
        self.assertFalse(os.path.exists(out_g))
        out_q = os.path.join(self.tmp, "q.wav")
        q = rr.build_reference_clip(self.src15, 0.5, 14.0, out_q, transcribe_fn=lambda _p: "확인",
                                    policy=ra.QWEN3_POLICY)
        self.assertTrue(q["ready"], q)
        self.assertTrue(os.path.exists(out_q))
        self.assertAlmostEqual(q["effective_region"]["dur_sec"], 14.0, delta=0.05)
        self.assertIn(rr.WARN_OUTSIDE_RECOMMENDED, q["warning_codes"])
        self.assertEqual(q["policy_engine"], "qwen3")

    def test_confirm_recommended_range_no_warning_both_engines(self):
        for pol in (ra.GPTSOVITS_POLICY, ra.QWEN3_POLICY):
            out = os.path.join(self.tmp, f"{pol.engine}.wav")
            r = rr.build_reference_clip(self.src15, 0.5, 7.0, out, transcribe_fn=lambda _p: "확인", policy=pol)
            self.assertTrue(r["ready"], r)
            self.assertNotIn(rr.WARN_OUTSIDE_RECOMMENDED, r["warning_codes"])

    # ── recommend_region ─────────────────────────────────────────────────────
    def test_recommend_targets_recommended_range_for_both(self):
        for pol in (ra.GPTSOVITS_POLICY, ra.QWEN3_POLICY):
            r = rr.recommend_region(self.src15, policy=pol)
            self.assertTrue(r["ok"], r)
            self.assertTrue(3.0 <= r["dur_sec"] <= 10.0, r)

    def test_recommend_no_safe_pair_is_honest_for_both(self):
        for pol in (ra.GPTSOVITS_POLICY, ra.QWEN3_POLICY):
            r = rr.recommend_region(self.src30, policy=pol)
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "no_safe_boundary_pair")

    # ── analysis_payload(ref-analyze 응답) ────────────────────────────────────
    def test_payload_long_file_gptsovits_requires_region(self):
        p = rr.analysis_payload(self.src15, ra.GPTSOVITS_POLICY, include_peaks=False)
        self.assertTrue(p["needs_region"])
        self.assertTrue(p["region_required"])
        self.assertFalse(p["valid_whole"])
        self.assertEqual(p["policy"]["engine"], "gptsovits")
        self.assertEqual(p["policy"]["required"], {"min_sec": 3.0, "max_sec": 10.0})
        self.assertIn("recommend", p)

    def test_payload_long_file_qwen3_recommends_region_but_not_required(self):
        p = rr.analysis_payload(self.src15, ra.QWEN3_POLICY, include_peaks=False)
        self.assertTrue(p["needs_region"])          # 자동 추천은 계속한다
        self.assertFalse(p["region_required"])      # 자르지 않아도 엔진이 거부하지 않는다
        self.assertTrue(p["valid_whole"])
        self.assertTrue(p["outside_recommended"])
        self.assertFalse(p["too_short"])
        self.assertEqual(p["policy"]["required"], {"min_sec": None, "max_sec": None})
        self.assertEqual(p["policy"]["recommended"], {"min_sec": 3.0, "max_sec": 10.0})
        self.assertIn("recommend", p)

    def test_payload_7s_file_ready_whole_for_both(self):
        p7 = os.path.join(self.tmp, "s7.wav")
        sf.write(p7, _tone(7.0), SR)
        for pol in (ra.GPTSOVITS_POLICY, ra.QWEN3_POLICY):
            p = rr.analysis_payload(p7, pol, include_peaks=False)
            self.assertFalse(p["needs_region"])
            self.assertFalse(p["region_required"])
            self.assertTrue(p["valid_whole"], p["errors"])
            self.assertFalse(p["outside_recommended"])

    def test_payload_2s_file_too_short_only_for_gptsovits(self):
        p2 = os.path.join(self.tmp, "s2.wav")
        sf.write(p2, _tone(2.0), SR)
        self.assertTrue(rr.analysis_payload(p2, ra.GPTSOVITS_POLICY, include_peaks=False)["too_short"])
        q = rr.analysis_payload(p2, ra.QWEN3_POLICY, include_peaks=False)
        self.assertFalse(q["too_short"])
        self.assertTrue(q["outside_recommended"])
        self.assertTrue(q["valid_whole"])


class SeparateWiring(unittest.TestCase):
    """separate.py 의 ref-analyze/ref-trim 이 정책 해석 함수를 거쳐 같은 정책을 모든 단계에 넘기는지(소스 계약)."""

    def setUp(self):
        here = os.path.dirname(os.path.abspath(__file__))
        self.src = io.open(os.path.join(here, "separate.py"), encoding="utf-8").read()

    def test_ref_modes_use_single_policy_resolution(self):
        self.assertIn("def _reference_policy(args):", self.src)
        self.assertIn("_ra.resolve_policy_engine(preferred, qwen_ok)", self.src)
        block = self.src[self.src.index('if args.mode == "ref-analyze":'):self.src.index('if args.mode == "ref-trim":')]
        self.assertIn("rr.analysis_payload(args.input, _policy)", block)
        self.assertNotIn("GPTSOVITS_POLICY", block)
        trim = self.src[self.src.index('if args.mode == "ref-trim":'):]
        trim = trim[:trim.index('emit("result", clip_path=out_path, metrics=metrics)')]
        self.assertIn("out_path, policy=_policy)", trim)
        self.assertIn('rr.analyze_region(out_path, 0.0, eff["dur_sec"], policy=_policy)', trim)
        self.assertNotIn("GPTSOVITS_POLICY", trim)

    def test_no_hardcoded_length_numbers_in_region_module(self):
        here = os.path.dirname(os.path.abspath(__file__))
        region = io.open(os.path.join(here, "reference_region.py"), encoding="utf-8").read()
        code = "\n".join(l for l in region.splitlines() if not l.strip().startswith("#") and '"""' not in l)
        # 길이 정책 숫자(3.0/10.0초 비교)가 코드에 남아 있지 않다. 3.0 이 든 다른 상수(예: -3.0 가중치)는 허용.
        self.assertIsNone(re.search(r"actual_dur\s*[<>]=?\s*(3\.0|10\.0)", code))
        self.assertIsNone(re.search(r"best_between\(3\.0,\s*10\.0\)", code))
        self.assertIsNone(re.search(r"min_sec=3\.0,\s*max_sec=10\.0", code))


if __name__ == "__main__":
    unittest.main()
