# -*- coding: utf-8 -*-
"""입력 분석 **상주 worker** — 타이핑마다 프로세스를 새로 띄우지 않기 위한 것.

프로토콜
--------
stdin 한 줄 = 요청 JSON, stdout 한 줄 = 응답 JSON. 그 외에는 stdout 에 아무것도 쓰지 않는다
(로그는 stderr 로만 가고, 거기에도 **원문 전문을 넣지 않는다**).

  요청  {"type":"analyze","request_id":"...","text":"...","mode":"high_quality_icl",
         "reference_conditioning_mode":"high_quality_icl","source_sha256":"..."}
  응답  {"type":"analysis","request_id":"...","ok":true, ...input_analysis.analyze 결과}
        {"type":"analysis","request_id":"...","ok":false,"code":"...","message":"..."}
        {"type":"ready","tokenizer":"production|approximate", ...}

무엇을 하지 않는가
------------------
GPU 를 쓰지 않고 TTS 모델을 로드하지 않는다. 필요한 것은 **tokenizer** 뿐이고 그마저도 첫
분석 요청에서 지연 로드한다. tokenizer 를 못 얻으면 분석을 포기하지 않고 근사 토큰으로
답하되 `TOKENIZER_UNAVAILABLE` 경고와 낮은 신뢰도를 함께 낸다 — 편집을 막지 않는 쪽이 낫다.

낡은 요청 — 무엇을 보장하고 무엇을 보장하지 않는가
--------------------------------------------------
`{"type":"drop_before","request_seq":N}` 은 **아직 시작하지 않은 대기 요청**을 건너뛰게 한다.
이미 계산에 들어간 요청은 단일 프로세스 구조상 중간에서 끊기지 않고 끝까지 간다(분석은
짧으므로 그대로 두는 편이 낫다 — 강제로 끊자고 worker 를 죽이지 않는다).

따라서 **이미 계산된 낡은 응답을 버리는 것은 drop_before 가 아니라** 호출부의 몫이다.
main 과 renderer 가 `request_id` 와 원문 SHA 로 판정한다. worker 는 두 값을 그대로 실어
보내 거짓말하지 않는 것만 맡는다.

`{"type":"prewarm"}` 은 **사용자 텍스트 없이** tokenizer 만 미리 로드한다. 첫 분석의 콜드
로드(실측 약 7.9초)를 사용자가 타이핑을 시작하기 전으로 옮기기 위한 것이고, 실패해도
`ok:false` 를 돌려줄 뿐 이후 분석을 막지 않는다.
"""
import hashlib
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import input_analysis  # noqa: E402

PROTOCOL_VERSION = 1
TOKENIZER_PRODUCTION = "production"
TOKENIZER_APPROXIMATE = "approximate"

_LOCK = threading.Lock()
_STATE = {"proc": None, "kind": None, "load_error": None}


def _log(message, **fields):
    """stderr 진단. 대사 원문·절대경로를 넣지 않는다."""
    try:
        payload = {"type": "log", "message": str(message)}
        payload.update({k: v for k, v in fields.items() if v is not None})
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + chr(10))
        sys.stderr.flush()
    except Exception:
        pass


def _model_dir():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ("qwen3_tts_1_7b_base", "qwen3_tts_0_6b_base"):
        p = os.path.join(root, "externals", name)
        if os.path.isdir(p):
            return p
    return None


def _load_tokenizer():
    """production tokenizer 를 **지연 로드**한다. 모델 가중치는 건드리지 않는다."""
    with _LOCK:
        if _STATE["kind"] is not None:
            return _STATE["kind"]
        path = _model_dir()
        if not path:
            _STATE["kind"] = TOKENIZER_APPROXIMATE
            _STATE["load_error"] = "MODEL_DIR_NOT_FOUND"
            return _STATE["kind"]
        try:
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            from transformers import AutoProcessor
            _STATE["proc"] = AutoProcessor.from_pretrained(path, trust_remote_code=True)
            _STATE["kind"] = TOKENIZER_PRODUCTION
        except Exception as exc:               # 설치 상태가 어떻든 편집을 막지 않는다
            _STATE["kind"] = TOKENIZER_APPROXIMATE
            _STATE["load_error"] = type(exc).__name__
            _log("tokenizer 지연 로드 실패", reason=type(exc).__name__)
        return _STATE["kind"]


#: 근사 토큰 계수 — production tokenizer 를 못 쓸 때만 쓴다. 이 값이 쓰였다는 사실은
#: 응답의 `tokenizer` 와 `TOKENIZER_UNAVAILABLE` 경고로 항상 드러난다.
_APPROX_CHARS_PER_TOKEN = 1.0


