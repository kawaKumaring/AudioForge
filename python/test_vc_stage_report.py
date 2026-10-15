import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from vc_diagnostics import Recorder
from vc_stage_report import analyze_record,compare_limit

class StageReportTest(unittest.TestCase):
    def record(self,root,controls=False):
        r=Recorder(root,{'sampling_rate':100,'reconstruction_controls':controls})
        for prefix in ['chunk_0']+(['control_source_0','control_reference_0'] if controls else []):
            r.array(prefix+'_generated_mel',np.ones((1,2,3),dtype=np.float32))
            x=np.array([[[.2,1.2,-1.3,.4]]],dtype=np.float32)
            r.array(prefix+'_prelimit_wave',x);r.array(prefix+'_vocoder_wave',np.clip(x,-1,1))
        output=root/'fixture.bin';output.write_bytes(b'output fixture');r.complete(output)
        return root/'record.json'

    def test_clipping_locations_and_controls(self):
        with tempfile.TemporaryDirectory() as d:
            report=analyze_record(self.record(Path(d)/'trace',True))
            self.assertEqual(len(report['stages']),3)
            stage=report['stages'][0]
            self.assertEqual(stage['changed_samples'],2)
            self.assertEqual(stage['first_changed_regions_seconds'],[[.01,.03]])
            self.assertTrue(stage['matches_hard_clip'])

    def test_no_change_has_no_fake_error_db(self):
        x=np.array([.2,-.4]);r=compare_limit(x,x,100)
        self.assertEqual(r['changed_samples'],0);self.assertIsNone(r['error_relative_db'])

    def test_tampered_array_or_output_is_rejected(self):
        for target in ('chunk_0_prelimit_wave.npy','fixture.bin'):
            with self.subTest(target=target),tempfile.TemporaryDirectory() as d:
                path=self.record(Path(d)/'trace');(path.parent/target).write_bytes(b'tampered')
                with self.assertRaises(ValueError):analyze_record(path)

    def test_incomplete_or_missing_controls_is_rejected(self):
        for change in ('status','controls'):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as d:
                path=self.record(Path(d)/'trace');doc=json.loads(path.read_text(encoding='utf-8'))
                if change=='status':doc['status']='recording'
                else:doc['metadata']['reconstruction_controls']=True
                path.write_text(json.dumps(doc),encoding='utf-8')
                with self.assertRaises(ValueError):analyze_record(path)

    def test_duplicate_array_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path=self.record(Path(d)/'trace');doc=json.loads(path.read_text(encoding='utf-8'))
            doc['arrays'].append(doc['arrays'][0]);path.write_text(json.dumps(doc),encoding='utf-8')
            with self.assertRaises(ValueError):analyze_record(path)

    def test_stereo_is_not_flattened_into_time(self):
        with self.assertRaises(ValueError):compare_limit(np.ones((2,5)),np.ones((2,5)),100)

if __name__=='__main__':unittest.main()
