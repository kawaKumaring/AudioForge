# -*- coding: utf-8 -*-
"""따라부르기 사슬 — **가장 비싸게 배운 두 가지**를 못 박는다.

  1. 꼬리표를 마지막 것으로 고른다 (안 그러면 화음을 변환해 기계음이 난다)
  2. 참조는 짧아야 한다 (안 그러면 곡이 잘게 토막 나 이음매가 거칠어진다)

둘 다 2026-09-20 에 실제로 당한 것이고, 둘 다 **돌려 보기 전에는 안 보인다.**
그래서 검사로 막는다 — 고친 것보다 다시 안 생기게 하는 것이 중요하다.
"""
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import song_chain as sc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class TestLastTagRule(unittest.TestCase):
    """★이 사슬에서 가장 비싼 교훈. 네 곡을 통째로 다시 돌리게 만들었다."""

    # 2단계 산출물의 진짜 이름 모양. 1단계 꼬리표 `(Vocals)` 를 물려받는다.
    LEAD = 'source_(Vocals)_model_bs_roformer_ep_317_(Vocals)_mel_band_karaoke.wav'
    HARM = 'source_(Vocals)_model_bs_roformer_ep_317_(Instrumental)_mel_band_karaoke.wav'

    def test_물려받은_꼬리표에_속지_않는다(self):
        files = [self.HARM, self.LEAD]          # 화음이 앞에 오도록 — 사고 때와 같은 순서
        self.assertEqual(sc.pick_by_last_tag(files, 'Vocals'), self.LEAD,
                         '화음을 주 보컬로 골랐다 — 2026-09-20 그 사고다')
        self.assertEqual(sc.pick_by_last_tag(files, 'Instrumental'), self.HARM)

    def test_순서가_바뀌어도_같은_답(self):
        for files in ([self.LEAD, self.HARM], [self.HARM, self.LEAD]):
            self.assertEqual(sc.pick_by_last_tag(files, 'Vocals'), self.LEAD)

    def test_앞에_들어_있다고_걸리지_않는다(self):
        """'이름에 (vocals) 가 있는가' 로 고르면 둘 다 걸린다 — 그 방식이 아님을 본다."""
        self.assertIn('(Vocals)', self.HARM, '전제가 깨졌다 — 검사가 눈이 멀었다')
        self.assertNotEqual(sc.pick_by_last_tag([self.HARM], 'Vocals'), self.HARM)

    def test_괄호가_없으면_고르지_않는다(self):
        self.assertIsNone(sc.pick_by_last_tag(['그냥이름.wav'], 'Vocals'))

    def test_대소문자를_가리지_않는다(self):
        self.assertIsNotNone(sc.pick_by_last_tag(['a_(vocals).wav'], 'Vocals'))

    def test_1단계도_같은_규칙을_쓴다(self):
        one = ['source_(Instrumental)_model_bs.wav', 'source_(Vocals)_model_bs.wav']
        self.assertTrue(sc.pick_by_last_tag(one, 'Vocals').endswith('(Vocals)_model_bs.wav'))


class TestShortReference(unittest.TestCase):
    """★참조가 길면 곡이 잘게 갈린다 — 돌리고 나서야 '거칠다' 고 알아챈다."""

    def test_창은_참조가_길수록_좁아진다(self):
        self.assertAlmostEqual(sc.segment_window_sec(8.0), 22.0)
        self.assertAlmostEqual(sc.segment_window_sec(25.0), 5.0)

    def test_토막_수는_어림이지만_방향과_규모가_맞는다(self):
        """★이 값은 **어림**이다. 정확히 맞다고 말하지 않는다.

        2026-09-20 기록: 4분 곡 기준 참조 25초 → 51토막, 8초 → 12토막.
        여기 계산은 48 · 11 로 조금씩 적다 — 실제 변환기는 토막을 겹쳐 잇기 때문에
        내 나눗셈보다 몇 개 더 난다. 그 차이를 아는 척 맞추지 않는다.

        이 검사가 지키는 것은 **정확한 개수가 아니라 관계**다:
        참조가 길수록 토막이 급격히 늘고, 그 규모가 기록과 같은 자리에 있다는 것.
        """
        many = sc.segment_count(4 * 60, 25.0)
        few = sc.segment_count(4 * 60, 8.0)
        self.assertGreater(many, few * 3, '참조를 늘려도 토막이 확 늘지 않는다')
        self.assertTrue(40 <= many <= 55, '기록(51)과 규모가 다르다: %d' % many)
        self.assertTrue(8 <= few <= 15, '기록(12)과 규모가 다르다: %d' % few)

    def test_창이_남지_않으면_돌리지_않는다(self):
        with self.assertRaises(sc.SongChainError):
            sc.segment_count(240, 30.0)

    def test_긴_참조는_시작하기_전에_막는다(self):
        with self.assertRaises(sc.SongChainError) as e:
            sc.convert_song('v.mp4', 'ref.wav', os.path.join(HERE, '_없는작업'),
                            ref_sec=25.0, song_sec=240.0)
        msg = str(e.exception)
        self.assertIn('토막', msg, '왜 문제인지 말하지 않는다')
        self.assertIn('잘라', msg, '어떻게 고치는지 말하지 않는다')


