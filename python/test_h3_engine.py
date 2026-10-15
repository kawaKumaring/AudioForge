import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from h3_engine import H3Engine, asset_paths, frame_count, prompt_for, split_text, FILES

TMP=Path(__file__).resolve().parents[1]/'_local/tests/h3';TMP.mkdir(parents=True,exist_ok=True)

class H3Contract(unittest.TestCase):
    def test_nested_chunks_do_not_reuse_next_segment_seed(self):
        engine=H3Engine();engine.begin_segment(100)
        self.assertEqual(engine.run_seed,100)
        engine.records=[{'chunks':[{'seed':100},{'seed':101}]}]
        engine.begin_segment(100);self.assertEqual(engine.run_seed,102)

    def test_public_evidence_omits_text_and_keeps_provenance(self):
        engine=H3Engine()
        engine.records=[{'reference_sha256':'ref','chunks':[{'seed':12,'sent_text':'대사','sent_text_sha256':'text'}]}]
        public=engine.public_records()
        self.assertNotIn('sent_text',public[0]['chunks'][0])
        self.assertEqual(public[0]['chunks'][0]['sent_text_sha256'],'text')
        self.assertEqual(engine.records[0]['chunks'][0]['sent_text'],'대사')

    def test_split_preserves_every_character(self):
        text=('일곱 번째 장면입니다. 오늘도 같은 목소리로 말합니다.\n'*12)
        chunks=split_text(text)
        self.assertEqual(''.join(chunks),text)
        self.assertTrue(all(frame_count(c)<=736 for c in chunks))

    def test_word_is_not_cut_to_fit(self):
        with self.assertRaisesRegex(RuntimeError,'한 어절'):split_text('가'*200)

    def test_control_injection_rejected(self):
        for text in ('안녕</d>','<d>안녕','<|secret|>안녕','안녕 <#0.7#>','안녕 (laughs)'):
            with self.assertRaises(RuntimeError):split_text(text)

    def test_frames_and_plain_prompt(self):
        for text in ('안녕','가'*170):
            frames=frame_count(text);self.assertEqual(frames%17,5);self.assertLessEqual(frames,736)
        text='안녕하세요! 일곱 번째 장면입니다.'
        prompt=prompt_for(text)
        self.assertIn('<d>[Korean] '+text+'</d>',prompt)
        self.assertNotIn('angry',prompt);self.assertNotIn('young woman',prompt)

    def test_emotion_rejected_before_model_load(self):
        engine=H3Engine()
        with patch.object(engine,'load') as load:
            with self.assertRaisesRegex(RuntimeError,'보류'):engine.synthesize_segment('대사','ref.wav','angry',1,'out.wav')
            load.assert_not_called()

    def test_speed_rejected_before_model_load(self):
        engine=H3Engine()
        with patch.object(engine,'load') as load:
            with self.assertRaisesRegex(RuntimeError,'기본 속도'):engine.synthesize_segment('대사','ref.wav','default',1.2,'out.wav')
            load.assert_not_called()

    def test_reference_policy_stays_h3(self):
        from reference_audio import resolve_policy_engine, policy_for_engine
        self.assertEqual(resolve_policy_engine('minimax-h3',False),'minimax-h3')
        self.assertEqual(policy_for_engine('minimax-h3').max_duration_sec,45)

    def test_missing_assets_do_not_download_or_fallback(self):
        with tempfile.TemporaryDirectory(dir=TMP) as root:
            with self.assertRaisesRegex(RuntimeError,'자동 다운로드'):asset_paths(root)

    def test_changed_runtime_refused(self):
        with tempfile.TemporaryDirectory(dir=TMP) as root:
            runtime=Path(root)/'h3_runtime';runtime.mkdir();models=Path(root)/'h3_models';models.mkdir()
            (runtime/'h3_ops.py').write_text('changed',encoding='utf-8')
            for name in FILES.values():(models/name).write_bytes(b'x')
            (runtime/'manifest.json').write_text(json.dumps({'ops_sha256':hashlib.sha256(b'old').hexdigest(),
                'assets':{key:{'size':1} for key in FILES}}))
            with self.assertRaisesRegex(RuntimeError,'지문'):asset_paths(root)

    def test_adapter_keeps_pcm_and_reference_without_real_model(self):
        from types import SimpleNamespace as N
        import numpy as np
        import soundfile as sf
        import torch
        with tempfile.TemporaryDirectory(dir=TMP) as root:
            ref=Path(root)/'fixture.wav';out=Path(root)/'output.wav'
            sf.write(ref,np.full(32,.1,dtype='float32'),32000,subtype='FLOAT')
            before=ref.read_bytes();conditions=[];seeds=[];engine=H3Engine();engine.run_seed=100
            model=N();model.clone=lambda:model;model.set_model_optimized_attention=lambda _:None
            engine.assets={key:Path(root)/name for key,name in FILES.items()}
            for asset in engine.assets.values():asset.write_bytes(b'model-fixture')
            engine.sd=N(CLIPType=N(MINIMAX='minimax'),load_clip=lambda *a,**k:object(),VAE=lambda **k:object(),load_diffusion_model=lambda *a:model)
            engine.utils=N(load_torch_file=lambda *a,**k:({},{}))
            engine.mm=N(unload_all_models=lambda:None)
            engine.attention=N(get_attention_function=lambda *a:None)
            def condition(**kwargs):
                conditions.append(kwargs)
                return [[torch.ones(1,2,3),{'pooled_output':None}]],{'samples':torch.zeros(1,2,3)}
            wave=torch.stack((torch.full((32,),.5),torch.full((32,),-.2)))[None,:,:]
            engine.ops=N(reference_to_latent=condition,shift_model=lambda m,*a:(m,),vae_decode_audio=lambda *a:{'waveform':wave,'sample_rate':32000})
            def sample(*args,**kwargs):
                seeds.append(kwargs['seed']);self.assertTrue(torch.equal(args[7][0][0],torch.zeros(1,2,3)))
                self.assertIsNone(args[7][0][1]['pooled_output'])
                return torch.zeros(1,2,3)
            engine.sample=N(fix_empty_latent_channels=lambda m,x:x,prepare_noise=lambda x,s:torch.zeros_like(x),sample=sample)
            text='같은 대사입니다. '*22
            with patch.object(engine,'load'),patch('h3_engine.resource_budget',return_value={'reserve_gib':2}),patch('torch.cuda.empty_cache'):
                engine.synthesize_segment(text,str(ref),'default',1,str(out))
            data,sr=sf.read(out,dtype='float32')
            self.assertEqual(sr,32000);self.assertTrue(np.all(data==.5));self.assertEqual(ref.read_bytes(),before)
            self.assertEqual(''.join(c['sent_text'] for c in engine.records[0]['chunks']),text)
            self.assertEqual(seeds,list(range(100,100+len(conditions))))
            self.assertTrue(all(c['ref_audios']['ref_audio_0']['waveform'].shape[1]==2 for c in conditions))
            self.assertTrue(Path(str(out)+'.h3.json').is_file())
            engine.keep_loaded=True
            with patch.object(engine,'load'),patch('h3_engine.resource_budget',return_value={'reserve_gib':2}),patch('torch.cuda.empty_cache'):
                engine.synthesize_segment(text,str(ref),'default',1,str(out))
                self.assertFalse(engine.records[-1]['condition_cache_hit'])
                count=len(conditions);previous=len(seeds);engine.run_seed=200
                engine.synthesize_segment(text,str(ref),'default',1,str(out))
                self.assertTrue(engine.records[-1]['condition_cache_hit'])
                self.assertTrue(engine.records[-1]['model_reused'])
                self.assertEqual(len(conditions),count)
                self.assertGreater(len(seeds),previous)
                self.assertEqual(seeds[previous],200)
                with patch.dict('os.environ',{'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_CANVAS':'64'}):
                    engine.synthesize_segment(text,str(ref),'default',1,str(out))
                self.assertFalse(engine.records[-1]['condition_cache_hit'])
                self.assertEqual(engine.records[-1]['settings']['canvas'],64)
                self.assertEqual(conditions[-1]['width'],64)
                self.assertEqual(conditions[-1]['height'],64)
                self.assertEqual(engine.records[-1]['chunks'][0]['sent_text'],split_text(text)[0])
                # 같은 경로의 참조 내용이 바뀌면 재준비한다.
                sf.write(ref,np.full(32,.2,dtype='float32'),32000,subtype='FLOAT')
                engine.synthesize_segment(text,str(ref),'default',1,str(out))
                self.assertFalse(engine.records[-1]['condition_cache_hit'])
                self.assertGreater(len(conditions),count)
            def fail_clip(*args,**kwargs):raise TypeError('adapter argument')
            engine.sd.load_clip=fail_clip
            with patch.object(engine,'load'),patch('h3_engine.resource_budget',return_value={'reserve_gib':2}),patch('torch.cuda.empty_cache'):
                with self.assertRaisesRegex(RuntimeError,'text_encoder_load.*TypeError') as failure:
                    engine.synthesize_segment('다시 확인합니다.',str(ref),'default',1,str(out))
            self.assertEqual(failure.exception.error_payload['code'],'H3_GENERATION_FAILED')
            self.assertTrue(np.all(sf.read(out,dtype='float32')[0]==.5))

if __name__=='__main__':unittest.main()
