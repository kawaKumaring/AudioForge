# -*- coding: utf-8 -*-
"""Qwen 보조 모델 빠르게 돌리기(qwen_fast) — 값 뽑는 규칙이 transformers 와 같은가, 끄는 길이 있는가.

왜 있는가(2026-09-30): 보조 모델 15걸음을 직접 반복·묶어 실행으로 바꿔 같은 문장 29초 → 10초가 됐다.
  ★직접 반복은 원래와 **비트까지 같은 소리**였다(실측). 그 전제는 값 뽑기가 transformers 4.57 `_sample` 과 같은 순서라는 것 —
  여기서 그 규칙을 붙든다. 실제 모델로 같은 소리인지는 격리 환경에서 `python/bench_qwen_fast.py` 로 잰다(GPU).
★CPU 만 쓴다 — 모델을 불러오지 않는다.

실행: python -X utf8 python/test_qwen_fast.py
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import types
import unittest

import qwen_fast as qf

try:
    import torch
except Exception:       # 토치 없는 환경 — 규칙 검사는 건너뛴다(끄는 길 검사는 돈다)
    torch = None


@unittest.skipIf(torch is None, "torch 가 없다")
class Pick(unittest.TestCase):
    def test_뽑지_않으면_가장_큰_값(self):
        lg = torch.tensor([[0.1, 3.0, -1.0, 2.9]])
        self.assertEqual(qf._pick(lg, False, 50, 1.0, 0.9).tolist(), [1])

    def test_상위_k_밖은_절대_뽑히지_않는다(self):
        torch.manual_seed(0)
        lg = torch.arange(100, dtype=torch.float32)[None, :]
        got = {int(qf._pick(lg, True, 5, 1.0, 0.9)) for _ in range(300)}
        self.assertTrue(got <= set(range(95, 100)), got)

    def test_transformers_와_같은_순서로_뽑는다(self):
        # 같은 씨앗·같은 점수 → 같은 결과여야 한다(직접 반복이 원래와 비트까지 같았던 전제).
        lg = torch.randn(1, 2048, generator=torch.Generator().manual_seed(7))
        torch.manual_seed(123)
        ours = [int(qf._pick(lg, True, 50, 1.0, 0.9)) for _ in range(20)]
        torch.manual_seed(123)
        ref = []
        for _ in range(20):
            s = lg.to(torch.float32) / 0.9
            kth = torch.topk(s, 50)[0][..., -1, None]
            s = s.masked_fill(s < kth, float("-inf"))
            ref.append(int(torch.multinomial(torch.nn.functional.softmax(s, dim=-1), 1).squeeze(1)))
        self.assertEqual(ours, ref)


class Switch(unittest.TestCase):
    def _fake(self):
        cp = types.SimpleNamespace(generate="원래")
        return types.SimpleNamespace(model=types.SimpleNamespace(talker=types.SimpleNamespace(code_predictor=cp))), cp

    def tearDown(self):
        for k in ("AUDIOFORGE_QWEN_FAST", "AUDIOFORGE_QWEN_GRAPH"):
            os.environ.pop(k, None)

    def test_기본은_묶어_실행(self):
        m, cp = self._fake()
        self.assertEqual(qf.apply(m), "graph")
        self.assertNotEqual(cp.generate, "원래")

    def test_묶어_실행만_끌_수_있다(self):
        os.environ["AUDIOFORGE_QWEN_GRAPH"] = "0"
        m, cp = self._fake()
        self.assertEqual(qf.apply(m), "loop")

    def test_통째로_끌_수_있다(self):
        os.environ["AUDIOFORGE_QWEN_FAST"] = "0"
        m, cp = self._fake()
        self.assertIsNone(qf.apply(m))
        self.assertEqual(cp.generate, "원래")

    def test_보조_모델이_없으면_손대지_않는다(self):
        self.assertIsNone(qf.apply(types.SimpleNamespace(model=types.SimpleNamespace())))


if __name__ == "__main__":
    unittest.main(verbosity=2)
