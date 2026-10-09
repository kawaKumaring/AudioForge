import unittest, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from quality_text import sentences,crosscheck

def report(text,segments,asr='small'):
    return {'source':{'sha256':'a'},'identity':{'text':text,'asr':asr,'modelHash':asr},'summary':{'window':[0,10]},'transcript':[{'kind':'segment','text':s,'start':i,'end':i+1} for i,s in enumerate(segments)]}

class TextTests(unittest.TestCase):
    def test_exact(self):
        r=sentences(report('안녕. 다음이다.',['안녕.','다음이다.']))
        self.assertEqual([x['status'] for x in r],['transcript_match']*2)
        self.assertEqual(r[1]['candidateWindows'],[{'start':1,'end':2}])
    def test_ordinal(self):
        self.assertEqual(sentences(report('2번째 장면.',['두 번째 장면.']))[0]['status'],'transcript_match')
    def test_wrong_number(self):
        self.assertNotEqual(sentences(report('5번째 장면.',['네 번째 장면.']))[0]['status'],'transcript_match')
    def test_missing_no_forced_time(self):
        r=sentences(report('안녕. 고맙습니다.',['안녕.']))[1]
        self.assertEqual(r['candidateWindows'],[])
        self.assertEqual(r['status'],'unlocated_candidate')
    def test_extra(self):
        r=sentences(report('안녕.',['안녕 안녕.']))
        self.assertTrue(r[0]['changes'])
    def test_repeated_sentence(self):
        r=sentences(report('안녕. 안녕.',['안녕.']))
        self.assertEqual(sum(x['status']=='transcript_match' for x in r),1)
    def test_disagree(self):
        r=crosscheck(report('안녕.',['안녕.']),report('안녕.',['안돼.'],'base'))
        self.assertEqual(r[0]['agreement'],'review_disagreement')
    def test_same_rejected(self):
        a=report('안녕.',['안녕.'])
        with self.assertRaises(ValueError):crosscheck(a,a)
    def test_mismatched_sources(self):
        a,b=report('안녕.',['안녕.']),report('안녕.',['안녕.'],'base');b['source']['sha256']='b'
        with self.assertRaises(ValueError):crosscheck(a,b)
    def test_mismatched_text(self):
        with self.assertRaises(ValueError):crosscheck(report('안녕.',['안녕.']),report('다음.',['다음.'],'base'))
    def test_mismatched_window(self):
        a,b=report('안녕.',['안녕.']),report('안녕.',['안녕.'],'base');b['summary']['window']=[1,10]
        with self.assertRaises(ValueError):crosscheck(a,b)
    def test_none_rejected(self):
        with self.assertRaises(ValueError):sentences(report('안녕.',[],'none'))
if __name__=='__main__':unittest.main()
