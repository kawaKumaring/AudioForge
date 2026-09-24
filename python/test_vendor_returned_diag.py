# -*- coding: utf-8 -*-
"""진단용 vendor 반환 PCM 보존이 **실제로 파일을 남기는지.**

★왜 이 검사가 필요한가(2026-09-24 2차 감사)
  이 기능은 2026-08-30 도입 이후 **한 번도 동작한 적이 없었다.** 기록을 만들면서
  이 모듈에 정의된 적 없는 이름을 참조해 NameError 로 죽었고, 그것을 감싼
  `except Exception` 이 `reason="NameError"` 한 줄로 바꿔 흘려서
  **코드 결함이 일시적 환경 문제처럼 읽혔다.**

  숨은 이유는 하나 더 있다 — 이 함수에 검사가 **0건**이었다.
  "기록이 남는다" 를 보는 검사는 있었지만 그것은 다른 곳의 키를 봤다.
  그래서 3주 넘게 아무도 몰랐다.

  여기서는 **실제로 함수를 불러 파일이 생기는지** 본다. 사용자 미디어를 쓰지 않는다 —
  합성한 무음 파형만 쓴다.
"""
import io
import json
import os
import sys
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load():
    """qwen_bridge 를 불러온다. 무거운 의존이 없으면 건너뛴다."""
    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except Exception as e:      # pragma: no cover - 환경에 따라 다르다
        raise unittest.SkipTest('numpy/soundfile 없음: %s' % e)
    try:
        import qwen_bridge
    except Exception as e:      # pragma: no cover
        raise unittest.SkipTest('qwen_bridge 를 불러오지 못함: %s' % e)
    return qwen_bridge


class TestVendorReturnedDiag(unittest.TestCase):
    def setUp(self):
        self.qb = _load()
        self.dir = tempfile.mkdtemp(prefix='af-vendor-diag-')
        self.emitted = []
        self._orig_emit = self.qb.emit

        def spy(msg_type, **kw):
            self.emitted.append(dict(kw, type=msg_type))

        self.qb.emit = spy

    def tearDown(self):
        self.qb.emit = self._orig_emit
        shutil.rmtree(self.dir, ignore_errors=True)

    def _run(self, samples=1600, sr=16000):
        import numpy as np
        d = np.zeros(samples, dtype='float32')
        self.qb._vendor_returned(self.dir, d, sr, {'generated_iterations': 8}, None, 0)

    def _stage(self, name):
        return [e for e in self.emitted if e.get('stage') == name]

    def test_파일이_실제로_생긴다(self):
        """★도입 이후 한 번도 생긴 적이 없던 그 파일들이다."""
        self._run()
        self.assertEqual(self._stage('vendor_returned_failed'), [],
                         '보존이 실패했다: %s' % self.emitted)
        self.assertTrue(self._stage('vendor_returned_kept'), '보존 성공을 알리지 않았다')
        base = os.path.join(self.dir, 'vendor-returned-target-only')
        self.assertTrue(os.path.isfile(base + '.wav'), 'PCM 이 남지 않았다')
        self.assertTrue(os.path.isfile(base + '.json'), '기록이 남지 않았다')

    def test_임시_파일을_남기지_않는다(self):
        """예전에는 .wav 도 .json 도 없이 orphan .part 만 남았다."""
        self._run()
        leftovers = [n for n in os.listdir(self.dir) if n.endswith('.part')]
        self.assertEqual(leftovers, [], '임시 파일이 남았다')

    def test_모르는_값을_지어내지_않는다(self):
        """★같은 기록 안에서 자기모순이었다 — UNKNOWN 이라 적고 아래에서 단언했다.

        vendor 가 돌려주지 않는 좌표를 고정 상수로 역산해 **관측값인 척**하던 필드
        셋을 지웠다. 모른다는 기록은 남긴다 — 그것도 사실이다.
        """
        self._run()
        rec = json.load(io.open(
            os.path.join(self.dir, 'vendor-returned-target-only.json'), encoding='utf-8'))
        for gone in ('codec_hop_samples', 'crop_formula', 'predicted_returned_samples_if_exact'):
            self.assertNotIn(gone, rec, '지어낸 값이 되살아났다: %s' % gone)
        for unknown in ('ref_code_frames', 'total_code_frames',
                        'decoded_total_samples', 'vendor_internal_cut_samples'):
            self.assertEqual(rec.get(unknown), 'UNKNOWN',
                             '모른다는 기록이 사라졌다: %s' % unknown)
        self.assertIs(rec.get('diagnostic_only'), True)
        self.assertIs(rec.get('production_result'), False)

    def test_실패하면_무엇이_잘못됐는지_말한다(self):
        """★예외 이름만 남기면 코드 결함과 환경 문제를 가를 수 없다.

        실제로 그래서 `reason=NameError` 한 줄이 3주 넘게 '환경 탓' 처럼 읽혔다.
        """
        # 숫자로 바꿀 수 없는 값을 넣어 쓰기 단계에서 걸리게 한다.
        self.qb._vendor_returned(self.dir, ['소리가 아님'], 16000,
                                 {'generated_iterations': 1}, None, 0)
        failed = self._stage('vendor_returned_failed')
        self.assertTrue(failed, '실패를 알리지 않았다')
        self.assertIn('detail', failed[0], '무엇이 잘못됐는지 말하지 않는다')
        self.assertTrue(str(failed[0]['detail']).strip(), 'detail 이 비어 있다')

    def test_보존_실패가_발행을_막지_않는다(self):
        """진단 보존은 절대 본 작업을 죽이지 않는다 — 이 파일의 규칙이다."""
        import numpy as np
        try:
            self.qb._vendor_returned(None, np.zeros(10, dtype='float32'), 16000, {}, None, 0)
        except Exception as e:      # pragma: no cover
            self.fail('진단 보존이 예외를 밖으로 냈다: %r' % e)


class TestSiblingDiagnosticsCarryDetail(unittest.TestCase):
    """형제 보존 함수 둘도 같은 자리에서 메시지를 버리고 있었다."""

    def test_세_자리_모두_detail_을_싣는다(self):
        here = os.path.dirname(os.path.abspath(__file__))
        src = io.open(os.path.join(here, 'qwen_bridge.py'), encoding='utf-8').read()
        for stage in ('vendor_returned_failed', 'generation_limit_partial_failed',
                      'diagnostic_raw_failed'):
            at = src.index('stage="%s"' % stage)
            window = src[at:at + 200]
            self.assertIn('detail=', window,
                          '%s 가 무엇이 잘못됐는지 말하지 않는다' % stage)


if __name__ == '__main__':
    unittest.main(verbosity=2)
