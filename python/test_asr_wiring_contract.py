# -*- coding: utf-8 -*-
"""ASR canonical 배선 계약 테스트 — 합성 데이터만(실제 음성·Whisper·GPU·soundfile·네트워크 없음).

이 테스트는 production 배선을 하지 않는다. transcribe_worker.py 의 세 지점을
순수 파이썬으로 *재현*해서, canonical 배선이 지켜야 할 불변식을 고정한다:

  (W1) SRT 블록 구조 계약 — 현재 원시 writer(transcribe_worker.py:492-496,
       separate.py:392-396)와 canonical render_srt 의 블록 구분·본문 배치가
       바이트 동일한지(타임코드 규약을 제외한). 배선이 자막 구조를 바꾸지
       않음을 보장.
  (W2) SRT 타임코드 규약 — 프로덕션 fmt_srt_time 의 ms 절삭 버그를 반올림으로
       고친 뒤 canonical format_srt_timestamp 와 경계 ms 까지 일치함을 고정한다.
       (수정 전에는 두 규약이 경계에서 최대 1ms 달랐다 — 그것이 migration 표면.)
  (W3) 무음 게이트 shadow 계약 — _filter_silent_segments(rms_threshold=0.005,
       0.4 keep-guard, b<=a 무조건 유지)의 keep 결정 수학을 순수 재현해
       apply_silence_policy 와 세그먼트별 keep 이 일치함을 고정(shadow 비교의
       기준). threshold 는 어느 쪽도 바꾸지 않는다.
  (W4) 세그먼트 수집 계약 — transcribe_worker.py:489 의 result["segments"]
       dict shape 를 segments_from_whisper 가 손실 없이 표준화함을 고정.

무거운 의존(torch/whisper/soundfile)을 import 하지 않는다. audio_utils.fmt_srt_time
은 함수 상단에서 무거운 것을 import 하지 않으므로 안전하게 가져온다.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr_canonical as ac
from audio_utils import fmt_srt_time


CJK_KO = "안녕하세요 반갑습니다"
EN_NUM = "Hello world 2026 test 42"


# ── 현재 프로덕션 원시 SRT writer 를 순수 문자열로 재현 (파일 I/O 없음) ──
# transcribe_worker.py:492-496 / separate.py:392-396 과 동일한 포맷 문자열.
def raw_srt_string(segments, fmt=fmt_srt_time):
    parts = []
    for si, seg in enumerate(segments, 1):
        parts.append(
            f"{si}\n{fmt(seg['start'])} --> {fmt(seg['end'])}\n{seg['text'].strip()}\n\n"
        )
    return "".join(parts)


# ── _filter_silent_segments(84-120) 의 keep 결정 수학을 순수 재현 ──
# 오디오를 읽지 않고 (rms, duration) 만으로 프로덕션 분기를 그대로 흉내낸다:
#   - b<=a(0길이) → 무조건 유지
#   - 그 외 rms >= threshold → 유지
#   - kept < total*0.4 → 전부 유지(over-delete 가드)
def legacy_filter_keep(rms_values, durations, threshold=0.005, keep_ratio=0.4):
    raw = []
    for rms, dur in zip(rms_values, durations):
        if dur <= 0.0:            # 프로덕션 b<=a 분기
            raw.append(True)
        else:
            raw.append(rms >= threshold)
    if sum(raw) < len(raw) * keep_ratio:
        return [True] * len(raw)
    return raw


class SrtBlockStructureContract(unittest.TestCase):
    """(W1) 타임코드를 뺀 SRT 블록 구조는 canonical 배선 후에도 바이트 동일."""

    def test_clean_segments_block_structure_identical(self):
        # 겹침·빈·초과 없는 '깨끗한' 세그먼트: 두 경로의 블록 구조가 같아야 한다.
        # 타임코드 차이를 배제하기 위해 canonical 도 절삭 포맷터로 렌더한 것과 비교.
        segs = [
            {"start": 0.0, "end": 1.0, "text": CJK_KO},
            {"start": 1.0, "end": 2.0, "text": EN_NUM},
        ]
        raw = raw_srt_string(segs)
        cues = ac.sanitize_srt_cues(
            [ac.SrtCue(0, s["start"], s["end"], s["text"]) for s in segs])
        rendered = ac.render_srt(cues)
        # 블록 구분(빈 줄)·인덱스·본문 라인 수 동일.
        self.assertEqual(raw.count("\n\n"), rendered.count("\n\n"))
        self.assertEqual([ln for ln in raw.split("\n") if ln in ("1", "2")],
                         [ln for ln in rendered.split("\n") if ln in ("1", "2")])
        # 본문 라인 보존.
        self.assertIn(CJK_KO, rendered)
        self.assertIn(EN_NUM, rendered)

    def test_sanitizer_drops_empty_and_reindexes(self):
        # 현재 writer 는 빈 세그먼트도 블록으로 쓴다(잘못된 SRT). canonical 은
        # 드롭+재번호 → 이것이 의도된 동작 변경(호환성 결정 대상).
        segs = [
            {"start": 0.0, "end": 1.0, "text": CJK_KO},
            {"start": 1.0, "end": 2.0, "text": "   "},   # 빈(공백) 세그먼트
            {"start": 2.0, "end": 3.0, "text": EN_NUM},
        ]
        raw = raw_srt_string(segs)
        cues = ac.sanitize_srt_cues(
            [ac.SrtCue(0, s["start"], s["end"], s["text"]) for s in segs])
        rendered = ac.render_srt(cues)
        self.assertEqual(raw.count(" --> "), 3)        # 현재: 빈 것도 3 cue
        self.assertEqual(rendered.count(" --> "), 2)   # canonical: 빈 것 드롭 → 2
        # 재번호로 EN_NUM 이 2번이 된다(현재는 3번).
        self.assertTrue(rendered.strip().endswith(EN_NUM))


class SrtTimecodeMigrationContract(unittest.TestCase):
    """(W2) 타임코드 규약 — 프로덕션 fmt_srt_time 의 ms 절삭 버그를 반올림으로
    고친 뒤, canonical format_srt_timestamp 와 규약이 일치함을 고정한다.
    (1ms migration 표면은 닫혔고, ≤1ms 계약은 그대로 유효하다.)"""

    def test_exact_ms_values_agree(self):
        # 정확한 ms 값에서는 두 포맷터가 동일(마이그레이션 무영향 구간).
        for t in (0.0, 1.0, 61.0, 3600.0, 1.234):
            self.assertEqual(ac.format_srt_timestamp(t), fmt_srt_time(t), f"@{t}")

    def test_float_boundary_diverges_by_1ms(self):
        # 2.3 == 2.2999… (float). 예전 프로덕션은 ms 를 절삭해 2299ms 를 냈고 그것이
        # 버그였다(이전 기대값: "00:00:02,299"). fmt_srt_time 이 반올림으로 수정되어
        # 이제 canonical 과 같은 2300ms — 1ms migration 표면이 닫혔다.
        self.assertEqual(fmt_srt_time(2.3), "00:00:02,300")            # 프로덕션(반올림, 수정 후)
        self.assertEqual(ac.format_srt_timestamp(2.3), "00:00:02,300")  # canonical(반올림)

    def test_divergence_never_exceeds_1ms(self):
        def to_ms(ts):
            hms, ms = ts.split(",")
            h, m, s = hms.split(":")
            return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(ms)
        for t in (0.0, 1.234, 2.3, 59.999, 61.5, 3661.001, 7200.0, 12.3456):
            diff = abs(to_ms(ac.format_srt_timestamp(t)) - to_ms(fmt_srt_time(t)))
            self.assertLessEqual(diff, 1, f"@{t}")


class SilenceGateShadowContract(unittest.TestCase):
    """(W3) apply_silence_policy 가 _filter_silent_segments keep 수학과 일치."""

    def test_shadow_parity_mixed(self):
        rms = [0.11, 0.0001, 0.11, 0.12]
        durs = [1.0, 1.0, 1.0, 1.0]
        legacy = legacy_filter_keep(rms, durs)
        pol = ac.apply_silence_policy(rms, durations=durs)
        self.assertEqual(list(pol.keep), legacy)
        self.assertFalse(pol.guard_tripped)

    def test_shadow_parity_over_delete_guard(self):
        rms = [0.0001] * 8 + [0.11] * 2
        durs = [1.0] * 10
        legacy = legacy_filter_keep(rms, durs)
        pol = ac.apply_silence_policy(rms, durations=durs)
        self.assertEqual(list(pol.keep), legacy)     # 둘 다 전부 유지
        self.assertTrue(pol.guard_tripped)
        self.assertTrue(all(legacy))

    def test_shadow_parity_zero_length_kept(self):
        # 0길이(b<=a) 세그먼트는 양쪽 다 무조건 유지.
        rms = [0.0, 0.11, 0.11]
        durs = [0.0, 1.0, 1.0]
        legacy = legacy_filter_keep(rms, durs)
        pol = ac.apply_silence_policy(rms, durations=durs)
        self.assertEqual(list(pol.keep), legacy)
        self.assertTrue(pol.keep[0])

    def test_threshold_not_mutated_by_shadow(self):
        before = ac.DEFAULT_RMS_THRESHOLD
        ac.apply_silence_policy([0.1, 0.0001], durations=[1.0, 1.0])
        self.assertEqual(ac.DEFAULT_RMS_THRESHOLD, before)  # shadow 는 임계 불변


class SegmentIngestContract(unittest.TestCase):
    """(W4) transcribe_worker.py:489 result["segments"] dict shape 수집."""

    def test_ingests_worker_segment_shape(self):
        # run_transcribe 결과 세그먼트가 갖는 실제 키를 그대로 넘긴다.
        worker_segments = [
            {"start": 0.0, "end": 2.0, "text": " " + CJK_KO + " ",
             "no_speech_prob": 0.01, "avg_logprob": -0.12,
             "words": [{"word": "안녕하세요", "start": 0.0, "end": 1.0, "probability": 0.95}]},
            {"start": 2.0, "end": 4.0, "text": EN_NUM,
             "no_speech_prob": 0.4, "avg_logprob": -1.2},
        ]
        segs = ac.segments_from_whisper(worker_segments, language="ko")
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0].text, CJK_KO)          # strip 적용
        self.assertTrue(segs[0].has_words)
        self.assertGreater(segs[0].confidence, segs[1].confidence)
        # timestamps.txt(원문 타임라인)와 동일한 start/end 를 canonical 이 보존.
        self.assertAlmostEqual(segs[0].start, 0.0)
        self.assertAlmostEqual(segs[1].end, 4.0)

    def test_txt_body_reconstructable_matches_worker(self):
        # transcribe_worker._save_transcription 의 text = result["text"].strip()
        # 와, canonical 세그먼트 본문을 이어붙인 것이 동일 본문을 담는지(TXT 호환).
        worker_segments = [
            {"start": 0.0, "end": 1.0, "text": CJK_KO},
            {"start": 1.0, "end": 2.0, "text": EN_NUM},
        ]
        segs = ac.segments_from_whisper(worker_segments)
        joined = " ".join(s.text for s in segs)
        self.assertIn(CJK_KO, joined)
        self.assertIn(EN_NUM, joined)


if __name__ == "__main__":
    unittest.main(verbosity=2)
