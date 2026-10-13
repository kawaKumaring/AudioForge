import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import patch
from h3_engine import condition_key,resource_budget,H3Engine,diagnostic_settings,select_attention
from h3_voice_server import run_request
from _test_root import test_dir

class H3Resident(unittest.TestCase):
    def test_condition_key_covers_text_reference_model_and_code(self):
        with tempfile.TemporaryDirectory(dir=test_dir('temp','h3-resident')) as d:
            p=Path(d)/'model';p.write_bytes(b'a');assets={'model':p}
            key=condition_key(['같은 대사'],'ref',assets,'code')
            self.assertEqual(key,condition_key(['같은 대사'],'ref',assets,'code'))
            for text,ref,code in [(['다른 대사'],'ref','code'),(['같은 대사'],'changed','code'),(['같은 대사'],'ref','new-code')]:
                self.assertNotEqual(key,condition_key(text,ref,assets,code))
            p.write_bytes(b'changed')
            self.assertNotEqual(key,condition_key(['같은 대사'],'ref',assets,'code'))

    def test_diagnostic_defaults_and_explicit_gate(self):
        self.assertEqual(diagnostic_settings({}),{'canvas':256,'attention_requested':'auto','diagnostic':False})
        for value in ['128','64','32']:
            with self.assertRaises(RuntimeError):diagnostic_settings({'AF_H3_DIAGNOSTIC_CANVAS':value})
            self.assertEqual(diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_CANVAS':value})['canvas'],int(value))
        for value in ['16','0','256.0','garbage']:
            with self.assertRaises(RuntimeError):diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_CANVAS':value})
        with self.assertRaises(RuntimeError):diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_ATTENTION':'sage'})

    def test_canvas_and_attention_do_not_share_condition_cache(self):
        with tempfile.TemporaryDirectory(dir=test_dir('temp','h3-profile')) as d:
            p=Path(d)/'model';p.write_bytes(b'a')
            profiles=[diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_CANVAS':str(n)}) for n in [256,128,64]]
            profiles.append(diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_ATTENTION':'pytorch'}))
            self.assertEqual(len({condition_key(['대사'],'ref',{'model':p},'code',r) for r in profiles}),4)

    def test_attention_requested_and_selected_are_separate(self):
        native=object();fallback=object()
        module=N(get_attention_function=lambda name,*a: native if name=='comfy_kitchen_int8' else fallback)
        self.assertEqual(select_attention(module,'auto'),(native,'comfy_kitchen_int8'))
        self.assertEqual(select_attention(module,'pytorch'),(fallback,'pytorch'))
        module=N(get_attention_function=lambda name,*a: fallback if name=='pytorch' else None)
        self.assertEqual(select_attention(module,'auto'),(fallback,'pytorch'))
        with self.assertRaises(RuntimeError):select_attention(N(get_attention_function=lambda *a:None),'pytorch')

    def test_comparison_plan_keeps_seed_text_and_quality(self):
        import runpy
        module=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts'/'compare-h3-profiles.py'))
        variants=module['plan'](2024)
        self.assertEqual([v['canvas'] for v in variants],[32])
        self.assertEqual(len({v['text'] for v in variants}),1)
        self.assertTrue(all(v['seed']==2024 and v['steps']==16 and v['cfg']==1 and v['sampler']=='res_multistep' for v in variants))
        self.assertEqual([v['attention_requested'] for v in variants],['auto'])

    def test_plan_does_not_read_reference_or_start_engine(self):
        import runpy
        module=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts'/'compare-h3-profiles.py'))
        with patch('sys.argv',['compare','--reference','missing.wav']),patch('builtins.print') as output,patch('pathlib.Path.read_bytes',side_effect=AssertionError('원본 읽기 금지')):
            module['main']()
        self.assertIn('계획만',output.call_args.args[0])
        with patch('sys.argv',['compare','--execute']),patch('sys.stderr'):
            with self.assertRaises(SystemExit) as error:module['main']()
        self.assertEqual(error.exception.code,2)

    def test_owned_memory_is_not_counted_as_foreign_gpu_work(self):
        with patch('h3_engine.subprocess.run',return_value=N(returncode=0,stdout='14500, 1000, 40')):
            with self.assertRaises(RuntimeError):resource_budget()
            r=resource_budget(10000)
            self.assertAlmostEqual(r['reserve_gib'],4500/1024+1.5)
            self.assertEqual(r['own_reusable_mib'],10000)

    def test_stop_does_not_generate_or_save(self):
        with tempfile.TemporaryDirectory(dir=test_dir('temp','h3-resident')) as d:
            stop=Path(d)/'stop';stop.touch();engine=H3Engine();engine.stop_file=str(stop)
            with self.assertRaises(RuntimeError) as e:engine._check_stop()
            self.assertEqual(e.exception.error_payload['code'],'H3_STOPPED')

    def test_request_resets_only_records_and_preserves_engine_cache(self):
        engine=N(records=[{'old':True}],cached='condition')
        def say(*args):engine.records.append({'seed':engine.run_seed,'cache':engine.cached})
        engine.synthesize_segment=say
        reply=run_request(engine,{'seed':123,'text':'대사','ref':'A','out':'out','speed':1},lambda _:None)
        self.assertTrue(reply['ok']);self.assertEqual(reply['record'],{'seed':123,'cache':'condition'})
        self.assertEqual(engine.stop_file,'');self.assertIsNone(engine.progress)

    def test_failed_request_preserves_structured_reason(self):
        engine=N(records=[])
        def fail(*args):
            e=RuntimeError('stopped');e.error_payload={'code':'H3_STOPPED'};raise e
        engine.synthesize_segment=fail
        reply=run_request(engine,{'seed':123,'text':'대사','ref':'A','out':'out','speed':1},lambda _:None)
        self.assertFalse(reply['ok']);self.assertTrue(reply['stopped'])
        self.assertIsNone(engine.progress)

if __name__=='__main__':unittest.main()
