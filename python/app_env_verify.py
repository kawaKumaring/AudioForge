#!/usr/bin/env python3
"""설치된 GPT-SoVITS venv 를 **실제로 돌려서** 검증한다.

이 스크립트는 설치 대상 venv 의 파이썬으로 실행된다(설치기가 하위 프로세스로 부른다).

왜 파일 존재 확인으로 끝내지 않는가
-----------------------------------
2026-08-29 사고에서 venv 디렉터리와 python.exe 는 멀쩡히 남고 site-packages 의
일부 구간만 사라졌다. 디렉터리가 있다는 사실은 아무것도 보증하지 않는다.
그래서 여기서는 두 단계를 실제로 수행한다.

  1. import 검증 — 명세의 모듈을 하나씩 실제로 import 한다(find_spec 이 아니라 import).
  2. 깊은 검증  — GPT-SoVITS 설정을 읽고 TTS 인스턴스를 만든다. 즉 t2s/vits/bert/
     hubert 네 가지 가중치가 실제로 메모리에 올라가는 것까지 확인한다.

출력은 마지막 줄에 JSON 한 줄. 설치기가 그 줄만 읽는다.
"""

import argparse
import json
import os
import sys
import time
import traceback


def load_import_list():
    here = os.path.dirname(os.path.abspath(__file__))
    spec_file = os.path.join(here, "runtime_spec.json")
    try:
        with open(spec_file, encoding="utf-8") as f:
            spec = json.load(f)
        return spec["components"]["gptsovits"]["verify"]["imports"]
    except Exception:
        return ["torch", "torchaudio", "numpy", "librosa", "transformers",
                "pytorch_lightning", "jieba", "jieba_fast", "eunjeon", "g2pk2"]


def check_imports(names):
    results = {}
    for name in names:
        t0 = time.time()
        try:
            __import__(name)
            results[name] = {"ok": True, "sec": round(time.time() - t0, 2)}
        except BaseException as e:  # ImportError 외 (DLL 로드 실패 등) 도 잡는다
            results[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return results


def check_cuda():
    try:
        import torch
        avail = torch.cuda.is_available()
        return {
            "available": bool(avail),
            "device": torch.cuda.get_device_name(0) if avail else None,
            "capability": list(torch.cuda.get_device_capability(0)) if avail else None,
            "torch": torch.__version__,
            "cuda_build": getattr(torch.version, "cuda", None),
        }
    except BaseException as e:
        return {"available": False, "error": f"{type(e).__name__}: {e}"}


def deep_check(repo):
    """실제 모델 로딩. 성공하면 합성 직전 상태까지 도달한 것이다."""
    out = {"ok": False}
    t0 = time.time()
    cwd0 = os.getcwd()
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        try:
            from audio_utils import patch_torchaudio
            patch_torchaudio()
        except Exception:
            pass  # 폴백 패치는 없어도 로딩 자체는 된다

        sys.path.insert(0, repo)
        sys.path.insert(0, os.path.join(repo, "GPT_SoVITS"))
        os.chdir(repo)

        import torch
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        cfg = TTS_Config("GPT_SoVITS/configs/tts_infer.yaml")
        if not torch.cuda.is_available():
            cfg.device = "cpu"
            cfg.is_half = False
        out["device"] = str(cfg.device)
        out["is_half"] = bool(cfg.is_half)
        out["version"] = getattr(cfg, "version", None)

        tts = TTS(cfg)
        out["t2s_loaded"] = tts.t2s_model is not None
        out["vits_loaded"] = tts.vits_model is not None
        out["bert_loaded"] = tts.bert_model is not None
        out["hubert_loaded"] = tts.cnhuhbert_model is not None
        out["ok"] = all([out["t2s_loaded"], out["vits_loaded"],
                         out["bert_loaded"], out["hubert_loaded"]])
        if not out["ok"]:
            out["error"] = "일부 가중치가 로딩되지 않았습니다."

        # 한국어 텍스트 프론트엔드까지 실제로 통과시킨다.
        # (import 만으로는 mecab 사전·g2pk2 자원 누락을 못 잡는다)
        try:
            from text.cleaner import clean_text
            phones, word2ph, norm = clean_text("안녕하세요, 테스트입니다.", "ko",
                                               getattr(cfg, "version", "v2"))
            out["korean_frontend"] = {"ok": True, "phones": len(phones),
                                      "normalized_len": len(norm or "")}
        except BaseException as e:
            out["korean_frontend"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            out["ok"] = False
            out.setdefault("error", "한국어 텍스트 프론트엔드 실패")

        del tts
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    except BaseException as e:
        out["error"] = f"{type(e).__name__}: {e}"
        out["traceback"] = traceback.format_exc()[-3000:]
    finally:
        os.chdir(cwd0)
        out["elapsed_sec"] = round(time.time() - t0, 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="GPT-SoVITS 코드 폴더")
    ap.add_argument("--no-deep", action="store_true", help="모델 로딩 검증 생략")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    report = {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "repo": args.repo,
        "imports": check_imports(load_import_list()),
        "cuda": check_cuda(),
    }
    import_ok = all(r.get("ok") for r in report["imports"].values())

    if args.no_deep:
        report["deep"] = {}
        report["ok"] = import_ok
    else:
        if not import_ok:
            report["deep"] = {"ok": False, "error": "import 실패로 모델 로딩을 시도하지 않았습니다."}
            report["ok"] = False
        else:
            report["deep"] = deep_check(args.repo)
            report["ok"] = bool(report["deep"].get("ok"))

    if not report["ok"] and "error" not in report:
        bad = [k for k, v in report["imports"].items() if not v.get("ok")]
        if bad:
            report["error"] = "import 실패: " + ", ".join(bad)

    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
