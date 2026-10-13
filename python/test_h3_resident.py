import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as N
from unittest.mock import patch
from h3_engine import condition_key,resource_budget,H3Engine
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
