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
        {"bridge_job": {<qwen_bridge 입력 그대로>}}   ★파이프 전용(2026-10-03) — 참조 목소리 합성(낭독·카드)을 **불러 둔 모델로**.
             qwen_bridge.run_loaded 를 그대로 부르므로 분할·생성 상한·종료 판정·결과 모양이 바로 실행과 같다.
             진행 줄은 {"line": "<브리지 JSON 줄>"} 로 흘려 보내고, 끝에 {"ok": ..., "done": true, "loaded_now": ...}.
             참조 특징은 **소리 내용(지문)·전사·방식·모델**이 같을 때만 다시 쓴다(경로만으로 판정하지 않는다).
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
        self.prompts = {}          # (모델 폴더, 참조 소리, 수정 시각) → 참조 목소리 특징(한 번만 계산)
        #: 참조 목소리 작업의 참조 특징 — (모델 폴더, 소리 지문, 전사, 방식) → 특징. 오래된 것부터 버린다.
        self.ref_prompts = collections.OrderedDict()
        self.ref_hits = 0          # 참조 특징을 다시 쓴 횟수(관측용)
        self.ref_made = 0          # 새로 만든 횟수

    def prompt(self, model, model_dir, clone):
        """고정 참조 소리 → 그 목소리를 따라 읽게 하는 특징. 같은 참조는 한 번만 만든다."""
        ref = clone["ref"]
        key = (model_dir, ref, os.path.getmtime(ref))
        if key not in self.prompts:
            self.prompts[key] = model.create_voice_clone_prompt(ref_audio=ref, ref_text=clone["text"])
        return self.prompts[key]

    def get(self, model_dir):
        import torch
        import qwen_custom_voice as qcv
        if model_dir in self.loaded:
            self.loaded.move_to_end(model_dir)
            return self.loaded[model_dir], False
        while len(self.loaded) >= MAX_MODELS:
            gone, _ = self.loaded.popitem(last=False)
            self.prompts = {k: v for k, v in self.prompts.items() if k[0] != gone}
            for k in [k for k in self.ref_prompts if k[0] == gone]:
                del self.ref_prompts[k]
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        m = qcv.load(model_dir)
        self.loaded[model_dir] = m
        return m, True


#: 참조 특징을 몇 개까지 들고 있을까(참조 목소리는 보통 하나 — 여럿을 오가도 넘치지 않게).
REF_PROMPT_MAX = 8


