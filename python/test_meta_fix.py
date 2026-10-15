# -*- coding: utf-8 -*-
"""메타 고치기 — 고친 메타 하나가 깨져 있으면 **아무 이름도 바꾸지 않고** 어느 파일인지 말한다(2026-10-16)."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import argparse
import contextlib
import io
import json
import shutil
import tempfile
import unittest

import separate


class TestMetaFix(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='af-metafix-')
        for n in ('01_a', '02_b'):
            open(os.path.join(self.d, n + '.wav'), 'wb').close()
        with open(os.path.join(self.d, '01_a.json'), 'w', encoding='utf-8') as f:
            json.dump({'output_file': '01_a.wav', 'title': '새 제목', 'track_number': 1}, f, ensure_ascii=False)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_깨진_메타가_있으면_아무것도_바꾸지_않는다(self):
        with open(os.path.join(self.d, '02_b.json'), 'w', encoding='utf-8') as f:
            f.write('{"output_file": "02_b.wav", ')
        buf = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(buf):
            separate._run_meta_fix(argparse.Namespace(output=self.d))
        self.assertEqual(cm.exception.code, 1)
        errors = [json.loads(l)['message'] for l in buf.getvalue().splitlines() if '"error"' in l]
        self.assertTrue(errors and '02_b.json' in errors[0] and '아무 파일도 바꾸지 않았습니다' in errors[0])
        self.assertEqual(sorted(f for f in os.listdir(self.d) if f.endswith('.wav')), ['01_a.wav', '02_b.wav'],
                         '앞쪽 트랙 이름만 바뀐 채 멈췄다')


if __name__ == '__main__':
    unittest.main(verbosity=2)
