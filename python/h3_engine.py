"""MiniMax H3 기본 말투 어댑터. 앱 내부 추론 라이브러리와 모델만, 서버·감정·다운로드 없음."""
import gc
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

FILES={'model':'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
       'encoder':'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors','audio_vae':'minimax_h3_audio_vae_fp32.safetensors'}

def asset_paths(root=None):
    if root is None:
        import app_runtime
        root=Path(app_runtime.assets_root())
    root=Path(root);runtime=root/'h3_runtime';model=root/'h3_models'
    need=[runtime/'h3_ops.py',runtime/'manifest.json',*[model/name for name in FILES.values()]]
    missing=[p.name for p in need if not p.is_file()]
    if missing:raise RuntimeError('MiniMax H3 준비 파일이 없습니다. 자동 다운로드나 다른 엔진 대체는 하지 않습니다: '+', '.join(missing))
    manifest=json.loads((runtime/'manifest.json').read_text(encoding='utf-8'))
    if hashlib.sha256((runtime/'h3_ops.py').read_bytes()).hexdigest()!=manifest.get('ops_sha256'):
        raise RuntimeError('H3 추론 코드 지문이 다릅니다. 다시 준비하세요')
    for key,name in FILES.items():
        if (model/name).stat().st_size!=manifest['assets'][key]['size']:raise RuntimeError('H3 모델 크기가 기록과 다릅니다: '+name)
    return runtime,{key:model/name for key,name in FILES.items()}

def split_text(text,limit=170):
    if not text.strip():raise RuntimeError('H3에 읽을 대사가 없습니다')
    if any(tag in text for tag in ('<d>','</d>','<|','|>')):raise RuntimeError('대사에 H3 내부 제어 태그를 넣을 수 없습니다')
    if re.search(r'<#[0-9.]+#>|\((?:laughs|chuckle|breath|sighs)\)',text):
        raise RuntimeError('Speech API 전용 발성·쉼 태그는 H3 기본 말투 경로에서 지원하지 않습니다')
    chunks=[];rest=text
    while len(rest)>limit:
        candidates=[m.end() for m in re.finditer(r'(?<=[.!?。！？])\s+|\s+',rest) if m.end()<=limit]
        if not candidates:raise RuntimeError('H3 한 어절이 길이 예산을 넘습니다. 단어를 자르지 말고 띄어쓰기를 확인하세요')
        end=max(candidates);chunks.append(rest[:end]);rest=rest[end:]
    if rest:chunks.append(rest)
    assert ''.join(chunks)==text
    return chunks

def frame_count(text):
    seconds=max(5,len(text)/7+2)
    if seconds>30:raise RuntimeError('H3 한 구간의 시간 예산을 넘었습니다')
    frames=max(5,round(seconds*24));return frames+(5-frames)%17

def prompt_for(text):
    # 초기 기본 말투 시험과 같은 틀. 감정·기호 연출·Speech API 태그를 덧붙이지 않는다.
    return ('subject_definitions:\n<Subject 1> is a person who uses <Audio 1> as their speaking voice timbre reference.\n\n'
            'summary:\n[reference generation + audio reference] A character speaking warmly to a friend.\n\n'
            'retention_analysis:\n<Audio 1>: reference - its vocal timbre guides the vocal delivery of <Subject 1> without copying the original signal.\n\n'
            'detailed_description:\n[Shot 1] <Subject 1> says: <d>[Korean] '+text+'</d> their tone is calm and warm.\n\n'
            'overall_soundscape:\nclear speech in a quiet indoor room')

