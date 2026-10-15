import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import local_assets
from _test_root import test_dir

class ResultRecordLocation(unittest.TestCase):
    def test_new_record_is_beside_result(self):
        with tempfile.TemporaryDirectory(dir=test_dir('temp','result-record-location')) as d:
            with patch.dict(os.environ,{'AUDIOFORGE_RUN_RECORD_OUTPUT_DIR':d}):
                p=local_assets.run_record_dir('run-1')
                self.assertEqual(Path(p),Path(d).resolve()/'.generation-record'/'run-1')
                self.assertTrue(Path(p).is_dir())
    def test_other_output_and_path_escape_rejected(self):
        with tempfile.TemporaryDirectory(dir=test_dir('temp','result-record-location')) as d:
            with patch.dict(os.environ,{'AUDIOFORGE_RUN_RECORD_OUTPUT_DIR':d}):
                with self.assertRaises(local_assets.ExternalOutputBlocked):local_assets.assert_run_record_root(str(Path(d)/'other'))
                with self.assertRaises(ValueError):local_assets.run_record_dir('../escape')
    def test_actual_private_script_is_in_result(self):
        import chunk_publish
        with tempfile.TemporaryDirectory(dir=test_dir('temp','result-record-location')) as d:
            with patch.dict(os.environ,{'AUDIOFORGE_RUN_RECORD_OUTPUT_DIR':d}):
                rec=chunk_publish.ChunkRecorder()
                rec.set_script('사용자 입력 대사',None)
                rec.open()
                rec.write('ok')
                self.assertTrue(str(Path(rec.root).resolve()).startswith(str(Path(d).resolve())))
                self.assertTrue(any('사용자 입력 대사' in p.read_text(encoding='utf-8') for p in Path(rec.root).glob('*.json')))
