# -*- coding: utf-8 -*-
"""asr_canonical 단위 테스트 — 합성 데이터만(실제 음성·Whisper·GPU·네트워크 없음).

검증 항목(임무 명세):
  세그먼트 시간 정렬·겹침·역전 / 빈·공백 세그먼트 / word timestamp 유무 /
  CJK·영문·숫자 합성 text / SRT index·시간형식·cue 길이 / 저음량·무음·짧은 발화 /
  confidence·provenance 보존 / 결정적 직렬화 / 전사 본문 로그 미노출.
"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr_canonical as ac


# 합성 전사 본문 — CJK(한/일/중) · 영문 · 숫자 혼합. 실제 음성에서 온 것이 아님.
CJK_KO = "안녕하세요 반갑습니다"
CJK_JA = "こんにちは 世界"
CJK_ZH = "你好世界"
EN_NUM = "Hello world 2026 test 42"


class ConfidenceTest(unittest.TestCase):
    def test_both_none_is_zero(self):
        self.assertEqual(ac.whisper_confidence(None, None), 0.0)

    def test_high_logprob_low_nospeech(self):
        # avg_logprob≈-0.1(거의 1), no_speech≈0.01 → 높은 confidence
        c = ac.whisper_confidence(-0.1, 0.01)
        self.assertGreater(c, 0.85)
        self.assertLessEqual(c, 1.0)

    def test_high_nospeech_pulls_down(self):
        # 무음 위 환각 의심(no_speech 높음) → confidence 급락
        c = ac.whisper_confidence(-0.1, 0.95)
        self.assertLess(c, 0.1)

    def test_clamped_range(self):
        # 극단 logprob 도 [0,1] 을 벗어나지 않는다.
        self.assertGreaterEqual(ac.whisper_confidence(-1000.0, 0.0), 0.0)
        self.assertLessEqual(ac.whisper_confidence(-1000.0, 0.0), 1.0)
        self.assertLessEqual(ac.whisper_confidence(5.0, 0.0), 1.0)  # 양수 logprob 도 <=1


class StatusTest(unittest.TestCase):
    def test_empty_text_is_empty(self):
        self.assertEqual(ac.classify_status("", 0.99), ac.SegmentStatus.EMPTY)
        self.assertEqual(ac.classify_status("   ", 0.99), ac.SegmentStatus.EMPTY)

    def test_confidence_thresholds(self):
        self.assertEqual(ac.classify_status("x", 0.10), ac.SegmentStatus.LOW_CONFIDENCE)
        self.assertEqual(ac.classify_status("x", 0.40), ac.SegmentStatus.REVIEW)
        self.assertEqual(ac.classify_status("x", 0.90), ac.SegmentStatus.OK)


class SegmentValidityTest(unittest.TestCase):
    def test_negative_start_rejected(self):
        with self.assertRaises(ValueError):
            ac.TranscriptSegment(start=-0.1, end=1.0)

    def test_end_before_start_rejected(self):
        with self.assertRaises(ValueError):
            ac.TranscriptSegment(start=2.0, end=1.0)

    def test_word_inversion_rejected(self):
        with self.assertRaises(ValueError):
            ac.WordTiming("x", 1.0, 0.5)

    def test_duration(self):
        seg = ac.make_segment(1.0, 2.5, text="x")
        self.assertAlmostEqual(seg.duration, 1.5)


class EmptySegmentTest(unittest.TestCase):
    def test_empty_and_whitespace_flagged(self):
        self.assertTrue(ac.make_segment(0.0, 1.0, text="").is_empty)
        self.assertTrue(ac.make_segment(0.0, 1.0, text="   ").is_empty)
        self.assertEqual(ac.make_segment(0.0, 1.0, text="  ").status, ac.SegmentStatus.EMPTY)

    def test_nonempty_not_flagged(self):
        self.assertFalse(ac.make_segment(0.0, 1.0, text=CJK_KO, avg_logprob=-0.1,
                                         no_speech_prob=0.01).is_empty)


class WordTimestampTest(unittest.TestCase):
    def test_segment_without_words(self):
        seg = ac.make_segment(0.0, 1.0, text=EN_NUM, avg_logprob=-0.2, no_speech_prob=0.02)
        self.assertFalse(seg.has_words)
        self.assertEqual(seg.to_dict()["has_words"], False)
        self.assertEqual(seg.to_dict()["words"], [])

    def test_segment_with_words(self):
        words = [ac.WordTiming("Hello", 0.0, 0.4, 0.9), ac.WordTiming("42", 0.4, 0.8, 0.8)]
        seg = ac.make_segment(0.0, 0.8, text=EN_NUM, words=words,
                              avg_logprob=-0.2, no_speech_prob=0.02)
        self.assertTrue(seg.has_words)
        self.assertEqual(len(seg.to_dict()["words"]), 2)

    def test_word_round_trip(self):
        w = ac.WordTiming("世界", 0.1, 0.2, 0.5)
        self.assertEqual(ac.WordTiming.from_dict(w.to_dict()).to_dict(), w.to_dict())


class WhisperIngestTest(unittest.TestCase):
    def test_segments_from_whisper_shape(self):
        whisper = [
            {"start": 0.0, "end": 1.0, "text": " " + CJK_JA + " ",
             "no_speech_prob": 0.02, "avg_logprob": -0.15,
             "words": [{"word": "こんにちは", "start": 0.0, "end": 0.5, "probability": 0.9},
                       {"word": "世界", "start": 0.5, "end": 1.0, "probability": 0.8}]},
            {"start": 1.0, "end": 2.0, "text": EN_NUM,
             "no_speech_prob": 0.4, "avg_logprob": -1.2},
        ]
        segs = ac.segments_from_whisper(whisper, language="ja")
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0].text, CJK_JA)  # strip 적용
        self.assertTrue(segs[0].has_words)
        self.assertFalse(segs[1].has_words)
        self.assertGreater(segs[0].confidence, segs[1].confidence)  # 첫째가 더 신뢰

    def test_empty_words_list(self):
        segs = ac.segments_from_whisper([{"start": 0.0, "end": 1.0, "text": "x", "words": []}])
        self.assertFalse(segs[0].has_words)


class SrtSanitizeTest(unittest.TestCase):
    def test_timestamp_format(self):
        # 3661.5s = 01:01:01,500 (ms 절삭 규약)
        self.assertEqual(ac.format_srt_timestamp(3661.5), "01:01:01,500")
        self.assertEqual(ac.format_srt_timestamp(0.0), "00:00:00,000")
        self.assertEqual(ac.format_srt_timestamp(-5.0), "00:00:00,000")

    def test_parity_with_production_fmt(self):
        # 프로덕션 audio_utils.fmt_srt_time 은 ms 절삭, 이 모듈은 ms 반올림 →
        # 두 결과는 항상 ≤1ms 이내로 일치(형식 호환). 배선 시 안전.
        from audio_utils import fmt_srt_time

        def _to_ms(ts):
            hms, ms = ts.split(",")
            h, m, s = hms.split(":")
            return ((int(h) * 3600 + int(m) * 60 + int(s)) * 1000) + int(ms)

        for t in (0.0, 1.234, 59.999, 61.5, 3661.001, 7200.0, 2.3):
            diff = abs(_to_ms(ac.format_srt_timestamp(t)) - _to_ms(fmt_srt_time(t)))
            self.assertLessEqual(diff, 1, f"{t}: >1ms 차이")

    def test_empty_cues_dropped(self):
        cues = [ac.SrtCue(0, 0.0, 1.0, ""), ac.SrtCue(0, 1.0, 2.0, "  "),
                ac.SrtCue(0, 2.0, 3.0, CJK_ZH)]
        out = ac.sanitize_srt_cues(cues)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].text, CJK_ZH)

    def test_reindexed_from_one(self):
        cues = [ac.SrtCue(99, 2.0, 3.0, "b"), ac.SrtCue(5, 0.0, 1.0, "a")]
        out = ac.sanitize_srt_cues(cues)
        self.assertEqual([c.index for c in out], [1, 2])
        self.assertEqual([c.text for c in out], ["a", "b"])  # 시간순 정렬

    def test_inversion_fixed(self):
        # end<start → 정규화 후 min_cue 로 복구(0길이 방지)
        out = ac.sanitize_srt_cues([ac.SrtCue(0, 5.0, 3.0, "x")], min_cue_sec=0.3)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0].start, 5.0)
        self.assertAlmostEqual(out[0].end, 5.3)

    def test_min_cue_extended(self):
        out = ac.sanitize_srt_cues([ac.SrtCue(0, 0.0, 0.1, "x")], min_cue_sec=0.3)
        self.assertAlmostEqual(out[0].end - out[0].start, 0.3)

    def test_max_cue_clamped(self):
        out = ac.sanitize_srt_cues([ac.SrtCue(0, 0.0, 100.0, "x")], max_cue_sec=7.0)
        self.assertAlmostEqual(out[0].end - out[0].start, 7.0)

    def test_overlap_pulled_back(self):
        # 두 cue 겹침 → 앞 cue end 를 뒤 start 로 당김(내용 보존)
        cues = [ac.SrtCue(0, 0.0, 5.0, "a"), ac.SrtCue(0, 2.0, 6.0, "b")]
        out = ac.sanitize_srt_cues(cues, min_cue_sec=0.3, max_cue_sec=7.0)
        self.assertLessEqual(out[0].end, out[1].start + 1e-9)

    def test_overlap_not_pulled_when_too_short(self):
        # 당기면 min_cue 가 깨지는 경우 → 내용 손실 방지 위해 그대로 둔다
        cues = [ac.SrtCue(0, 0.0, 5.0, "a"), ac.SrtCue(0, 0.1, 6.0, "b")]
        out = ac.sanitize_srt_cues(cues, min_cue_sec=0.3, max_cue_sec=7.0)
        self.assertEqual(len(out), 2)  # 둘 다 보존

    def test_render_format(self):
        cues = ac.sanitize_srt_cues([ac.SrtCue(0, 0.0, 1.0, EN_NUM)])
        srt = ac.render_srt(cues)
        lines = srt.split("\n")
        self.assertEqual(lines[0], "1")
        self.assertEqual(lines[1], "00:00:00,000 --> 00:00:01,000")
        self.assertEqual(lines[2], EN_NUM)

    def test_render_deterministic(self):
        cues = ac.sanitize_srt_cues([ac.SrtCue(0, 1.0, 2.0, "b"), ac.SrtCue(0, 0.0, 1.0, "a")])
        self.assertEqual(ac.render_srt(cues), ac.render_srt(cues))

    def test_empty_render(self):
        self.assertEqual(ac.render_srt([]), "")


class SilencePolicyTest(unittest.TestCase):
    def test_classify_level(self):
        self.assertEqual(ac.classify_level(0.0001), ac.LevelClass.SILENCE)   # 무음
        self.assertEqual(ac.classify_level(0.006), ac.LevelClass.LOW)        # 저음량(경계)
        self.assertEqual(ac.classify_level(0.11), ac.LevelClass.SPEECH)      # 명확한 발화

    def test_recommend_no_samples_returns_floor(self):
        self.assertEqual(ac.recommend_rms_threshold([]), ac.DEFAULT_RMS_THRESHOLD)

    def test_recommend_never_below_floor(self):
        # 아주 조용한 바닥이라도 기존 민감도(floor) 아래로 내려가지 않는다
        rec = ac.recommend_rms_threshold([0.0001, 0.0002, 0.00005])
        self.assertGreaterEqual(rec, ac.DEFAULT_RMS_THRESHOLD)

    def test_recommend_capped(self):
        # 시끄러운 바닥이라도 상한(floor×ceil_mult) 초과 금지 → 발화 과삭제 방지
        rec = ac.recommend_rms_threshold([1.0, 1.0, 1.0])
        self.assertLessEqual(rec, ac.DEFAULT_RMS_THRESHOLD * ac.DEFAULT_ADAPT_CEIL_MULT)

    def test_recommend_does_not_mutate_constants(self):
        before = ac.DEFAULT_RMS_THRESHOLD
        ac.recommend_rms_threshold([0.5, 0.5])
        self.assertEqual(ac.DEFAULT_RMS_THRESHOLD, before)

    def test_silence_policy_keeps_speech_drops_silence(self):
        # 저음량/무음/짧은 발화 혼합: 무음만 떨어지고 발화는 유지
        rms = [0.11, 0.0001, 0.11, 0.12]  # 하나만 무음
        dec = ac.apply_silence_policy(rms)
        self.assertFalse(dec.guard_tripped)
        self.assertEqual(dec.keep, (True, False, True, True))
        self.assertEqual(dec.kept_count, 3)

    def test_over_delete_guard(self):
        # 대부분 임계 미만(레벨 스케일 이상 의심) → 전부 유지, 가드 발동
        rms = [0.0001] * 8 + [0.11] * 2  # 20%만 유지될 상황 → 40% 미만 → 가드
        dec = ac.apply_silence_policy(rms)
        self.assertTrue(dec.guard_tripped)
        self.assertTrue(all(dec.keep))
        self.assertEqual(dec.kept_count, dec.total_count)

    def test_empty_input(self):
        dec = ac.apply_silence_policy([])
        self.assertEqual(dec.keep, ())
        self.assertFalse(dec.guard_tripped)

    def test_short_utterance_audible_kept(self):
        # 짧지만 명확히 들리는 발화(RMS 높음)는 유지된다 — 정책은 길이로 버리지 않음
        rms = [0.11, 0.11]
        dec = ac.apply_silence_policy(rms)
        self.assertTrue(all(dec.keep))

    def test_threshold_boundary_kept(self):
        # rms == threshold 는 유지(>= 규약). 바로 아래는 삭제.
        thr = ac.DEFAULT_RMS_THRESHOLD
        # 하나만 임계 미만이면 40% 가드 아래로 안 떨어지도록 다수를 명확 발화로.
        dec = ac.apply_silence_policy([thr, thr - 1e-9, 0.11, 0.11], threshold=thr)
        self.assertEqual(dec.keep, (True, False, True, True))


class ZeroLengthPolicyTest(unittest.TestCase):
    """0길이(end==start) 세그먼트 처리 — 프로덕션 b<=a '무조건 유지' 정합."""

    def test_zero_length_segment_is_valid_input(self):
        # canonical 계약: end==start 는 거부하지 않는다(end<start 만 거부).
        seg = ac.TranscriptSegment(start=1.0, end=1.0)   # 예외 없음
        self.assertEqual(seg.duration, 0.0)
        w = ac.WordTiming("x", 2.0, 2.0)                 # 예외 없음
        self.assertEqual(w.duration, 0.0)
        # end<start 는 여전히 거부.
        with self.assertRaises(ValueError):
            ac.TranscriptSegment(start=1.0, end=0.9)

    def test_zero_length_kept_unconditionally_even_if_silent(self):
        # duration<=0 항목은 RMS 가 임계 미만이어도(심지어 None 이어도) 무조건 유지.
        rms = [None, 0.11, 0.11]
        durs = [0.0, 1.0, 1.0]
        dec = ac.apply_silence_policy(rms, durations=durs)
        self.assertFalse(dec.guard_tripped)
        self.assertEqual(dec.keep, (True, True, True))

    def test_minimal_positive_duration_measured_normally(self):
        # 최소 양수 길이(측정 대상)는 임계로 정상 판정된다.
        rms = [0.0001, 0.11, 0.11]
        durs = [0.02, 1.0, 1.0]   # 전부 양수 → 전부 측정
        dec = ac.apply_silence_policy(rms, durations=durs)
        self.assertEqual(dec.keep, (False, True, True))  # 무음만 삭제

    def test_zero_length_counts_toward_guard(self):
        # 0길이 유지분도 kept 카운트에 포함(프로덕션과 동일).
        rms = [None, 0.0001, 0.0001]
        durs = [0.0, 1.0, 1.0]    # 1개 무조건 유지 + 2개 무음 삭제 → kept=1 < 3*0.4=1.2 → 가드
        dec = ac.apply_silence_policy(rms, durations=durs)
        self.assertTrue(dec.guard_tripped)
        self.assertTrue(all(dec.keep))

    def test_durations_length_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            ac.apply_silence_policy([0.1, 0.1], durations=[0.0])

    def test_validation_precedes_silence_policy_call_order(self):
        # 호출 순서: 세그먼트 생성(검증) → 그 뒤 순수 정책에 duration 전달.
        # 0길이 세그먼트가 정책에 '도달'하며, 도달 시 무조건 유지됨을 고정.
        segs = [
            ac.make_segment(0.0, 0.0, text="네"),          # 0길이(유효) — 검증 통과
            ac.make_segment(0.0, 2.0, text=CJK_KO,
                            avg_logprob=-0.1, no_speech_prob=0.0),
        ]
        # 세그먼트에서 정책 입력을 파생(오디오 없이 duration 만).
        durs = [s.duration for s in segs]
        rms = [None, 0.11]   # 0길이엔 RMS 없음(프로덕션도 측정 안 함)
        dec = ac.apply_silence_policy(rms, durations=durs)
        self.assertTrue(dec.keep[0])   # 0길이 세그먼트 보존
        self.assertTrue(dec.keep[1])


class DeterministicSerializationTest(unittest.TestCase):
    def _transcript(self):
        segs = [
            ac.make_segment(2.0, 3.0, text=CJK_ZH, avg_logprob=-0.3, no_speech_prob=0.05),
            ac.make_segment(0.0, 1.0, text=CJK_KO, avg_logprob=-0.1, no_speech_prob=0.01),
            ac.make_segment(1.0, 1.2, text=EN_NUM, avg_logprob=-0.5, no_speech_prob=0.1),
        ]
        return ac.CanonicalTranscript(
            segments=segs, language="ko",
            provenance={"model": "large-v3", "task": "transcribe",
                        "hallucination_silence_threshold": "2.0"},
            source={"z": "1", "a": "2"})

    def test_segments_sorted_by_time(self):
        starts = [s["start"] for s in self._transcript().to_dict()["segments"]]
        self.assertEqual(starts, sorted(starts))

    def test_byte_identical(self):
        t = self._transcript()
        self.assertEqual(t.to_json(), t.to_json())

    def test_insertion_order_independent(self):
        segs = [ac.make_segment(0.0, 1.0, text="a", avg_logprob=-0.1, no_speech_prob=0.0),
                ac.make_segment(1.0, 2.0, text="b", avg_logprob=-0.1, no_speech_prob=0.0)]
        a = ac.CanonicalTranscript(segments=list(segs)).to_json()
        b = ac.CanonicalTranscript(segments=list(reversed(segs))).to_json()
        self.assertEqual(a, b)

    def test_schema_present(self):
        d = self._transcript().to_dict()
        self.assertEqual(d["schema"], ac.SCHEMA_ID)
        self.assertEqual(d["schema_version"], ac.SCHEMA_VERSION)

    def test_provenance_preserved_round_trip(self):
        t = self._transcript()
        again = ac.CanonicalTranscript.from_json(t.to_json())
        self.assertEqual(again.provenance["model"], "large-v3")
        self.assertEqual(again.provenance["hallucination_silence_threshold"], "2.0")
        self.assertEqual(t.to_json(), again.to_json())

    def test_confidence_preserved_round_trip(self):
        t = self._transcript()
        again = ac.CanonicalTranscript.from_json(t.to_json())
        c_before = [s.confidence for s in t.sorted_segments()]
        c_after = [s.confidence for s in again.sorted_segments()]
        for a, b in zip(c_before, c_after):
            self.assertAlmostEqual(a, b, places=6)

    def test_fixed_decimals(self):
        seg = ac.make_segment(0.123456789, 1.0, text="x", avg_logprob=-0.1, no_speech_prob=0.0)
        self.assertEqual(seg.to_dict()["start"], round(0.123456789, ac.TIME_DECIMALS))

    def test_valid_json(self):
        json.dumps(self._transcript().to_dict())


class SrtFromTranscriptTest(unittest.TestCase):
    def test_empty_segment_excluded_from_srt(self):
        segs = [
            ac.make_segment(0.0, 1.0, text=CJK_KO, avg_logprob=-0.1, no_speech_prob=0.0),
            ac.make_segment(1.0, 2.0, text="", avg_logprob=-0.1, no_speech_prob=0.0),
        ]
        srt = ac.CanonicalTranscript(segments=segs).to_srt()
        self.assertIn("1\n", srt)
        self.assertNotIn("2\n0", srt)  # 두 번째 cue(빈 세그먼트) 없음
        self.assertEqual(srt.count(" --> "), 1)


class LogRedactionTest(unittest.TestCase):
    """전사 본문 로그 미노출 — 모듈이 text 를 stdout 으로 흘리지 않는지."""

    def _transcript(self):
        segs = [ac.make_segment(0.0, 1.0, text=CJK_JA,
                                words=[ac.WordTiming("世界", 0.5, 1.0, 0.9)],
                                avg_logprob=-0.1, no_speech_prob=0.01)]
        return ac.CanonicalTranscript(segments=segs, language="ja",
                                      provenance={"model": "large-v3"})

    def test_summary_excludes_transcript_text(self):
        summ = ac.log_safe_summary(self._transcript())
        blob = json.dumps(summ, ensure_ascii=False)
        self.assertNotIn(CJK_JA, blob)
        self.assertNotIn("世界", blob)
        self.assertEqual(summ["segment_count"], 1)
        self.assertEqual(summ["word_count"], 1)
        self.assertEqual(summ["language"], "ja")

    def test_module_calls_do_not_print_text(self):
        # 표준화·정책 계산·요약 어떤 것도 stdout 으로 본문을 내보내지 않는다.
        t = self._transcript()
        buf = io.StringIO()
        with redirect_stdout(buf):
            ac.log_safe_summary(t)
            ac.apply_silence_policy([0.11, 0.0001])
            ac.recommend_rms_threshold([0.001, 0.002])
            ac.segments_from_whisper([{"start": 0.0, "end": 1.0, "text": CJK_ZH}])
            t.to_srt()
        out = buf.getvalue()
        self.assertNotIn(CJK_JA, out)
        self.assertNotIn(CJK_ZH, out)
        self.assertNotIn("世界", out)


class IntegrationSyntheticTest(unittest.TestCase):
    """합성 Whisper 결과 → 표준화 → SRT/JSON 직렬화 전체 흐름."""

    def test_full_pipeline(self):
        whisper = [
            {"start": 0.0, "end": 2.0, "text": CJK_KO, "no_speech_prob": 0.01,
             "avg_logprob": -0.12,
             "words": [{"word": "안녕하세요", "start": 0.0, "end": 1.0, "probability": 0.95},
                       {"word": "반갑습니다", "start": 1.0, "end": 2.0, "probability": 0.9}]},
            {"start": 2.0, "end": 2.1, "text": "네", "no_speech_prob": 0.2,   # 짧은 발화
             "avg_logprob": -0.5},
            {"start": 2.1, "end": 4.0, "text": "", "no_speech_prob": 0.9,     # 무음 위 빈 것
             "avg_logprob": -2.0},
            {"start": 4.0, "end": 6.0, "text": EN_NUM, "no_speech_prob": 0.03,
             "avg_logprob": -0.2},
        ]
        segs = ac.segments_from_whisper(whisper, language="ko")
        t = ac.CanonicalTranscript(segments=segs, language="ko",
                                   provenance={"model": "large-v3", "task": "transcribe"},
                                   source={"tool": "synthetic"})
        # 결정성.
        self.assertEqual(t.to_json(), t.to_json())
        self.assertEqual(ac.CanonicalTranscript.from_json(t.to_json()).to_json(), t.to_json())
        # 빈 세그먼트는 EMPTY, 나머지는 본문 있음.
        statuses = [s.status for s in t.sorted_segments()]
        self.assertIn(ac.SegmentStatus.EMPTY, statuses)
        # SRT: 빈 세그먼트 제외 → 3 cue, 시간순·1부터 재번호.
        srt = t.to_srt()
        self.assertEqual(srt.count(" --> "), 3)
        first_line = srt.split("\n")[0]
        self.assertEqual(first_line, "1")
        # 짧은 발화(0.1s)는 min_cue 로 확장돼 사라지지 않는다.
        self.assertIn("00:00:02,000 --> 00:00:02,300", srt)
        # 로그 요약에 본문 없음.
        self.assertNotIn(CJK_KO, json.dumps(ac.log_safe_summary(t), ensure_ascii=False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
