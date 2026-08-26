# -*- coding: utf-8 -*-
"""생성 상한(ABS_LIMIT=256) 감사 — 순수 계산 + 재현 가능한 표 생성. READ-ONLY 감사용.

이 파일은 **프로덕션 동작을 바꾸지 않는다.** 상수·기본값·timeout·재시도 정책을 일절 수정하지 않으며,
generation_limit 의 값을 복사하지 않고 import 해서 읽기만 한다. GPU·모델·합성·네트워크 없음.

────────────────────────────────────────────────────────────────────────────
값의 출처 표기 규칙 (본 파일 전체에 적용)
────────────────────────────────────────────────────────────────────────────
  MEASURED : 이 저장소의 코드/테스트/커밋에서 그대로 읽어온 값. 아래 _origin 주석에 출처를 남긴다.
  DERIVED  : MEASURED 값에서 공식으로 계산한 값. 공식을 함께 적는다.
  ASSUMED  : 저장소에서 확인되지 않아 가정한 값. 표에 UNVERIFIED 로 표시된다.

핵심 구분(혼동 금지):
  · production TEXT token (prod_tokens) — 입력. `_build_assistant_text(text)` 를 processor 에 통과시킨
    input_ids 길이(qwen_bridge._prod_tokens). 래퍼(chat template) 토큰을 **포함**한다.
  · generated AUDIO token — 출력. talker 자기회귀 1 step = codec 토큰 1개(qwen_bridge 41~48행 주석).
  · generation ITERATION — talker step 수. 위 정의상 iteration 수 == 생성된 codec 토큰 수로 같은 것을 센다.
    `max_new_tokens` 는 이 iteration/codec 토큰에 걸리는 상한이지, 입력 텍스트 토큰의 상한이 아니다.

용어: L = 한 chunk 에 적용된 max_new_tokens 상한값. tok = 그 chunk 의 prod_tokens.
"""
import os
import re
import sys
import math
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generation_limit as gl


# ─────────────────────────────────────────────────────────────────────────────
# 1. MEASURED 입력 — 전부 이 저장소에서 읽어온 값
# ─────────────────────────────────────────────────────────────────────────────

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PY_DIR = os.path.join(_REPO_ROOT, "python")


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _grep1(text, pattern, what):
    """소스에서 상수 1개를 뽑아온다(값 복사 금지 — 원본 파일이 유일 출처)."""
    m = re.search(pattern, text)
    if not m:
        raise AssertionError("소스에서 %s 를 찾지 못함 — 상수가 이동/개명되었을 수 있다" % what)
    return m.group(1)


def measured_watchdogs():
    """MEASURED: 두 감시자(watchdog) 상수를 소스 텍스트에서 직접 읽는다.

    _QWEN_INACTIVITY_SEC : python/tts_worker.py — 부모 파이썬이 Qwen 브리지 stdout 무응답을 재는 시간.
                           qwen_bridge 는 chunk **시작/완료** 시에만 progress 를 내보내므로(_generate_plan),
                           이 무응답 시간의 실질 의미는 '한 chunk 의 생성 시간'이다.
    WATCHDOG_MS          : src/main/ipc/audio.ipc.ts — Electron 이 progress 무진행을 재는 시간.
    """
    worker = _read(os.path.join(_PY_DIR, "tts_worker.py"))
    ipc = _read(os.path.join(_REPO_ROOT, "src", "main", "ipc", "audio.ipc.ts"))
    parent_sec = int(_grep1(worker, r"_QWEN_INACTIVITY_SEC\s*=\s*(\d+)", "_QWEN_INACTIVITY_SEC"))
    electron_ms = int(_grep1(ipc, r"const\s+WATCHDOG_MS\s*=\s*(\d+)", "WATCHDOG_MS"))
    return parent_sec, electron_ms / 1000.0


def measured_model_repo_id():
    """MEASURED: python/tts_worker.py 의 _QWEN_REPO 문자열(모델 식별자)."""
    worker = _read(os.path.join(_PY_DIR, "tts_worker.py"))
    return _grep1(worker, r'_QWEN_REPO\s*=\s*"([^"]+)"', "_QWEN_REPO")


# ── 정상 생성 상단 포락선(upper envelope) ────────────────────────────────────
# MEASURED(산문): generation_limit.py docstring "calib3 정상 upper envelope(iter ≈ 2.786*tok − 5.1)" 및
#   test_generation_limit.py::test_normal_envelope_below_cap_accepted_range 가 같은 식을 고정한다.
#   적합 표본은 doc/work-in-progress/tts-prosody-integration.md:30 에 기록: "calib3 fitting(정상 done,
#   talker_iters<8192, 87건) ... (resid_max 67·std 27)".
# ⚠ 원시 (tok, iter) 측정 데이터 파일은 이 저장소 어디에도 없다. 같은 문서 63행이 그 이유를 명시한다:
#   "진단 스크립트/checkpoint: 세션 scratchpad(diag_*.py, calib3_checkpoint.json) — Git 미추적."
#   즉 87건의 원본은 커밋된 적이 없고, 계수 2.786/−5.1 은 재검증 불가능하다.
ENVELOPE_SLOPE = 2.786     # MEASURED(산문) — iter/tok
ENVELOPE_INTERCEPT = -5.1  # MEASURED(산문)
CALIB3_N = 87              # MEASURED(산문) — 적합에 쓰인 정상 완료 표본 수
CALIB3_RESID_MAX = 67      # MEASURED(산문)
CALIB3_STD = 27            # MEASURED(산문)

