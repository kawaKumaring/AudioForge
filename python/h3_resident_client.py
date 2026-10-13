"""앱 소유 로컬 이름 있는 파이프. 생성 음성 재사용·네트워크·조용한 대체 없음."""
import json
import os
import time
from pathlib import Path

def synthesize(text,ref,emotion,speed,out,seed):
    from multiprocessing.connection import Client
    addr=os.environ['AF_H3_PIPE_ADDR'];key=os.environ['AF_H3_PIPE_KEY']
    request={'text':text,'ref':ref,'emotion':emotion,'speed':speed,'out':out,'seed':int(seed),
             'stop_file':os.environ.get('AF_QWEN_STOP_FILE','')}
    try:
        with Client(addr,family='AF_PIPE',authkey=key.encode()) as conn:
            conn.send(request);deadline=time.monotonic()+600
            while time.monotonic()<deadline:
                if not conn.poll(min(10,max(.01,deadline-time.monotonic()))):continue
                reply=conn.recv()
                if 'progress' in reply:
                    print(json.dumps(reply['progress'],ensure_ascii=False),flush=True);continue
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
