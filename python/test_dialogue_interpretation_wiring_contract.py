# -*- coding: utf-8 -*-
"""posterior 해석 → dialogueSidecar **additive** 배선 계약 테스트 — 합성 전용.

아직 production 배선을 하지 않는다(conversation_worker.py 미수정). 대신 계획된
additive payload 조립을 순수 파이썬으로 재현해서, 배선이 반드시 지켜야 할 계약을
불변식으로 고정한다. 실제 배선을 넣을 때 이 계약이 회귀 가드가 된다.
(test_dialogue_wiring_contract.py 가 merge_short_turns 를 재현한 것과 동일한 방식.)

배경(develop 실측):
  - conversation_worker._build_dialogue_sidecar_payload 는 argmax hard-label sidecar
    (posterior={label:1.0}, status=OK, overlap 없음)를 versioned payload 로 만든다.
  - dialogue_quality_p1.interpret_posteriors 는 프레임 posterior 를 해석해
    overlap 다중 라벨 + UNKNOWN/REVIEW 세그먼트를 만든다(미배선).

검증 계약:
  (I1) posterior 해석은 기존 payload 에 **추가**(additive)만 한다 — 기존
       hard-label `sidecar` 와 `speakerMeta` 는 posterior 유무와 무관하게 byte-동일.
  (I2) interpretation 블록은 자체 discriminator(kind) + overlap/UNKNOWN/REVIEW 를
       담는다(hard-label 은 전부 OK·단일 라벨이라 이 정보가 없다).
  (I3) 두 sidecar 는 같은 schema id/version 을 쓰므로, 구분은 wrapper 의 kind 와
       source.pipeline 로 한다(schema 충돌 회피).
  (I4) deterministic — 같은 입력 = 같은 바이트.
  (I5) 입력(frame_labels/smoothed/posteriors/mask) 불변, 파일 생성 0.
  (I6) payload 에 전사 본문·파일 경로·민감정보 0(해석 블록 포함).
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conversation_worker as cw
import dialogue_canonical as dc
import dialogue_quality_p1 as q1


def _rows(n, row):
    return [list(row) for _ in range(n)]


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


# 계획된 additive 조립을 순수 파이썬으로 재현 (production 미수정).
# 실제 배선 diff 는 이 함수와 동등한 결과를 내야 한다.
def build_additive_payload(frame_labels, smoothed, order, n_speakers, frame_rate,
                           frame_posteriors=None, speech_mask=None):
    payload = cw._build_dialogue_sidecar_payload(
        frame_labels, smoothed, order, n_speakers, frame_rate)
    if frame_posteriors is None:
        return payload  # posterior 없으면 기존 payload 그대로(불변).

    # order 기반 canonical 라벨 (hard-label helper 와 동일 규칙).
    label_of = {c: f"화자 {chr(65 + idx)}" for idx, c in enumerate(order)}
    speaker_names = [label_of.get(c, f"화자 {chr(65 + c)}") for c in range(n_speakers)]

    segs = q1.interpret_posteriors(
        frame_posteriors, frame_rate, speaker_names,
        frame_confidence=None,          # P1: margin 대용(speaker_weights 는 [0,1] 아님)
        speech_mask=speech_mask,
    )
    interp = q1.to_sidecar(
        segs, source={"pipeline": "posterior-interpret",
                      "frame_rate": str(int(frame_rate))})
    payload["interpretation"] = {
        "kind": "posterior-interpretation",
        "schema": dc.SCHEMA_ID,
        "schemaVersion": dc.SCHEMA_VERSION,
        "sidecar": interp.to_dict(),
        "overlapCount": sum(1 for s in segs if s.is_overlap),
        "unknownCount": sum(1 for s in segs if s.status == dc.SegmentStatus.UNKNOWN),
        "reviewCount": sum(1 for s in segs if s.status == dc.SegmentStatus.REVIEW),
    }
    return payload


class InterpretationWiringContractTest(unittest.TestCase):
    def setUp(self):
        self.fr = 100
        self.n = 2
        self.order = [0, 1]
        # A(OK) 1.0s → 0.5/0.5(UNKNOWN overlap) 0.5s → 0.7/0.3(REVIEW overlap) 0.6s → B(OK) 1.0s
        self.post = (_rows(100, [0.9, 0.1]) + _rows(50, [0.5, 0.5])
                     + _rows(60, [0.7, 0.3]) + _rows(100, [0.05, 0.95]))
        self.mask = [True] * len(self.post)
        # hard-label 경로 입력: argmax 라벨(무음 없음), smoothed=동일.
        self.frame_labels = [0] * 150 + [0] * 60 + [1] * 100  # argmax: 0.7/0.3→0
        self.smoothed = list(self.frame_labels)

    def test_i1_hardlabel_payload_unchanged_by_posterior(self):
        base = cw._build_dialogue_sidecar_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr)
        withp = build_additive_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr,
            frame_posteriors=self.post, speech_mask=self.mask)
        # 기존 최상위 필드가 byte-동일.
        self.assertEqual(withp["schema"], base["schema"])
        self.assertEqual(withp["schemaVersion"], base["schemaVersion"])
        self.assertEqual(
            json.dumps(withp["sidecar"], sort_keys=True, ensure_ascii=False),
            json.dumps(base["sidecar"], sort_keys=True, ensure_ascii=False))
        self.assertEqual(
            json.dumps(withp["speakerMeta"], sort_keys=True, ensure_ascii=False),
            json.dumps(base["speakerMeta"], sort_keys=True, ensure_ascii=False))
        # interpretation 은 순수 추가 키.
        self.assertNotIn("interpretation", base)
        self.assertIn("interpretation", withp)

    def test_i1b_hardlabel_is_all_ok_single_label(self):
        # hard-label sidecar 에는 overlap·UNKNOWN·REVIEW 가 원천적으로 없다.
        base = cw._build_dialogue_sidecar_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr)
        for s in base["sidecar"]["segments"]:
            self.assertEqual(s["status"], "OK")
            self.assertFalse(s["is_overlap"])
            self.assertEqual(len(s["speakers"]), 1)

    def test_i2_interpretation_captures_overlap_unknown_review(self):
        p = build_additive_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr,
            frame_posteriors=self.post, speech_mask=self.mask)
        interp = p["interpretation"]
        self.assertEqual(interp["kind"], "posterior-interpretation")
        self.assertGreaterEqual(interp["overlapCount"], 1)
        self.assertGreaterEqual(interp["unknownCount"], 1)
        self.assertGreaterEqual(interp["reviewCount"], 1)
        statuses = {s["status"] for s in interp["sidecar"]["segments"]}
        self.assertIn("UNKNOWN", statuses)
        self.assertIn("REVIEW", statuses)
        overlaps = [s for s in interp["sidecar"]["segments"] if s["is_overlap"]]
        self.assertTrue(all(len(s["speakers"]) >= 2 for s in overlaps))

    def test_i3_schema_shared_discriminator_by_kind_and_pipeline(self):
        p = build_additive_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr,
            frame_posteriors=self.post, speech_mask=self.mask)
        # 같은 schema id/version 이라도 pipeline 으로 구분된다(namespace 충돌 회피).
        self.assertEqual(p["sidecar"]["schema"], p["interpretation"]["sidecar"]["schema"])
        self.assertEqual(p["sidecar"]["source"].get("pipeline"), "argmax-mask")
        self.assertEqual(p["interpretation"]["sidecar"]["source"].get("pipeline"),
                         "posterior-interpret")

    def test_i4_deterministic(self):
        a = build_additive_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr,
            frame_posteriors=self.post, speech_mask=self.mask)
        b = build_additive_payload(
            list(self.frame_labels), list(self.smoothed), list(self.order),
            self.n, self.fr, frame_posteriors=[list(r) for r in self.post],
            speech_mask=list(self.mask))
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False))

    def test_i5_inputs_not_mutated_and_no_file(self):
        fl, sm = list(self.frame_labels), list(self.smoothed)
        post = [list(r) for r in self.post]
        mask = list(self.mask)
        fl_b, sm_b, post_b, mask_b = list(fl), list(sm), [list(r) for r in post], list(mask)
        with tempfile.TemporaryDirectory() as d:
            before = set(os.listdir(d))
            build_additive_payload(fl, sm, self.order, self.n, self.fr,
                                   frame_posteriors=post, speech_mask=mask)
            self.assertEqual(set(os.listdir(d)), before)
        self.assertEqual(fl, fl_b)
        self.assertEqual(sm, sm_b)
        self.assertEqual(post, post_b)
        self.assertEqual(mask, mask_b)

    def test_i6_no_transcript_paths_or_sensitive_info(self):
        p = build_additive_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr,
            frame_posteriors=self.post, speech_mask=self.mask)
        for s in p["interpretation"]["sidecar"]["segments"]:
            self.assertEqual(s["words"], [])  # 전사 본문 없음.
        # schema URN 상수는 스캔 제외, 나머지에 경로/확장자 없음.
        import re
        scan = {k: v for k, v in p["interpretation"].items()
                if k not in ("schema", "schemaVersion")}
        # 내부 sidecar 의 schema 상수도 제외.
        scan["sidecar"] = {k: v for k, v in scan["sidecar"].items() if k != "schema"}
        for s in _walk_strings(scan):
            low = s.lower()
            self.assertNotIn(".wav", low)
            self.assertNotIn(".json", low)
            self.assertNotIn("\\", s)
            self.assertNotIn("://", s)
            self.assertIsNone(re.match(r"^[A-Za-z]:", s))


if __name__ == "__main__":
    unittest.main(verbosity=2)
