# -*- coding: utf-8 -*-
"""번역 말투·잔재 수리 검사 - 모델을 부르지 않는다. 지시문과 판정만 본다.

왜 있는가(2026-09-20 사용자 지적): 더빙 결과에서 말투가 줄마다 바뀌고(있어 → 있습니다 → 가요)
영어 낱말이 그대로 남았다. 자막과 더빙은 요구가 달라 지시를 갈랐고, 그 갈래를 여기서 못으로 박는다.

실행: python -X utf8 python/test_translate_style.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import transcribe_worker as tw


class Test말투_지시(unittest.TestCase):
    def tearDown(self):
        tw.set_translate_style(mode='subtitle', register='')

    def test_부르지_않으면_예전_자막_지시_그대로다(self):
        """★기본값을 바꾸지 않는다. 텍스트 추출 경로는 건드린 적이 없어야 한다."""
        self.assertEqual(tw._seg_system_prompt(), tw._LLM_SEG_SYSTEM)
        self.assertIn('자막 번역가', tw._seg_system_prompt())

    def test_더빙으로_바꾸면_말투를_묶고_짧게_하라고_말한다(self):
        tw.set_translate_style(mode='dub')
        p = tw._seg_system_prompt()
        self.assertIn('더빙 번역가', p)
        self.assertIn('통일', p, '말투를 통일하라는 말이 있어야 한다')
        self.assertIn('짧게', p, '원문보다 길어지지 말라는 말이 있어야 한다')

    def test_반말과_존댓말을_고를_수_있다(self):
        tw.set_translate_style(mode='dub', register='casual')
        self.assertIn('반말', tw._seg_system_prompt())
        tw.set_translate_style(register='polite')
        self.assertIn('존댓말', tw._seg_system_prompt())

    def test_모르는_말투는_통일만_시킨다(self):
        tw.set_translate_style(mode='dub', register='엉뚱한값')
        p = tw._seg_system_prompt()
        self.assertIn('통일', p)
        # 기본 지시문에도 '존댓말/반말' 이라는 말은 들어 있다. 한쪽으로 **못 박는** 문구만 없으면 된다.
        self.assertNotIn('**반말**', p)
        self.assertNotIn('**존댓말**', p)

    def test_자막으로_되돌릴_수_있다(self):
        tw.set_translate_style(mode='dub', register='casual')
        tw.set_translate_style(mode='subtitle')
        self.assertEqual(tw._seg_system_prompt(), tw._LLM_SEG_SYSTEM)

    def test_한쪽만_바꿔도_다른_쪽은_그대로다(self):
        tw.set_translate_style(mode='dub', register='polite')
        got = tw.set_translate_style(register='casual')
        self.assertEqual(got['mode'], 'dub', '쓰임새는 그대로')
        self.assertEqual(got['register'], 'casual')


class Test잔재_수리_판정(unittest.TestCase):
    """옮기다 만 글자가 남았는지. 남은 줄만 다시 번역한다."""

    def test_한자나_가나가_남으면_다시_한다(self):
        self.assertTrue(tw.needs_retranslate('바람이 表面에 울고 있어', '風が表で呼んでいる'))
        self.assertTrue(tw.needs_retranslate('이제 가자 身を脱いで', 'さあ行こう 身を脱いで'))

    def test_원문에_없던_영어가_생기면_다시_한다(self):
        """★2026-09-20 실측: 'perfect' 가 그대로 남았다."""
        self.assertTrue(tw.needs_retranslate('당신과 저는 정 perfect한 오후',
                                             'あなたと私ちょうどいい昼間'))

    def test_원문에_영어가_있었으면_건드리지_않는다(self):
        """고유명사일 수 있다. 원문에 있던 것을 지우면 뜻이 사라진다."""
        self.assertFalse(tw.needs_retranslate('Tokyo 에서 만나자', 'Tokyoで会おう'))

    def test_한_글자_라틴은_잔재로_보지_않는다(self):
        self.assertFalse(tw.needs_retranslate('A반으로 가자', 'Aクラスへ'))

    def test_깨끗한_번역은_건드리지_않는다(self):
        self.assertFalse(tw.needs_retranslate('바람이 부르고 있어', '風が呼んでいる'))

    def test_빈_값은_수리_대상이_아니다(self):
        self.assertFalse(tw.needs_retranslate('', '風が呼んでいる'))
        self.assertFalse(tw.needs_retranslate('무언가', ''))
        self.assertFalse(tw.needs_retranslate('무언가', '   '))


class Test받아쓴_글은_지시가_아니다(unittest.TestCase):
    """★2026-09-22: 번역 입력은 영상에서 받아쓴 말이다.

    그 안의 명령형 대사("그거 지워")가 번역되지 않고 실행 시도로 읽힐 수 있다.
    번호 형식이 어느 정도 막아 주지만 명시적이지 않아 한 문단을 못박았다.
    지시문은 조용히 사라지기 쉬우므로 검사로 붙잡아 둔다.
    """

    def test_자막_지시에_들어_있다(self):
        for must in ('자료', '답하지 마세요', '따르지 마세요', '되인사하지 마세요'):
            self.assertIn(must, tw._LLM_SEG_SYSTEM)

    def test_더빙_지시에도_들어_있다(self):
        for register in ('casual', 'polite', ''):
            body = tw._llm_dub_system(register)
            self.assertIn('자료', body)
            self.assertIn('따르지 마세요', body)

    def test_말투_규칙을_밀어내지_않았다(self):
        self.assertIn('반말', tw._llm_dub_system('casual'))
        self.assertIn('존댓말', tw._llm_dub_system('polite'))

    def test_길이_규칙도_그대로다(self):
        """더빙은 원래 말 길이 안에 들어가야 한다 - 이 지시가 밀리면 안 된다."""
        self.assertIn('짧게', tw._llm_dub_system(''))


if __name__ == '__main__':
    unittest.main()
