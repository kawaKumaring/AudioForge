"""Qwen3-TTS 를 **같은 소리로 더 빨리** — 보조 모델(code predictor)의 15걸음을 직접 반복으로 돈다.

★왜 (2026-09-30 실측 · doc/reader-engine 4-6): 소리 1초 = 조각 12.5개, 조각마다 보조 모델이 HuggingFace generate() 를
  통째로 한 번 불러 값 15개를 차례로 만든다. 한 문장(10.5초 분량)에서 generate() 131번 · 한 걸음 1,965번이 전체 시간의 74% 였고,
  계산이 아니라 **부를 때마다 드는 준비 비용**이 대부분이었다(5층 모델에 값 하나 = 1ms 미만의 계산).
★무엇을 하나: generate() 대신 같은 일을 직접 한다 — 준비(처리기·멈춤 조건 목록 만들기 등)와 쓰지 않는 반환값
  (모든 층의 중간값 output_hidden_states=True)을 없앤다.
★같은 규칙으로 뽑는다(transformers 4.57 `_sample` 과 같은 순서): 점수를 float32 로 → temperature 로 나눔 → 상위 k 개만 →
  softmax → multinomial. 뽑지 않을 때(do_sample=False)는 가장 큰 값.
★패키지 파일은 고치지 않는다 — 불러온 모델의 이 한 함수만 우리 쪽에서 바꿔 끼운다(`apply`). 끄려면 AUDIOFORGE_QWEN_FAST=0.
"""
import os
import types


class _Result:
    __slots__ = ("sequences",)

    def __init__(self, sequences):
        self.sequences = sequences


def _pick(logits, do_sample, top_k, top_p, temperature):
    import torch
    scores = logits.to(dtype=torch.float32)
    if not do_sample:
        return torch.argmax(scores, dim=-1)
    if temperature is not None and float(temperature) != 1.0:
        scores = scores / float(temperature)
    if top_k is not None and int(top_k) > 0:
        k = min(int(top_k), scores.size(-1))
        kth = torch.topk(scores, k)[0][..., -1, None]
        scores = scores.masked_fill(scores < kth, float("-inf"))
    if top_p is not None and float(top_p) < 1.0:
        # transformers TopPLogitsWarper 와 같은 방식(오름차순 누적 확률로 자른다)
        sorted_logits, sorted_idx = torch.sort(scores, descending=False)
        cum = sorted_logits.softmax(dim=-1).cumsum(dim=-1)
        remove_sorted = cum <= (1 - float(top_p))
        remove_sorted[..., -1:] = False
        remove = remove_sorted.scatter(1, sorted_idx, remove_sorted)
        scores = scores.masked_fill(remove, float("-inf"))
    probs = torch.nn.functional.softmax(scores, dim=-1)
    return torch.multinomial(probs, num_samples=1).squeeze(1)


def _fast_generate(self, inputs_embeds=None, max_new_tokens=None, do_sample=None, top_p=None, top_k=None,
                   temperature=None, **_ignored):
    """code_predictor.generate() 와 같은 결과 모양(.sequences: [배치, max_new_tokens])."""
    import torch
    from transformers.cache_utils import DynamicCache
    g = self.generation_config
    do_sample = g.do_sample if do_sample is None else do_sample
    top_k = g.top_k if top_k is None else top_k
    top_p = g.top_p if top_p is None else top_p
    temperature = g.temperature if temperature is None else temperature
    n = int(max_new_tokens)
    with torch.no_grad():
        cache = DynamicCache()
        out = self(inputs_embeds=inputs_embeds, past_key_values=cache, use_cache=True)
        steps = out.generation_steps
        toks = []
        for i in range(n):
            tok = _pick(out.logits[:, -1, :], do_sample, top_k, top_p, temperature)
            toks.append(tok)
            if i == n - 1:
                break
            out = self(input_ids=tok[:, None], past_key_values=cache, use_cache=True, generation_steps=steps)
            steps = out.generation_steps
        return _Result(torch.stack(toks, dim=1))