# ── '정상 완료 최대 iteration' — 저장소가 서로 다른 값을 말한다 ───────────────
# MEASURED(산문) A: generation_limit.py:17 "정상 짧은 문장 iter는 수십, 관측 최대 88" (MIN_LIMIT 근거)
# MEASURED(산문) B: tts-prosody-integration.md:33 "정상 최대 iter 183"
# MEASURED(산문) C: tts-prosody-integration.md:21 "정상 talker_iters 10~180(문장 길이 비례)"
# A 는 B/C 보다 하루 뒤에 쓰였고, 88 이라는 값은 저장소의 다른 어디에도 나오지 않는다.
# A 를 '짧은 문장 한정' 으로 읽으면 모순은 아니지만, 그렇게 한정한다는 근거도 저장소에 없다.
OBSERVED_MAX_NORMAL_ITERS_SHORT = 88    # MEASURED(산문) A
OBSERVED_MAX_NORMAL_ITERS_ALL = 183     # MEASURED(산문) B

# ── 실제 런어웨이 tail 관측(G2) — 이 감사에서 가장 중요한 실데이터 ────────────
# MEASURED(산문): doc/research/tts-stochastic-acceptance.md:21 (branch research/tts-stochastic-acceptance)
#   "prod_tokens=18 세그먼트가 적용 상한 213(=ceil(2.9·18+160))에서 iters=213 으로 generation_limit —
#    정상 envelope 예측 2.786·18−5.1 ≈ 45.0 대비 약 4.73배를 넘어 상한에 닿았다."
# 이것은 '정상 완료' 가 아니라 '상한까지 달린 tail' 의 실측이다. envelope 은 tail 을 전혀 bound 하지 못한다.
G2_TAIL_PROD_TOKENS = 18
G2_TAIL_ITERS = 213

# ── CPU 최악 타이밍 모델 ──────────────────────────────────────────────────────
# MEASURED(산문): generation_limit.py docstring —
#   "CPU worst-observed spi=0.763 s/iter(이상치 포함)", "overhead_bound=50.8s", "predicted(256)≈246s".
# 이 세 값은 predicted(L) = overhead_bound + L*spi 라는 선형 모델로 서로 정합한다(아래 테스트가 확인).
CPU_WORST_SPI = 0.763        # s/iter, MEASURED(산문)
OVERHEAD_BOUND = 50.8        # s, MEASURED(산문)
# MEASURED(산문): 같은 docstring — 실측 CPU mismatch@256 = 151s, GPU@256 ≈ 158s.
CPU_OBSERVED_AT_256 = 151.0
GPU_OBSERVED_AT_256 = 158.0

# MEASURED(산문): commit 1401d38 커밋 메시지 — "predicted 246s<250, margin 34s".
# 즉 채택 당시의 합격 기준은 '<250s'였다.
ADOPTION_CRITERION_SEC = 250.0

# ── codec 토큰 레이트 ────────────────────────────────────────────────────────
# MEASURED — 단, **이 앱 저장소가 아니라 모델 스냅샷의 config 에서** 읽은 값이다.
#   <snapshot>/speech_tokenizer/config.json:46   "_frame_rate": 12.5
#   같은 파일이 산술로도 못 박는다: output_sample_rate 24000 / decode_upsample_rate 1920 = 12.5
#   벤더 코드도 같은 상수로 길이를 만든다:
#     qwen_tts/core/tokenizer_12hz/modeling_qwen3_tts_tokenizer_v2.py:1012
#     audio_lengths = (audio_codes[..., 0] > -1).sum(1) * self.decode_upsample_rate
#   즉 codec 프레임 1개 = 1920 샘플 = 정확히 0.08초.
# ⚠ 모델 이름의 "12Hz" 는 12.0 이 아니라 12.5 다(tokenizer v2 라벨). 12.0 으로 잡으면 4% 어긋난다.
# ⚠ 이 앱 저장소 안에는 이 레이트를 적은 상수·주석·문서가 **하나도 없고**, 토큰→초 환산 코드도 없다.
#   따라서 아래 duration 열은 저장소만 보고는 재현할 수 없다(모델 config 를 함께 봐야 한다).
CODEC_TOKENS_PER_SEC = 12.5
CODEC_SAMPLES_PER_FRAME = 1920   # MEASURED: decode_upsample_rate
CODEC_OUTPUT_SAMPLE_RATE = 24000  # MEASURED: output_sample_rate (= 산출 WAV sr)

# ── 모델 자신의 상한 (MEASURED: 스냅샷 config, 앱 저장소 아님) ────────────────
#   generation_config.json:11  "max_new_tokens": 8192      ← 모델 기본 출력 상한
#   config.json:140 talker_config."max_position_embeddings": 32768
#   speech_tokenizer/config.json:22,63  codec enc/dec "max_position_embeddings": 8000
#   config.json:164 talker "vocab_size": 3072  (codec 토큰 공간), codec_eos_token_id 2150
MODEL_DEFAULT_MAX_NEW_TOKENS = 8192
MODEL_TALKER_MAX_POSITIONS = 32768
MODEL_CODEC_MAX_POSITIONS = 8000

CANDIDATE_CEILINGS = (256, 320, 384, 512)


# ─────────────────────────────────────────────────────────────────────────────
# 2. DERIVED — 순수 계산
# ─────────────────────────────────────────────────────────────────────────────

def max_segment_tokens_for(abs_limit):
    """DERIVED: floor((abs_limit - BASE)/SLOPE). generation_limit.max_segment_tokens() 의 일반화."""
    return math.floor((abs_limit - gl.BASE) / gl.SLOPE)


def applied_cap(tok, abs_limit):
    """DERIVED: clamp(ceil(SLOPE*tok+BASE), MIN_LIMIT, abs_limit). abs_limit 만 후보값으로 바꿔 끼운다."""
    return min(max(math.ceil(gl.SLOPE * tok + gl.BASE), gl.MIN_LIMIT), abs_limit)


def normal_envelope_iters(tok):
    """DERIVED(MEASURED 계수): ceil(2.786*tok - 5.1) — '정상' 생성의 상단 포락선 iteration 수."""
    return math.ceil(ENVELOPE_SLOPE * tok + ENVELOPE_INTERCEPT)


def seconds_for_tokens(n_tokens, rate=CODEC_TOKENS_PER_SEC):
    """DERIVED(ASSUMED 레이트): n_tokens / rate. 레이트가 가정이므로 결과도 UNVERIFIED."""
    return n_tokens / rate


