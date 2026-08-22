"""Qwen3-TTS job bridge — 격리 qwen3_tts_venv에서 실행, JSON stdin/stdout 통신.

성능: 모델 1회 로딩 후 한 작업의 모든 문장(감정별 참조 포함)을 처리(문장별 프로세스 금지).
완전 오프라인: local_files_only=True(런타임 자동 다운로드 금지). HF_HOME은 부모가 env로 지정.

생성 안전장치(계약 A):
  segment마다 production token 수(`_build_assistant_text` 적용 후 tokenize, production과 동일 경로)로
  동적 max_new_tokens 상한을 산정(generation_limit.compute_max_new_tokens)해 talker 생성 상한을 건다.
  talker 자기회귀 반복(iteration)을 RNG/logits 불변 StoppingCriteria로 계측하고, 상한 대비로 종료 상태를 판정한다.
  상한 도달(generation_limit)이면 잘린 WAV를 쓰지 않고 GENERATION_LIMIT_EXCEEDED 구조화 오류를 낸다.
  ※ 이 안전장치는 vendor(qwen_tts) 수정 없이 이 브리지에서만 구현한다. eos_pos/has_stop_token/effective_lengths
    기반 EOS 판정은 이 pinned 버전에서 유효하지 않아 사용하지 않는다(talker_iters vs 동적 상한만 사용).

stdin config(JSON):
  model_path             로컬 스냅샷 디렉터리(오프라인). repo id가 아니라 경로 → HF API 호출 회피.
  device                 "cuda:0" | "cpu"
  segments               [{index, text, ref_audio, ref_text, x_vector_only, language_name, out_path}]
                         x_vector_only=True면 x-vector-only(ref_text 무시), False면 ICL(ref_text 필요)
                         language_name은 세그먼트별(Korean/English/Chinese/Japanese)
stdout: progress/result/error JSON 라인(부모가 실시간 읽음). 각 세그먼트 wav는 raw 저장(후처리 없음).
  result.segments[*]에 prod_tokens/generation_limit/generated_iterations/termination_reason 포함.
  error.code == GENERATION_LIMIT_EXCEEDED 는 상한 도달 — segment_index/generated_iterations/generation_limit(정수)만,
  전사·문장·경로는 절대 포함하지 않는다.
"""
import sys
import json

import generation_limit  # 순수 계산(math만). 스크립트 디렉터리(python/)가 sys.path에 있어 import 가능.
import text_segmenter    # 다국어 token-aware 자동 분할(계약 B). 순수 로직.


def emit(msg_type, **kwargs):
    print(json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False), flush=True)


# talker 자기회귀 스텝 카운터 — 세그먼트마다 리셋. RNG/logits 불변(scores 미사용·torch/random 무호출).
_COUNTER = {"n": 0}


def _install_talker_counter(model):
    """model.model.talker.generate 에 counting StoppingCriteria를 주입(멱등).

    criteria는 _COUNTER['n'] += 1; return False 뿐이라:
      - 항상 False → 기존 종료조건(eos_token_id=2150 / max_new_tokens) OR 에 영향 없음(동작 불변).
      - scores 미사용·난수 미사용 → 생성 분포/RNG 불변(계측 전용).
    talker step 1회 = codec 토큰 1개 생성. 상한 도달 시 step 수 == max_new_tokens.
    """
    from transformers import StoppingCriteria, StoppingCriteriaList

    talker = model.model.talker
    if getattr(talker, "_af_counter_installed", False):
        return

    class _StepCounter(StoppingCriteria):
        def __call__(self, input_ids, scores, **kw):
            _COUNTER["n"] += 1
            return False

    orig = talker.generate

    def wrapped(*a, **k):
        sc = k.get("stopping_criteria")
        if sc is None:
            sc = StoppingCriteriaList()
        elif not isinstance(sc, StoppingCriteriaList):
            sc = StoppingCriteriaList(sc)
        sc.append(_StepCounter())
        k["stopping_criteria"] = sc
        return orig(*a, **k)

    talker.generate = wrapped
    talker._af_counter_installed = True


