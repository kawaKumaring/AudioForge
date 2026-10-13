"""로컬 H3 연기 결과의 측정·청취 페이지. 자동 음질 합격 판정 없음."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT=Path(__file__).resolve().parents[1]
BASE=(ROOT/'externals').resolve().parent/'_local/테스트/결과'

def measure(path):
    wave,sr=sf.read(path,dtype='float32',always_2d=True)
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'duration':len(wave)/sr,'sample_rate':sr,'channels':wave.shape[1],
            'peak':float(np.abs(wave).max()),'full_scale_samples':int((np.abs(wave)>=1).sum()),
            'sample_count':int(wave.size),'non_finite_samples':int((~np.isfinite(wave)).sum())}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('folder');args=parser.parse_args()
    folder=Path(args.folder).resolve()
    if not folder.is_relative_to(BASE.resolve()):raise ValueError('시험 결과 폴더 밖')
    record=json.loads((folder/'record.json').read_text(encoding='utf-8-sig'))
    if record['status']!='complete' or 'combined' not in record:raise ValueError('생성 완료 전')
    baseline=BASE/'h3-direct-speech-20261012-231542/첫생성.wav'
    reference=Path(record['plan']['reference'])
    if hashlib.sha256(reference.read_bytes()).hexdigest()!=record['plan']['reference_sha256']:
        raise ValueError('참조 지문 불일치')
    paths=[baseline,Path(record['combined']['path']),*[Path(r['path']) for r in record['runs']]]
    metrics=[measure(p) for p in paths]
    for run in record['runs']:
        if measure(Path(run['path']))['sha256']!=run['sha256']:raise ValueError('결과 지문 불일치')
    if ''.join(r['acting']['spoken'] for r in record['runs'])!=record['plan']['text']:
        raise ValueError('원문 불일치')
    (folder/'measurements.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2),encoding='utf-8')
    esc=html.escape
    def player(path):return '<audio controls preload="none" src="'+esc(path.as_uri(),quote=True)+'"></audio><p class="path">'+esc(str(path))+'</p>'
    body='''<!doctype html><meta charset="utf-8"><title>H3 감정 연기 듣기</title>
<style>body{margin:0;background:#101218;color:#e6e9f1;font:15px/1.7 system-ui}main{max-width:1000px;margin:auto;padding:28px}section{padding:20px;border:1px solid #343944;border-radius:14px;background:#1a1e27;margin:16px 0}audio{width:100%}.path{font-size:12px;overflow-wrap:anywhere;color:#a1adbf}button{background:#293447;color:#e6efff;border:1px solid #536981;padding:9px 14px;border-radius:8px;cursor:pointer}.note{color:#b2bfd3}blockquote{margin:0;border-left:3px solid #65bad0;padding-left:16px}h1{font-size:24px}h2{font-size:18px}</style><main><h1>H3 · 같은 대사와 참조 A의 감정 연기</h1>
<p class="note">기본 말투는 30초 한 번 생성, 연기는 여덟 구간 독립 생성 후 연결입니다. 동일한 길이·분할 조건의 비교는 아닙니다. 아래 감정과 발성은 요청 내용이며 적용 성공 판정이 아닙니다. Speech 2.8의 태그를 문자 그대로 사용하지 않았습니다.</p>'''
    body+='<section><h2>참조 A · 원래 목소리</h2>'+player(reference)+'</section>'
    body+='<section><h2>앞선 기본 말투</h2>'+player(baseline)+'</section>'
    combined=Path(record['combined']['path'])
    body+='<section><h2>감정 연기 연결본</h2><audio id="whole" controls preload="none" src="'+esc(combined.as_uri(),quote=True)+'"></audio><p class="path">'+esc(str(combined))+'</p><p class="note">자르기·음량·속도·크로스페이드 없음. 두려움 뒤 0.7초 무음을 추가했고 모델 자체 쉼은 더해질 수 있습니다.</p></section>'
    for i,(run,join) in enumerate(zip(record['runs'],record['combined']['joins'])):
        a=run['acting'];event={'chuckle':'가벼운 웃음','sighs':'한숨','breath':'호흡','laughs':'웃음'}.get(a['nonverbal'],'없음')
        body+='<section><h2>'+str(i+1)+' · '+esc(a['emotion'])+'</h2><button onclick="let p=document.getElementById(\'whole\');p.currentTime='+str(join['start_seconds'])+';p.play()">연결본의 이 구간 듣기</button><blockquote>'+esc(a['spoken'])+'</blockquote><p class="note">추가 발성 요청: '+event+'</p>'+player(Path(run['path']))+'</section>'
    body+='<section><h2>청취 기준</h2><p>감정이 바뀌는지 · 발음과 원문이 유지되는지 · 참조 A와 닮았는지 · 구간 이음과 웃음·호흡이 자연스러운지 확인해 주세요. 자동 수치는 음질이나 인물 닮음의 합격 기준이 아닙니다.</p></section></main>'
    body+='''<script>document.addEventListener('play',e=>{if(e.target.tagName==='AUDIO')for(const p of document.querySelectorAll('audio'))if(p!==e.target)p.pause()},true)</script>'''
    (folder/'감정비교듣기.html').write_text(body,encoding='utf-8')
    print(json.dumps({'page':str(folder/'감정비교듣기.html'),'metrics':metrics},ensure_ascii=False))

if __name__=='__main__':main()
