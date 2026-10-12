"""흡수 전 최소 시험: 설치 코드 직접 호출, 서버·영상 저장·다운로드 없음."""
import argparse
import ctypes
import gc
import hashlib
import html
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time

COMFY=Path(r'E:\AI\ComfyUI_windows_portable_python3.12\ComfyUI')
BASE=Path(r'E:\AI_Project\claudeCodeVsCode\apps\master\AudioForge\_local\테스트\결과')
REFERENCE=BASE/'cosyvoice3-scenes-fixed-20261012/참조/A.wav'
REFERENCE_SHA='ace9ac3bb65798a729b65d2a768e67e73cb10c832b033dff3804445b18b1a10e'
MODEL='minimax-h3/minimax_h3_ref2va_pruned_int8_convrot.safetensors'
ENCODER='minimax-h3/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
VAE='minimax-h3/minimax_h3_audio_vae_fp32.safetensors'
LINE='오늘은 하루 종일 비가 와서 조금 우울했는데, 저녁에 친구가 찾아와서 따뜻한 차를 마시며 이야기를 나누니까 기분이 정말 좋아졌어요.'
LONG_LINE=(LINE+' 창문 밖으로 떨어지는 빗방울을 바라보면서, 그동안 혼자 마음에 담아 두었던 걱정도 조금씩 꺼내 놓았어요.'
           ' 친구는 서두르지 않고 제 이야기를 끝까지 들어 주었고, 저는 오랜만에 마음이 가벼워지는 걸 느꼈어요.'
           ' 비가 그치면 함께 산책하기로 했어요. 이제 편안한 마음으로 내일을 기다리려고 해요.')
PROMPT=('subject_definitions:\n<Subject 1> is a young woman who uses <Audio 1> as her speaking voice timbre reference.\n\n'
        'summary:\n[reference generation + audio reference] A character speaking warmly to a friend.\n\n'
        'retention_analysis:\n<Audio 1>: reference - its vocal timbre guides the vocal delivery of <Subject 1> without copying the original signal.\n\n'
        'detailed_description:\n[Shot 1] <Subject 1> says: <d>[Korean] '+LINE+'</d> her tone is calm and warm.\n\n'
        'overall_soundscape:\nher clear voice in a quiet indoor room')

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def gpu_snapshot():
    r=subprocess.run(['nvidia-smi','--query-gpu=memory.free,memory.used,utilization.gpu',
                      '--format=csv,noheader,nounits'],capture_output=True,text=True,check=True)
    values=[int(x.strip()) for x in r.stdout.strip().splitlines()[0].split(',')]
    return dict(zip(('free_mib','used_mib','utilization_percent'),values))