def _preflight_tokenizer(model):
    """production token 계산에 필요한 도구 존재 확인. 부재/비호출 → 조용한 8192 폴백 금지, 명확한 호환성 오류."""
    builder = getattr(model, "_build_assistant_text", None)
    if not callable(builder):
        raise RuntimeError(
            "TTS_COMPAT: model._build_assistant_text 부재 — 이 pinned qwen_tts에서 production 토큰 계산 불가. "
            "안전장치 없이 생성하지 않는다.")
    proc = getattr(model, "processor", None)
    if proc is None or not callable(proc):
        raise RuntimeError("TTS_COMPAT: model.processor 부재/비호출 — production 토큰 계산 불가.")
    return builder, proc


def _prod_tokens(builder, proc, text):
    """production과 동일 경로의 입력 토큰 수: processor(_build_assistant_text(text)).input_ids 길이.
    실패 시 조용한 폴백 없이 호환성 오류(안전장치가 임의 상한으로 열리는 것을 막는다)."""
    try:
        at = builder(text)
        enc = proc(text=at, return_tensors="pt")
        ids = enc["input_ids"]
        n = int(ids.shape[-1])
    except Exception as e:
        raise RuntimeError(f"TTS_COMPAT: production 토큰 계산 실패 — {type(e).__name__}")
    if n <= 0:
        raise RuntimeError("TTS_COMPAT: production 토큰 수가 0 이하 — 계산 경로 이상.")
    return n


def _generate_segment(model, seg, builder, proc):
    """세그먼트 1개 합성 + 안전장치. production token → 동적 상한 → 상한 건 생성 → 반복 계측 → 종료 판정.
    반환: dict(wavs, sr, prod_tokens, generation_limit, generated_iterations, termination_reason).
    counter 미측정(0)·상한 산정 실패는 조용히 통과하지 않고 예외(안전장치 없는 성공 금지)."""
    xvo = bool(seg.get("x_vector_only", False))
    ref_text = "" if xvo else (seg.get("ref_text") or "")
    prod_tokens = _prod_tokens(builder, proc, seg["text"])
    seg_limit = generation_limit.compute_max_new_tokens(prod_tokens)
    _COUNTER["n"] = 0
    wavs, sr = model.generate_voice_clone(
        text=seg["text"], language=seg.get("language_name", "Korean"),
        ref_audio=seg["ref_audio"], ref_text=ref_text,
        x_vector_only_mode=xvo, max_new_tokens=seg_limit)
    iters = _COUNTER["n"]
    if iters <= 0:
        # 계측 래퍼가 동작하지 않은 것 — 상한이 실제로 걸렸는지 확인 불가. 성공 처리 금지.
        raise RuntimeError(
            "TTS_COMPAT: talker 반복 계측값이 0 — StoppingCriteria 계측 경로 미동작. 안전장치 없이 통과 금지.")
    reason = generation_limit.classify_termination(iters, seg_limit)
    return {"wavs": wavs, "sr": sr, "prod_tokens": prod_tokens,
            "generation_limit": seg_limit, "generated_iterations": iters,
            "termination_reason": reason}


