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

    def _conv(self, lead, ref, out_dir, log=None):
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
        out = sc.convert_song('v.mp4', 'ref.wav', self.d, voice_name='A',
                              ref_sec=8.0, song_sec=240.0,
                              separate_fn=self._sep, convert_fn=self._conv,
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
        sc.convert_song('v.mp4', 'ref.wav', self.d, voice_name='A', ref_sec=8.0,
                        separate_fn=self._sep, convert_fn=self._conv, run=self._run)
        note = os.path.join(self.d, '쓴목소리.json')
        self.assertTrue(os.path.isfile(note), '무엇으로 만들었는지 남기지 않았다')

    def test_단계_결과가_없으면_거기서_멈춘다(self):
        def empty(src, out_dir, key):
            os.makedirs(out_dir, exist_ok=True)
            return []
        with self.assertRaises(sc.SongChainError):
            sc.convert_song('v.mp4', 'ref.wav', self.d, ref_sec=8.0,
                            separate_fn=empty, convert_fn=self._conv, run=self._run)


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