class TestChainDoesNotSkipSteps(unittest.TestCase):
    """★주보컬 분리를 건너뛰면 겹친 목소리가 변환기에 들어가 기계음이 난다."""

    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afsc-')
        self.calls = []
        self.shift = None
        # ★가짜 경로 대신 진짜 파일을 쓴다. 사슬이 GPU 를 쓰기 전에 파일 존재를
        #   확인하기 때문이다 — 그 확인은 옳으므로 검사를 맞춘다.
        self.ref = os.path.join(self.d, 'ref.wav')
        with io.open(self.ref, 'w', encoding='utf-8') as f:
            f.write('x')

    def _sep(self, src, out_dir, key):
        self.calls.append(key)
        os.makedirs(out_dir, exist_ok=True)
        names = ['a_(Vocals)_x.wav', 'a_(Instrumental)_x.wav']
        made = []
        for n in names:
            p = os.path.join(out_dir, n)
            with io.open(p, 'w', encoding='utf-8') as f:
                f.write('x')
            made.append(p)
        return made

    def _conv(self, lead, ref, out_dir, log=None, semitones=0):
        self.shift = semitones
        self.calls.append('변환:' + os.path.basename(lead))
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, 'made.wav')
        with io.open(p, 'w', encoding='utf-8') as f:
            f.write('x')
        return p

    def _run(self, args, **kw):
        # ffmpeg 를 대신한다 — 결과 파일만 만들어 둔다.
        with io.open(args[-1], 'w', encoding='utf-8') as f:
            f.write('x')
        return type('R', (), {'returncode': 0, 'stderr': b''})()

    def test_두_분리를_모두_거치고_주보컬만_변환한다(self):
        out = sc.convert_song('v.mp4', self.ref, self.d, voice_name='A',
                              ref_sec=8.0, song_sec=240.0,
                              separate_fn=self._sep, convert_fn=self._conv, pitch_fn=False,
                              run=self._run)
        self.assertEqual(self.calls[0], sc.VOCAL_MODEL_KEY, '반주 분리를 안 했다')
        self.assertEqual(self.calls[1], sc.KARAOKE_MODEL_KEY,
                         '주보컬 분리를 건너뛰었다 — 기계음이 나는 길이다')
        # 변환에 들어간 것이 **2단계 산출물**이어야 한다(1단계 보컬이 아니라).
        self.assertTrue(self.calls[2].startswith('변환:'))
        self.assertEqual(set(out.keys()), {'주보컬만', '화음없이', '원래화음같이'})
        for p in out.values():
            self.assertTrue(os.path.isfile(p), '만들었다는 파일이 없다: %s' % p)

    def test_기록을_남긴다(self):
        sc.convert_song('v.mp4', self.ref, self.d, voice_name='A', ref_sec=8.0,
                        separate_fn=self._sep, convert_fn=self._conv, pitch_fn=False, run=self._run)
        note = os.path.join(self.d, '쓴목소리.json')
        self.assertTrue(os.path.isfile(note), '무엇으로 만들었는지 남기지 않았다')

    def test_단계_결과가_없으면_거기서_멈춘다(self):
        def empty(src, out_dir, key):
            os.makedirs(out_dir, exist_ok=True)
            return []
        with self.assertRaises(sc.SongChainError):
            sc.convert_song('v.mp4', self.ref, self.d, ref_sec=8.0,
                            separate_fn=empty, convert_fn=self._conv, run=self._run, pitch_fn=False)


    # ★어떤 곡에서는 두 번째 가르기가 말을 통째로 앗아간다(2026-09-26 청취 확인).
    #   그래서 건너뛸 수 있어야 하고, 건너뛰었다는 사실이 기록에 남아야 한다.
    def test_가르기를_건너뛰면_보컬_전체를_변환한다(self):
        out = sc.convert_song('v.mp4', self.ref, self.d, voice_name='A',
                              ref_sec=8.0, split_lead=False,
                              separate_fn=self._sep, convert_fn=self._conv,
                              pitch_fn=False, run=self._run)
        self.assertEqual(self.calls[0], sc.VOCAL_MODEL_KEY, '반주 분리는 해야 한다')
        self.assertNotIn(sc.KARAOKE_MODEL_KEY, self.calls,
                         '건너뛰라고 했는데 두 번째 가르기를 했다')
        self.assertIn('화음없이', out)
        self.assertNotIn('원래화음같이', out,
                         '화음을 갈라내지 않았는데 화음 섞은 것을 내놓는다')

    def test_건너뛴_사실이_기록에_남는다(self):
        import json
        sc.convert_song('v.mp4', self.ref, self.d, voice_name='A', ref_sec=8.0,
                        split_lead=False, separate_fn=self._sep,
                        convert_fn=self._conv, pitch_fn=False, run=self._run)
        with io.open(os.path.join(self.d, '쓴목소리.json'), encoding='utf-8') as f:
            note = json.load(f)
        self.assertEqual(note.get('주보컬 가르기'), '건너뜀',
                         '무엇을 건너뛰었는지 기록에 없으면 나중에 알 수 없다')

