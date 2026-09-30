"""낭독 **상주 실행기** — 기본 목소리(Supertonic)를 한 번 열어 두고 덩이마다 소리만 만든다.

★왜 (2026-10-01 실측 · 15초 분량 한 덩이)
  조각마다 `separate.py` 를 새로 띄우면 4.8초 — 그중 합성은 3.1초이고 1.7초는 파이썬 기동·모델 열기다.
  띄워 두면 둘째 덩이부터 합성 시간만 든다(약 35% 줄어든다).
★소리는 **예전 길과 똑같다.** 같은 `separate.main()` 을 설정 파일 하나로 부른다 — 글 나누기·쉼·말끝 다듬기가
  한 벌이다. 엔진은 `tts_worker._engine_cache` 에 남아 두 번째부터 모델을 다시 열지 않는다.
★부모가 사라지면(입력이 끊기면) 스스로 끝난다.

주고받기(한 줄에 JSON 하나 — Qwen 상주 실행기와 같은 모양)
  요청: {"id": "...", "config": "<chunk.json>"}            덩이 하나
        {"id": "...", "warm": true, "model": "<스타일 파일>"}  미리 열기(소리는 만들지 않는다)
  답  : {"id": "...", "ok": true, "path": "<만든 소리>", "gen_sec": 3.1, "loaded_now": false}
        {"id": "...", "ok": false, "error": "..."}
  ★진행 줄은 내보내지 않는다 — 진행 글에는 책 글이 조금 섞인다. 답에는 사유 한 줄만 싣는다.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_OUT = sys.stdout


def reply(**kw):
    _OUT.write(json.dumps(kw, ensure_ascii=False) + "\n")
    _OUT.flush()


def _fresh_run(separate):
    """한 실행의 종결 기록을 비운다 — 한 프로세스에서 여러 번 돌기 때문이다."""
    import audio_utils
    audio_utils.reset_error_state()
    separate._RUN.update({"mode": None, "result": 0, "error": 0, "error_code": None,
                          "outputs": [], "mismatch": False, "final_emitted": False})


def main():
    import separate
    import tts_worker
    captured = []

    def capture(msg_type, **kw):
        # 결과·오류만 붙든다. 진행 줄(책 글이 섞인다)은 버린다 — 표준 출력에도 내지 않는다.
        if msg_type in ("result", "error"):
            captured.append({"type": msg_type, **kw})

    separate._emit_upstream = capture
    reply(id="", ok=True, ready=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = ""
        try:
            req = json.loads(line)
            rid = str(req.get("id", ""))
            had = "supertonic" in tts_worker._engine_cache and tts_worker._engine_cache["supertonic"]._tts is not None
            if req.get("warm"):
                eng = tts_worker._get_engine("supertonic")
                eng.load()
                reply(id=rid, ok=True, path="", gen_sec=0, loaded_now=not had)
                continue
            captured.clear()
            _fresh_run(separate)
            sys.argv = ["separate.py", "--config", str(req["config"])]
            t = time.time()
            try:
                separate.main()
            except SystemExit:
                pass
            gen = time.time() - t
            err = next((c for c in captured if c["type"] == "error"), None)
            res = next((c for c in reversed(captured) if c["type"] == "result"), None)
            path = ""
            if res:
                tracks = res.get("tracks") or []
                if tracks and isinstance(tracks[0], dict):
                    path = str(tracks[0].get("path") or "")
            if err or not path or not os.path.isfile(path):
                reply(id=rid, ok=False, error=str((err or {}).get("message") or "이 부분을 소리로 만들지 못했습니다")[:300])
                continue
            reply(id=rid, ok=True, path=path, gen_sec=round(gen, 2), loaded_now=not had)
        except Exception as e:
            reply(id=rid, ok=False, error="%s: %s" % (type(e).__name__, str(e)[:300]))
    return 0      # 입력이 끊겼다 = 부모가 닫았거나 사라졌다


if __name__ == "__main__":
    raise SystemExit(main())
