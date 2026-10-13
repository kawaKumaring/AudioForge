"""승인된 기존 비교 음성만 읽는 CPU 분석. 새 생성·모델 추론 없음."""
import json,hashlib,time
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy import signal
BASE=Path(r'E:\AI_Project\claudeCodeVsCode\apps\master\AudioForge\_local\테스트\결과')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def metrics(path,expected):
    assert sha(path)==expected, '기존 파일 지문 불일치'
    x,sr=sf.read(path,dtype='float64');ch=1 if x.ndim==1 else x.shape[1]
    if x.ndim>1:x=x.mean(axis=1)
    assert np.isfinite(x).all()
    rms=float(np.sqrt(np.mean(x*x)));peak=float(abs(x).max())
    _,_,z=signal.stft(x,fs=sr,nperseg=1024,noverlap=768,boundary=None,padded=False)
    freq=np.fft.rfftfreq(1024,1/sr);power=abs(z)**2
    total=float(power.sum());high=float(power[freq>=6000].sum()/max(total,1e-30))
    n=max(1,int(sr*.02));frames=x[:len(x)//n*n].reshape(-1,n)
    fr=np.sqrt(np.mean(frames**2,axis=1))
    return {'path':str(path),'sha256':expected,'sample_rate':sr,'channels':ch,'seconds':len(x)/sr,'peak':peak,'rms':rms,'rms_dbfs':20*np.log10(max(rms,1e-15)),'full_scale_samples':int((abs(x)>=1).sum()),'above_full_scale_samples':int((abs(x)>1).sum()),'energy_above_6khz_fraction':high,'frames_below_minus_50dbfs_fraction':float(np.mean(fr<10**(-50/20))),'scope':'에너지·진폭 관측. 음질·화자 유사도·발음 판정 아님.'}
rows=json.loads((BASE/'sohee-emotion-transfer-20261012-043214/results.json').read_text(encoding='utf-8'))
inputs={}
for r in rows:
    for pk,hk in [('path','sha256'),('source_path','source_sha256'),('reference_path','reference_sha256')]:inputs[r[pk]]=r[hk]
for folder in ['speech-emotion-a-20261012-044425','ying-emotion-a-20261012-043807']:
    r=json.loads((BASE/folder/'results.json').read_text(encoding='utf-8'));inputs[r['path']]=r['sha256']
p=json.loads((BASE/'speech-peak-audit-20261012-044920/진폭분석.json').read_text(encoding='utf-8'))
raw,sr=sf.read(p['raw_path']);assert sha(p['raw_path'])==p['raw_sha256']
inputs[p['raw_path']]=p['raw_sha256']
err=raw-np.clip(raw,-1,1)
error_ratio_db=20*np.log10(max(np.sqrt(np.mean(err**2)),1e-30)/np.sqrt(np.mean(raw**2)))
audit={'analysis_kind':'CPU read-only analysis; no generation','metrics':[metrics(Path(path),h) for path,h in inputs.items()],'clipping_error_relative_to_signal_db':float(error_ratio_db),'clipping_changed_samples':int(np.count_nonzero(err)),'clipping_regions':p['overload_regions'],'previous_reproduced_exactly':p['previous_reproduced_exactly'],'limitations':['진폭·스펙트럼 수치로 기계음이나 화자 유사도 합격을 판정하지 않음','기존 기록에 중간 멜·복원 전 출력이 없어 두 단계 손상을 완전히 분리할 수 없음','원문 발음 누락은 이 분석으로 판정하지 않음']}
out=BASE/('vc-code-signal-audit-'+time.strftime('%Y%m%d-%H%M%S'));out.mkdir(exist_ok=False)
(out/'기존음성분석.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print(str(out),flush=True)
print(json.dumps({'clip_error_relative_db':error_ratio_db,'changed_samples':int(np.count_nonzero(err)),'signals':[{'name':Path(x['path']).name,'rms_dbfs':round(x['rms_dbfs'],2),'peak':round(x['peak'],5),'seconds':round(x['seconds'],3)} for x in audit['metrics']]},ensure_ascii=False),flush=True)
