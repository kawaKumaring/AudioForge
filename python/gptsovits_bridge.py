"""GPT-SoVITS bridge — 격리 venv에서 실행, JSON stdin/stdout으로 통신.

AudioForge의 tts_worker가 GPT-SoVITS venv Python으로 이 스크립트를 실행한다.
stdin으로 JSON config를 읽어 추론하고, stdout으로 JSON 진행/결과를 낸다.

config 키:
  ref_audio    참조 음성 경로 (필수)
  text         합성할 텍스트 (필수)
  output_path  출력 wav 경로 (필수)
  language     ko/ja/zh/en (기본 ko)
  speed        속도 배수 (기본 1.0)
  prompt_text  참조 음성의 전사 (있으면 품질↑, 없으면 ref-free)
  prompt_lang  prompt_text 언어 (기본 language와 동일)
"""

import sys
import json
import os


def emit(msg_type, **kwargs):
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


# GPT-SoVITS 언어 코드: 텍스트 전체를 한 언어로 취급하는 all_* 사용
_LANG_MAP = {"ko": "all_ko", "ja": "all_ja", "zh": "all_zh", "en": "en"}


def main():
    config = json.loads(sys.stdin.read())

    ref_audio = config["ref_audio"]
    text = config["text"]
    output_path = config["output_path"]
    language = config.get("language", "ko")
    speed = config.get("speed", 1.0)
    prompt_text = config.get("prompt_text", "") or ""
    prompt_lang = config.get("prompt_lang", language)

    # torchaudio 2.11 torchcodec 문제: GPT-SoVITS가 torchaudio.load를 쓰므로
    # AudioForge와 동일한 soundfile 폴백 패치를 먼저 적용 (audio_utils 재사용)
    py_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, py_dir)
    try:
        from audio_utils import patch_torchaudio
        patch_torchaudio()
    except Exception:
        pass

    # GPT-SoVITS를 path에 추가 (repo 루트 + GPT_SoVITS 하위: AR 등 내부 모듈용)
    # 코드 위치도 runtime.json이 답한다 — 작업 트리처럼 externals가 없는 곳에서도
    # 이미 내려받아 둔 코드·모델을 그대로 가리킬 수 있어야 한다.
    try:
        import app_runtime
        sovits_dir = app_runtime.resolve_gptsovits()["repo"]
    except Exception:
        sovits_dir = os.path.abspath(os.path.join(py_dir, "..", "externals", "GPT-SoVITS"))
    if not os.path.isdir(sovits_dir):
        emit("error", message=f"GPT-SoVITS 코드 폴더를 찾을 수 없습니다: {sovits_dir}")
        sys.exit(1)
    sys.path.insert(0, sovits_dir)
    sys.path.insert(0, os.path.join(sovits_dir, "GPT_SoVITS"))
    # tts_infer.yaml과 모델 경로가 cwd 기준 상대경로이므로 repo 루트로 이동
    os.chdir(sovits_dir)

    try:
        import torch
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        emit("progress", percent=15, message="GPT-SoVITS 설정 로딩 중...")
        # tts_infer.yaml의 custom 프로파일 사용 (v2). CUDA 없으면 __init__이 CPU로 자동 강등.
        tts_config = TTS_Config("GPT_SoVITS/configs/tts_infer.yaml")
        # device 계보를 남긴다 — 나중에 'GPU 로 돌았나' 를 결과만 보고 답할 수 있어야 한다.
        requested_device = str(getattr(tts_config, "device", "") or "")
        device_selection_source = "tts_infer.yaml"
        fallback = False
        fallback_reason = None
        if not torch.cuda.is_available():
            tts_config.device = "cpu"
            tts_config.is_half = False
            device_selection_source = "torch.cuda.is_available()"
            if requested_device and not requested_device.startswith("cpu"):
                fallback = True
                fallback_reason = "CUDA_UNAVAILABLE"

        emit("progress", percent=35, message=f"GPT-SoVITS 모델 로딩 중... ({tts_config.device})")
        tts = TTS(tts_config)

        emit("progress", percent=55, message="음성 합성 중...")

        text_lang = _LANG_MAP.get(language, "all_ko")
        p_lang = _LANG_MAP.get(prompt_lang, text_lang)

        # pyopenjtalk(일본어 음소화)는 C++ 빌드가 필요해 미설치일 수 있음.
        # 일본어 텍스트 처리 경로에서만 필요하므로 상황별로 처리:
        #  - 합성 텍스트가 일본어인데 미설치 → 명확한 에러
        #  - 참조 전사(prompt_text)만 일본어인데 미설치 → ref-free로 자동 강등
        import importlib.util
        has_pyopenjtalk = importlib.util.find_spec("pyopenjtalk") is not None
        if not has_pyopenjtalk:
            if text_lang == "all_ja":
                emit("error", message="일본어 합성은 pyopenjtalk가 필요합니다 (VS Build Tools 빌드). "
                                      "한국어/영어/중국어 출력은 가능합니다.")
                sys.exit(1)
            if p_lang == "all_ja" and prompt_text.strip():
                emit("progress", percent=56,
                     message="pyopenjtalk 미설치 → 참조 전사 없이(ref-free) 합성")
                prompt_text = ""

        inputs = {
            "text": text,
            "text_lang": text_lang,
            "ref_audio_path": ref_audio,
            "prompt_text": prompt_text.strip(),
            "prompt_lang": p_lang,
            "speed_factor": float(speed),
            "text_split_method": "cut5",
            "batch_size": 1,
            "top_k": 5,
            "top_p": 1.0,
            "temperature": 1.0,
        }

        import soundfile as sf
        import numpy as np

        chunks = []
        sr = None
        for item in tts.run(inputs):
            # run()은 (sr, ndarray) 튜플을 yield
            if not isinstance(item, (tuple, list)) or len(item) != 2:
                continue
            chunk_sr, audio = item
            if audio is None:
                continue
            if hasattr(audio, "numpy"):
                audio = audio.numpy()
            sr = chunk_sr
            chunks.append(audio)

        if chunks and sr:
            combined = np.concatenate(chunks)
            sf.write(output_path, combined, sr)
            emit("progress", percent=95, message="저장 완료")
            actual_device = str(getattr(getattr(tts, "configs", None), "device", "")
                                or getattr(tts_config, "device", "") or "")
            if (not fallback and requested_device
                    and not requested_device.startswith("cpu")
                    and actual_device.startswith("cpu")):
                # 요청은 GPU 였는데 실제로 CPU 로 내려간 경우 — 성공으로 포장하지 않는다.
                fallback = True
                fallback_reason = "DEVICE_DOWNGRADED_AT_LOAD"
            emit("result", output_path=output_path, success=True,
                 requested_device=requested_device or None,
                 actual_device=actual_device or None,
                 device_selection_source=device_selection_source,
                 fallback=fallback, fallback_reason=fallback_reason)
        else:
            emit("error", message="합성 결과가 없습니다.")
            sys.exit(1)

    except Exception as e:
        import traceback
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
