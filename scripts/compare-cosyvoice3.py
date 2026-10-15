"""승인된 기존 기준 참조 A/B로 같은 대사의 Qwen/Cosy 비교. 모든 자료는 로컬."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
MASTER=ROOT/'externals'
MASTER=MASTER.resolve().parent
TEXT='정말 반가워요. 잠깐 제 이야기를 들어 주세요. 오늘 와 줘서 고마워요. 다음에 다시 만나요.'
BASE=MASTER/'_local'/'테스트'/'결과'/'voice-baseline-20261012'
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def generate(root,engine,scenario=False,resume=False,limit=None):
    sys.path.insert(0,str(ROOT/'python'))
    from tts_worker import synthesize
    import numpy as np
    import soundfile as sf
    rows=[]
    resultfile=root/f'{engine}-results.json'
    if resume and resultfile.exists():
        old=json.loads(resultfile.read_text(encoding='utf-8'))
        failed=[x for x in old if x['status']=='failed']
        if failed:
            with (root/f'{engine}-failed-attempt-{time.time_ns()}.json').open('x',encoding='utf-8') as f: json.dump(failed,f,ensure_ascii=False,indent=2)
        rows=[x for x in old if x['status']=='generated']
    sources=json.loads((BASE/'results.json').read_text(encoding='utf-8'))
    for source in sources[:3] if scenario else sources[:2]:
        label=source['label']
        ref=Path(source['ref']['clip'])
        before=sha(ref)
        if before!=source['reference_sha256']:
            raise RuntimeError('기준 참조가 기록과 다릅니다: '+label)
        dest=root/'참조'/f'{label}.wav'
        dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists(): shutil.copyfile(ref,dest)
        modes=[('기존 Qwen','')] if engine=='qwen3' else [('Cosy 자연스럽게',''),('Cosy 기쁨','기쁨'),('Cosy 다정','다정')]
        if scenario:
            modes=[('자연스럽게',''),('분노','화남'),('슬픔','슬픔'),('명랑','명랑'),('낮고 부드럽게 · 실험','다정')]
            from cosyvoice_engine import INSTRUCTIONS
            INSTRUCTIONS['tender']='You are a helpful assistant. Speak in a low, soft, intimate and playful tone.'
        for name,emotion in modes:
            out=root/label/name
            out.mkdir(parents=True,exist_ok=True)
            if (out/'synthesized.wav').exists():
                previous=next((r for r in rows if r['voice']==label and r['condition']==name),None)
                if resume and previous and sha(out/'synthesized.wav')==previous['sha256'] and previous['reference_sha256']==before:
                    print(label,name,'기존 성공본 보존',flush=True)
                    continue
                raise RuntimeError('비교 결과가 이미 있습니다. 기존 결과는 덮지 않습니다')
            os.environ['AUDIOFORGE_TTS_SEED']='20261012'
            os.environ['AUDIOFORGE_DIAG_CHUNK_PUBLISH']='cosy-'+label+'-'+hashlib.sha256(name.encode()).hexdigest()[:8]+'-'+engine+'-'+root.name
            os.environ['AUDIOFORGE_LOCAL_ROOT']=str(root/'기록'); os.environ['AF_RUN_RECORD_DAYS']='0'
            spoken=('이제 와서 그런 말을 한다고 달라질 줄 알았어요? 나는 끝까지 당신을 믿었어요. 그래도 오늘은 내 곁에 있어 줘요. 우리 다시 시작할 수 있잖아요.') if scenario else TEXT
            raw=spoken if not emotion else f'[{emotion}] '+spoken
            t=time.monotonic()
            try:
                result=synthesize(str(ref),raw,str(out),preferred_engine=engine,
                    reference_conditioning_mode='auto',speed=1,pitch=0,silence_gap=.5,
                    tail_cfg={'mode':'auto','pad_ms':120,'fade_ms':8})
                audio,sr=sf.read(result)
                row={'voice':label,'condition':name,'engine':engine,'source_text':spoken,
                     'request_text':raw,'path':str(result),'sha256':sha(result),'seed':20261012,
                     'reference_sha256':before,'duration_sec':len(audio)/sr,
                     'peak':float(np.abs(audio).max()),'elapsed_sec':round(time.monotonic()-t,3),
                     'reference_unchanged':sha(ref)==before,'status':'generated','listening':'pending'}
            except Exception as exc:
                row={'voice':label,'condition':name,'engine':engine,'status':'failed','error':str(exc)}
            rows.append(row)
            (root/f'{engine}-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
            print(label,name,row['status'],flush=True)
            if row['status']=='failed': raise RuntimeError(row['error'])
            if limit is not None and len(rows)>=limit:return

def page(root):
    rows=[]
    for p in root.glob('*-results.json'): rows.extend(json.loads(p.read_text(encoding='utf-8')))
    asr={}
    if (root/'자동전사-참고.json').exists():
        asr={x['audio_sha256']:x for x in json.loads((root/'자동전사-참고.json').read_text(encoding='utf-8'))['rows']}
    scenario=any(x.get('condition')=='분노' for x in rows)
    body=''
    for label in sorted(set(x['voice'] for x in rows)):
        body+=f'<h2>참조 {label}</h2><audio controls src="참조/{label}.wav"></audio>'
        for r in sorted([x for x in rows if x['voice']==label],key=lambda x: (['기존 Qwen','Cosy 자연스럽게','Cosy 기쁨','Cosy 다정','자연스럽게','분노','슬픔','명랑','낮고 부드럽게 · 실험'].index(x['condition']))):
            body+=f'<section><h3>{html.escape(r["condition"])}</h3>'
            if r['status']=='generated':
                relative=Path(r['path']).relative_to(root).as_posix()
                body+=f'<audio controls preload="none" src="{html.escape(relative,quote=True)}"></audio><p>{r["duration_sec"]:.2f}초 · 최대값 {r["peak"]:.3f}</p><div class="path">{html.escape(r["path"])}</div>'
                if r['sha256'] in asr:
                    body+=f'<details><summary>자동 전사 참고 · 청취 판정 아님</summary><p>{html.escape(asr[r["sha256"]]["recognized_text"])}</p></details>'
            else: body+=f'<p>생성 실패: {html.escape(r["error"])}</p>'
            body+='</section>'
    markup='''<!doctype html><meta charset="utf-8"><title>CosyVoice3 연출 비교</title>
<style>body{background:#11151c;color:#dce7f6;font:16px sans-serif;max-width:980px;margin:35px auto;padding:0 24px}section{background:#1b212b;border-radius:12px;padding:18px;margin:14px 0}audio{width:100%}.path{font-size:12px;color:#a9b9cb;overflow-wrap:anywhere}p{line-height:1.7}</style>
<h1>같은 대사 · 같은 참조 목소리</h1><p>기존 Qwen과 CosyVoice3 자연스러운 읽기를 먼저 비교한 뒤, Cosy 안에서 기쁨·다정을 비교하세요. 생성 성공은 품질 합격이 아닙니다.</p>'''+f'<p>{html.escape(rows[0].get("source_text", TEXT) if rows else TEXT)}</p>'+body+'''<p>확인할 것: 원래 인물의 음색 / 모든 말의 발음 / 말끝 / 감정 변화. 같은 씨앗이어도 다른 모델의 조건을 완전히 같게 만들지는 못합니다. 음량·속도 맞춤 없음.</p>
<script>document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()}),true)</script>'''
    if scenario:
        markup=markup.replace('<h1>', '<p style="color:#ecc286">일부 자동 전사에서 조사와 단어가 다르게 인식됐습니다. 감정뿐 아니라 발음도 함께 들어 확인해 주세요.</p><h1>',1)
        markup=markup.replace('기존 Qwen과 CosyVoice3 자연스러운 읽기를 먼저 비교한 뒤, Cosy 안에서 기쁨·다정을 비교하세요.', '같은 상황극 대사에서 자연스럽게 / 분노 / 슬픔 / 명랑 / 낮고 부드럽게를 비교하세요. 마지막 조건은 섹시한 말투를 탐색하는 자유 지시이며 검증된 감정이 아닙니다.')
    (root/'비교듣기.html').write_text(markup,encoding='utf-8')

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--scenario',action='store_true')
    parser.add_argument('--resume',action='store_true')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--engine',choices=['qwen3','cosyvoice3'])
    args=parser.parse_args()
    root=Path(args.root)
    root.mkdir(parents=True,exist_ok=True)
    if args.engine: generate(root,args.engine,args.scenario,args.resume,args.limit)
    page(root)
