#!/usr/bin/env python3
"""C1(장문 job 안정성) E2E용 synthetic worker — 미디어·모델·GPU·사용자 경로 없음.

PythonRunner가 separate.py 대신 이 스크립트를 띄운다(AF_E2E_TTS_SCRIPT 시임, AF_E2E=1에서만).
기존 synthetic_tree.py는 취소 lifecycle 전용이라 건드리지 않는다 — 여기 필요한 모드만 새로 둔다.

모드(AF_E2E_LONGFORM_MODE):
  chunks-then-result : 조각 완료 progress를 n회 낸 뒤 result emit 후 정상 종료(0).
                       → '정상 result는 staging 확인 후 한 번만 공개된다' 검증용.
  result-then-hang   : result를 먼저 emit하고 종료하지 않고 버틴다.
                       → main이 결과를 붙들고 있는 상태에서 취소/시간초과가 일어난다.
                         terminal 확정 이후 그 결과가 공개되면 안 된다(clobber 0).
  alive-no-progress  : 살아있다는 progress(로딩 heartbeat 문구, percent 고정)만 계속 낸다.
                       조각은 하나도 완료하지 않는다 → stall 축이 잡아야 한다.
  structured-error   : Python이 스스로 구조화 오류를 보고하고 코드 1로 종료.
                       → QWEN_NO_RESPONSE가 일반 timeout으로 뭉개지지 않는지 검증용.

환경:
  AF_E2E_LONGFORM_MODE  : 위 네 가지(기본 chunks-then-result)
  AF_E2E_LONGFORM_CHUNKS: chunks-then-result의 조각 수(기본 3)
  AF_E2E_PIDFILE        : 있으면 {"parent": pid} 기록(테스트가 트리 종료 확인용으로만 읽는다)

안전장치: 어떤 경우에도 MAX_LIFETIME_S 후 자진 종료 → 테스트가 실패해도 프로세스가 남지 않는다.
stdout은 PythonRunner가 JSON 라인으로 파싱한다(전사·오디오·경로 없음).
"""
import json
import os
import sys
import time

MAX_LIFETIME_S = 40.0
_T0 = time.monotonic()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def alive():
    return time.monotonic() - _T0 < MAX_LIFETIME_S


def chunk_progress(seg, n_seg, ci, cc, phase):
    """python/qwen_bridge.py `_progress`와 **같은 문구 형식**. 이게 달라지면 main이 위치를
    읽지 못하고 liveness로 떨어진다(그 fail-safe 성질은 유닛 테스트가 따로 고정한다)."""
    tag = "시작" if phase == "start" else "완료"
    emit({"type": "progress", "percent": 30,
          "message": f"합성 중... (문장 {seg + 1}/{n_seg}, 조각 {ci + 1}/{cc} {tag})"})


RESULT = {
    "type": "result",
    "tracks": [{"name": "synthesized", "label": "합성 음성", "path": "SYNTH/out/synthesized.wav"}],
    "metadata": {"engine": "synthetic", "chunk_count": 3, "speed_postprocessed": False},
}


def main():
    mode = os.environ.get("AF_E2E_LONGFORM_MODE", "chunks-then-result")
    pidfile = os.environ.get("AF_E2E_PIDFILE", "")
    if pidfile:
        try:
            with open(pidfile, "w", encoding="utf-8") as f:
                json.dump({"parent": os.getpid()}, f)
        except Exception:
            pass

    if mode == "chunks-then-result":
        n = int(os.environ.get("AF_E2E_LONGFORM_CHUNKS", "3"))
        for i in range(n):
            chunk_progress(i, n, 0, 1, "start")
            time.sleep(0.05)
            chunk_progress(i, n, 0, 1, "complete")
        emit(RESULT)
        return 0

    if mode == "result-then-hang":
        chunk_progress(0, 1, 0, 1, "complete")
        emit(RESULT)          # main은 이걸 붙들기만 하고 공개하지 않는다(done 전)
        while alive():
            time.sleep(0.1)   # 종료하지 않는다 → 취소/시간초과가 terminal을 확정한다
        return 0

    if mode == "alive-no-progress":
        # 살아있다는 신호만. 조각 완료는 없다 → 비활성 축은 계속 갱신되고 stall 축만 잡을 수 있다.
        while alive():
            emit({"type": "progress", "percent": 24,
                  "message": "모델 로딩 중... (%d초 경과 — 첫 실행은 오래 걸릴 수 있습니다)"
                             % int(time.monotonic() - _T0)})
            time.sleep(0.2)
        return 0

    if mode == "structured-error":
        chunk_progress(0, 1, 0, 1, "start")
        time.sleep(0.05)
        # python/tts_worker.py의 _no_response()가 만드는 payload와 같은 모양(정수·enum만).
        emit({"type": "error", "message": "Qwen 무응답 280s 초과 — 프로세스 종료",
              "code": "QWEN_NO_RESPONSE", "inactivity_sec": 280, "last_stage": "generating"})
        return 1

    emit({"type": "error", "message": f"알 수 없는 fixture 모드: {mode}"})
    return 2


if __name__ == "__main__":
    sys.exit(main())
