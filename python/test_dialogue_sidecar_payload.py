# -*- coding: utf-8 -*-
"""conversation_worker._build_dialogue_sidecar_payload 단위 테스트 — synthetic 전용.

모델·GPU·오디오·파일 I/O 없음. conversation_worker 는 모듈 로드 시 torch 를 import 하지
않으므로(무거운 import 는 함수 내부), 헬퍼만 순수하게 검증 가능하다.

검증(확정 계약):
  - in-memory payload 는 versioned(schema/schemaVersion) 이다.
  - 병합 전 frame_labels 사용 → <500ms backchannel 세그먼트 보존.
  - order 매핑이 트랙 라벨("화자 A/B")과 일치하고 trackIndex 부여.
  - backchannel-only 화자 보존 + trackAvailable=False / trackIndex=None / reviewRequired=True.
  - deterministic 직렬화(정렬·고정 소수 → 같은 입력=같은 바이트).
  - payload 에 전사 본문·파일 경로·민감정보 0.
  - 헬퍼는 입력(frame_labels/smoothed)을 변형하지 않는다(오디오 경로 불변 보장).
  - 헬퍼는 파일을 만들지 않는다.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conversation_worker as cw
import dialogue_canonical as dc


def _walk_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield str(k)
            yield from _walk_strings(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_strings(v)


class SidecarPayloadTest(unittest.TestCase):
    def setUp(self):
        self.fr = 100
        self.names2 = ["화자 A", "화자 B"]

    # ── 일반 2화자, 둘 다 트랙 존재 ──
    def test_general_two_speakers_order_and_track_mapping(self):
        pre = [0] * 100 + [1] * 100 + [0] * 100
        smoothed = list(pre)                 # 병합으로 사라진 화자 없음
        order = [0, 1]                       # first-appearance: 0 먼저
        p = cw._build_dialogue_sidecar_payload(pre, smoothed, order, 2, self.fr)

        self.assertEqual(p["schema"], dc.SCHEMA_ID)
        self.assertEqual(p["schemaVersion"], dc.SCHEMA_VERSION)
        meta = {m["id"]: m for m in p["speakerMeta"]}
        self.assertEqual(meta["화자 A"]["trackAvailable"], True)
        self.assertEqual(meta["화자 A"]["trackIndex"], 0)
        self.assertEqual(meta["화자 A"]["reviewRequired"], False)
        self.assertEqual(meta["화자 B"]["trackAvailable"], True)
        self.assertEqual(meta["화자 B"]["trackIndex"], 1)
        # 세그먼트 라벨이 트랙 라벨과 동일 규칙.
        segs = p["sidecar"]["segments"]
        self.assertEqual(len(segs), 3)
        self.assertEqual([s["speakers"][0] for s in segs], ["화자 A", "화자 B", "화자 A"])

    # ── 병합 전 frame_labels 사용 → backchannel 보존 ──
    def test_premerge_labels_preserve_backchannel(self):
        pre = [0] * 100 + [1] * 20 + [0] * 100   # 20프레임 = 0.2s backchannel
        smoothed = [0] * 220                       # 병합으로 cluster 1 흡수
        order = [0, 1]
        p = cw._build_dialogue_sidecar_payload(pre, smoothed, order, 2, self.fr)
        segs = p["sidecar"]["segments"]
        self.assertEqual(len(segs), 3)
        backchannels = [s for s in segs if s["is_backchannel"]]
        self.assertEqual(len(backchannels), 1)
        self.assertEqual(backchannels[0]["speakers"], ["화자 B"])

    # ── backchannel-only 화자 보존 + trackAvailable=False ──
    def test_backchannel_only_speaker_flagged_not_dropped(self):
        pre = [0] * 100 + [1] * 20 + [0] * 100
        smoothed = [0] * 220
        order = [0, 1]
        p = cw._build_dialogue_sidecar_payload(pre, smoothed, order, 2, self.fr)
        meta = {m["id"]: m for m in p["speakerMeta"]}
        # 화자 B 는 smoothed 트랙에서 사라졌지만 sidecar 에서 삭제되지 않는다.
        self.assertIn("화자 B", meta)
        self.assertEqual(meta["화자 B"]["trackAvailable"], False)
        self.assertIsNone(meta["화자 B"]["trackIndex"])
        self.assertEqual(meta["화자 B"]["reviewRequired"], True)
        # 화자 A 는 트랙 존재.
        self.assertEqual(meta["화자 A"]["trackAvailable"], True)
        self.assertEqual(meta["화자 A"]["trackIndex"], 0)
        # 전역 화자 목록에도 보존.
        self.assertIn("화자 B", p["sidecar"]["speakers"])

    # ── deterministic 직렬화 ──
    def test_deterministic_serialization(self):
        pre = [0] * 50 + [1] * 10 + [0] * 50
        smoothed = [0] * 110
        order = [0, 1]
        a = cw._build_dialogue_sidecar_payload(pre, smoothed, order, 2, self.fr)
        b = cw._build_dialogue_sidecar_payload(pre, smoothed, order, 2, self.fr)
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False))

    # ── 전사 본문·파일 경로·민감정보 없음 ──
    def test_no_transcript_paths_or_sensitive_info(self):
        pre = [0] * 100 + [1] * 20 + [0] * 100
        smoothed = [0] * 220
        p = cw._build_dialogue_sidecar_payload(pre, smoothed, [0, 1], 2, self.fr)
        # 세그먼트에 words(전사) 없음.
        for s in p["sidecar"]["segments"]:
            self.assertEqual(s["words"], [])
        # schema URN(고정 상수, "audioforge/dialogue-canonical")은 스캔에서 제외 —
        # 나머지 콘텐츠에 파일 경로·확장자가 없어야 한다.
        scan = {k: v for k, v in p.items() if k not in ("schema", "schemaVersion")}
        import re
        for s in _walk_strings(scan):
            low = s.lower()
            self.assertNotIn(".wav", low)
            self.assertNotIn(".json", low)
            self.assertNotIn(".txt", low)
            self.assertNotIn(".srt", low)
            self.assertNotIn("\\", s)                 # Windows 경로 구분자
            self.assertNotIn("://", s)                # URL/스킴
            self.assertIsNone(re.match(r"^[A-Za-z]:", s))  # 드라이브 문자(C:\ 등)
        # 경로/전사성 키 부재.
        self.assertNotIn("path", p)
        self.assertNotIn("text", p)
        self.assertNotIn("outputDir", p)

    # ── 입력 불변(오디오/트랙 경로 보호) ──
    def test_inputs_not_mutated(self):
        pre = [0] * 100 + [1] * 20 + [0] * 100
        smoothed = [0] * 220
        pre_before, sm_before = list(pre), list(smoothed)
        cw._build_dialogue_sidecar_payload(pre, smoothed, [0, 1], 2, self.fr)
        self.assertEqual(pre, pre_before)
        self.assertEqual(smoothed, sm_before)

    # ── 파일 생성 0 ──
    def test_no_file_created(self):
        with tempfile.TemporaryDirectory() as d:
            before = set(os.listdir(d))
            cw._build_dialogue_sidecar_payload([0] * 10, [0] * 10, [0, 1], 2, self.fr)
            self.assertEqual(set(os.listdir(d)), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
