# -*- coding: utf-8 -*-
"""dub_pipeline.py 단위 검사 - 가짜 단계 함수로 돌린다. GPU도 모델도 영상도 쓰지 않는다.

실행: python -X utf8 python/test_dub_pipeline.py
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dub_pipeline as dp


def fake_steps(log, *, fail_at=None, produce=True):
    """단계마다 파일을 만들어 두는 가짜 함수들. 무엇이 어떤 순서로 불렸는지 log 에 남긴다."""
    def make(name):
        def step(ctx):
            log.append(name)
            if fail_at == name:
                raise RuntimeError('일부러 낸 오류')
            if produce:
                for p in dp.stage_paths(ctx['out_dir'], name):
                    with open(p, 'w', encoding='utf-8') as f:
                        # ★줄 목록은 **읽히는 JSON** 이어야 한다(2026-09-24 2차 감사).
                        #   예전 재료는 단계 이름만 적어 뒀는데, 판정이 존재만 봤기에
                        #   그래도 통과했다. 이제 내용을 보므로 재료도 실물에 맞춘다.
                        if os.path.basename(p) == 'lines.json':
                            json.dump({'language': 'ja', 'lines': [
                                {'index': 0, 'start': 0.0, 'end': 1.0,
                                 'source': 'こんにちは', 'korean': '안녕하세요'}]},
                                f, ensure_ascii=False)
                        else:
                            f.write(name)
        return step
    return dict((n, make(n)) for n in dp.STAGE_NAMES)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-dub-')
        self.out = os.path.join(self.dir, 'work')
        self.video = os.path.join(self.dir, 'clip.mp4')
        with open(self.video, 'w', encoding='utf-8') as f:
            f.write('영상인 척하는 파일 - 열지 않는다')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class Test구글_차단(Base):
    """★가장 중요한 검사. 대사 전체가 밖으로 나가는 길을 막는다."""

    def test_구글을_고르면_사유와_함께_막는다(self):
        with self.assertRaises(dp.DubPipelineError) as cm:
            dp.check_translate_backend('google')
        self.assertIn('인터넷', str(cm.exception))

    def test_대소문자나_공백으로_피해_갈_수_없다(self):
        for v in ('Google', '  GOOGLE  ', 'google'):
            with self.assertRaises(dp.DubPipelineError):
                dp.check_translate_backend(v)

    def test_막힌_경우_단계가_하나도_돌지_않는다(self):
        """막기 전에 무언가 돌면 이미 늦다 - 가장 먼저 막혀야 한다."""
        log = []
        with self.assertRaises(dp.DubPipelineError):
            dp.run_front(self.video, self.out,
                         steps=fake_steps(log), translate_backend='google')
        self.assertEqual(log, [])
        self.assertFalse(os.path.isdir(self.out), '폴더조차 만들지 않는다')

    def test_로컬_번역은_통과한다(self):
        self.assertEqual(dp.check_translate_backend('llm'), 'llm')
        self.assertEqual(dp.check_translate_backend(None), dp.DEFAULT_TRANSLATE_BACKEND)


class Test순서와_완주(Base):
    def test_네_단계가_기획서_순서대로_돈다(self):
        log = []
        r = dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertEqual(log, ['audio', 'separate', 'transcribe', 'translate'])
        self.assertEqual(r['ran'], list(dp.STAGE_NAMES))
        self.assertEqual(r['skipped'], [])

    def test_끝나면_산출물_경로를_돌려준다(self):
        r = dp.run_front(self.video, self.out, steps=fake_steps([]))
        self.assertIn('background.wav', ' '.join(r['paths']['separate']))
        for paths in r['paths'].values():
            for p in paths:
                self.assertTrue(os.path.isfile(p))


class Test이어_하기(Base):
    def test_끝난_단계는_다시_하지_않는다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        log = []
        r = dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertEqual(log, [], '전부 끝났으면 아무것도 다시 하지 않는다')
        self.assertEqual(r['skipped'], list(dp.STAGE_NAMES))

    def test_전사까지_됐으면_번역부터_이어서_한다(self):
        log = []
        with self.assertRaises(dp.DubPipelineError):
            dp.run_front(self.video, self.out, steps=fake_steps(log, fail_at='translate'))
        log2 = []
        dp.run_front(self.video, self.out, steps=fake_steps(log2))
        self.assertEqual(log2, ['translate'], '앞의 셋은 건너뛴다')

    def test_기록만_믿지_않고_파일이_있는지_본다(self):
        """사용자가 폴더를 치웠을 수 있다. 기록이 '끝남' 이어도 파일이 없으면 다시 한다."""
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        os.remove(os.path.join(self.out, 'vocals.wav'))
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertEqual(log, ['separate', 'transcribe', 'translate'],
                         '갈라내기를 다시 하면 그 뒤도 전부 다시 한다')

    def test_앞_단계를_다시_하면_뒤도_전부_다시_한다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        os.remove(os.path.join(self.out, 'source.wav'))
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertEqual(log, list(dp.STAGE_NAMES))

    def test_영상이_바뀌면_처음부터_한다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        with open(self.video, 'w', encoding='utf-8') as f:
            f.write('아주 다른 내용이라 크기가 달라진다 ' * 10)
        log, events = [], []
        dp.run_front(self.video, self.out, steps=fake_steps(log),
                     on_event=lambda kind, **kw: events.append((kind, kw)))
        self.assertEqual(log, list(dp.STAGE_NAMES))
        self.assertTrue(any(k == 'reset' for k, _ in events), '왜 다시 하는지 말한다')

    def test_처음부터_다시_하기를_고르면_전부_다시_한다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log), force=True)
        self.assertEqual(log, list(dp.STAGE_NAMES))

    def test_상태_파일이_깨져도_멈추지_않는다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        with open(os.path.join(self.out, dp.STATE_FILE), 'w', encoding='utf-8') as f:
            f.write('{ 이건 json 이 아니다')
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertEqual(log, list(dp.STAGE_NAMES), '읽을 수 없으면 처음부터 한다')


class Test어긋났을_때(Base):
    def test_멈춘_단계의_이름을_말한다(self):
        with self.assertRaises(dp.DubPipelineError) as cm:
            dp.run_front(self.video, self.out, steps=fake_steps([], fail_at='transcribe'))
        self.assertIn(dp.STAGE_LABELS['transcribe'], str(cm.exception))
        self.assertIn('일부러 낸 오류', str(cm.exception), '사유를 삼키지 않는다')

    def test_실패해도_그때까지의_산출물은_남는다(self):
        with self.assertRaises(dp.DubPipelineError):
            dp.run_front(self.video, self.out, steps=fake_steps([], fail_at='transcribe'))
        self.assertTrue(os.path.isfile(os.path.join(self.out, 'source.wav')))
        self.assertTrue(os.path.isfile(os.path.join(self.out, 'vocals.wav')))
        self.assertEqual(dp.read_state(self.out)['done'], ['audio', 'separate'])

    def test_조용히_끝난_단계를_통과시키지_않는다(self):
        """오류 없이 끝났는데 결과 파일이 없는 경우. 여기서 잡지 않으면 뒤에서 엉뚱하게 터진다."""
        log = []
        with self.assertRaises(dp.DubPipelineError) as cm:
            dp.run_front(self.video, self.out, steps=fake_steps(log, produce=False))
        self.assertIn('결과가 없습니다', str(cm.exception))
        self.assertEqual(log, ['audio'], '첫 단계에서 바로 멈춘다')

    def test_없는_영상은_사유와_함께_실패한다(self):
        with self.assertRaises(dp.DubPipelineError):
            dp.run_front(os.path.join(self.dir, '없는파일.mp4'), self.out,
                         steps=fake_steps([]))

    def test_실행_함수가_빠지면_시작_전에_말한다(self):
        steps = fake_steps([])
        del steps['translate']
        with self.assertRaises(dp.DubPipelineError) as cm:
            dp.run_front(self.video, self.out, steps=steps)
        self.assertIn('translate', str(cm.exception))


class Test알림(Base):
    def test_단계마다_시작과_끝을_알린다(self):
        events = []
        dp.run_front(self.video, self.out, steps=fake_steps([]),
                     on_event=lambda kind, **kw: events.append((kind, kw.get('stage'))))
        self.assertEqual([e for e in events if e[0] == 'start'],
                         [('start', n) for n in dp.STAGE_NAMES])
        self.assertEqual([e for e in events if e[0] == 'done'],
                         [('done', n) for n in dp.STAGE_NAMES])

    def test_건너뛴_단계도_알린다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        events = []
        dp.run_front(self.video, self.out, steps=fake_steps([]),
                     on_event=lambda kind, **kw: events.append(kind))
        self.assertEqual(events.count('skip'), len(dp.STAGE_NAMES))

    def test_알림을_주지_않아도_돈다(self):
        r = dp.run_front(self.video, self.out, steps=fake_steps([]))
        self.assertEqual(r['ran'], list(dp.STAGE_NAMES))


class Test단계에_설정_넘기기(Base):
    def test_설정이_단계_함수에_닿는다(self):
        seen = {}

        def step(ctx):
            seen.update(ctx)
            for q in dp.stage_paths(ctx['out_dir'], 'audio'):
                with open(q, 'w', encoding='utf-8') as f:
                    f.write('x')

        steps = fake_steps([])
        steps['audio'] = step
        dp.run_front(self.video, self.out, steps=steps,
                     extra={'whisper_model': 'small', 'language': 'ja'})
        self.assertEqual(seen.get('whisper_model'), 'small')
        self.assertEqual(seen.get('language'), 'ja')

    def test_설정으로_실행_경로를_덮어쓸_수_없다(self):
        """설정 하나가 조용히 다른 폴더를 쓰거나 막힌 번역을 되살리면 안 된다."""
        seen = {}

        def step(ctx):
            seen.update(ctx)
            for q in dp.stage_paths(ctx['out_dir'], 'audio'):
                with open(q, 'w', encoding='utf-8') as f:
                    f.write('x')

        steps = fake_steps([])
        steps['audio'] = step
        dp.run_front(self.video, self.out, steps=steps,
                     extra={'backend': 'google', 'out_dir': '다른폴더'})
        self.assertEqual(seen['backend'], dp.DEFAULT_TRANSLATE_BACKEND)
        self.assertEqual(seen['out_dir'], self.out)


class Test표(Base):
    def test_영상_내용을_읽지_않고_크기와_시각만_본다(self):
        sig = dp.source_signature(self.video)
        self.assertEqual(set(sig), {'name', 'size', 'mtime'})
        self.assertEqual(sig['name'], 'clip.mp4')


class Test잘린_산출물(Base):
    """★잘린 파일이 '끝남' 으로 세면 되돌릴 길이 막힌다(2026-09-24 2차 감사).

    예전 판정은 존재만 봤다. 쓰다 끊겨 잘린 lines.json 도 번역 끝남으로 세어
    그 단계를 건너뛰었고, 사용자는 앱을 다시 켜도 같은 자리에 갇혔다.
    빠져나올 길은 --force 뿐이었는데 그것은 손본 번역문을 통째로 버리는 길이다.
    """

    def test_잘린_줄목록은_끝난_것으로_세지_않는다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        lines = os.path.join(self.out, 'lines.json')
        with open(lines, 'w', encoding='utf-8') as f:
            f.write('{"language": "ja", "lin')      # 쓰다 끊긴 모양
        log = []
        r = dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertIn('translate', log, '잘린 파일을 끝난 것으로 세어 건너뛰었다')
        self.assertNotIn('translate', r['skipped'])
        self.assertIn('transcribe', r['skipped'], '앞 단계까지 다시 하지는 않는다')

    def test_빈_줄목록도_끝난_것으로_세지_않는다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        with open(os.path.join(self.out, 'lines.json'), 'w', encoding='utf-8') as f:
            f.write('')
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertIn('translate', log)

    def test_모양이_다른_JSON도_끝난_것으로_세지_않는다(self):
        dp.run_front(self.video, self.out, steps=fake_steps([]))
        with open(os.path.join(self.out, 'lines.json'), 'w', encoding='utf-8') as f:
            f.write('{"language": "ja"}')            # lines 가 없다
        log = []
        dp.run_front(self.video, self.out, steps=fake_steps(log))
        self.assertIn('translate', log)

    def test_판정은_아무것도_실행하지_않는다(self):
        """확인 방법까지 주입된다 — 이 함수가 디스크를 직접 읽지 않아도 된다."""
        seen = []

        def fake_readable(path):
            seen.append(path)
            return False

        plan = dp.plan_stages(self.out, 'sig', state={'done': list(dp.STAGE_NAMES), 'source': 'sig'},
                              exists=lambda p: True, readable=fake_readable)
        self.assertIn('translate', plan['run'])
        self.assertTrue(seen, '주입한 확인 방법을 쓰지 않았다')


class Test상태_저장(Base):
    """상태 파일도 임시본을 거쳐 바뀐다 — 쓰다 끊겨도 기존 것이 잘리지 않는다."""

    def test_임시본을_남기지_않는다(self):
        os.makedirs(self.out, exist_ok=True)
        dp.write_state(self.out, {"version": dp.STATE_VERSION, "done": ["audio"], "source": "sig"})
        self.assertEqual(dp.read_state(self.out)["done"], ["audio"])
        leftovers = [n for n in os.listdir(self.out) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [], "임시본이 남았다")

    def test_쓰다_끊겨도_기존_상태가_남는다(self):
        os.makedirs(self.out, exist_ok=True)
        dp.write_state(self.out, {"version": dp.STATE_VERSION, "done": ["audio", "separate"], "source": "sig"})
        before = io.open(os.path.join(self.out, dp.STATE_FILE), encoding="utf-8").read()
        real = json.dump

        def boom(*a, **k):
            raise RuntimeError("쓰다 끊김")

        json.dump = boom
        try:
            with self.assertRaises(RuntimeError):
                dp.write_state(self.out, {"done": [], "source": "x"})
        finally:
            json.dump = real
        after = io.open(os.path.join(self.out, dp.STATE_FILE), encoding="utf-8").read()
        self.assertEqual(after, before, "실패했는데 기존 상태가 바뀌었다")

if __name__ == '__main__':
    unittest.main()