class TestOctaveShift(unittest.TestCase):
    """★2026-09-26 사용자 신고 — "목소리가 안 바뀌고 끅끅대며 숨소리만 난다."

      곡의 주보컬이 쓸 목소리보다 반 옥타브 넘게 높으면, 변환기가 음색을 입히지
      못하고 힘만 쓴다. 숫자로 확인됐다(음색 거리, 작을수록 그 목소리에 가깝다):
          그대로   참조와 63.9 · 원본과 71.7   ← 거의 안 바뀜
          한 옥타브 참조와 44.5 · 원본과 95.6   ← 확실히 바뀜
    """

    def test_신고된_그_경우에_한_옥타브_내린다(self):
        self.assertEqual(sc.octave_shift(519.0, 355.0), -12)

    def test_음역이_비슷하면_건드리지_않는다(self):
        self.assertEqual(sc.octave_shift(360.0, 355.0), 0)
        self.assertEqual(sc.octave_shift(300.0, 355.0), 0, '반음 몇 개로 옮기면 안 된다')

    def test_곡이_낮으면_올린다(self):
        self.assertEqual(sc.octave_shift(130.0, 260.0), 12)

    # ★옥타브 단위만 — 어중간한 간격은 반주와 조가 어긋나 노래가 깨진다.
    def test_언제나_옥타브_배수다(self):
        for song in range(80, 900, 7):
            for voice in (200.0, 355.0, 500.0):
                s = sc.octave_shift(float(song), voice)
                self.assertEqual(s % 12, 0, '옥타브가 아닌 간격으로 옮긴다: %d' % s)

    def test_옮긴_뒤에는_음역이_가까워진다(self):
        song, voice = 519.0, 355.0
        before = abs(sc.semitones(voice, song))
        after = abs(sc.semitones(voice, song * (2 ** (sc.octave_shift(song, voice) / 12.0))))
        self.assertLess(after, before, '옮겼는데 더 멀어졌다')

    def test_잴_수_없으면_옮기지_않는다(self):
        self.assertEqual(sc.octave_shift(0.0, 355.0), 0)
        self.assertEqual(sc.octave_shift(519.0, 0.0), 0)

