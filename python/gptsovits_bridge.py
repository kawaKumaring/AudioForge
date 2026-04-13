"""GPT-SoVITS bridge — runs in isolated venv, communicates via JSON stdin/stdout.

This script is executed by AudioForge's tts_worker using the GPT-SoVITS venv Python.
It reads a JSON config from stdin, runs inference, and outputs JSON result to stdout.
"""

import sys
import json
import os

def emit(msg_type, **kwargs):
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


def main():
    # Read config from stdin
    config_str = sys.stdin.read()
    config = json.loads(config_str)

    ref_audio = config["ref_audio"]
    text = config["text"]
    output_path = config["output_path"]
    language = config.get("language", "ko")
    speed = config.get("speed", 1.0)

    # Add GPT-SoVITS to path
    sovits_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "externals", "GPT-SoVITS")
    sys.path.insert(0, sovits_dir)

    emit("progress", percent=10, message="GPT-SoVITS 모델 로딩 중...")

    try:
        # GPT-SoVITS inference
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        # Find pretrained models
        models_dir = os.path.join(sovits_dir, "GPT_SoVITS", "pretrained_models")

        tts_config = TTS_Config()
        tts_config.device = "cuda" if __import__("torch").cuda.is_available() else "cpu"

        emit("progress", percent=30, message="GPT-SoVITS 초기화 중...")
        tts = TTS(tts_config)

        emit("progress", percent=50, message="음성 합성 중...")

        # Map language codes
        lang_map = {"ko": "ko", "ja": "ja", "zh": "zh", "en": "en"}
        tts_lang = lang_map.get(language, "ko")

        result = tts.run({
            "text": text,
            "text_lang": tts_lang,
            "ref_audio_path": ref_audio,
            "prompt_lang": tts_lang,
            "speed_factor": speed,
        })

        # Collect audio chunks
        import soundfile as sf
        import numpy as np

        all_audio = []
        sr = None
        for chunk in result:
            sr = chunk.get("sr", 32000)
            audio = chunk.get("audio", None)
            if audio is not None:
                if hasattr(audio, 'numpy'):
                    audio = audio.numpy()
                all_audio.append(audio)

        if all_audio and sr:
            combined = np.concatenate(all_audio)
            sf.write(output_path, combined, sr)
            emit("progress", percent=90, message="저장 완료")
            emit("result", output_path=output_path, success=True)
        else:
            emit("error", message="합성 결과가 없습니다.")

    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
