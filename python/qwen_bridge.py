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
stdout: progress/stage/heartbeat/result/error JSON 라인(부모가 실시간 읽음). 각 세그먼트 wav는 raw 저장(후처리 없음).
  result.segments[*]에 prod_tokens/generation_limit/generated_iterations/termination_reason 포함.
  error.code == GENERATION_LIMIT_EXCEEDED 는 상한 도달 — segment_index/generated_iterations/generation_limit(정수)만,
  전사·문장·경로는 절대 포함하지 않는다.

수명주기 이벤트(C1):
  {"type":"stage","stage":"loading"|"loaded"|"generating", ...}  단계 전이(수치/enum만)
  {"type":"heartbeat","stage":"loading","seq":N,"elapsed_sec":F}  로딩 중 생존 신호(10~15s 간격)
  로딩은 blocking 단일 호출(from_pretrained)이라 그 사이 stdout이 전혀 없었다 — 부모의 무응답 timeout이
  '정상이지만 느린 콜드 로딩'을 죽일 수 있었다. heartbeat는 부모의 '비활성 timer'만 갱신하며,
  부모가 별도로 두는 '기동 hard deadline'은 절대 연장하지 않는다(멈춘 로딩은 여전히 죽는다).
  loaded 이후에는 heartbeat를 보내지 않는다 — 생성 구간 무응답 계약(280s)을 그대로 보존하기 위함.