class TestReusesAlreadySeparated(unittest.TestCase):
    """★더빙이 이미 갈라 둔 보컬을 그대로 쓴다 — 같은 일을 두 번 하지 않는다.

      2026-09-26 사용자 지적: "음원을 대체 몇 번을 불러내야 하는가".
      더빙과 따라부르기는 앞뒤가 같고 가운데만 다른 한 기능인데, 내가 둘을 따로
      만들어 갈라내기를 두 번 하게 해 놓았다. 이 문이 그것을 없앤다.
    """

    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp(prefix='afsc2-')
        self.calls = []
        def mk(name):
            p = os.path.join(self.d, name)
            with io.open(p, 'w', encoding='utf-8') as f:
                f.write('x')
            return p
        # 더빙 앞단이 만드는 이름 그대로
        self.vocals = mk('vocals.wav')
        self.bg = mk('background.wav')
        self.ref = mk('ref.wav')

    def _sep(self, src, out_dir, key):
        self.calls.append(key)
        os.makedirs(out_dir, exist_ok=True)
        made = []
        for n in ('a_(Vocals)_x.wav', 'a_(Instrumental)_x.wav'):
            p = os.path.join(out_dir, n)
            with io.open(p, 'w', encoding='utf-8') as f:
                f.write('x')
            made.append(p)
        return made

    def _conv(self, lead, ref, out_dir, log=None, semitones=0):
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, 'made.wav')
        with io.open(p, 'w', encoding='utf-8') as f:
            f.write('x')
        return p

    def _run(self, args, **kw):
        with io.open(args[-1], 'w', encoding='utf-8') as f:
            f.write('x')
        return type('R', (), {'returncode': 0, 'stderr': b''})()

    def test_반주_갈라내기를_다시_하지_않는다(self):
        sc.convert_from_vocals(self.vocals, self.bg, self.ref,
                               os.path.join(self.d, 'w'), voice_name='A',
                               separate_fn=self._sep, convert_fn=self._conv,
                               pitch_fn=False, run=self._run, split_lead=False)
        self.assertNotIn(sc.VOCAL_MODEL_KEY, self.calls,
                         '이미 갈라 둔 것을 받고도 반주 갈라내기를 또 했다')

    def test_주보컬_가르기는_고른_대로_한다(self):
        sc.convert_from_vocals(self.vocals, self.bg, self.ref,
                               os.path.join(self.d, 'w2'), voice_name='A',
                               separate_fn=self._sep, convert_fn=self._conv,
                               pitch_fn=False, run=self._run, split_lead=True)
        self.assertEqual(self.calls, [sc.KARAOKE_MODEL_KEY],
                         '두 번째 가르기만 해야 하는데 다른 것도 했다: %s' % self.calls)

    def test_없는_파일은_GPU_쓰기_전에_막는다(self):
        with self.assertRaises(sc.SongChainError) as e:
            sc.convert_from_vocals(os.path.join(self.d, '없음.wav'), self.bg, self.ref,
                                   os.path.join(self.d, 'w3'),
                                   separate_fn=self._sep, convert_fn=self._conv,
                                   pitch_fn=False, run=self._run)
        self.assertIn('보컬', str(e.exception), '무엇이 없는지 말하지 않는다')

    def test_두_진입점이_같은_뒷단을_쓴다(self):
        """갈라진 구현이 둘이면 한쪽만 고쳐지는 일이 생긴다."""
        with io.open(os.path.join(HERE, 'song_chain.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('return convert_from_vocals(', src,
                      '곡 전체 경로가 공용 뒷단을 쓰지 않는다')

class TestBoundaryToConverter(unittest.TestCase):
    """★변환기 사정이 이 파일로 새면, 모델을 갈아 끼울 때 여기도 뜯게 된다."""

    def test_사슬은_변환기의_인자를_모른다(self):
        with io.open(os.path.join(HERE, 'song_chain.py'), encoding='utf-8') as f:
            src = f.read()
        for mark in ('diffusion-steps', 'f0-condition', 'auto-f0-adjust', '--source'):
            self.assertNotIn(mark, src, '변환기 사정이 사슬로 샜다: %s' % mark)

    def test_이름을_바꾸지_않는_이유가_적혀_있다(self):
        """꼬리표를 지우면 위 사고가 되살아난다 — 왜 앱 경로를 안 쓰는지 남긴다."""
        with io.open(os.path.join(HERE, 'song_chain.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('이름을 바꾸지 않는다', src)


if __name__ == '__main__':
    unittest.main(verbosity=2)