# ── ② 15걸음을 미리 기록해 두고 다시 틀기(CUDA graph) ──────────────────────────
# ★남은 시간의 대부분은 한 걸음을 **부르는** 비용이었다(파이썬·프레임워크·GPU 명령 수십 개). 걸음의 모양은 늘 같다 —
#   첫 걸음 입력 2개, 이후 14걸음 입력 1개, 위치 0~15. 그래서 고정 크기 기억(StaticCache)으로 걸음마다 한 번씩 기록해 두고,
#   조각마다 그 기록을 다시 튼다. **값 뽑기(무작위)는 기록 밖에서** 한다 — 뽑는 규칙과 순서는 위와 같다.
# ★비트까지 같지는 않다 — 고정 기억은 빈 칸을 가린 채 16칸 전체로 주의를 계산해 끝자리 수가 다를 수 있다.
#   그래서 받아 적기·길이로 따로 확인한다. 기록에 실패하면 위의 직접 반복으로 돌아간다(끄기: AUDIOFORGE_QWEN_GRAPH=0).

class _GraphRunner:
    STEPS = 15

    def __init__(self, cp, batch, hidden, dtype, device):
        import torch
        from transformers.cache_utils import StaticCache
        self.cp = cp
        self.cache = StaticCache(config=cp.config, max_cache_len=self.STEPS + 1)
        self.emb = torch.zeros((batch, 2, hidden), dtype=dtype, device=device)
        self.tok = torch.zeros((batch, 1), dtype=torch.long, device=device)
        self.pos = [torch.tensor([0, 1], device=device)] + [torch.tensor([k + 1], device=device) for k in range(1, self.STEPS)]
        self.graphs, self.logits = [], []

    def _step(self, k):
        if k == 0:
            return self.cp(inputs_embeds=self.emb, past_key_values=self.cache, use_cache=True, cache_position=self.pos[0])
        return self.cp(input_ids=self.tok, past_key_values=self.cache, use_cache=True,
                       cache_position=self.pos[k], generation_steps=k)

    def capture(self):
        import torch
        with torch.no_grad():
            side = torch.cuda.Stream()
            side.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(side):
                for _ in range(2):                       # 데우기(기억 공간을 만들고 커널을 고른다)
                    for k in range(self.STEPS):
                        self._step(k)
            torch.cuda.current_stream().wait_stream(side)
            pool = None
            for k in range(self.STEPS):
                g = torch.cuda.CUDAGraph()
                with torch.cuda.graph(g, pool=pool):
                    out = self._step(k)
                pool = g.pool()
                self.graphs.append(g)
                self.logits.append(out.logits)

    def run(self, inputs_embeds, pick):
        import torch
        self.emb.copy_(inputs_embeds)
        toks = []
        for k in range(self.STEPS):
            self.graphs[k].replay()
            tok = pick(self.logits[k][:, -1, :])
            toks.append(tok)
            if k + 1 < self.STEPS:
                self.tok.copy_(tok[:, None])
        return torch.stack(toks, dim=1)


