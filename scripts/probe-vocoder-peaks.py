import sys,json,time,hashlib,html
from pathlib import Path
root=Path(r'E:\AI_Project\claudeCodeVsCode\apps\development\AudioForge_af_worktrees\develop-run');sys.path.insert(0,str(root/'python'))
import speech_vc as vc
import torch,numpy as np,soundfile as sf
base=Path(r'E:\AI_Project\claudeCodeVsCode\apps\master\AudioForge\_local\테스트\결과')
previous=base/'speech-emotion-a-20261012-044425'
r=json.loads((previous/'results.json').read_text(encoding='utf-8'))
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for key,hkey in [('path','sha256'),('source_path','source_sha256'),('reference_path','reference_sha256')]:assert sha(r[key])==r[hkey]
(previous/'사용자청취판정.json').write_text(json.dumps({'feedback':'말하기용이 좀 더 기계음이 적긴 했다.','scope':'기계음 상대 개선; 발음·감정·참조 유사도 합격 아님','sha256':r['sha256']},ensure_ascii=False,indent=2),encoding='utf-8')
assert torch.cuda.is_available() and torch.cuda.mem_get_info()[0]>5*1024**3,'GPU 여유 부족'
out=base/('speech-peak-audit-'+time.strftime('%Y%m%d-%H%M%S'));out.mkdir(exist_ok=False)
load=vc.load_models
def raw_models(paths,device):
    items=list(load(paths,device));m=items[3]
    assert not m.use_tanh_at_final,'이 모델은 잘라내기 경로가 아닙니다'
    items[3]=lambda x:m(x,clip_output=False)
    return tuple(items)
vc.load_models=raw_models
args=vc.build_parser().parse_args(['--source',r['source_path'],'--target',r['reference_path'],'--output',str(out/'원시'),'--seed','20261012','--diffusion-steps','40','--inference-cfg-rate','0.7'])
rawpath=Path(vc.main(args));a,sr=sf.read(rawpath,dtype='float32');old,oldsr=sf.read(r['path'],dtype='float32')
assert np.isfinite(a).all();clipped=np.clip(a,-1,1)
peak=float(abs(a).max());gain=min(1,.95/max(peak,1e-12))
paths=[]
for title,name,wave in [('같은 실행 · 기존 잘라내기 + 같은 음량','기존처리-동일음량.wav',clipped*gain),('같은 실행 · 잘라내기 없이 여유 확보','개선-최대진폭보존.wav',a*gain)]:
    path=out/name;sf.write(path,wave,sr,subtype='FLOAT');paths.append((title,path))
residual=a-clipped
idx=np.flatnonzero(abs(a)>1)
segments=[]
if len(idx):
    groups=np.split(idx,np.flatnonzero(np.diff(idx)>1)+1)
    segments=[{'start_sec':int(g[0])/sr,'end_sec':(int(g[-1])+1)/sr,'samples':len(g),'peak':float(abs(a[g]).max())} for g in groups]
same=oldsr==sr and old.shape==clipped.shape and np.array_equal(old,clipped)
report={'source_sha256':r['source_sha256'],'reference_sha256':r['reference_sha256'],'previous_sha256':r['sha256'],'raw_path':str(rawpath),'raw_sha256':sha(rawpath),'sample_rate':sr,'raw_peak':peak,'above_one_samples':int(len(idx)),'above_one_percent':100*len(idx)/len(a),'gain_applied_to_both':gain,'clipping_error_rms':float(np.sqrt(np.mean(residual**2))),'previous_reproduced_exactly':same,'previous_comparison_max_abs_error':float(abs(old-clipped).max()) if old.shape==clipped.shape else None,'overload_regions':segments,'files':[{'path':str(p),'sha256':sha(p),'peak':float(abs(sf.read(p)[0]).max())} for _,p in paths],'listening':'pending','cause_limit':'잘라내기 왜곡만 분리. 전체 기계음 원인 확정 아님.'}
(out/'진폭분석.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
body='<meta charset="utf-8"><title>말하기 변환 진폭 원인 비교</title><style>body{background:#141821;color:#e3edf8;max-width:900px;margin:32px auto;font:16px sans-serif}section{padding:20px;background:#222a36;margin:12px;border-radius:12px}audio{width:100%}p{overflow-wrap:anywhere}</style><h1>참조 A · 분노 · 잘라내기 영향 분리</h1><p>아래 두 비교는 같은 실행의 잘리기 전 신호에서 만들었습니다. 둘에 같은 선형 음량 배율을 적용했습니다. 차이는 ±1.0 잘라내기 유무뿐이며, 원본 파일은 그대로입니다. 잘라내기 전 원시 파일은 1.0을 넘을 수 있어 재생 목록에 넣지 않았습니다.</p><p>잘라내기 전 최대 진폭: '+str(round(peak,5))+' / 범위 초과: '+str(round(report['above_one_percent'],5))+'%. 기존 결과 완전 재현: '+('예' if same else '아니오')+'</p>'
for title,p in [('실제 참조 A',Path(r['reference_path'])),('소희 감정 원음',Path(r['source_path'])),('이전 말하기 결과 · 원본 보존',Path(r['path']))]+paths:
    body+='<section><h2>'+title+'</h2><audio controls src="'+html.escape(p.as_uri(),quote=True)+'"></audio><p>'+html.escape(str(p))+'</p></section>'
body+='<script>document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()}),true)</script>'
(out/'비교듣기.html').write_text(body,encoding='utf-8')
for key,hkey in [('path','sha256'),('source_path','source_sha256'),('reference_path','reference_sha256')]:assert sha(r[key])==r[hkey]
print(json.dumps({k:v for k,v in report.items() if k!='overload_regions'},ensure_ascii=False),flush=True)
print(str(out/'비교듣기.html'),flush=True)
