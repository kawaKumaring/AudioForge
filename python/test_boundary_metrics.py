# -*- coding: utf-8 -*-
"""boundary_metrics.py 단위 테스트 — SYNTHETIC 신호만(사용자 음성/실제 오디오 파일 미사용).

전 신호는 numpy 로 생성하고 난수는 고정 seed 만 쓴다(벽시계·환경 의존 없음 → 반복 실행 동일 결과).
프로덕션 파일은 하나도 import 하지 않는다 — 계측 대상은 boundary_metrics 뿐이며, 결합 규칙은
boundary_metrics.concat_with_boundaries_array 가 tts_worker._concat_with_boundaries 를 미러한다.

8 케이스 매트릭스(케이스 id 는 CASES 참조):
  1 no_emotion_single      감정 없음 + 단일 chunk        → join 없음
  2 emotion_single         감정 있음 + 단일 chunk        → join 없음
  3 autosplit_same_emotion 동일 감정 자동분할 2 chunk     → join 1개(gap 0), 매끄러움
  4 emotion_immediate      감정 전환 즉시                 → join 1개(gap 0)
  5 emotion_pause          감정 전환 + 쉼                 → join 1개(gap > 0)
  6 discontinuity          join 에 큰 단차 주입            → sample_jump 급증
  7 trailing_residue       join 직전 저에너지 잔향         → trailing_low_energy_len 급증
  8 trailing_consonant     join 직전 짧은 고역 자음 버스트  → 7과 반드시 구별되어야 함

실행:  python test_boundary_metrics.py   (또는 python -m unittest test_boundary_metrics)
"""
import ast
import io
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import boundary_metrics as bm


SR = 24000
TONE_F = 200.0          # sr 24000 에서 정확히 120 샘플 주기
TONE2_F = 260.0
AMP = 0.35

WIN = int(round(bm.WINDOW_MS * SR / 1000.0))        # 1200 샘플
FRAME = int(round(bm.TRAILING_FRAME_MS * SR / 1000.0))  # 120 샘플

RESIDUE_SEED = 20260826
BURST_SEED = 11


# ────────────────────────── 결정적 합성 신호 빌더 ──────────────────────────

def _tone(n, f=TONE_F, amp=AMP, start=0):
    """위상 연속 사인. start 를 주면 같은 파형의 이어지는 구간을 얻는다(자동분할 미러)."""
    idx = np.arange(start, start + n, dtype=np.float64)
    return (amp * np.sin(2.0 * np.pi * f * idx / SR)).astype(np.float32)


