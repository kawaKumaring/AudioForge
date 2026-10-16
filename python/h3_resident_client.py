"""앱 소유 로컬 이름 있는 파이프. 생성 음성 재사용·네트워크·조용한 대체 없음."""
import json
import os
import time
from pathlib import Path

IDLE_SEC=600

def synthesize(text,ref,emotion,speed,out,seed,direction='',segment=(0,1)):
    from multiprocessing.connection import Client
    addr=os.environ['AF_H3_PIPE_ADDR'];key=os.environ['AF_H3_PIPE_KEY']
    request={'text':text,'ref':ref,'emotion':emotion,'speed':speed,'out':out,'seed':int(seed),
             'stop_file':os.environ.get('AF_QWEN_STOP_FILE',''),'direction':direction,'segment':[int(segment[0]),int(segment[1])]}
    try:
        with Client(addr,family='AF_PIPE',authkey=key.encode()) as conn:
            # ★응답 대기는 '마지막 소식 이후' 600초다(2026-10-16). 예전에는 문장 하나 전체가 600초 고정이라
            #   긴 문단은 단계마다 진행 소식이 와도 10분에 끊겼다. 진짜로 멈추면(소식 없음) 여전히 600초에 끊긴다.
            conn.send(request);deadline=time.monotonic()+IDLE_SEC
            while time.monotonic()<deadline:
                if not conn.poll(min(10,max(.01,deadline-time.monotonic()))):continue
                reply=conn.recv()
                if 'progress' in reply:
                    print(json.dumps(reply['progress'],ensure_ascii=False),flush=True);deadline=time.monotonic()+IDLE_SEC;continue
                if not reply.get('ok'):
                    error=RuntimeError(reply.get('error','H3 상주 생성 실패'))
                    error.error_payload={'code':reply.get('code','H3_GENERATION_FAILED')};raise error
                if not Path(out).is_file():raise RuntimeError('H3 상주 결과 파일이 없습니다')
                return reply['record']
            raise TimeoutError('H3 상주 실행기 응답 시간이 초과됐습니다')
    except RuntimeError:raise
    except Exception as exc:
        error=RuntimeError(f'H3 상주 연결 실패: {type(exc).__name__}: {exc}')
        error.error_payload={'code':'H3_RESIDENT_FAILED'};raise error from exc
