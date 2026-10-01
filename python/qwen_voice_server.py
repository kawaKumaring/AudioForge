"""Qwen 지정 목소리 **상주 실행기** — 모델을 한 번 불러 두고 요청마다 소리만 만든다.

★왜 (2026-09-30 실측): 조각마다 프로세스를 새로 띄우면 모델 열기·묶어 실행 준비에 약 10초가 매번 든다
  (10.6초 분량이 20초 — 그중 생성은 10초). 띄워 두면 그 10초는 첫 조각에만 든다 → 읽는 속도보다 빨라진다.
★격리 환경(externals/qwen3_tts_venv)의 파이썬으로 돈다. 앱 본체(reader)가 하나만 띄워 관리한다.
★부모가 사라지면(입력이 끊기면) 스스로 끝난다 — 그래픽카드 메모리를 붙든 고아로 남지 않는다.

★두 번째 입구 — **이름 있는 파이프**(2026-10-01, 감정 생성 시간 줄이기)
  생성 카드는 본체가 아니라 합성 프로세스(separate.py → tts_worker)가 Qwen 을 부른다. 그 프로세스는 생성마다 새로 뜨고,
  예전에는 **조각마다** qwen_custom_voice.py 를 띄워 모델(1.7B)을 매번 열었다(한 번에 30~60초).
  본체가 이 실행기를 띄울 때 파이프 주소·열쇠(실행마다 새로 만든 값)를 넘기면, 합성 프로세스가 여기로 요청을 보낸다.
  ★이 컴퓨터 안의 프로세스 사이 통로다(네트워크가 아니다). 열쇠가 맞아야 붙는다.
  ★요청은 한 줄로 차례대로 처리한다 — 낭독(표준 입력)과 카드(파이프)가 겹쳐도 GPU 에는 하나씩.
  ★파이프 요청을 처리할 때마다 {"activity": true} 를 내보낸다 — 부모가 '한동안 안 씀' 으로 내리지 않게.
  ★모델은 둘까지 들고 있는다(빠른 0.6B · 감정 1.7B) — 낭독과 카드가 번갈아도 다시 열지 않는다.

주고받기(표준 입력: 한 줄에 JSON 하나 · 파이프: 같은 모양의 dict)
  요청: {"id": "...", "model": "<폴더>", "speaker": "sohee", "language": "korean", "text_file": "<글.txt>"(또는 "text"),
         "out": "<소리.wav>", "seed": 0, "instruct": "<영어 감정 지시 · 1.7B 만>"}
        {"id": "...", "model": "<폴더>", "warm": true}   미리 열기(소리는 만들지 않는다)
        {"id": "...", "model": "<1.7B 폴더>", "speaker": ..., "segments": [{"text": "...", "emotion": "happy"}, ...], "out": ...}
             낭독 감정(2026-10-01) — 덩어리마다 감정 지시로 만들어 짧은 쉼을 두고 한 파일로 잇는다.
  답  : {"id": "...", "ok": true, "seconds": 10.6, "sample_rate": 24000, "gen_sec": 9.8, "loaded_now": false}
        {"id": "...", "ok": false, "error": "..."}
  그 밖의 줄(라이브러리가 찍는 경고 등)은 부모가 무시한다 — 답은 id 로 짝짓는다.
"""
import collections
import json
import os
import queue
import sys
import threading
import time

_OUT_LOCK = threading.Lock()


def reply(**kw):
    with _OUT_LOCK:
        sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
        sys.stdout.flush()


MAX_MODELS = max(1, int(os.environ.get("AF_QWEN_MAX_MODELS", "2") or 2))
#: 미리 열기에서 한 번 만들어 버리는 짧은 글(첫 덩이와 같은 길이대 — 같은 묶어 실행 칸을 쓴다).
PRIME_TEXT = "준비하고 있습니다."


def _preimport():
    """라이브러리를 미리 불러 둔다 — 그래픽카드 메모리는 잡지 않는다(모델은 요청이 와야 연다).
    ★왜 (2026-10-02 실측): 모델 열기 13초 중 torch 1.9초 + qwen_tts 4.6초가 불러오기였다. 목록을 여는 순간 띄우면 고를 때는 모델만 연다."""
    try:
        import torch  # noqa: F401
        import qwen_custom_voice  # noqa: F401
        from qwen_tts import Qwen3TTSModel  # noqa: F401
    except Exception as e:      # 못 불러오면 요청 때 다시 시도한다(그때 오류가 답으로 간다)
        sys.stderr.write("[qwen_voice_server] 미리 불러오기 실패: %s\n" % e)


