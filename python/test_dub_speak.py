# -*- coding: utf-8 -*-
"""dub_speak.py 검사 - 모델도 GPU도 부르지 않는다. 구간 고르기와 상태 되돌리기만 본다.

실행: python -X utf8 python/test_dub_speak.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_speak as ds


class Test참조_구간_고르기(unittest.TestCase):
    def test_가장_긴_대사_구간을_고른다(self):
        start, dur = ds.pick_reference_span([
            {'start': 0.0, 'end': 1.0},
            {'start': 10.0, 'end': 15.0},
            {'start': 20.0, 'end': 22.0},
        ])
        self.assertEqual(start, 10.0)
        self.assertAlmostEqual(dur, 5.0)

    def test_너무_긴_구간은_잘라_쓴다(self):
        """참조가 길면 여러 소리가 섞인다."""
        _, dur = ds.pick_reference_span([{'start': 0.0, 'end': 60.0}])
        self.assertEqual(dur, ds.REF_SEC)

    def test_너무_짧아도_최소_길이는_준다(self):
        _, dur = ds.pick_reference_span([{'start': 5.0, 'end': 5.4}])
        self.assertGreaterEqual(dur, 2.0)

    def test_길이가_0이하인_구간은_쓰지_않는다(self):
        start, _ = ds.pick_reference_span([
            {'start': 3.0, 'end': 3.0},
            {'start': 8.0, 'end': 9.0},
        ])
        self.assertEqual(start, 8.0)

    def test_쓸_구간이_없으면_사유와_함께_멈춘다(self):
        for bad in ([], None, [{'start': 1.0, 'end': 1.0}]):
            with self.assertRaises(ds.DubSpeakError):
                ds.pick_reference_span(bad)


class Test한_프로세스_합성(unittest.TestCase):
    """★핵심: separate.py 의 전역 상태를 **매번 처음으로 되돌린다.**

    되돌리지 않으면 두 번째 줄부터 '이미 끝났다' 로 잠겨 결과가 나오지 않는다.
    되돌릴 값을 여기에 적어 두지 않고 아무것도 돌기 전의 값을 떠서 쓴다 -
    나중에 그쪽에 항목이 늘어도 이 코드가 조용히 어긋나지 않게.
    """

    def test_부를_때마다_처음_상태로_되돌린다(self):
        import shutil
        import tempfile
        sp = ds.InProcessSpeaker()
        run = sp._sep._RUN
        first = dict(run)

        work = tempfile.mkdtemp(prefix='af-speak-')
        try:
            calls = []

            def fake_main():
                # 실제 합성 대신, 돌던 중에 전역이 더럽혀지는 상황만 흉내 낸다.
                calls.append(dict(sp._sep._RUN))
                run['final_emitted'] = True
                run['result'] = 99
                with open(os.path.join(work, 'made-%d.wav' % len(calls)), 'w') as f:
                    f.write('x')

            sp._sep.main = fake_main
            cfg = ds._config_for('v.wav', 'r.wav', '가나다', work)
            log = os.path.join(work, 'log.txt')
            sp.speak(cfg, work, log)
            sp.speak(cfg, work, log)

            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1], first,
                             '두 번째 호출도 처음 상태에서 시작해야 한다')
        finally:
            sp._sep.main = ds.__dict__.get('_unused', sp._sep.main)
            shutil.rmtree(work, ignore_errors=True)

    def test_되돌릴_값은_코드에_적어_두지_않는다(self):
        """항목이 늘어도 따라가도록 **실제 전역을 떠서** 쓴다."""
        sp = ds.InProcessSpeaker()
        self.assertEqual(set(sp._pristine), set(sp._sep._RUN))


class Test설정(unittest.TestCase):
    def test_화면이_보내는_것과_같은_값을_담는다(self):
        cfg = ds._config_for('voice.wav', 'ref.wav', '안녕', 'out')
        self.assertEqual(cfg['mode'], 'tts')
        self.assertEqual(cfg['ttsText'], '안녕')
        self.assertEqual(cfg['ttsReferenceOverride'], 'ref.wav')
        self.assertEqual(cfg['ttsSpeakerMode'], 'single')
        self.assertEqual(cfg['ttsTailMode'], 'auto', '말끝 다듬기는 화면과 같은 기본값')


if __name__ == '__main__':
    unittest.main()
