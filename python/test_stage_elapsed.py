# -*- coding: utf-8 -*-
"""합성 작업의 **단계별 소요가 실제로 기록되는지.**

★왜 이 검사가 필요한가(2026-09-25)
  성능을 고치려고 로그를 집계했더니, 남는 것은 작업 전체 소요 한 줄뿐이었다.
  71초가 모델 올리는 데 갔는지 생성에 갔는지 물으면 **총시간에서 빼는 간접 계산**밖에
  없었다.

  그런데 적을 칸은 처음부터 있었다 — `ChunkRecorder.stage_elapsed` 가 그것이고
  기록 파일에도 `stage_elapsed` 키로 나간다. **부르는 곳이 한 곳도 없어서** 언제나
  빈 배열이었을 뿐이다. 브리지도 마찬가지로 단계마다 경과를 재서 보내는데
  부모가 그 숫자를 읽지 않고 버렸다.

  즉 **재는 비용은 이미 치르고 있었는데 값을 버리고 있었다.**
  재지 못하면 고쳐도 나아졌는지 증명할 수 없다 — 그래서 계측이 먼저다.

여기서는 기록기와 부모의 배선만 본다. 모델을 돌리지 않는다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chunk_publish  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class TestRecorderKeepsStages(unittest.TestCase):
    def _rec(self):
        r = chunk_publish.ChunkRecorder.__new__(chunk_publish.ChunkRecorder)
        r.active = True
        r.header = {}
        r.stages = []
        return r

    def test_단계를_적으면_남는다(self):
        r = self._rec()
        r.stage_elapsed('model_load', 12.3456)
        r.stage_elapsed('run_job', 71.2)
        self.assertEqual([x['stage'] for x in r.stages], ['model_load', 'run_job'])
        self.assertEqual(r.stages[0]['elapsed_sec'], 12.346)

    def test_값이_없으면_적지_않는다(self):
        """★없는 값을 0으로 적으면 **안 걸린 것처럼 보인다** — 그것이 더 나쁘다."""
        r = self._rec()
        r.stage_elapsed('model_load', None)
        self.assertEqual(r.stages, [])

    def test_기록이_꺼져_있으면_아무것도_안_한다(self):
        r = self._rec()
        r.active = False
        r.stage_elapsed('model_load', 1.0)
        self.assertEqual(r.stages, [])


class TestParentWiring(unittest.TestCase):
    """★칸을 채우는 코드가 실제로 붙어 있는지. 없으면 기록은 영원히 빈 배열이다."""

    def setUp(self):
        self.src = io.open(os.path.join(HERE, 'tts_worker.py'), encoding='utf-8').read()

    def test_브리지가_보낸_경과를_줍는다(self):
        self.assertIn("msg.get(\"elapsed_sec\")", self.src,
                      '브리지가 재서 보낸 숫자를 다시 버리고 있다')

    def test_네_단계를_기록에_남긴다(self):
        for name in ('model_load', 'bridge_loaded', 'bridge_generating', 'run_job'):
            self.assertIn("stage_elapsed('%s'" % name, self.src,
                          '%s 단계가 기록되지 않는다' % name)

    def test_부모_시계와_브리지_시계를_섞지_않는다(self):
        """뜻이 다른 두 시계를 한 이름으로 합치면 숫자를 읽을 수 없게 된다.

        부모는 '프로세스를 띄운 뒤' 를, 브리지는 '제가 뜬 뒤' 를 잰다 —
        브리지 값에는 파이썬 기동·torch import 가 **들어 있지 않다.**
        """
        self.assertIn('bridge_loaded', self.src)
        self.assertIn('model_load', self.src)
        self.assertNotIn("stage_elapsed('load'", self.src, '뜻이 다른 둘을 한 이름으로 합쳤다')


class TestStageNamesAreStable(unittest.TestCase):
    """이름이 바뀌면 지난 기록과 견줄 수 없다 — 성능 비교의 전제가 무너진다."""

    def test_이름은_영문_소문자와_밑줄뿐(self):
        src = io.open(os.path.join(HERE, 'tts_worker.py'), encoding='utf-8').read()
        import re
        names = set(re.findall(r"stage_elapsed\('([^']+)'", src))
        self.assertTrue(names, '기록하는 단계가 하나도 없다')
        for n in names:
            self.assertRegex(n, r'^[a-z][a-z0-9_]*$', '단계 이름이 규칙에서 벗어났다: %s' % n)


if __name__ == '__main__':
    unittest.main(verbosity=2)
