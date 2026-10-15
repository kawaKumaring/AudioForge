import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import sys, os, unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'yingmusic_vc'))
import convert as y
import song_voice as sv
class Contract(unittest.TestCase):
    def args(self, *extra):
        return y.build_parser().parse_args(['--source','missing.wav','--target','missing-ref.wav',*extra])
    def test_default_stays_seedvc(self):
        with patch.dict(os.environ, {sv.ENGINE_ENV:''}):
            self.assertEqual(sv.converter()['script'],sv.ABSORBED_SCRIPT)
    def test_explicit_engine(self):
        with patch.dict(os.environ, {sv.ENGINE_ENV:'yingmusic'}):
            self.assertTrue(sv.converter()['script'].endswith(os.path.join('yingmusic_vc','convert.py')))
    def test_pitch_and_speed_rejected_before_loading(self):
        for values in [('--auto-f0-adjust','True'),('--semi-tone-shift','12'),('--length-adjust','1.1')]:
            with self.subTest(values=values), patch.object(y,'load_models') as load:
                with self.assertRaises(SystemExit): y.main(self.args(*values))
                load.assert_not_called()
    def test_shared_model_paths(self):
        paths=y.model_paths('shared')
        self.assertEqual(paths['whisper'],os.path.join('shared','whisper-small'))
        self.assertIn('yingmusic_svc_models',paths['dit'])
    def test_model_keys_are_strict(self):
        import tempfile,torch
        from modules.commons import Munch
        class Fake:
            def load_state_dict(self, weights, strict):
                assert strict
                raise RuntimeError('missing weight')
        with patch('modules.commons.build_model',return_value=Munch(cfm=Fake())), patch.object(torch,'load',return_value={'net':{'cfm':{}}}):
            with self.assertRaisesRegex(RuntimeError,'missing weight'):
                y.load_dit('unused',str(ROOT/'yingmusic_vc/configs/YingMusic-SVC.yml'),'cpu')
if __name__=='__main__': unittest.main()