def _scaled_noise(n, peak, seed):
    """고정 seed 백색잡음을 지정 peak 로 정규화(결정적)."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    m = float(np.max(np.abs(x)))
    return (x / m * peak).astype(np.float32)


def _hf_burst(n, peak, seed):
    """고역 편중 버스트 = 백색잡음의 1차 차분(고역 강조) 후 peak 정규화. 실제 말끝 자음/파열음 대역
    특성을 흉내낸 것이며, 잔향(_scaled_noise 저레벨)과 달리 **레벨이 살아있는 음성 성분**이다."""
    rng = np.random.default_rng(seed)
    x = np.diff(rng.standard_normal(n + 1))
    m = float(np.max(np.abs(x)))
    return (x / m * peak).astype(np.float32)


# 자동분할 미러: 하나의 연속 파형을 두 chunk 로 자른다(합치면 원파형과 동일).
_SPLIT_TOTAL = 9600
_SPLIT_AT = 4831            # (4830 = 40주기+30샘플) → 자르는 지점이 사인 peak 부근


def make_case(case_id):
    """케이스 id → (signal, boundaries). 전 케이스 결정적."""
    if case_id == "no_emotion_single":
        chunks = [dict(audio=_tone(_SPLIT_TOTAL), original_segment_index=0,
                       chunk_index=0, emotion_id="default")]

    elif case_id == "emotion_single":
        chunks = [dict(audio=_tone(_SPLIT_TOTAL), original_segment_index=0,
                       chunk_index=0, emotion_id="excited")]

    elif case_id in ("autosplit_same_emotion", "discontinuity"):
        full = _tone(_SPLIT_TOTAL)
        a, b = full[:_SPLIT_AT], full[_SPLIT_AT:]
        if case_id == "discontinuity":
            b = (-b).astype(np.float32)     # 위상 반전 = 순수 단차 주입(레벨/스펙트럼은 동일)
        chunks = [
            dict(audio=a, original_segment_index=0, chunk_index=0, emotion_id="calm"),
            dict(audio=b, original_segment_index=0, chunk_index=1, emotion_id="calm"),
        ]

    elif case_id in ("emotion_immediate", "emotion_pause"):
        gap = 0 if case_id == "emotion_immediate" else int(0.200 * SR)   # 200 ms
        chunks = [
            dict(audio=_tone(6000, f=TONE_F), original_segment_index=0,
                 chunk_index=0, emotion_id="calm"),
            dict(audio=_tone(6000, f=TONE2_F), original_segment_index=1,
                 chunk_index=0, emotion_id="excited", gap_samples=gap),
        ]

    elif case_id in ("trailing_residue", "trailing_consonant"):
        if case_id == "trailing_residue":
            tail = _scaled_noise(4800, peak=0.004, seed=RESIDUE_SEED)    # 200 ms 저레벨 잔향
        else:
            tail = _hf_burst(600, peak=0.12, seed=BURST_SEED)            # 25 ms 자음 버스트
        a = np.concatenate([_tone(12000, f=TONE_F), tail]).astype(np.float32)
        chunks = [
            dict(audio=a, original_segment_index=0, chunk_index=0, emotion_id="calm"),
            dict(audio=_tone(6000, f=TONE2_F), original_segment_index=0,
                 chunk_index=1, emotion_id="calm"),
        ]

    else:
        raise AssertionError(f"unknown case: {case_id}")

    return bm.build_concat_case(chunks)


CASES = ("no_emotion_single", "emotion_single", "autosplit_same_emotion",
         "emotion_immediate", "emotion_pause", "discontinuity",
         "trailing_residue", "trailing_consonant")

NO_JOIN_CASES = ("no_emotion_single", "emotion_single")
SMOOTH_JOIN_CASES = ("autosplit_same_emotion", "emotion_immediate", "emotion_pause")


def metrics_for(case_id):
    sig, bounds = make_case(case_id)
    return bm.compute_boundary_metrics(sig, SR, bounds)


def single_record(case_id):
    recs = metrics_for(case_id)
    assert len(recs) == 1, f"{case_id}: 경계 {len(recs)}개"
    return recs[0]


# ────────────────────────── 1) 구조: join 유무 ──────────────────────────

class TestStructure(unittest.TestCase):

    def test_case1_no_emotion_single_chunk_has_no_join(self):
        sig, bounds = make_case("no_emotion_single")
        self.assertEqual(len(bounds), 0, "단일 chunk 는 join 이 없어야 한다")
        self.assertEqual(bm.compute_boundary_metrics(sig, SR, bounds), [])

    def test_case2_emotion_single_chunk_has_no_join(self):
        sig, bounds = make_case("emotion_single")
        self.assertEqual(len(bounds), 0, "감정이 있어도 단일 chunk 면 join 이 없다")
        self.assertEqual(bm.compute_boundary_metrics(sig, SR, bounds), [])

    def test_case3_autosplit_join_exists_and_is_finite(self):
        r = single_record("autosplit_same_emotion")
        self.assertEqual(r["declared_gap_samples"], 0, "자동분할 내부 join 의 gap 은 항상 0")
        self.assertEqual(r["chunk_index"], 1)
        self.assertEqual(r["original_segment_index"], 0, "자동분할은 원 segment 가 같다")
        self.assertEqual(r["emotion_id"], "calm")
        for k in bm.RECORD_FIELDS:
            if k == "emotion_id":
                continue
            self.assertTrue(math.isfinite(float(r[k])), f"{k} 가 비유한")

    def test_case4_emotion_transition_immediate_has_zero_gap(self):
        r = single_record("emotion_immediate")
        self.assertEqual(r["declared_gap_samples"], 0, "immediate 전환은 무음 0")
        self.assertEqual(r["original_segment_index"], 1, "원 segment 경계")
        self.assertEqual(r["emotion_id"], "excited", "레코드는 join 이후 감정을 식별한다")

    def test_case5_emotion_transition_pause_has_declared_gap(self):
        r = single_record("emotion_pause")
        self.assertEqual(r["declared_gap_samples"], int(0.200 * SR))
        # 선언 무음은 창에서 제외된다 — 그렇지 않으면 next_head_rms 가 0 으로 희석된다.
        self.assertGreater(r["next_head_rms"], 0.15,
                           "next 창은 gap 이후 실제 오디오에서 재야 한다")
        self.assertGreater(r["prev_tail_rms"], 0.15)

    def test_declared_fade_and_padding_are_zero_at_joins(self):
        # 프로덕션에서 tail fade/padding 은 결합 후 파일 끝에 1회만 적용된다(join 에는 없다).
        for case_id in SMOOTH_JOIN_CASES + ("discontinuity",):
            r = single_record(case_id)
            self.assertEqual(r["declared_fade_samples"], 0, case_id)
            self.assertEqual(r["declared_padding_samples"], 0, case_id)


# ────────────────────────── 2) 케이스 6: 단차 ──────────────────────────

class TestDiscontinuity(unittest.TestCase):

    def test_case6_sample_jump_dominates_smooth_joins(self):
        disc = single_record("discontinuity")["sample_jump"]
        smooth = [single_record(c)["sample_jump"] for c in SMOOTH_JOIN_CASES]
        worst_smooth = max(smooth)
        self.assertGreater(disc, 10.0 * worst_smooth,
                           f"단차 {disc:.6g} 가 매끄러운 join 최대 {worst_smooth:.6g} 를 압도하지 못함")
        # 이론 상한: 200 Hz·0.35 사인의 최대 1샘플 기울기.
        self.assertLess(worst_smooth, AMP * 2.0 * math.pi * TONE_F / SR * 1.05)

    def test_case6_isolates_the_seam_only(self):
        """단차는 이음매만 바꾼다 — 창 레벨/고역 에너지는 케이스 3과 사실상 같아야 한다."""
        base = single_record("autosplit_same_emotion")
        disc = single_record("discontinuity")
        for k in ("prev_tail_rms", "next_head_rms", "hf_energy_prev", "hf_energy_next"):
            self.assertAlmostEqual(base[k], disc[k], places=6, msg=k)
        self.assertEqual(base["trailing_low_energy_len"], disc["trailing_low_energy_len"])


# ────────────────────────── 3) 케이스 7 vs 8: 잔향 vs 자음 ──────────────────────────

class TestTrailingDiscrimination(unittest.TestCase):

    def test_case7_residue_produces_long_trailing_low_energy(self):
        r = single_record("trailing_residue")
        self.assertGreaterEqual(r["trailing_low_energy_len"], 4000,
                                "200 ms 잔향이 저에너지 꼬리로 잡혀야 한다")
        self.assertLessEqual(r["trailing_low_energy_len"], 4800 + FRAME)

    def test_clean_joins_have_no_trailing_low_energy(self):
        for case_id in SMOOTH_JOIN_CASES:
            self.assertEqual(single_record(case_id)["trailing_low_energy_len"], 0, case_id)

    def test_case8_consonant_is_not_flagged_as_low_energy(self):
        """핵심: 진짜 말끝 자음은 저에너지 꼬리로 잡히면 안 된다(삭제 위험 회피)."""
        r = single_record("trailing_consonant")
        self.assertLessEqual(r["trailing_low_energy_len"], FRAME,
                             "자음 버스트가 잔향으로 오인됨 — 삭제 위험")

    def test_case7_vs_case8_are_separated(self):
        res = single_record("trailing_residue")
        con = single_record("trailing_consonant")
        # (a) 레벨 독립 분리자 — 상대 임계 기반 꼬리 길이.
        self.assertGreater(res["trailing_low_energy_len"],
                           con["trailing_low_energy_len"] + 3000)
        # (b) 레벨 의존 보강자 — 창 RMS/peak.
        self.assertGreater(con["prev_tail_rms"], 20.0 * res["prev_tail_rms"])
        self.assertGreater(con["prev_tail_peak"], 10.0 * res["prev_tail_peak"])
        # (c) 고역 에너지(절대) — 자음 버스트가 잔향보다 자릿수 단위로 크다.
        self.assertGreater(con["hf_energy_prev"], 50.0 * res["hf_energy_prev"])
        # (d) hf_energy_delta 부호: 잔향→다음 음성은 고역 증가(+), 자음→다음 음성은 감소(-).
        self.assertGreater(res["hf_energy_delta"], 0.0)
        self.assertLess(con["hf_energy_delta"], 0.0)

    def test_case8_is_also_separated_from_clean_tone_join(self):
        """자음 버스트는 깨끗한 모음 join 과도 고역 에너지로 구별된다(그냥 '큰 소리'가 아님)."""
        clean = single_record("autosplit_same_emotion")
        con = single_record("trailing_consonant")
        self.assertGreater(con["hf_energy_prev"], 5.0 * clean["hf_energy_prev"])


# ────────────────────────── 4) 창 클램핑 / 결합 규칙 미러 ──────────────────────────

class TestWindowingAndConcatMirror(unittest.TestCase):

    def test_concat_mirror_ignores_leading_gap_like_production(self):
        a = np.ones(10, dtype=np.float32)
        b = np.ones(10, dtype=np.float32) * 2.0
        out = bm.concat_with_boundaries_array([a, b], [999, 4])
        self.assertEqual(out.size, 24, "gaps_before[0] 은 무시되어야 한다(프로덕션 동일)")
        self.assertTrue(np.all(out[10:14] == 0.0))

    def test_windows_do_not_cross_neighbouring_joins(self):
        """중간 chunk 가 창보다 짧아도 앞/뒤 chunk 오디오가 창에 섞이면 안 된다."""
        loud = (np.ones(6000, dtype=np.float32) * 0.9)
        middle = _tone(480, f=TONE_F, amp=0.1)          # 20 ms < 50 ms 창
        last = _tone(6000, f=TONE2_F, amp=0.9)
        sig, bounds = bm.build_concat_case([
            dict(audio=loud, original_segment_index=0, chunk_index=0, emotion_id="calm"),
            dict(audio=middle, original_segment_index=1, chunk_index=0, emotion_id="calm"),
            dict(audio=last, original_segment_index=2, chunk_index=0, emotion_id="calm"),
        ])
        recs = bm.compute_boundary_metrics(sig, SR, bounds)
        self.assertEqual(len(recs), 2)
        second = recs[1]
        self.assertLess(second["prev_tail_peak"], 0.2,
                        "두 번째 join 의 prev 창이 첫 chunk(0.9)까지 넘어갔다")

    def test_records_follow_descriptor_order(self):
        sig, bounds = bm.build_concat_case([
            dict(audio=_tone(3000), original_segment_index=0, chunk_index=0, emotion_id="a"),
            dict(audio=_tone(3000), original_segment_index=1, chunk_index=0, emotion_id="b"),
            dict(audio=_tone(3000), original_segment_index=2, chunk_index=0, emotion_id="c"),
        ])
        recs = bm.compute_boundary_metrics(sig, SR, bounds)
        self.assertEqual([r["emotion_id"] for r in recs], ["b", "c"])

    def test_rejects_out_of_range_join(self):
        sig = _tone(1000)
        bad = [bm.BoundaryPoint(join_index=1000, original_segment_index=0,
                                chunk_index=1, emotion_id="calm")]
        with self.assertRaises(bm.BoundaryMetricsError):
            bm.compute_boundary_metrics(sig, SR, bad)

    def test_rejects_non_finite_signal(self):
        sig = _tone(1000).copy()
        sig[10] = np.nan
        b = [bm.BoundaryPoint(join_index=500, original_segment_index=0,
                              chunk_index=1, emotion_id="calm")]
        with self.assertRaises(bm.BoundaryMetricsError):
            bm.compute_boundary_metrics(sig, SR, b)


# ────────────────────────── 5) 프라이버시(하드 요건) ──────────────────────────

# onset_continuity_metrics 는 계측 1차 함수의 단일 권위이며 동일한 순수성 보증을 받는다
# (test_onset_continuity_metrics.py 가 같은 AST 검사를 그 모듈에 적용한다).
_ALLOWED_IMPORTS = {"math", "re", "dataclasses", "typing", "numpy", "onset_continuity_metrics"}
_FORBIDDEN_CALLS = {"open", "print", "exec", "eval", "input", "compile", "__import__"}


def _module_source():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boundary_metrics.py")
    with io.open(path, "r", encoding="utf-8") as fh:
        return fh.read()


class TestPrivacy(unittest.TestCase):

    def test_serialised_record_has_only_numbers_indices_and_emotion_id(self):
        for case_id in CASES:
            for rec in bm.serialize_records(metrics_for(case_id)):
                self.assertEqual(set(rec.keys()), set(bm.RECORD_FIELDS), case_id)
                for key, value in rec.items():
                    if key == "emotion_id":
                        self.assertRegex(value, bm.SAFE_EMOTION_ID)
                        continue
                    self.assertIsInstance(value, (int, float), f"{case_id}/{key}")
                    self.assertNotIsInstance(value, bool, f"{case_id}/{key}")

    def test_serialised_output_contains_no_path_like_or_text_content(self):
        forbidden_substrings = ("/", "\\", ":", " ", ".wav", ".txt", ".json",
                                "C:", "Users", "python")
        for case_id in CASES:
            blob = bm.format_records(metrics_for(case_id))
            for line in blob.splitlines()[1:]:          # 헤더(필드명)는 제외
                for cell in line.split("\t"):
                    for bad in forbidden_substrings:
                        self.assertNotIn(bad, cell, f"{case_id}: '{cell}' 에 '{bad}'")

    def test_serializer_rejects_path_like_emotion_id(self):
        base = single_record("emotion_immediate")
        for poison in (r"C:\Users\kawae\script.txt",
                       "/home/user/ref.wav",
                       "안녕하세요 이건 대사입니다",
                       "reference transcript text",
                       "a" * 64):
            rec = dict(base)
            rec["emotion_id"] = poison
            with self.assertRaises(bm.PrivacyViolation):
                bm.serialize_record(rec)

    def test_serializer_rejects_extra_fields(self):
        rec = dict(single_record("emotion_immediate"))
        rec["source_path"] = "C:/tmp/synthesized.wav"
        with self.assertRaises(bm.PrivacyViolation):
            bm.serialize_record(rec)

    def test_serializer_rejects_audio_samples_in_a_field(self):
        rec = dict(single_record("emotion_immediate"))
        rec["prev_tail_rms"] = [0.1, 0.2, 0.3]
        with self.assertRaises(bm.PrivacyViolation):
            bm.serialize_record(rec)

    def test_module_cannot_do_io_or_logging(self):
        """정적 보증: 모듈이 파일/네트워크/로그/서브프로세스에 손댈 수 없음을 AST 로 확인한다."""
        tree = ast.parse(_module_source())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        self.assertTrue(imported <= _ALLOWED_IMPORTS,
                        f"허용되지 않은 import: {sorted(imported - _ALLOWED_IMPORTS)}")
        # import 가 위 allowlist 로 묶였으므로 남은 위험은 builtins 직접 호출뿐이다.
        called = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                called.add(node.func.id)
        self.assertEqual(called & _FORBIDDEN_CALLS, set(),
                         f"금지된 builtins 호출: {sorted(called & _FORBIDDEN_CALLS)}")


# ────────────────────────── 6) 결정성 ──────────────────────────

class TestDeterminism(unittest.TestCase):

    def test_same_case_yields_identical_records_across_runs(self):
        for case_id in CASES:
            first = bm.serialize_records(metrics_for(case_id))
            second = bm.serialize_records(metrics_for(case_id))
            self.assertEqual(first, second, case_id)

    def test_builders_are_seeded(self):
        self.assertTrue(np.array_equal(_scaled_noise(64, 0.004, RESIDUE_SEED),
                                       _scaled_noise(64, 0.004, RESIDUE_SEED)))
        self.assertTrue(np.array_equal(_hf_burst(64, 0.12, BURST_SEED),
                                       _hf_burst(64, 0.12, BURST_SEED)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
