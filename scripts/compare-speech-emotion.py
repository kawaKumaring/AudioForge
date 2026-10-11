import sys,json,time,hashlib,html
from pathlib import Path
ROOT=Path(r'E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge_af_worktrees\develop-run')
sys.path.insert(0,str(ROOT/'python'))
import speech_vc as vc
import torch,numpy as np,soundfile as sf
base=Path(r'E:\AI_Project\claudeCodeVsCode\apps\master\AudioForge\_local\테스트\결과')
records=json.loads((base/'sohee-emotion-transfer-20261012-043214/results.json').read_text(encoding='utf-8'))
r=next(x for x in records if x['voice']=='A' and x['condition']=='분노')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
for key,hkey in [('path','sha256'),('source_path','source_sha256'),('reference_path','reference_sha256')]:assert sha(r[key])==r[hkey]
assert torch.cuda.is_available() and torch.cuda.mem_get_info()[0]>5*1024**3,'GPU 여유 부족; CPU 전환하지 않음'
out=base/('speech-emotion-a-'+time.strftime('%Y%m%d-%H%M%S'));out.mkdir(exist_ok=False)
args=vc.build_parser().parse_args(['--source',r['source_path'],'--target',r['reference_path'],'--output',str(out/'변환'),'--seed','20261012','--diffusion-steps','40','--inference-cfg-rate','0.7','--f0-condition','False','--auto-f0-adjust','False','--semi-tone-shift','0'])
t=time.monotonic();vc.main(args)
paths=list((out/'변환').glob('*.wav'));assert len(paths)==1
path=paths[0];a,sr=sf.read(path);assert len(a) and np.isfinite(a).all()
data={'voice':'A','condition':'분노','engine':'Seed-VC speech 22.05kHz','source_path':r['source_path'],'source_sha256':r['source_sha256'],'reference_path':r['reference_path'],'reference_sha256':r['reference_sha256'],'seed_vc_path':r['path'],'seed_vc_sha256':r['sha256'],'path':str(path),'sha256':sha(path),'source_text':r['source_text'],'source_instruction':r['source_instruction'],'f0_condition':False,'conversion_seed':20261012,'steps':40,'cfg':0.7,'auto_f0_adjust':False,'semitones':0,'duration_sec':len(a)/sr,'sample_rate':sr,'peak':float(abs(a).max()),'elapsed_sec':time.monotonic()-t,'listening':'pending','postprocessing':'none'}
for key,hkey in [('source_path','source_sha256'),('reference_path','reference_sha256'),('path','sha256')]:assert sha(r[key])==r[hkey]
(out/'results.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
body='<meta charset="utf-8"><title>참조 A 분노 변환 비교</title><style>body{background:#141821;color:#e3edf8;max-width:900px;margin:32px auto;font:16px sans-serif}section{padding:20px;background:#222a36;margin:12px;border-radius:12px}audio{width:100%}p{overflow-wrap:anywhere}</style><h1>참조 A · 분노 · 변환 비교</h1><p>동일한 소희 원음과 참조 조각. 두 변환은 다른 모델이며 각각 한 번 생성. 말하기용 모델은 직접 음높이 조건을 받지 않습니다. 음량 맞춤·후처리 없음. 기계음·감정·발음·참조 유사도를 따로 확인해 주세요.</p>'
for label,p in [('실제 참조 A',r['reference_path']),('소희 감정 원음',r['source_path']),('Seed-VC · 이전 불합격 결과',r['path']),('Seed-VC 말하기용 · 새 비교',str(path))]:
    body+='<section><h2>'+label+'</h2><audio controls src="'+html.escape(Path(p).as_uri(),quote=True)+'"></audio><p>'+html.escape(p)+'</p></section>'
body+='<script>document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()}),true)</script>'
(out/'비교듣기.html').write_text(body,encoding='utf-8')
print(json.dumps(data,ensure_ascii=False),flush=True)
print(str(out/'비교듣기.html'),flush=True)
