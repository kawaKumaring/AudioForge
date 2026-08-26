# -*- coding: utf-8 -*-
"""화자 트랙 저장 계약 — 합성 프레임 라벨만(실제 음성·모델·GPU·파일 I/O 없음).

버그: 트랙 저장 루프가 order 전체(= n_speakers)를 돌며 무조건 save_audio 를 불렀다.
MIN_TURN_FRAMES(500ms) 병합이 어떤 화자의 구간을 전부 흡수하면 그 화자의
speaker_wavs 는 끝까지 all-zero 인데도 WAV 로 저장돼, 사용자 트랙 목록에 재생해도
아무 소리가 없는 트랙이 섞여 나왔다.

계약:
  - 출력 프레임이 없는 화자는 파일을 쓰지 않고 tracks 에도 넣지 않는다.
  - 살아남은 화자는 order(첫 등장 순)를 유지한 채 화자 A, B, … 를 빈틈없이 받는다.
  - 살아남은 화자에게 넘어가는 오디오 텐서(speaker_wavs[spk_idx])는 그대로다.

save_audio 는 가짜로 바꿔 끼우므로 실제 오디오를 쓰지 않는다. torch/numpy 를
쓰지 않는다(conversation_worker 는 모듈 로드 시 무거운 것을 import 하지 않는다).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conversation_worker as cw


PROB_SR = 100        # conversation_worker:411
SR_FULL = 16000      # 재구성 해상도(합성값)
MIN_TURN_FRAMES = int(0.5 * PROB_SR)   # conversation_worker: 500ms


# ── conversation_worker 의 MIN_TURN 병합을 순수 리스트로 재현 ──
def merge_short_turns(smoothed, min_turn_frames=MIN_TURN_FRAMES):
    s = list(smoothed)
    n = len(s)
    i = 0
    while i < n:
        if s[i] < 0:
            i += 1
            continue
        j = i
        while j < n and s[j] == s[i]:
            j += 1
        if (j - i) < min_turn_frames:
            prev_spk = s[i - 1] if i > 0 else -1
            next_spk = s[j] if j < n else -1
            merge_to = prev_spk if prev_spk >= 0 else next_spk
            if merge_to >= 0:
                s[i:j] = [merge_to] * (j - i)
        i = j
    return s


# ── Step 8 의 first_app/order 계산을 순수 리스트로 재현 ──
def first_appearance(smoothed, n_speakers, n_samples):
    first_app = [n_samples] * n_speakers
    for f, spk in enumerate(smoothed):
        if 0 <= spk < n_speakers:
            s = int(f / PROB_SR * SR_FULL)
            if s < first_app[spk]:
                first_app[spk] = s
    return first_app


def order_of(first_app, n_speakers):
    return sorted(range(n_speakers), key=lambda x: first_app[x])


class _FakeSaver(object):
    """save_audio 대체 — 파일을 쓰지 않고 (path, tensor, sr) 만 기록."""

    def __init__(self):
        self.calls = []

    def __call__(self, path, tensor, sr):
        self.calls.append((path, tensor, sr))

    @property
    def paths(self):
        return [os.path.basename(p) for p, _, _ in self.calls]


class _Wav(object):
    """speaker_wavs 원소 대역 — 동일성 비교만 하므로 태그 하나면 충분."""

    def __init__(self, tag):
        self.tag = tag

    def __repr__(self):
        return "<Wav %s>" % self.tag


def _run_save(order, first_app, n_samples, n_speakers, outdir="/out"):
    """conversation_worker._save_speaker_tracks 를 가짜 save_audio 로 구동."""
    saver = _FakeSaver()
    wavs = [_Wav(i) for i in range(n_speakers)]
    original = cw.save_audio
    cw.save_audio = saver
    try:
        tracks = cw._save_speaker_tracks(order, first_app, n_samples,
                                         wavs, SR_FULL, outdir)
    finally:
        cw.save_audio = original
    return tracks, saver, wavs


class MergedAwaySpeakerWritesNoFile(unittest.TestCase):
    """합성 시나리오: 3화자 중 가운데 화자의 구간이 병합에 전부 흡수된다."""

    def _scenario(self):
        # 화자 0: 0~3초, 화자 1: 3.0~3.2초(200ms — MIN_TURN 500ms 미만),
        # 화자 2: 3.2~6초. 병합 후 화자 1 은 한 프레임도 남지 않는다.
        smoothed = ([0] * 300) + ([1] * 20) + ([2] * 280)
        merged = merge_short_turns(smoothed)
        n_samples = int(len(merged) / PROB_SR * SR_FULL)
        return merged, n_samples

    def test_merge_actually_absorbs_the_middle_speaker(self):
        # 전제 확인 — 병합 전에는 있었고 병합 후에는 없다.
        merged, _ = self._scenario()
        self.assertNotIn(1, merged, "전제 실패: 화자 1 이 병합되지 않았다")
        self.assertIn(0, merged)
        self.assertIn(2, merged)

    def test_no_file_written_for_absorbed_speaker(self):
        merged, n_samples = self._scenario()
        first_app = first_appearance(merged, 3, n_samples)
        order = order_of(first_app, 3)

        tracks, saver, wavs = _run_save(order, first_app, n_samples, 3)

        # 화자 1 의 텐서는 save_audio 에 넘어가지 않았다.
        saved_tensors = [t for _, t, _ in saver.calls]
        self.assertNotIn(wavs[1], saved_tensors)
        # 저장은 정확히 두 번, 무음 트랙 없음.
        self.assertEqual(len(saver.calls), 2, saver.paths)
        self.assertEqual(len(tracks), 2, tracks)

    def test_surviving_labels_are_contiguous(self):
        merged, n_samples = self._scenario()
        first_app = first_appearance(merged, 3, n_samples)
        order = order_of(first_app, 3)

        tracks, saver, wavs = _run_save(order, first_app, n_samples, 3)

        # 구멍 없는 A, B (예전에는 A / B(무음) / C 였다).
        self.assertEqual([t["label"] for t in tracks], ["화자 A", "화자 B"])
        self.assertEqual([t["name"] for t in tracks], ["speaker_a", "speaker_b"])
        self.assertEqual(saver.paths, ["speaker_a.wav", "speaker_b.wav"])
        # 라벨은 재부여됐지만 오디오는 원래 화자 것 그대로다:
        # 화자 A ← cluster 0, 화자 B ← cluster 2 (흡수된 1 이 아님).
        self.assertEqual([t for _, t, _ in saver.calls], [wavs[0], wavs[2]])

    def test_paths_match_tracks(self):
        merged, n_samples = self._scenario()
        first_app = first_appearance(merged, 3, n_samples)
        order = order_of(first_app, 3)
        tracks, saver, _ = _run_save(order, first_app, n_samples, 3, outdir="/tmp/out")
        self.assertEqual([t["path"] for t in tracks], [c[0] for c in saver.calls])
        for t in tracks:
            self.assertEqual(os.path.basename(t["path"]), t["name"] + ".wav")


class PlanFunctionContract(unittest.TestCase):
    """_speaker_track_plan 단위 계약."""

    def test_all_speakers_present_is_unchanged_behaviour(self):
        # 모두 출력이 있으면 예전과 완전히 동일한 결과.
        plan = cw._speaker_track_plan([1, 0], [500, 0], 1000)
        self.assertEqual(plan, [(1, "speaker_a", "화자 A"),
                                (0, "speaker_b", "화자 B")])

    def test_first_speaker_dropped(self):
        # order 첫 화자가 사라져도 남은 화자가 A 부터 시작한다.
        plan = cw._speaker_track_plan([0, 1, 2], [1000, 10, 20], 1000)
        self.assertEqual([p[2] for p in plan], ["화자 A", "화자 B"])
        self.assertEqual([p[0] for p in plan], [1, 2])

    def test_last_speaker_dropped(self):
        plan = cw._speaker_track_plan([0, 1, 2], [0, 10, 1000], 1000)
        self.assertEqual([p[0] for p in plan], [0, 1])
        self.assertEqual([p[2] for p in plan], ["화자 A", "화자 B"])

    def test_multiple_dropped_stay_contiguous(self):
        # 5화자 중 2명 흡수 → A, B, C (구멍 없음).
        plan = cw._speaker_track_plan([0, 1, 2, 3, 4],
                                      [0, 1000, 10, 1000, 20], 1000)
        self.assertEqual([p[0] for p in plan], [0, 2, 4])
        self.assertEqual([p[2] for p in plan], ["화자 A", "화자 B", "화자 C"])
        self.assertEqual([p[1] for p in plan],
                         ["speaker_a", "speaker_b", "speaker_c"])

    def test_all_dropped_gives_empty_plan(self):
        # 전원 흡수 → 빈 계획. separate.py 의 `if not tracks:` 가 원인을 보고한다.
        self.assertEqual(cw._speaker_track_plan([0, 1], [1000, 1000], 1000), [])

    def test_sentinel_boundary_is_exclusive(self):
        # first_app == n_samples 만 sentinel(출력 없음). n_samples-1 은 살아 있다.
        self.assertEqual(len(cw._speaker_track_plan([0], [999], 1000)), 1)
        self.assertEqual(len(cw._speaker_track_plan([0], [1000], 1000)), 0)

    def test_order_is_preserved(self):
        # 라벨은 재부여돼도 저장 순서는 order(첫 등장 순) 그대로다.
        # first_app 은 화자 id 로 색인한다: spk3=1000(sentinel) 만 탈락 →
        # order [3,1,0,2] 에서 3 만 빠진 [1,0,2] 순서가 그대로 유지된다.
        plan = cw._speaker_track_plan([3, 1, 0, 2], [5, 2, 8, 1000], 1000)
        self.assertEqual([p[0] for p in plan], [1, 0, 2])
        self.assertEqual([p[2] for p in plan], ['화자 A', '화자 B', '화자 C'])


if __name__ == "__main__":
    unittest.main()


class SidecarTrackIndexAlignment(unittest.TestCase):
    """무음 화자를 트랙에서 뺀 뒤에도 sidecar 의 trackIndex 가 실제 tracks 위치와 맞는지.

    order 위치를 그대로 쓰면 중간 화자가 빠졌을 때 그 뒤 화자들이 한 칸씩 밀린다.
    sidecar 가 renderer 로 전달되기 시작했으므로 어긋난 인덱스는 곧 잘못된 표시가 된다."""

    def test_track_index_matches_saved_track_position(self):
        import conversation_worker as cw
        order = [0, 1, 2]                 # 화자 A, B, C
        n_samples = 100
        # 화자 B(order 위치 1)는 병합으로 출력 프레임이 사라진 상태.
        first_app = {0: 0, 1: n_samples, 2: 40}
        plan = cw._speaker_track_plan(order, first_app, n_samples)
        saved = [name for _spk, name, _label in plan]
        self.assertEqual(saved, ["speaker_a", "speaker_b"],
                         "살아남은 두 화자가 연속된 이름을 받는다")

        # sidecar 쪽과 동일한 규칙으로 매긴 인덱스가 저장 위치와 일치해야 한다.
        smoothed_present = {0, 2}
        track_pos = 0
        indices = []
        for c in order:
            avail = c in smoothed_present
            indices.append(track_pos if avail else None)
            if avail:
                track_pos += 1
        self.assertEqual(indices, [0, None, 1])
        self.assertEqual(len(saved), sum(1 for i in indices if i is not None))
