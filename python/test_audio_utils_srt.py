# -*- coding: utf-8 -*-
"""audio_utils.fmt_srt_time 경계 계약 — 순수 문자열만(오디오·모델·파일 I/O 없음).

버그: `ms = int((seconds % 1) * 1000)` 은 ms 를 절삭했고, 시/분/초를 각각 따로
계산해 자리올림이 없었다. 그래서
  - float 비표현(2.3 == 2.2999…)이 그대로 새어나와 2.3 → ",299"
  - 2.9996 은 초를 못 올리고 "00:00:02,999"
  - 59.9996 / 3599.9996 은 분·시로 넘어가지 못했다.
수정: 총 밀리초를 한 번에 반올림한 뒤 divmod 로 자리올림을 유도한다.

fmt_time 은 이 수정의 대상이 아니다 — 출력 불변을 여기서 같이 고정한다.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_utils import fmt_srt_time, fmt_time


class FmtSrtTimeBoundaries(unittest.TestCase):

    def test_boundary_table(self):
        cases = [
            # (초, 기대 문자열, 비고)
            (0, "00:00:00,000", "0 (int)"),
            (0.0, "00:00:00,000", "0.0"),
            (0.0004, "00:00:00,000", "1ms 미만 → 0"),
            (0.0006, "00:00:00,001", "1ms 미만이지만 반올림 → 1ms"),
            (1.0, "00:00:01,000", "정확한 초"),
            (1.234, "00:00:01,234", "정확히 표현되는 ms"),
            # ↓ 절삭 버그의 핵심 사례 — 예전 값은 "00:00:02,299" 였다.
            (2.3, "00:00:02,300", "float 비표현 2.2999… → 반올림"),
            (2.9996, "00:00:03,000", "초 자리올림 (예전: 00:00:02,999)"),
            (59.9996, "00:01:00,000", "분 자리올림 (예전: 00:00:59,999)"),
            (3599.9996, "01:00:00,000", "시 자리올림 (예전: 00:59:59,999)"),
            (59.999, "00:00:59,999", "자리올림 직전"),
            (60.0, "00:01:00,000", "정확한 분"),
            (61.5, "00:01:01,500", "분+초+ms"),
            (3600.0, "01:00:00,000", "정확한 시"),
            (3661.001, "01:01:01,001", "시/분/초/ms 전 자리"),
            (7200.0, "02:00:00,000", "두 시간"),
            (86399.9996, "24:00:00,000", "24시간 자리올림(시는 2자리 초과 허용)"),
        ]
        for seconds, expected, note in cases:
            with self.subTest(seconds=seconds, note=note):
                self.assertEqual(fmt_srt_time(seconds), expected)

    def test_carry_never_produces_out_of_range_fields(self):
        # 예전 구현은 ms 가 1000 이 되는 조합을 만들 수 있었다. 어떤 입력에서도
        # ms<1000, s<60, m<60 이어야 한다(자리올림이 상위로 전파).
        step = 0.0001
        t = 0.0
        for _ in range(20000):          # 0 ~ 2초를 0.1ms 간격으로 훑는다
            ts = fmt_srt_time(t)
            hms, ms = ts.split(",")
            h, m, s = hms.split(":")
            self.assertEqual(len(ms), 3, ts)
            self.assertLess(int(ms), 1000, ts)
            self.assertLess(int(s), 60, ts)
            self.assertLess(int(m), 60, ts)
            t += step

    def test_monotonic_non_decreasing(self):
        # 시간이 늘면 타임코드도 줄지 않는다(자리올림이 역행하지 않는지).
        def to_ms(ts):
            hms, ms = ts.split(",")
            h, m, s = hms.split(":")
            return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(ms)

        prev = -1
        t = 59.9
        for _ in range(2000):
            cur = to_ms(fmt_srt_time(t))
            self.assertGreaterEqual(cur, prev, t)
            prev = cur
            t += 0.0001

    def test_rounding_matches_canonical(self):
        # asr_canonical.format_srt_timestamp 와 규약이 완전히 같아야 한다(0ms 차이).
        import asr_canonical as ac
        for t in (0.0, 1.234, 2.3, 2.9996, 12.3456, 59.999, 59.9996,
                  61.5, 3599.9996, 3661.001, 7200.0):
            with self.subTest(t=t):
                self.assertEqual(fmt_srt_time(t), ac.format_srt_timestamp(t))


class FmtSrtTimeDefensive(unittest.TestCase):
    """음수·비유한값·비숫자는 예외 대신 00:00:00,000 으로 클램프한다.

    문서화된 선택: 자막 타임코드에는 음수/NaN/무한대를 쓸 수 없고, 여기서 예외를
    던지면 전사 저장(_save_transcription) 전체가 깨진다. asr_canonical.
    format_srt_timestamp 의 음수 클램프 규약과 같은 방향이다."""

    def test_negative_clamps_to_zero(self):
        for t in (-0.001, -1.0, -5.0, -3600.0):
            with self.subTest(t=t):
                self.assertEqual(fmt_srt_time(t), "00:00:00,000")

    def test_nan_and_infinity_clamp_to_zero(self):
        for t in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(t=repr(t)):
                self.assertEqual(fmt_srt_time(t), "00:00:00,000")

    def test_non_numeric_clamps_to_zero(self):
        for t in (None, "", "abc", [], {}):
            with self.subTest(t=repr(t)):
                self.assertEqual(fmt_srt_time(t), "00:00:00,000")

    def test_numeric_string_still_formats(self):
        # float() 로 해석되는 값은 정상 처리(방어가 정상 입력을 삼키지 않는지).
        self.assertEqual(fmt_srt_time("2.3"), "00:00:02,300")

    def test_never_raises(self):
        for t in (float("nan"), float("inf"), -1, None, "x", 0, 2.3, 10 ** 9):
            with self.subTest(t=repr(t)):
                out = fmt_srt_time(t)
                self.assertRegex(out, r"^\d{2,}:\d{2}:\d{2},\d{3}$")


class FmtTimeUnchanged(unittest.TestCase):
    """fmt_srt_time 수정이 이웃한 fmt_time 출력을 건드리지 않았다."""

    def test_fmt_time_outputs(self):
        self.assertEqual(fmt_time(0), "0:00")
        self.assertEqual(fmt_time(0.0), "0:00")
        self.assertEqual(fmt_time(2.3), "0:02")
        self.assertEqual(fmt_time(59.9996), "0:59")      # 절삭 유지(반올림 아님)
        self.assertEqual(fmt_time(60.0), "1:00")
        self.assertEqual(fmt_time(61.5), "1:01")
        self.assertEqual(fmt_time(3661.001), "61:01")    # 시 단위 없음 — 기존 규약


if __name__ == "__main__":
    unittest.main()
