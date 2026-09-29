# -*- coding: utf-8 -*-
"""노래 변환 진입점 — **사슬을 다시 만들지 않고 잇기만 하는가.**

모델·GPU·실제 소리를 쓰지 않는다. 가짜 부품으로 계약만 본다.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import song_worker


class PercentMap(unittest.TestCase):
    """단계 글월이 진행률로 옮겨지는가."""

    def test_아는_단계는_진행률을_준다(self):
        self.assertEqual(song_worker.percent_for('소리 꺼내는 중'), 4)
        self.assertEqual(song_worker.percent_for('목소리 바꾸는 중'), 40)
        self.assertEqual(song_worker.percent_for('합치는 중'), 92)

    def test_진행률이_뒤로_가지_않는다(self):
        order = [p for _, p in song_worker.STAGE_PERCENT]
        self.assertEqual(order, sorted(order), '단계 순서와 진행률이 어긋난다')

    def test_모르는_글월은_진행률을_건드리지_않는다(self):
        self.assertIsNone(song_worker.percent_for('무언가 다른 말'))

    def test_가르기를_건너뛰어도_같은_자리다(self):
        """켜든 끄든 그 단계의 진행률은 같아야 화면이 튀지 않는다."""
        self.assertEqual(song_worker.percent_for('주 보컬과 화음 가르는 중'),
                         song_worker.percent_for('주 보컬 가르기를 건너뛴다 — 보컬 전체를'))


class VideoDetect(unittest.TestCase):
    def test_영상과_소리를_가른다(self):
        self.assertTrue(song_worker.is_video('a.mp4'))
        self.assertTrue(song_worker.is_video('B.MKV'))
        self.assertFalse(song_worker.is_video('a.wav'))
        self.assertFalse(song_worker.is_video(''))


class PrepareReference(unittest.TestCase):
    """참조 토막 — 원본을 건드리지 않고, 어디를 썼는지 남기는가."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='songworker_')
        self.voice = os.path.join(self.dir, 'voice.wav')
        with io.open(self.voice, 'wb') as f:
            f.write(b'original-bytes')
        self.calls = []

        def fake_cut(src, dest, seconds=8.0):
            self.calls.append((src, dest, seconds))
            with io.open(dest, 'wb') as f:
                f.write(b'clip')
            return {'path': dest, 'start_sec': 12.5, 'seconds': 8.0, 'source_sec': 95.0}

        self._real_cut = song_worker.song_reference.cut
        song_worker.song_reference.cut = fake_cut

    def tearDown(self):
        song_worker.song_reference.cut = self._real_cut
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_긴_원본도_받고_토막을_따로_만든다(self):
        ref = song_worker.prepare_reference(self.voice, self.dir, 'abcdef123456', lambda _m: None)
        self.assertNotEqual(ref['clipPath'], self.voice, '원본을 참조로 그대로 쓰면 곡이 토막 난다')
        self.assertEqual(ref['fromPath'], self.voice, '어느 파일에서 왔는지 남아야 한다')
        self.assertEqual(ref['startSec'], 12.5)
        self.assertEqual(ref['durationSec'], 8.0)
        self.assertFalse(ref['wholeFile'])

    def test_원본_바이트를_건드리지_않는다(self):
        song_worker.prepare_reference(self.voice, self.dir, 'abcdef123456', lambda _m: None)
        with io.open(self.voice, 'rb') as f:
            self.assertEqual(f.read(), b'original-bytes')

    def test_짧은_원본은_통째로_쓴_것으로_표시한다(self):
        def short_cut(src, dest, seconds=8.0):
            with io.open(dest, 'wb') as f:
                f.write(b'clip')
            return {'path': dest, 'start_sec': 0.0, 'seconds': 5.0, 'source_sec': 5.0}
        song_worker.song_reference.cut = short_cut
        ref = song_worker.prepare_reference(self.voice, self.dir, 'abcdef123456', lambda _m: None)
        self.assertTrue(ref['wholeFile'])

    def test_영상_목소리는_소리를_꺼내_쓴다(self):
        video = os.path.join(self.dir, 'voice.mp4')
        with io.open(video, 'wb') as f:
            f.write(b'video')
        pulled = []

        def fake_extract(src, dest, run=None):
            pulled.append((src, dest))
            with io.open(dest, 'wb') as f:
                f.write(b'pulled')
            return dest
        real = song_worker.song_chain.extract_audio
        song_worker.song_chain.extract_audio = fake_extract
        try:
            ref = song_worker.prepare_reference(video, self.dir, 'abcdef123456', lambda _m: None)
        finally:
            song_worker.song_chain.extract_audio = real
        self.assertEqual(len(pulled), 1, '영상에서 소리를 꺼내지 않았다')
        self.assertTrue(ref['extractedFrom'].endswith('voice_source.wav'))
        self.assertEqual(ref['fromPath'], video, '원본은 영상 경로로 남아야 한다')

    # ★준비가 실패하면 **거기서 멈춘다.** 다른 목소리로 바꾸지 않는다.
    def test_토막을_고르지_못하면_멈춘다(self):
        def angry_cut(src, dest, seconds=8.0):
            raise song_worker.song_reference.SongReferenceError('쓸 만한 구간이 없습니다')
        song_worker.song_reference.cut = angry_cut
        with self.assertRaises(song_worker.song_reference.SongReferenceError):
            song_worker.prepare_reference(self.voice, self.dir, 'abcdef123456', lambda _m: None)


if __name__ == '__main__':
    unittest.main(verbosity=2)