class _SampledRunner(_GraphRunner):
    """④ 15걸음 **과 값 뽑기까지** 한 기록으로 (2026-10-01).

    ★왜 (실측 · 본 모델을 묶은 뒤): 한 조각 30.8ms 중 보조 모델이 18.1ms(59%) — 기록은 걸음마다 다시 틀지만
      걸음 사이마다 파이썬이 값을 뽑고(top-k·softmax·multinomial) 다음 입력에 복사하느라 열다섯 번 오갔다.
    ★뽑기 규칙은 같다(`_pick` 그대로 기록한다). 무작위는 GPU 의 기록용 난수(재생마다 이어진다)로 뽑는다.
      실측(같은 글 4 × 씨앗 4): 걸음마다 묶기와 **결과 길이가 16개 모두 같았고** 받아 적기 오류율도 같았다(평균 0.3%),
      속도는 x2.92 → x3.49. 같은 값이라고 보장하지는 않는다 — 받아 적기로 확인한다.
    ★뽑기 설정(do_sample·top_k·top_p·temperature)이 기록에 굳는다 — 설정마다 따로 기록한다.
    끄기: AUDIOFORGE_QWEN_SAMPLE_GRAPH=0 (걸음마다 기록 · 뽑기는 밖).
    """

    def _loop(self, pick):
        import torch
        toks = []
        for k in range(self.STEPS):
            out = self._step(k)
            tok = pick(out.logits[:, -1, :])
            toks.append(tok)
            if k + 1 < self.STEPS:
                self.tok.copy_(tok[:, None])
        return torch.stack(toks, dim=1)

    def capture_sampled(self, pick):
        import torch
        with torch.no_grad():
            side = torch.cuda.Stream()
            side.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(side):
                for _ in range(2):
                    self._loop(pick)
            torch.cuda.current_stream().wait_stream(side)
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g):
                self.out = self._loop(pick)
            self.full = g

    def run_sampled(self, inputs_embeds):
        self.emb.copy_(inputs_embeds)
        self.full.replay()
        return self.out.clone()


def _graph_generate(self, inputs_embeds=None, max_new_tokens=None, do_sample=None, top_p=None, top_k=None,
                    temperature=None, **kw):
    import sys
    import torch
    n = int(max_new_tokens)
    if (os.environ.get("AUDIOFORGE_QWEN_SAMPLE_GRAPH", "1") != "0" and inputs_embeds is not None and inputs_embeds.is_cuda
            and inputs_embeds.shape[1] == 2 and n == _GraphRunner.STEPS and not getattr(self, "_af_sample_graph_failed", False)):
        g = self.generation_config
        ds = g.do_sample if do_sample is None else do_sample
        tk = g.top_k if top_k is None else top_k
        tp = g.top_p if top_p is None else top_p
        tt = g.temperature if temperature is None else temperature
        key = (inputs_embeds.shape[0], inputs_embeds.dtype, bool(ds), tk, tp, tt)
        sampled = self.__dict__.setdefault("_af_sampled_runners", {})
        runner = sampled.get(key)
        if runner is None:
            try:
                runner = _SampledRunner(self, inputs_embeds.shape[0], inputs_embeds.shape[2], inputs_embeds.dtype,
                                        inputs_embeds.device)
                runner.emb.copy_(inputs_embeds)
                runner.capture_sampled(lambda lg: _pick(lg, ds, tk, tp, tt))
                sampled[key] = runner
            except Exception as e:                     # 뽑기까지 기록하지 못하면 걸음마다 기록으로
                self._af_sample_graph_failed = True
                sys.stderr.write("[qwen_fast] 뽑기까지 묶지 못해 걸음마다 묶기로 돌아갑니다: %s: %s\n"
                                 % (type(e).__name__, str(e)[:200]))
                runner = None
        if runner is not None:
            with torch.no_grad():
                return _Result(runner.run_sampled(inputs_embeds))
    use = (inputs_embeds is not None and inputs_embeds.is_cuda and inputs_embeds.shape[1] == 2
           and n == _GraphRunner.STEPS and not getattr(self, "_af_graph_failed", False))
    if use:
        key = (inputs_embeds.shape[0], inputs_embeds.dtype)
        runners = self.__dict__.setdefault("_af_graph_runners", {})
        runner = runners.get(key)
        if runner is None:
            try:
                runner = _GraphRunner(self, inputs_embeds.shape[0], inputs_embeds.shape[2], inputs_embeds.dtype,
                                      inputs_embeds.device)
                runner.capture()
                runners[key] = runner
            except Exception as e:                     # 기록 실패 — 조용히 넘기지 않고 알리고 직접 반복으로
                self._af_graph_failed = True
                sys.stderr.write("[qwen_fast] 묶어 실행을 쓰지 못해 직접 반복으로 돌아갑니다: %s: %s\n"
                                 % (type(e).__name__, str(e)[:200]))
                runner = None
        if runner is not None:
            g = self.generation_config
            ds = g.do_sample if do_sample is None else do_sample
            tk = g.top_k if top_k is None else top_k
            tp = g.top_p if top_p is None else top_p
            tt = g.temperature if temperature is None else temperature
            with torch.no_grad():
                return _Result(runner.run(inputs_embeds, lambda lg: _pick(lg, ds, tk, tp, tt)))
    return _fast_generate(self, inputs_embeds=inputs_embeds, max_new_tokens=max_new_tokens, do_sample=do_sample,
                          top_p=top_p, top_k=top_k, temperature=temperature, **kw)