"""
import sys
import json
import threading
import time

import generation_limit  # 순수 계산(math만). 스크립트 디렉터리(python/)가 sys.path에 있어 import 가능.
import text_segmenter    # 다국어 token-aware 자동 분할(계약 B). 순수 로직.
import chunk_paths       # chunk 경로 규칙(bridge·worker 공용 순수 헬퍼).

# heartbeat 주기(초). 부모 무응답 timeout(280s)보다 훨씬 짧아야 하고, 로그를 덮지 않을 만큼은 길어야 한다.
_HEARTBEAT_SEC = 12.0

# emit 직렬화 락 — heartbeat 스레드와 메인 스레드가 같은 stdout에 쓴다.
_EMIT_LOCK = threading.Lock()

_T0 = time.monotonic()


def emit(msg_type, **kwargs):
    """JSON 한 줄을 stdout에 원자적으로 쓴다.

    print()는 본문과 end('\n')를 '두 번' write 하므로 두 스레드가 섞이면 JSON 라인이 깨진다.
    문자열을 미리 합쳐 락 아래에서 단일 write 하는 것이 heartbeat 스레드 도입의 전제다."""
    line = json.dumps({"type": msg_type, **kwargs}, ensure_ascii=False) + "\n"
    with _EMIT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def _elapsed(clock=None):
    return round((clock or time.monotonic)() - _T0, 2)


def _load_with_heartbeat(load_fn, stage="loading", interval=_HEARTBEAT_SEC,
                         clock=time.monotonic, emit_fn=None):
    """load_fn()을 실행하는 동안 interval마다 heartbeat를 emit 한다(생존 신호).

    load_fn 자체는 '호출 스레드'에서 그대로 실행된다 — 모델/토치 객체가 다른 스레드로 새지 않는다.
    heartbeat 스레드는 daemon이며 load_fn 반환/예외 모두에서 finally로 정지·join 된다.
    → loaded 이후에는 heartbeat가 단 한 개도 나가지 않는다(생성 구간 280s 계약 보존).

    interval/clock/emit_fn 은 테스트 주입점이다(분 단위 sleep 없이 결정적으로 검증)."""
    e = emit_fn or emit
    stop = threading.Event()
    state = {"seq": 0}

    def _beat():
        while not stop.wait(interval):
            state["seq"] += 1
            e("heartbeat", stage=stage, seq=state["seq"], elapsed_sec=_elapsed(clock))

    th = threading.Thread(target=_beat, daemon=True)
    th.start()
    try:
        return load_fn()
    finally:
        stop.set()
        th.join(timeout=max(interval, 1.0))


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


def _instruct_probe_kwargs(model, seg, probe_context):
    """instruct_ids 실험 probe — **production 에서는 절대 켜지지 않는다.**

    이 모델(Qwen3-TTS Base)의 voice clone 경로에는 감정 지시 인자가 없다. 유일한 미검증 통로가
    model.generate 의 instruct_ids 명명 파라미터다:
      generate_voice_clone(**kwargs) → _merge_generate_kwargs 가 `dict(kwargs)` 로 시작해
      알려진 샘플링 인자만 덮어쓰므로, 모르는 키는 그대로 model.generate 까지 간다.
    → **accepted 는 구조적으로 거의 확실하다. honored 는 완전히 미검증이다.**
    같은 vendor 파일이 `tts_model_size in "0b6"` 에 대해 "instruct is not supported" 라고
    선언하고 있고 우리 스냅샷이 정확히 "0b6" 이다 — 그래서 이것은 기능이 아니라 실험이다.

    켜지는 조건은 둘 다 만족해야 한다:
      1) probe_context 가 'experiment' (production 이면 요청 여부와 무관하게 꺼진다)
      2) 세그먼트에 명시적 실험 지시문이 실려 있다
    production 경로(tts_worker)는 이 키를 쓰지 않으므로 조건 2 도 성립하지 않는다 —
    이중 차단이며, 기본 경로에서는 generate_voice_clone 호출 인자가 한 글자도 바뀌지 않는다.

    반환: (kwargs, record) — 미시도면 ({}, None). record 에 honored 는 **없다**(여기서 정할 수 없다).
    """
    if probe_context != "experiment":
        return {}, None
    text = seg.get("instruct_probe_text")
    if not text:
        return {}, None
    # 토큰화 도구는 vendor 의 것을 '읽어서' 쓴다(수정하지 않는다). 부재하면 조용히 넘어가지 않고
    # 시도했다는 사실과 실패를 그대로 남긴다 — 미시도와 거부는 다른 결론이기 때문이다.
    builder = getattr(model, "_build_instruct_text", None)
    tokenize = getattr(model, "_tokenize_texts", None)
    if not callable(builder) or not callable(tokenize):
        return {}, {"attempted": True, "accepted": False, "reason": "instruct_tokenizer_absent"}
    ids = tokenize([builder(str(text))])
    return {"instruct_ids": [ids[0]]}, {"attempted": True, "accepted": None,
                                        "reason": "instruct_ids_submitted"}


def _generate_segment(model, seg, builder, proc, probe_context="production"):
    """세그먼트 1개 합성 + 안전장치. production token → 동적 상한 → 상한 건 생성 → 반복 계측 → 종료 판정.
    반환: dict(wavs, sr, prod_tokens, generation_limit, generated_iterations, termination_reason).
    counter 미측정(0)·상한 산정 실패는 조용히 통과하지 않고 예외(안전장치 없는 성공 금지).

    probe_context: 'production'(기본) | 'experiment'. 기본값에서는 instruct probe 가 완전히 꺼져
    generate_voice_clone 호출 인자가 이전과 동일하다(동작 불변)."""
    xvo = bool(seg.get("x_vector_only", False))
    ref_text = "" if xvo else (seg.get("ref_text") or "")
    prod_tokens = _prod_tokens(builder, proc, seg["text"])
    seg_limit = generation_limit.compute_max_new_tokens(prod_tokens)
    probe_kwargs, probe = _instruct_probe_kwargs(model, seg, probe_context)
    _COUNTER["n"] = 0
    # 이 한 호출이 곧 'blocking 생성 구간'이다 — 그 사이 stdout 이 없으므로 production 비활성
    # timeout 280s 가 재는 창과 정확히 같은 구간이다. 그래서 상한 정책 판단에 쓸 수 있는
    # seconds_per_iteration 은 이 구간만 재야 한다.
    #
    # tts_worker 의 elapsed_seconds 로 대신할 수 없다: 그 타이머는 장치 선택·참조 평가·모델
    # 로딩·결합·pitch·원자적 배치까지 포함한 '작업 전체' 시간이다. 또 generated_iterations 가
    # chunk 단위이므로 elapsed 도 chunk 단위여야 나눗셈이 의미를 갖는다.
    _t_gen = time.monotonic()
    # probe_kwargs 는 기본 경로에서 항상 빈 dict 다 → 호출 인자·동작 불변.
    wavs, sr = model.generate_voice_clone(
        text=seg["text"], language=seg.get("language_name", "Korean"),
        ref_audio=seg["ref_audio"], ref_text=ref_text,
        x_vector_only_mode=xvo, max_new_tokens=seg_limit, **probe_kwargs)
    gen_elapsed = round(time.monotonic() - _t_gen, 3)
    if probe is not None and probe.get("accepted") is None:
        # 예외 없이 여기까지 왔다 = 엔진이 instruct_ids 를 받아들였다(accepted).
        # ⚠️ honored 는 여기서 절대 정하지 않는다 — 소리가 실제로 달라졌는지는 이 자리에서 알 수 없다.
        #    판정은 오프라인 분석기가 emotion_acoustic.emotion_result_follow 로 별도 측정해야 한다.
        probe = dict(probe, accepted=True, reason="instruct_ids_accepted")
    iters = _COUNTER["n"]
    if iters <= 0:
        # 계측 래퍼가 동작하지 않은 것 — 상한이 실제로 걸렸는지 확인 불가. 성공 처리 금지.
        raise RuntimeError(
            "TTS_COMPAT: talker 반복 계측값이 0 — StoppingCriteria 계측 경로 미동작. 안전장치 없이 통과 금지.")
    reason = generation_limit.classify_termination(iters, seg_limit)
    return {"wavs": wavs, "sr": sr, "prod_tokens": prod_tokens,
            "generation_limit": seg_limit, "generated_iterations": iters,
            "termination_reason": reason, "generation_elapsed_sec": gen_elapsed,
            # 실험 probe 결과(기본 경로에서는 항상 None). honored 키는 존재하지 않는다.
            "instruct_probe": probe}


class BridgeSegmentTooLong(Exception):
    """자동 분할로도 상한 이내 못 만든 원본 줄(계약 B). 생성 시작 전에 발생 → generate 호출 0."""

    def __init__(self, segment_index, emotion_id, production_tokens, allowed):
        self.segment_index = segment_index
        self.emotion_id = emotion_id
        self.production_tokens = production_tokens
        self.allowed = allowed
        super().__init__(f"TEXT_SEGMENT_TOO_LONG(seg={segment_index})")


class BridgeGenerationLimit(Exception):
    """chunk가 동적 상한 도달(계약 A). 잘린 WAV 미채택."""

    def __init__(self, segment_index, chunk_index, emotion_id, generated_iterations, generation_limit):
        self.segment_index = segment_index
        self.chunk_index = chunk_index
        self.emotion_id = emotion_id
        self.generated_iterations = generated_iterations
        self.generation_limit = generation_limit
        super().__init__(f"GENERATION_LIMIT_EXCEEDED(seg={segment_index}, chunk={chunk_index})")


def _build_chunk_plan(segments, builder, proc, max_seg_tok):
    """전 원본 segment를 먼저 분할(생성 없음). 하나라도 분할 실패면 BridgeSegmentTooLong →
    생성 루프에 진입하지 않아 generate 호출 0. 반환: [{seg, chunk_index, chunk_count, text}]."""
    plan = []
    for seg in segments:
        try:
            chunks = text_segmenter.split_for_generation(
                seg["text"], lambda t: _prod_tokens(builder, proc, t), max_seg_tok)
        except text_segmenter.SegmentTooLong as e:
            raise BridgeSegmentTooLong(int(seg["index"]), seg.get("emotion_id"),
                                       int(e.prod_tokens), int(e.max_tokens))
        cc = len(chunks)
        for ci, ctext in enumerate(chunks):
            plan.append({"seg": seg, "chunk_index": ci, "chunk_count": cc, "text": ctext})
    return plan


def _finalize_wav(wavs, sr, seg_index, chunk_index):
    """생성 결과 → 검증된 mono float32 1-D 배열. sr>0·non-empty·finite·mono 보장."""
    import numpy as np
    d = wavs[0] if isinstance(wavs, list) else wavs
    d = np.asarray(d, dtype=np.float32)
    if d.ndim > 1:
        d = d.mean(axis=1)   # 모델이 다채널을 주면 mono로 다운믹스(저장은 항상 mono 1-D)
    if not (isinstance(sr, (int, float)) and sr > 0):
        raise RuntimeError(f"세그먼트 {seg_index} 조각 {chunk_index} sr 이상: {sr}")
    if d.size == 0:
        raise RuntimeError(f"세그먼트 {seg_index} 조각 {chunk_index} 빈 오디오")
    if not np.all(np.isfinite(d)):
        raise RuntimeError(f"세그먼트 {seg_index} 조각 {chunk_index} 비유한(NaN/Inf) 샘플")
    return d


def _generate_plan(model, plan, builder, proc, n_segments, progress=None,
                   probe_context="production"):
    """chunk plan을 순서대로 생성. total_chunks 기준 진행률(시작/완료). chunk 상한 도달 → BridgeGenerationLimit.
    progress(percent, seg_index, n_segments, chunk_index, chunk_count, phase) 콜백(수치만).
    probe_context: 기본 'production' — instruct probe 가 꺼진 상태이며 동작이 이전과 동일하다."""
    import soundfile as sf
    total = len(plan)
    completed = 0
    done = []
    for item in plan:
        seg = item["seg"]
        ci = item["chunk_index"]
        cc = item["chunk_count"]
        if progress:
            progress(30 + (completed * 60) // total, int(seg["index"]), n_segments, ci, cc, "start")
        cseg = dict(seg)         # 원본 속성 상속 — text만 chunk로 교체
        cseg["text"] = item["text"]
        g = _generate_segment(model, cseg, builder, proc, probe_context)
        if g["termination_reason"] == "generation_limit":
            raise BridgeGenerationLimit(int(seg["index"]), int(ci), seg.get("emotion_id"),
                                        int(g["generated_iterations"]), int(g["generation_limit"]))
        d = _finalize_wav(g["wavs"], g["sr"], seg["index"], ci)
        cpath = chunk_paths.chunk_out_path(seg["out_path"], ci)  # 결정적·job_dir 내부
        sf.write(cpath, d, int(g["sr"]))
        completed += 1
        done.append({"original_segment_index": int(seg["index"]), "chunk_index": int(ci),
                     "chunk_count": int(cc), "out_path": cpath, "sr": int(g["sr"]),
                     "x_vector_only": bool(seg.get("x_vector_only", False)),
                     "emotion_id": seg.get("emotion_id"), "production_tokens": int(g["prod_tokens"]),
                     "generation_limit": int(g["generation_limit"]),
                     "generated_iterations": int(g["generated_iterations"]),
                     # blocking 생성 구간만 잰 값(가산). 없으면 None — 0 으로 위조하지 않는다.
                     "generation_elapsed_sec": g.get("generation_elapsed_sec"),
                     "termination_reason": g["termination_reason"], "status": "ok"})
        if progress:
            progress(30 + (completed * 60) // total, int(seg["index"]), n_segments, ci, cc, "done")
    return done


def _load_model(model_path, device):
    """로컬 스냅샷 '경로'에서 로드(repo id 아님 → 오프라인에서 HF API 호출 회피) + local_files_only.
    sdpa 우선, 실패 시 원인 보존 + 부분참조 해제·gc·CUDA cache 정리 후 eager 재시도.
    CPU면 float32, CUDA면 bfloat16(고정 금지). 둘 다 실패하면 실제 원인을 포함해 예외."""
    import gc
    import torch
    from qwen_tts import Qwen3TTSModel
    dtype = torch.bfloat16 if str(device).startswith("cuda") else torch.float32
    errors = {}
    # sdpa 실패 시 eager 재시도 = '두 번째 전체 로딩'이다. 예전에는 두 시도 모두 stdout이 없어
    # "한 번 느린 로딩"과 "sdpa 실패 후 두 번째 시도"를 사후에 구분할 수 없었다.
    # attempt/attn 을 담은 stage=loading 이벤트가 그 모호성을 없앤다(재시도가 눈에 보인다).
    for attempt, attn in enumerate(("sdpa", "eager"), start=1):
        try:
            emit("stage", stage="loading", attn=attn, attempt=attempt, device=str(device),
                 elapsed_sec=_elapsed())
            m = _load_with_heartbeat(
                lambda: Qwen3TTSModel.from_pretrained(
                    model_path, device_map=device, dtype=dtype,
                    attn_implementation=attn, local_files_only=True),
                stage="loading")
            emit("stage", stage="loaded", attn=attn, attempt=attempt, dtype=str(dtype),
                 elapsed_sec=_elapsed())
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
    # instruct probe 컨텍스트. production 워커(tts_worker)는 이 키를 보내지 않으므로 항상 'production'
    # 이고, 그 값에서는 probe 가 켜지는 길이 없다(실험 하네스만 'experiment' 를 명시한다).
    probe_context = cfg.get("probe_context", "production")
    segments = cfg.get("segments", [])
    if not segments:
        emit("error", message="합성할 세그먼트가 없습니다.")
        sys.exit(1)

    try:
        emit("progress", percent=10, message=f"Qwen3-TTS 모델 로딩 중... ({device}, offline)")
        model = _load_model(model_path, device)
        builder, proc = _preflight_tokenizer(model)  # 안전장치 전제 — 부재 시 여기서 명확히 실패
        _install_talker_counter(model)
        n = len(segments)

        # 1단계: 전 segment 선분할(생성 없음). 실패 시 여기서 종료 → generate 호출 0(뒤 실패로 앞 낭비 방지).
        max_seg_tok = generation_limit.max_segment_tokens()
        try:
            plan = _build_chunk_plan(segments, builder, proc, max_seg_tok)
        except BridgeSegmentTooLong as e:
            emit("error", code="TEXT_SEGMENT_TOO_LONG", segment_index=e.segment_index,
                 emotion_id=e.emotion_id, production_tokens=e.production_tokens, allowed=e.allowed)
            sys.exit(1)

        # 2단계: 생성. total_chunks 기준 진행률(시작 30% → 완료 90%). 시작·완료 모두 수치만(텍스트 없음).
        def _progress(percent, seg_index, n_seg, ci, cc, phase):
            tag = "시작" if phase == "start" else "완료"
            emit("progress", percent=percent,
                 message=f"합성 중... (문장 {seg_index + 1}/{n_seg}, 조각 {ci + 1}/{cc} {tag})")

        # loaded → generating 전이. 이 시점 이후 heartbeat는 없고, 부모의 무응답 280s 계약이
        # 기존 그대로 적용된다(생성 구간 안전장치는 이 변경으로 완화되지 않는다).
        emit("stage", stage="generating", elapsed_sec=_elapsed())
        try:
            done = _generate_plan(model, plan, builder, proc, n, progress=_progress,
                                  probe_context=probe_context)
        except BridgeGenerationLimit as e:
            emit("error", code="GENERATION_LIMIT_EXCEEDED", segment_index=e.segment_index,
                 chunk_index=e.chunk_index, emotion_id=e.emotion_id,
                 generated_iterations=e.generated_iterations, generation_limit=e.generation_limit,
                 termination_reason="generation_limit", status="generation_limit")
            sys.exit(1)

        emit("result", segments=done, success=True)

    except Exception as e:
        import traceback
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.stderr.write(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
