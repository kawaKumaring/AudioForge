# -*- coding: utf-8 -*-
"""실패 종료 사유 분류 — 시간 초과 / 모델 상한 / 분할 실패 / worker 감시 / 참조 준비 / 취소를 섞지 않는다."""
import unittest

import chunk_publish as cp


class FailureClassTest(unittest.TestCase):
    def test_codes_map_to_distinct_classes(self):
        self.assertEqual(cp.failure_class_for("GENERATION_LIMIT_EXCEEDED"), cp.FAILURE_CLASS_MODEL_CAP)
        self.assertEqual(cp.failure_class_for("JOB_WALL_TIME_EXCEEDED"), cp.FAILURE_CLASS_TIME_LIMIT)
        self.assertEqual(cp.failure_class_for("JOB_STALLED"), cp.FAILURE_CLASS_TIME_LIMIT)
        self.assertEqual(cp.failure_class_for("JOB_BUDGET_EXHAUSTED"), cp.FAILURE_CLASS_TIME_LIMIT)
        self.assertEqual(cp.failure_class_for("TEXT_SEGMENT_TOO_LONG"), cp.FAILURE_CLASS_SPLIT)
        self.assertEqual(cp.failure_class_for("QWEN_NO_RESPONSE"), cp.FAILURE_CLASS_WORKER_WATCHDOG)
        self.assertEqual(cp.failure_class_for("SPEAKER_NOT_REGISTERED"), cp.FAILURE_CLASS_REFERENCE_PREP)
        self.assertEqual(cp.failure_class_for("SPEAKER_REFERENCE_NOT_READY"), cp.FAILURE_CLASS_REFERENCE_PREP)
        self.assertEqual(cp.failure_class_for("CANCELLED"), cp.FAILURE_CLASS_USER_CANCEL)
        self.assertEqual(cp.failure_class_for("RuntimeError"), cp.FAILURE_CLASS_OTHER)   # 추측하지 않는다
        self.assertEqual(cp.failure_class_for(None), cp.FAILURE_CLASS_OTHER)

    def test_extra_keeps_only_numbers_and_ids(self):
        payload = {"code": "GENERATION_LIMIT_EXCEEDED", "segment_index": 2, "chunk_index": 0, "emotion_id": "happy",
                   "generated_iterations": 512, "generation_limit": 512, "resplit_attempts": 1,
                   "text": "대사 원문", "path": "C:/x.wav", "speaker_label": "이름"}
        out = cp.failure_extra_from_payload("GENERATION_LIMIT_EXCEEDED", payload)
        self.assertEqual(out["error_code"], "GENERATION_LIMIT_EXCEEDED")
        self.assertEqual(out["failure_class"], cp.FAILURE_CLASS_MODEL_CAP)
        self.assertEqual(out["generated_iterations"], 512)
        self.assertEqual(out["resplit_attempts"], 1)
        for forbidden in ("text", "path", "speaker_label"):
            self.assertNotIn(forbidden, out)

    def test_extra_without_payload_still_classifies(self):
        out = cp.failure_extra_from_payload("JOB_STALLED", None)
        self.assertEqual(out, {"error_code": "JOB_STALLED", "failure_class": cp.FAILURE_CLASS_TIME_LIMIT})


if __name__ == "__main__":
    unittest.main()
