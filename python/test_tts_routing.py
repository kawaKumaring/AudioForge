# -*- coding: utf-8 -*-
"""TTS 2A 라우팅 회귀 테스트 — 모델 로딩 없이 감정 태그별 참조 음성이
tts_worker.synthesize()의 engine.synthesize_segment 호출까지 정확히 선택되는지 검증.

검증 경로(실제 synthesize를 그대로 호출 — 헬퍼만 따로 테스트하지 않음):
  ttsEmotionRefs → synthesize() → _parse_line() → emotion_id → ref_cache
  → engine.synthesize_segment(text, ref, emotion_id, ...)

모델 차단: _select_engine을 가짜 엔진 반환으로 monkeypatch → 실제 GPT-SoVITS/F5/Kokoro
로딩·추론이 한 번도 일어나지 않는다(_engine_cache 비어 있음 + 실행 시간으로 확인).

새 의존성 없음(stdlib unittest). soundfile/numpy는 프로젝트가 이미 쓰는 것.
임시 디렉터리만 사용하고 종료 후 정리한다.

실행:
  python python/test_tts_routing.py
  python -m unittest discover -s python -p "test_tts_routing.py"
"""
import os
import sys
import time
import tempfile
import shutil
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tts_worker  # noqa: E402


def _write_tiny_wav(path):
    """0.05초 무음 WAV(24kHz mono) — 실제 모델 없이 파이프라인이 읽을 수 있는 최소 파일."""
    import soundfile as sf
    import numpy as np
    sf.write(path, np.zeros(1200, dtype="float32"), 24000)


class FakeEngine(tts_worker.TTSEngine):
    """모델을 로딩하지 않는 가짜 엔진. synthesize_segment 인자를 기록하고
    출력 경로에 최소 WAV를 쓴다(concat/rename이 동작하도록)."""
    name = "fake"

    def __init__(self):
        self.calls = []
        self.load_called = 0

    def load(self, *a, **k):
        self.load_called += 1  # 실제 라우팅에선 호출되지 않아야 함

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        self.calls.append({
            "text": text,
            "ref": ref_audio,
            "ref_name": os.path.basename(ref_audio),
            "emotion_id": emotion_id,
            "speed": speed,
            "output_path": output_path,
        })
        _write_tiny_wav(output_path)


class TtsRoutingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af_tts_test_")
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out, exist_ok=True)
        # 참조 WAV 3개
        self.default_wav = os.path.join(self.tmp, "default.wav")
        self.happy_wav = os.path.join(self.tmp, "happy.wav")
        self.sad_wav = os.path.join(self.tmp, "sad.wav")
        for p in (self.default_wav, self.happy_wav, self.sad_wav):
            _write_tiny_wav(p)

        # 가짜 엔진 주입 + emit 기록(실제 모델 로딩 완전 차단)
        self.fake = FakeEngine()
        self._orig_select = tts_worker._select_engine
        self._orig_job = tts_worker._select_job_engine
        self._orig_emit = tts_worker.emit
        self.emitted = []
        tts_worker._select_engine = lambda text, preferred=None: self.fake
        # 이 테스트는 '문장별 감정 매핑'을 검증한다. Qwen venv가 설치돼 있으면 한국어 auto가
        # Qwen 배치로 라우팅되므로, 배치 라우팅을 끄고 per-segment 경로를 결정적으로 탄다.
        tts_worker._select_job_engine = lambda text, preferred=None: None
        tts_worker.emit = lambda mtype, **kw: self.emitted.append((mtype, kw))
        # 라우팅에 영향받지 않도록 엔진 캐시는 비운 상태에서 시작하되,
        # 기존 캐시를 보존했다가 tearDown에서 복원한다(같은 프로세스의 다른 TTS 테스트 격리).
        self._orig_engine_cache = dict(tts_worker._engine_cache)
        tts_worker._engine_cache.clear()

    def tearDown(self):
        tts_worker._select_engine = self._orig_select
        tts_worker._select_job_engine = self._orig_job
        tts_worker.emit = self._orig_emit
        # 이 테스트가 만든 캐시를 제거하고 기존 캐시를 복원
        tts_worker._engine_cache.clear()
        tts_worker._engine_cache.update(self._orig_engine_cache)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, text, emotion_refs):
        t0 = time.time()
        tts_worker.synthesize(
            self.default_wav, text, self.out,
            speed=1.0, silence_gap=0.5, emotion_refs=emotion_refs, preferred_engine=None,
        )
        return time.time() - t0

    def _no_error(self):
        errs = [kw for mtype, kw in self.emitted if mtype == "error"]
        self.assertEqual(errs, [], f"에러 emit 발생: {errs}")

    # ── 5. 메인 라우팅: 기쁨/슬픔/화남 ──────────────────────────────────
    def test_emotion_routing_main(self):
        text = "[기쁨] 기쁜 문장입니다.\n[슬픔] 슬픈 문장입니다.\n[화남] 화난 문장입니다."
        refs = {"happy": self.happy_wav, "sad": self.sad_wav}  # angry 미등록
        elapsed = self._run(text, refs)
        self._no_error()

        calls = self.fake.calls
        self.assertEqual(len(calls), 3, "3개 문장 모두 synthesize_segment 호출")

        # 기쁨 → happy.wav / emotion_id=happy / 본문만
        self.assertEqual(calls[0]["emotion_id"], "happy")
        self.assertEqual(calls[0]["ref_name"], "happy.wav")
        self.assertEqual(calls[0]["text"], "기쁜 문장입니다.")
        # 슬픔 → sad.wav / sad
        self.assertEqual(calls[1]["emotion_id"], "sad")
        self.assertEqual(calls[1]["ref_name"], "sad.wav")
        self.assertEqual(calls[1]["text"], "슬픈 문장입니다.")
        # 화남 → 미등록이라 default.wav / emotion_id=angry
        self.assertEqual(calls[2]["emotion_id"], "angry")
        self.assertEqual(calls[2]["ref_name"], "default.wav")
        self.assertEqual(calls[2]["text"], "화난 문장입니다.")

        # 참조가 서로 뒤바뀌지 않음
        self.assertNotEqual(calls[0]["ref"], calls[1]["ref"])
        self.assertNotEqual(calls[0]["ref"], calls[2]["ref"])

        # 최종 산출물 생성
        self.assertTrue(os.path.exists(os.path.join(self.out, "synthesized.wav")))

        # 모델 로딩 없음: 실제 엔진 캐시 비어 있음 + 가짜 load 미호출 + 빠른 실행
        self.assertEqual(tts_worker._engine_cache, {}, "실제 엔진이 생성되면 안 됨")
        self.assertEqual(self.fake.load_called, 0)
        self.assertLess(elapsed, 5.0, f"모델 없는 라우팅이 5초 미만이어야 함(측정 {elapsed:.2f}s)")

    # ── 6-1. 알 수 없는 태그 → default ─────────────────────────────────
    def test_unknown_tag_falls_back_to_default(self):
        self._run("[존재하지않는태그] 미지 태그 문장.", {})
        self._no_error()
        c = self.fake.calls
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["emotion_id"], "default")
        self.assertEqual(c[0]["ref_name"], "default.wav")
        self.assertEqual(c[0]["text"], "미지 태그 문장.")

    # ── 6-2. 등록 경로가 존재하지 않는 감정 참조 → default 폴백 ─────────
    def test_missing_ref_path_errors_not_silent_fallback(self):
        # 계약 §5 불변식3(변경): 등록된 감정의 effective 파일이 없으면(만료) 조용히 default로 폴백하지
        # 않고 감정 label을 지목한 명확한 오류(RuntimeError)를 낸다. 예전엔 silent default 폴백이었음.
        refs = {"happy": os.path.join(self.tmp, "does_not_exist.wav")}
        with self.assertRaises(RuntimeError) as ctx:
            self._run("[기쁨] 파일 없는 기쁨.", refs)
        self.assertIn("기쁨", str(ctx.exception))          # 감정 label 지목
        self.assertEqual(self.fake.calls, [])              # 조용한 합성 진행이 없어야 함

    # ── 6-3. 감정 태그 없는 문장 → default 참조 ────────────────────────
    def test_no_tag_uses_default(self):
        self._run("태그 없는 그냥 문장입니다.", {"happy": self.happy_wav})
        self._no_error()
        c = self.fake.calls
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["emotion_id"], "default")
        self.assertEqual(c[0]["ref_name"], "default.wav")
        self.assertEqual(c[0]["text"], "태그 없는 그냥 문장입니다.")

    # ── 6-4. 서로 다른 감정 참조가 뒤바뀌지 않음(교차 등록) ────────────
    def test_refs_not_swapped(self):
        text = "[슬픔] 슬픔 먼저.\n[기쁨] 기쁨 나중."
        refs = {"happy": self.happy_wav, "sad": self.sad_wav}
        self._run(text, refs)
        self._no_error()
        c = self.fake.calls
        self.assertEqual(c[0]["ref_name"], "sad.wav")   # 슬픔 → sad
        self.assertEqual(c[1]["ref_name"], "happy.wav")  # 기쁨 → happy

    # ── 모델 로딩이 전혀 없었음을 별도 확인 ────────────────────────────
    def test_no_real_engine_instantiated(self):
        self._run("[기쁨] 문장.", {"happy": self.happy_wav})
        self.assertEqual(tts_worker._engine_cache, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