def _prefetch(dirs):
    """모델 파일을 미리 한 번 읽어 둔다(운영체제가 메모리에 붙들어 둔다) — 그래픽카드는 쓰지 않는다.
    ★왜 (2026-10-02 실측): 디스크 읽기 0.53GB/s — 1.7B(3.8GB)를 처음 열면 7.3초가 더 든다. 목록을 보는 동안 읽어 둔다."""
    buf = bytearray(16 << 20)
    for d in dirs:
        for root, _, files in os.walk(str(d)):
            for f in files:
                if f.endswith((".safetensors", ".bin", ".pt")):
                    try:
                        with open(os.path.join(root, f), "rb", buffering=0) as fh:
                            while fh.readinto(buf):
                                pass
                    except OSError:
                        pass


class Models:
    """모델 폴더 → 불러 둔 모델. 넘치면 가장 오래 안 쓴 것부터 내린다."""

    def __init__(self):
        self.loaded = collections.OrderedDict()

    def get(self, model_dir):
        import torch
        import qwen_custom_voice as qcv
        if model_dir in self.loaded:
            self.loaded.move_to_end(model_dir)
            return self.loaded[model_dir], False
        while len(self.loaded) >= MAX_MODELS:
            self.loaded.popitem(last=False)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        m = qcv.load(model_dir)
        self.loaded[model_dir] = m
        return m, True


def handle(models, req):
    """요청 하나 → 답(dict, id 없이)."""
    import numpy as np
    import soundfile as sf
    if isinstance(req.get("prefetch"), list):
        # 미리 읽기 — 곧바로 답하고 뒤에서 읽는다(줄을 막지 않는다).
        threading.Thread(target=_prefetch, args=(req["prefetch"],), daemon=True).start()
        return dict(ok=True, seconds=0, sample_rate=0, gen_sec=0, loaded_now=False)
    import torch
    model, loaded_now = models.get(req["model"])
    if req.get("warm"):
        # 미리 열기 — 고른 순간 모델을 올려 둔다(첫 조각의 모델 열기를 누르기 전에 치른다).
        # ★막 열었으면 짧은 글을 한 번 만들어 버린다 — 첫 생성의 묶어 실행 준비(1.3초, 2026-10-02 실측)를 여기서 치른다.
        prime = 0.0
        if loaded_now and req.get("speaker"):
            t = time.time()
            torch.manual_seed(0)
            model.generate_custom_voice(text=PRIME_TEXT, speaker=req["speaker"], language=req.get("language", "korean"))
            prime = round(time.time() - t, 2)
        return dict(ok=True, seconds=0, sample_rate=0, gen_sec=0, loaded_now=loaded_now, prime_sec=prime)
    if isinstance(req.get("segments"), list):
        return _segments(model, loaded_now, req)
    if "text" in req:
        text = str(req["text"] or "").strip()
    else:
        with open(req["text_file"], encoding="utf-8") as f:
            text = f.read().strip()
    if not text:
        raise RuntimeError("읽을 글이 없습니다")
    seed = int(req.get("seed", 0))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    t = time.time()
    wavs, sr = model.generate_custom_voice(text=text, speaker=req["speaker"], language=req.get("language", "korean"),
                                           instruct=(req.get("instruct") or None))
    gen = time.time() - t
    wav = np.asarray(wavs[0], dtype="float32").reshape(-1)
    if wav.size == 0 or not np.isfinite(wav).all():
        raise RuntimeError("소리가 비었거나 깨졌습니다")
    sf.write(req["out"], wav, int(sr), subtype="PCM_16")
    return dict(ok=True, seconds=round(wav.size / float(sr), 2), sample_rate=int(sr), gen_sec=round(gen, 2),
                loaded_now=loaded_now)


#: 낭독 감정 덩어리 사이의 쉼(초) — 덩어리 끝에도 모델이 남기는 쉼이 있어 짧게 둔다.
SEGMENT_GAP_SEC = 0.12


def _segments(model, loaded_now, req):
    """감정 덩어리들 → 한 소리. 덩어리마다 같은 모델(1.7B)로 — 감정 없는 덩어리도 같은 모델이라 목소리가 바뀌지 않는다."""
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_emotions import instruct_of
    seed = int(req.get("seed", 0))
    pieces, sr, gen, made = [], 24000, 0.0, 0
    for seg in req["segments"]:
        text = str((seg or {}).get("text") or "").strip()
        if not text:
            continue
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        t = time.time()
        wavs, sr = model.generate_custom_voice(text=text, speaker=req["speaker"], language=req.get("language", "korean"),
                                               instruct=instruct_of((seg or {}).get("emotion")))
        gen += time.time() - t
        w = np.asarray(wavs[0], dtype="float32").reshape(-1)
        if w.size == 0 or not np.isfinite(w).all():
            raise RuntimeError("소리가 비었거나 깨졌습니다")
        if pieces:
            pieces.append(np.zeros(int(SEGMENT_GAP_SEC * int(sr)), dtype="float32"))
        pieces.append(w)
        made += 1
    if not pieces:
        raise RuntimeError("읽을 글이 없습니다")
    wav = np.concatenate(pieces)
    sf.write(req["out"], wav, int(sr), subtype="PCM_16")
    return dict(ok=True, seconds=round(wav.size / float(sr), 2), sample_rate=int(sr), gen_sec=round(gen, 2),
                loaded_now=loaded_now, segments=made)


