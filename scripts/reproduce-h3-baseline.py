"""초기 승인된 H3 기준 재현. 제품 설정 변경 없음, 명시적 실행 때 한 번만 생성."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import runpy
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
import h3_engine


def make_plan(legacy,factor='baseline'):
    text=legacy['LINE'];prompt=legacy['PROMPT'];seed=2024;frames=243
    labels={'baseline':'초기 정상 조건','prompt':'인물·말투 지시만 변경','duration':'생성 길이만 변경','seed':'seed만 변경'}
    if factor not in labels:raise ValueError('알 수 없는 비교 조건')
    if factor=='prompt':prompt=h3_engine.prompt_for(text)
    elif factor=='duration':frames=311
    elif factor=='seed':seed=473899724
    return {'factor':factor,'label':labels[factor],'seed':seed,'frames':frames,'canvas':256,'steps':16,'cfg':1,
            'sampler':'res_multistep','scheduler':'simple','text':text,'prompt':prompt,'channels':'stereo',
            'scope':'정상 기준에서 조건 하나만 변경. 앱 내부 추론 사용, 환경 전체 동일성 미보장'}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--execute',action='store_true');parser.add_argument('--approve-reference',action='store_true')
    parser.add_argument('--reference');parser.add_argument('--out')
    parser.add_argument('--factor',choices=['baseline','prompt','duration','seed'],default='baseline');args=parser.parse_args()
    legacy=runpy.run_path(str(Path(__file__).with_name('probe-h3-speech.py')))
    plan=make_plan(legacy,args.factor);prompt=plan['prompt'];text=plan['text']
    if not args.execute:print(json.dumps(plan,ensure_ascii=False,indent=2));return
    if not args.approve_reference or not args.reference or not args.out:parser.error('참조 승인·원본 경로·새 결과 폴더 필요')
    if os.environ.get('AF_H3_PIPE_ADDR'):parser.error('독립 실행 환경 필요')
    import app_runtime
    root=Path(app_runtime.assets_root()).resolve().parent/'_local'/'테스트'/'결과';out=Path(args.out).resolve()
    if not out.is_relative_to(root) or out==root or out.exists():parser.error('검사 결과 아래 새 폴더만 사용 가능')
    ref=Path(args.reference);before=ref.read_bytes();ref_hash=hashlib.sha256(before).hexdigest()
    if ref_hash!=legacy['REFERENCE_SHA']:parser.error('승인된 초기 참조 A 지문 불일치')
    baseline=root/'h3-direct-speech-20261012-224502'/'첫생성.wav';old=baseline.read_bytes()
    if hashlib.sha256(old).hexdigest()!='21f8da1c4e9d6743946dd38f7a082f1a0f904c233e082a6088ebbc5abde67439':parser.error('정상 초기 음원 지문 불일치')
    out.mkdir(parents=True);snapshot=out/'참조.wav';snapshot.write_bytes(before);(out/'초기기준.wav').write_bytes(old)
    report={'plan':plan,'reference_sha256':ref_hash,'status':'준비 중'}
    def save():(out/'재현기록.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    engine=h3_engine.H3Engine();engine.run_seed=plan['seed'];started=time.monotonic();save()
    original_prompt=h3_engine.prompt_for;original_frames=h3_engine.frame_count
    old_env={k:os.environ.get(k) for k in ['AF_H3_DIAGNOSTIC','AF_H3_DIAGNOSTIC_CANVAS','AF_H3_DIAGNOSTIC_ATTENTION']}
    try:
        os.environ.update(AF_H3_DIAGNOSTIC='1',AF_H3_DIAGNOSTIC_CANVAS='256',AF_H3_DIAGNOSTIC_ATTENTION='auto')
        h3_engine.prompt_for=lambda value:prompt if value==text else (_ for _ in ()).throw(ValueError('초기 대사 불일치'))
        h3_engine.frame_count=lambda value:plan['frames'] if value==text else (_ for _ in ()).throw(ValueError('초기 대사 불일치'))
        engine.load();decode=engine.ops.vae_decode_audio
        def capture(*args,**kwargs):
            result=decode(*args,**kwargs)
            import soundfile as sf
            wave=result['waveform'][0].float().cpu().numpy().T
            sf.write(out/'재현-스테레오.wav',wave,result['sample_rate'],subtype='FLOAT')
            report['stereo']={'duration':len(wave)/result['sample_rate'],'channels':wave.shape[1],'peak':float(abs(wave).max()),'sha256':hashlib.sha256((out/'재현-스테레오.wav').read_bytes()).hexdigest()}
            return result
        engine.ops.vae_decode_audio=capture
        engine.progress=lambda msg:print(json.dumps(msg,ensure_ascii=False),flush=True)
        engine.synthesize_segment(text,str(snapshot),'default',1,str(out/'재현-모노.wav'))
        report.update(status='생성 완료·청취 대기',seconds=time.monotonic()-started,engine_record=engine.records[-1],reference_unchanged=hashlib.sha256(ref.read_bytes()).hexdigest()==ref_hash)
        players='<h2>초기 정상 기준</h2><audio controls src="초기기준.wav"></audio><h2>비교 결과 · 스테레오</h2><audio controls src="재현-스테레오.wav"></audio><h2>같은 생성의 한 채널 · 추가 생성 아님</h2><audio controls src="재현-모노.wav"></audio>'
        (out/'비교듣기.html').write_text('<!doctype html><meta charset="utf-8"><title>H3 초기 기준 재현</title><style>body{background:#151820;color:#eef;font:17px sans-serif;max-width:850px;margin:40px auto}audio{width:100%}</style><h1>H3 초기 기준 재현</h1><p>'+html.escape(plan['label'])+' · seed '+str(plan['seed'])+' · '+str(plan['frames'])+'프레임. 나머지 조건과 참조 A는 같습니다. 아래 모노는 같은 생성에서 뽑은 한 채널입니다.</p>'+players+'<p>'+html.escape(str(out))+'</p>',encoding='utf-8')
    except Exception as exc:report.update(status='실패',error=str(exc));raise
    finally:
        engine.release();h3_engine.prompt_for=original_prompt;h3_engine.frame_count=original_frames
        for k,v in old_env.items():
            if v is None:os.environ.pop(k,None)
            else:os.environ[k]=v
        save()

if __name__=='__main__':main()
