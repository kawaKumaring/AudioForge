# -*- coding: utf-8 -*-
"""노래 목소리 변환 부품 — **경계가 얇은가, 실패를 삼키지 않는가.**

★이 부품은 갈아 끼울 것을 알고 만들었다(2026-09-26 사용자 결정:
  "나중에 더 좋은 모델이 생기면 제거하면 된다"). 그래서 검사도
  "잘 도는가" 보다 **"떼어내기 쉬운 상태로 남아 있는가"** 를 본다.

  경계가 새면 나중에 떼어낼 때 사슬 전체를 뜯게 된다.
  이 저장소가 반복해서 적어 온 말이기도 하다 — **경계를 새로 만들면서 그 경계를 안 봤다.**
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import song_voice as sv  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = io.open(os.path.join(HERE, 'song_voice.py'), encoding='utf-8').read()


class Ran(object):
    """가짜 실행기. 진짜 변환기 없이 명령줄만 본다."""

    def __init__(self, code=0, err=b'', makes=None):
        self.code, self.err, self.makes = code, err, makes or []
        self.args = None

    def __call__(self, args, **kw):
        self.args = args
        out = args[args.index('--output') + 1]
        for n in self.makes:
            _tmp(out, n)
        return type('R', (), {'returncode': self.code, 'stderr': self.err})()


def _tmp(tmpdir, name, body='x'):
    p = os.path.join(tmpdir, name)
    with io.open(p, 'w', encoding='utf-8') as f:
        f.write(body)
    return p


class TestSettingsAreTheMeasuredOnes(unittest.TestCase):
    """★청취로 정해진 값이다. 누가 무심코 바꾸면 소리가 달라진다."""

    def test_정해진_값을_그대로_쓴다(self):
        self.assertEqual(sv.DIFFUSION_STEPS, 40, '100보다 40이 자연스러웠다(청취)')
        self.assertIs(sv.F0_CONDITION, True, '가락이 남는 이유가 이것이다')
        self.assertIs(sv.AUTO_F0_ADJUST, False, '곡의 조를 임의로 옮기면 안 된다')

    def test_명령줄에_그_값들이_실제로_실린다(self):
        a = sv.convert_args('a.wav', 'b.wav', 'out',
                            conv={'python': 'py', 'script': 's.py'})
        self.assertIn('--diffusion-steps', a)
        self.assertEqual(a[a.index('--diffusion-steps') + 1], '40')
        self.assertEqual(a[a.index('--f0-condition') + 1], 'True')
        self.assertEqual(a[a.index('--auto-f0-adjust') + 1], 'False')


class TestNoHardcodedPath(unittest.TestCase):
    """★'연결은 추측이 아니라 기록이어야 한다' — 본체가 이미 적어 둔 원칙."""

    def test_특정_PC_경로가_코드에_없다(self):
        body = SRC.split('"""', 2)[2]          # 사연을 적은 머리말은 뺀다
        for bad in [':\\\\', ':/', 'seed', '.venv']:
            self.assertNotIn(bad, body,
                             '코드에 특정 PC 나 특정 변환기 흔적이 박혀 있다: %s' % bad)

    def test_기록이_없으면_고치는_방법까지_말한다(self):
        keep = dict(os.environ)
        try:
            os.environ.pop(sv.PYTHON_ENV, None)
            os.environ.pop(sv.SCRIPT_ENV, None)
            sv.ENV_FILE = os.path.join(HERE, '없는파일.json')
            with self.assertRaises(sv.SongVoiceError) as e:
                sv.converter()
            msg = str(e.exception)
            self.assertIn('기록', msg, '무엇을 하라는지 말하지 않는다')
            self.assertIn(sv.PYTHON_KEY, msg, '어디에 적어야 하는지 말하지 않는다')
        finally:
            os.environ.clear()
            os.environ.update(keep)
            sv.ENV_FILE = os.path.join(sv.ROOT, 'externals', 'env.json')


