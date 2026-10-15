import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import tempfile,unittest
from pathlib import Path
import numpy as np
import soundfile as sf
import tts_worker as worker
from speech_join_policy import has_active_tail

class ActiveTailPreservation(unittest.TestCase):
    def test_preservation_evidence_survives_metadata_filters(self):
        self.assertIn('active_tail_preserved',worker._RUN_HEADER_FROM_METADATA)
        self.assertIn('segment_active_tail_preserved_count',worker._RUN_HEADER_FROM_METADATA)

    def test_guard_checks_entire_tail_not_just_last_sample(self):
        x=np.zeros(2400,dtype=np.float32);x[-200]=.1
        self.assertTrue(has_active_tail(x,24000))
        self.assertFalse(has_active_tail(np.full(2400,.0005),24000))
        self.assertFalse(has_active_tail(np.zeros(0),24000))

    def test_line_end_is_bit_identical_when_active(self):
        with tempfile.TemporaryDirectory() as d:
            paths=[]
            for i in range(2):
                p=str(Path(d)/f'{i}.wav')
                sf.write(p,np.full(4800,.2,dtype=np.float32),24000,subtype='FLOAT');paths.append(p)
            originals=[Path(p).read_bytes() for p in paths]
            out,meta=worker._apply_segment_envelopes(paths,[{'original_segment_index':i,'chunk_index':0} for i in range(2)],['internal','line'],d,preserve_active_tail=True)
            np.testing.assert_array_equal(sf.read(paths[0])[0],sf.read(out[0])[0])
            self.assertEqual(meta['segment_envelope_offset_count'],0)
            self.assertEqual(meta['segment_active_tail_preserved_count'],1)
            self.assertEqual(meta['segment_envelope_onset_count'],1)
            self.assertEqual([Path(p).read_bytes() for p in paths],originals)

    def test_quiet_line_end_keeps_click_fade(self):
        with tempfile.TemporaryDirectory() as d:
            paths=[]
            for i in range(2):
                p=str(Path(d)/f'{i}.wav');x=np.full(4800,.2,dtype=np.float32);x[-480:]=.0005
                sf.write(p,x,24000,subtype='FLOAT');paths.append(p)
            out,meta=worker._apply_segment_envelopes(paths,[{'original_segment_index':i,'chunk_index':0} for i in range(2)],['internal','line'],d,preserve_active_tail=True)
            self.assertEqual(meta['segment_envelope_offset_count'],1)
            self.assertEqual(meta['segment_active_tail_preserved_count'],0)
            self.assertEqual(sf.read(out[0])[0][-1],0)
            np.testing.assert_array_equal(sf.read(paths[0])[0][:-480],sf.read(out[0])[0][:-480])

    def test_final_tail_retains_speech_and_adds_requested_wait(self):
        for mode in ('auto','off'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as d:
                src=str(Path(d)/'src.wav');dst=str(Path(d)/'dst.wav')
                x=np.full(4800,.2,dtype=np.float32);sf.write(src,x,24000,subtype='FLOAT')
                result=worker._finish_and_place(src,dst,0,d,{'mode':mode,'pad_ms':120,'fade_ms':8},preserve_active_tail=True)
                y,sr=sf.read(dst,dtype='float32')
                self.assertTrue(result['active_tail_preserved'])
                self.assertEqual(result['boundary_offset_samples'],0)
                self.assertFalse(result['tail_fade_applied'])
                np.testing.assert_array_equal(x[-480:],y[4320:4800])
                self.assertEqual(len(y),4800+(2880 if mode=='auto' else 0))
                if mode=='auto':self.assertFalse(np.any(y[4800:]))

if __name__=='__main__':unittest.main()
