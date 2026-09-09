"""대화 분리 화자 전환 페이드 — 경계는 **배정 구간**에서 온다(표본 진폭이 아니다).

왜 이 파일이 있는가(2026-09-09 관리자 검수)
────────────────────────────────────────
페이드 경계를 `np.abs(wav) > 1e-8` 로 찾고 있었다. 발화 안에는 0에 가까운 표본이 얼마든지
있다(파형의 0 교차, 디지털 무음). 그 자리마다 경계로 오인해 감쇠를 곱했고, 램프가 겹치면
감쇠가 누적됐다. 합성 신호 실측(150Hz 사인, 48kHz):

    한 화자가 0.6초 내내 말하는 경우
      찾은 경계   시작 180개 · 끝 179개   (있어야 할 값: 1 · 1)
      발화 내부   -73.55 dB               (즉 사실상 지워졌다)
      원인        |x| <= 1e-8 인 표본 180개 = 0 교차 수와 같다

배정 구간은 재구성 단계에서 이미 계산돼 있다. 그 시작·끝만 쓰면 된다.

★이 결함을 과거 합성(TTS) 떨림의 원인으로 연결하지 않는다. 별개 경로다 —
  여기는 대화 분리(입력을 화자별로 나누는 일)이고, 합성은 참조로 목소리를 만드는 일이다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

SR = 48000
PROB_SR = 50.0
FADE = int(0.015 * SR)      # 제품과 같은 15ms


def _tone(n, freq=150.0, amp=0.4):
    t = np.arange(n) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def rebuild_and_fade(assign, n_speakers=2):
    """제품(conversation_worker Step 7)과 **같은 방식**으로 재구성 + 페이드.

    제품 코드를 그대로 부르지 않는 이유: 그 함수는 diarization 모델·오디오 로딩과 한 덩어리다.
    여기서 재는 것은 '경계를 어디서 얻는가' 하나이므로 그 부분만 같은 규칙으로 옮겨 둔다.
    규칙이 갈라지지 않도록 아래 test_product_uses_spans 가 제품 소스를 함께 확인한다.
    """
    n_frames = len(assign)
    n = int(n_frames / PROB_SR * SR)
    full = _tone(n)
    wavs = [np.zeros(n, dtype=np.float32) for _ in range(n_speakers)]

    spans = [[] for _ in range(n_speakers)]
    cur_spk, cur_s, cur_e = -1, 0, 0
    for f in range(n_frames):
        spk = assign[f]
        s = int(f / PROB_SR * SR)
        e = min(int((f + 1) / PROB_SR * SR), n)
        if s >= n:
            break
        if spk >= 0:
            wavs[spk][s:e] = full[s:e]
        if spk != cur_spk:
            if cur_spk >= 0 and cur_e > cur_s:
                spans[cur_spk].append((cur_s, cur_e))
            cur_spk, cur_s, cur_e = spk, s, e
        else:
            cur_e = e
    if cur_spk >= 0 and cur_e > cur_s:
        spans[cur_spk].append((cur_s, cur_e))

    for spk in range(n_speakers):
        for (s, e) in spans[spk]:
            ln = e - s
            if ln <= 1:
                continue
            f_len = min(FADE, ln // 2)
            if f_len <= 0:
                continue
            wavs[spk][s:s + f_len] *= np.linspace(0.0, 1.0, f_len, dtype=wavs[spk].dtype)
            wavs[spk][e - f_len:e] *= np.linspace(1.0, 0.0, f_len, dtype=wavs[spk].dtype)
    return wavs, spans, full


def rms_db(a, b):
    ra = float(np.sqrt(np.mean(np.square(a, dtype=np.float64)))) if a.size else 0.0
    rb = float(np.sqrt(np.mean(np.square(b, dtype=np.float64)))) if b.size else 0.0
    return 20.0 * np.log10(max(1e-12, ra) / max(1e-12, rb))


class FadeUsesAssignmentSpans(unittest.TestCase):
    def test_continuous_speech_keeps_its_inside(self):
        # 한 화자가 0.6초 내내 말한다 — 구간은 하나, 내부는 손실이 없어야 한다.
        wavs, spans, full = rebuild_and_fade([0] * 30)
        self.assertEqual(len(spans[0]), 1, "배정이 이어지면 구간은 하나다: {0}".format(spans[0]))
        inner = slice(int(0.1 * SR), int(0.5 * SR))
        loss = rms_db(wavs[0][inner], full[inner])
        self.assertGreater(loss, -0.01, "발화 내부가 손실됐다: {0:+.2f} dB".format(loss))

    def test_edges_are_faded(self):
        wavs, _spans, _full = rebuild_and_fade([0] * 30)
        self.assertLess(abs(float(wavs[0][0])), 1e-6, "구간 시작은 0에서 올라온다")
        self.assertLess(abs(float(wavs[0][-1])), 1e-6, "구간 끝은 0으로 내려간다")
        # 페이드는 15ms 안에서 끝난다 — 그 밖은 원본 그대로다.
        i = FADE + 1
        self.assertGreater(abs(float(wavs[0][i])), 1e-4, "페이드가 구간 안쪽까지 번지지 않는다")

    def test_zero_crossings_are_not_boundaries(self):
        # 0 교차는 발화 안에 널려 있다. 그것을 경계로 세면 감쇠가 누적된다(옛 결함).
        wavs, spans, _full = rebuild_and_fade([0] * 30)
        crossings = int(np.sum(np.abs(_tone(wavs[0].size)) <= 1e-8))
        self.assertGreater(crossings, 50, "이 신호에는 0 교차가 많다(전제 확인)")
        self.assertEqual(len(spans[0]), 1, "그런데도 경계는 하나다")

    def test_two_speakers_alternating(self):
        # 번갈아 말하면 각자의 구간이 나뉘고, 각 구간의 양 끝에만 페이드가 걸린다.
        assign = [0] * 10 + [1] * 10 + [0] * 10
        wavs, spans, full = rebuild_and_fade(assign)
        self.assertEqual(len(spans[0]), 2)
        self.assertEqual(len(spans[1]), 1)
        # 두 번째 화자의 구간 내부는 원본과 같다.
        s, e = spans[1][0]
        inner = slice(s + FADE + 10, e - FADE - 10)
        self.assertGreater(rms_db(wavs[1][inner], full[inner]), -0.01)

    def test_short_span_does_not_double_attenuate(self):
        # 구간이 페이드 두 개보다 짧으면 램프가 겹쳐 두 번 곱해진다 — 절반으로 제한한다.
        assign = [0] * 1          # 1프레임 = 20ms < 15ms × 2
        wavs, spans, _full = rebuild_and_fade(assign)
        s, e = spans[0][0]
        f_len = min(FADE, (e - s) // 2)
        self.assertLessEqual(f_len * 2, e - s, "램프 둘이 겹치지 않는다")
        mid = (s + e) // 2
        self.assertGreater(abs(float(wavs[0][mid])), 0.0, "가운데가 0으로 지워지지 않는다")

    def test_unassigned_frames_stay_silent(self):
        assign = [-1] * 5 + [0] * 10 + [-1] * 5
        wavs, spans, _full = rebuild_and_fade(assign)
        self.assertEqual(len(spans[0]), 1)
        self.assertLess(float(np.max(np.abs(wavs[0][:int(0.09 * SR)]))), 1e-6,
                        "배정되지 않은 앞부분은 무음이다")


class ProductRuleMatches(unittest.TestCase):
    """위 규칙이 제품과 갈라지지 않는지 — 제품 소스에서 함께 확인한다."""

    def setUp(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "conversation_worker.py"), encoding="utf-8") as fh:
            self.src = fh.read()

    def test_product_no_longer_finds_boundaries_by_amplitude(self):
        self.assertNotIn("is_active = np.abs(wav_np) > 1e-8", self.src,
                         "표본 진폭으로 경계를 찾는 코드가 남아 있다")
        self.assertNotIn("np.diff(is_active", self.src)

    def test_product_uses_spans(self):
        self.assertIn("spans = [[] for _ in range(n_speakers)]", self.src)
        self.assertIn("for (s, e) in spans[spk]:", self.src)
        self.assertIn("f_len = min(fade_samples, n // 2)", self.src,
                      "짧은 구간에서 램프가 겹치지 않게 절반으로 제한한다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
