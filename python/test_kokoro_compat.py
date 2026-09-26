# -*- coding: utf-8 -*-
"""kokoro_compat.py 단위 검사 — Kokoro 를 부르지 않는다. 조사하는 두 가지를 넣어 준다.

★왜 이 검사가 있는가(2026-09-24)
  우리 엔진이 "ko·ja·zh·en 을 지원한다" 고 적어 두었는데 **넷 중 셋이 사실이 아니었다.**
  한국어·일본어는 GPT-SoVITS 실패 시 **떨어질 자리**였고 중국어는 **유일한 길**이었다.
  구하러 온 사다리가 썩어 있었고, 터지는 모양도 AssertionError 라 읽을 수 없었다.
  같은 일이 조용히 되풀이되지 않게 붙잡아 둔다.

실행: python -X utf8 python/test_kokoro_compat.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kokoro_compat as kc


ALL = set('abefhijpz')          # 2026-09-24 실측으로 설치돼 있던 언어표
NONE_MISSING = lambda name: True
ALL_MISSING = lambda name: False


class Test언어가_정말_되는가(unittest.TestCase):
    def test_언어표에_없으면_안_된다고_말한다(self):
        got = kc.available_languages(codes=ALL, has_module=NONE_MISSING)
        ok, why = got['ko']
        self.assertFalse(ok)
        self.assertIn('담고 있지', why)

    def test_딸린_부품이_없으면_안_된다고_말한다(self):
        got = kc.available_languages(codes=ALL, has_module=ALL_MISSING)
        for lang, need in (('ja', 'pyopenjtalk'), ('zh', 'ordered_set')):
            ok, why = got[lang]
            self.assertFalse(ok, lang)
            self.assertIn(need, why, '무엇이 없는지 말해야 한다')

    def test_부품이_다_있으면_된다고_말한다(self):
        got = kc.available_languages(codes=ALL, has_module=NONE_MISSING)
        self.assertEqual(got['ja'][0], True)
        self.assertEqual(got['zh'][0], True)

    def test_영어는_딸린_부품이_없다(self):
        got = kc.available_languages(codes=ALL, has_module=ALL_MISSING)
        self.assertEqual(got['en'], (True, ''))

    def test_실측_그대로의_환경을_재현한다(self):
        """★2026-09-24 이 컴퓨터의 실제 상태 — en 만 된다."""
        missing = {'pyopenjtalk', 'ordered_set'}
        got = kc.available_languages(codes=ALL,
                                     has_module=lambda m: m not in missing)
        self.assertEqual([k for k, (ok, _) in got.items() if ok], ['en'])

    def test_네_언어를_빠짐없이_본다(self):
        got = kc.available_languages(codes=ALL, has_module=NONE_MISSING)
        self.assertEqual(set(got), {'ko', 'ja', 'zh', 'en'})


class Test사유를_사람이_읽을_수_있는가(unittest.TestCase):
    def test_되면_빈_문구다(self):
        self.assertEqual(kc.check_language('en', codes=ALL,
                                           has_module=NONE_MISSING), '')

    def test_안_되면_사유가_나온다(self):
        why = kc.check_language('ko', codes=ALL, has_module=NONE_MISSING)
        self.assertTrue(why)
        self.assertNotIn('AssertionError', why, '속사정이 아니라 사람 말이어야 한다')

    def test_모르는_언어도_조용히_넘기지_않는다(self):
        why = kc.check_language('de', codes=ALL, has_module=NONE_MISSING)
        self.assertIn('de', why)

    def test_Kokoro_를_못_불러도_사유를_돌려준다(self):
        """★없는 것을 '된다' 고 말하지 않는다."""
        # 언어표가 비었다 = Kokoro 를 제대로 보지 못한 것과 같은 뜻이다.
        got = kc.available_languages(codes=set(), has_module=NONE_MISSING)
        self.assertTrue(all(not ok for ok, _ in got.values()))


class Test기본_목소리(unittest.TestCase):
    """★목소리를 안 넘기면 **언어와 무관하게 전부 터진다**(2026-09-24 실측).

    엔진이 voice 를 넘기지 않아 en·zh 양쪽에서 "Specify a voice" 가 났다 —
    즉 Kokoro 합성은 **어느 언어로도 되지 않는 상태**였다. 언어 문제가 아니었다.
    """

    def test_우리_언어_이름으로_고를_수_있다(self):
        self.assertTrue(kc.default_voice('en'))
        self.assertTrue(kc.default_voice('zh'))
        self.assertTrue(kc.default_voice('ja'))

    def test_Kokoro_글자로도_고를_수_있다(self):
        self.assertEqual(kc.default_voice('a'), kc.default_voice('en'))
        self.assertEqual(kc.default_voice('z'), kc.default_voice('zh'))

    def test_언어마다_다른_목소리다(self):
        got = [kc.default_voice(x) for x in ('en', 'zh', 'ja')]
        self.assertEqual(len(set(got)), 3)

    def test_모르면_아무거나_고르지_않는다(self):
        """★엉뚱한 목소리로 합성되면 결과만 보고는 알 수 없다."""
        self.assertIsNone(kc.default_voice('de'))
        self.assertIsNone(kc.default_voice('ko'))


class Test덧대기(unittest.TestCase):
    def test_두_번_불러도_한_번만_한다(self):
        kc._done = False
        try:
            first = kc.ensure()
            second = kc.ensure()
            self.assertEqual(second, '', '두 번째는 아무것도 하지 않는다')
            self.assertIsInstance(first, str)
        finally:
            kc._done = False

    def test_없는_환경에서도_터지지_않는다(self):
        """덧댈 수 없어도 막지 않는다 — 정상 설치를 방해하지 않기 위해서다."""
        kc._done = False
        try:
            self.assertIsInstance(kc.ensure(), str)
        finally:
            kc._done = False


class Test옮긴_자리_찾기(unittest.TestCase):
    """★적어 둔 절대경로가 죽었을 때 지금 저장소 아래에서 찾아 주는가.

    2026-09-24: 저장소를 옮기자 runtime.json 의 절대경로가 죽어
    **주력 합성 엔진이 통째로 닿지 않게 됐다.** 게다가 조용히 —
    엔진 고르기가 예외를 잡아 다른 엔진으로 내려보내므로 사용자는 모른다.
    같은 일이 이번 이동에서 네 번 났다(git 링크·externals 링크·이 기록·venv 설정).
    """

    def setUp(self):
        import app_runtime
        self.ar = app_runtime

    def test_적어_둔_자리가_살아_있으면_그대로_쓴다(self):
        got = self.ar.relocate_recorded(r'X:\a\externals\runtime\p.exe', r'Y:\new\externals',
                                        exists=lambda p: True)
        self.assertEqual(got, r'X:\a\externals\runtime\p.exe')

    def test_죽었으면_지금_저장소_아래에서_찾는다(self):
        old = r'X:\old\externals\runtime\venv\Scripts\python.exe'
        new_root = r'Y:\new\externals'
        want = os.path.join(new_root, 'runtime', 'venv', 'Scripts', 'python.exe')
        got = self.ar.relocate_recorded(old, new_root, exists=lambda p: p == want)
        self.assertEqual(got, want)

    def test_새_자리에도_없으면_적어_둔_것을_그대로_돌려준다(self):
        """★없는 것을 지어내지 않는다 — 판정은 부르는 쪽이 한다."""
        old = r'X:\old\externals\runtime\p.exe'
        got = self.ar.relocate_recorded(old, r'Y:\new\externals', exists=lambda p: False)
        self.assertEqual(got, old)

    def test_externals_가_없는_경로는_건드리지_않는다(self):
        old = r'X:\어딘가\p.exe'
        got = self.ar.relocate_recorded(old, r'Y:\new\externals', exists=lambda p: False)
        self.assertEqual(got, old)

    def test_빈_값도_터지지_않는다(self):
        self.assertEqual(self.ar.relocate_recorded('', r'Y:\e', exists=lambda p: False), '')
        self.assertIsNone(self.ar.relocate_recorded(None, r'Y:\e', exists=lambda p: False))


if __name__ == '__main__':
    unittest.main()
