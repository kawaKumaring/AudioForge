import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from vc_diagnostics import Recorder, traced_vocoder

class DiagnosticsTest(unittest.TestCase):
    def test_array_roundtrip_and_preserve_input(self):
        with tempfile.TemporaryDirectory() as d:
            r=Recorder(Path(d)/'trace',{'seed':1});a=np.array([1.2,-.3],dtype=np.float32)
            before=a.copy();r.array('raw',a)
            self.assertTrue(np.array_equal(a,before))
            self.assertTrue(np.array_equal(np.load(r.root/'raw.npy',allow_pickle=False),before))
            self.assertEqual(json.loads((r.root/'record.json').read_text(encoding='utf-8'))['status'],'recording')
            with self.assertRaises(FileExistsError):r.array('raw',a)
            with self.assertRaises(FileExistsError):Recorder(r.root,{})
            r.complete(r.root/'raw.npy')
            saved=json.loads((r.root/'record.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['status'],'complete')
            self.assertEqual(saved['output']['sha256'],saved['arrays'][0]['sha256'])
    def test_reject_bad_arrays_and_names(self):
        with tempfile.TemporaryDirectory() as d:
            r=Recorder(Path(d)/'trace',{})
            for name,a in [('bad',[]),('bad',[np.nan]),('../outside',[1])]:
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):r.array(name,a)
    def test_observation_preserves_output_and_rng(self):
        class Vocoder(torch.nn.Module):
            def __init__(self):super().__init__();self.conv_post=torch.nn.Identity()
            def forward(self,x):return self.conv_post(x).clamp(-1,1)
        with tempfile.TemporaryDirectory() as d:
            r=Recorder(Path(d)/'trace',{});m=Vocoder();x=torch.tensor([[-1.2,.3,1.4]])
            rng=torch.get_rng_state().clone();actual=traced_vocoder(m,r)(x)
            self.assertTrue(torch.equal(actual,m(x)))
            self.assertTrue(torch.equal(rng,torch.get_rng_state()))
            self.assertTrue(np.array_equal(np.load(r.root/'chunk_0_prelimit_wave.npy'),x.numpy()))
            self.assertEqual(len(m.conv_post._forward_hooks),0)
    def test_hook_removed_after_failure(self):
        class Broken(torch.nn.Module):
            def __init__(self):super().__init__();self.conv_post=torch.nn.Identity()
            def forward(self,x):self.conv_post(x);raise RuntimeError('test failure')
        with tempfile.TemporaryDirectory() as d:
            m=Broken();r=Recorder(Path(d)/'trace',{})
            with self.assertRaises(RuntimeError):traced_vocoder(m,r)(torch.ones(2))
            self.assertEqual(len(m.conv_post._forward_hooks),0)
    def test_control_names_do_not_overwrite_conversion(self):
        class Vocoder(torch.nn.Module):
            def __init__(self):super().__init__();self.conv_post=torch.nn.Identity()
            def forward(self,x):return self.conv_post(x).clamp(-1,1)
        with tempfile.TemporaryDirectory() as d:
            r=Recorder(Path(d)/'trace',{});m=Vocoder();x=torch.ones(3)
            traced_vocoder(m,r)(x)
            traced_vocoder(m,r,prefix='control_source')(x)
            traced_vocoder(m,r,prefix='control_reference')(x)
            names=[a['name'] for a in r.document['arrays']]
            self.assertEqual(len(names),len(set(names)))
            self.assertEqual(len(names),9)
            with self.assertRaises(ValueError):traced_vocoder(m,r,prefix='../bad')

if __name__=='__main__':unittest.main()
