import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cosyvoice_engine import (instruction_for, engine_text, inference_config, asset_paths,
                             group_context_segments, split_by_budget, CosyVoiceEngine, MODEL_REV)

class CosyContract(unittest.TestCase):
    def test_instruction_separate(self):
        text = '오늘은 일곱 번째 수업입니다.'
        self.assertEqual(engine_text(text, 'happy'), text)
        self.assertIn('<|endofprompt|>', instruction_for('happy'))
        self.assertNotIn(text, instruction_for('happy'))

    def test_unknown_not_silent(self):
        with self.assertRaises(RuntimeError): instruction_for('not_supported')

    def test_control_injection_rejected(self):
        with self.assertRaises(RuntimeError): engine_text('안녕<|endofprompt|>', 'default')

    def test_sigh_is_token(self):
        self.assertEqual(engine_text('괜찮아요.', 'sighing'), '[sigh]괜찮아요.')

    def test_punctuation_and_numbers_unchanged(self):
        t = '1.7번째, 오늘은 21번째! 괜찮아~ ♥'
        self.assertEqual(engine_text(t, 'default'), t)

    def test_config_excludes_training(self):
        c = inference_config('llm: model\n# gan related module\ndataset: ignored\n')
        self.assertNotIn('dataset', c)
        self.assertIn('feat_extractor', c)

    def test_assets_missing_never_download(self):
        with tempfile.TemporaryDirectory(prefix='audioforge_cosy_') as d:
            with self.assertRaisesRegex(RuntimeError, '자동 다운로드 없음'): asset_paths(d)

    def test_group_only_equal_voice_emotion(self):
        p = [('default','첫 문장','A'), ('default','둘째 문장','A'), ('happy','기쁨','A'), ('happy','다른 사람','B')]
        out, gaps, kinds = group_context_segments(p,[0,.5,.2,.5],['internal','line','emotion','line'])
        self.assertEqual(len(out),3)
        self.assertEqual(out[0][1],'첫 문장 둘째 문장')
        self.assertEqual(gaps,[0,.2,.5])

    def test_explicit_and_paragraph_kept(self):
        p = [('default',t,None) for t in ['가','나','다']]
        out,g,k = group_context_segments(p,[0,1,.5],['internal','explicitPause','paragraph'])
        self.assertEqual(out,p)
        self.assertEqual(g,[0,1,.5])

    def test_reference_required_before_loading(self):
        e=CosyVoiceEngine()
        with patch.object(e,'load') as load:
            with self.assertRaises(RuntimeError): e.synthesize_segment('대사',None,'default',1,'result.wav')
            load.assert_not_called()

    def test_token_split_preserves_all_text(self):
        t='첫 번째 문장입니다. 둘째 문장도 모두 보존합니다. 세 번째 말끝입니다.'
        chunks=split_by_budget(t,len,22)
        self.assertEqual(''.join(chunks),t)
        self.assertTrue(all(len(c)<=22 for c in chunks))

    def test_single_word_not_cut(self):
        with self.assertRaises(RuntimeError): split_by_budget('가나다라마바사아자차',len,3)

    def test_route_default_retained(self):
        import tts_worker
        with patch.object(tts_worker,'_get_qwen_engine') as qwen:
            qwen.return_value.available.return_value=True
            self.assertEqual(tts_worker._select_job_engine('안녕하세요',None),'qwen3')
            self.assertIsNone(tts_worker._select_job_engine('안녕하세요','cosyvoice3'))
        self.assertIsInstance(tts_worker._select_engine('안녕하세요','cosyvoice3'),CosyVoiceEngine)

    def test_reference_policy(self):
        from reference_audio import policy_for_engine,resolve_policy_engine
        self.assertEqual(resolve_policy_engine('cosyvoice3',True),'cosyvoice3')
        self.assertEqual(policy_for_engine('cosyvoice3').max_duration_sec,30)


