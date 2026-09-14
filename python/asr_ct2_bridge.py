"""faster-whisper(CTranslate2) 전사 — **격리 venv 안에서 도는 다리**.

왜 따로 도는가: 앱이 쓰는 파이썬은 ComfyUI 내장 파이썬이고, 거기에는 이미 torch 와 합성
환경이 들어 있다. ctranslate2 는 cuDNN 9 를 요구하고(4.5.0 부터, CHANGELOG) 제 DLL 을
직접 연다 — 같은 자리에 섞으면 기존 합성 환경을 흔든다. 그래서 `externals/asr_ct2_venv`
안에서 돌리고, 결과만 JSON 파일로 건넨다. 기존 GPT-SoVITS·Qwen 다리와 같은 방식이다.

★전역 PATH·CUDA 를 건드리지 않는다. cuBLAS·cuDNN 은 이 venv 안의 pip 꾸러미에서만 찾는다.
★모델은 **로컬 절대경로**로만 적재한다. 실행 중 자동 다운로드를 막는다(local_files_only).
★반환 모양은 기존 openai-whisper 의 결과 dict 와 **같게** 만든다 — 부르는 쪽(TXT·SRT·번역·
  무음 게이트)이 엔진을 몰라도 되게 하기 위해서다.
"""

import argparse
import glob
import json
import os
import sys
import time


def _add_nvidia_dll_dirs():
    """cuBLAS·cuDNN 을 **이 venv 안에서만** 찾게 한다(전역 PATH 무변경)."""
    base = os.path.join(os.path.dirname(os.path.abspath(sys.executable)),
                        "..", "Lib", "site-packages", "nvidia")
    found, dirs = [], []
    for d in glob.glob(os.path.join(base, "*", "bin")):
        d = os.path.abspath(d)
        dirs.append(d)
        try:
            os.add_dll_directory(d)
        except Exception:
            pass
        found.append(os.path.basename(os.path.dirname(d)))
    # ★add_dll_directory 만으로는 부족하다. ctranslate2 는 cuBLAS 를 **실행 도중** 이름으로
    #   불러오는데(LoadLibrary), 그 경로는 add_dll_directory 가 더한 자리를 보지 않는다
    #   (실측: "Library cublas64_12.dll is not found"). 그래서 PATH 앞에도 붙인다 —
    #   **이 프로세스의 환경변수만** 바꾸는 것이라 전역 PATH 는 그대로다.
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
    return sorted(found)


def _norm_lang(lang):
    if not lang or lang in ("auto", "none", ""):
        return None
    return lang


def transcribe(audio_path, model_dir, language=None, device="cuda",
               compute_type="float16", beam_size=1):
    """전사 한 건. 기존 경로와 **같은 모양의 dict** 를 돌려준다.

    ★양쪽 기본값이 다른 것들을 전부 **명시**한다. 이름이 같아도 뜻이 같다고 보지 않는다.
      · beam_size — 기존 경로는 인자를 주지 않아 greedy(=1) 로 돈다. faster-whisper 기본은 5.
        여기서는 기존 동작을 따라 1 을 준다(호출자가 바꿀 수 있다).
      · condition_on_previous_text — 양쪽 기본 True. 기존 경로는 환각 억제를 위해 False 로
        명시하고 있으므로 여기서도 False.
      · word_timestamps — 양쪽 기본 False. 기존 경로는 True.
      · hallucination_silence_threshold — 양쪽 기본 None. 기존 경로는 2.0.
      · logprob_threshold(openai) == log_prob_threshold(faster-whisper) — **이름이 다르다.**
      · vad_filter — faster-whisper 에만 있다. 기본 False 를 **그대로 둔다**. 켜면 기존
        무음 게이트와 판정이 겹쳐 무엇이 무엇을 지웠는지 알 수 없게 된다.
    """
    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(model_dir, device=device, compute_type=compute_type,
                         local_files_only=True)
    load_sec = time.time() - t0

    t1 = time.time()
    segments_iter, info = model.transcribe(
        audio_path,
        language=_norm_lang(language),
        task="transcribe",
        beam_size=beam_size,
        best_of=beam_size,
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        condition_on_previous_text=False,
        word_timestamps=True,
        hallucination_silence_threshold=2.0,
        vad_filter=False,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )

    # ★generator 다. 끝까지 돌려야 전사가 실제로 일어난다 — 여기서 완주시킨다.
    segments = []
    full = []
    for i, s in enumerate(segments_iter):
        words = []
        for w in (s.words or []):
            words.append({"start": float(w.start), "end": float(w.end),
                          "word": w.word, "probability": float(w.probability)})
        segments.append({
            "id": i, "seek": int(getattr(s, "seek", 0)),
            "start": float(s.start), "end": float(s.end), "text": s.text,
            "tokens": list(getattr(s, "tokens", []) or []),
            "temperature": float(getattr(s, "temperature", 0.0) or 0.0),
            "avg_logprob": float(getattr(s, "avg_logprob", 0.0) or 0.0),
            "compression_ratio": float(getattr(s, "compression_ratio", 0.0) or 0.0),
            "no_speech_prob": float(getattr(s, "no_speech_prob", 0.0) or 0.0),
            "words": words,
        })
        full.append(s.text)
    run_sec = time.time() - t1

    return {
        "text": "".join(full),
        "language": info.language,
        "segments": segments,
        # 실행 기록 — 무엇이 어디서 어떻게 돌았는지 숨기지 않는다.
        "_run": {
            "engine": "faster-whisper",
            "engineVersion": _pkg_version("faster_whisper"),
            "ct2Version": _pkg_version("ctranslate2"),
            "modelDir": model_dir,
            "device": device,
            "computeType": compute_type,
            "beamSize": beam_size,
            "batchSize": 1,          # 배치 처리는 쓰지 않는다(탐색 안 함)
            "loadSec": round(load_sec, 2),
            "transcribeSec": round(run_sec, 2),
            "audioDurationSec": round(float(info.duration), 2),
            "languageProbability": round(float(info.language_probability), 4),
            "segmentCount": len(segments),
        },
    }


def _pkg_version(mod):
    try:
        import importlib.metadata as md
        return md.version(mod.replace("_", "-"))
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--language", default=None)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="float16")
    ap.add_argument("--beam-size", type=int, default=1)
    a = ap.parse_args()

    dlls = _add_nvidia_dll_dirs()
    if not os.path.isdir(a.model_dir):
        raise SystemExit(f"ASR_CT2_MODEL_MISSING: {a.model_dir}")

    result = transcribe(a.audio, a.model_dir, a.language, a.device,
                        a.compute_type, a.beam_size)
    result["_run"]["dllDirs"] = dlls
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    # 본문은 찍지 않는다 — 전사 내용이 진단 로그로 새지 않게 한다.
    r = result["_run"]
    print(f"[asr-ct2] done engine={r['engine']} ct2={r['ct2Version']} "
          f"device={r['device']} compute={r['computeType']} beam={r['beamSize']} "
          f"segments={r['segmentCount']} audio={r['audioDurationSec']}s "
          f"load={r['loadSec']}s run={r['transcribeSec']}s", flush=True)


if __name__ == "__main__":
    main()