def resource_budget(reusable_mib=0):
    flags={'creationflags':0x08000000} if os.name=='nt' else {}
    proc=subprocess.run(['nvidia-smi','--query-gpu=memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],
                        capture_output=True,text=True,timeout=10,**flags)
    if proc.returncode:raise RuntimeError('H3 GPU 여유를 확인하지 못했습니다. CPU로 자동 대체하지 않습니다')
    used,free,util=[int(v.strip()) for v in proc.stdout.strip().splitlines()[0].split(',')]
    reusable_mib=max(0,min(used,int(reusable_mib)))
    if free+reusable_mib<6144:raise RuntimeError('H3는 GPU 여유 6GB 이상이 필요합니다. 다른 GPU 작업을 마친 뒤 다시 시도하세요')
    reserve=(used-reusable_mib)/1024+1.5
    if reserve>10:raise RuntimeError('H3의 GPU 적재 공간이 부족합니다')
    return {'used_mib':used,'free_mib':free,'own_reusable_mib':reusable_mib,'utilization_percent':util,'reserve_gib':reserve}

def _copy_condition(value):
    import torch
    if isinstance(value,torch.Tensor):return value.detach().cpu().clone()
    if getattr(value,'is_nested',False):return type(value)([_copy_condition(t) for t in value.unbind()])
    if isinstance(value,dict):return {k:_copy_condition(v) for k,v in value.items()}
    if isinstance(value,list):return [_copy_condition(v) for v in value]
    if isinstance(value,tuple):return tuple(_copy_condition(v) for v in value)
    return value

def _condition_bytes(value):
    import torch
    if isinstance(value,torch.Tensor):return value.numel()*value.element_size()
    if getattr(value,'is_nested',False):return sum(_condition_bytes(t) for t in value.unbind())
    if isinstance(value,dict):return sum(_condition_bytes(v) for v in value.values())
    if isinstance(value,(list,tuple)):return sum(_condition_bytes(v) for v in value)
    return 0

def diagnostic_settings(environ=None):
    env=os.environ if environ is None else environ
    canvas=env.get('AF_H3_DIAGNOSTIC_CANVAS','256')
    attention=env.get('AF_H3_DIAGNOSTIC_ATTENTION','auto')
    if (canvas!='256' or attention!='auto') and env.get('AF_H3_DIAGNOSTIC')!='1':
        raise RuntimeError('H3 비교 설정은 검수 모드를 명시해야 합니다')
    if canvas not in {'256','128','64'} or attention not in {'auto','pytorch'}:
        raise RuntimeError('지원하지 않는 H3 비교 설정입니다')
    return {'canvas':int(canvas),'attention_requested':attention,'diagnostic':env.get('AF_H3_DIAGNOSTIC')=='1'}

def select_attention(module,requested):
    if requested=='pytorch':
        fn=module.get_attention_function('pytorch',None)
        if fn is None:raise RuntimeError('요청한 H3 PyTorch 계산 방식이 없습니다')
        return fn,'pytorch'
    fn=module.get_attention_function('comfy_kitchen_int8',None)
    if fn is not None:return fn,'comfy_kitchen_int8'
    return module.get_attention_function('pytorch'),'pytorch'

def condition_key(chunks,ref_hash,assets,code_identity,profile=None):
    stamps=[(key,str(p.resolve()),p.stat().st_size,p.stat().st_mtime_ns) for key,p in sorted(assets.items())]
    return hashlib.sha256(json.dumps([[(prompt_for(c),frame_count(c)) for c in chunks],ref_hash,stamps,code_identity,
        {**(profile or diagnostic_settings({})),'reference_channels':'mono_duplicate_or_stereo'}],ensure_ascii=False).encode()).hexdigest()

class H3Engine:
    name='minimax-h3'
    supported_languages=['ko']

    def __init__(self):
        self.run_seed=0;self.records=[];self._ready=False
        self.keep_loaded=False;self._model=None;self._vae=None;self._cached=None;self.code_identity=''
        self.stop_file='';self.progress=None

    def release(self):
        self._cached=None;self._model=None;self._vae=None
        if self._ready:
            import torch
            self.mm.unload_all_models();gc.collect();torch.cuda.empty_cache()

    def _check_stop(self):
        if self.stop_file and Path(self.stop_file).exists():
            error=RuntimeError('H3 생성을 멈췄습니다');error.error_payload={'code':'H3_STOPPED'};raise error

    def begin_segment(self,base_seed):
        # 내부 분할까지 센다. 다음 문장의 씨앗이 앞 문장 마지막 조각과 겹치지 않는다.
        self.run_seed=(int(base_seed)+sum(len(r['chunks']) for r in self.records)) % (2**31-1)

    def public_records(self):
        # 원문은 private 기록에만. 공용 메타와 검수 헤더는 같은 표현을 사용한다.
        return [{**{k:v for k,v in r.items() if k != 'chunks'},
                 'chunks':[{k:v for k,v in c.items() if k != 'sent_text'} for c in r['chunks']]}
                for r in self.records]

    def load(self):
        if self._ready:return
        runtime,self.assets=asset_paths();self.budget=resource_budget()
        self.code_identity=hashlib.sha256((runtime/'h3_ops.py').read_bytes()).hexdigest()
        cache=runtime/'cache';cache.mkdir(exist_ok=True)
        os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',
                          USE_PYTORCH_KERNEL_CACHE='0',NUMBA_CACHE_DIR=str(cache))
        sys.path.insert(0,str(runtime))
        argv=sys.argv[:]
        try:
            sys.argv=[argv[0],'--fast','fp16_accumulation','--disable-pinned-memory','--disable-async-offload',
                      '--reserve-vram',str(self.budget['reserve_gib'])]
            import comfy.options
            comfy.options.enable_args_parsing()
            import comfy.sd
            import comfy.sample
            import comfy.utils
            import comfy.model_management
            import comfy.ldm.modules.attention
            import h3_ops
            if not Path(comfy.sd.__file__).resolve().is_relative_to(runtime.resolve()):
                raise RuntimeError('앱 밖의 H3 추론 코드가 먼저 로딩되었습니다. 이 작업을 다시 시작하세요')
            self.sd=comfy.sd;self.sample=comfy.sample;self.utils=comfy.utils
            self.mm=comfy.model_management;self.attention=comfy.ldm.modules.attention;self.ops=h3_ops
        finally:sys.argv=argv
        import torch
        if not torch.cuda.is_available():raise RuntimeError('MiniMax H3는 현재 GPU가 필요합니다')
        self._ready=True

    def synthesize_segment(self,text,ref_audio,emotion_id,speed,output_path):
        if os.environ.get('AF_H3_PIPE_ADDR') and not os.environ.get('AF_H3_SERVER'):
            from h3_resident_client import synthesize
            self.records.append(synthesize(text,ref_audio,emotion_id,speed,output_path,self.run_seed))
            return
        if emotion_id not in {None,'default'}:raise RuntimeError('MiniMax H3 감정 연출은 대사 손상 청취 판정으로 보류 중입니다')
        if float(speed)!=1:raise RuntimeError('현재 H3 생성은 기본 속도만 지원합니다')
        if not any('\uac00'<=c<='\ud7a3' for c in text):raise RuntimeError('현재 H3 카드 경로는 한국어 대사만 연결했습니다')
        profile=diagnostic_settings()
        chunks=split_text(text)
        if not ref_audio or not Path(ref_audio).is_file():raise RuntimeError('MiniMax H3에는 참조 목소리가 필요합니다')
        boot=time.monotonic();self.load();runtime_setup=time.monotonic()-boot
        import torch
        import numpy as np
        import soundfile as sf
        own=torch.cuda.memory_reserved()/1024**2 if self.keep_loaded and torch.cuda.is_available() else 0
        self.budget=resource_budget(own)
        self.mm.EXTRA_RESERVED_VRAM=self.budget['reserve_gib']*1024**3
        self._check_stop()
        ref_bytes=Path(ref_audio).read_bytes();ref_hash=hashlib.sha256(ref_bytes).hexdigest()
        key=condition_key(chunks,ref_hash,self.assets,self.code_identity,profile)
        ref,sr=sf.read(io.BytesIO(ref_bytes),dtype='float32',always_2d=True);del ref_bytes
        if not len(ref) or not np.isfinite(ref).all():raise RuntimeError('H3 참조 목소리가 비어 있거나 손상되었습니다')
        if len(ref)/sr>45:raise RuntimeError('H3 참조는 45초 이하로 준비하세요. 원본을 자동으로 잘라 대체하지 않습니다')
        reference_channels=ref.shape[1]
        if reference_channels==1:ref=np.repeat(ref,2,axis=1)
        elif reference_channels!=2:raise RuntimeError('H3 참조는 모노 또는 스테레오 음원이어야 합니다')
        audio={'waveform':torch.from_numpy(ref.T.copy())[None,:,:],'sample_rate':sr}
        clip=model=vae=None;conditions=[];waves=[];records=[];started=time.monotonic();stage='prepare';stamp=started;timings={}
        cache_hit=bool(self._cached and self._cached['key']==key)
        model_reused=bool(self._model is not None and cache_hit)
        def mark(name):
            nonlocal stage,stamp
            now=time.monotonic();timings[stage]=timings.get(stage,0)+now-stamp;stage=name;stamp=now
            self._check_stop()
        try:
            with torch.inference_mode():
                if cache_hit:
                    mark('condition_cache');conditions=_copy_condition(self._cached['conditions']);vae=self._vae;model=self._model
                    attention_selected=self._cached['attention_selected']
                else:
                    self.release();mark('text_encoder_load')
                    clip=self.sd.load_clip([str(self.assets['encoder'])],embedding_directory=[],clip_type=self.sd.CLIPType.MINIMAX)
                    mark('audio_vae_load')
                    state,metadata=self.utils.load_torch_file(str(self.assets['audio_vae']),return_metadata=True)
                    vae=self.sd.VAE(sd=state,metadata=metadata);del state
                    mark('reference_and_text_encode')
                    for chunk in chunks:
                        conditions.append(self.ops.reference_to_latent(clip=clip,prompt=prompt_for(chunk),width=profile['canvas'],height=profile['canvas'],
                            length=frame_count(chunk),audio_vae=vae,ref_audios={'ref_audio_0':audio}))
                    mark('release_encoder');self.mm.unload_all_models();clip=None;gc.collect();torch.cuda.empty_cache()
                    mark('diffusion_load')
                    model=self.sd.load_diffusion_model(str(self.assets['model']))
                    model=self.ops.shift_model(model,12.,3.)[0]
                    attention,attention_selected=select_attention(self.attention,profile['attention_requested'])
                    model=model.clone();model.set_model_optimized_attention(attention)
                    if self.keep_loaded and _condition_bytes(conditions)<=64*1024**2:
                        self._cached={'key':key,'conditions':_copy_condition(conditions),'attention_selected':attention_selected};self._model=model;self._vae=vae
                for index,(chunk,condition) in enumerate(zip(chunks,conditions)):
                    mark('sampling')
                    positive,latent=condition
                    negative=[]
                    for item in positive:
                        metadata=item[1].copy()
                        if metadata.get('pooled_output') is not None:metadata['pooled_output']=torch.zeros_like(metadata['pooled_output'])
                        negative.append([torch.zeros_like(item[0]),metadata])
                    seed=(int(self.run_seed)+index) % (2**31-1)
                    image=self.sample.fix_empty_latent_channels(model,latent['samples'])
                    noise=self.sample.prepare_noise(image,seed)
                    def callback(step,*args):
                        self._check_stop()
                        if self.progress:self.progress({'type':'progress','percent':25+int(55*(index+(step+1)/16)/len(chunks)),
                            'message':f'H3 생성 {index+1}/{len(chunks)} · {step+1}/16'})
                    samples=self.sample.sample(model,noise,16,1.,'res_multistep','simple',positive,negative,image,
                                               denoise=1.,disable_pbar=True,seed=seed,callback=callback)
                    result={**latent,'samples':samples}
                    mark('audio_decode')
                    decoded=self.ops.vae_decode_audio(vae,result)
                    wave=decoded['waveform'][0].float().cpu().numpy()
                    if not wave.size or not np.isfinite(wave).all():raise RuntimeError('H3 출력이 비어 있거나 손상되었습니다')
                    channel=int(np.argmax(np.mean(wave.astype('float64')**2,axis=1)))
                    mono=wave[channel].copy();waves.append(mono)
                    records.append({'index':index,'seed':seed,'sent_text':chunk,'sent_text_sha256':hashlib.sha256(chunk.encode()).hexdigest(),
                                    'frames':frame_count(chunk),'duration':len(mono)/decoded['sample_rate'],'mono_channel':channel})
                mark('save');out=np.concatenate(waves);sf.write(output_path,out,decoded['sample_rate'],subtype='FLOAT')
            mark('complete')
            detail={'engine':self.name,'chunks':records,'reference_sha256':ref_hash,
                    'sample_rate':decoded['sample_rate'],'settings':{'steps':16,'cfg':1,'sampler':'res_multistep',**profile,'attention_selected':attention_selected},
                    'emotion':'미적용·보류','seconds':time.monotonic()-started,'resource_budget':self.budget,
                    'reference_channels_in':reference_channels,
                    'stage_seconds':timings,'condition_cache_hit':cache_hit,'model_reused':model_reused,
                    'runtime_setup_seconds':runtime_setup,
                    'processing':'기본 VAE 디코더 처리 후 앱 mono 계약에 맞춰 가장 큰 RMS 채널 유지. 추가 자르기·음량 정규화·속도 변경 없음.'}
            self.records.append(detail)
            Path(str(output_path)+'.h3.json').write_text(json.dumps(detail,ensure_ascii=False,indent=2),encoding='utf-8')
        except Exception as exc:
            self.release()
            if getattr(exc,'error_payload',{}).get('code')=='H3_STOPPED':raise
            error=RuntimeError(f'H3 {stage} 실패: {type(exc).__name__}: {exc}')
            error.error_payload={'code':'H3_GENERATION_FAILED'}
            raise error from exc
        finally:
            conditions.clear();clip=model=vae=None
            if not self.keep_loaded or self._cached is None:self.release()