def _pipe_listener(work):
    """파이프 입구 — 붙은 연결마다 요청을 받아 같은 줄에 세우고, 답을 그 연결로 돌려준다."""
    addr = os.environ.get("AF_QWEN_PIPE_ADDR", "")
    key = os.environ.get("AF_QWEN_PIPE_KEY", "")
    if not (addr and key):
        return None
    from multiprocessing.connection import Listener
    lis = Listener(address=addr, family="AF_PIPE", authkey=key.encode("utf-8"))

    def serve(conn):
        try:
            while True:
                req = conn.recv()
                if not isinstance(req, dict):
                    break
                done = threading.Event()
                box = {}
                work.put((req, lambda r: (box.update(r), done.set()), True))
                done.wait()
                conn.send(box)
        except (EOFError, OSError):
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def accept():
        while True:
            try:
                conn = lis.accept()
            except Exception:
                return          # 닫혔다(실행기가 끝난다) 또는 열쇠가 틀렸다 — 열쇠 틀림은 그 연결만 끊긴다
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return lis


class _Stdin:
    """표준 입력을 **막히지 않게** 읽는다.

    ★왜 (2026-10-01 실측 · 카드 감정 한 번에 약 200초): 처음엔 다른 스레드가 표준 입력을 늘 읽고(막힌 채 기다리고) 있었다.
      윈도우에서는 한 스레드가 동기 파이프를 읽느라 막혀 있으면, 다른 스레드가 그 손잡이를 건드리는 일(새 DLL 의 초기화 등 —
      모델·GPU 라이브러리를 여는 동안 일어난다)이 **그 읽기가 끝날 때까지** 멈춘다. 그래서 모델 열기가 부모가 '한동안 안 씀'(3분)으로
      입력을 닫을 때까지 멈춰 있었다. 이제 들어온 바이트가 있을 때만 읽는다(PeekNamedPipe) — 막힌 읽기가 없다.
    """

    def __init__(self):
        self.fd = sys.stdin.fileno()
        self.buf = b""
        self.eof = False
        self.handle = None
        if os.name == "nt":
            import msvcrt
            self.handle = msvcrt.get_osfhandle(self.fd)

    def _available(self):
        if self.handle is not None:
            import _winapi
            try:
                return _winapi.PeekNamedPipe(self.handle, 0)[0]
            except OSError:
                self.eof = True          # 부모가 닫았다
                return 0
        import select
        r, _, _ = select.select([self.fd], [], [], 0)
        return 65536 if r else 0

    def lines(self):
        """지금 들어와 있는 완전한 줄들(막히지 않는다). 끊기면 eof 가 선다."""
        n = self._available()
        if n:
            chunk = os.read(self.fd, n)
            if not chunk:
                self.eof = True
            self.buf += chunk
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            out.append(line.decode("utf-8", "replace").strip())
        return [x for x in out if x]


def main():
    work = queue.Queue()
    models = Models()
    stdin = _Stdin()

    def run(req, respond):
        try:
            respond(handle(models, req))
        except Exception as e:
            respond(dict(ok=False, error="%s: %s" % (type(e).__name__, str(e)[:300])))

    lis = None
    try:
        lis = _pipe_listener(work)
    except Exception as e:      # 파이프를 못 열면 표준 입력만 — 카드는 예전 길로 돌아간다
        sys.stderr.write("[qwen_voice_server] 파이프를 열지 못했습니다: %s\n" % e)
    reply(id="", ok=True, ready=True, pipe=bool(lis))
    # 준비 신호 뒤에 **따로** 불러온다 — 미리 읽기 요청을 곧바로 받게. 모델을 여는 요청은 같은 모듈을 불러오다
    #   파이썬의 불러오기 잠금에서 이 스레드가 끝나길 기다린다(두 번 불러오지 않는다).
    threading.Thread(target=_preimport, daemon=True).start()
    # ★한 스레드(여기)가 차례로 처리한다 — 표준 입력 요청과 파이프 요청이 겹쳐도 GPU 에는 하나씩.
    while not stdin.eof:
        for line in stdin.lines():
            try:
                req = json.loads(line)
            except Exception:
                continue
            rid = str(req.get("id", ""))
            run(req, lambda r, rid=rid: reply(id=rid, **r))
        try:
            req, respond, _ = work.get(timeout=0.05)
        except queue.Empty:
            continue
        reply(id="", activity=True)
        run(req, respond)
    try:
        if lis:
            lis.close()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