def predicted_cpu_worst_sec(limit):
    """DERIVED: overhead_bound + limit*spi. 상한에 실제로 도달했을 때(=최악)의 한 chunk 생성 시간."""
    return OVERHEAD_BOUND + CPU_WORST_SPI * limit


def max_limit_under(budget_sec):
    """DERIVED: predicted_cpu_worst_sec(L) < budget 를 만족하는 최대 정수 L."""
    return math.floor((budget_sec - OVERHEAD_BOUND) / CPU_WORST_SPI)


def sentences_per_chunk(max_seg_tok, wrapper_tokens, tokens_per_sentence):
    """ASSUMED: 한 chunk 에 들어가는 문장 수 = floor((max_seg_tok - wrapper)/문장당토큰).

    prod_tokens 는 래퍼를 포함하므로 k문장 묶음의 토큰 수 ≈ wrapper + k*문장당토큰 이다.
    wrapper_tokens 는 이 저장소에서 **측정 불가**(qwen_tts 벤더 패키지와 모델 스냅샷이 이 워크트리에 없음).
    따라서 이 함수의 출력은 전부 UNVERIFIED 이며, 두 가정값에 매우 민감하다.
    """
    usable = max_seg_tok - wrapper_tokens
    if usable < tokens_per_sentence:
        return 0
    return usable // tokens_per_sentence


# ─────────────────────────────────────────────────────────────────────────────
# 3. 표 생성 (재현 가능한 산출물)
# ─────────────────────────────────────────────────────────────────────────────

TABLE_A_TOKENS = (1, 5, 10, 13, 14, 20, 25, 30, 33, 34, 40)


def build_table_a():
    """표 A — 현재 정책(ABS=256)에서 텍스트 토큰 수별 적용 상한·여유·함의 길이."""
    rows = []
    for tok in TABLE_A_TOKENS:
        unclamped = gl.unclamped_limit(tok)
        cap = gl.compute_max_new_tokens(tok)
        env = normal_envelope_iters(tok)
        accepted = not gl.segment_exceeds_limit(tok)
        rows.append({
            "tok": tok,
            "unclamped": unclamped,                       # DERIVED
            "applied_cap": cap,                           # MEASURED(함수 호출)
            "accepted_chunk": accepted,                   # MEASURED(함수 호출)
            "normal_env_iters": env,                      # DERIVED
            "margin_tokens": cap - env,                   # DERIVED
            "margin_ratio": cap / env if env > 0 else float("inf"),   # DERIVED
            "max_audio_sec": seconds_for_tokens(cap),     # DERIVED w/ ASSUMED rate — UNVERIFIED
            "normal_audio_sec": seconds_for_tokens(env),  # DERIVED w/ ASSUMED rate — UNVERIFIED
        })
    return rows


def build_table_b():
    """표 B — 후보 상한 256/320/384/512 비교."""
    parent_sec, electron_sec = measured_watchdogs()
    base_seg_tok = max_segment_tokens_for(CANDIDATE_CEILINGS[0])
    rows = []
    for abs_limit in CANDIDATE_CEILINGS:
        seg_tok = max_segment_tokens_for(abs_limit)
        cap = applied_cap(seg_tok, abs_limit)
        env = normal_envelope_iters(seg_tok)
        pred = predicted_cpu_worst_sec(abs_limit)
        rows.append({
            "abs_limit": abs_limit,
            "max_segment_tokens": seg_tok,                     # DERIVED
            "seg_tok_vs_current": seg_tok / base_seg_tok,      # DERIVED
            "cap_at_max_seg_tok": cap,                         # DERIVED
            "normal_env_iters": env,                           # DERIVED
            "margin_tokens": cap - env,                        # DERIVED
            "margin_ratio": cap / env,                         # DERIVED
            "max_audio_sec": seconds_for_tokens(abs_limit),    # UNVERIFIED rate
            "normal_audio_sec": seconds_for_tokens(env),       # UNVERIFIED rate
            "cpu_worst_sec": pred,                             # DERIVED
            "breaches_parent_280": pred >= parent_sec,         # DERIVED vs MEASURED watchdog
            "breaches_electron_300": pred >= electron_sec,     # DERIVED vs MEASURED watchdog
            "meets_adoption_250": pred < ADOPTION_CRITERION_SEC,  # DERIVED
        })
    return rows


# ASSUMED 조합 — 래퍼 토큰 수 W, 문장당 토큰 수 S. 둘 다 저장소에서 확인 불가.
ASSUMED_WRAPPER_TOKENS = (0, 5, 10)
ASSUMED_TOKENS_PER_SENTENCE = (12, 18, 25)


def build_table_c():
    """표 C — (전부 UNVERIFIED) 후보 상한별 'chunk 당 문장 수' 감도표."""
    rows = []
    for abs_limit in CANDIDATE_CEILINGS:
        seg_tok = max_segment_tokens_for(abs_limit)
        for w in ASSUMED_WRAPPER_TOKENS:
            for s in ASSUMED_TOKENS_PER_SENTENCE:
                rows.append({
                    "abs_limit": abs_limit,
                    "max_segment_tokens": seg_tok,
                    "assumed_wrapper_tokens": w,
                    "assumed_tokens_per_sentence": s,
                    "sentences_per_chunk": sentences_per_chunk(seg_tok, w, s),
                })
    return rows


