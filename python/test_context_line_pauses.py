import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import unittest
import numpy as np
from context_line_pauses import insert_line_pauses, plan_lines

class ContextPauseTests(unittest.TestCase):
    def asr(self, words):
        return {'segments':[{'words':[{'word':t,'start':a,'end':b} for t,a,b in words]}]}
    def test_samples_preserved_and_gap_not_doubled(self):
        x=np.ones(1000,dtype=np.float32)*.2; x[400:500]=0
        y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.3],self.asr([('안녕',0,.4),('반가워',.5,.9)]))
        self.assertEqual(r[0]['added_samples'],200)
        pos=r[0]['input_sample']; self.assertTrue(np.array_equal(np.r_[y[:pos],y[pos+200:]],x))
    def test_speech_between_words_is_not_cut(self):
        x=np.ones(1000)*.2
        y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.3],self.asr([('안녕',0,.4),('반가워',.5,.9)]))
        self.assertTrue(np.array_equal(x,y)); self.assertEqual(r[0]['status'],'NO_SAFE_SILENCE')
    def test_partial_word_not_split(self):
        x=np.zeros(1000)
        y,r=insert_line_pauses(x,1000,['안','녕'],[.3],self.asr([('안녕',0,.9)]))
        self.assertEqual(r[0]['status'],'NO_WORD_GAP'); self.assertEqual(len(x),len(y))
    def test_wrong_or_missing_words_do_not_pass(self):
        for words in [[('안녕',0,.4)],[('안녕',0,.4),('다른말',.5,.9)]]:
            x=np.zeros(1000); y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.3],self.asr(words))
            self.assertTrue(np.array_equal(x,y)); self.assertEqual(r[0]['status'],'TEXT_MISMATCH')
    def test_short_quiet_valley_not_safe(self):
        x=np.ones(1000)*.2; x[450:455]=0
        y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.3],self.asr([('안녕',0,.4),('반가워',.5,.9)]))
        self.assertTrue(np.array_equal(x,y))
    def test_conditions_and_explicit_pause_preserved(self):
        good=[('default','안녕',None),('default','반가워',None)]
        self.assertEqual(plan_lines(good,['internal','line'],[0,.5])[0],['안녕','반가워'])
        for kind in ['paragraph','explicitPause','emotion']:
            with self.assertRaises(ValueError):plan_lines(good,['internal',kind],[0,.5])
        with self.assertRaises(ValueError):plan_lines([good[0],('angry','반가워',None)],['internal','line'],[0,.5])
    def test_existing_long_silence_is_not_removed(self):
        x=np.zeros(1000); y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.1],self.asr([('안녕',0,.2),('반가워',.8,.9)]))
        self.assertTrue(np.array_equal(x,y)); self.assertEqual(r[0]['status'],'ALREADY_SUFFICIENT')

    def test_multiple_insertions_preserve_order_and_samples(self):
        x=np.full(1000,.2,dtype=np.float32); x[200:250]=0; x[600:650]=0
        y,r=insert_line_pauses(x,1000,['안녕','반가워','고마워'],[.2,.3],self.asr([('안녕',0,.2),('반가워',.25,.6),('고마워',.65,.9)]))
        self.assertEqual(len(y),1400)
        z=y.copy()
        for entry in reversed(r):
            pos=entry['output_sample']; n=entry['added_samples']; z=np.r_[z[:pos],z[pos+n:]]
        self.assertTrue(np.array_equal(z,x))
    def test_bad_timestamp_order_is_rejected(self):
        x=np.zeros(1000)
        y,r=insert_line_pauses(x,1000,['안녕','반가워'],[.3],self.asr([('안녕',.5,.8),('반가워',.1,.4)]))
        self.assertTrue(np.array_equal(x,y)); self.assertEqual(r[0]['status'],'TEXT_MISMATCH')

    def test_source_mapping_and_long_context_uses_no_character_cap(self):
        from context_line_pauses import line_sources, resolve_line_mode
        lines=['안녕', '반가워']; mapping=line_sources(lines)
        joined=' '.join(lines)
        self.assertEqual([joined[r['context_start']:r['context_end']] for r in mapping],lines)
        rows=[('default','가'*600,None),('default','나'*600,None)]
        self.assertEqual(len(plan_lines(rows,['internal','line'],[0,.5])[0]),2)
        self.assertEqual(resolve_line_mode('context'),'context')
        for value in [None, True, 'unknown']:
            with self.assertRaises(ValueError):resolve_line_mode(value)
