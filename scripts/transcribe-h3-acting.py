"""승인된 H3 시험 결과만 CPU 받아쓰기. 외부 통신·자동 품질 합격 판정 없음."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time

ROOT=Path(__file__).resolve().parents[1]
EXT=(ROOT/'externals').resolve()
BASE=EXT.parent/'_local/테스트/결과'

def distance(left,right):
    prev=list(range(len(right)+1))
    for i,a in enumerate(left,1):
        row=[i]
        for j,b in enumerate(right,1):row.append(min(row[-1]+1,prev[j]+1,prev[j-1]+(a!=b)))
        prev=row
    return prev[-1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('folder');args=parser.parse_args()
    folder=Path(args.folder).resolve()
    if not folder.is_relative_to(BASE.resolve()):raise ValueError('시험 결과 폴더 밖')
    record=json.loads((folder/'record.json').read_text(encoding='utf-8-sig'))
    if record['status']!='complete':raise ValueError('생성 완료 전')
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
    from faster_whisper import WhisperModel
    model=WhisperModel(str(EXT/'asr_ct2_models/faster-whisper-large-v3'),device='cpu',compute_type='int8',
                       cpu_threads=4,local_files_only=True)
    results=[]
    for run in record['runs']:
        path=Path(run['path']).resolve()
        if not path.is_relative_to(folder) or hashlib.sha256(path.read_bytes()).hexdigest()!=run['sha256']:
            raise ValueError('결과 경로·지문 불일치')
        start=time.perf_counter()
        segments,info=model.transcribe(str(path),beam_size=1,temperature=0,condition_on_previous_text=False,vad_filter=False)
        pieces=list(segments);text=''.join(s.text for s in pieces)
        expected=run.get('acting',{}).get('spoken',record['plan']['text'])
        norm=lambda value:re.sub(r'[^가-힣A-Za-z0-9]','',value).lower()
        source,spoken=norm(expected),norm(text)
        result={'path':str(path),'sha256':run['sha256'],'expected':expected,'recognized':text,
                'language':info.language,'language_probability':info.language_probability,
                'character_edits':distance(source,spoken),'expected_characters':len(source),
                'character_error_rate':distance(source,spoken)/max(1,len(source)),
                'seconds':time.perf_counter()-start,
                'segments':[{'start':s.start,'end':s.end,'text':s.text} for s in pieces]}
        results.append(result)
        (folder/'asr-review.json').write_text(json.dumps({'engine':'faster-whisper-large-v3 CPU int8',
            'status':'complete' if len(results)==len(record['runs']) else 'running','results':results,
            'limitation':'받아쓰기 오차도 포함된다. 억양·발음 자연스러움·감정·인물 닮음의 합격 판정이 아니다.'},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'completed':len(results),'total':len(record['runs']),'character_error_rate':result['character_error_rate']},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
