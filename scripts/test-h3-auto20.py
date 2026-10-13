"""승인된 참조A로 자동 계산된 약20초 대사1개만 시험. 제품 기본 추론 경로."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from h3_engine import H3Engine,split_text,frame_count,diagnostic_settings
from h3_timing import estimate
TEXT='오늘은 오랜만에 친구와 조용한 길을 걸었어요. 바람이 조금 차가웠지만, 함께 이야기를 나누니 마음은 따뜻했어요. 집에 돌아와 창문을 열고 잠시 쉬면서, 내일은 더 편안한 하루가 되기를 바랐어요. 오늘의 기억을 오래 간직하고 싶어요. 다음에도 함께 이런 시간을 보내고 싶어요.'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--approve-reference',action='store_true');parser.add_argument('--reference');parser.add_argument('--out');args=parser.parse_args()
    budget=estimate(TEXT)
    if len(split_text(TEXT))!=1 or frame_count(TEXT)!=481:raise ValueError('자동20초 시험 계획 불일치')
    if not args.execute:print(json.dumps({'text':TEXT,'budget':budget},ensure_ascii=False,indent=2));return
    if not args.approve_reference or not args.reference or not args.out:parser.error('참조 승인·경로·새 저장폴더 필요')
    if os.environ.get('AF_H3_PIPE_ADDR') or diagnostic_settings()['canvas']!=256:parser.error('기본256 독립 시험 환경 필요')
    import app_runtime
    root=Path(app_runtime.assets_root()).resolve().parent/'_local'/'테스트'/'결과';out=Path(args.out).resolve()
    if not out.is_relative_to(root) or out==root or out.exists():parser.error('검사 결과 아래 새 폴더 필요')
    ref=Path(args.reference);data=ref.read_bytes();sha=hashlib.sha256(data).hexdigest()
    if sha!='ace9ac3bb65798a729b65d2a768e67e73cb10c832b033dff3804445b18b1a10e':raise ValueError('승인된 참조A와 다름')
    out.mkdir(parents=True);snapshot=out/'참조.wav';snapshot.write_bytes(data)
    report={'text':TEXT,'budget':budget,'seed':2024,'reference_sha256':sha,'status':'진행 중'}
    engine=H3Engine();engine.run_seed=2024;started=time.monotonic()
    try:
        engine.load();decode=engine.ops.vae_decode_audio
        def capture(*args,**kwargs):
            result=decode(*args,**kwargs)
            import soundfile as sf
            wave=result['waveform'][0].float().cpu().numpy().T
            sf.write(out/'스테레오.wav',wave,result['sample_rate'],subtype='FLOAT')
            return result
        engine.ops.vae_decode_audio=capture;engine.progress=lambda msg:print(json.dumps(msg,ensure_ascii=False),flush=True)
        engine.synthesize_segment(TEXT,str(snapshot),'default',1,str(out/'자동20초.wav'))
        report.update(status='생성 완료·청취 대기',seconds=time.monotonic()-started,record=engine.records[-1],reference_unchanged=hashlib.sha256(ref.read_bytes()).hexdigest()==sha)
        if report['record']['chunks'][0]['frames']!=481:raise ValueError('실제 생성 프레임 불일치')
        (out/'듣기.html').write_text('<!doctype html><meta charset="utf-8"><title>H3 자동 시간 계산 시험</title><style>body{background:#151820;color:#eef;font:17px sans-serif;max-width:850px;margin:40px auto}audio{width:100%}p{line-height:1.8}</style><h1>자동 계산·약20초</h1><p>'+html.escape(TEXT)+'</p><h2>앱 방식 · 한 채널</h2><audio controls src="자동20초.wav"></audio><h2>같은 생성 · 스테레오</h2><audio controls src="스테레오.wav"></audio><p>마지막 문장까지 들리는지,엉뚱한 대사·반복·목소리 변질이 있는지 확인해 주세요.</p><p>'+html.escape(str(out))+'</p>',encoding='utf-8')
    except Exception as exc:report.update(status='실패',error=str(exc));raise
    finally:
        engine.release();(out/'측정.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