# ── ③ 본 모델(28층)의 한 걸음도 기록해 두고 다시 틀기 (2026-10-01) ─────────────────────────
# ★왜 (실측 · 소희 15.3초 분량): 보조 모델을 묶은 뒤 남은 시간의 77% 가 본 모델 한 걸음(조각당 66ms)이었다.
#   폭 1024 · 28층 모델에 글자 하나 넣는 계산은 1~2ms 거리다 — 나머지는 층마다 파이썬·틀(가림판 만들기·위치 계산)이
#   도는 **부르는 비용**이다. 보조 모델에서 쓴 방법을 그대로 쓴다: 고정 크기 기억(StaticCache)에 한 걸음을 기록해 두고 다시 튼다.
# ★무엇을 기록하나: 본 모델(talker.model)의 **이어 쓰기 한 걸음**만. 첫 읽기(prefill)·값 뽑기·보조 모델은 기록 밖이다.
#   가림판은 우리가 [1,1,1,L] 모양으로 만들어 넣는다(4차원 가림판은 틀이 그대로 쓴다 — transformers 4.57 masking_utils).
# ★값 뽑기는 transformers `_sample` 과 **같은 규칙·같은 순서**다: float32 → 반복 벌점 → 최소 길이(끝 표시 막기) → 막은 값 →
#   temperature → 상위 k → (상위 p) → softmax → multinomial. 뽑는 차례(본 모델 1 → 보조 모델 15)도 같아 무작위 흐름이 같다.
# ★비트까지 같지는 않다(고정 기억은 빈 칸을 가린 채 L 칸으로 주의를 계산한다) — 받아 적기·길이로 따로 확인한다.
# ★하나씩(배치 1)·GPU 일 때만 쓴다. 기록에 실패하면 원래 generate 로 돌아간다. 끄기: AUDIOFORGE_QWEN_TALKER_GRAPH=0.
# ★기억 칸 수 L = 첫 읽기 길이 + TALKER_MAX_FRAMES. 조각(약 164초 분량)을 넘겨 말을 잇는 폭주는 거기서 멈춘다 —
#   원래 상한 8192 조각(약 11분)은 낭독 한 덩이(최대 약 35초)에 쓸모가 없다.
TALKER_MAX_FRAMES = 2048


class _TalkerOut:
    __slots__ = ("hidden_states", "sequences")

    def __init__(self, hidden_states, sequences):
        self.hidden_states = hidden_states
        self.sequences = sequences


class _TalkerStepGraph:
    """본 모델의 이어 쓰기 한 걸음 — 입력은 고정 자리(emb·pos·cpos·mask)에 복사하고 기록을 다시 튼다."""

    def __init__(self, model, cache, hidden, dtype, device, max_len):
        import torch
        self.model = model
        self.cache = cache
        self.emb = torch.zeros((1, 1, hidden), dtype=dtype, device=device)
        self.pos = torch.zeros((3, 1, 1), dtype=torch.long, device=device)
        self.cpos = torch.zeros((1,), dtype=torch.long, device=device)
        self.mask = torch.zeros((1, 1, 1, max_len), dtype=torch.bool, device=device)
        self.graph = None
        self.out = None

    def _run(self):
        return self.model._af_orig_forward(inputs_embeds=self.emb, attention_mask=self.mask, position_ids=self.pos,
                                           past_key_values=self.cache, use_cache=True, cache_position=self.cpos)

    def load(self, inputs_embeds, position_ids, cache_position, attention_mask_2d):
        self.emb.copy_(inputs_embeds)
        self.pos.copy_(position_ids)
        self.cpos.copy_(cache_position)
        n = attention_mask_2d.shape[1]
        self.mask.zero_()
        self.mask[:, 0, 0, :n] = attention_mask_2d.to(torch_bool())

    def capture(self):
        import torch
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(2):                  # 데우기 — 지금 걸음 자리에 같은 값을 쓴다(뒤이어 다시 쓴다)
                self._run()
        torch.cuda.current_stream().wait_stream(side)
        g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g):
            out = self._run()
        self.graph = g
        self.out = out.last_hidden_state

    def step(self):
        self.graph.replay()
        return self.out


