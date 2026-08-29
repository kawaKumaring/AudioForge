# -*- coding: utf-8 -*-
"""B envelope 1단계 — 조립 중 열리는 **내부 segment 경계**에만 fade 를 거는 계약의 회귀 테스트.

계약(사용자 확정):
  - 같은 생성 chunk 안에서 이어진 문장은 접합 지점이 아니다 → 적용 0.
  - 실제로 독립 생성된 segment 를 조립하며 휴지가 존재하는 경계에만 적용.
  - kind ∈ {line, paragraph, explicitPause} → 앞 segment 끝 inverted ease-out + 뒤 segment 시작 ease-in.
  - kind ∈ {internal, emotion} → 적용 0. 문장 내부 자동 chunk 경계 → 적용 0.
  - 최종 파일 시작·끝은 _finish_and_place 단일 권위 → 이 단계가 **구조적으로** 닿을 수 없다.
  - 길이·pause 값·onset 10ms·offset 20ms 는 바꾸지 않는다.

'무엇이 경계인가' 는 오직 파서 kind 로만 판정한다 — 이 파일도 문장부호 규칙을 새로 만들지 않고
classify_plan_boundaries 의 kind 를 **먼저 단언**한 뒤 오디오 결과를 센다.

사용자 미디어는 읽지 않는다 — 전부 SYNTHETIC(DC 상수 / 대역 잡음) 신호다.
"""
import math
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tts_grammar as g          # noqa: E402
import tts_worker as w           # noqa: E402
import semantic_chunk_planner as scp   # noqa: E402

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:                                     # pragma: no cover
    HAS_NUMPY = False

try:
    import soundfile as sf
    HAS_SOUNDFILE = True
except ImportError:                                     # pragma: no cover
    HAS_SOUNDFILE = False

_DEFER = "numpy/soundfile 부재 — 공유 qwen venv 에서 실행"

SR = 24000
ONSET_N = 240      # 10ms @ 24k — audio_finishing 계약값(여기서 바꾸지 않는다)
OFFSET_N = 480     # 20ms @ 24k
CHUNK_N = 4800     # 200ms — 두 창을 합쳐도 여유 있는 길이


def kinds_of(raw):
    """파서 → 경계 kind 목록. 이 파일의 '무엇이 경계인가' 단일 소스."""
    plan = g.parse_tts_script(raw)["plan"]
    return [e["kind"] for e in scp.classify_plan_boundaries(plan)]


@unittest.skipUnless(HAS_NUMPY and HAS_SOUNDFILE, _DEFER)
class SegmentEnvelopeBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="af-segenv-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # ── SYNTHETIC 재료 ──
    def dc_chunks(self, layout, level=0.5, n=CHUNK_N, subtype="FLOAT"):
        """layout = [(osi, ci), ...]. chunk 마다 **서로 다른 DC 상수**로 채운다 —
        결과 배열을 상수로 나누면 그 chunk 에 걸린 gain 곡선이 그대로 보인다(기울어진 구간을 정확히 셀 수 있다)."""
        paths, entries = [], []
        for i, (osi, ci) in enumerate(layout):
            p = os.path.join(self.dir, "c%02d.wav" % i)
            sf.write(p, np.full(n, level, dtype=np.float32), SR, subtype=subtype)
            paths.append(p)
            entries.append({"original_segment_index": osi, "chunk_index": ci})
        return paths, entries

    def read(self, path):
        d, sr = sf.read(path, dtype="float32")
        self.assertEqual(sr, SR)
        return d

    def gain_of(self, path, level=0.5):
        return self.read(path) / level

    def sloped_count(self, gain, tol=1e-6):
        """gain 배열에서 1.0 이 아닌 샘플 수 — '기울어진 구간'의 크기."""
        return int(np.count_nonzero(np.abs(gain - 1.0) > tol))

    def run_stage(self, paths, entries, raw=None, kinds=None):
        if kinds is None:
            kinds = kinds_of(raw)
        return w._apply_segment_envelopes(paths, entries, kinds, self.dir)


