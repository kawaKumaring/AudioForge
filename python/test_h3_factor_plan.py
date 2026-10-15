import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

class FactorPlan(unittest.TestCase):
    def setUp(self):
        scripts=Path(__file__).resolve().parents[1]/'scripts'
        self.module=runpy.run_path(str(scripts/'reproduce-h3-baseline.py'))
        self.legacy=runpy.run_path(str(scripts/'probe-h3-speech.py'))

    def test_only_declared_generation_input_changes(self):
        base=self.module['make_plan'](self.legacy)
        for factor,field in [('prompt','prompt'),('duration','frames'),('seed','seed')]:
            plan=self.module['make_plan'](self.legacy,factor)
            changed={k for k in base if plan[k]!=base[k]}-{'factor','label'}
            self.assertEqual(changed,{field})
            self.assertIn('<d>[Korean] '+base['text']+'</d>',plan['prompt'])

    def test_default_is_unchanged_initial_baseline(self):
        plan=self.module['make_plan'](self.legacy)
        self.assertEqual(plan['prompt'],self.legacy['PROMPT'])
        self.assertEqual((plan['seed'],plan['frames'],plan['canvas']),(2024,243,256))

    def test_plan_mode_does_not_read_voice(self):
        with patch('sys.argv',['compare','--factor','duration']),patch('builtins.print') as output,patch('pathlib.Path.read_bytes',side_effect=AssertionError('음원 읽기 금지')):
            self.module['main']()
        self.assertIn('311',output.call_args.args[0])

    def test_execute_requires_reference_permission(self):
        with patch('sys.argv',['compare','--execute','--factor','seed']),patch('sys.stderr'):
            with self.assertRaises(SystemExit) as exc:self.module['main']()
        self.assertEqual(exc.exception.code,2)

if __name__=='__main__':unittest.main()
