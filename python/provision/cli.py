# -*- coding: utf-8 -*-
"""provision.cli — Electron이 subprocess로 부르는 얇은 어댑터(로직 재구현 0).

Agent Q 소유. P의 pure core(state/default_manifest/fingerprint)를 호출해 canonical JSON을
한 줄로 emit할 뿐이다 — plan/dry-run/verify state machine·DAG·manifest·fingerprint는 전부
provision.state 등 P 코어가 소유하며, 여기서는 재구현하지 않는다.

plan/verify는 순수 stdlib다 — torch/모델/GPU/네트워크 불요. 파일 쓰기·다운로드·pip·venv 생성 0.
apply(실제 설치)는 이 진입점에서 호출하지 않는다(state.apply는 어차피 APPLY_DISABLED로 차단).

roots(runtimeRoot/modelRoot/cacheRoot; 공유 계약 RuntimeRootConfig)는 **선택 인자**다:
  - plan/verify 자체는 roots가 필요 없다(상대 installPath·displayLabel만 다룸).
  - config에 roots가 실려 오면 runtime_paths.configure로 검증만 한다(주입 경로 배선을 존중).
    미주입/borrowed 규칙은 P 코어(runtime_paths)가 이미 강제하므로 여기서 재구현하지 않는다.
    roots가 실렸는데 무효면 NO_RUNTIME_ROOT 오류 봉투로 표면화한다(조용한 폴백 금지).

출력 계약(stdout 한 줄, canonical JSON):
  성공: {"type":"provision-result","ok":true,"result": <PlanResult|VerifyResult>}
  실패: {"type":"provision-error","ok":false,"error":{"code": <ReasonCode>, "message": <str>}}
result는 provisionContract.ts의 PlanResult/VerifyResult와 1:1(키·형태 동일)이며 전체 절대경로 0이다.
"""

import argparse
import json
import os
import sys

# runtime_paths(및 그를 import하는 provision.layout)가 어느 cwd에서도 import되도록 python/ 디렉터리를
# sys.path 최상단에 둔다. __file__ = python/provision/cli.py → 부모의 부모 = python/.
_PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

import runtime_paths  # noqa: E402  (roots 검증용 — 선택 경로)
from . import default_manifest  # noqa: E402
from . import manifest as mf  # noqa: E402
from . import reason_codes as rc  # noqa: E402
from . import state  # noqa: E402

VALID_MODES = ("provision-plan", "provision-dry-run", "provision-verify")


def _ok(result):
    return {"type": "provision-result", "ok": True, "result": result}


def _err(code, message=""):
    return {"type": "provision-error", "ok": False, "error": {"code": code, "message": message}}


def _resolve_engine_ids(components, engine_ids):
    """engineIds 정규화. "*" 또는 ["*"]는 '모든 선택(required=False) component'로 확장한다
    (component id 지식을 Python 단일 소스에 둔다 — TS가 id를 하드코딩하지 않게). None → 필수만."""
    if engine_ids is None:
        return ()
    if isinstance(engine_ids, str):
        engine_ids = [engine_ids]
    if not isinstance(engine_ids, (list, tuple)):
        return ()
    if "*" in engine_ids:
        return tuple(c["id"] for c in components if not c.get("required"))
    return tuple(str(e) for e in engine_ids)


def build_response(config):
    """config(dict) → 출력 봉투(dict). 순수: 파일 쓰기·네트워크·다운로드 0. 예외를 오류 봉투로 정규화.

    config 키:
      mode      : "provision-plan" | "provision-dry-run" | "provision-verify"
      engineIds : [id, ...] | "*" | ["*"]  (선택; "*"=모든 선택 component)
      roots     : RuntimeRootConfig (선택; 있으면 configure로 검증만)
    """
    if not isinstance(config, dict):
        return _err(rc.APPLY_DISABLED, "config가 dict 아님")
    mode = config.get("mode")
    if mode not in VALID_MODES:
        return _err(rc.APPLY_DISABLED, "알 수 없는 provision mode")

    # roots가 실렸으면 검증만(선택). plan/verify는 roots를 쓰지 않으므로 부재는 정상.
    roots = config.get("roots")
    if roots is not None:
        try:
            runtime_paths.configure(roots)
        except runtime_paths.RuntimeRootError as e:
            return _err(e.code, "roots 주입 무효")

    try:
        manifest = default_manifest.build()
        components = mf.validate_manifest(manifest)
        engine_ids = _resolve_engine_ids(components, config.get("engineIds"))
        if mode == "provision-verify":
            # 이번 단계 apply 비활성 + 설치 이력 0 → evidence 미주입(synthetic). present=False로 정직하게.
            result = state.verify(manifest, engine_ids=engine_ids, evidence_by_id=None)
        elif mode == "provision-dry-run":
            result = state.dry_run(manifest, engine_ids=engine_ids)
        else:
            result = state.plan(manifest, engine_ids=engine_ids)
        return _ok(result)
    except rc.ProvisionError as e:
        return _err(e.code, "provision 계획 실패")
    except Exception:  # noqa: BLE001  (비민감: 예외 종류/경로 미노출)
        return _err(rc.APPLY_DISABLED, "provision 처리 오류")


def main(argv=None):
    parser = argparse.ArgumentParser(description="AudioForge provisioner (plan/verify, read-only)")
    parser.add_argument("--config", default="", help="JSON config file path")
    parser.add_argument("--mode", default="", help="provision-plan|provision-dry-run|provision-verify (config 없을 때)")
    args = parser.parse_args(argv)

    config = None
    if args.config and os.path.exists(args.config):
        try:
            with open(args.config, "r", encoding="utf-8") as f:
                config = json.load(f)
        except (OSError, ValueError):
            print(json.dumps(_err(rc.APPLY_DISABLED, "config 읽기 실패"), ensure_ascii=False), flush=True)
            return 1
    elif args.mode:
        config = {"mode": args.mode}

    if config is None:
        print(json.dumps(_err(rc.APPLY_DISABLED, "config 없음"), ensure_ascii=False), flush=True)
        return 1

    resp = build_response(config)
    # 한 줄 canonical JSON. ensure_ascii=False로 한글 라벨 보존(UTF-8). IPC가 마지막 봉투 라인을 소비.
    print(json.dumps(resp, ensure_ascii=False), flush=True)
    return 0 if resp.get("ok") else 1