class AppliesOnlyAtOpenSegmentBoundaries(SegmentEnvelopeBase):
    """경계가 열린 자리에만, 그리고 딱 한 번씩."""

    def test_multi_chunk_sentence_gets_exactly_one_onset_and_one_offset(self):
        """한 문장이 여러 chunk 로 나뉘어도 그 문장에 걸리는 것은 **시작 1 · 끝 1** 이다.
        (가운데 chunk 들은 전혀 손대지 않는다 — 문장 내부 자동 chunk 경계 적용 0.)"""
        raw = "가나다\n라마바\n사아자"
        self.assertEqual(kinds_of(raw), ["internal", "line", "line"])
        layout = [(0, 0), (1, 0), (1, 1), (1, 2), (2, 0)]   # 가운데 문장만 3 chunk
        paths, entries = self.dc_chunks(layout)
        out, meta = self.run_stage(paths, entries, raw)

        mid_first, mid_mid, mid_last = self.gain_of(out[1]), self.gain_of(out[2]), self.gain_of(out[3])
        # 시작 1회: 첫 chunk 앞머리만 기울어졌다.
        self.assertEqual(self.sloped_count(mid_first), ONSET_N)
        self.assertLess(float(mid_first[0]), 1e-6)
        self.assertEqual(self.sloped_count(mid_first[ONSET_N:]), 0)
        # 끝 1회: 마지막 chunk 말미만 기울어졌다.
        self.assertEqual(self.sloped_count(mid_last), OFFSET_N)
        self.assertLess(float(mid_last[-1]), 1e-6)
        self.assertEqual(self.sloped_count(mid_last[:-OFFSET_N]), 0)
        # 문장 내부 chunk 는 gain 1 그대로.
        self.assertEqual(self.sloped_count(mid_mid), 0)
        self.assertEqual(out[2], paths[2], "손대지 않은 chunk 는 원본 경로 그대로여야 한다")

    def test_each_open_boundary_gets_one_onset_and_one_offset(self):
        """여러 문장 — 열린 경계마다 정확히 한 쌍(앞 끝 · 뒤 시작)."""
        raw = "가나다\n라마바\n사아자"
        paths, entries = self.dc_chunks([(0, 0), (1, 0), (2, 0)])
        out, meta = self.run_stage(paths, entries, raw)
        self.assertEqual(meta["segment_envelope_onset_count"], 2)
        self.assertEqual(meta["segment_envelope_offset_count"], 2)
        self.assertEqual(meta["segment_envelope_kind_counts"], {"line": 2})
        # seg0 = 끝만 / seg1 = 양쪽 / seg2 = 시작만
        g0, g1, g2 = (self.gain_of(p) for p in out)
        self.assertEqual(self.sloped_count(g0), OFFSET_N)
        self.assertEqual(self.sloped_count(g1), ONSET_N + OFFSET_N)
        self.assertEqual(self.sloped_count(g2), ONSET_N)

    def test_internal_chunk_boundaries_are_untouched(self):
        """문장 하나가 여러 chunk 인데 경계가 하나도 안 열린 경우 — 전부 무적용."""
        paths, entries = self.dc_chunks([(0, 0), (0, 1), (0, 2)])
        out, meta = self.run_stage(paths, entries, kinds=["internal"])
        self.assertEqual(out, paths)
        self.assertEqual(meta["segment_envelope_onset_count"], 0)
        self.assertEqual(meta["segment_envelope_offset_count"], 0)
        for p in out:
            self.assertEqual(self.sloped_count(self.gain_of(p)), 0)

    def test_comma_is_not_a_boundary(self):
        """쉼표는 파서가 아예 끊지 않는다 → segment 하나 → 적용 0."""
        raw = "안녕, 반가워"
        ks = kinds_of(raw)
        self.assertEqual(ks, ["internal"], "쉼표는 segment 를 만들지 않는다")
        paths, entries = self.dc_chunks([(0, 0), (0, 1)])
        out, meta = self.run_stage(paths, entries, kinds=ks)
        self.assertEqual(meta["segment_envelope_onset_count"], 0)
        self.assertEqual(meta["segment_envelope_offset_count"], 0)
        self.assertEqual(sum(self.sloped_count(self.gain_of(p)) for p in out), 0)

    def test_emotion_tag_boundary_is_not_applied(self):
        """감정 전환 경계 — kind 가 emotion 임을 먼저 단언하고, 적용 0 을 센다."""
        raw = "[기쁨] 안녕 [명랑] 반가워"
        ks = kinds_of(raw)
        self.assertEqual(ks, ["internal", "emotion"], "감정 전환 경계는 kind=emotion")
        paths, entries = self.dc_chunks([(0, 0), (1, 0)])
        out, meta = self.run_stage(paths, entries, kinds=ks)
        self.assertEqual(meta["segment_envelope_onset_count"], 0)
        self.assertEqual(meta["segment_envelope_offset_count"], 0)
        self.assertEqual(meta["segment_envelope_kind_counts"], {})
        self.assertEqual(sum(self.sloped_count(self.gain_of(p)) for p in out), 0)

    def test_line_paragraph_and_explicit_pause_are_applied(self):
        """줄바꿈(문장 종결 줄) · 빈 줄(문단) · 명시적 쉼 — 셋 다 열린 경계다."""
        cases = [("안녕하세요.\n반갑습니다.", "line"),
                 ("안녕하세요.\n\n반갑습니다.", "paragraph"),
                 ("안녕하세요. [쉼 0.5] 반갑습니다.", "explicitPause")]
        for raw, expect in cases:
            ks = kinds_of(raw)
            self.assertEqual(ks, ["internal", expect], repr(raw[:8]))
            paths, entries = self.dc_chunks([(0, 0), (1, 0)])
            out, meta = self.run_stage(paths, entries, kinds=ks)
            self.assertEqual(meta["segment_envelope_kind_counts"], {expect: 1}, expect)
            self.assertEqual(self.sloped_count(self.gain_of(out[0])), OFFSET_N, expect)
            self.assertEqual(self.sloped_count(self.gain_of(out[1])), ONSET_N, expect)


