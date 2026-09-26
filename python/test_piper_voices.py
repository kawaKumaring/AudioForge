# -*- coding: utf-8 -*-
"""piper_voices.py 단위 검사 — 진짜 모델을 열지 않는다. 가짜 폴더만 만든다.

★왜 이 검사가 있는가(2026-09-24)
  Kokoro 에서 "지원한다고 적어 두기만 하고 실제로 되는지 보지 않으면
  구하러 온 사다리가 썩어 있어도 모른다" 는 것을 겪었다(넷 중 셋이 거짓이었다).
  같은 실수를 되풀이하지 않도록, **있는 것만 있다고 말하는지**를 붙잡아 둔다.

실행: python -X utf8 python/test_piper_voices.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import piper_voices as pv


def make_voice(root, rel, lang_family, sample_rate=22050, with_config=True):
    """가짜 목소리 한 벌. onnx 는 **빈 파일**이다 — 여는 것은 이 파일의 일이 아니다."""
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'')
    if with_config:
        cfg = {'language': {'family': lang_family, 'code': lang_family + '_XX'},
               'audio': {'sample_rate': sample_rate}}
        with open(path + '.json', 'w', encoding='utf-8') as f:
            json.dump(cfg, f)
    return path


class Test목소리_찾기(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='af-piper-')

    def test_깊이_들어_있어도_찾는다(self):
        """★내려받으면 ko/ko_KR/kss/medium/... 처럼 깊게 들어온다."""
        make_voice(self.d, 'ko/ko_KR/kss/medium/ko_KR-kss-medium.onnx', 'ko')
        got = pv.scan(self.d)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]['lang'], 'ko')
        self.assertEqual(got[0]['name'], 'ko_KR-kss-medium')

    def test_언어를_이름이_아니라_설정에서_읽는다(self):
        """★이름이 어떻든 설정이 권위다."""
        make_voice(self.d, 'aaa/mystery.onnx', 'ko')
        self.assertEqual(pv.find('ko', self.d)['name'], 'mystery')

    def test_설정이_없으면_세지_않는다(self):
        make_voice(self.d, 'x/lonely.onnx', 'ko', with_config=False)
        self.assertEqual(pv.scan(self.d), [])

    def test_설정이_깨졌으면_조용히_건너뛴다(self):
        p = make_voice(self.d, 'x/broken.onnx', 'ko')
        with open(p + '.json', 'w', encoding='utf-8') as f:
            f.write('{ 망가진')
        self.assertEqual(pv.scan(self.d), [])

    def test_표본율을_읽는다(self):
        make_voice(self.d, 'a/v.onnx', 'ko', sample_rate=16000)
        self.assertEqual(pv.scan(self.d)[0]['sample_rate'], 16000)

    def test_여럿이면_늘_같은_것을_고른다(self):
        """★같은 입력에 다른 결과가 나오면 무엇으로 합성됐는지 알 수 없다."""
        make_voice(self.d, 'b/zeta.onnx', 'ko')
        make_voice(self.d, 'a/alpha.onnx', 'ko')
        self.assertEqual(pv.find('ko', self.d)['name'], 'alpha')
        self.assertEqual(pv.find('ko', self.d)['name'], 'alpha')

    def test_없는_언어는_None(self):
        make_voice(self.d, 'a/v.onnx', 'ko')
        self.assertIsNone(pv.find('ja', self.d))

    def test_폴더가_없어도_터지지_않는다(self):
        self.assertEqual(pv.scan(os.path.join(self.d, '없는곳')), [])

    def test_언어_표기가_길어도_알아본다(self):
        make_voice(self.d, 'a/v.onnx', 'ko')
        self.assertIsNotNone(pv.find('ko_KR', self.d))
        self.assertIsNotNone(pv.find('ko-KR', self.d))


class Test사유를_사람이_읽을_수_있는가(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='af-piper-')

    def test_있으면_빈_문구다(self):
        make_voice(self.d, 'a/v.onnx', 'ko')
        self.assertEqual(pv.check_language('ko', self.d), '')

    def test_없으면_무엇이_있는지_알려_준다(self):
        """★"안 됩니다" 만으로는 다음에 무엇을 할지 알 수 없다."""
        make_voice(self.d, 'a/v.onnx', 'ko')
        why = pv.check_language('ja', self.d)
        self.assertIn('ja', why)
        self.assertIn('ko', why, '지금 있는 것을 말해야 한다')

    def test_하나도_없으면_그렇게_말한다(self):
        why = pv.check_language('ko', self.d)
        self.assertTrue(why)

    def test_폴더_자체가_없으면_자리를_알려_준다(self):
        missing = os.path.join(self.d, '없는곳')
        why = pv.check_language('ko', missing)
        self.assertIn(missing, why)


class Test둘_자리(unittest.TestCase):
    def test_환경변수가_있으면_그곳을_본다(self):
        old = os.environ.get(pv.VOICES_ENV)
        os.environ[pv.VOICES_ENV] = r'X:\어딘가'
        try:
            self.assertEqual(pv.voices_root(), r'X:\어딘가')
        finally:
            if old is None:
                os.environ.pop(pv.VOICES_ENV, None)
            else:
                os.environ[pv.VOICES_ENV] = old

    def test_기본은_externals_아래다(self):
        old = os.environ.pop(pv.VOICES_ENV, None)
        try:
            got = pv.voices_root(repo_root=os.path.join('어떤', '저장소'))
            self.assertTrue(got.endswith(os.path.join('externals', 'piper_voices')))
        finally:
            if old is not None:
                os.environ[pv.VOICES_ENV] = old


if __name__ == '__main__':
    unittest.main()
