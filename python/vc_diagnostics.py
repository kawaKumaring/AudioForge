"""선택적 로컬 변환 기록. 추론 수치·난수 상태를 바꾸지 않는다."""
import hashlib
import json
import re
from pathlib import Path
import numpy as np

def file_fingerprint(path):
    p=Path(path);h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return {'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest()}

class Recorder:
    def __init__(self, directory, metadata):
        self.root=Path(directory)
        self.root.mkdir(parents=True,exist_ok=False)
        self.document={'status':'recording','metadata':metadata,'arrays':[]}
        self._write()

    def _write(self):
        temporary=self.root/'record.json.tmp'
        temporary.write_text(json.dumps(self.document,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
        temporary.replace(self.root/'record.json')

    def array(self, name, values):
        if not re.fullmatch(r'[a-z0-9_]+',name):raise ValueError('잘못된 기록 이름')
        if hasattr(values,'detach'):values=values.detach().float().cpu().numpy()
        # 원본과 메모리를 공유하지 않는 사본만 저장한다.
        a=np.array(values,copy=True)
        if not a.size or not np.isfinite(a).all():raise ValueError('기록 데이터가 비었거나 유효하지 않습니다')
        path=self.root/(name+'.npy')
        with path.open('xb') as f:np.save(f,a,allow_pickle=False)
        numeric=a.astype(np.float64)
        self.document['arrays'].append({'name':name,'shape':list(a.shape),'dtype':str(a.dtype),
            'min':float(a.min()),'max':float(a.max()),'rms':float(np.sqrt(np.mean(numeric**2))),
            **file_fingerprint(path)})
        self._write()

    def complete(self, output):
        self.document['output']=file_fingerprint(output)
        self.document['status']='complete';self._write()

def traced_vocoder(vocoder, recorder, *, prefix='chunk'):
    """같은 forward의 잘라내기 전후를 기록. 반환 신호는 원래 출력 그대로."""
    calls=0
    if not re.fullmatch(r'[a-z0-9_]+',prefix):raise ValueError('잘못된 관측 이름')
    def run(mel):
        nonlocal calls
        name=prefix+'_'+str(calls);calls+=1
        recorder.array(name+'_generated_mel',mel)
        captured=[]
        hook=vocoder.conv_post.register_forward_hook(lambda module,inputs,output:captured.append(output.detach().clone()))
        try:output=vocoder(mel)
        finally:hook.remove()
        if len(captured)!=1:raise RuntimeError('음성 복원 전 신호를 정확히 한 번 관측하지 못했습니다')
        recorder.array(name+'_prelimit_wave',captured[0])
        recorder.array(name+'_vocoder_wave',output)
        return output
    return run