def torch_bool():
    import torch
    return torch.bool


def _talker_scores(logits, gen, n_new, rp, min_new, eos, suppress):
    """본 모델 점수 → 뽑기 전 점수(transformers 처리기와 같은 차례). gen: 지금까지 뽑은 첫 값들 [1, n]."""
    import torch
    scores = logits.to(dtype=torch.float32)
    if rp is not None and float(rp) != 1.0 and n_new > 0:
        s = torch.gather(scores, 1, gen)
        s = torch.where(s < 0, s * float(rp), s / float(rp))
        scores = scores.scatter(1, gen, s)
    if min_new is not None and n_new < int(min_new) and eos is not None:
        scores = scores.clone()
        scores[:, eos] = float("-inf")
    if suppress is not None:
        scores = scores.clone()
        scores[:, suppress] = float("-inf")
    return scores


def _count_only_criteria(kw):
    """멈춤 조건이 '세기만 하는 것' 들뿐인가 — (조건 목록, 나머지 인자, 빠른 길에서 받아도 되나)."""
    crit = kw.get("stopping_criteria")
    rest = {k: v for k, v in kw.items() if k != "stopping_criteria"}
    crit = list(crit) if crit is not None else []
    return crit, rest, all(getattr(c, "_af_count_only", False) for c in crit)


