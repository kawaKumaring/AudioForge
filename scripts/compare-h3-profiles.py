"""생성은 명시적 실행·참조 승인 때만. 기본 실행은 계획 출력만 한다."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from h3_engine import diagnostic_settings

PROFILES=[('기준',256,'auto'),('중간',128,'auto'),('작게',64,'auto'),('계산방식',256,'pytorch')]
TEXT='오늘은 하루 종일 비가 와서 조금 우울했는데, 저녁에 친구가 찾아와서 따뜻한 차를 마시며 이야기를 나누니까 기분이 정말 좋아졌어요.'

def plan(seed):
    return [{'label':label,'seed':seed,'text':TEXT,'steps':16,'cfg':1,'sampler':'res_multistep',
             **diagnostic_settings({'AF_H3_DIAGNOSTIC':'1','AF_H3_DIAGNOSTIC_CANVAS':str(canvas),'AF_H3_DIAGNOSTIC_ATTENTION':attention})}
            for label,canvas,attention in PROFILES]

def main():
    parser=argparse.ArgumentParser(description='H3 비교 계획·승인된 생성')
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--approve-reference',action='store_true')
    parser.add_argument('--reference');parser.add_argument('--out');parser.add_argument('--seed',type=int,default=2024)
    args=parser.parse_args()
    if not 0<=args.seed<2**31-1:parser.error('seed 범위를 확인하세요')
    variants=plan(args.seed)
    if not args.execute:
        print(json.dumps({'status':'계획만·파일 읽기 및 생성 없음','profiles':variants},ensure_ascii=False,indent=2));return
    if not args.approve_reference or not args.reference or not args.out:parser.error('생성에는 참조 승인·참조 경로·새 결과 폴더가 필요합니다')
    out=Path(args.out).resolve()
    # 외부 모델 연결은 정리 대상으로 쓰지 않는다. 결과는 지정된 검사 저장소에만 둔다.
    import app_runtime
    test_root=Path(app_runtime.assets_root()).resolve().parent/'_local'/'테스트'/'결과'
    if not out.is_relative_to(test_root.resolve()) or out==test_root.resolve():parser.error('결과 폴더는 master의 _local/테스트/결과 아래 새 폴더여야 합니다')
    if out.exists():parser.error('기존 결과는 덮지 않습니다')
    if os.environ.get('AF_H3_PIPE_ADDR'):parser.error('다른 상주 실행기로 보내지 않도록 독립 검사 환경에서 실행하세요')
    reference=Path(args.reference).resolve();ref_bytes=reference.read_bytes()
    report={'reference_sha256':hashlib.sha256(ref_bytes).hexdigest(),'profiles':variants,'runs':[],'status':'진행 중'}
    out.mkdir(parents=True);snapshot=out/'참조.wav';snapshot.write_bytes(ref_bytes)
    from h3_engine import H3Engine
    engine=H3Engine()  # 각 조건의 모델 상태를 보존하지 않음. 런타임·OS 캐시는 남으므로 총시간의 순서 효과는 명시한다.
    try:
        for index,variant in enumerate(variants):
            os.environ.update(AF_H3_DIAGNOSTIC='1',AF_H3_DIAGNOSTIC_CANVAS=str(variant['canvas']),AF_H3_DIAGNOSTIC_ATTENTION=variant['attention_requested'])
            engine.run_seed=args.seed;engine.records=[];dest=out/f'비교-{index+1}.wav';started=time.monotonic()
            engine.synthesize_segment(TEXT,str(snapshot),'default',1,str(dest))
            report['runs'].append({'path':str(dest),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'wall_seconds':time.monotonic()-started,'record':engine.records[-1]})
            (out/'측정.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        report['status']='생성 완료·청취 대기'
        players=''.join(f'<h2>{html.escape(v["label"])} · {v["canvas"]}</h2><audio controls src="비교-{i+1}.wav"></audio>' for i,v in enumerate(variants))
        (out/'비교듣기.html').write_text('<!doctype html><meta charset="utf-8"><title>H3 설정 비교</title><style>body{background:#151820;color:#eef;font:17px sans-serif;max-width:850px;margin:40px auto}audio{width:100%}</style><h1>H3 설정 비교</h1><p>같은 대사·참조·seed. 발음, 목소리, 말끝을 직접 비교하세요. 총시간에는 실행 순서와 캐시 효과가 포함됩니다.</p>'+players+'<p>'+html.escape(str(out))+'</p>',encoding='utf-8')
    except Exception as exc:
        report['status']='실패';report['error']=str(exc);raise
    finally:
        engine.release();(out/'측정.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
