"""Qwen3-TTS job bridge — 격리 qwen3_tts_venv에서 실행, JSON stdin/stdout 통신.

성능: 모델 1회 로딩 후 한 작업의 모든 문장(감정별 참조 포함)을 처리(문장별 프로세스 금지).
완전 오프라인: local_files_only=True(런타임 자동 다운로드 금지). HF_HOME은 부모가 env로 지정.

stdin config(JSON):
  model_path             로컬 스냅샷 디렉터리(오프라인). repo id가 아니라 경로 → HF API 호출 회피.
  device                 "cuda:0" | "cpu"
  segments               [{index, text, ref_audio, ref_text, x_vector_only, language_name, out_path}]
                         x_vector_only=True면 x-vector-only(ref_text 무시), False면 ICL(ref_text 필요)
                         language_name은 세그먼트별(Korean/English/Chinese/Japanese)
stdout: progress/result/error JSON 라인(부모가 실시간 읽음). 각 세그먼트 wav는 raw 저장(후처리 없음).
"""
import sys
import json


def emit(msg_type, **kwargs):
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


def _load_model(model_path, device):
    """로컬 스냅샷 '경로'에서 로드(repo id 아님 → 오프라인에서 HF API 호출 회피) + local_files_only.
    sdpa 우선, 실패 시 원인 보존 + 부분참조 해제·gc·CUDA cache 정리 후 eager 재시도.
    CPU면 float32, CUDA면 bfloat16(고정 금지). 둘 다 실패하면 실제 원인을 포함해 예외."""
    import gc
    import torch
    from qwen_tts import Qwen3TTSModel
    dtype = torch.bfloat16 if str(device).startswith("cuda") else torch.float32
    errors = {}
    for attn in ("sdpa", "eager"):
        try:
            m = Qwen3TTSModel.from_pretrained(
                model_path, device_map=device, dtype=dtype,
                attn_implementation=attn, local_files_only=True)
            emit("progress", percent=25, message=f"모델 로딩 완료 (attn={attn}, dtype={dtype})")
            return m
        except Exception as e:
            errors[attn] = f"{type(e).__name__}: {str(e)[:300]}"
            # eager 재시도 전 부분 모델 참조 해제 + 정리
            try:
                del m  # noqa: F821
            except Exception:
                pass
            gc.collect()
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
    raise RuntimeError("Qwen 모델 로딩 실패 — sdpa: %s | eager: %s"
                       % (errors.get("sdpa"), errors.get("eager")))


def main():
    cfg = json.loads(sys.stdin.read())
    model_path = cfg["model_path"]  # 로컬 스냅샷 디렉터리(오프라인)
    device = cfg.get("device", "cuda:0")
    segments = cfg.get("segments", [])
    if not segments:
        emit("error", message="합성할 세그먼트가 없습니다.")
        sys.exit(1)

    try:
        import numpy as np
        import soundfile as sf

        emit("progress", percent=10, message=f"Qwen3-TTS 모델 로딩 중... ({device}, offline)")
        model = _load_model(model_path, device)

        done = []
        n = len(segments)
        for i, seg in enumerate(segments):
            pct = 30 + int((i / max(n, 1)) * 60)
            emit("progress", percent=pct, message=f"합성 중... ({i + 1}/{n})")
            xvo = bool(seg.get("x_vector_only", False))
            ref_text = "" if xvo else (seg.get("ref_text") or "")
            wavs, sr = model.generate_voice_clone(
                text=seg["text"], language=seg.get("language_name", "Korean"),
                ref_audio=seg["ref_audio"], ref_text=ref_text,
                x_vector_only_mode=xvo)
            d = wavs[0] if isinstance(wavs, list) else wavs
            d = np.asarray(d, dtype=np.float32)
            if d.ndim > 1:
                d = d.mean(axis=1)
            # 출력 검증: sr>0, non-empty, finite
            if not (isinstance(sr, (int, float)) and sr > 0):
                raise RuntimeError(f"세그먼트 {seg['index']} sr 이상: {sr}")
            if d.size == 0:
                raise RuntimeError(f"세그먼트 {seg['index']} 빈 오디오")
            if not np.all(np.isfinite(d)):
                raise RuntimeError(f"세그먼트 {seg['index']} 비유한(NaN/Inf) 샘플")
            sf.write(seg["out_path"], d, int(sr))
            done.append({"index": seg["index"], "out_path": seg["out_path"], "sr": int(sr),
                         "x_vector_only": xvo})

        emit("result", segments=done, success=True)

    except Exception as e:
        import traceback
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