def _chunk_out_path(seg_out_path, chunk_index):
    """chunk WAV의 결정적 경로 — 원본 out_path와 같은 디렉터리(job_dir) 안, 파일명에 chunk index 포함.
    예: .../segment_qwen_001.wav → .../segment_qwen_001_c000.wav. 임의/외부 경로 생성 금지."""
    import os
    d = os.path.dirname(seg_out_path)
    base = os.path.basename(seg_out_path)
    stem = base[:-4] if base.lower().endswith(".wav") else base
    return os.path.join(d, f"{stem}_c{chunk_index:03d}.wav")


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
        builder, proc = _preflight_tokenizer(model)  # 안전장치 전제 — 부재 시 여기서 명확히 실패
        _install_talker_counter(model)

        max_seg_tok = generation_limit.max_segment_tokens()
        done = []
        n = len(segments)
        for i, seg in enumerate(segments):
            emo = seg.get("emotion_id")  # 태그(비민감). 결과·오류에 그대로 반환.

            # 계약 B: 원본 segment를 동적 상한 이내 chunk로 자동 분할(실제 tokenizer 기준).
            try:
                chunks = text_segmenter.split_for_generation(
                    seg["text"], lambda t: _prod_tokens(builder, proc, t), max_seg_tok)
            except text_segmenter.SegmentTooLong as e:
                # 더는 못 나눔 → 명확히 실패(내용 미포함). 부분 결과도 채택되지 않는다.
                emit("error", code="TEXT_SEGMENT_TOO_LONG", segment_index=int(seg["index"]),
                     emotion_id=emo, production_tokens=int(e.prod_tokens), allowed=int(e.max_tokens))
                sys.exit(1)

            cc = len(chunks)
            for ci, chunk_text in enumerate(chunks):
                pct = 30 + int(((i + (ci + 1) / cc) / max(n, 1)) * 60)
                # 진행률: 원본 문장 n / 생성 조각 m — 수치만(텍스트 전문 없음). chunk마다 watchdog 정상 갱신.
                emit("progress", percent=pct,
                     message=f"합성 중... (문장 {i + 1}/{n}, 조각 {ci + 1}/{cc})")

                # 원본 속성 상속(재감정/재언어감지·기본참조 폴백 없음): text만 chunk로 교체.
                cseg = dict(seg)
                cseg["text"] = chunk_text
                g = _generate_segment(model, cseg, builder, proc)

                if g["termination_reason"] == "generation_limit":
                    # 상한 도달 → 잘린 WAV 미저장 + offending 구조화 오류(정수·감정 ID만).
                    emit("error", code="GENERATION_LIMIT_EXCEEDED", segment_index=int(seg["index"]),
                         chunk_index=int(ci), emotion_id=emo,
                         generated_iterations=int(g["generated_iterations"]),
                         generation_limit=int(g["generation_limit"]),
                         termination_reason="generation_limit", status="generation_limit")
                    sys.exit(1)

                wavs, sr = g["wavs"], g["sr"]
                d = wavs[0] if isinstance(wavs, list) else wavs
                d = np.asarray(d, dtype=np.float32)
                if d.ndim > 1:
                    d = d.mean(axis=1)
                if not (isinstance(sr, (int, float)) and sr > 0):
                    raise RuntimeError(f"세그먼트 {seg['index']} 조각 {ci} sr 이상: {sr}")
                if d.size == 0:
                    raise RuntimeError(f"세그먼트 {seg['index']} 조각 {ci} 빈 오디오")
                if not np.all(np.isfinite(d)):
                    raise RuntimeError(f"세그먼트 {seg['index']} 조각 {ci} 비유한(NaN/Inf) 샘플")

                # chunk out_path: job_dir 내부 결정적 파일명(원본 out_path 기반). job_dir 밖 경로 금지.
                cpath = _chunk_out_path(seg["out_path"], ci)
                sf.write(cpath, d, int(sr))
                done.append({"original_segment_index": int(seg["index"]), "chunk_index": int(ci),
                             "chunk_count": int(cc), "out_path": cpath, "sr": int(sr),
                             "x_vector_only": bool(seg.get("x_vector_only", False)), "emotion_id": emo,
                             "production_tokens": int(g["prod_tokens"]),
                             "generation_limit": int(g["generation_limit"]),
                             "generated_iterations": int(g["generated_iterations"]),
                             "termination_reason": g["termination_reason"], "status": "ok"})

        emit("result", segments=done, success=True)

    except Exception as e:
        import traceback
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