def _count_tokens(text):
    """production 과 같은 assistant template 로 센다(qwen_bridge._prod_tokens 와 같은 형태)."""
    kind = _load_tokenizer()
    if kind == TOKENIZER_PRODUCTION:
        nl = chr(10)
        wrapped = ("<|im_start|>assistant" + nl + (text or "") + "<|im_end|>" + nl
                   + "<|im_start|>assistant" + nl)
        try:
            ids = _STATE["proc"](text=wrapped, return_tensors="pt")["input_ids"]
            return int(ids.shape[-1])
        except Exception as exc:
            _log("토큰 계산 실패 — 근사로 내려간다", reason=type(exc).__name__)
    return max(1, int(round(len(text or "") / _APPROX_CHARS_PER_TOKEN)))


def _replay_frames(reference_conditioning_mode):
    """legacy controlled-prefix 만 참조를 재발화한다. vendor native 는 0 이다."""
    if os.environ.get("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX") == "1" and \
            reference_conditioning_mode == "high_quality_icl":
        return 83
    return 0


def handle(req):
    """요청 하나를 처리한다. 예외를 밖으로 내지 않는다 — 응답으로 바꾼다."""
    rid = req.get("request_id")
    text = req.get("text") or ""
    mode = req.get("mode") or "high_quality_icl"
    rc_mode = req.get("reference_conditioning_mode") or mode
    base = {"type": "analysis", "request_id": rid,
            "protocol_version": PROTOCOL_VERSION,
            "source_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    claimed = req.get("source_sha256")
    if claimed and claimed != base["source_sha256"]:
        return dict(base, ok=False, code="SOURCE_SHA_MISMATCH",
                    message="요청 본문과 SHA 가 일치하지 않습니다")
    try:
        result = input_analysis.analyze(
            text, _count_tokens, mode=mode,
            reference_replay_frames=_replay_frames(rc_mode))
    except Exception as exc:
        return dict(base, ok=False, code=getattr(exc, "code", type(exc).__name__),
                    message=type(exc).__name__)
    kind = _STATE["kind"] or TOKENIZER_APPROXIMATE
    if kind != TOKENIZER_PRODUCTION:
        result = dict(result)
        result["warnings"] = list(result.get("warnings") or []) + ["TOKENIZER_UNAVAILABLE"]
        result["confidence"] = input_analysis.CONFIDENCE_INSUFFICIENT
        result["confidence_reason"] = "TOKENIZER_UNAVAILABLE"
        result["estimated_wall_seconds"] = None
    out = dict(base, ok=True, tokenizer=kind)
    out.update(result)
    out["source_sha256"] = base["source_sha256"]     # 분석 결과가 덮어쓰지 않게 고정
    return out


def main():
    sys.stdout.write(json.dumps({"type": "ready", "protocol_version": PROTOCOL_VERSION,
                                 "pid": os.getpid()}, ensure_ascii=False) + chr(10))
    sys.stdout.flush()
    drop_before = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue                        # 깨진 줄은 조용히 버린다(원문을 로그에 남기지 않는다)
        kind = req.get("type")
        if kind == "shutdown":
            break
        if kind == "prewarm":
            # 사용자 텍스트 없이 tokenizer 만 데운다. GPU·모델은 건드리지 않는다.
            loaded = _load_tokenizer()
            sys.stdout.write(json.dumps(
                {"type": "prewarm", "protocol_version": PROTOCOL_VERSION,
                 "ok": loaded == TOKENIZER_PRODUCTION, "tokenizer": loaded,
                 "reason": _STATE.get("load_error")}, ensure_ascii=False) + chr(10))
            sys.stdout.flush()
            continue
        if kind == "drop_before":
            try:
                drop_before = max(drop_before, int(req.get("request_seq") or 0))
            except Exception:
                pass
            continue
        if kind != "analyze":
            continue
        try:
            seq = int(req.get("request_seq") or 0)
        except Exception:
            seq = 0
        if seq and seq < drop_before:
            # 아직 시작하지 않은 대기 요청이 낡았다 — 계산을 생략하고 그 사실만 알린다.
            # (이미 계산 중인 요청에는 해당하지 않는다. 그건 호출부가 SHA 로 버린다.)
            resp = {"type": "analysis", "request_id": req.get("request_id"),
                    "protocol_version": PROTOCOL_VERSION, "ok": False, "code": "SUPERSEDED"}
        else:
            resp = handle(req)
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + chr(10))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