def ram_snapshot():
    class MemoryStatus(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(n,ctypes.c_ulonglong) for n in
            ('total_phys','avail_phys','total_page','avail_page','total_virtual','avail_virtual','extended')]
    status=MemoryStatus();status.length=ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError('시스템 메모리 확인 실패')
    return {'available_mib':status.avail_phys//1024**2,'total_mib':status.total_phys//1024**2}

def assets():
    files=[COMFY/'models/diffusion_models'/MODEL,COMFY/'models/text_encoders'/ENCODER,
           COMFY/'models/vae'/VAE]
    return [{'path':str(p),'bytes':p.stat().st_size} for p in files]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--minimum-free-mib',type=int,default=6144)
    parser.add_argument('--seconds',type=float,default=10)
    parser.add_argument('--runs',type=int,default=3)
    parser.add_argument('--longform',action='store_true')
    parser.add_argument('--acting-deck',action='store_true')
    parser.add_argument('--acting-segments',action='store_true')
    parser.add_argument('--reserve-vram-gib',type=float)
    args=parser.parse_args()
    if not 5<=args.seconds<=60 or not 1<=args.runs<=3:raise ValueError('시험 길이·횟수 범위 밖')
    frames=max(5,round(args.seconds*24));frames+=(5-frames)%17
    line=LONG_LINE if args.longform else LINE
    prompt=PROMPT.replace(LINE,line,1)
    acting=[]
    if args.acting_deck or args.acting_segments:
        line=LONG_LINE
        # 정확한 원문 위치로 나눠 공백·문장부호도 보존한다.
        points=[line.index('저녁에'),line.index(' 창문'),line.index('그동안'),line.index(' 친구는'),
                line.index('저는 오랜만에'),line.index(' 비가 그치면'),line.index(' 이제 편안한')]
        bounds=[0,*points,len(line)]
        moods=[('기쁨','happy and delighted'),('슬픔','sad and sorrowful'),('분노','angry and forceful'),
               ('두려움','fearful with a trembling voice'),('혐오','disgusted and repelled'),
               ('놀람','surprised and astonished'),('차분함','calm and composed'),('속삭임','a quiet but clearly articulated whisper')]
        events={0:('chuckle','A short gentle chuckle follows.'),1:('sighs','A soft audible sigh follows.'),
                2:('breath','One audible breath follows.'),5:('laughs','A brief natural laugh follows.')}
        parts=[]
        for i,(label,description) in enumerate(moods):
            spoken=line[bounds[i]:bounds[i+1]]
            event=events.get(i)
            acting.append({'emotion':label,'start':bounds[i],'end':bounds[i+1],'spoken':spoken,
                           'nonverbal':event[0] if event else None,'pause_request_seconds':.7 if i==3 else None,
                           'description':description})
            parts.append(f'<Subject 1> (S1) speaks in Korean with {description}: <d>[Korean] {spoken}</d> '+
                         (event[1] if event else '')+(' Then she pauses silently for about 0.7 seconds.' if i==3 else ''))
        assert ''.join(a['spoken'] for a in acting)==LONG_LINE
        prompt=PROMPT.split('detailed_description:')[0]+'detailed_description:\n[Shot 1] The same speaker keeps the voice timbre of <Audio 1> throughout. '+\
               ' '.join(parts)+'\n\noverall_soundscape:\nClear Korean speech and the described breaths and laughter in a quiet room.'
    plan={'models':assets(),'reference':str(REFERENCE),'reference_sha256':REFERENCE_SHA,
          'seeds':[2024,2025,2026][:args.runs],'seconds_requested':args.seconds,'frames':frames,'canvas':256,
          'text':line,'prompt':prompt,'training_range_exceeded':args.seconds>15,
          'acting_plan':acting,'pause_accuracy':'H3 의미 요청이며 정확한 시간 보장 없음',
          'steps':16,'sampler':'res_multistep','scheduler':'simple','cfg':1.0,
          'shift_video':12,'shift_audio':3,'turbo':False,'step_reuse_cache':False,
          'fp16_accumulation':True,'attention_requested':'comfy kitchen attention',
          'pinned_memory':False,'async_offload':False,
          'video_vae':False,'video_decode':False,'server':False,'minimum_free_mib':args.minimum_free_mib,
          'load_order':'encode_release_text_then_load_diffusion','reserve_vram_gib':args.reserve_vram_gib}
    if args.reserve_vram_gib is not None and not 0<=args.reserve_vram_gib<=12:raise ValueError('메모리 예약 범위 밖')
    if args.acting_segments:
        plan['seeds']=[2024]*len(acting)
        plan['generation_mode']='감정별 독립 생성 후 원음 연결'
        for item in acting:
            seconds=max(5, len(item['spoken'])/7+1+(1 if item['nonverbal'] else 0))
            count=max(5,round(seconds*24));count+=(5-count)%17
            item['frames']=count
            item['prompt']=PROMPT.split('detailed_description:')[0]+\
                'detailed_description:\n[Shot 1] <Subject 1> (S1) says: <d>[Korean] '+item['spoken']+'</d> '+\
                'Her tone is '+item['description']+'. '+\
                ({'chuckle':'She gives a short chuckle.','sighs':'She sighs softly.',
                  'breath':'One audible breath follows.','laughs':'She laughs briefly.'}.get(item['nonverbal'],''))+\
                '\n\noverall_soundscape:\nOnly clear Korean speech and the described vocal sound in a quiet room.'
        plan['pause_accuracy']='두려움 구간 뒤 0.7초 무음을 연결 단계에 삽입. 모델의 자체 쉼은 추가될 수 있음.'
        plan['training_range_exceeded']=any(item['frames']/24>15 for item in acting)
    if args.prepare_only:
        print(json.dumps(plan,ensure_ascii=False,indent=2));return
    before_gpu=gpu_snapshot()
    if args.minimum_free_mib<4096:raise ValueError('최소 GPU 여유는 4GiB 이상이어야 합니다')
    if before_gpu['free_mib']<args.minimum_free_mib or before_gpu['utilization_percent']>20:
        raise RuntimeError('GPU 경합으로 측정 시작하지 않음: '+str(before_gpu))
    if sha(REFERENCE)!=REFERENCE_SHA:raise RuntimeError('승인된 참조 A의 지문 불일치')
    out=BASE/('h3-direct-speech-'+time.strftime('%Y%m%d-%H%M%S'));out.mkdir(exist_ok=False)
    report={'status':'running','plan':plan,'gpu_before':before_gpu,'ram_before':ram_snapshot(),'runs':[],
            'scope':'설치 코드 직접 호출 시험이며 제품 흡수 완료가 아니다. OS 파일 캐시를 비우지 않음.'}
    def save():
        tmp=out/'record.tmp';tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(out/'record.json')
    save();started=time.perf_counter()
    try:
        os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',
                          USE_PYTORCH_KERNEL_CACHE='0',NUMBA_CACHE_DIR=str(out/'numba-cache'))
        sys.path.insert(0,str(COMFY));sys.argv=[sys.argv[0],'--fast','fp16_accumulation',
            '--disable-pinned-memory','--disable-async-offload']
        if args.reserve_vram_gib is not None:sys.argv+=['--reserve-vram',str(args.reserve_vram_gib)]
        import comfy.options
        comfy.options.enable_args_parsing()
        logging.basicConfig(level=logging.INFO)
        import torch
        import soundfile as sf
        import nodes
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo,MiniMaxH3SigmaShift
        from comfy_extras.nodes_audio import VAEDecodeAudio
        from comfy_extras.nodes_model_advanced import ModelAttentionBackend
        import comfy.ldm.modules.attention as attention
        import comfy.model_management as mm
        # 그래픽 미리보기는 만들지 않는다. 샘플러의 원래 계산은 유지한다.
        def progress_callback(*args,**kwargs):
            def callback(step,x0,x,total_steps):
                run['sampling_progress']={'completed_steps':step+1,'total_steps':total_steps,
                    'elapsed_run_seconds':time.perf_counter()-t}
                save();print(json.dumps(run['sampling_progress']),flush=True)
            return callback
        nodes.latent_preview.prepare_callback=progress_callback
        def timed(label,fn,container):
            torch.cuda.synchronize();t=time.perf_counter()
            value=fn();torch.cuda.synchronize()
            container[label]=time.perf_counter()-t
            report.setdefault('resource_observations',[]).append({'stage':label,'ram':ram_snapshot(),'gpu':gpu_snapshot()})
            save()
            print(json.dumps({'stage':label,'seconds':container[label]},ensure_ascii=False),flush=True)
            return value
        report['imports_seconds']=time.perf_counter()-started
        report['torch']=torch.__version__
        report['code_sha256']={p:sha(COMFY/p) for p in ('nodes.py','comfy_extras/nodes_minimax_h3.py','comfy_extras/nodes_audio.py','comfy/ldm/minimax/model.py')}
        loading={}
        report['load_stages']=loading
        with torch.inference_mode():
            clip=timed('text_encoder_load',lambda:nodes.CLIPLoader().load_clip(ENCODER,'minimax','default')[0],loading)
            vae=timed('audio_vae_load',lambda:nodes.VAELoader().load_vae(VAE)[0],loading)
            x,sr=sf.read(REFERENCE,dtype='float32',always_2d=True)
            audio={'waveform':torch.from_numpy(x.T.copy())[None,:,:],'sample_rate':sr}
            condition=None
            model=None
            conditions=[]
            if args.acting_segments:
                for i,item in enumerate(acting):
                    conditions.append(timed('encode_segment_'+str(i+1),lambda item=item:MiniMaxH3ReferenceToVideo.execute(
                        clip=clip,prompt=item['prompt'],width=256,height=256,length=item['frames'],audio_vae=vae,
                        ref_audios={'ref_audio_0':audio}),loading))
            for index,seed in enumerate(plan['seeds']):
                run={'index':index,'seed':seed,'stages':{},'gpu_before':gpu_snapshot(),
                     'mode':'first' if index==0 else 'same_process_regeneration'}
                report['runs'].append(run);save();t=time.perf_counter()
                # 같은 참조·본문의 재생성은 확정 조건만 재사용한다. 생성 음성은 재사용하지 않는다.
                if args.acting_segments:
                    condition=conditions[index];run['acting']=acting[index]
                elif condition is None:
                    condition=timed('reference_and_text_encode',lambda:MiniMaxH3ReferenceToVideo.execute(
                        clip=clip,prompt=prompt,width=256,height=256,length=frames,audio_vae=vae,
                        ref_audios={'ref_audio_0':audio}),run['stages'])
                else:run['stages']['reference_and_text_encode']=0.0
                if model is None:
                    def release_encoder():
                        nonlocal clip
                        mm.unload_all_models();clip=None;gc.collect();torch.cuda.empty_cache()
                    timed('release_text_encoder',release_encoder,run['stages'])
                    model=timed('diffusion_load',lambda:nodes.UNETLoader().load_unet(MODEL,'default')[0],run['stages'])
                    model=MiniMaxH3SigmaShift.execute(model,12.0,3.0)[0]
                    report['attention_actual']='comfy kitchen int8' if attention.COMFY_KITCHEN_INT8_ATTENTION_IS_AVAILABLE else 'pytorch fallback'
                    model=ModelAttentionBackend.execute(model,'comfy kitchen attention')[0]
                positive,latent=condition[0],condition[1]
                negative=nodes.ConditioningZeroOut().zero_out(positive)[0]
                result=timed('sample',lambda:nodes.KSampler().sample(model,seed,16,1.0,
                    'res_multistep','simple',positive,negative,latent,denoise=1.0)[0],run['stages'])
                decoded=timed('audio_decode',lambda:VAEDecodeAudio.execute(vae,result)[0],run['stages'])
                wave=decoded['waveform'][0].float().cpu().numpy().T
                if not torch.isfinite(decoded['waveform']).all():raise RuntimeError('결과 비정상 값')
                path=out/(f'구간{index+1}_{acting[index]["emotion"]}.wav' if args.acting_segments else ('첫생성.wav' if index==0 else f'재생성{index}.wav'))
                timed('save',lambda:sf.write(path,wave,decoded['sample_rate'],subtype='FLOAT'),run['stages'])
                run.update(seconds=time.perf_counter()-t,path=str(path),sha256=sha(path),
                           duration=len(wave)/decoded['sample_rate'],sample_rate=decoded['sample_rate'],
                           peak=float(abs(wave).max()),conditioning_reused=index>0 and not args.acting_segments,gpu_after=gpu_snapshot())
                if index==0:run['startup_inclusive_seconds']=time.perf_counter()-started
                save();print(json.dumps(run,ensure_ascii=False),flush=True)
        if args.acting_segments:
            import numpy as np
            joined=[];cursor=0;joins=[]
            for i,run in enumerate(report['runs']):
                wave,sr=sf.read(run['path'],dtype='float32',always_2d=True)
                joins.append({'emotion':acting[i]['emotion'],'start_seconds':cursor/sr,'duration':len(wave)/sr})
                joined.append(wave);cursor+=len(wave)
                if acting[i]['pause_request_seconds']:
                    pause=np.zeros((round(.7*sr),wave.shape[1]),dtype=wave.dtype);joined.append(pause);cursor+=len(pause)
            combined=out/'감정연기_연결본.wav';sf.write(combined,np.concatenate(joined),sr,subtype='FLOAT')
            report['combined']={'path':str(combined),'sha256':sha(combined),'joins':joins,'duration':cursor/sr,
                                'processing':'원음 연결, 두려움 뒤 0.7초 무음 추가. 자르기·속도·음량·크로스페이드 없음.'}
        report['status']='complete';save()
        body='<meta charset="utf-8"><title>H3 최소 생성 비교</title><h1>H3 음성 생성 시험</h1><p>음질은 청취 판정 전.</p><p>'+html.escape(line)+'</p>'
        for run in report['runs']:
            body+=f'<h2>{run["index"]+1} · {run["seconds"]:.1f}초</h2><audio controls src="{Path(run["path"]).as_uri()}"></audio><p>{html.escape(run["path"])}</p>'
        (out/'비교듣기.html').write_text(body,encoding='utf-8')
        print('RESULT_DIR='+str(out),flush=True)
    except BaseException as error:
        report['status']='failed';report['error']=repr(error);save();raise
    finally:
        if 'mm' in locals():
            try:mm.unload_all_models()
            except Exception as error:print('모델 정리 실패: '+repr(error),flush=True)

if __name__=='__main__':main()
