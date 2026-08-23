# -*- coding: utf-8 -*-
"""대화 canonical sidecar 배선 계약 테스트 — 합성 타임라인만 (모델·오디오·GPU 없음).

이 테스트는 아직 production 배선을 하지 않는다. 대신 conversation_worker.py 의
두 배열(병합 전 `frame_labels` :284 vs 병합 후 `smoothed` :296-325)을 순수 파이썬으로
재현해서, canonical sidecar 가 **어느 배열을 먹어야 backchannel 이 보존되는가**를
불변식으로 고정한다. 배선을 실제로 넣을 때 이 계약이 회귀 가드가 된다.

검증 계약:
  (C1) sidecar 는 병합 전 frame_labels 를 먹어야 <500ms backchannel 이 보존된다.
  (C2) 병합 후 smoothed 를 먹으면 backchannel 이 소실된다(잘못된 배선의 증거).
  (C3) sidecar 배선이 소비하는 것은 '복사본'이어야 하며, 오디오/트랙 출력이 쓰는
       smoothed 배열을 변형하지 않는다(조용한 출력 변경 금지).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dialogue_canonical as dc


# conversation_worker.py:308-325 의 MIN_TURN_FRAMES 병합을 순수 파이썬으로 재현.
# (worker 는 numpy·PROB_SR=100 을 쓰지만, 알고리즘은 동일하게 이웃 화자 흡수.)
def merge_short_turns(labels, min_turn_frames):
    """<min_turn_frames 짜리 turn 을 앞(없으면 뒤) 화자로 흡수. worker 의 smoothed 단계."""
    out = list(labels)
    n = len(out)
    i = 0
    while i < n:
        if out[i] < 0:
            i += 1
            continue
        j = i
        while j < n and out[j] == out[i]:
            j += 1
        if (j - i) < min_turn_frames:
            prev_spk = out[i - 1] if i > 0 else -1
            next_spk = out[j] if j < n else -1
            merge_to = prev_spk if prev_spk >= 0 else next_spk
            if merge_to >= 0:
                for k in range(i, j):
                    out[k] = merge_to
        i = j
    return out


class WiringContractTest(unittest.TestCase):
    def setUp(self):
        self.fr = 100
        self.MIN_TURN_FRAMES = int(0.5 * self.fr)  # 50 = worker 값
        # A 1.0s → B 0.2s(backchannel, 20프레임<50) → A 1.0s
        self.frame_labels = [0] * 100 + [1] * 20 + [0] * 100
        self.names = ["화자 A", "화자 B"]

    def test_c1_premerge_preserves_backchannel(self):
        segs = dc.build_segments_from_frames(self.frame_labels, self.fr, self.names)
        self.assertEqual(len(segs), 3)
        self.assertEqual(dc.count_backchannels(segs), 1)
        self.assertEqual(segs[1].speakers, ("화자 B",))

    def test_c2_postmerge_loses_backchannel(self):
        smoothed = merge_short_turns(self.frame_labels, self.MIN_TURN_FRAMES)
        # 20프레임 B turn 이 이웃 A 로 흡수 → 전 구간 A 단일.
        self.assertNotIn(1, smoothed)
        segs = dc.build_segments_from_frames(smoothed, self.fr, self.names)
        self.assertEqual(dc.count_backchannels(segs), 0)  # backchannel 소실 = 잘못된 배선
        self.assertEqual({s.primary_speaker() for s in segs}, {"화자 A"})

    def test_c3_sidecar_consumes_copy_does_not_mutate_smoothed(self):
        # 오디오/트랙 출력이 쓰는 배열(여기선 smoothed)이 sidecar 배선으로 변형되면 안 된다.
        smoothed = merge_short_turns(self.frame_labels, self.MIN_TURN_FRAMES)
        before = list(smoothed)
        # 배선 후보: 병합 전 frame_labels 의 '복사본'을 sidecar 에 넘긴다.
        sidecar_input = list(self.frame_labels)
        _ = dc.build_segments_from_frames(sidecar_input, self.fr, self.names)
        # 빌더는 입력을 읽기만 한다(불변) + smoothed 는 손대지 않는다.
        self.assertEqual(sidecar_input, list(self.frame_labels))
        self.assertEqual(smoothed, before)

    def test_c1_c2_contrast_is_the_wiring_decision(self):
        # 같은 원본에서 두 배열이 backchannel 보존 여부가 갈린다 — 배선 근거.
        pre = dc.build_segments_from_frames(self.frame_labels, self.fr, self.names)
        post = dc.build_segments_from_frames(
            merge_short_turns(self.frame_labels, self.MIN_TURN_FRAMES), self.fr, self.names)
        self.assertGreater(dc.count_backchannels(pre), dc.count_backchannels(post))


if __name__ == "__main__":
    unittest.main(verbosity=2)