def format_report():
    parent_sec, electron_sec = measured_watchdogs()
    out = []
    a = out.append
    a("=" * 100)
    a("생성 상한 감사 리포트 — 재현 가능한 산출물 (test_generation_limit_audit.py)")
    a("=" * 100)
    a("")
    a("[MEASURED] 현재 상수 (python/generation_limit.py)")
    a("    SLOPE=%s  BASE=%s  MIN_LIMIT=%s  ABS_LIMIT=%s  max_segment_tokens()=%d"
      % (gl.SLOPE, gl.BASE, gl.MIN_LIMIT, gl.ABS_LIMIT, gl.max_segment_tokens()))
    a("[MEASURED] 모델 식별자: %s" % measured_model_repo_id())
    a("[MEASURED] 부모 파이썬 무응답 watchdog  = %.0f s  (python/tts_worker.py:_QWEN_INACTIVITY_SEC)" % parent_sec)
    a("[MEASURED] Electron 무진행 watchdog     = %.0f s  (src/main/ipc/audio.ipc.ts:WATCHDOG_MS)" % electron_sec)
    a("[MEASURED*] codec 토큰 레이트           = %.1f tok/s  (= %d/%d, 프레임당 %.2f초)"
      % (CODEC_TOKENS_PER_SEC, CODEC_OUTPUT_SAMPLE_RATE, CODEC_SAMPLES_PER_FRAME,
         1.0 / CODEC_TOKENS_PER_SEC))
    a("           * 출처는 모델 스냅샷 speech_tokenizer/config.json 의 \"_frame_rate\": 12.5 —")
    a("             **이 앱 저장소가 아니다.** 저장소에는 레이트 상수도 토큰→초 환산 코드도 전혀 없다.")
    a("             모델 이름의 '12Hz' 를 12.0 으로 읽으면 4% 어긋난다(실제 12.5).")
    a("[MEASURED*] 모델 자신의 상한: max_new_tokens=%d, codec max_positions=%d(=%.0f초), talker ctx=%d"
      % (MODEL_DEFAULT_MAX_NEW_TOKENS, MODEL_CODEC_MAX_POSITIONS,
         seconds_for_tokens(MODEL_CODEC_MAX_POSITIONS), MODEL_TALKER_MAX_POSITIONS))
    a("             -> 후보 상한 256~512 는 모델 상한의 1/16 이하다. 모델은 제약이 아니다.")
    a("")
    a("-" * 100)
    a("표 A — 현재 정책(ABS_LIMIT=%d): 텍스트 토큰 수별 적용 상한" % gl.ABS_LIMIT)
    a("-" * 100)
    a("  tok  unclamp  적용상한  채택?   정상env  여유(tok)  여유배수   최대길이s*  정상길이s*")
    for r in build_table_a():
        env = r["normal_env_iters"]
        if env <= 0:
            # envelope 은 적합 구간 밖(아주 짧은 tok)에서 음수가 된다 — 외삽 금지 구간으로 표시.
            a("  %3d  %7d  %8d  %-6s  %7s  %9s  %9s  %10.2f  %10s"
              % (r["tok"], r["unclamped"], r["applied_cap"],
                 "예" if r["accepted_chunk"] else "분할",
                 "적합밖", "-", "-", r["max_audio_sec"], "-"))
            continue
        a("  %3d  %7d  %8d  %-6s  %7d  %9d  %8.2fx  %10.2f  %10.2f"
          % (r["tok"], r["unclamped"], r["applied_cap"],
             "예" if r["accepted_chunk"] else "분할",
             env, r["margin_tokens"], r["margin_ratio"],
             r["max_audio_sec"], r["normal_audio_sec"]))
    a("  * duration = tokens / 12.5 (모델 config 의 _frame_rate). 앱 저장소에는 이 환산이 없다.")
    a("  '채택?'=분할 인 행은 실제로는 자동 분할되어 생성에 그대로 들어가지 않는다(계약 B).")
    a("  정상env = ceil(%.3f*tok %+.1f) — MEASURED(산문) 계수(n=%d, resid_max %d, std %d), 원시 데이터 없음."
      % (ENVELOPE_SLOPE, ENVELOPE_INTERCEPT, CALIB3_N, CALIB3_RESID_MAX, CALIB3_STD))
    a("  '적합밖' = 외삽하면 음수가 되는 아주 짧은 구간. 이 구간은 MIN_LIMIT 이 지배한다.")
    a("  ⚠ 이 envelope 은 '정상 완료' 만 적합한 것이라 런어웨이 tail 을 bound 하지 않는다(아래 G2 참조).")
    a("")
    a("-" * 100)
    a("표 B — 후보 상한 비교")
    a("-" * 100)
    a("  ABS   maxSegTok  현재대비  상한@maxTok  정상env  여유(tok)  여유배수  최대길이s*  CPU최악s   280s   300s   채택기준<250s")
    for r in build_table_b():
        a("  %4d  %9d  %6.2fx  %11d  %7d  %9d  %7.2fx  %10.2f  %8.1f  %-5s  %-5s  %s"
          % (r["abs_limit"], r["max_segment_tokens"], r["seg_tok_vs_current"],
             r["cap_at_max_seg_tok"], r["normal_env_iters"], r["margin_tokens"], r["margin_ratio"],
             r["max_audio_sec"], r["cpu_worst_sec"],
             "위반" if r["breaches_parent_280"] else "OK",
             "위반" if r["breaches_electron_300"] else "OK",
             "충족" if r["meets_adoption_250"] else "미달"))
    a("  * duration = tokens / 12.5 (모델 config 의 _frame_rate). 앱 저장소에는 이 환산이 없다.")
    a("  CPU최악s = %.1f + %.3f*ABS  (MEASURED 산문 계수로 재구성한 선형 모델)"
      % (OVERHEAD_BOUND, CPU_WORST_SPI))
    a("  이 모델에서 280s 를 지키는 최대 상한 L = %d,  250s 기준으로는 L = %d."
      % (max_limit_under(parent_sec), max_limit_under(ADOPTION_CRITERION_SEC)))
    a("  참고 실측(산문): CPU@256=%.0fs, GPU@256=%.0fs — 둘 다 예측치 %.0fs 보다 훨씬 빠르다."
      % (CPU_OBSERVED_AT_256, GPU_OBSERVED_AT_256, predicted_cpu_worst_sec(256)))
    a("")
    a("-" * 100)
    a("표 C — chunk 당 문장 수 감도 (전 행 UNVERIFIED: 래퍼 토큰 W·문장당 토큰 S 모두 미측정)")
    a("-" * 100)
    a("  ABS   maxSegTok   W    S   문장/chunk")
    for r in build_table_c():
        a("  %4d  %9d  %3d  %3d  %11d"
          % (r["abs_limit"], r["max_segment_tokens"], r["assumed_wrapper_tokens"],
             r["assumed_tokens_per_sentence"], r["sentences_per_chunk"]))
    a("  W(래퍼 토큰)는 _build_assistant_text 가 붙이는 chat template 분량이다. 이 워크트리에는")
    a("  qwen_tts 벤더 패키지도 모델 스냅샷도 없어 측정할 수 없었다. W 측정은 GPU 없이 가능한")
    a("  가장 값싼 미측정 항목이며, 33 중 실제로 텍스트에 쓸 수 있는 몫을 바로 결정한다.")
    a("")
    a("-" * 100)
    a("실제 런 데이터 현황")
    a("-" * 100)
    a("  원시 (tok -> iter) 측정 파일: 없음. calib3 87건의 원본은 세션 scratchpad 에 있었고 Git 미추적이다")
    a("  (tts-prosody-integration.md:63 이 직접 그렇게 적고 있다). envelope 계수 %.3f/%.1f 는 재검증 불가."
      % (ENVELOPE_SLOPE, ENVELOPE_INTERCEPT))
    a("  정상완료 vs generation_limit 의 실제 분포: 없음. 테스트의 generated_iterations(예: 100)은 픽스처다.")
    a("")
    a("  '정상 최대 iter' 는 저장소 안에서 서로 어긋난다:")
    a("      88  (generation_limit.py:17, MIN_LIMIT 근거)   -> ABS %d 대비 %.2f배 여유"
      % (gl.ABS_LIMIT, gl.ABS_LIMIT / OBSERVED_MAX_NORMAL_ITERS_SHORT))
    a("      183 (tts-prosody-integration.md:33)            -> ABS %d 대비 %.2f배 여유"
      % (gl.ABS_LIMIT, gl.ABS_LIMIT / OBSERVED_MAX_NORMAL_ITERS_ALL))
    a("      10~180 (tts-prosody-integration.md:21)")
    a("      88 은 envelope(33 tok) 예측 %d 과 사실상 같아 독립 관측으로 보기 어렵다."
      % normal_envelope_iters(gl.max_segment_tokens()))
    a("")
    a("  [실데이터 1건] 런어웨이 tail — 상한 논쟁의 핵심:")
    a("      tok=%d, 적용상한 %d, iters=%d -> generation_limit (envelope 예측 %d 의 %.2f배)"
      % (G2_TAIL_PROD_TOKENS, gl.compute_max_new_tokens(G2_TAIL_PROD_TOKENS), G2_TAIL_ITERS,
         normal_envelope_iters(G2_TAIL_PROD_TOKENS),
         G2_TAIL_ITERS / normal_envelope_iters(G2_TAIL_PROD_TOKENS)))
    a("      -> envelope 은 tail 을 bound 하지 못한다. 설계 여유(resid_max+3σ=%d)로도 못 막는다."
      % (CALIB3_RESID_MAX + 3 * CALIB3_STD))
    a("      -> tail 이 실제로 상한까지 달리므로, watchdog 비교는 정상완료 시간이 아니라 predicted(L)로 해야 한다.")
    a("=" * 100)
    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────────────────