def _ref_prompt_cache(models, model, model_dir):
    """model.create_voice_clone_prompt 를 **내용 기준 캐시**로 감싼다(멱등).
    ★열쇠 = (모델 폴더, 참조 소리 지문(sha256), 전사, 특징만 쓰는가, 그 밖의 인자) — 같은 경로라도 소리가 바뀌면 다시 만든다.
      다른 화자의 참조가 섞일 수 없다(지문이 다르다). 목록 입력·모르는 인자는 감싸지 않고 그대로 부른다."""
    import hashlib
    if getattr(model, "_af_ref_cache", False):
        return
    orig = model.create_voice_clone_prompt

    def cached(ref_audio=None, ref_text=None, x_vector_only_mode=False, **kw):
        if not isinstance(ref_audio, str) or not os.path.isfile(ref_audio) or isinstance(ref_text, list) \
                or isinstance(x_vector_only_mode, list):
            return orig(ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=x_vector_only_mode, **kw)
        with open(ref_audio, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        key = (model_dir, sha, ref_text or "", bool(x_vector_only_mode), repr(sorted(kw.items())))
        hit = models.ref_prompts.get(key)
        if hit is not None:
            models.ref_prompts.move_to_end(key)
            models.ref_hits += 1
            return hit
        made = orig(ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=x_vector_only_mode, **kw)
        models.ref_prompts[key] = made
        while len(models.ref_prompts) > REF_PROMPT_MAX:
            models.ref_prompts.popitem(last=False)
        models.ref_made += 1
        return made

    model.create_voice_clone_prompt = cached
    model._af_ref_cache = True


def _bridge_job(models, req, push):
    """참조 목소리 작업 하나 — qwen_bridge 와 같은 함수(run_loaded)를 불러 둔 모델로 돌린다."""
    import torch
    import qwen_bridge as qb
    cfg = req["bridge_job"]
    if not str(cfg.get("device", "cuda:0")).startswith("cuda") or not torch.cuda.is_available():
        # CPU 로 고른 작업은 여기서 하지 않는다 — 부르는 쪽이 원래 길(새 프로세스)로 간다.
        return dict(ok=False, done=True, error="상주 실행기는 그래픽카드 작업만 받습니다", fallback=True)
    lines = []
    qb._SINK = (lambda l: push({"line": l})) if push else lines.append
    qb._T0 = time.monotonic()
    qb._COUNTER["n"] = 0
    qb._STOP["requested"], qb._STOP["at_step"] = False, None
    stop_flag = str(cfg.get("stop_flag") or "")
    old_flag = os.environ.get(qb.DIAG_STOP_FLAG_ENV)
    if stop_flag:
        os.environ[qb.DIAG_STOP_FLAG_ENV] = stop_flag     # 협조적 정지 — 이 파일이 생기면 생성이 정상 반환한다
    else:
        os.environ.pop(qb.DIAG_STOP_FLAG_ENV, None)
    hits0, made0 = models.ref_hits, models.ref_made
    try:
        qb.emit("progress", percent=10, message="띄워 둔 Qwen 으로 만듭니다")
        qb.emit("stage", stage="loading", attn="resident", attempt=1, device="cuda:0", elapsed_sec=qb._elapsed())
        model, loaded_now = models.get(cfg["model_path"])
        _ref_prompt_cache(models, model, cfg["model_path"])
        qb.emit("stage", stage="loaded", attn="resident", attempt=1, dtype="resident", elapsed_sec=qb._elapsed())
        qb.emit("progress", percent=25, message="모델 준비됨(띄워 둔 실행기%s)" % (" · 방금 엶" if loaded_now else ""))
        try:
            rc = qb.run_loaded(model, cfg)
        except Exception as e:
            qb.emit("error", message="%s: %s" % (type(e).__name__, e))
            rc = 1
        return dict(ok=rc == 0, done=True, loaded_now=loaded_now, stopped=bool(qb._STOP["requested"]), ref_hits=models.ref_hits - hits0,
                    ref_made=models.ref_made - made0, **({} if push else {"lines": lines}))
    finally:
        qb._SINK = None
        if old_flag is None:
            os.environ.pop(qb.DIAG_STOP_FLAG_ENV, None)
        else:
            os.environ[qb.DIAG_STOP_FLAG_ENV] = old_flag


def handle(models, req, push=None):
    """요청 하나 → 답(dict, id 없이). push: 파이프 요청이면 진행 줄을 흘려 보낼 곳."""
    import numpy as np
    import soundfile as sf
    if isinstance(req.get("bridge_job"), dict):
        return _bridge_job(models, req, push)
    if isinstance(req.get("prefetch"), list):
        # 미리 읽기 — 곧바로 답하고 뒤에서 읽는다(줄을 막지 않는다).
        threading.Thread(target=_prefetch, args=(req["prefetch"],), daemon=True).start()
        return dict(ok=True, seconds=0, sample_rate=0, gen_sec=0, loaded_now=False)
    import torch
    import qwen_fast
    model, loaded_now = models.get(req["model"])
    say = _speaker(models, model, req)
    # ★협조적 정지(2026-10-03) — 낭독이 자리를 옮기거나 멈추면 본체가 이 파일을 만든다. 본 모델 반복이 16걸음 안에 멈추고,
    #   멈춘 소리는 쓰지 않는다(파일을 쓰지 않고 stopped 로 답한다). 이 요청에만 걸린다 — 다음 요청(카드 등)과 섞이지 않는다.
    qwen_fast.STOP_FILE = str(req.get("stop_flag") or "") or None
    qwen_fast.STOPPED = False
    try:
        return _handle_loaded(models, req, model, loaded_now, say)
    finally:
        qwen_fast.STOP_FILE = None


def _stopped():
    import qwen_fast
    return bool(qwen_fast.STOPPED)


def _handle_loaded(models, req, model, loaded_now, say):
    import numpy as np
    import soundfile as sf
    import torch
    if req.get("warm"):
        # 미리 열기 — 고른 순간 모델을 올려 둔다(첫 조각의 모델 열기를 누르기 전에 치른다).
        # ★막 열었으면 짧은 글을 한 번 만들어 버린다 — 첫 생성의 묶어 실행 준비(1.3초, 2026-10-02 실측)를 여기서 치른다.
        prime = 0.0
        if loaded_now and (req.get("speaker") or req.get("clone")):
            t = time.time()
            torch.manual_seed(0)
            say(PRIME_TEXT, None)
            prime = round(time.time() - t, 2)
        return dict(ok=True, seconds=0, sample_rate=0, gen_sec=0, loaded_now=loaded_now, prime_sec=prime)
    if isinstance(req.get("segments"), list):
        return _segments(model, loaded_now, req, say)
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
    wavs, sr = say(text, req.get("instruct") or None)
    gen = time.time() - t
    if _stopped():
        return dict(ok=False, stopped=True, error="멈춤 요청으로 만들기를 멈췄습니다", gen_sec=round(gen, 2), loaded_now=loaded_now)
    wav = np.asarray(wavs[0], dtype="float32").reshape(-1)
    if wav.size == 0 or not np.isfinite(wav).all():
        raise RuntimeError("소리가 비었거나 깨졌습니다")
    sf.write(req["out"], wav, int(sr), subtype="PCM_16")
    return dict(ok=True, seconds=round(wav.size / float(sr), 2), sample_rate=int(sr), gen_sec=round(gen, 2),
                loaded_now=loaded_now)


#: 낭독 감정 덩어리 사이의 쉼(초) — 덩어리 끝에도 모델이 남기는 쉼이 있어 짧게 둔다.
SEGMENT_GAP_SEC = 0.12


def _speaker(models, model, req):
    """요청 → (글, 지시) 로 소리를 만드는 함수. 고정 참조(clone)가 있으면 그 목소리를 따라, 아니면 지정 목소리(speaker)로.
    ★참조 목소리는 지시(감정)를 받지 않는다 — 지시는 버린다(화면도 이 목소리에는 감정을 켜지 않는다)."""
    lang = req.get("language", "korean")
    if req.get("clone"):
        prompt = models.prompt(model, req["model"], req["clone"])
        return lambda text, instruct: model.generate_voice_clone(text=text, language=lang, voice_clone_prompt=prompt)
    return lambda text, instruct: model.generate_custom_voice(text=text, speaker=req.get("speaker"), language=lang,
                                                                instruct=instruct)


def _segments(model, loaded_now, req, say=None):
    """감정 덩어리들 → 한 소리. 덩어리마다 같은 모델(1.7B)로 — 감정 없는 덩어리도 같은 모델이라 목소리가 바뀌지 않는다."""
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_emotions import instruct_of
    if say is None:
        say = _speaker(None, model, req)
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
        wavs, sr = say(text, instruct_of((seg or {}).get("emotion")))
        gen += time.time() - t
        if _stopped():
            return dict(ok=False, stopped=True, error="멈춤 요청으로 만들기를 멈췄습니다", gen_sec=round(gen, 2), loaded_now=loaded_now)
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
                # 진행 줄을 흘려 보낼 곳 — 처리하는 스레드가 부른다(이 스레드는 끝날 때까지 기다리기만 한다).
                work.put((req, lambda r: (box.update(r), done.set()), lambda m: conn.send(m)))
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

    def run(req, respond, push=None):
        try:
            r = handle(models, req, push)
        except Exception as e:
            r = dict(ok=False, done=True, error="%s: %s" % (type(e).__name__, str(e)[:300]))
        if push is not None:
            # ★파이프 작업(카드·참조 낭독)이 **실제로 끝났다**는 알림 — 답보다 먼저 낸다(2026-10-03).
            #   부모(본체)는 카드 취소를 이 알림까지 기다린다: 합성 프로세스가 죽어도 이 실행기는 따로 돌고 있기 때문이다.
            why = "stopped" if r.get("stopped") else ("ok" if r.get("ok") else ("error: " + str(r.get("error") or "")[:80]))
            reply(id="", pipe_busy=False, stopped=bool(r.get("stopped")), why=why)
        respond(r)

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
            req, respond, push = work.get(timeout=0.05)
        except queue.Empty:
            continue
        reply(id="", activity=True, pipe_busy=True)
        run(req, respond, push)
    try:
        if lis:
            lis.close()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
