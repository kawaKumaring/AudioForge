"""MiniMax H3 기본 말투 어댑터. 앱 내부 추론 라이브러리와 모델만, 서버·감정·다운로드 없음."""
import gc
import hashlib
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

def resource_budget():
    flags={'creationflags':0x08000000} if os.name=='nt' else {}
    proc=subprocess.run(['nvidia-smi','--query-gpu=memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],
                        capture_output=True,text=True,timeout=10,**flags)
    if proc.returncode:raise RuntimeError('H3 GPU 여유를 확인하지 못했습니다. CPU로 자동 대체하지 않습니다')
    used,free,util=[int(v.strip()) for v in proc.stdout.strip().splitlines()[0].split(',')]
    if free<6144:raise RuntimeError('H3는 GPU 여유 6GB 이상이 필요합니다. 다른 GPU 작업을 마친 뒤 다시 시도하세요')
    reserve=used/1024+1.5
    if reserve>10:raise RuntimeError('H3의 GPU 적재 공간이 부족합니다')
    return {'used_mib':used,'free_mib':free,'utilization_percent':util,'reserve_gib':reserve}

class H3Engine:
    name='minimax-h3'
    supported_languages=['ko']

    def __init__(self):
        self.run_seed=0;self.records=[];self._ready=False

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
        if emotion_id not in {None,'default'}:raise RuntimeError('MiniMax H3 감정 연출은 대사 손상 청취 판정으로 보류 중입니다')
        if float(speed)!=1:raise RuntimeError('현재 H3 생성은 기본 속도만 지원합니다')
        if not any('\uac00'<=c<='\ud7a3' for c in text):raise RuntimeError('현재 H3 카드 경로는 한국어 대사만 연결했습니다')
        chunks=split_text(text)
        if not ref_audio or not Path(ref_audio).is_file():raise RuntimeError('MiniMax H3에는 참조 목소리가 필요합니다')
        self.load()
        self.budget=resource_budget()
        self.mm.EXTRA_RESERVED_VRAM=self.budget['reserve_gib']*1024**3
        import torch
        import numpy as np
        import soundfile as sf
        ref,sr=sf.read(ref_audio,dtype='float32',always_2d=True)
        if not len(ref) or not np.isfinite(ref).all():raise RuntimeError('H3 참조 목소리가 비어 있거나 손상되었습니다')
        if len(ref)/sr>45:raise RuntimeError('H3 참조는 45초 이하로 준비하세요. 원본을 자동으로 잘라 대체하지 않습니다')
        reference_channels=ref.shape[1]
        if reference_channels==1:ref=np.repeat(ref,2,axis=1)
        elif reference_channels!=2:raise RuntimeError('H3 참조는 모노 또는 스테레오 음원이어야 합니다')
        audio={'waveform':torch.from_numpy(ref.T.copy())[None,:,:],'sample_rate':sr}
        clip=model=vae=None;conditions=[];waves=[];records=[];started=time.monotonic()
        try:
            with torch.inference_mode():
                clip=self.sd.load_clip([str(self.assets['encoder'])],embedding_directory=[],clip_type=self.sd.CLIPType.MINIMAX)
                state,metadata=self.utils.load_torch_file(str(self.assets['audio_vae']),return_metadata=True)
                vae=self.sd.VAE(sd=state,metadata=metadata);del state
                for chunk in chunks:
                    conditions.append(self.ops.reference_to_latent(clip=clip,prompt=prompt_for(chunk),width=256,height=256,
                        length=frame_count(chunk),audio_vae=vae,ref_audios={'ref_audio_0':audio}))
                self.mm.unload_all_models();clip=None;gc.collect();torch.cuda.empty_cache()
                model=self.sd.load_diffusion_model(str(self.assets['model']))
                model=self.ops.shift_model(model,12.,3.)[0]
                attention=self.attention.get_attention_function('comfy_kitchen_int8',None)
                if attention is None:attention=self.attention.get_attention_function('pytorch')
                model=model.clone();model.set_model_optimized_attention(attention)
                for index,(chunk,condition) in enumerate(zip(chunks,conditions)):
                    positive,latent=condition
                    negative=[]
                    for item in positive:
                        metadata=item[1].copy()
                        if 'pooled_output' in metadata:metadata['pooled_output']=torch.zeros_like(metadata['pooled_output'])
                        negative.append([torch.zeros_like(item[0]),metadata])
                    seed=(int(self.run_seed)+index) % (2**31-1)
                    image=self.sample.fix_empty_latent_channels(model,latent['samples'])
                    noise=self.sample.prepare_noise(image,seed)
                    samples=self.sample.sample(model,noise,16,1.,'res_multistep','simple',positive,negative,image,
                                               denoise=1.,disable_pbar=True,seed=seed)
                    result={**latent,'samples':samples}
                    decoded=self.ops.vae_decode_audio(vae,result)
                    wave=decoded['waveform'][0].float().cpu().numpy()
                    if not wave.size or not np.isfinite(wave).all():raise RuntimeError('H3 출력이 비어 있거나 손상되었습니다')
                    channel=int(np.argmax(np.mean(wave.astype('float64')**2,axis=1)))
                    mono=wave[channel].copy();waves.append(mono)
                    records.append({'index':index,'seed':seed,'sent_text':chunk,'sent_text_sha256':hashlib.sha256(chunk.encode()).hexdigest(),
                                    'frames':frame_count(chunk),'duration':len(mono)/decoded['sample_rate'],'mono_channel':channel})
                out=np.concatenate(waves);sf.write(output_path,out,decoded['sample_rate'],subtype='FLOAT')
            detail={'engine':self.name,'chunks':records,'reference_sha256':hashlib.sha256(Path(ref_audio).read_bytes()).hexdigest(),
                    'sample_rate':decoded['sample_rate'],'settings':{'steps':16,'cfg':1,'sampler':'res_multistep','canvas':256},
                    'emotion':'미적용·보류','seconds':time.monotonic()-started,'resource_budget':self.budget,
                    'reference_channels_in':reference_channels,
                    'processing':'기본 VAE 디코더 처리 후 앱 mono 계약에 맞춰 가장 큰 RMS 채널 유지. 추가 자르기·음량 정규화·속도 변경 없음.'}
            self.records.append(detail)
            Path(str(output_path)+'.h3.json').write_text(json.dumps(detail,ensure_ascii=False,indent=2),encoding='utf-8')
        finally:
            conditions.clear();clip=model=vae=None;self.mm.unload_all_models();gc.collect();torch.cuda.empty_cache()
