"""기존 소희 1.7B만 사용하는 감정 기준 비교. 제품 설정 변경 없음."""
import hashlib
import html
import json
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
from qwen_emotions import instruct_of

def main():
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_custom_voice import load
    free,_=torch.cuda.mem_get_info() if torch.cuda.is_available() else (0,0)
    if free<6*1024**3:
        raise RuntimeError('GPU 여유가 부족합니다. 생성을 시작하지 않습니다')
    ext=(ROOT/'externals').resolve()
    modelpath=ext/'qwen3_tts_1_7b_customvoice'
    config=json.loads((modelpath/'config.json').read_text(encoding='utf-8'))
    if config.get('tts_model_size')!='1b7' or config.get('tts_model_type')!='custom_voice':
        raise RuntimeError('소희 1.7B 지정 목소리 모델이 아닙니다')
    out=ext.parent/'_local/테스트/결과'/('sohee-emotions-'+time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True,exist_ok=False)
    text='이제 와서 그런 말을 한다고 달라질 줄 알았어요? 나는 끝까지 당신을 믿었어요. 그래도 오늘은 내 곁에 있어 줘요. 우리 다시 시작할 수 있잖아요.'
    seed=20261012
    model=load(str(modelpath))
    rows=[]
    for label,emotion in [('자연스럽게','default'),('분노','angry'),('슬픔','sad'),('명랑','cheerful')]:
        instruction=instruct_of(emotion)
        torch.manual_seed(seed); torch.cuda.manual_seed_all(seed); np.random.seed(seed)
        started=time.monotonic()
        wavs,sr=model.generate_custom_voice(text=text,language='Korean',speaker='sohee',instruct=instruction)
        audio=np.asarray(wavs[0],dtype='float32').reshape(-1)
        if not len(audio) or not np.isfinite(audio).all():raise RuntimeError('음성이 비었거나 깨졌습니다')
        peak=float(np.abs(audio).max())
        path=out/(label+'.wav')
        sf.write(path,audio,int(sr),subtype='FLOAT')
        rows.append({'condition':label,'emotion':emotion,'instruction':instruction,'source_text':text,
            'sent_text':text,'seed':seed,'speaker':'sohee','model_path':str(modelpath),
            'config_sha256':hashlib.sha256((modelpath/'config.json').read_bytes()).hexdigest(),
            'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'duration_sec':len(audio)/sr,'sample_rate':int(sr),'peak':peak,
            'elapsed_sec':time.monotonic()-started,'listening':'pending'})
        (out/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
        print(label+' 완료',flush=True)
    body='<meta charset="utf-8"><title>소희 한국어 감정 비교</title><style>body{background:#141821;color:#e3edf8;max-width:900px;margin:32px auto;font:16px sans-serif}section{padding:20px;background:#222a36;margin:12px;border-radius:12px}audio{width:100%}p{overflow-wrap:anywhere}</style><h1>소희 1.7B · 한국어 감정 기준</h1><p>기본 목소리 비교이며 참조 A/B/C 복제 성공을 의미하지 않습니다. 같은 모델·대사·seed, 감정 지시만 다릅니다. 후처리·음량 맞춤 없음.</p><p>'+html.escape(text)+'</p>'
    for r in rows:body+='<section><h2>'+r['condition']+'</h2><audio controls src="'+html.escape(Path(r['path']).name,quote=True)+'"></audio><p>'+html.escape(r['path'])+'</p></section>'
    body+='<script>document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()}),true)</script>'
    (out/'비교듣기.html').write_text(body,encoding='utf-8')
    print(str(out/'비교듣기.html'),flush=True)

if __name__=='__main__':main()
