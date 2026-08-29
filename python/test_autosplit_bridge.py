# -*- coding: utf-8 -*-
"""bridge 선분할·진행률(P0-1) 단위 테스트 — fake model/tokenizer, GPU 없음.

검증: 단일 chunk 30→90, 다중 chunk 단조 증가(시작/완료 각각), 2 segment 전체 chunk 기준 단조,
뒤 segment 분할 실패 시 생성 호출 0(선분할이 생성 앞에 오므로 앞 segment도 합성 안 됨).
"""
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import qwen_bridge
import generation_limit as gl


class _Ids:
    def __init__(self, n):
        self.shape = (1, n)


class _ProcLen:
    """production token 수 = 텍스트 길이(테스트용)."""
    def __call__(self, text=None, return_tensors=None):
        return {"input_ids": _Ids(len(text))}


class _ProcMark:
    """마커 'Z'가 하나라도 있으면 항상 100 토큰(문자 단위로도 못 나눔 → SegmentTooLong 유도), 그 외 길이.
    seg1 텍스트를 'ZZZZ'로 두면 어떤 단일 문자('Z')도 100 → 분할 불가."""
    def __call__(self, text=None, return_tensors=None):
        return {"input_ids": _Ids(100 if "Z" in text else len(text))}


def _builder(t):
    return t   # 래퍼 없음(prod_tokens = proc 길이)


class _FakeModel:
    def __init__(self, iters=50):
        self.iters = iters
        self.calls = 0

    def generate_voice_clone(self, text=None, language=None, ref_audio=None, ref_text=None,
                             x_vector_only_mode=False, max_new_tokens=None):
        self.calls += 1
        qwen_bridge._COUNTER["n"] = self.iters   # 상한 미만 → completed_before_limit
        return [np.zeros(2400, dtype=np.float32)], 24000


class ProgressPlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_bridgeplan_")
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.max = gl.max_segment_tokens()   # 33

    def _seg(self, i, text):
        return {"index": i, "text": text, "ref_audio": "r.wav", "ref_text": "rt",
                "x_vector_only": False, "language_name": "Korean", "emotion_id": "default",
                "out_path": os.path.join(self.tmp, f"segment_qwen_{i + 1:03d}.wav")}

    def _run(self, segments, proc):
        plan = qwen_bridge._build_chunk_plan(segments, _builder, proc, self.max)
        model = _FakeModel()
        events = []

        def progress(percent, seg_index, n, ci, cc, phase):
            events.append((percent, phase))
        done = qwen_bridge._generate_plan(model, plan, _builder, proc, len(segments), progress=progress)
        return plan, done, events, model

    def test_single_chunk_30_to_90(self):
        plan, done, events, model = self._run([self._seg(0, "짧은 문장")], _ProcLen())  # len<=33 → 1 chunk
        self.assertEqual(len(plan), 1)
        starts = [p for p, ph in events if ph == "start"]
        dones = [p for p, ph in events if ph == "done"]
        self.assertEqual(starts, [30])
        self.assertEqual(dones, [90])
        self.assertEqual(model.calls, 1)

    def test_multi_chunk_monotonic(self):
        # 3 문장(각 ~20자) → 문장 경계로 3 chunk
        text = "AAAAAAAAAAAAAAAAAAAA. BBBBBBBBBBBBBBBBBBBB. CCCCCCCCCCCCCCCCCCCC."
        plan, done, events, model = self._run([self._seg(0, text)], _ProcLen())
        self.assertGreaterEqual(len(plan), 2)
        starts = [p for p, ph in events if ph == "start"]
        dones = [p for p, ph in events if ph == "done"]
        self.assertEqual(len(starts), len(plan))
        self.assertEqual(len(dones), len(plan))
        self.assertEqual(starts[0], 30)
        self.assertEqual(dones[-1], 90)
        self.assertEqual(starts, sorted(starts))   # 단조 비감소
        self.assertEqual(dones, sorted(dones))
        self.assertEqual(model.calls, len(plan))

    def test_two_segments_monotonic_by_total(self):
        s0 = self._seg(0, "AAAAAAAAAAAAAAAAAAAA. BBBBBBBBBBBBBBBBBBBB.")   # 2 chunk
        s1 = self._seg(1, "짧은 둘째")                                      # 1 chunk
        plan, done, events, model = self._run([s0, s1], _ProcLen())
        dones = [p for p, ph in events if ph == "done"]
        self.assertEqual(dones[-1], 90)
        self.assertEqual(dones, sorted(dones))
        self.assertEqual(len(done), len(plan))
        # 원본 segment 상속 확인(모든 chunk emotion/xvo 동일)
        self.assertTrue(all(d["emotion_id"] == "default" for d in done))

    def test_rear_split_fail_no_generate(self):
        s0 = self._seg(0, "짧은 앞")
        s1 = self._seg(1, "ZZZZ")   # _ProcMark → 어떤 문자('Z')도 100 토큰, 분할 불가
        model = _FakeModel()
        with self.assertRaises(qwen_bridge.BridgeSegmentTooLong):
            qwen_bridge._build_chunk_plan([s0, s1], _builder, _ProcMark(), self.max)
        # 선분할 실패 → 생성 루프 미진입
        self.assertEqual(model.calls, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
