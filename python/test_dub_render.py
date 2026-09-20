# -*- coding: utf-8 -*-
"""dub_render.py 검사 - 검사용 영상을 **직접 만들어** 끝까지 한 번 돌린다.

남의 저작물도 사용자 미디어도 쓰지 않는다. 단색 화면에 합성 신호를 붙인 6초짜리다.

실행: python -X utf8 python/test_dub_render.py
의존이나 ffmpeg 가 없으면 건너뛰고 그 사실을 남긴다.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
    import soundfile as sf
    HAVE_SF = True
except Exception:
    HAVE_SF = False

import audio_fit
import dub_render as dr


def video_duration(path):
    """영상 길이(초). soundfile 은 mp4 를 못 읽으므로 ffprobe 로 잰다."""
    import subprocess
    exe = os.path.join(os.path.dirname(audio_fit.find_ffmpeg()), 'ffprobe.exe')
    if not os.path.isfile(exe):
        exe = 'ffprobe'
    r = subprocess.run([exe, '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or b'').decode('utf-8', 'replace')[:200])
    return float((r.stdout or b'').decode('utf-8', 'replace').strip())


class Test짝짓기(unittest.TestCase):
    """소리 파일 없이 되는 부분. 짝이 맞는지, 빠진 줄을 알리는지."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-rend-')
        self.a = os.path.join(self.dir, 'a.wav')
        self.b = os.path.join(self.dir, 'b.wav')
        for p in (self.a, self.b):
            open(p, 'w').close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def lines(self):
        return [{'index': 0, 'start': 0.0, 'end': 2.0, 'korean': '첫 줄'},
                {'index': 1, 'start': 3.0, 'end': 5.0, 'korean': '둘째 줄'}]

    def test_소리가_없는_줄을_따로_알린다(self):
        """★조용히 빼면 결과에서 그 대사만 사라지고 아무도 이유를 모른다."""
        _, ready, missing = dr.collect_lines(self.lines(), {'0': self.a},
                                             probe=lambda p: 1.5)
        self.assertEqual(missing, [1])
        self.assertEqual([r['index'] for r in ready], [0])

    def test_경로가_있어도_파일이_없으면_빠진_것으로_본다(self):
        _, _, missing = dr.collect_lines(
            self.lines(), {'0': self.a, '1': os.path.join(self.dir, '없다.wav')},
            probe=lambda p: 1.5)
        self.assertEqual(missing, [1])

    def test_줄_번호를_숫자로_줘도_찾는다(self):
        _, ready, missing = dr.collect_lines(self.lines(), {0: self.a, 1: self.b},
                                             probe=lambda p: 1.0)
        self.assertEqual(missing, [])
        self.assertEqual(len(ready), 2)

    def test_시작_시각_순서로_정렬한다(self):
        """자리 계산은 순서대로 받는 것을 전제한다 - 여기서 보장한다."""
        lines = [{'index': 0, 'start': 9.0, 'end': 10.0, 'korean': '나중'},
                 {'index': 1, 'start': 1.0, 'end': 2.0, 'korean': '먼저'}]
        _, ready, _ = dr.collect_lines(lines, {0: self.a, 1: self.b},
                                       probe=lambda p: 0.5)
        self.assertEqual([r['index'] for r in ready], [1, 0])

    def test_읽을_수_없는_소리는_몇_번째인지_말한다(self):
        def boom(p):
            raise OSError('깨진 파일')
        with self.assertRaises(dr.DubRenderError) as cm:
            dr.collect_lines(self.lines(), {'0': self.a}, probe=boom)
        self.assertIn('1번째', str(cm.exception))


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 - 공용 venv 필요')
class Test끝까지_한_번(unittest.TestCase):
    SR = 24000
    DUR = 6.0

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='af-rend-e2e-')
        self.work = os.path.join(self.dir, 'work')
        os.makedirs(self.work)
        sr = self.SR
        t = np.arange(int(sr * self.DUR)) / float(sr)

        # 배경음: 6초 내내 낮게 깔린다.
        sf.write(os.path.join(self.work, 'background.wav'),
                 (0.2 * np.sin(2 * np.pi * 110.0 * t)).astype('float32'), sr)

        # 원본 보컬: 0~2초와 3~5초에만 소리가 있다(음량 맞추기가 쓸 재료).
        v = np.zeros_like(t, dtype='float32')
        for a, b, amp in ((0.0, 2.0, 0.5), (3.0, 5.0, 0.15)):
            seg = slice(int(a * sr), int(b * sr))
            v[seg] = (amp * np.sin(2 * np.pi * 300.0 * t[seg])).astype('float32')
        sf.write(os.path.join(self.work, 'vocals.wav'), v, sr)

        with open(os.path.join(self.work, 'lines.json'), 'w', encoding='utf-8') as f:
            json.dump({'language': 'ja', 'backend': 'llm', 'lines': [
                {'index': 0, 'start': 0.0, 'end': 2.0, 'source': 'x', 'korean': '첫 줄'},
                {'index': 1, 'start': 3.0, 'end': 5.0, 'source': 'y', 'korean': '둘째 줄'},
            ]}, f, ensure_ascii=False)

        # 줄별 소리: 첫 줄은 자리에 맞고(1.5초), 둘째 줄은 넘쳐 늘여야 한다(2.4초).
        self.takes = {}
        for idx, dur in ((0, 1.5), (1, 2.4)):
            tt = np.arange(int(sr * dur)) / float(sr)
            p = os.path.join(self.dir, 'take-%d.wav' % idx)
            sf.write(p, (0.4 * np.sin(2 * np.pi * 440.0 * tt)).astype('float32'), sr)
            self.takes[str(idx)] = p

        # 검사용 영상: 단색 화면 + 배경음. 직접 만든다.
        self.video = os.path.join(self.dir, 'clip.mp4')
        try:
            audio_fit._run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=15:d=%.1f' % self.DUR,
                '-i', os.path.join(self.work, 'background.wav'),
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-shortest', self.video,
            ])
        except audio_fit.AudioFitError as e:
            self.skipTest('검사용 영상을 만들지 못했다: %s' % e)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_더빙된_영상이_나온다(self):
        dest = os.path.join(self.dir, 'dubbed.mp4')
        r = dr.render(self.work, self.takes, self.video, dest)
        self.assertTrue(os.path.isfile(dest))
        self.assertGreater(os.path.getsize(dest), 1000)
        # 소리는 따로 읽을 수 있다 - 트랙 길이가 영상 길이와 맞는지 본다.
        self.assertLess(abs(audio_fit.probe_duration(r['audio']) - self.DUR), 0.3)
        try:
            self.assertLess(abs(video_duration(dest) - self.DUR), 0.3)
        except (RuntimeError, OSError, ValueError) as e:
            self.skipTest('ffprobe 로 영상 길이를 재지 못했다: %s' % e)

    def test_줄마다_상태를_남긴다(self):
        dest = os.path.join(self.dir, 'dubbed.mp4')
        r = dr.render(self.work, self.takes, self.video, dest)
        self.assertEqual(r['summary']['total'], 2)
        self.assertEqual(r['summary']['missing_indexes'], [])
        self.assertEqual([x['index'] for x in r['lines']], [0, 1])
        for row in r['lines']:
            self.assertIn(row['status'], ('fit', 'stretched', 'over'))

    def test_원본_영상은_그대로다(self):
        """★건드리지 않는다는 약속. 크기와 시각으로 확인한다."""
        before = os.stat(self.video)
        dr.render(self.work, self.takes, self.video,
                  os.path.join(self.dir, 'dubbed.mp4'))
        after = os.stat(self.video)
        self.assertEqual((before.st_size, int(before.st_mtime)),
                         (after.st_size, int(after.st_mtime)))

    def test_한국어_자막도_함께_나온다(self):
        dest = os.path.join(self.dir, 'dubbed.mp4')
        r = dr.render(self.work, self.takes, self.video, dest)
        self.assertTrue(os.path.isfile(r['srt']))
        with open(r['srt'], encoding='utf-8') as f:
            text = f.read()
        self.assertIn('첫 줄', text)
        self.assertIn('둘째 줄', text)

    def test_작게_말한_대목은_새_목소리도_작아진다(self):
        """★원래 작게 말한 대목에서 새 목소리가 크게 나오면 바로 어색해진다."""
        dest = os.path.join(self.dir, 'dubbed.mp4')
        dr.render(self.work, self.takes, self.video, dest)
        fit_dir = os.path.join(self.work, 'fitted')
        loud = audio_fit.measure_loudness(os.path.join(fit_dir, 'line-0000.wav'))
        quiet = audio_fit.measure_loudness(os.path.join(fit_dir, 'line-0001.wav'))
        self.assertIsNotNone(loud)
        self.assertIsNotNone(quiet)
        self.assertLess(quiet, loud - 3.0,
                        '크게 말한 줄 %.1f, 작게 말한 줄 %.1f LUFS' % (loud, quiet))

    def test_소리가_없는_줄이_있어도_나머지는_나온다(self):
        dest = os.path.join(self.dir, 'dubbed.mp4')
        r = dr.render(self.work, {'0': self.takes['0']}, self.video, dest)
        self.assertEqual(r['summary']['missing_indexes'], [1])
        self.assertTrue(os.path.isfile(dest))

    def test_소리가_하나도_없으면_사유와_함께_멈춘다(self):
        with self.assertRaises(dr.DubRenderError) as cm:
            dr.render(self.work, {}, self.video, os.path.join(self.dir, 'x.mp4'))
        self.assertIn('소리를 먼저 만드세요', str(cm.exception))

    def test_앞단_결과가_없으면_무엇이_없는지_말한다(self):
        os.remove(os.path.join(self.work, 'background.wav'))
        with self.assertRaises(dr.DubRenderError) as cm:
            dr.render(self.work, self.takes, self.video,
                      os.path.join(self.dir, 'x.mp4'))
        self.assertIn('background.wav', str(cm.exception))


if __name__ == '__main__':
    unittest.main()
