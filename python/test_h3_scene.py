import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import unittest
from types import SimpleNamespace
from h3_scene import validate_direction
from h3_engine import prompt_for,H3Engine
from h3_voice_server import run_request

class SceneTests(unittest.TestCase):
    def test_default_unchanged(self):
        self.assertEqual(prompt_for('원문'),prompt_for('원문',''))
        self.assertIn('calm and warm',prompt_for('원문'))
    def test_dialogue_separate(self):
        p=prompt_for('돌아와 줘!','친구를 붙잡으며 절박하게 말한다')
        self.assertEqual(p.split('<d>[Korean] ')[1].split('</d>')[0],'돌아와 줘!')
        self.assertNotIn('calm and warm',p)
        self.assertIn('친구를 붙잡으며 절박하게 말한다',p)
    def test_invalid(self):
        for v in ['<d>말</d>','[Shot 2]','summary <x>','가'*1201,12]:
            with self.assertRaises(ValueError):validate_direction(v)
        self.assertEqual(validate_direction('  조용히 말한다  '),'조용히 말한다')
    def test_private_record(self):
        e=H3Engine();e.records=[{'scene_direction':'비밀 지시','scene_direction_requested':True,'chunks':[{'sent_text':'원문','seed':1}]}]
        r=e.public_records()[0]
        self.assertNotIn('scene_direction',r);self.assertNotIn('sent_text',r['chunks'][0])
    def test_server_clears_direction(self):
        e=SimpleNamespace(records=[],direction='')
        def synth(*args):e.records.append({'direction':e.direction})
        e.synthesize_segment=synth
        req={'seed':1,'text':'원문','ref':'A','speed':1,'out':'결과','direction':'분노'}
        self.assertEqual(run_request(e,req,None)['record']['direction'],'분노')
        self.assertEqual(e.direction,'')
        req.pop('direction');self.assertEqual(run_request(e,req,None)['record']['direction'],'')
    def test_failure_clears_direction(self):
        e=SimpleNamespace(records=[])
        def fail(*args):raise ValueError('실패')
        e.synthesize_segment=fail
        r=run_request(e,{'seed':1,'text':'원문','ref':'A','speed':1,'out':'결과','direction':'분노'},None)
        self.assertFalse(r['ok']);self.assertEqual(e.direction,'')