class NoOverlapWithFinalFileEnvelope(SegmentEnvelopeBase):
    """최종 파일 양 끝(_finish_and_place 단일 권위)과의 중복 0."""

    def test_first_start_and_last_end_are_never_touched(self):
        """첫 chunk 의 앞 ONSET_N 과 마지막 chunk 의 뒤 OFFSET_N 은 이 단계가 손대지 않는다 —
        인덱스로 직접 단언한다(모든 경계가 열려 있어도 그렇다)."""
        raw = "가나다\n라마바\n사아자"
        paths, entries = self.dc_chunks([(0, 0), (1, 0), (2, 0)])
        out, meta = self.run_stage(paths, entries, raw)
        first, last = self.gain_of(out[0]), self.gain_of(out[-1])
        self.assertEqual(self.sloped_count(first[:ONSET_N]), 0, "최종 파일 시작 240샘플 무접촉")
        self.assertEqual(self.sloped_count(last[-OFFSET_N:]), 0, "최종 파일 끝 480샘플 무접촉")
        # 그 자리는 여전히 _finish_and_place 몫이므로 여기 기록에도 등장하지 않는다.
        for rec in meta["segment_envelope_applied"]:
            self.assertNotEqual(rec["onset_chunk"], [0, 0])
            self.assertNotEqual(rec["offset_chunk"], [2, 0])

    def test_structural_guard_rejects_touching_the_outer_ends(self):
        """구조적 차단이 살아 있는지 — 경계는 그룹 '사이'에만 생기므로 바깥 끝은 후보가 될 수 없다.
        단일 segment(경계 없음)에서는 어떤 kind 를 줘도 적용이 0 이다."""
        for k in ("line", "paragraph", "explicitPause"):
            paths, entries = self.dc_chunks([(0, 0), (0, 1)])
            out, meta = self.run_stage(paths, entries, kinds=[k])
            self.assertEqual(out, paths, k)
            self.assertEqual(meta["segment_envelope_applied"], [], k)