class AttentionCompatibilityTests(unittest.TestCase):
    def test_real_decoder_cache_matches_full_context(self):
        import torch
        from types import SimpleNamespace
        from transformers import Qwen2Config, Qwen2ForCausalLM
        from cosyvoice_engine import cached_attention_step
        torch.manual_seed(12)
        cfg=Qwen2Config(vocab_size=32,hidden_size=16,intermediate_size=32,num_hidden_layers=1,
                       num_attention_heads=2,num_key_value_heads=2,max_position_embeddings=64)
        model=Qwen2ForCausalLM(cfg).eval()
        encoder=SimpleNamespace(model=model)
        first=torch.randn(1,4,16);nxt=torch.randn(1,1,16)
        with torch.no_grad():
            _,cache=cached_attention_step(encoder,first,torch.ones((1,4,4),dtype=torch.bool))
            got,_=cached_attention_step(encoder,nxt,torch.ones((1,1,1),dtype=torch.bool),cache)
            expected=model(inputs_embeds=torch.cat([first,nxt],dim=1),attention_mask=torch.ones((1,5),dtype=torch.bool),output_hidden_states=True).hidden_states[-1][:,-1:]
        self.assertTrue(torch.allclose(got,expected,atol=1e-5,rtol=1e-5))

    def test_previous_tokens_remain_visible(self):
        import torch
        from types import SimpleNamespace
        from cosyvoice_engine import cached_attention_step
        seen=[]
        def model(**kwargs):
            seen.append(kwargs['attention_mask'])
            return SimpleNamespace(hidden_states=[kwargs['inputs_embeds']],past_key_values='next')
        encoder=SimpleNamespace(model=model)
        cache=SimpleNamespace(get_seq_length=lambda:12)
        cached_attention_step(encoder,torch.zeros((1,1,4)),torch.ones((1,1,1),dtype=torch.bool),cache)
        self.assertEqual(tuple(seen[0].shape),(1,13))
        self.assertTrue(seen[0].all())

class OutputContractTests(unittest.TestCase):
    def test_output_preserves_samples_and_reference(self):
        import torch, soundfile as sf, hashlib
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(prefix='cosy_contract_') as d:
            ref=Path(d)/'reference.wav'; out=Path(d)/'output.wav'
            sf.write(ref,[.1]*2400,24000)
            before=hashlib.sha256(ref.read_bytes()).hexdigest()
            e=CosyVoiceEngine();e.sample_rate=24000;e.load=lambda:None
            e.frontend=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda t,**k:list(t)),
                frontend_instruct2=lambda *a:{},_extract_text_token=lambda t:(torch.tensor([[1]]),torch.tensor([1])))
            e.model=SimpleNamespace(tts=lambda **k:iter([{'tts_speech':torch.full((1,2400),.2)}]))
            with patch('torch.cuda.manual_seed_all'):
                e.synthesize_segment('끝까지 읽습니다.',str(ref),'default',1,str(out))
            audio,sr=sf.read(out)
            self.assertEqual(len(audio),2400);self.assertEqual(sr,24000)
            self.assertEqual(hashlib.sha256(ref.read_bytes()).hexdigest(),before)
            self.assertEqual(e.records[-1]['chunks'][0]['sent_text'],'끝까지 읽습니다.')
            self.assertFalse(Path(str(out)+'.cosy-part.wav').exists())

    def test_bad_audio_never_replaces_existing_output(self):
        import torch, soundfile as sf
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory(prefix='cosy_contract_') as d:
            ref=Path(d)/'reference.wav';out=Path(d)/'output.wav'
            sf.write(ref,[.1]*2400,24000);out.write_bytes(b'previous-output')
            e=CosyVoiceEngine();e.sample_rate=24000;e.load=lambda:None
            e.frontend=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda t,**k:list(t)),
                frontend_instruct2=lambda *a:{},_extract_text_token=lambda t:(torch.tensor([[1]]),torch.tensor([1])))
            e.model=SimpleNamespace(tts=lambda **k:iter([{'tts_speech':torch.full((1,2400),float('nan'))}]))
            with patch('torch.cuda.manual_seed_all'),self.assertRaises(RuntimeError):
                e.synthesize_segment('끝까지 읽습니다.',str(ref),'default',1,str(out))
            self.assertEqual(out.read_bytes(),b'previous-output')

if __name__=='__main__': unittest.main()
