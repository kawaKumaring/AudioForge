# -*- coding: utf-8 -*-
"""posterior 해석 → dialogueSidecar **additive** 배선 계약 테스트 — synthetic 전용.

이제 production 배선(conversation_worker.py)을 실제로 구동한다(모델·GPU·오디오 없음:
무거운 import 는 run_conversation_separation 안에만 있으므로 순수 헬퍼는 그대로 호출
가능). run_conversation_separation 의 emit 블록이 부르는 것과 동일한 순수 헬퍼
(_build_dialogue_sidecar_payload / _attach_interpretation / _build_dialogue_interpretation /
_unavailable_interpretation)를 직접 호출해 계약을 고정한다.

계약(승인 결정 반영):
  (I1) 기존 hard-label payload(sidecar/speakerMeta)는 interpretation 부착 전후 byte-동일.
  (I2) interpretation 은 별도 namespace 로 additive: schemaVersion/status/experimental/
       segments/summary/thresholds/source.
  (I3) source.pipeline="posterior-interpret", experimental=True.
  (I4) posterior 순위만 교차(같은 화자 집합·같은 상태)하면 세그먼트를 불필요하게 나누지 않음.
  (I5) overlap·UNKNOWN·REVIEW 를 해석해 담는다(hard-label 은 전부 OK 단일이라 없음).
  (I6) <500ms backchannel 보존.
  (I7) 해석 실패는 내부 try 로 격리 → hard-label payload 불변, status=unavailable,
       safe error code(예외 클래스명)만 포함(traceback·경로·score 배열 없음).
  (I8) 파일 생성 0, 입력 불변.
  (I9) payload 에 전사 본문·파일 경로·민감정보 없음, thresholds 는 확정 정확도값이 아님을 명시.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import conversation_worker as cw
import dialogue_canonical as dc


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


class InterpretationWiringContractTest(unittest.TestCase):
    def setUp(self):
        self.fr = 100
        self.n = 2
        self.order = [0, 1]
        _, self.names = cw._canonical_labels(self.order, self.n)
        # A(OK) 1.0s → 0.5/0.5(UNKNOWN overlap) 0.5s → 0.7/0.3(REVIEW overlap) 0.6s → B(OK) 1.0s
        self.post = (_rows(100, [0.9, 0.1]) + _rows(50, [0.5, 0.5])
                     + _rows(60, [0.7, 0.3]) + _rows(100, [0.05, 0.95]))
        self.mask = [True] * len(self.post)
        self.frame_labels = [0] * 210 + [1] * 100   # argmax hard-label
        self.smoothed = list(self.frame_labels)

    def _hardlabel(self):
        return cw._build_dialogue_sidecar_payload(
            self.frame_labels, self.smoothed, self.order, self.n, self.fr)

    def _with_interp(self):
        p = self._hardlabel()
        cw._attach_interpretation(p, self.post, self.mask, self.names, self.fr)
        return p

    # (I1) hard-label 불변 ---------------------------------------------------
    def test_i1_hardlabel_unchanged_by_interpretation(self):
        base = self._hardlabel()
        withp = self._with_interp()
        self.assertEqual(withp["schema"], base["schema"])
        self.assertEqual(withp["schemaVersion"], base["schemaVersion"])
        self.assertEqual(
            json.dumps(withp["sidecar"], sort_keys=True, ensure_ascii=False),
            json.dumps(base["sidecar"], sort_keys=True, ensure_ascii=False))
        self.assertEqual(
            json.dumps(withp["speakerMeta"], sort_keys=True, ensure_ascii=False),
            json.dumps(base["speakerMeta"], sort_keys=True, ensure_ascii=False))
        self.assertNotIn("interpretation", base)
        self.assertIn("interpretation", withp)

    def test_i1b_hardlabel_all_ok_single_label(self):
        base = self._hardlabel()
        for s in base["sidecar"]["segments"]:
            self.assertEqual(s["status"], "OK")
            self.assertFalse(s["is_overlap"])
            self.assertEqual(len(s["speakers"]), 1)

    # (I2)(I3) additive namespace 구조 --------------------------------------
    def test_i2_i3_interpretation_namespace_shape(self):
        interp = self._with_interp()["interpretation"]
        self.assertEqual(set(interp) >= {
            "schemaVersion", "status", "experimental",
            "segments", "summary", "thresholds", "source"}, True)
        self.assertEqual(interp["status"], "available")
        self.assertIs(interp["experimental"], True)
        self.assertEqual(interp["source"]["pipeline"], "posterior-interpret")
        self.assertEqual(set(interp["summary"]),
                         {"overlapCount", "unknownCount", "reviewCount"})

    # (I4) 순위 교차 불필요 분할 없음 ----------------------------------------
    def test_i4_posterior_rank_swap_no_extra_split(self):
        post = _rows(60, [0.6, 0.4]) + _rows(60, [0.4, 0.6])  # 같은 {A,B}·같은 UNKNOWN
        p = {"schema": "x", "schemaVersion": "y", "sidecar": {}, "speakerMeta": []}
        cw._attach_interpretation(p, post, [True] * len(post), self.names, self.fr)
        segs = p["interpretation"]["segments"]
        self.assertEqual(len(segs), 1)             # 순위만 교차 → 분할 없음
        self.assertTrue(segs[0]["is_overlap"])

    # (I5) overlap/unknown/review -------------------------------------------
    def test_i5_overlap_unknown_review_captured(self):
        interp = self._with_interp()["interpretation"]
        self.assertGreaterEqual(interp["summary"]["overlapCount"], 1)
        self.assertGreaterEqual(interp["summary"]["unknownCount"], 1)
        self.assertGreaterEqual(interp["summary"]["reviewCount"], 1)
        statuses = {s["status"] for s in interp["segments"]}
        self.assertIn("UNKNOWN", statuses)
        self.assertIn("REVIEW", statuses)
        for s in interp["segments"]:
            if s["is_overlap"]:
                self.assertGreaterEqual(len(s["speakers"]), 2)

    # (I6) backchannel 보존 -------------------------------------------------
    def test_i6_backchannel_preserved(self):
        post = _rows(100, [0.95, 0.05]) + _rows(20, [0.05, 0.95]) + _rows(100, [0.95, 0.05])
        p = {"schema": "x", "schemaVersion": "y", "sidecar": {}, "speakerMeta": []}
        cw._attach_interpretation(p, post, [True] * len(post), self.names, self.fr)
        segs = p["interpretation"]["segments"]
        bc = [s for s in segs if s["is_backchannel"]]
        self.assertEqual(len(bc), 1)               # 0.2s B turn 이 세그먼트로 보존
        self.assertEqual(bc[0]["speakers"], ["화자 B"])

    # (I7) 해석 실패 격리 → hard-label 보호 ----------------------------------
    def test_i7_failure_isolated_hardlabel_protected(self):
        base = self._hardlabel()
        p = self._hardlabel()
        # frame_rate<=0 → interpret_posteriors 가 ValueError. 내부 try 로 격리돼야 한다.
        cw._attach_interpretation(p, self.post, self.mask, self.names, 0)
        # hard-label 필드 불변.
        self.assertEqual(
            json.dumps(p["sidecar"], sort_keys=True, ensure_ascii=False),
            json.dumps(base["sidecar"], sort_keys=True, ensure_ascii=False))
        self.assertEqual(p["speakerMeta"], base["speakerMeta"])
        interp = p["interpretation"]
        self.assertEqual(interp["status"], "unavailable")
        self.assertEqual(interp["segments"], [])
        self.assertEqual(interp["summary"],
                         {"overlapCount": 0, "unknownCount": 0, "reviewCount": 0})
        # safe error code = 예외 클래스명만(메시지/traceback/경로/score 없음).
        self.assertEqual(interp["errorCode"], "ValueError")

    def test_i7b_error_code_has_no_leak(self):
        interp = cw._unavailable_interpretation("ValueError")
        for s in _walk_strings(interp):
            self.assertNotIn("\\", s)
            self.assertNotIn("/", s.replace("posterior-interpret", ""))  # pipeline 문자열 제외
            self.assertNotIn("Traceback", s)

    # (I8) 파일 0 · 입력 불변 -------------------------------------------------
    def test_i8_no_file_and_inputs_immutable(self):
        post = [list(r) for r in self.post]
        mask = list(self.mask)
        post_b, mask_b = [list(r) for r in post], list(mask)
        with tempfile.TemporaryDirectory() as d:
            before = set(os.listdir(d))
            p = self._hardlabel()
            cw._attach_interpretation(p, post, mask, self.names, self.fr)
            self.assertEqual(set(os.listdir(d)), before)
        self.assertEqual(post, post_b)
        self.assertEqual(mask, mask_b)

    # (I9) 민감정보 없음 · thresholds 면책 표기 -------------------------------
    def test_i9_no_sensitive_info_and_threshold_disclaimer(self):
        interp = self._with_interp()["interpretation"]
        for s in interp["segments"]:
            self.assertEqual(s["words"], [])       # 전사 본문 없음
        import re
        scan = {k: v for k, v in interp.items() if k not in ("schemaVersion", "source")}
        for s in _walk_strings(scan):
            low = s.lower()
            self.assertNotIn(".wav", low)
            self.assertNotIn(".json", low)
            self.assertNotIn("\\", s)
            self.assertNotIn("://", s)
            self.assertIsNone(re.match(r"^[A-Za-z]:", s))
        # 임계는 synthetic 검증값이며 확정 정확도가 아님을 명시.
        self.assertIn("note", interp["thresholds"])
        self.assertIn("synthetic", interp["thresholds"]["note"])

    # deterministic ----------------------------------------------------------
    def test_deterministic(self):
        a = self._with_interp()
        b = self._with_interp()
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False),
                         json.dumps(b, sort_keys=True, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
