"""H3 한 프로세스·한 요청씩. GPU 모델과 조건 한 벌만 재사용한다."""
import json
import os
import sys
import threading
import time
from multiprocessing.connection import Listener
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from qwen_voice_server import _Stdin  # 기존의 Windows 비차단 부모 수명 감시
from h3_engine import H3Engine

def run_request(engine,req,progress):
    engine.records=[];engine.run_seed=int(req['seed']);engine.stop_file=str(req.get('stop_file') or '')
    engine.progress=progress;engine.direction=req.get('direction','')
    seg=req.get('segment') or [0,1];engine.segment_pos=(int(seg[0]),max(1,int(seg[1])))
    try:
        engine.synthesize_segment(req['text'],req['ref'],req.get('emotion'),req['speed'],req['out'])
        return {'ok':True,'record':engine.records[-1]}
    except Exception as exc:
        code=getattr(exc,'error_payload',{}).get('code','H3_GENERATION_FAILED')
        return {'ok':False,'error':str(exc),'code':code,'stopped':code=='H3_STOPPED'}
    finally:engine.stop_file='';engine.progress=None;engine.direction='';engine.segment_pos=(0,1)

def main():
    os.environ['AF_H3_SERVER']='1'
    engine=H3Engine();engine.keep_loaded=True
    lock=threading.Lock();busy=threading.Event();control=_Stdin()
    def emit(**fields):
        with lock:sys.stdout.write(json.dumps(fields,ensure_ascii=False)+'\n');sys.stdout.flush()
    def watch():
        last=0
        while True:
            control.lines()
            if control.eof:os._exit(0)  # 부모가 사라지면 GPU 작업도 함께 끝난다.
            if busy.is_set() and time.monotonic()-last>=5:
                emit(activity=True,pipe_busy=True);last=time.monotonic()
            time.sleep(.1)
    threading.Thread(target=watch,daemon=True).start()
    listener=Listener(os.environ['AF_H3_PIPE_ADDR'],family='AF_PIPE',authkey=os.environ['AF_H3_PIPE_KEY'].encode())
    emit(ready=True)
    try:
        while True:
            try:conn=listener.accept()
            except Exception:continue  # 잘못된 열쇠는 그 연결만 거부한다.
            with conn:
                try:req=conn.recv()
                except (EOFError,OSError):continue
                busy.set();emit(activity=True,pipe_busy=True)
                disconnected=threading.Event()
                def progress(msg):
                    if disconnected.is_set():
                        error=RuntimeError('H3 요청 연결이 닫혔습니다');error.error_payload={'code':'H3_STOPPED'};raise error
                    try:conn.send({'progress':msg})
                    except (EOFError,OSError):
                        disconnected.set();error=RuntimeError('H3 요청 연결이 닫혔습니다');error.error_payload={'code':'H3_STOPPED'};raise error
                result=run_request(engine,req,progress)
                # 실행 종료를 먼저 알린다. 이 이후에는 GPU 생성 작업·파일 쓰기가 없다.
                busy.clear();emit(pipe_busy=False,stopped=bool(result.get('stopped')),why='ok' if result['ok'] else result.get('code'))
                try:conn.send(result)
                except (EOFError,OSError):pass
    finally:engine.release();listener.close()

if __name__=='__main__':main()