# 4. 테스트 — 표의 핵심 셀과 재구성한 모델의 정합성을 고정
# ─────────────────────────────────────────────────────────────────────────────

class ProductionConstantsUnchangedTest(unittest.TestCase):
    """감사는 읽기 전용이다. 현재 값을 그대로 고정해 두어, 누군가 바꾸면 즉시 드러나게 한다."""

    def test_constants_are_current_values(self):
        self.assertEqual(gl.SLOPE, 2.9)
        self.assertEqual(gl.BASE, 160)
        self.assertEqual(gl.MIN_LIMIT, 200)
        self.assertEqual(gl.ABS_LIMIT, 256)
        self.assertEqual(gl.max_segment_tokens(), 33)

    def test_watchdogs_are_current_values(self):
        parent_sec, electron_sec = measured_watchdogs()
        self.assertEqual(parent_sec, 280)
        self.assertEqual(electron_sec, 300.0)
        # 부모가 Electron 보다 먼저 걸려야 파이썬이 먼저 정리한다(tts_worker 주석의 설계 의도).
        self.assertLess(parent_sec, electron_sec)

    def test_model_repo_id_is_the_12hz_base_model(self):
        repo = measured_model_repo_id()
        self.assertEqual(repo, "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
        # 레이트 가정의 유일한 근거가 이 문자열이라는 사실 자체를 고정한다.
        self.assertIn("12Hz", repo)


class GeneralizedFormulaTest(unittest.TestCase):
    """후보 상한을 끼웠을 때의 파생 공식이 현재 값에서 프로덕션과 일치하는지 확인."""

    def test_generalization_matches_production_at_256(self):
        self.assertEqual(max_segment_tokens_for(gl.ABS_LIMIT), gl.max_segment_tokens())
        for tok in range(1, 60):
            self.assertEqual(applied_cap(tok, gl.ABS_LIMIT), gl.compute_max_new_tokens(tok))

    def test_max_segment_tokens_for_candidates(self):
        # DERIVED: floor((ABS-160)/2.9)
        self.assertEqual(max_segment_tokens_for(256), 33)   # floor(96/2.9)  = floor(33.10)
        self.assertEqual(max_segment_tokens_for(320), 55)   # floor(160/2.9) = floor(55.17)
        self.assertEqual(max_segment_tokens_for(384), 77)   # floor(224/2.9) = floor(77.24)
        self.assertEqual(max_segment_tokens_for(512), 121)  # floor(352/2.9) = floor(121.38)

    def test_relative_headroom_shrinks_as_ceiling_rises(self):
        """중요: 상한을 올릴수록 '정상 대비 여유 배수'는 줄어든다.

        SLOPE(2.9)가 envelope 기울기(2.786)보다 겨우 4% 크고, 여유의 대부분은 상수항 BASE=160 에서
        온다. 따라서 tok 이 커질수록 cap/envelope -> 2.9/2.786 ≈ 1.04 로 수렴한다.
        여유의 '절대량'은 거의 그대로인데 '배수'만 무너지는 것이 이 공식의 성질이다.
        """
        ratios = [r["margin_ratio"] for r in build_table_b()]
        self.assertEqual(ratios, sorted(ratios, reverse=True), "여유 배수는 상한이 커질수록 단조 감소해야 한다")
        self.assertGreater(ratios[0], 2.5)    # ABS=256 에서는 약 2.9배
        self.assertLess(ratios[-1], 1.7)      # ABS=512 에서는 약 1.5배
        # 절대 여유는 거의 변하지 않는다(상수항 지배).
        margins = [r["margin_tokens"] for r in build_table_b()]
        self.assertLess(max(margins) - min(margins), 20)


class CpuTimingModelTest(unittest.TestCase):
    """docstring 이 남긴 세 숫자(overhead 50.8 / spi 0.763 / predicted 246)가 선형모델로 정합하는지 확인.

    정합한다면 predicted(L) = 50.8 + 0.763*L 로 다른 후보 상한을 같은 근거 위에서 외삽할 수 있다.
    """

    def test_reconstructed_model_reproduces_recorded_prediction(self):
        # MEASURED(산문) "predicted(256)≈246s" 를 재현 → 모델 재구성이 맞다는 증거.
        self.assertAlmostEqual(predicted_cpu_worst_sec(256), 246.1, places=1)

    def test_256_meets_the_recorded_adoption_criterion_but_only_just(self):
        parent_sec, _ = measured_watchdogs()
        pred = predicted_cpu_worst_sec(256)
        self.assertLess(pred, ADOPTION_CRITERION_SEC)          # <250s 기준 충족
        # 커밋 메시지가 남긴 "margin 34s" 와 일치.
        self.assertAlmostEqual(parent_sec - pred, 34.0, delta=0.2)

    def test_320_already_breaches_the_parent_watchdog(self):
        """핵심 결과: 256 바로 위 후보인 320 이 이미 280s 부모 watchdog 을 넘는다.

        즉 이 타이밍 모델을 그대로 믿는 한, 상한을 올릴 때 가장 먼저 무너지는 것은
        VRAM 도 모델 컨텍스트도 아니고 '부모 무응답 watchdog' 이다.
        """
        parent_sec, electron_sec = measured_watchdogs()
        self.assertGreater(predicted_cpu_worst_sec(320), parent_sec)
        self.assertGreater(predicted_cpu_worst_sec(384), electron_sec)
        self.assertGreater(predicted_cpu_worst_sec(512), electron_sec)

    def test_ceiling_implied_by_each_budget(self):
        parent_sec, electron_sec = measured_watchdogs()
        # DERIVED: (budget - 50.8)/0.763
        self.assertEqual(max_limit_under(ADOPTION_CRITERION_SEC), 261)
        self.assertEqual(max_limit_under(parent_sec), 300)
        self.assertEqual(max_limit_under(electron_sec), 326)
        # 300 < 320 이므로 320 은 어떤 기준으로도 통과하지 못한다.
        self.assertLess(max_limit_under(parent_sec), 320)

    def test_observed_runs_are_far_faster_than_the_worst_case_model(self):
        """실측(산문) CPU@256=151s, GPU@256=158s 는 예측 246s 보다 훨씬 빠르다.

        상한을 올리려면 최악치 모델을 다시 재느냐, 아니면 실측 기반으로 기준을 바꾸느냐가 갈린다.
        실측 CPU 기울기로 다시 풀면 허용 상한이 크게 달라진다는 점만 여기서 고정한다.
        """
        self.assertLess(CPU_OBSERVED_AT_256, predicted_cpu_worst_sec(256))
        # 실측 151s 를 같은 overhead 로 설명하면 spi ≈ (151-50.8)/256 ≈ 0.391 s/iter.
        implied_spi = (CPU_OBSERVED_AT_256 - OVERHEAD_BOUND) / 256.0
        self.assertAlmostEqual(implied_spi, 0.391, places=3)
        # 그 기울기라면 280s 예산에서 L ≈ 585 까지 간다 — 최악치 모델의 300 과 2배 차이.
        implied_max = math.floor((280 - OVERHEAD_BOUND) / implied_spi)
        self.assertGreater(implied_max, 550)


class DurationTableTest(unittest.TestCase):
    """duration 열의 근거 — 레이트는 모델 config 에서 왔고, 앱 저장소에는 없다."""

    def test_rate_is_internally_consistent_with_the_codec_arithmetic(self):
        """12.5 = 24000 / 1920. 모델 config 의 두 필드가 서로를 못 박는다."""
        self.assertAlmostEqual(CODEC_OUTPUT_SAMPLE_RATE / CODEC_SAMPLES_PER_FRAME,
                               CODEC_TOKENS_PER_SEC, places=9)
        # codec 프레임 1개 = 0.08초 정확히.
        self.assertAlmostEqual(1.0 / CODEC_TOKENS_PER_SEC, 0.08, places=9)

    def test_model_name_12hz_is_not_literally_12(self):
        """모델 이름의 '12Hz' 를 12.0 으로 읽으면 4% 어긋난다 — 실제 _frame_rate 는 12.5 다."""
        self.assertIn("12Hz", measured_model_repo_id())
        self.assertNotEqual(CODEC_TOKENS_PER_SEC, 12.0)
        self.assertAlmostEqual(CODEC_TOKENS_PER_SEC / 12.0 - 1.0, 0.041667, places=5)

    def test_durations_are_pure_division_by_the_rate(self):
        for r in build_table_b():
            self.assertAlmostEqual(r["max_audio_sec"],
                                   r["abs_limit"] / CODEC_TOKENS_PER_SEC, places=6)

    def test_candidate_max_durations(self):
        # DERIVED: tokens / 12.5
        self.assertAlmostEqual(seconds_for_tokens(256), 20.48, places=2)
        self.assertAlmostEqual(seconds_for_tokens(320), 25.60, places=2)
        self.assertAlmostEqual(seconds_for_tokens(384), 30.72, places=2)
        self.assertAlmostEqual(seconds_for_tokens(512), 40.96, places=2)
        # 현재 MIN_LIMIT 은 16.0초에 해당한다.
        self.assertAlmostEqual(seconds_for_tokens(gl.MIN_LIMIT), 16.0, places=2)

    def test_rate_is_absent_from_this_repo(self):
        """앱 저장소 안에 레이트 상수도 토큰→초 환산 코드도 없음을 정적으로 확인한다.

        이 감사가 duration 을 말하려면 모델 스냅샷 config 를 함께 읽어야만 했다는 사실 자체가
        하나의 결함이다 — 상한을 '몇 초' 로 논의할 근거가 코드 어디에도 적혀 있지 않다.
        """
        for name in ("generation_limit.py", "qwen_bridge.py", "text_segmenter.py"):
            src = _read(os.path.join(_PY_DIR, name))
            for needle in ("tokens_per_second", "codec_frame_rate", "_frame_rate", "12.5", "1920"):
                self.assertNotIn(needle, src, "%s 에 레이트 흔적이 생겼다면 이 감사를 갱신하라" % name)


class ModelOwnLimitsTest(unittest.TestCase):
    """모델 자신의 상한은 후보 상한 어디에도 근처에 오지 않는다."""

    def test_every_candidate_is_far_below_the_model_output_cap(self):
        # 모델 기본 max_new_tokens = 8192. 가장 큰 후보 512 조차 1/16 이다.
        for abs_limit in CANDIDATE_CEILINGS:
            self.assertLess(abs_limit * 16, MODEL_DEFAULT_MAX_NEW_TOKENS + 1)
        self.assertEqual(MODEL_DEFAULT_MAX_NEW_TOKENS // max(CANDIDATE_CEILINGS), 16)

    def test_every_candidate_is_far_below_the_codec_position_limit(self):
        # codec enc/dec max_position_embeddings = 8000 → 8000/12.5 = 640초.
        self.assertAlmostEqual(seconds_for_tokens(MODEL_CODEC_MAX_POSITIONS), 640.0, places=1)
        for abs_limit in CANDIDATE_CEILINGS:
            self.assertLess(abs_limit, MODEL_CODEC_MAX_POSITIONS / 10)

    def test_text_side_context_is_not_binding_either(self):
        # talker max_position_embeddings = 32768 vs 채택 최대 텍스트 토큰 121(ABS=512).
        self.assertLess(max_segment_tokens_for(max(CANDIDATE_CEILINGS)),
                        MODEL_TALKER_MAX_POSITIONS / 100)

    def test_model_limits_are_not_the_binding_constraint(self):
        """결론: 256 은 모델 능력에서 온 값이 아니다. 어떤 후보도 모델 상한을 건드리지 못한다."""
        binding_by_model = min(MODEL_DEFAULT_MAX_NEW_TOKENS, MODEL_CODEC_MAX_POSITIONS)
        self.assertGreater(binding_by_model / max(CANDIDATE_CEILINGS), 10)


class NormalCompletionMarginTest(unittest.TestCase):
    """정상 완료와 상한 사이의 여유."""

    def test_recorded_normal_maxima_disagree_with_each_other(self):
        """저장소가 '정상 최대 iter' 로 서로 다른 값을 말한다 — 88 vs 183."""
        self.assertNotEqual(OBSERVED_MAX_NORMAL_ITERS_SHORT, OBSERVED_MAX_NORMAL_ITERS_ALL)
        # 88 기준이면 여유 2.9배, 183 기준이면 1.4배 — 결론이 완전히 달라진다.
        self.assertGreater(gl.ABS_LIMIT / OBSERVED_MAX_NORMAL_ITERS_SHORT, 2.9)
        self.assertLess(gl.ABS_LIMIT / OBSERVED_MAX_NORMAL_ITERS_ALL, 1.5)

    def test_88_is_not_an_independent_datapoint(self):
        """88 은 채택 최대 토큰(33)의 envelope 예측치와 사실상 같다.

        즉 MIN_LIMIT 근거로 인용된 '관측 최대 88' 은 envelope 과 독립인 관측이 아니라
        같은 모델의 재진술일 가능성이 높다(원시 데이터가 없어 확정 불가).
        """
        self.assertLessEqual(abs(normal_envelope_iters(gl.max_segment_tokens())
                                 - OBSERVED_MAX_NORMAL_ITERS_SHORT), 2)

    def test_envelope_stays_below_applied_cap_across_accepted_range(self):
        # 채택되는 전 구간(tok<=33)에서 정상 envelope 가 적용 상한 아래여야 한다.
        for tok in range(1, gl.max_segment_tokens() + 1):
            self.assertGreater(gl.compute_max_new_tokens(tok), normal_envelope_iters(tok))

    def test_margin_design_matches_resid_max_plus_3_sigma(self):
        """BASE=160 의 여유가 기록된 설계치(resid_max + 3σ)를 실제로 덮는지 확인."""
        design_margin = CALIB3_RESID_MAX + 3 * CALIB3_STD   # DERIVED: 67 + 81 = 148
        self.assertEqual(design_margin, 148)
        actual = gl.compute_max_new_tokens(gl.max_segment_tokens()) \
            - normal_envelope_iters(gl.max_segment_tokens())
        self.assertGreaterEqual(actual, design_margin)      # 169 >= 148

    def test_no_real_run_distribution_exists_in_repo(self):
        """정상완료 vs generation_limit 의 실제 분포 데이터가 저장소에 없음을 고정.

        test_qwen_engine.py 의 generated_iterations 값은 전부 손으로 적은 픽스처다.
        이 테스트는 '분포 데이터가 생기면 여기부터 고쳐라' 는 표식 역할을 한다.
        """
        src = _read(os.path.join(_PY_DIR, "test_qwen_engine.py"))
        # 픽스처는 죄다 동일한 라운드 넘버 100 — 실측 분포라면 이럴 수 없다.
        self.assertGreater(src.count('"generated_iterations": 100'), 1)


class RunawayTailTest(unittest.TestCase):
    """G2 실측 tail — 상한을 올릴 때 무엇이 진짜 위험한지 결정하는 단 하나의 실데이터."""

    def test_g2_tail_blew_through_the_envelope_to_the_cap(self):
        cap_at_18 = gl.compute_max_new_tokens(G2_TAIL_PROD_TOKENS)
        self.assertEqual(cap_at_18, 213)                 # ceil(2.9*18+160) = 213
        self.assertEqual(G2_TAIL_ITERS, cap_at_18)       # 상한에 '도달' — 즉 잘림
        self.assertEqual(gl.classify_termination(G2_TAIL_ITERS, cap_at_18), "generation_limit")
        env = normal_envelope_iters(G2_TAIL_PROD_TOKENS)
        self.assertGreater(G2_TAIL_ITERS / env, 4.5)     # 약 4.63~4.73배

    def test_envelope_does_not_bound_the_tail(self):
        """핵심: envelope 위에 얹은 margin(resid_max+3σ)은 tail 을 막지 못한다.

        G2 는 tok=18 에서 envelope 46 을 4.6배 넘겨 상한까지 달렸다. 설계 여유 148 로는
        어림도 없다. 따라서 '여유 배수' 논증만으로 상한을 올리는 것은 근거가 되지 못한다.
        """
        env = normal_envelope_iters(G2_TAIL_PROD_TOKENS)
        design_margin = CALIB3_RESID_MAX + 3 * CALIB3_STD
        self.assertGreater(G2_TAIL_ITERS - env, design_margin)

    def test_tail_means_the_worst_case_timing_model_is_the_relevant_one(self):
        """tail 이 실제로 상한까지 달린다는 것은 predicted(L) 이 가설이 아니라는 뜻이다.

        상한을 L 로 올리면, 런어웨이가 났을 때 그 chunk 는 실제로 L 번 돌고 나서야 끊긴다.
        따라서 watchdog 대비 비교는 '정상 완료 시간' 이 아니라 predicted(L) 로 해야 한다.
        """
        parent_sec, _ = measured_watchdogs()
        # 현재 상한에서도 tail 이 걸리면 CPU 최악 예측은 watchdog 여유가 34s 뿐이다.
        self.assertLess(parent_sec - predicted_cpu_worst_sec(gl.ABS_LIMIT), 40)


class CounterfactualAbs1024Test(unittest.TestCase):
    """커밋되지 않은 초기 계약(ABS=1024)이 왜 살아남지 못했는지를 산술로 남긴다.

    MEASURED(산문): tts-prosody-integration.md:33 은 ABS_LIMIT=1024 를 '정상 최대 iter 183 의 ~5.6배'
    라는 캘리브레이션 헤드룸 논증으로 정당화했다. 그 문서는 지금도 1024 라고 적혀 있어 코드와 어긋난다.
    1401d38 은 근거를 통째로 바꿔(타이밍 예산) 256 을 커밋했고, 그 사이 중간 커밋은 없다.
    """

    def test_1024_headroom_claim_is_arithmetically_consistent(self):
        self.assertAlmostEqual(1024 / OBSERVED_MAX_NORMAL_ITERS_ALL, 5.6, delta=0.05)

    def test_1024_is_hopeless_under_the_timing_budget(self):
        # predicted(1024) = 50.8 + 0.763*1024 = 832.1s — 부모 watchdog 280s 의 약 3배.
        parent_sec, _ = measured_watchdogs()
        self.assertGreater(predicted_cpu_worst_sec(1024) / parent_sec, 2.9)

    def test_1024_would_have_allowed_297_text_tokens(self):
        """상한 인하의 숨은 대가: 채택 가능한 segment 길이가 297 → 33 으로 약 9배 줄었다.

        어떤 문서도 이 결과를 논의하지 않았다.
        """
        self.assertEqual(max_segment_tokens_for(1024), 297)
        self.assertGreater(max_segment_tokens_for(1024) / gl.max_segment_tokens(), 8.9)


class TableShapeTest(unittest.TestCase):
    """표가 실제로 만들어지고 자기모순이 없는지."""

    def test_tables_build(self):
        a, b, c = build_table_a(), build_table_b(), build_table_c()
        self.assertEqual(len(a), len(TABLE_A_TOKENS))
        self.assertEqual(len(b), len(CANDIDATE_CEILINGS))
        self.assertEqual(len(c), len(CANDIDATE_CEILINGS)
                         * len(ASSUMED_WRAPPER_TOKENS) * len(ASSUMED_TOKENS_PER_SENTENCE))

    def test_table_a_marks_the_autosplit_boundary(self):
        by_tok = {r["tok"]: r for r in build_table_a()}
        self.assertTrue(by_tok[33]["accepted_chunk"])    # 경계 포함
        self.assertFalse(by_tok[34]["accepted_chunk"])   # 초과 → 자동 분할
        self.assertEqual(by_tok[33]["applied_cap"], gl.ABS_LIMIT)

    def test_sentences_per_chunk_is_monotonic_in_ceiling(self):
        # 상한이 커지면 chunk 당 문장 수는 줄지 않는다(가정값 고정 시).
        for w in ASSUMED_WRAPPER_TOKENS:
            for s in ASSUMED_TOKENS_PER_SENTENCE:
                vals = [sentences_per_chunk(max_segment_tokens_for(x), w, s)
                        for x in CANDIDATE_CEILINGS]
                self.assertEqual(vals, sorted(vals))

    def test_report_renders(self):
        text = format_report()
        self.assertIn("UNVERIFIED", text)
        self.assertIn("표 B", text)
        self.assertGreater(len(text.splitlines()), 40)


if __name__ == "__main__":
    print(format_report())
    print()
    unittest.main(verbosity=2)
