#!/usr/bin/env python3
"""취소 lifecycle E2E용 synthetic 프로세스 트리 — 미디어·모델·사용자 경로 없음.

PythonRunner가 separate.py 대신 이 스크립트를 띄운다(AF_E2E_TTS_SCRIPT 시임, AF_E2E=1에서만).
동작:
  - 'hang'(기본): grandchild 1개 생성 + progress JSON 반복 emit + 명시 종료(taskkill /T) 전까지 대기.
  - 'result': progress 후 result JSON emit 후 정상 종료(0). (grandchild 없음)
  - 'error' : progress 후 error JSON emit 후 코드 1로 종료. (grandchild 없음)
환경:
  - AF_E2E_FIXTURE_MODE: hang|result|error (기본 hang)
  - AF_E2E_PIDFILE: 있으면 {"parent":pid,"child":pid|null} JSON 기록(테스트가 트리 종료 검증용으로만 읽음)
안전장치: 어떤 경우에도 MAX_LIFETIME_S 후 자진 종료 → 테스트 실패 시에도 leak 없음.
stdout은 PythonRunner가 JSON 라인으로 파싱한다(전사·오디오·경로 없음).
"""
import json
import os
import subprocess
import sys
import time

MAX_LIFETIME_S = 25.0
PROGRESS_INTERVAL_S = 0.25


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def spawn_grandchild():
    # 순수 stdlib sleep 루프 — 트리(parent→grandchild) 구성용. taskkill /T가 함께 종료해야 한다.
    code = "import time,sys\n" + f"t=time.time()\nwhile time.time()-t < {MAX_LIFETIME_S}: time.sleep(0.2)\n"
    try:
        p = subprocess.Popen([sys.executable, "-c", code],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return p
    except Exception:
        return None


def main():
    mode = os.environ.get("AF_E2E_FIXTURE_MODE", "hang")
    grandchild = spawn_grandchild() if mode == "hang" else None
    pidfile = os.environ.get("AF_E2E_PIDFILE", "")
    if pidfile:
        try:
            with open(pidfile, "w", encoding="utf-8") as f:
                json.dump({"parent": os.getpid(),
                           "child": (grandchild.pid if grandchild else None)}, f)
        except Exception:
            pass

    # 시작 즉시 진행률 신호(렌더러가 processing→진행 표시하도록). 90% 미만으로만 → 절대 '완료'로 보이지 않음.
    emit({"type": "progress", "percent": 30, "message": "synthetic 처리 중"})

    if mode == "result":
        time.sleep(0.3)
        emit({"type": "progress", "percent": 90, "message": "synthetic 마무리"})
        emit({"type": "result",
              "tracks": [{"name": "synthesized", "label": "합성 음성", "path": "SYNTH/out/synthesized.wav"}],
              "outputDir": "SYNTH/out",
              "metadata": {"requested_engine": "auto", "actual_engine": "synthetic", "device": "cpu"}})
        return 0

    if mode == "error":
        time.sleep(0.3)
        emit({"type": "error", "message": "synthetic 합성 오류(테스트)"})
        return 1

    # hang: 명시 종료 전까지 진행률만 반복(90% 이하 유지). 안전 상한 도달 시 자진 종료.
    start = time.time()
    pct = 30
    while time.time() - start < MAX_LIFETIME_S:
        time.sleep(PROGRESS_INTERVAL_S)
        pct = 30 + int((time.time() - start) * 5) % 55  # 30~84 사이 왕복(완료로 안 보이게)
        emit({"type": "progress", "percent": pct, "message": "synthetic 처리 중"})
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
