"""저장된 중간 자료만 분석한다. 모델 추론·새 생성·음질 합격 판정 없음."""
import argparse
import json
import re
from pathlib import Path
import numpy as np
from vc_diagnostics import file_fingerprint

def wave_stats(values):
    a=np.asarray(values,dtype=np.float64)
    if not a.size or not np.isfinite(a).all():raise ValueError('유효하지 않은 신호')
    return {'peak':float(np.max(np.abs(a))),
            'rms':float(np.sqrt(np.mean(a*a))),
            'full_scale_samples':int(np.sum(np.abs(a)>=1)),
            'above_full_scale_samples':int(np.sum(np.abs(a)>1)),
            'sample_count':int(a.size)}

def compare_limit(raw,final,sr):
    a=np.asarray(raw,dtype=np.float64);b=np.asarray(final,dtype=np.float64)
    if a.shape!=b.shape:raise ValueError('제한 전후 신호 모양이 다릅니다')
    # 현재 기록은 한 조각의 모노 신호다. 채널을 시간으로 잘못 해석하지 않는다.
    if a.ndim<1 or a.ndim>3 or any(n!=1 for n in a.shape[:-1]):
        raise ValueError('한 조각의 모노 신호가 아닙니다')
    before=wave_stats(a);after=wave_stats(b)
    diff=a-b;error=float(np.sqrt(np.mean(diff*diff)))
    changed=np.flatnonzero(diff.reshape(-1)!=0)
    if changed.size:
        groups=np.split(changed,np.where(np.diff(changed)>1)[0]+1)
    else:groups=[]
    ratio_db=None if error==0 or before['rms']==0 else float(20*np.log10(error/before['rms']))
    return {'before':before,'after':after,'changed_samples':int(changed.size),
            'error_rms':error,'error_relative_db':ratio_db,
            'matches_hard_clip':bool(np.array_equal(np.clip(a,-1,1),b)),
            'changed_region_count':len(groups),
            'first_changed_regions_seconds':[[int(g[0])/sr,(int(g[-1])+1)/sr] for g in groups[:20]],
            'scope':'제한 처리의 신호 차이. 기계음 원인·음질 합격 판정 아님.'}

def analyze_record(record_path):
    path=Path(record_path).resolve();root=path.parent
    doc=json.loads(path.read_text(encoding='utf-8'))
    if doc.get('status')!='complete':raise ValueError('완료되지 않은 단계 기록')
    sr=doc.get('metadata',{}).get('sampling_rate')
    if isinstance(sr,bool) or not isinstance(sr,int) or sr<=0:raise ValueError('표본율 기록 없음')
    output=doc.get('output',{})
    observed=file_fingerprint(output['path'])
    if any(observed[k]!=output[k] for k in ('bytes','sha256')):
        raise ValueError('완성 음성의 지문이 다릅니다')
    arrays={}
    for entry in doc.get('arrays',[]):
        name=entry['name']
        if not re.fullmatch(r'[a-z0-9_]+',name) or name in arrays:
            raise ValueError('배열 이름 중복 또는 잘못된 이름')
        p=(root/(name+'.npy')).resolve()
        if p.parent!=root:raise ValueError('기록 폴더 밖 배열')
        observed=file_fingerprint(p)
        if any(observed[k]!=entry[k] for k in ('bytes','sha256')):
            raise ValueError('중간 신호 지문 불일치: '+name)
        a=np.load(p,allow_pickle=False)
        if list(a.shape)!=entry['shape'] or str(a.dtype)!=entry['dtype']:
            raise ValueError('중간 신호 구조 불일치: '+name)
        wave_stats(a)
        arrays[name]=a
    stages=[]
    for name in arrays:
        if name.endswith(('_vocoder_wave','_generated_mel')):
            suffix='_vocoder_wave' if name.endswith('_vocoder_wave') else '_generated_mel'
            prefix=name.removesuffix(suffix)
            if prefix+'_prelimit_wave' not in arrays:
                raise ValueError('제한 전 신호 기록 누락: '+prefix)
    for name,a in arrays.items():
        if not name.endswith('_prelimit_wave'):continue
        prefix=name.removesuffix('_prelimit_wave')
        final=arrays.get(prefix+'_vocoder_wave')
        mel=arrays.get(prefix+'_generated_mel')
        if final is None or mel is None:raise ValueError('복원 단계 기록 누락: '+prefix)
        stages.append({'stage':prefix,'mel':wave_stats(mel),
                       **compare_limit(a,final,sr)})
    if not any(s['stage'].startswith('chunk_') for s in stages):
        raise ValueError('변환 결과 단계 기록 없음')
    expected=doc['metadata'].get('reconstruction_controls',False)
    controls={s['stage'] for s in stages if s['stage'].startswith('control_')}
    if expected and controls!={'control_source_0','control_reference_0'}:
        raise ValueError('원음 복원 대조 기록 누락')
    return {'record':file_fingerprint(path),'output':output,'sampling_rate':sr,
            'reconstruction_controls':expected,'stages':stages,
            'quality_verdict':'미판정: 지문과 진폭 통계는 발음·감정·화자 닮음의 근거가 아니다.'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('record');p.add_argument('--output',required=True)
    args=p.parse_args();result=analyze_record(args.record)
    with Path(args.output).open('x',encoding='utf-8') as f:
        json.dump(result,f,ensure_ascii=False,indent=2,allow_nan=False)
