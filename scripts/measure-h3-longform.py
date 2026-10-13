"""승인된 기존30초 H3의 시간 측정. CPU 음성 검출만, 생성·다운로드 없음."""
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import argparse
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--approve-audio',action='store_true');parser.add_argument('--sample',choices=['10','30'],default='30');args=parser.parse_args()
    if not args.approve_audio:parser.error('기존 음원 읽기 승인 필요')
    import app_runtime
    root=Path(app_runtime.assets_root()).resolve().parent/'_local'/'테스트'/'결과'
    folder=root/('h3-direct-speech-20261012-231542' if args.sample=='30' else 'h3-direct-speech-20261012-224502');path=folder/'첫생성.wav'
    output=folder/'발화시간측정-20261014.json'
    if output.exists():parser.error('기존 측정 파일 보존: 이미 측정됨')
    record=json.loads((folder/'record.json').read_text(encoding='utf-8'));blob=path.read_bytes();sha=hashlib.sha256(blob).hexdigest()
    if record['status']!='complete' or sha!=record['runs'][0]['sha256']:raise ValueError('실행 기록과 음성 지문 불일치')
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    wave,sr=sf.read(path,dtype='float32',always_2d=True);channel=int(np.argmax(np.mean(wave.astype('float64')**2,axis=0)))
    mono=wave[:,channel];gcd=math.gcd(sr,16000);audio=resample_poly(mono,16000//gcd,sr//gcd).astype('float32')
    local=Path(app_runtime.assets_root())/'diarization_models'/'silero-vad'
    if not (local/'hubconf.py').is_file():raise ValueError('앱 내부 음성 검출 모델 없음. 다운로드하지 않음')
    torch.set_num_threads(4)
    model,utils=torch.hub.load(str(local),model='silero_vad',source='local',onnx=False)
    rows=[]
    for threshold in [.35,.4,.5]:
        spans=utils[0](torch.from_numpy(audio),model,sampling_rate=16000,threshold=threshold,min_speech_duration_ms=250,min_silence_duration_ms=100,speech_pad_ms=30)
        intervals=[{'start':s['start']/16000,'end':s['end']/16000,'seconds':(s['end']-s['start'])/16000} for s in spans]
        if not intervals:raise ValueError('발화 구간을 검출하지 못함')
        gaps=[{'start':a['end'],'end':b['start'],'seconds':b['start']-a['end']} for a,b in zip(intervals,intervals[1:])]
        rows.append({'threshold':threshold,'intervals':intervals,'detected_speech_sum_seconds':sum(s['seconds'] for s in intervals),'first_speech_start':intervals[0]['start'],'last_speech_end':intervals[-1]['end'],'speech_span_seconds':intervals[-1]['end']-intervals[0]['start'],'leading_non_speech_seconds':intervals[0]['start'],'trailing_non_speech_seconds':len(wave)/sr-intervals[-1]['end'],'internal_gaps':gaps,'internal_gap_sum_seconds':sum(g['seconds'] for g in gaps)})
    text=record['plan'].get('text')
    text_source='생성 당시 실행 기록'
    if text is None:
        confirmed=json.loads((root/'h3-baseline-reproduce-20261014'/'재현기록.json').read_text(encoding='utf-8'))
        if confirmed['plan'].get('factor','baseline')!='baseline':raise ValueError('정상 재현 기준 확인 필요')
        if confirmed['plan']['seed']!=record['runs'][0]['seed'] or confirmed['plan']['frames']!=record['plan']['frames']:raise ValueError('원문 대응 조건 불일치')
        text=confirmed['plan']['text'];text_source='PCM 동일성 확인된 정상 재현 기록'
    syllables=len(re.findall('[가-힣]',text));main=rows[1]
    frame=round(sr*.02);rms=np.sqrt(np.mean(np.pad(mono,(0,(-len(mono))%frame)).reshape(-1,frame).astype('float64')**2,axis=1))
    energy=[]
    for db in [-35,-40,-45]:
        active=np.flatnonzero(rms>=10**(db/20));energy.append({'threshold_dbfs':db,'first_active_seconds':float(active[0]*.02) if len(active) else None,'last_active_seconds':min(len(wave)/sr,float((active[-1]+1)*.02)) if len(active) else None})
    import h3_engine
    report={'path':str(path),'sha256':sha,'record_match':True,'source_unchanged':hashlib.sha256(path.read_bytes()).hexdigest()==sha,'file_seconds':len(wave)/sr,'sample_rate':sr,'channels':wave.shape[1],'analysis_channel':channel,'text_source':text_source,'text_chars':len(text),'hangul_syllables':syllables,'sentences':len(re.findall('[.!?]',text)),'hangul_per_speech_span_second':syllables/main['speech_span_seconds'],'hangul_per_detected_speech_second':syllables/main['detected_speech_sum_seconds'],'vad':rows,'energy_sensitivity':energy,'current_auto_whole_seconds_before_alignment':len(text)/7+2,'current_auto_chunks':[{'chars':len(c),'frames':h3_engine.frame_count(c),'seconds':h3_engine.frame_count(c)/24} for c in h3_engine.split_text(text)],'method':'앱 내부 Silero VAD,CPU,16kHz,최소음성250ms·최소쉼100ms·여유30ms. 문장별 정렬 아님. 숨소리·낮은 말끝 오차 가능. 정상 청취는 사용자 기존 판정이며 이 측정으로 누락 여부 확정하지 않음.'}
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
