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
  seed                   (선택) 진단 전용 고정 seed. 없으면 미호출 = 기존 동작 그대로.
  segments               [{index, text, ref_audio, ref_text, x_vector_only, language_name, out_path,
                          prefix_text?}]
                         x_vector_only=True면 x-vector-only(ref_text 무시), False면 ICL(ref_text 필요)
                         language_name은 세그먼트별(Korean/English/Chinese/Japanese)
                         prefix_text(선택, 비어있지 않으면 controlled-prefix 모드): 이 chunk 를 생성할 때
                         목표 대사 앞에 붙여 '의도적으로 먼저 발화시킬' 참조 전사.
                         ★이 브리지는 controlled-prefix 를 **자르지 않는다**. 파형만으로는 목표 대사
                         시작을 특정할 수 없고(참조 발화 내부 무음이 더 길다 — prefix_alignment §D 실측),
                         텍스트(ASR) 정렬이 필요한데 이 venv 에는 whisper 가 없다(설치 금지).
                         그래서 raw 를 그대로 chunk WAV 로 쓰고 needs_alignment/alignment_request 를
                         부모에게 넘긴다. 부모(tts_worker)가 정렬·절단을 끝낸 뒤에야 chunk 가 확정된다.
stdout: progress/stage/heartbeat/result/error JSON 라인(부모가 실시간 읽음). 각 세그먼트 wav는 raw 저장(후처리 없음).
  result.segments[*]에 prod_tokens/generation_limit/generated_iterations/termination_reason 포함.
  controlled-prefix chunk 는 needs_alignment=True 와 alignment_request(prefix_text/target_text/
  sample_rate)를 함께 낸다 — 부모 정렬 전용 입력이며 metadata/로그로는 절대 옮기지 않는다.
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
import os
import sys
import json
import threading
import time

import generation_limit  # 순수 계산(math만). 스크립트 디렉터리(python/)가 sys.path에 있어 import 가능.
import text_segmenter    # 다국어 token-aware 자동 분할(계약 B). 순수 로직.
import chunk_paths       # chunk 경로 규칙(bridge·worker 공용 순수 헬퍼).
import prefix_alignment  # controlled-prefix 텍스트 조립 + 파형 자동 경계(순수 stdlib).

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
            # 협조적 정지: 플래그 파일이 생기면 True 를 반환해 generate 를 **정상 반환**시킨다.
            # 강제 kill 과 달리 지금까지의 codes 가 decode 를 거쳐 파형이 된다.
            # scores 미사용·난수 미사용은 그대로라 생성 분포는 불변이다.
            if _COUNTER["n"] % _STOP_CHECK_EVERY == 0:
                fp = os.environ.get(DIAG_STOP_FLAG_ENV)
                if fp and os.path.exists(fp):
                    _STOP["requested"] = True
                    _STOP["at_step"] = _COUNTER["n"]
                    return True
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


def _seed_rng(seed, chunk_ordinal):
    """진단 전용 — 고정 seed 로 talker 샘플링을 재현 가능하게 만든다.

    seed 가 None 이면 아무것도 하지 않는다(production 기본값 = 기존 동작 그대로, 계약 불변).
    chunk 마다 seed+ordinal 로 다시 심는 이유: 한 프로세스에서 여러 chunk 를 이어 생성할 때
    'N번째 생성' 이라는 프로세스 상태가 결과에 섞이면, 참조 차이 때문인지 앞선 생성 때문인지
    구분할 수 없다. chunk 별로 RNG 를 고정하면 그 교란이 사라진다 — 캐시·버퍼 잔류를
    RNG 변화와 분리해 재는 것이 이 계측의 목적이다."""
    if seed is None:
        return None
    import torch
    s = (int(seed) + int(chunk_ordinal)) % (2 ** 31 - 1)
    torch.manual_seed(s)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(s)
    return s


