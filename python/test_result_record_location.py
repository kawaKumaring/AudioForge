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
