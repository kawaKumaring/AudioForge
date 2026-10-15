import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import soundfile as sf
import speech_join_policy as policy
import tts_worker as worker
import reference_region as region

class Preservation(unittest.TestCase):
    def test_level_ignores_added_silence(self):
        voice = np.full(2400, .2, dtype=np.float32)
        self.assertAlmostEqual(policy.active_rms(voice, 24000),
            policy.active_rms(np.r_[np.zeros(4800), voice, np.zeros(7200)], 24000))

    def test_stereo_phase_and_silence(self):
        x = np.column_stack([np.full(2400,.2), np.full(2400,-.2)])
        self.assertAlmostEqual(policy.active_rms(x,24000),.2)
        self.assertEqual(policy.active_rms(np.zeros(1000),24000),0)

    def test_quiet_edge_does_not_touch_voice_or_length(self):
        x=np.full(1000,.3,dtype=np.float32); x[-48:]=.0005
        y, applied=policy.quiet_edge(x,24000)
        self.assertTrue(applied); self.assertEqual(len(x),len(y))
        np.testing.assert_array_equal(x[:-48],y[:-48])
        self.assertEqual(y[-1],0); self.assertEqual(x[-1],np.float32(.0005))

    def test_nonquiet_edge_untouched(self):
        x=np.full(1000,.02,dtype=np.float32)
        y, applied=policy.quiet_edge(x,24000)
        self.assertFalse(applied); np.testing.assert_array_equal(x,y)

    def test_peak_guard_is_single_gain(self):
        x=np.array([0,1.2,-1.3,.01],dtype=np.float32)
        y,g=policy.peak_safe(x)
        np.testing.assert_allclose(y,x*g); self.assertLessEqual(np.max(np.abs(y)),.970001)
        self.assertEqual(policy.peak_safe(np.array([.2]))[1],1)

    def test_concat_preserves_overrange_and_gap(self):
        with tempfile.TemporaryDirectory(prefix='audioforge_join_') as d:
            a=str(Path(d)/'a.wav'); b=str(Path(d)/'b.wav'); out=str(Path(d)/'out.wav')
            sf.write(a,np.full(240,1.2,dtype=np.float32),24000,subtype='FLOAT')
            sf.write(b,np.full(240,-1.1,dtype=np.float32),24000,subtype='FLOAT')
            before=Path(a).read_bytes()
            layout=worker._concat_with_boundaries([a,b],[0,.01],out)
            x,sr=sf.read(out,dtype='float32')
            self.assertEqual(sf.info(out).subtype,'FLOAT'); self.assertEqual(len(x),720)
            self.assertEqual(layout[1]['start_sample'],480)
            np.testing.assert_array_equal(x[:240],np.full(240,np.float32(1.2)))
            self.assertEqual(Path(a).read_bytes(),before)

    def test_internal_boundary_pipeline_preserves_spoken_samples(self):
        with tempfile.TemporaryDirectory(prefix='audioforge_edges_') as d:
            paths=[]
            for i in range(2):
                x=np.full(1000,.2,dtype=np.float32); x[:48]=.0005; x[-48:]=-.0005
                p=str(Path(d)/f'{i}.wav'); sf.write(p,x,24000,subtype='FLOAT'); paths.append(p)
            out,meta=worker._apply_segment_envelopes(paths,
                [{'original_segment_index':0,'chunk_index':i} for i in range(2)],['internal'],d)
            self.assertEqual(len(meta['internal_quiet_edges']),2)
            for p,q in zip(paths,out):
                a,_=sf.read(p); b,_=sf.read(q)
                self.assertEqual(len(a),len(b)); np.testing.assert_array_equal(a[48:-48],b[48:-48])
            np.testing.assert_array_equal(sf.read(paths[0])[0][:48],sf.read(out[0])[0][:48])
            np.testing.assert_array_equal(sf.read(paths[1])[0][-48:],sf.read(out[1])[0][-48:])

    def test_final_stage_guards_peak_and_preserves_body_shape(self):
        with tempfile.TemporaryDirectory(prefix='audioforge_finish_') as d:
            src=str(Path(d)/'source.wav'); dst=str(Path(d)/'final.wav')
            x=np.full(24000,1.2,dtype=np.float32)
            sf.write(src,x,24000,subtype='FLOAT')
            r=worker._finish_and_place(src,dst,0,d,tail_cfg={'mode':'off'})
            y,sr=sf.read(dst,dtype='float32')
            self.assertLessEqual(float(np.max(np.abs(y))),.970001)
            self.assertEqual(len(y),len(x)); self.assertLess(r['final_peak_gain'],1)
            np.testing.assert_allclose(y[1000:-1000],x[1000:-1000]*r['final_peak_gain'],atol=1e-6)

    def test_reference_prefers_less_clipping_among_comparable_candidates(self):
        sr=1000
        x=np.zeros(15000,dtype=np.float32)
        x[1000:6000]=.2; x[2000:2010]=1.
        x[8000:13000]=.2
        with patch.object(region,'_load_mono',return_value=(x,sr)), patch.object(region,'detect_silences',
                return_value=[(0,1),(6,7),(7,8),(13,14)]):
            r=region.recommend_region('unused',min_sec=5,max_sec=6)
        self.assertTrue(r['ok']); self.assertGreater(r['start_sec'],6)
        self.assertEqual(r['selection_policy'],'speech_amount_then_clipping_v1')
        self.assertLessEqual(len(r['candidates']),3)

if __name__ == '__main__':
    unittest.main()
