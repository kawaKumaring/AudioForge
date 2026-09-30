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


def _graph_generate(self, inputs_embeds=None, max_new_tokens=None, do_sample=None, top_p=None, top_k=None,
                    temperature=None, **kw):
    import sys
    import torch
    n = int(max_new_tokens)
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


def apply(model):
    """불러온 Qwen3TTSModel(또는 그 안의 .model)의 보조 모델 generate 를 바꿔 끼운다. 바꿨으면 어떤 방식인지('graph'·'loop'), 아니면 None."""
    if os.environ.get("AUDIOFORGE_QWEN_FAST", "1") == "0":
        return None
    inner = getattr(model, "model", model)
    talker = getattr(inner, "talker", None)
    cp = getattr(talker, "code_predictor", None)
    if cp is None:
        return None
    if os.environ.get("AUDIOFORGE_QWEN_GRAPH", "1") != "0":
        cp.generate = types.MethodType(_graph_generate, cp)
        return "graph"
    cp.generate = types.MethodType(_fast_generate, cp)
    return "loop"