class PreservesSpeechAndAssemblyContracts(SegmentEnvelopeBase):
    """오디오 내용 · 조립 수치가 그대로인지."""

    def test_consonant_burst_and_last_syllable_survive(self):
        """첫 자음 보존 — 기존 버스트 보존 기준을 그대로 재사용한다(실측 8ms 버스트, 감쇠 1dB 미만).
        마지막 음절도 offset 창(20ms) 밖은 전혀 줄지 않는다."""
        import audio_finishing as af
        gi = af.smoothstep_fade_in_window(ONSET_N)
        i8 = int(round(8.0 * SR / 1000.0))
        atten_db = -20 * math.log10(float(gi[i8]))
        self.assertLess(atten_db, 1.0, f"8ms 버스트 감쇠 {atten_db:.2f} dB")

        raw = "가나다\n라마바"
        paths, entries = self.dc_chunks([(0, 0), (1, 0)])
        out, _ = self.run_stage(paths, entries, raw)
        tail_gain = self.gain_of(out[0])
        # 마지막 음절 = 창 밖. 창 직전 20ms 는 gain 정확히 1.
        self.assertEqual(self.sloped_count(tail_gain[:-OFFSET_N]), 0)
        head_gain = self.gain_of(out[1])
        self.assertGreater(float(head_gain[i8]), 10 ** (-1.0 / 20.0))

    def test_pause_layout_is_byte_identical(self):
        """문장 사이 pause 계약 보존 — envelope 전/후로 결합 layout(gap_before_samples·frames·
        start_sample)이 완전히 같다. 길이 불변이므로 pause 값이 흔들릴 여지가 없다."""
        raw = "가나다\n라마바\n사아자"
        _, gaps, kinds = w._boundary_gaps_from_plan(g.parse_tts_script(raw)["plan"], 0.3)
        layout_entries = [(0, 0), (1, 0), (1, 1), (2, 0)]
        gaps_before = [0.0, gaps[1], 0.0, gaps[2]]

        paths, entries = self.dc_chunks(layout_entries)
        before = w._concat_with_boundaries(paths, gaps_before,
                                           os.path.join(self.dir, "before.wav"))
        out, _ = self.run_stage(paths, entries, kinds=kinds)
        after = w._concat_with_boundaries(out, gaps_before,
                                          os.path.join(self.dir, "after.wav"))
        self.assertEqual(before, after)
        self.assertNotEqual(before[1]["gap_before_samples"], 0, "경계 무음이 실제로 있어야 의미 있는 단언")
        self.assertEqual(before[2]["gap_before_samples"], 0, "문장 내부 chunk joint 는 gap 0")
        # 결합본 길이도 같다.
        self.assertEqual(len(self.read(os.path.join(self.dir, "before.wav"))),
                         len(self.read(os.path.join(self.dir, "after.wav"))))

    def test_curve_shapes_match_the_existing_window_contract(self):
        """곡선 시작0끝1 · 역곡선 시작1끝0 — 기존 창 함수의 **실제 끝값 특성**을 그대로 존중한다.
        fade_in 의 마지막 값은 정확히 1 이 아니다(1 − 3/n²) — 거기에 맞춰 단언한다."""
        import audio_finishing as af
        raw = "가나다\n라마바"
        paths, entries = self.dc_chunks([(0, 0), (1, 0)])
        out, _ = self.run_stage(paths, entries, raw)

        fin = self.gain_of(out[1])[:ONSET_N]
        self.assertEqual(float(fin[0]), 0.0, "ease-in 시작은 정확히 0")
        self.assertAlmostEqual(float(fin[-1]), 1.0 - 3.0 / (ONSET_N ** 2), places=6)
        self.assertLess(float(fin[-1]), 1.0, "마지막 값이 정확히 1 이 아님을 명시적으로 고정")
        self.assertTrue(np.all(np.diff(fin) > 0), "단조 증가")
        np.testing.assert_allclose(fin, af.smoothstep_fade_in_window(ONSET_N), atol=1e-6)

        fout = self.gain_of(out[0])[-OFFSET_N:]
        self.assertEqual(float(fout[-1]), 0.0, "inverted ease-out 끝은 정확히 0")
        self.assertAlmostEqual(float(fout[0]), 1.0 - (3.0 / OFFSET_N ** 2 - 2.0 / OFFSET_N ** 3),
                               places=6)
        self.assertLess(float(fout[0]), 1.0, "역곡선 시작도 정확히 1 이 아니다(u=(k+1)/n 위상)")
        self.assertTrue(np.all(np.diff(fout) < 0), "단조 감소")
        np.testing.assert_allclose(fout, af.smoothstep_fade_out_window(OFFSET_N), atol=1e-6)

    def test_rewritten_chunk_interior_is_bit_identical_even_for_pcm16(self):
        """다시 쓴 chunk 라도 창 **밖**은 비트 단위로 같다 — subtype 을 보존하므로 재양자화가 없다.
        (PCM_16 → float32 → PCM_16 왕복이 무손실임을 실측으로 고정한다.)"""
        raw = "가나다\n라마바"
        rng = np.random.default_rng(5)
        paths, entries = [], []
        for i, (osi, ci) in enumerate([(0, 0), (1, 0)]):
            x = (rng.standard_normal(CHUNK_N) * 0.3).astype(np.float32)
            p = os.path.join(self.dir, "p%02d.wav" % i)
            sf.write(p, x, SR, subtype="PCM_16")
            paths.append(p)
            entries.append({"original_segment_index": osi, "chunk_index": ci})
        out, _ = self.run_stage(paths, entries, raw)
        for i, sl in ((0, slice(0, CHUNK_N - OFFSET_N)), (1, slice(ONSET_N, CHUNK_N))):
            self.assertEqual(sf.info(out[i]).subtype, "PCM_16", "subtype 보존")
            np.testing.assert_array_equal(self.read(paths[i])[sl], self.read(out[i])[sl])

    def test_no_nan_no_clipping_no_length_change(self):
        """NaN·clipping·길이 변화 없음 — 풀스케일에 가까운 신호로 확인."""
        raw = "가나다\n라마바\n사아자"
        layout = [(0, 0), (1, 0), (2, 0)]
        paths, entries = [], []
        rng = np.random.default_rng(3)
        for i, (osi, ci) in enumerate(layout):
            x = (0.99 * np.sign(rng.standard_normal(CHUNK_N))).astype(np.float32)
            p = os.path.join(self.dir, "f%02d.wav" % i)
            sf.write(p, x, SR, subtype="FLOAT")
            paths.append(p)
            entries.append({"original_segment_index": osi, "chunk_index": ci})
        out, _ = self.run_stage(paths, entries, raw)
        for src, dst in zip(paths, out):
            a, b = self.read(src), self.read(dst)
            self.assertEqual(len(a), len(b), "길이 불변")
            self.assertTrue(np.all(np.isfinite(b)), "NaN/inf 없음")
            self.assertLessEqual(float(np.max(np.abs(b))), float(np.max(np.abs(a))) + 1e-6,
                                 "gain ≤ 1 이므로 절대 커지지 않는다(clipping 없음)")
            self.assertLessEqual(float(np.max(np.abs(b))), 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