def _generation_text(seg):
    """이 chunk 를 실제로 모델에 넘길 텍스트.

    controlled-prefix(prefix_text 있음) → [참조 전사][문장 종결][개행][목표 대사] 한 덩어리.
    그 외 → 목표 대사 그대로(기존 동작 불변)."""
    prefix = (seg.get("prefix_text") or "").strip()
    if not prefix:
        return seg["text"], False
    _pfx = prefix_alignment.build_controlled_prefix_text(prefix, seg["text"])
    return _pfx, True


def _instruct_probe_kwargs(model, seg, probe_context):
    """instruct_ids 실험 probe — **production 에서는 절대 켜지지 않는다.**

    이 모델(Qwen3-TTS Base)의 voice clone 경로에는 감정 지시 인자가 없다. 유일한 미검증 통로가
    model.generate 의 instruct_ids 명명 파라미터다:
      generate_voice_clone(**kwargs) → _merge_generate_kwargs 가 `dict(kwargs)` 로 시작해
      알려진 샘플링 인자만 덮어쓰므로, 모르는 키는 그대로 model.generate 까지 간다.
    → 코드 경로상 수용될 자리는 있으나 런타임 관측이 없다.
      **accepted 도 honored 도 미확인이다** — 배선 추적은 관측이 아니다.
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

    controlled-prefix 일 때 상한은 **결합 텍스트 기준**으로 산정한다(정책 자체는 그대로 —
    compute_max_new_tokens 를 다른 공식으로 바꾸지 않는다). 참조 발화만큼 codec 프레임이 늘어나므로
    상한이 부족하면 termination_reason='generation_limit' 으로 드러나고 상위가 구조화 오류를 낸다
    (잘린 결과를 조용히 채택하지 않는다).

    probe_context: 'production'(기본) | 'experiment'. 기본값에서는 instruct probe 가 완전히 꺼져
    generate_voice_clone 호출 인자가 이전과 동일하다(동작 불변)."""
    xvo = bool(seg.get("x_vector_only", False))
    ref_text = "" if xvo else (seg.get("ref_text") or "")
    gen_text, controlled_prefix = _generation_text(seg)
    prod_tokens = _prod_tokens(builder, proc, gen_text)
    seg_limit = generation_limit.compute_max_new_tokens(prod_tokens)
    _dmax = _diag_max_new_tokens()
    if _dmax is not None:
        # 진단 상한. termination 판정(classify_termination)은 이 값 기준으로 그대로 돈다 —
        # 상한 도달이면 generation_limit 으로 드러나지 조용히 잘린 결과를 채택하지 않는다.
        seg_limit = _dmax
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
        text=gen_text, language=seg.get("language_name", "Korean"),
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
    if _STOP["requested"]:
        # 사용자 중지는 eos 도 generation_limit 도 아니다. 별도 사유로 남긴다.
        reason = "cooperative_stop"
        emit("stage", stage="cooperative_stop", at_step=int(_STOP["at_step"] or iters),
             generated_iterations=int(iters))
    return {"wavs": wavs, "sr": sr, "prod_tokens": prod_tokens,
            "generation_limit": seg_limit, "generated_iterations": iters,
            "termination_reason": reason, "generation_elapsed_sec": gen_elapsed,
            "controlled_prefix": controlled_prefix,
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


DIAG_CAP_ENV = "AUDIOFORGE_DIAG_SEGMENT_TOKEN_CAP"
DIAG_SINGLE_ENV = "AUDIOFORGE_DIAG_SINGLE_CHUNK_OVERTEST"
DIAG_MAXNEW_ENV = "AUDIOFORGE_DIAG_MAX_NEW_TOKENS"
DIAG_STOP_FLAG_ENV = "AUDIOFORGE_DIAG_STOP_FLAG"
_STOP_CHECK_EVERY = 16   # step 마다 stat() 하면 느려진다. 16 step ~ 1.3초 지연.
_STOP = {"requested": False, "at_step": None}


def _diag_flag(name):
    """진단 플래그. 값이 있으면 켠다. 잘못된 값은 조용히 무시하지 않는다."""
    v = (os.environ.get(name) or "").strip()
    if not v:
        return False
    if v not in ("1", "true", "True"):
        raise RuntimeError("DIAG_FLAG_INVALID: %s=%r (1 만 허용)" % (name, v))
    return True


def _diag_max_new_tokens():
    """진단 전용 codec 생성 상한. 분할 기준이 아니라 runaway 방지 안전장치다.

    production 은 generation_limit 이 유일 권위이고 이 훅은 환경변수가 있을 때만 산다.
    조용한 clamp 를 하지 않는다 — 범위를 벗어나면 실패시킨다."""
    raw = (os.environ.get(DIAG_MAXNEW_ENV) or "").strip()
    if not raw:
        return None
    try:
        v = int(raw)
    except ValueError:
        raise RuntimeError("DIAG_MAXNEW_INVALID: %s=%r" % (DIAG_MAXNEW_ENV, raw))
    # 상한은 모델 architecture(talker max_position_embeddings=32768)를 따른다.
    # 예전에 임의로 둔 4096 은 근거가 없었고 실제로 6144 요청을 막았다.
    if not (1 <= v <= 32768):
        raise RuntimeError("DIAG_MAXNEW_OUT_OF_RANGE: %s=%d (1~32768)" % (DIAG_MAXNEW_ENV, v))
    return v
DIAG_SENTENCE_ENV = "AUDIOFORGE_DIAG_SENTENCE_FIRST"


def _diag_cap(default_cap):
    """진단 전용 분할 상한 override.

    production 기본값은 generation_limit.max_segment_tokens() 그대로다. 이 훅은
    분할 정책 비교 하네스가 같은 코드 경로로 다른 상한을 재보기 위한 것이며,
    환경변수가 없으면 **한 글자도 다르게 동작하지 않는다**.
    상한을 올려도 동적 상한(ABS_LIMIT)과 termination 판정은 그대로 적용되므로,
    과도한 값을 주면 generation_limit 으로 드러나지 조용히 잘리지 않는다.
    """
    raw = os.environ.get(DIAG_CAP_ENV)
    if not raw:
        return default_cap, False
    try:
        v = int(raw)
    except ValueError:
        raise RuntimeError("DIAG_CAP_INVALID: %s=%r" % (DIAG_CAP_ENV, raw))
    if v <= 0:
        raise RuntimeError("DIAG_CAP_INVALID: %s=%r" % (DIAG_CAP_ENV, raw))
    return v, True


def _build_chunk_plan(segments, builder, proc, max_seg_tok):
    """전 원본 segment를 먼저 분할(생성 없음). 하나라도 분할 실패면 BridgeSegmentTooLong →
    생성 루프에 진입하지 않아 generate 호출 0. 반환: [{seg, chunk_index, chunk_count, text}]."""
    plan = []
    if _diag_flag(DIAG_SINGLE_ENV):
        # 분할하지 않는다. 250자 전체가 vendor 호출 한 번의 target 이 된다.
        emit("stage", stage="diagnostic_single_chunk", segments=len(segments))
        for seg in segments:
            plan.append({"seg": seg, "chunk_index": 0, "chunk_count": 1, "text": seg["text"]})
        return plan
    max_seg_tok, diag = _diag_cap(max_seg_tok)
    sentence_first = bool(os.environ.get(DIAG_SENTENCE_ENV))
    if diag or sentence_first:
        emit("stage", stage="diagnostic_split", cap=max_seg_tok, sentence_first=sentence_first)
    for seg in segments:
        try:
            count = lambda t: _prod_tokens(builder, proc, t)
            if sentence_first:
                # 진단 전용: 문장 경계를 넘겨 병합하지 않는다.
                chunks = []
                for snt in text_segmenter._cut_after(
                        seg["text"], text_segmenter.SENTENCE_ENDERS, eat_closers=True):
                    if not snt.strip():
                        continue
                    chunks.extend([snt] if count(snt) <= max_seg_tok
                                  else text_segmenter.split_for_generation(snt, count, max_seg_tok))
            else:
                chunks = text_segmenter.split_for_generation(seg["text"], count, max_seg_tok)
        except text_segmenter.SegmentTooLong as e:
            raise BridgeSegmentTooLong(int(seg["index"]), seg.get("emotion_id"),
                                       int(e.prod_tokens), int(e.max_tokens))
        cc = len(chunks)
        for ci, ctext in enumerate(chunks):
            plan.append({"seg": seg, "chunk_index": ci, "chunk_count": cc, "text": ctext})
    return plan


VENDOR_CROP_SCHEMA = "af-vendor-internal-crop/2"
VENDOR_CROP_CONTRACT_VERSION = 2
VENDOR_CROP_AUTHORITY = "vendor_native_ref_code"
VENDOR_CROP_ALGORITHM_ID = "qwen3_tts.generate_voice_clone.proportional_ref_code_crop"


def _sha_bytes(b):
    import hashlib
    return hashlib.sha256(b).hexdigest()


def _sha_text(t):
    return _sha_bytes((t or "").encode("utf-8"))


def _ref_code_frames(model, seg):
    """참조 오디오를 vendor 와 같은 tokenizer 로 인코딩해 ref_code 프레임 수를 얻는다.

    vendor 가 이 값을 반환하지 않으므로 발행 근거로 쓰려면 직접 재현해야 한다.
    실패하면 None — 상위가 fail-closed 한다(추정값으로 채우지 않는다)."""
    try:
        import soundfile as _sf
        wav, sr = _sf.read(seg["ref_audio"])
        if getattr(wav, "ndim", 1) > 1:
            wav = wav.mean(axis=1)
        enc = model.model.speech_tokenizer.encode(wav, sr=sr)
        codes = enc.audio_codes[0]
        return int(codes.shape[0])
    except Exception:
        return None


def _build_vendor_crop_record(model, seg, g, d, sr, wav_path):
    """vendor 내부 codec-frame crop 의 발행 근거. 값을 만들어 내지 않고 실측만 담는다.

    ASR alignment record 와 **별개 권위**다. 둘이 동시에 존재하면 상위가 실패시킨다.
    필드가 하나라도 없으면 None 을 돌려 fail-closed 로 보낸다."""
    import numpy as _np
    ref_frames = _ref_code_frames(model, seg)
    gen_frames = int(g.get("generated_iterations") or 0)
    if not ref_frames or gen_frames <= 0:
        return None
    arr = _np.asarray(d, dtype="float32")
    returned = int(arr.shape[0])
    total_frames = ref_frames + gen_frames
    if returned <= 0:
        return None
    if not bool(_np.all(_np.isfinite(arr))) or int(_np.sum(_np.abs(arr) >= 0.999)) > 0:
        return None
    return {
        "schema_version": VENDOR_CROP_SCHEMA,
        "crop_contract_version": VENDOR_CROP_CONTRACT_VERSION,
        "model_revision": str(getattr(model, "_af_model_revision", "") or
                              os.environ.get("AUDIOFORGE_QWEN_REVISION") or "UNKNOWN"),
        "sample_rate": int(sr),
        "prefix_text_enabled": False,
        "x_vector_only_mode": bool(seg.get("x_vector_only")),
        "reference_audio_sha256": _sha_bytes(open(seg["ref_audio"], "rb").read()),
        "reference_text_sha256": _sha_text(seg.get("ref_text")),
        "target_script_sha256": _sha_text(seg.get("text")),
        "ref_code_frames": ref_frames,
        "generated_code_frames": gen_frames,
        "total_code_frames": total_frames,
        "returned_samples": returned,
        # 발행 대상 파일 자체의 바이트로 묶는다 — 메모리 float32 는 기록 형식과 값이 달라
        # 검증 측과 절대 일치하지 않는다.
        "returned_pcm_sha256": _sha_bytes(open(wav_path, "rb").read()),
        "crop_authority": VENDOR_CROP_AUTHORITY,
        # ★ decoded_total/cut 좌표는 vendor 가 반환하지 않는다. 역산해서 관측값인 척하지 않는다.
        "crop_coordinates_observed": False,
        "termination_reason": g.get("termination_reason"),
        "external_alignment_calls": 0,
    }


def _vendor_returned(dirpath, d, sr, g, seg, ci):
    """vendor 반환 PCM 을 temp -> 재검증 -> SHA -> atomic rename 으로 보존(진단 전용)."""
    try:
        import hashlib
        import numpy as _np, soundfile as _sf
        os.makedirs(dirpath, exist_ok=True)
        base = os.path.join(dirpath, "vendor-returned-target-only")
        tmp = base + ".part"
        _sf.write(tmp, _np.ascontiguousarray(_np.asarray(d, dtype="float32")), sr,
                  format="WAV", subtype="PCM_16")
        chk, _csr = _sf.read(tmp)
        if _csr != sr or chk.shape[0] != int(_np.asarray(d).shape[0]):
            raise RuntimeError("VENDOR_RETURNED_VERIFY_FAILED")
        wav_sha = hashlib.sha256(open(tmp, "rb").read()).hexdigest()
        gen = int(g.get("generated_iterations") or 0)
        rec = {"source_run_id": os.path.basename(dirpath),
               "prefix_text_enabled": False,
               "generated_code_frames": gen,
               "returned_samples": int(_np.asarray(d).shape[0]),
               "sample_rate": sr,
               "codec_hop_samples": CODEC_HOP_SAMPLES,
               "crop_formula": "cut = int(ref_len / total_len * decoded_total_samples)",
               "ref_code_frames": "UNKNOWN",
               "total_code_frames": "UNKNOWN",
               "decoded_total_samples": "UNKNOWN",
               "vendor_internal_cut_samples": "UNKNOWN",
               "predicted_returned_samples_if_exact": gen * CODEC_HOP_SAMPLES,
               "output_wav_sha256": wav_sha,
               "external_alignment_calls": 0,
               "production_result": False,
               "diagnostic_only": True}
        jt = base + ".json.part"
        with open(jt, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, base + ".wav")
        os.replace(jt, base + ".json")
        emit("stage", stage="vendor_returned_kept", samples=rec["returned_samples"],
             generated_code_frames=gen)
    except Exception as e:
        emit("stage", stage="vendor_returned_failed", reason=type(e).__name__)


def _diag_save_raw(g, tag):
    """진단 전용: 발행되지 않는 파형을 진단 폴더에 남긴다. 발행 계약은 건드리지 않는다.

    폐기해 버리면 "어디서부터 무너졌는가" 를 영영 들을 수 없다. 실패해도 생성 흐름은 막지 않는다.
    """
    if os.environ.get("AUDIOFORGE_DIAG_KEEP_LIMIT_WAVEFORM") != "1":
        return
    try:
        import numpy as _np, soundfile as _sf
        base = os.environ.get("AUDIOFORGE_DIAG_LIMIT_WAVEFORM_PATH")
        if not base:
            return
        root, ext = os.path.splitext(base)
        dst = root + "-" + tag + (ext or ".wav")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        d = g["wavs"][0] if isinstance(g["wavs"], list) else g["wavs"]
        d = _np.asarray(d, dtype="float32")
        if d.ndim > 1:
            d = d.mean(axis=1)
        _sf.write(dst, _np.ascontiguousarray(d), int(g["sr"]))
        emit("stage", stage="diagnostic_raw_kept", tag=tag,
             frames=int(d.size), sr=int(g["sr"]))
    except Exception as e:
        emit("stage", stage="diagnostic_raw_failed", tag=tag, reason=type(e).__name__)


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


def _generate_plan(model, plan, builder, proc, n_segments, progress=None, seed=None,
                   probe_context="production"):
    """chunk plan을 순서대로 생성. total_chunks 기준 진행률(시작/완료). chunk 상한 도달 → BridgeGenerationLimit.
    progress(percent, seg_index, n_segments, chunk_index, chunk_count, phase) 콜백(수치만).
    seed 는 진단 전용(None이면 미호출 = 기존 동작).
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
        applied_seed = _seed_rng(seed, completed)
        g = _generate_segment(model, cseg, builder, proc, probe_context)
        if g["termination_reason"] == "cooperative_stop":
            _diag_save_raw(g, "cooperative-stop")
        if g["termination_reason"] == "generation_limit":
            _diag_save_raw(g, "limit-reached")
            raise BridgeGenerationLimit(int(seg["index"]), int(ci), seg.get("emotion_id"),
                                        int(g["generated_iterations"]), int(g["generation_limit"]))
        d = _finalize_wav(g["wavs"], g["sr"], seg["index"], ci)
        _vdir = os.environ.get("AUDIOFORGE_DIAG_VENDOR_RETURNED_DIR")
        if _vdir and not g.get("controlled_prefix"):
            # 진단 전용: vendor 내부 codec-frame crop 이 끝나고 외부 alignment 이전에
            # 반환된 PCM. controlled-prefix raw 와 구분되는 이름을 쓴다.
            _vendor_returned(_vdir, d, int(g["sr"]), g, seg, ci)

        alignment_request = None
        if g.get("controlled_prefix"):
            # ★여기서 자르지 않는다. 이 raw 는 **중간 산출물**이지 최종 결과가 아니다.
            # 파형만으로는 목표 대사 시작을 특정할 수 없다(실측: 참조 발화 내부의 문장 간 무음이
            # 더 길어서 전역 탐색이 0.87s 를 목표 onset 으로 오검출하고 ok=True 로 통과했다 —
            # prefix_alignment §D). 위치는 텍스트(ASR) 정렬로 먼저 잡아야 하는데 이 venv 에는
            # whisper 가 없다(설치하지 않는다). 그래서 정렬·절단은 부모가 한다.
            # 부모는 이 subprocess 가 끝난 뒤에 ASR 을 부르므로 Qwen 과 whisper 는 동시 적재되지 않는다.
            alignment_request = {"needs_alignment": True,
                                 "prefix_text": (seg.get("prefix_text") or ""),
                                 "target_text": item["text"],
                                 "sample_rate": int(g["sr"])}
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
                     "applied_seed": applied_seed,   # 진단 전용. seed 미지정이면 None.
                     # controlled-prefix 이면 raw 그대로 기록됐고 정렬·절단이 남아 있다.
                     # 절단 기록(reference_alignment/reference_cut_sample)은 부모가 정렬을 끝낸 뒤
                     # 채운다 — 여기서 None 인 채로 결과가 확정되지 않는다(_align_icl_chunks 가 강제).
                     "controlled_prefix": bool(g.get("controlled_prefix")),
                     # vendor native ICL(= controlled-prefix 없음, x-vector 아님)일 때만
                     # 발행 근거를 만든다. 실패하면 None 이라 상위가 fail-closed 한다.
                     "vendor_crop_record": (
                         _build_vendor_crop_record(model, seg, g, d, g["sr"], cpath)
                         if (not g.get("controlled_prefix")
                             and not seg.get("x_vector_only")) else None),
                     "needs_alignment": alignment_request is not None,
                     # 정렬 입력(부모 전용, 1회 소비 후 폐기). bridge stdout → 부모 메모리까지만 산다.
                     # metadata/로그/세션 어디에도 옮기지 않는다(_align_icl_chunks 가 pop 한다).
                     "alignment_request": alignment_request,
                     "reference_alignment": None, "reference_cut_sample": None,
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
                                   seed=cfg.get("seed"), probe_context=probe_context)
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
