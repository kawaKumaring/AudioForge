"""문맥 유지 요청의 실제 Python 연결. 모델만 대역, 음원 조립/확정은 실제."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # noqa: E401,E702 — 내장 파이썬은 스크립트 폴더를 경로에 넣지 않는다
import _test_temp  # noqa: F401,E402  ★맨 앞 — 검사 임시 자리를 C 드라이브 밖으로(단독 실행 포함)
import json
import os
from unittest import mock
from _local_isolation import setUpModule, tearDownModule
from test_qwen_engine import AtomicFinalReplaceTest
import tts_worker

class ContextPipelineTest(AtomicFinalReplaceTest):
    def job(self, mode='context', kinds=None, rows=None):
        import speaker_refs
        rows=rows or [('default','안녕',None),('default','반가워',None)]
        table=speaker_refs.ReferenceTable(default_ref=self.ref)
        table.freeze_routing(rows)
        with mock.patch.object(tts_worker,'_icl_transcribe_fn',return_value=lambda p:{'segments':[]}):
            return tts_worker._synthesize_qwen_job(rows,{'default':self.ref},{},self.out,1,.5,
                boundary_gaps=[0,.5],boundary_kinds=kinds or ['internal','line'],
                reference_conditioning_mode='safe_xvector',ref_table=table,line_mode=mode)

    def test_context_is_one_segment_and_reports_unaligned_pauses(self):
        seen=[]
        original=tts_worker.QwenTTSEngine.run_job
        def capture(engine,segments,device,**kw):
            seen.extend(segments)
            return original(engine,segments,device,**kw)
        with mock.patch.object(tts_worker.QwenTTSEngine,'run_job',new=capture):
            final,info=self.job()
        self.assertEqual(len(seen),1)
        self.assertEqual(seen[0]['text'],'안녕 반가워')
        self.assertTrue(os.path.exists(final))
        self.assertEqual(info['line_generation_mode'],'context')
        self.assertEqual(info['context_pause_boundaries'][0]['status'],'TEXT_MISMATCH')
        self.assertEqual(len(info['context_source_segments']),2)
        meta=tts_worker._build_tts_metadata(**info)
        self.assertEqual(meta['context_pause_boundaries'],info['context_pause_boundaries'])

    def test_default_path_keeps_two_segments(self):
        seen=[]; original=tts_worker.QwenTTSEngine.run_job
        def capture(engine,segments,device,**kw):
            seen.extend(segments); return original(engine,segments,device,**kw)
        with mock.patch.object(tts_worker.QwenTTSEngine,'run_job',new=capture):
            final,info=self.job('separate')
        self.assertEqual([s['text'] for s in seen],['안녕','반가워'])
        self.assertEqual(info['line_generation_mode'],'separate')

    def test_explicit_pause_is_not_silently_removed(self):
        marker=self._preexisting_final()
        with mock.patch.object(tts_worker.QwenTTSEngine,'run_job') as generate:
            with self.assertRaises(ValueError): self.job(kinds=['internal','explicitPause'])
            generate.assert_not_called()
        with open(self.final,'rb') as f:
            self.assertEqual(f.read(),marker)

    def test_other_engines_reject_context_before_generation(self):
        with mock.patch.object(tts_worker,'_run_record_begin') as begin:
            with self.assertRaises(RuntimeError):
                tts_worker.synthesize('', '안녕', self.out, preferred_engine='piper',line_mode='context')
            begin.assert_not_called()

    def test_existing_bridge_token_budget_still_splits_context(self):
        import qwen_bridge
        text='첫 번째 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.'
        with mock.patch.dict(os.environ,{},clear=True), mock.patch.object(qwen_bridge,'_prod_tokens',side_effect=lambda b,p,t:len(t)):
            plan=qwen_bridge._build_chunk_plan([{'index':0,'text':text}],None,None,20)
        self.assertGreater(len(plan),1)
        self.assertEqual(''.join(p['text'] for p in plan),text)
        self.assertTrue(all(len(p['text'])<=20 for p in plan))
