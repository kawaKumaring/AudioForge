"""실행 기록이 나중에 질문에 답할 수 있는가 — 기록 완전성 계약.

왜 이 파일이 있는가(2026-09-08)
────────────────────────────
"이전에 옵션을 켜고 끄며 테스트했을 때는 왜 음원에 문제가 있었나" 를 실행 기록으로 답하려 했다.
기록은 95건이 남아 있었는데 **정작 필요한 값이 빠져 있었다.**

  · 어느 음성 모델 판으로 만들었는지        → 기록에 없음(화면 metadata 에는 있었다)
  · 참조의 어느 구간을 썼는지                → 칸은 있는데 늘 None
  · 참조를 어떤 방식으로 먹였는지(전사 상태) → 기록에 없음
  · 난수 씨앗                                → 늘 None, `seed_supported: false` 로 **사실과 다르게** 기록
  · 음량 보정이 걸린 기준값                  → 걸렸다는 사실만 있고 게이트 값이 없음

그 결과 "옵션 차이 때문인가 난수 때문인가" 를 끝까지 가릴 수 없었다. 기록은 남기는 것이 목적이
아니라 **나중에 답할 수 있는 것**이 목적이다. 이 시험은 그 최소선을 고정한다.

동시에 반대쪽도 고정한다: 기록에는 **절대경로·대사 전문·전사 전문이 들어가지 않는다.**
많이 남기는 것과 아무거나 남기는 것은 다른 일이다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tts_worker as tw

#: 2026-09-08 조사에서 없어서 막혔던 값들. 하나라도 빠지면 같은 질문에 또 답할 수 없다.
MUST_RECORD = (
    "qwen_model_variant",          # 어느 모델 판
    "seed", "seed_supported", "seed_source",   # 난수 — 이것이 없으면 어떤 비교도 재현 불가
    "reference_region",            # 참조의 어느 구간
    "prompt_source", "x_vector_only_mode",     # 참조를 어떻게 먹였나
    "reference_transcript_status", "reference_transcript_language",
    "reference_conditioning_mode_effective", "reference_conditioning_auto_fallback",
    "macro_gain_applied", "macro_gain_reason",
    "macro_gain_statistic_db", "macro_gain_gate_db", "macro_gain_max_boost_db",
    "model_name", "model_revision", "device",
    "generation_limit", "generated_iterations", "termination_reason",
)

#: 기록에 들어가면 안 되는 것 — 절대경로·본문. 남기는 범위와 개인정보 경계는 다른 축이다.
MUST_NOT_RECORD = (
    "original_reference_path",     # 절대경로
    "effective_reference_path",    # 절대경로
    "raw_text",                    # 대사 전문
    "reference_transcript",        # 전사 전문
    "prompt_text",
)


class HeaderCarriesWhatWeNeed(unittest.TestCase):
    def test_must_record_keys_are_in_the_header_list(self):
        missing = [k for k in MUST_RECORD if k not in tw._RUN_HEADER_FROM_METADATA]
        self.assertEqual(missing, [], "기록에서 빠진 값 — 이것들이 없어서 2026-09-08 조사가 막혔다")

    def test_header_list_has_no_absolute_paths_or_text(self):
        leaked = [k for k in MUST_NOT_RECORD if k in tw._RUN_HEADER_FROM_METADATA]
        self.assertEqual(leaked, [], "절대경로·본문은 기록에 넣지 않는다")

    def test_every_header_key_exists_in_metadata(self):
        # 목록에만 있고 metadata 에 없는 이름은 조용히 버려진다 — 기록이 있다고 착각하게 된다.
        unknown = [k for k in tw._RUN_HEADER_FROM_METADATA if k not in tw._METADATA_KEYS]
        self.assertEqual(unknown, [], "metadata 에 없는 이름 — 기록되지 않고 조용히 사라진다")

    def test_metadata_builder_keeps_the_seed_fields(self):
        # _METADATA_KEYS 로 걸러지므로 목록에 없으면 값을 넣어도 사라진다.
        for k in ("seed", "seed_supported", "seed_source"):
            self.assertIn(k, tw._METADATA_KEYS, k)


class EnvironmentFacts(unittest.TestCase):
    """환경 기록은 실패해도 합성을 막지 않는다 — 그리고 개인정보를 담지 않는다."""

    def test_returns_a_dict_and_never_raises(self):
        for dev in (None, "cpu", "cuda:0", "cuda:bad", 123):
            with self.subTest(dev=dev):
                out = tw._environment_facts(dev)
                self.assertIsInstance(out, dict)

    def test_keys_are_limited_to_environment_facts(self):
        allowed = {"env_python", "env_os", "env_torch", "env_cuda",
                   "gpu_name", "gpu_vram_free_mb", "gpu_vram_total_mb"}
        extra = set(tw._environment_facts("cpu")) - allowed
        self.assertEqual(extra, set(), "환경 기록에 허용되지 않은 이름이 들어갔다")

    def test_no_paths_in_values(self):
        # 경로처럼 보이는 값이 섞이면 절대경로 금지 계약이 깨진다.
        for k, v in tw._environment_facts("cpu").items():
            if isinstance(v, str):
                self.assertNotIn(os.sep, v, f"{k} 에 경로가 들어 있다")


class SeedIsWired(unittest.TestCase):
    """씨앗은 '기능은 있는데 배선이 없던' 대표 사례였다 — 배선을 계약으로 고정한다."""

    def test_run_job_accepts_seed(self):
        import inspect
        sig = inspect.signature(tw.QwenTTSEngine.run_job)
        self.assertIn("seed", sig.parameters, "run_job 이 씨앗을 받지 않는다")

    def test_bridge_reads_seed_from_job_config(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "qwen_bridge.py"), encoding="utf-8") as fh:
            bridge = fh.read()
        self.assertIn('cfg.get("seed")', bridge, "브리지가 job 설정에서 씨앗을 읽어야 한다")

    def test_worker_puts_seed_into_job_config(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "tts_worker.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn('cfg["seed"] = int(seed)', src)
        self.assertIn("qwen.run_job(segments, device, seed=run_seed)", src)
        # 기본은 실행마다 다른 씨앗이다 — 항상 고정하면 매번 같은 소리만 나온다.
        self.assertIn("random.randrange(1, 2 ** 31 - 1)", src)
        self.assertIn('AUDIOFORGE_TTS_SEED', src, "고정 지정 통로가 있어야 재현이 된다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
