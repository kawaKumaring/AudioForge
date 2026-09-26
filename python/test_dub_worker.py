# -*- coding: utf-8 -*-
"""dub_worker.py 검사 - 실행기의 입구가 제대로 막히는지 본다.

무거운 일(분리·전사·번역)은 여기서 돌리지 않는다. 그 순서와 이어 하기는
test_dub_pipeline.py 가 이미 못으로 박았다. 여기서 보는 것은 **실행기 자체**다 -
사람이 실제로 부르는 입구에서도 막히는가.

실행: python -X utf8 python/test_dub_worker.py
"""
import io
import contextlib
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_pipeline as dp
import dub_worker as dw


def run_cli(argv):
    """실행기를 부르고 (돌려준 값, 내보낸 알림들) 을 받는다."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = dw.main(argv)
    events = []
    for line in buf.getvalue().splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    return code, events


class Test실행기_입구(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-dubw-')
        self.out = os.path.join(self.dir, 'work')
        self.video = os.path.join(self.dir, 'clip.mp4')
        with open(self.video, 'w', encoding='utf-8') as f:
            f.write('영상인 척하는 파일')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_구글_번역은_실행기에서도_막힌다(self):
        """★라이브러리만 막혀 있으면 부족하다. 사람이 부르는 입구에서도 막혀야 한다."""
        code, events = run_cli(['--video', self.video, '--out', self.out,
                                '--translate', 'google'])
        self.assertEqual(code, 1)
        errors = [e for e in events if e.get('type') == 'error']
        self.assertTrue(errors, '왜 안 되는지 말한다')
        self.assertIn('인터넷', errors[0].get('message', ''))
        self.assertFalse(os.path.isdir(self.out), '아무것도 만들지 않는다')

    def test_없는_영상은_사유를_내고_1을_돌려준다(self):
        code, events = run_cli(['--video', os.path.join(self.dir, '없다.mp4'),
                                '--out', self.out])
        self.assertEqual(code, 1)
        self.assertTrue([e for e in events if e.get('type') == 'error'])


class Test배선(unittest.TestCase):
    def test_네_단계가_모두_배선돼_있다(self):
        """하나라도 빠지면 run_front 가 시작도 못 한다 - 빠진 것을 여기서 먼저 잡는다."""
        steps = dw.real_steps()
        self.assertEqual(sorted(steps), sorted(dp.STAGE_NAMES))
        for name, fn in steps.items():
            self.assertTrue(callable(fn), name)

    def test_기본_번역은_로컬이다(self):
        self.assertEqual(dp.DEFAULT_TRANSLATE_BACKEND, 'llm')
        self.assertNotIn(dp.DEFAULT_TRANSLATE_BACKEND, dp.BLOCKED_TRANSLATE_BACKENDS)

    def test_배경음은_보컬을_뺀_나머지다(self):
        self.assertNotIn('vocals', dw.BACKGROUND_STEMS)
        self.assertIn('drums', dw.BACKGROUND_STEMS)


class Test분리기_고르기(unittest.TestCase):
    """★좋은 분리기를 먼저 쓴다.

    2026-09-20 사용자 청취에서 확정: 갈라낸 보컬이 지저분하면 그 지저분함이
    뒤의 모든 단계로 간다(합성에 기계음이 섞인다). 처음에 약한 분리기를 고른 것을 되돌린 자리다.
    """

    def setUp(self):
        import music_worker
        self.mw = music_worker
        self.roformer = music_worker.run_roformer_separation
        self.demucs = music_worker.run_music_separation

    def tearDown(self):
        self.mw.run_roformer_separation = self.roformer
        self.mw.run_music_separation = self.demucs

    def test_좋은_분리기를_먼저_쓴다(self):
        called = []
        self.mw.run_roformer_separation = lambda s, d: (
            called.append('roformer') or [{'name': 'vocals', 'path': 'v'}])
        self.mw.run_music_separation = lambda s, d: called.append('demucs') or []
        tracks, engine = dw._separate_tracks('src.wav', 'out')
        self.assertEqual(called, ['roformer'], '기본 분리기까지 가지 않는다')
        self.assertEqual(engine, 'roformer')

    def test_좋은_분리기가_막히면_물러선다(self):
        """막혔다고 아무것도 못 하게 두지 않는다 - 대신 무엇을 썼는지 돌려준다."""
        called = []

        def boom(s, d):
            called.append('roformer')
            raise RuntimeError('분리기 없음')

        self.mw.run_roformer_separation = boom
        self.mw.run_music_separation = lambda s, d: (
            called.append('demucs') or [{'name': 'vocals', 'path': 'v'}])
        tracks, engine = dw._separate_tracks('src.wav', 'out')
        self.assertEqual(called, ['roformer', 'demucs'])
        self.assertEqual(engine, 'demucs')

    def test_빈_결과여도_물러선다(self):
        self.mw.run_roformer_separation = lambda s, d: []
        self.mw.run_music_separation = lambda s, d: [{'name': 'vocals', 'path': 'v'}]
        _, engine = dw._separate_tracks('src.wav', 'out')
        self.assertEqual(engine, 'demucs')


if __name__ == '__main__':
    unittest.main()