def _talker_generate(self, inputs_embeds=None, attention_mask=None, trailing_text_hidden=None, tts_pad_embed=None,
                     max_new_tokens=None, min_new_tokens=None, do_sample=None, top_k=None, top_p=None, temperature=None,
                     eos_token_id=None, repetition_penalty=None, suppress_tokens=None, subtalker_dosample=None,
                     subtalker_top_k=None, subtalker_top_p=None, subtalker_temperature=None,
                     output_hidden_states=True, return_dict_in_generate=True, **kw):
    import sys
    import torch
    from transformers.cache_utils import StaticCache
    orig = lambda: self._af_orig_generate(  # noqa: E731
        inputs_embeds=inputs_embeds, attention_mask=attention_mask, trailing_text_hidden=trailing_text_hidden,
        tts_pad_embed=tts_pad_embed, max_new_tokens=max_new_tokens, min_new_tokens=min_new_tokens, do_sample=do_sample,
        top_k=top_k, top_p=top_p, temperature=temperature, eos_token_id=eos_token_id,
        repetition_penalty=repetition_penalty, suppress_tokens=suppress_tokens, subtalker_dosample=subtalker_dosample,
        subtalker_top_k=subtalker_top_k, subtalker_top_p=subtalker_top_p, subtalker_temperature=subtalker_temperature,
        output_hidden_states=output_hidden_states, return_dict_in_generate=return_dict_in_generate, **kw)
    # ★멈춤 조건(stopping_criteria)이 '세기만 하는 것'(_af_count_only — 받은 값을 보지 않고 걸음을 세며, 요청이 있을 때만 True)이면
    #   빠른 길에서도 받는다(2026-10-03). 예전에는 kw 가 하나라도 있으면 원래 길로 갔다 — qwen_bridge 가 걸음 수를 재려고
    #   늘 계수기를 넘기므로 **참조 목소리(낭독·카드)는 본 모델 묶어 실행을 한 번도 쓰지 못했다**(생성만 실시간 0.6~0.9배).
    #   다른 멈춤 조건이나 다른 인자가 오면 지금처럼 원래 길이다.
    crit, rest, count_only = _count_only_criteria(kw)
    if (inputs_embeds is None or not inputs_embeds.is_cuda or inputs_embeds.shape[0] != 1 or rest or not count_only
            or getattr(self, "_af_talker_failed", False) or attention_mask is None):
        return orig()
    g = self.generation_config
    do_sample = g.do_sample if do_sample is None else do_sample
    top_k = g.top_k if top_k is None else top_k
    top_p = g.top_p if top_p is None else top_p
    temperature = g.temperature if temperature is None else temperature
    rp = g.repetition_penalty if repetition_penalty is None else repetition_penalty
    eos = g.eos_token_id if eos_token_id is None else eos_token_id
    eos = eos[0] if isinstance(eos, (list, tuple)) else eos
    limit = min(int(max_new_tokens or g.max_new_tokens or TALKER_MAX_FRAMES), TALKER_MAX_FRAMES)
    dev = inputs_embeds.device
    suppress = torch.tensor(list(suppress_tokens), device=dev, dtype=torch.long) if suppress_tokens else None
    P = inputs_embeds.shape[1]
    # ★기억 칸 수를 256 단위로 올려 잡는다 — 조각마다 첫 읽기 길이가 달라도 같은 기록을 다시 쓴다.
    #   (처음엔 부를 때마다 새로 기록해 짧은 글에서 1.2배에 그쳤다 — 기록 비용이 매번 들었다. 2026-10-01 실측.)
    L = ((P + 255) // 256) * 256 + TALKER_MAX_FRAMES
    sub = dict(subtalker_dosample=subtalker_dosample, subtalker_top_k=subtalker_top_k,
               subtalker_top_p=subtalker_top_p, subtalker_temperature=subtalker_temperature)
    try:
        states = self.__dict__.setdefault("_af_talker_states", {})
        key = (L, inputs_embeds.dtype, inputs_embeds.shape[2])
        if key in states:
            cache, runner = states[key]
            cache.reset()                       # 앞 조각의 기억을 비운다(칸과 기록은 그대로)
        else:
            while len(states) >= 3:             # 그래픽카드 메모리 — 크기 셋까지만 들고 있는다(하나 약 260MB)
                states.pop(next(iter(states)))
            cache = StaticCache(config=self.config, max_cache_len=L)
            runner = _TalkerStepGraph(self.model, cache, inputs_embeds.shape[2], inputs_embeds.dtype, dev, L)
            states[key] = (cache, runner)
    except Exception as e:
        self._af_talker_failed = True
        sys.stderr.write("[qwen_fast] 본 모델 묶어 실행 준비 실패 — 원래대로: %s: %s\n" % (type(e).__name__, str(e)[:200]))
        return orig()

    def graphed_forward(inputs_embeds=None, attention_mask=None, position_ids=None, past_key_values=None,
                        use_cache=None, cache_position=None, **fk):
        from transformers.modeling_outputs import BaseModelOutputWithPast
        if past_key_values is not cache or inputs_embeds is None or inputs_embeds.shape[1] != 1:
            return self.model._af_orig_forward(inputs_embeds=inputs_embeds, attention_mask=attention_mask,
                                               position_ids=position_ids, past_key_values=past_key_values,
                                               use_cache=use_cache, cache_position=cache_position, **fk)
        runner.load(inputs_embeds, position_ids, cache_position, attention_mask)
        if runner.graph is None:
            runner.capture()
        # ★복사해서 돌려준다 — 기록의 출력 자리는 다음 걸음이 덮어쓴다(그대로 주면 모아 둔 걸음들이 모두 마지막 값이 된다).
        return BaseModelOutputWithPast(last_hidden_state=runner.step().clone(), past_key_values=cache)

    hidden_list = []
    tokens = []
    with torch.no_grad():
        self.model._af_orig_forward = self.model.forward
        self.model.forward = graphed_forward
        try:
            am = attention_mask
            # ★첫 읽기는 **원래 길(늘어나는 기억)** 로 한다 — 고정 기억으로 읽으면 첫 숨은 값부터 조금 달라져(0.5/99)
            #   받아 적기 오류가 16개 중 둘에서 13~15% 로 뛰었다(2026-10-01 실측). 읽은 기억은 고정 기억으로 옮겨 이어 쓴다.
            from transformers.cache_utils import DynamicCache
            dyn = DynamicCache()
            pos = torch.arange(P, device=dev)
            out = self(inputs_embeds=inputs_embeds, attention_mask=am, past_key_values=dyn, use_cache=True,
                       cache_position=pos, trailing_text_hidden=trailing_text_hidden,
                       tts_pad_embed=tts_pad_embed, **sub)
            for li, layer in enumerate(dyn.layers):
                cache.update(layer.keys, layer.values, li, {"cache_position": pos})
            del dyn
            gen = torch.zeros((1, 0), dtype=torch.long, device=dev)
            for i in range(limit):
                hidden_list.append(((out.past_hidden,), out.hidden_states[1]))
                scores = _talker_scores(out.logits[:, -1, :], gen, i, rp, min_new_tokens, eos, suppress)
                tok = _pick(scores, do_sample, top_k, top_p, temperature)
                gen = torch.cat([gen, tok[:, None]], dim=1)
                tokens.append(tok)
                # 멈춤 조건 — 원래 길(transformers)처럼 걸음마다 **모두** 한 번씩 부른다(하나가 True 여도 나머지를 센다).
                stop = [bool(c(gen, scores)) for c in crit]
                if int(tok[0]) == int(eos) or i == limit - 1 or any(stop):
                    break
                am = torch.cat([am, am.new_ones((1, 1))], dim=1)
                out = self(input_ids=tok[:, None], attention_mask=am, past_key_values=cache, use_cache=True,
                           cache_position=torch.tensor([P + i], device=dev), past_hidden=out.past_hidden,
                           generation_step=out.generation_step, trailing_text_hidden=out.trailing_text_hidden,
                           tts_pad_embed=out.tts_pad_embed, **sub)
        except Exception as e:
            self.model.forward = self.model._af_orig_forward
            self._af_talker_failed = True
            sys.stderr.write("[qwen_fast] 본 모델 묶어 실행을 쓰지 못해 원래대로 다시 만듭니다: %s: %s\n"
                             % (type(e).__name__, str(e)[:200]))
            return orig()
        finally:
            self.model.forward = self.model._af_orig_forward
    return _TalkerOut(hidden_list, torch.stack(tokens, dim=1) if tokens else None)


def apply(model):
    """불러온 Qwen3TTSModel(또는 그 안의 .model)의 generate 를 바꿔 끼운다. 바꿨으면 어떤 방식인지('graph+talker'·'graph'·'loop'), 아니면 None."""
    if os.environ.get("AUDIOFORGE_QWEN_FAST", "1") == "0":
        return None
    inner = getattr(model, "model", model)
    talker = getattr(inner, "talker", None)
    cp = getattr(talker, "code_predictor", None)
    if cp is None:
        return None
    if os.environ.get("AUDIOFORGE_QWEN_GRAPH", "1") != "0":
        cp.generate = types.MethodType(_graph_generate, cp)
        # 본 모델 한 걸음도 묶는다(③). 끄기: AUDIOFORGE_QWEN_TALKER_GRAPH=0 — 그때는 보조 모델만 묶는다.
        if (os.environ.get("AUDIOFORGE_QWEN_TALKER_GRAPH", "1") != "0" and hasattr(talker, "generate")
                and not hasattr(talker, "_af_orig_generate")):
            talker._af_orig_generate = talker.generate
            talker.generate = types.MethodType(_talker_generate, talker)
            return "graph+talker"
        return "graph"
    cp.generate = types.MethodType(_fast_generate, cp)
    return "loop"