class TestFailureIsNotSwallowed(unittest.TestCase):
    """★이 저장소가 반복해서 데인 자리 — 실패를 버리는 것."""

    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afsv-')
        self.src = _tmp(self.d, 'vocal.wav')
        self.ref = _tmp(self.d, 'ref.wav')
        self.out = os.path.join(self.d, 'out')

    def test_변환기가_멈추면_사유를_들고_올라간다(self):
        run = Ran(code=1, err='CUDA out of memory'.encode('utf-8'))
        with self.assertRaises(sv.SongVoiceError) as e:
            sv.convert_vocal(self.src, self.ref, self.out, run=run,
                             conv={'python': 'py', 'script': 's.py'})
        self.assertIn('memory', str(e.exception), '왜 실패했는지 버렸다')

    def test_끝났다는데_결과가_없으면_성공이라_하지_않는다(self):
        run = Ran(code=0, makes=[])
        with self.assertRaises(sv.SongVoiceError):
            sv.convert_vocal(self.src, self.ref, self.out, run=run,
                             conv={'python': 'py', 'script': 's.py'})

    def test_없는_파일을_넘기면_부르기_전에_막는다(self):
        run = Ran(code=0, makes=['made.wav'])
        with self.assertRaises(sv.SongVoiceError):
            sv.convert_vocal(os.path.join(self.d, '없음.wav'), self.ref, self.out,
                             run=run, conv={'python': 'py', 'script': 's.py'})
        self.assertIsNone(run.args, '없는 파일로 변환기를 불렀다')

    def test_잘_되면_만든_파일을_돌려준다(self):
        run = Ran(code=0, makes=['made.wav'])
        got = sv.convert_vocal(self.src, self.ref, self.out, run=run,
                               conv={'python': 'py', 'script': 's.py'})
        self.assertTrue(got.endswith('made.wav'))

    def test_원래_있던_파일을_결과로_착각하지_않는다(self):
        """★전에 돌린 결과가 남아 있어도 **이번에 만든 것**을 돌려줘야 한다."""
        os.makedirs(self.out)
        _tmp(self.out, 'zzz-옛날.wav')
        run = Ran(code=0, makes=['aaa-이번.wav'])
        got = sv.convert_vocal(self.src, self.ref, self.out, run=run,
                               conv={'python': 'py', 'script': 's.py'})
        self.assertTrue(got.endswith('aaa-이번.wav'),
                        '옛 결과를 이번 것으로 착각한다: %s' % os.path.basename(got))


class TestRunsInItsOwnHome(unittest.TestCase):
    """★변환기를 우리 폴더에서 돌리면 저장소에 수 GB 가 쏟아진다(2026-09-26 사고).

      변환기는 모델 캐시를 `./checkpoints` 같은 **상대 경로**에 만든다.
      우리 작업 폴더에서 불렀더니 **앱 저장소 안에 2.4GB** 가 내려왔고,
      `git add -A` 가 그것을 통째로 담아 하마터면 커밋될 뻔했다.
      (푸시 전에 잡아 되돌렸다.)

      집을 정해 주면 제 옆에 받고, 이미 받아 둔 것도 그대로 쓴다.
    """

    def test_변환기의_집에서_돌린다(self):
        import tempfile
        d = tempfile.mkdtemp(prefix='afsv-home-')
        src, ref = _tmp(d, 'a.wav'), _tmp(d, 'b.wav')
        seen = {}

        def run(args, **kw):
            seen.update(kw)
            out = args[args.index('--output') + 1]
            _tmp(out, 'made.wav')
            return type('R', (), {'returncode': 0, 'stderr': b''})()

        script = os.path.join(d, '변환기', 'inference.py')
        os.makedirs(os.path.dirname(script), exist_ok=True)
        _tmp(os.path.dirname(script), 'inference.py')
        sv.convert_vocal(src, ref, os.path.join(d, 'out'), run=run,
                         conv={'python': 'py', 'script': script})
        self.assertEqual(seen.get('cwd'), os.path.dirname(script),
                         '변환기를 남의 집에서 돌린다 — 모델 캐시가 거기 쏟아진다')


class TestBoundaryStaysThin(unittest.TestCase):
    """★떼어낼 때 여기 한 곳만 보면 되는가."""

    def test_변환기를_아는_곳은_이_파일뿐이다(self):
        """★제품 코드만 본다.

        처음에는 검사 파일까지 뒤졌고, **같은 규칙을 강제하려고 그 이름들을 적어 둔**
        `test_song_chain.py` 를 위반으로 잡았다. 이 저장소에서 여러 번 나온
        '잘못 잡는 가드' 다 — 그런 가드는 결국 꺼진다.
        경계가 지켜져야 하는 곳은 **실제로 도는 코드**이지 검사 문장이 아니다.
        """
        leaks = []
        for name in sorted(os.listdir(HERE)):
            if not name.endswith('.py') or name.startswith('test_') or name == 'song_voice.py':
                continue
            body = io.open(os.path.join(HERE, name), encoding='utf-8',
                           errors='replace').read()
            for mark in ('diffusion-steps', 'f0-condition', 'auto-f0-adjust'):
                if mark in body:
                    leaks.append('%s — %s' % (name, mark))
        self.assertEqual(leaks, [], '변환기 사정이 밖으로 샜다: %s' % ', '.join(leaks))

    def test_이_부품은_분리도_합치기도_하지_않는다(self):
        for bad in ('separator', 'demucs', 'ffmpeg', 'mix'):
            self.assertNotIn(bad, SRC.lower(),
                             '한 칸만 맡기로 한 부품이 %s 까지 한다' % bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
