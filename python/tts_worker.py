"""TTS engine abstraction + synthesis worker.

Engines:
  - F5-TTS: English + voice cloning (reference audio)
  - Kokoro: Korean, Japanese, Chinese, English (voice packs)
  - (future) GPT-SoVITS: Korean/Japanese + voice cloning

Engine selection:
  - User can specify engine in UI
  - Auto-select by language: Korean/Japanese → Kokoro, English → F5-TTS
"""

import os
import re
import sys
import time
import chunk_paths   # chunk 경로 규칙(bridge와 공용) — 결정적 경로 정확 일치 검증
import semantic_chunk_planner   # 의미 경계 분류 + 무음 예산(C2). 순수 로직(stdlib only).
from audio_utils import emit, get_device, find_ffmpeg, patch_torchaudio

# ── Emotion definitions ──
# ⚠️ 감정 id는 UI(src/renderer/components/TTSEditor.tsx의 EMOTION_GROUPS)와 공유된다.
# 여기 값(id)/키(한글 태그)를 바꾸면 TS도 함께 갱신할 것. 불일치는 smoke_test의
# _check_emotions()가 잡는다(TS id ⊆ EMOTION_PROMPTS 키 ∩ EMOTION_TAGS 값). — L-3

EMOTION_TAGS = {
    "기본": "default", "기쁨": "happy", "슬픔": "sad", "화남": "angry",
    "놀람": "surprise", "속삭임": "whisper", "진지": "serious", "명랑": "cheerful",
    "걱정": "worried", "피곤": "tired", "공손": "polite", "냉소": "sarcastic",
    "긴장": "nervous", "부끄러움": "shy", "자신감": "confident", "위로": "comforting",
    "흥분": "excited", "공포": "scared", "짜증": "annoyed", "나레이션": "narration",
    "그리움": "longing", "질투": "jealous", "감동": "touched", "허탈": "empty",
    "비꼼": "mocking", "애교": "cute", "냉정": "cold", "다정": "tender",
    "울먹": "tearful", "한숨": "sighing", "비장": "solemn", "장난": "playful",
    "경멸": "contempt", "동경": "admiring", "초조": "restless", "체념": "resigned",
    "호기심": "curious", "지루함": "bored", "당황": "flustered", "득의": "proud",
    "설렘": "flutter", "유혹": "seductive", "달콤": "sweet", "은밀": "intimate",
    "애틋": "bittersweet", "매력": "charming", "흥분(성적)": "aroused",
    "절정": "climax", "신음": "moaning", "황홀": "ecstasy",
    # English aliases
    "happy": "happy", "sad": "sad", "angry": "angry", "surprise": "surprise",
    "whisper": "whisper", "serious": "serious", "cheerful": "cheerful",
    "worried": "worried", "tired": "tired", "polite": "polite", "sarcastic": "sarcastic",
    "nervous": "nervous", "shy": "shy", "confident": "confident", "comforting": "comforting",
    "excited": "excited", "scared": "scared", "annoyed": "annoyed", "narration": "narration",
    "longing": "longing", "jealous": "jealous", "touched": "touched", "empty": "empty",
    "mocking": "mocking", "cute": "cute", "cold": "cold", "tender": "tender",
    "tearful": "tearful", "sighing": "sighing", "solemn": "solemn", "playful": "playful",
    "contempt": "contempt", "admiring": "admiring", "restless": "restless", "resigned": "resigned",
    "curious": "curious", "bored": "bored", "flustered": "flustered", "proud": "proud",
    "flutter": "flutter", "seductive": "seductive", "sweet": "sweet", "intimate": "intimate",
    "bittersweet": "bittersweet", "charming": "charming", "aroused": "aroused",
    "climax": "climax", "moaning": "moaning", "ecstasy": "ecstasy",
}

EMOTION_PROMPTS = {
    "default": "", "happy": "(happily, with joy and excitement) ",
    "sad": "(sadly, with a sorrowful and melancholic tone) ",
    "angry": "(angrily, with frustration and strong intensity) ",
    "surprise": "(with genuine surprise and wide-eyed astonishment) ",
    "whisper": "(whispering very softly and quietly, barely audible) ",
    "serious": "(in a serious, formal and composed authoritative tone) ",
    "cheerful": "(cheerfully, with a bright, upbeat and light-hearted tone) ",
    "worried": "(with worry and anxiety, voice slightly trembling) ",
    "tired": "(tiredly, with a weary, slow and exhausted tone) ",
    "polite": "(politely and respectfully, with a warm courteous tone) ",
    "sarcastic": "(sarcastically, with a dry and ironic undertone) ",
    "nervous": "(nervously, with a shaky and hesitant voice) ",
    "shy": "(shyly, with a soft, bashful and timid tone) ",
    "confident": "(confidently, with a strong, bold and assured voice) ",
    "comforting": "(gently and warmly, with a soothing comforting tone) ",
    "excited": "(excitedly, with high energy and enthusiastic tone) ",
    "scared": "(fearfully, with a trembling and frightened voice) ",
    "annoyed": "(with annoyance and slight irritation in voice) ",
    "narration": "(in a calm, clear narrator voice with even pacing) ",
    "longing": "(with deep longing and nostalgic yearning) ",
    "jealous": "(with jealousy and envious undertone) ",
    "touched": "(deeply moved and emotionally touched, voice quivering) ",
    "empty": "(with an empty, hollow and defeated tone) ",
    "mocking": "(mockingly, with a taunting and derisive tone) ",
    "cute": "(cutely, with an adorable and sweet aegyo tone) ",
    "cold": "(coldly, with an icy and emotionless flat tone) ",
    "tender": "(tenderly, with warmth and gentle affection) ",
    "tearful": "(on the verge of tears, voice cracking with emotion) ",
    "sighing": "(with a heavy sigh, weary and resigned) ",
    "solemn": "(solemnly, with gravity and dignified seriousness) ",
    "playful": "(playfully, with a teasing and fun-loving tone) ",
    "contempt": "(with contempt and disdain, looking down) ",
    "admiring": "(with admiration and awe, deeply impressed) ",
    "restless": "(restlessly, with urgent and fidgety energy) ",
    "resigned": "(with resigned acceptance, giving up hope) ",
    "curious": "(curiously, with inquisitive wonder) ",
    "bored": "(boredly, with a flat and uninterested monotone) ",
    "flustered": "(flustered, confused and embarrassed) ",
    "proud": "(proudly, with triumphant satisfaction) ",
    "flutter": "(with heart fluttering, nervous romantic excitement and anticipation) ",
    "seductive": "(in a low, seductive and alluring tone, slow and breathy) ",
    "sweet": "(sweetly, with a honey-like warm and loving tone) ",
    "intimate": "(intimately, in a close, quiet and private whisper) ",
    "bittersweet": "(with bittersweet longing, tender yet painful) ",
    "charming": "(charmingly, with confident and magnetic allure) ",
    "aroused": "(with heavy breathing, heated and passionate intensity) ",
    "climax": "(with intense, overwhelming emotional peak, gasping) ",
    "moaning": "(with a low, breathy moan-like quality) ",
    "ecstasy": "(in a dreamy, euphoric and blissful daze) ",
}


# ── Engine base class ──

class TTSEngine:
    """Base class for TTS engines. Subclass to add new engines."""
    name = "base"
    supported_languages = []

    def load(self):
        raise NotImplementedError

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        raise NotImplementedError


# ── F5-TTS Engine (English + voice cloning) ──

class F5TTSEngine(TTSEngine):
    name = "f5tts"
    supported_languages = ["en"]

    def __init__(self):
        self._model = None

    def load(self):
        if self._model is None:
            emit("progress", percent=10, message="F5-TTS 모델 로딩 중...")
            patch_torchaudio()  # F5-TTS loads ref audio via torchaudio.load
            from f5_tts.api import F5TTS
            device = get_device(timeout_sec=10)
            self._model = F5TTS(device=device)
            emit("progress", percent=20, message=f"F5-TTS 로딩 완료 ({device.upper()})")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        self.load()
        ref_text = EMOTION_PROMPTS.get(emotion_id, "")
        self._model.infer(
            ref_file=ref_audio, ref_text=ref_text,
            gen_text=text, file_wave=output_path, speed=speed
        )


# ── Kokoro Engine (Korean, Japanese, Chinese, English) ──

class KokoroEngine(TTSEngine):
    name = "kokoro"
    supported_languages = ["ko", "ja", "zh", "en"]

    def __init__(self):
        self._pipeline = None
        self._lang = "k"  # default Korean

    def load(self, lang_code="ko"):
        lang_map = {"ko": "k", "ja": "j", "zh": "z", "en": "a"}
        new_lang = lang_map.get(lang_code, "k")

        # Reload only when the language actually changes
        if self._pipeline is not None and self._lang == new_lang:
            return

        emit("progress", percent=10, message=f"Kokoro TTS 로딩 중... (언어: {lang_code})")
        from kokoro import KPipeline
        self._pipeline = KPipeline(lang_code=new_lang)
        self._lang = new_lang
        emit("progress", percent=20, message="Kokoro 로딩 완료")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        # Do not force-reload here — the caller sets the language via load(lang)
        if self._pipeline is None:
            self.load()
        import soundfile as sf

        generator = self._pipeline(text, speed=speed)
        all_audio = []
        for _, _, audio in generator:
            all_audio.append(audio)

        if all_audio:
            import numpy as np
            combined = np.concatenate(all_audio)
            sf.write(output_path, combined, 24000)


# ── GPT-SoVITS Engine (Korean, Japanese, Chinese, English — via isolated venv) ──

class GPTSoVITSEngine(TTSEngine):
    name = "gptsovits"
    supported_languages = ["ko", "ja", "zh", "en"]

    # 전사 캐시 상한(엔진 인스턴스 범위) — 정상 작업은 참조가 소수라 도달하지 않지만,
    # 비정상적으로 많은 참조에서도 무한히 쌓이지 않게 하는 방어적 상한.
    _TRANSCRIPT_CACHE_MAX = 128

    def __init__(self):
        self._venv_python = None
        self._bridge_script = None
        self._ref_assess_cache = {}  # (path,size,mtime) → ReferenceAssessment (재판정 방지)
        self._warned_refs = set()    # 참조당 판정 경고 1회만 알림
        self._ref_transcript_cache = {}  # (path,size,mtime,model) → ReferenceTranscript (전사 1회)
        self._warned_transcripts = set()  # (transcript_key, code) → 전사 강등 경고 1회만
        self._announced_transcripts = set()  # transcript_key → 전사 완료 메시지 1회만(로그 오염 방지)
        self._prompt_overrides = {}  # abspath → {manual_text, prompt_lang, mode} (사용자 수동 override)
        self._last_device_info = {}  # bridge 가 보고한 device 계보(요청/실제/강등)

    def set_prompt_overrides(self, overrides_by_path):
        """경로별 사용자 프롬프트 override 설정. 매 작업 시작 시 호출(빈 dict면 이전 override 해제)."""
        self._prompt_overrides = overrides_by_path or {}

    def _emit_prompt_warnings(self, key, prompt):
        """ref-free 등 강등 경고를 참조·원인당 1회만 emit."""
        for w in prompt.warnings:
            wkey = (key, w.code)
            if wkey not in self._warned_transcripts:
                self._warned_transcripts.add(wkey)
                emit("progress", percent=8, message=f"참조 전사 경고 [{w.code}] {w.message}")

    def load(self):
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self._bridge_script = os.path.join(base_dir, "python", "gptsovits_bridge.py")

        # 실행 환경은 app_runtime(=runtime.json)이 답한다. 설치기가 검증을 통과시킨
        # 환경만 연결되므로, 여기서 얻은 경로는 "있는 것"이 아니라 "검증된 것"이다.
        # runtime.json이 없으면 예전 관례 경로로 폴백한다(기존 설치 호환).
        import app_runtime
        paths = app_runtime.resolve_gptsovits()
        self._venv_python = paths["python"]

        if not os.path.exists(self._venv_python):
            probe = app_runtime.probe_gptsovits()
            raise RuntimeError(
                "GPT-SoVITS 실행 환경이 준비되지 않았습니다 "
                f"({probe['reason']}: {app_runtime.describe(probe['reason'])}). "
                "run.bat을 실행하면 환경 검사 후 설치·연결을 진행합니다.")

    def _transcript_key(self, ref_audio, model_name):
        """전사 캐시 키: 절대경로 + size + mtime_ns + Whisper 모델명.
        경로가 같아도 파일이 교체(size/mtime 변경)되면 키가 달라져 재전사된다."""
        try:
            st = os.stat(ref_audio)
            return (os.path.abspath(ref_audio), st.st_size, st.st_mtime_ns, model_name)
        except OSError:
            return (os.path.abspath(ref_audio), None, None, model_name)

    def _get_ref_prompt(self, ref_audio, target_language, model_name="small"):
        """참조 음성을 전사하고 GPT-SoVITS용 ReferencePrompt를 만든다(구조화).
        - 전사는 (경로+size+mtime+모델) 캐시로 참조당 1회.
        - 성공: 언어+글자 수만 progress로 표시(전문은 로그에 출력하지 않음).
        - 실패/빈 결과/미지원 언어: ref-free로 강등하되, 같은 참조·같은 원인당 1회만 경고 emit."""
        from reference_transcript import (transcribe_reference, build_gpt_prompt,
                                          build_manual_prompt, build_user_ref_free_prompt,
                                          normalize_language, MODE_TRANSCRIBED, MODE_REF_FREE)
        key = self._transcript_key(ref_audio, model_name)

        # ── 사용자 override(수동 전사/프롬프트 언어/모드) — 자동 전사보다 우선 ──
        ov = self._prompt_overrides.get(os.path.abspath(ref_audio)) if self._prompt_overrides else None
        user_lang = (ov or {}).get("prompt_lang")
        if ov:
            # 우선순위 고정: 명시적 ref_free > 명시적 manual(비어있지 않음) > auto.
            if ov.get("mode") == MODE_REF_FREE:
                # ref-free에서는 manual_text가 남아 있어도 무시하고 참조 없이 합성.
                prompt = build_user_ref_free_prompt(target_language, user_lang)
                self._emit_prompt_warnings(key, prompt)
                return prompt
            manual_text = (ov.get("manual_text") or "").strip()
            if manual_text:
                # 비어있지 않은 수동 전사문 → Whisper 미호출
                prompt = build_manual_prompt(manual_text, user_lang, target_language)
                if key not in self._announced_transcripts:
                    self._announced_transcripts.add(key)
                    emit("progress", percent=9,
                         message=f"참조 전사(수동): {prompt.prompt_language}, {len(manual_text)}자")
                return prompt
            # 빈 수동 입력 + auto → 아래 자동 경로로(빈 수동을 자동 성공으로 오인하지 않음)

        # ── 자동 전사 경로 ──
        if key in self._ref_transcript_cache:
            transcript = self._ref_transcript_cache[key]
        else:
            emit("progress", percent=8, message="참조 음성 전사 중... (클로닝 품질 향상)")
            transcript = transcribe_reference(ref_audio, model_name)
            # 실패/빈 결과도 캐시해 같은 작업에서 반복 모델 호출을 막는다.
            if len(self._ref_transcript_cache) < self._TRANSCRIPT_CACHE_MAX:
                self._ref_transcript_cache[key] = transcript

        prompt = build_gpt_prompt(transcript, target_language)
        # 사용자가 프롬프트 언어를 지정했으면 자동 감지 언어를 덮어씀(전사문은 자동 유지)
        if user_lang and prompt.mode == MODE_TRANSCRIBED:
            nl = normalize_language(user_lang)
            if nl:
                prompt.prompt_language = nl

        if prompt.mode == MODE_TRANSCRIBED:
            if key not in self._announced_transcripts:
                self._announced_transcripts.add(key)
                emit("progress", percent=9,
                     message=f"참조 전사 완료: {prompt.prompt_language}, {len(prompt.prompt_text)}자")
        else:
            self._emit_prompt_warnings(key, prompt)
        return prompt

    def _assess_ref(self, ref_audio):
        """모델/Whisper/브리지 로딩 전에 참조 음성을 판정한다.
        invalid면 구조화된 오류로 즉시 실패 → 2초·20초·무음·손상 파일은 모델을 전혀 로딩하지 않는다.
        같은 참조(size/mtime 동일)는 재판정하지 않고, 경고는 참조당 한 번만 알린다."""
        from reference_audio import assess_reference_file, GPTSOVITS_POLICY
        try:
            st = os.stat(ref_audio)
            key = (os.path.abspath(ref_audio), st.st_size, st.st_mtime_ns)
        except OSError:
            key = (os.path.abspath(ref_audio), None, None)

        if key in self._ref_assess_cache:
            assessment = self._ref_assess_cache[key]
        else:
            assessment = assess_reference_file(ref_audio, GPTSOVITS_POLICY)
            self._ref_assess_cache[key] = assessment

        if not assessment.valid:
            codes = "; ".join(f"[{e.code}] {e.message}" for e in assessment.errors)
            raise RuntimeError(f"참조 음성 부적합(GPT-SoVITS): {codes}")

        if assessment.warnings and key not in self._warned_refs:
            self._warned_refs.add(key)
            for w in assessment.warnings:
                emit("progress", percent=7, message=f"참조 경고 [{w.code}] {w.message}")

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        # 실제 모델/Whisper/브리지 로딩 전에 참조 판정(부적합이면 로딩 없이 실패)
        self._assess_ref(ref_audio)
        self.load()
        import subprocess, json, tempfile

        # 목표 텍스트 언어는 기존 방식(_detect_language)으로 판별.
        target_language = _detect_language(text)
        # 참조 프롬프트는 구조화된 전사 정책으로 결정.
        # 전사 성공 시 Whisper 언어를 그대로 쓰고 _detect_language(ref_text)로 재추정하지 않는다.
        # ref-free일 때만 프롬프트 언어 기본값으로 목표 텍스트 언어를 쓴다.
        prompt = self._get_ref_prompt(ref_audio, target_language)
        config = {
            "ref_audio": ref_audio,
            "text": text,
            "output_path": output_path,
            "language": target_language,
            "speed": speed,
            "prompt_text": prompt.prompt_text,
            "prompt_lang": prompt.prompt_language,
        }

        result = subprocess.run(
            [self._venv_python, "-X", "utf8", "-u", self._bridge_script],
            input=json.dumps(config, ensure_ascii=False),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=300  # 첫 모델 로딩 + CPU 폴백 대비
        )

        if result.returncode != 0:
            stderr = result.stderr[-500:] if result.stderr else ""
            raise RuntimeError(f"GPT-SoVITS 실패: {stderr}")

        # Parse output for errors
        for line in result.stdout.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                if msg.get("type") == "result":
                    # bridge 가 실제로 잡은 device 계보. 여기서 추측해 채우지 않는다.
                    self._last_device_info = {
                        k: msg.get(k) for k in
                        ("requested_device", "actual_device", "device_selection_source",
                         "fallback", "fallback_reason") if k in msg}
                if msg.get("type") == "error":
                    raise RuntimeError(msg.get("message", "Unknown error"))
                if msg.get("type") == "progress":
                    emit("progress", percent=msg.get("percent", 0), message=msg.get("message", ""))
            except json.JSONDecodeError:
                pass


# ── Qwen3-TTS engine (로컬 Base, 격리 venv, job bridge — 모델 1회 로딩, 완전 오프라인) ──
# GPT-SoVITS 엔진은 제거하지 않고 병존. 한국어 Auto 우선순위: Qwen3 → GPT-SoVITS → 폴백.
_QWEN_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
_QWEN_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"  # 공식 pinned Base
_QWEN_LANG_NAME = {"ko": "Korean", "en": "English", "zh": "Chinese", "ja": "Japanese"}
# 로컬 스냅샷(오프라인 preflight/추론 고정 위치). 런타임 자동 다운로드 금지.
_QWEN_HF_HOME = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "externals", "qwen3_tts_hf")
_QWEN_SNAPSHOT = os.path.join(_QWEN_HF_HOME, "hub",
                              "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base", "snapshots", _QWEN_REVISION)
_QWEN_REQUIRED = ["config.json", "model.safetensors", "vocab.json", "merges.txt",
                  "tokenizer_config.json", os.path.join("speech_tokenizer", "model.safetensors")]
# 무응답(진행 없음) 인용 timeout. Electron watchdog(무진행 5분)보다 짧게 잡아 Python이 먼저 정리·오류.
# ※ 이 값은 '생성 구간' 계약이다(계약 A 산정 근거가 이 280에 묶여 있다) — 절대 키우지 않는다.
# ── 작업 전체 벽시계 천장 ──────────────────────────────────────────────────────
# progress watchdog(무응답)·generation limit(생성량)과 **별개 축**이다. 둘 다 정상인데도
# 작업이 끝없이 길어지는 경우가 있다 — chunk 가 많고 각각은 정상 종료하는 장문이 그렇다.
# 사용자가 무한정 기다리지 않도록 작업 수락부터 terminal 까지 누적 시간에 절대 상한을 둔다.
MAX_JOB_WALL_TIME_SEC = 3600
JOB_WALL_TIME_EXCEEDED = "JOB_WALL_TIME_EXCEEDED"


class JobWallTimeExceeded(RuntimeError):
    """작업 전체 시간 천장 초과. partial 은 진단에만 남기고 정상 발행하지 않는다."""

    def __init__(self, elapsed_sec, limit_sec, completed_chunks=None):
        self.elapsed_sec = float(elapsed_sec)
        self.limit_sec = int(limit_sec)
        self.completed_chunks = completed_chunks
        super().__init__("작업 시간 %.0f초가 상한 %d초를 넘었습니다 — 결과를 발행하지 않습니다."
                         % (elapsed_sec, limit_sec))
        self.error_payload = {"code": JOB_WALL_TIME_EXCEEDED,
                              "elapsed_sec": round(float(elapsed_sec), 1),
                              "limit_sec": int(limit_sec),
                              "completed_chunks": completed_chunks}


class JobWallClock:
    """작업 수락 시각을 잡고 누적 경과를 판정한다. 시작 시각은 한 번만 정해진다.

    시간 소스를 주입받는다 — 모듈 전역 시계에 의존하면 호출부마다 다른 시계를 쓰게 되고
    테스트에서도 서로의 mock 을 밟는다.
    """

    def __init__(self, limit_sec=None, clock=None):
        import time as _time
        self._clock = clock or _time.monotonic
        self.limit_sec = int(MAX_JOB_WALL_TIME_SEC if limit_sec is None else limit_sec)
        self.started_at = self._clock()

    def elapsed(self):
        return self._clock() - self.started_at

    def exceeded(self):
        return self.elapsed() > self.limit_sec

    def check(self, completed_chunks=None):
        """초과면 예외. 초과가 아니면 경과를 돌려준다.

        시계는 **한 번만** 읽는다 — 두 번 읽으면 판정과 보고가 서로 다른 시각이 된다.
        """
        el = self.elapsed()
        if el > self.limit_sec:
            raise JobWallTimeExceeded(el, self.limit_sec, completed_chunks)
        return el


_QWEN_PROGRESS_PROBE_ROUNDS = 3     # 무응답 판정 전에 GPU 활동을 확인하는 연속 횟수


def _gpu_busy():
    """이 호스트의 GPU 가 실제로 일하고 있는가. 판정 불가면 True(=계속 기다린다).

    util 은 CPU 후처리·동기화·커널 사이 공백에서도 0 이 될 수 있으므로 util 하나로
    hang 을 단정하지 않는다. 메모리 사용까지 함께 보고, 조회 자체가 실패하면
    '모른다' 이므로 종료 근거로 쓰지 않는다.
    """
    try:
        import subprocess as _sp
        r = _sp.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=8)
        if r.returncode != 0:
            return True
        util, mem = [int(x.strip()) for x in r.stdout.strip().splitlines()[0].split(",")]
        return util > 0 or mem > 1500
    except Exception:
        return True


_QWEN_INACTIVITY_SEC = 280
# 진단 전용: 무응답 종료를 끈다. production 계약(280s)은 그대로이고 이 훅은
# 환경변수가 있을 때만 산다. 장문 단일 호출의 실제 능력을 재려면 시간 제한이
# 먼저 걸려서는 안 된다 — 다만 사용자가 직접 취소할 수 있어야 한다.
if os.environ.get("AUDIOFORGE_DIAG_NO_INACTIVITY_TIMEOUT") == "1":
    # None 이 아니라 큰 유한값을 쓴다 — 로딩 단계의 min(inactivity, remain) 산술이
    # None 에서 TypeError 로 죽기 때문이다. 24시간이면 사실상 제한 없음이고,
    # 사용자는 언제든 직접 취소할 수 있다.
    _QWEN_INACTIVITY_SEC = 86400

# 기동(모델 로딩) 전용 hard deadline. 무응답 timeout과 '다른 축'이다:
#   - 무응답 timeout: 마지막 stdout 이후 경과. heartbeat가 갱신한다.
#   - 기동 deadline : run_job 진입 이후 총 경과. heartbeat가 절대 연장하지 못한다.
# 로딩은 blocking 단일 호출이라 예전에는 stdout이 전혀 없어, '정상이지만 느린 콜드 로딩'과
# '멈춘 로딩'을 구분할 수 없었다. heartbeat가 생존을 증명하므로 무응답 timeout을 키우는 대신
# 별도의 유한한 기동 예산을 둔다 — heartbeat가 계속 와도 이 예산을 넘기면 종료한다.
_QWEN_STARTUP_DEADLINE_SEC = 600

# 로딩 heartbeat → Electron progress 변환 구간(percent).
# Electron watchdog(src/main/ipc/audio.ipc.ts WATCHDOG_MS=300000)은 'progress'에서만 리셋되므로,
# heartbeat를 progress로 옮기지 않으면 기동 deadline을 아무리 늘려도 300s에 Electron이 먼저 죽인다.
# 브리지가 로딩 완료 시 percent=25를 쓰므로 이 구간은 25 '미만'으로만 움직이고 되돌아가지 않는다.
_QWEN_LOAD_PCT_MIN = 12
_QWEN_LOAD_PCT_MAX = 24


def _kill_proc_tree(proc):
    import subprocess
    try:
        if os.name == "nt" and proc.pid:
            subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


class QwenLoadTimeoutError(RuntimeError):
    """모델 로딩이 기동 hard deadline을 초과(C1). heartbeat가 계속 도착해도 종료한다.

    보안: 정수/enum만 담는다 — 경로·전사·문장 금지.
    재시도 대상이 아니다: CUDA OOM이 아니므로 상위(_synthesize_qwen_job)의 CPU 1회 재시도
    분기에 걸리지 않고 그대로 전파된다(자동 재시도·자동 CPU 강등·모델 재다운로드 없음)."""

    def __init__(self, elapsed_sec, deadline_sec, heartbeats_seen, last_stage):
        self.elapsed_sec = elapsed_sec
        self.deadline_sec = deadline_sec
        self.heartbeats_seen = heartbeats_seen
        self.last_stage = last_stage
        self.error_payload = {
            "code": "QWEN_LOAD_TIMEOUT", "elapsed_sec": int(elapsed_sec),
            "deadline_sec": int(deadline_sec), "heartbeats_seen": int(heartbeats_seen),
            "last_stage": last_stage,
        }
        super().__init__(
            f"Qwen 모델 로딩이 기동 제한 {int(deadline_sec)}s를 초과했습니다"
            f"(경과 {int(elapsed_sec)}s, 생존 신호 {int(heartbeats_seen)}회) — 프로세스 종료")


class QwenGenerationLimitError(RuntimeError):
    """talker 생성이 동적 max_new_tokens 상한에 도달(계약 A). 잘린 결과는 정상으로 채택하지 않는다.
    보안: segment_index/generated_iterations/generation_limit(정수)만 담는다 — 전사·문장·경로 금지.
    감정 ID 매핑은 parsed를 아는 상위(_synthesize_qwen_job)에서 부여한다."""

    def __init__(self, segment_index, generated_iterations, generation_limit, emotion_id=None,
                 chunk_index=None):
        self.segment_index = segment_index
        self.generated_iterations = generated_iterations
        self.generation_limit = generation_limit
        self.emotion_id = emotion_id
        self.chunk_index = chunk_index
        super().__init__(
            f"GENERATION_LIMIT_EXCEEDED(seg={segment_index}, chunk={chunk_index}, "
            f"emotion={emotion_id}, iters={generated_iterations}, limit={generation_limit})")


class QwenIclBoundaryError(RuntimeError):
    """controlled-prefix 생성물에서 목표 대사 시작 경계를 확정하지 못했다(fail-closed).

    발생 지점은 **부모의 정렬 단계**(_align_icl_chunks)다 — bridge 는 더 이상 자르지 않으므로
    경계 판정을 하지 않는다. boundary_reason 은 prefix_alignment / icl_alignment 의 사유 코드.
    보안: segment/chunk index·emotion_id·경계 사유 코드만 — 전사·대사·경로 없음."""

    def __init__(self, segment_index, chunk_index, emotion_id, boundary_reason):
        self.segment_index = segment_index
        self.chunk_index = chunk_index
        self.emotion_id = emotion_id
        self.boundary_reason = boundary_reason
        # 진단 보존 폴더 '이름'(절대경로 아님). 보존에 실패했으면 None 으로 남는다.
        self.diagnostic_dir_name = None
        super().__init__(
            f"ICL_BOUNDARY_ALIGNMENT_FAILED(seg={segment_index}, chunk={chunk_index}, "
            f"emotion={emotion_id}, reason={boundary_reason})")


class QwenTextSegmentTooLongError(RuntimeError):
    """자동 분할로도 동적 상한 이내로 못 만든 줄(계약 B). 보안: segment_index/emotion_id/토큰 수만.
    감정 ID 매핑은 상위에서. 대사·전사·경로 미포함."""

    def __init__(self, segment_index, production_tokens, allowed, emotion_id=None):
        self.segment_index = segment_index
        self.production_tokens = production_tokens
        self.allowed = allowed
        self.emotion_id = emotion_id
        super().__init__(
            f"TEXT_SEGMENT_TOO_LONG(seg={segment_index}, emotion={emotion_id}, "
            f"tokens={production_tokens}, allowed={allowed})")


class QwenTTSEngine(TTSEngine):
    """Qwen3-TTS 로컬 Base — 격리 qwen3_tts_venv에서 job bridge로 실행(모델 1회 로딩, 전 문장 배치).
    per-segment가 아니라 run_job 배치. 완전 오프라인(local_files_only)."""
    name = "qwen3"
    supported_languages = ["ko", "ja", "zh", "en"]
    is_batch = True

    def __init__(self):
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        venv = os.path.join(base, "externals", "qwen3_tts_venv")
        self._venv_python = os.path.join(venv, "Scripts", "python.exe")
        self._bridge = os.path.join(base, "python", "qwen_bridge.py")
        # qwen_tts 패키지 설치 흔적(venv만 남고 패키지가 제거된 상태를 available로 오판하지 않게)
        self._qwen_pkg_dir = os.path.join(venv, "Lib", "site-packages", "qwen_tts")

    def available(self):
        """venv 존재만으로 True 금지 — qwen_tts 패키지 설치 흔적 + pinned revision 로컬 스냅샷의
        필수 모델 파일까지 preflight."""
        if not (os.path.exists(self._venv_python) and os.path.exists(self._bridge)):
            return False
        if not os.path.isdir(self._qwen_pkg_dir):  # venv만 남고 패키지 제거된 상태 배제
            return False
        if not os.path.isdir(_QWEN_SNAPSHOT):
            return False
        for f in _QWEN_REQUIRED:
            p = os.path.join(_QWEN_SNAPSHOT, f)
            try:
                if not (os.path.exists(p) and os.path.getsize(p) > 0):
                    return False
            except OSError:
                return False
        return True

    def synthesize_segment(self, text, ref_audio, emotion_id, speed, output_path):
        raise RuntimeError("QwenTTSEngine은 배치(run_job) 전용입니다. synthesize() 배치 경로를 사용하세요.")

    def run_job(self, segments, device, *, inactivity_sec=None, startup_deadline_sec=None,
                monotonic=None):
        """모델 1회 로딩 후 전 세그먼트 합성. Popen으로 stdout JSON을 실시간 읽어 즉시 progress emit.
        무응답 시 프로세스 종료·정리 후 명확한 오류. 오프라인(HF_HOME 고정 + bridge local_files_only).

        두 개의 독립된 시계(C1):
          - 비활성 timer(inactivity_sec, 기본 280): 마지막 stdout 라인 이후 경과. heartbeat가 갱신한다.
          - 기동 deadline(startup_deadline_sec, 기본 600): run_job 진입 이후 총 경과.
            stage=loaded 이전에만 적용되고 heartbeat로 절대 연장되지 않는다.
        stage=loaded 이후에는 기존 무응답 계약(280s)이 '그대로' 적용된다 — 생성 구간은 변경 없음.

        inactivity_sec/startup_deadline_sec/monotonic 은 keyword-only 테스트 주입점이다
        (production 호출부는 위치 인자 2개 그대로 — 기존 run_job stub들이 계속 유효하다)."""
        import subprocess
        import threading
        import queue
        import json as _json
        inactivity_sec = _QWEN_INACTIVITY_SEC if inactivity_sec is None else inactivity_sec
        startup_deadline_sec = (_QWEN_STARTUP_DEADLINE_SEC if startup_deadline_sec is None
                                else startup_deadline_sec)
        _now = monotonic or time.monotonic
        _t0 = _now()
        # 로컬 스냅샷 '경로'로 로드(repo id 아님) → 오프라인에서 HF API 호출 회피. 자동 다운로드 금지.
        cfg = {"model_path": _QWEN_SNAPSHOT, "device": device, "segments": segments}
        env = {**os.environ, "HF_HOME": _QWEN_HF_HOME, "HF_HUB_OFFLINE": "1",
               "TRANSFORMERS_OFFLINE": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        try:
            proc = subprocess.Popen(
                [self._venv_python, "-X", "utf8", "-u", self._bridge],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", env=env)
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"Qwen 브리지 실행 오류: {e}")

        stderr_tail = []

        def _read_err():
            try:
                for ln in proc.stderr:
                    stderr_tail.append(ln)
                    if len(stderr_tail) > 40:
                        stderr_tail.pop(0)
            except Exception:
                pass
        threading.Thread(target=_read_err, daemon=True).start()

        q = queue.Queue()

        def _read_out():
            try:
                for ln in proc.stdout:
                    q.put(ln)
            except Exception:
                pass
            q.put(None)
        threading.Thread(target=_read_out, daemon=True).start()

        try:
            proc.stdin.write(_json.dumps(cfg, ensure_ascii=False))
            proc.stdin.close()
        except Exception as e:
            _kill_proc_tree(proc)
            raise RuntimeError(f"Qwen 브리지 입력 전달 오류: {e}")

        seg_out = None
        err_msg = None
        gl_err = None   # GENERATION_LIMIT_EXCEEDED(구조화) — 감정 ID 매핑은 상위에서
        tsl_err = None  # TEXT_SEGMENT_TOO_LONG(구조화)
        loaded = False          # stage=loaded 관측 여부. True면 기동 deadline은 더 이상 적용되지 않는다.
        stage = "starting"      # 마지막 관측 stage(오류 payload용, 비민감 enum)
        hb = {"seen": 0, "pct": _QWEN_LOAD_PCT_MIN}  # heartbeat 수신 수 / 마지막 로딩 percent(단조 비감소)

        def _load_timeout():
            """기동 deadline 초과 — 자식 트리 종료 후 구조화 오류."""
            _kill_proc_tree(proc)
            return QwenLoadTimeoutError(_now() - _t0, startup_deadline_sec, hb["seen"], stage)

        _quiet_rounds = {"n": 0}

        def _no_response():
            """무응답 초과. 다만 **시간만으로 종료하지 않는다**.

            장문 단일 호출은 vendor blocking 구간에서 정상적으로 아무 메시지도 내지 않는다.
            그래서 여기서 GPU 활동을 먼저 본다 — 살아 있으면 '진행 확인 중' 으로 보고 계속
            기다리고, 연속 %d 회 활동이 없을 때만 hang 으로 판정한다. 프로세스가 이미
            죽었으면 그 자체가 실패 확정이므로 즉시 종료한다.
            """ % _QWEN_PROGRESS_PROBE_ROUNDS
            if proc.poll() is None and _gpu_busy():
                _quiet_rounds["n"] = 0
                emit("progress", percent=60,
                     message="합성 중... (긴 문장은 시간이 더 걸립니다)")
                return None                      # 계속 기다린다
            _quiet_rounds["n"] += 1
            if proc.poll() is None and _quiet_rounds["n"] < _QWEN_PROGRESS_PROBE_ROUNDS:
                return None
            _kill_proc_tree(proc)
            e = RuntimeError(f"Qwen 무응답 {inactivity_sec}s 초과 — 프로세스 종료")
            e.error_payload = {"code": "QWEN_NO_RESPONSE",
                               "inactivity_sec": int(inactivity_sec), "last_stage": stage}
            return e

        while True:
            if loaded:
                wait = inactivity_sec
            else:
                # heartbeat가 아무리 와도 이 남은 예산은 늘지 않는다(요구사항 7).
                remain = startup_deadline_sec - (_now() - _t0)
                if remain <= 0:
                    raise _load_timeout()
                wait = min(inactivity_sec, remain)
            try:
                line = q.get(timeout=wait)
            except queue.Empty:
                # wait가 기동 예산 잔량이라 짧았을 수 있다 — 어느 축이 터졌는지 명확히 구분한다.
                if not loaded and (_now() - _t0) >= startup_deadline_sec:
                    raise _load_timeout()
                _e = _no_response()
                if _e is not None:
                    raise _e
                continue                 # GPU 가 살아 있다 — 계속 기다린다
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = _json.loads(line)
            except _json.JSONDecodeError:
                continue
            t = msg.get("type")
            if t == "progress":
                emit("progress", percent=msg.get("percent", 0), message=msg.get("message", ""))  # 실시간
            elif t == "stage":
                st = msg.get("stage")
                if st in ("loading", "loaded", "generating"):
                    stage = st
                if st == "loaded":
                    loaded = True   # 이 시점부터 기동 deadline 해제, 무응답 280s 계약 그대로
                elif st == "loading" and int(msg.get("attempt") or 1) > 1:
                    # sdpa 실패 후 eager 재시도 = 두 번째 전체 로딩. 사용자에게 보이게 한다
                    # (한 번 느린 로딩과 재시도를 사후에 구분할 수 있어야 한다).
                    emit("progress", percent=hb["pct"],
                         message="모델 로딩 재시도 중... (attn=%s)" % (msg.get("attn"),))
            elif t == "heartbeat":
                hb["seen"] += 1
                # 비활성 timer만 갱신된다(q.get이 반환됐으므로 자동). 기동 deadline은 손대지 않는다.
                # Electron watchdog(progress에서만 리셋)을 살리기 위해 progress로 옮긴다.
                hb["pct"] = max(hb["pct"], min(_QWEN_LOAD_PCT_MAX, _QWEN_LOAD_PCT_MIN + hb["seen"]))
                emit("progress", percent=hb["pct"],
                     message="모델 로딩 중... (%d초 경과 — 첫 실행은 오래 걸릴 수 있습니다)"
                             % (int(_now() - _t0),))
            elif t == "error":
                code = msg.get("code")
                if code == "GENERATION_LIMIT_EXCEEDED":
                    gl_err = QwenGenerationLimitError(
                        msg.get("segment_index"), msg.get("generated_iterations"),
                        msg.get("generation_limit"), msg.get("emotion_id"), msg.get("chunk_index"))
                elif code == "TEXT_SEGMENT_TOO_LONG":
                    tsl_err = QwenTextSegmentTooLongError(
                        msg.get("segment_index"), msg.get("production_tokens"),
                        msg.get("allowed"), msg.get("emotion_id"))
                else:
                    err_msg = msg.get("message", "Qwen 오류")
            elif t == "result":
                seg_out = msg.get("segments")
        try:
            proc.wait(timeout=10)
        except Exception:
            _kill_proc_tree(proc)
        if tsl_err is not None:
            raise tsl_err  # 분할 불가 — 상위가 감정 ID로 재해석.
        if gl_err is not None:
            raise gl_err  # 상한 도달 — CPU 재시도(OOM 전용) 대상 아님. 상위가 감정 ID로 재해석.
        if err_msg:
            raise RuntimeError(f"Qwen 합성 오류: {err_msg}")
        if proc.returncode not in (0, None) and seg_out is None:
            raise RuntimeError(f"Qwen 실패(코드 {proc.returncode}): {''.join(stderr_tail)[-400:]}")
        if not seg_out:
            raise RuntimeError(f"Qwen 합성 결과 없음: {''.join(stderr_tail)[-300:]}")
        return self._validate_seg_out(seg_out, segments)

    @staticmethod
    def _validate_seg_out(seg_out, segments):
        """chunk 결과 검증(계약 B §2 + P0 보완):
        - status=ok·메타 필드 정합·original_segment_index 연속·chunk_index 0..cc-1 완전·chunk_count 일치.
        - 경로: 각 결과가 정확히 chunk_paths.chunk_out_path(원본 out_path, ci)와 realpath+normcase 동일
          (같은 디렉터리만으로 통과 금지; junction/symlink·상위경로 이탈·잘못된 basename·segment 교차 차단).
        - sr: 결과 metadata sr == 실제 WAV sr, 전 chunk 공통 sr, mono(1-D), non-empty, finite."""
        import soundfile as sf
        import numpy as np
        n = len(segments)
        if not segments:
            raise RuntimeError("검증할 세그먼트 없음")
        want_path = {s["index"]: s["out_path"] for s in segments}
        by_seg = {}    # osi -> {"cc":int, "chunks":{ci:entry}}
        common_sr = None
        for r in seg_out:
            if r.get("status") != "ok":
                raise RuntimeError(f"비정상 chunk status={r.get('status')} (seg {r.get('original_segment_index')})")
            osi = r.get("original_segment_index")
            ci = r.get("chunk_index")
            cc = r.get("chunk_count")
            if not (isinstance(osi, int) and isinstance(ci, int) and isinstance(cc, int) and cc >= 1
                    and 0 <= ci < cc):
                raise RuntimeError(f"chunk 메타 필드 이상: seg={osi} chunk={ci} count={cc}")
            if osi not in want_path:
                raise RuntimeError(f"알 수 없는 original_segment_index: {osi}")
            gp = r.get("out_path")
            expected = chunk_paths.chunk_out_path(want_path[osi], ci)
            if not gp or not os.path.exists(gp):
                raise RuntimeError(f"chunk 출력 없음: seg {osi} chunk {ci}")
            if not chunk_paths.same_real_path(gp, expected):
                raise RuntimeError(f"chunk 경로 불일치(결정적 규칙 위반/이탈): seg {osi} chunk {ci}")
            if os.path.getsize(gp) <= 0:
                raise RuntimeError(f"chunk 0바이트: seg {osi} chunk {ci}")
            meta_sr = r.get("sr")
            if not (isinstance(meta_sr, int) and meta_sr > 0):
                raise RuntimeError(f"chunk metadata sr 이상: seg {osi} chunk {ci}")
            d, sr = sf.read(gp, dtype="float32")
            if int(sr) != meta_sr:
                raise RuntimeError(f"chunk metadata sr({meta_sr}) != 실제 sr({sr}): seg {osi} chunk {ci}")
            if common_sr is None:
                common_sr = int(sr)
            elif int(sr) != common_sr:
                raise RuntimeError(f"chunk 간 sr 불일치: {common_sr} vs {sr} (seg {osi} chunk {ci})")
            d = np.asarray(d)
            if d.ndim != 1:
                raise RuntimeError(f"chunk가 mono(1-D)가 아님: seg {osi} chunk {ci} ndim={d.ndim}")
            if d.size == 0 or not np.all(np.isfinite(d)):
                raise RuntimeError(f"chunk 비유한/빈 오디오: seg {osi} chunk {ci}")
            grp = by_seg.setdefault(osi, {"cc": cc, "chunks": {}})
            if grp["cc"] != cc:
                raise RuntimeError(f"seg {osi} chunk_count 불일치: {grp['cc']} vs {cc}")
            if ci in grp["chunks"]:
                raise RuntimeError(f"seg {osi} chunk_index 중복: {ci}")
            grp["chunks"][ci] = r
        if set(by_seg.keys()) != set(range(n)):
            raise RuntimeError(f"원본 segment index 불연속: {sorted(by_seg)} vs 0..{n - 1}")
        for osi, grp in by_seg.items():
            if set(grp["chunks"].keys()) != set(range(grp["cc"])):
                raise RuntimeError(f"seg {osi} chunk_index 누락/역전: {sorted(grp['chunks'])} vs 0..{grp['cc'] - 1}")
        return seg_out


_qwen_engine = None


def _get_qwen_engine():
    global _qwen_engine
    if _qwen_engine is None:
        _qwen_engine = QwenTTSEngine()
    return _qwen_engine


# ── Engine registry ──

ENGINES = {
    "f5tts": F5TTSEngine,
    "kokoro": KokoroEngine,
    "gptsovits": GPTSoVITSEngine,
}

# 엔진 선택 계약(구조화 오류 코드). 명시 요청은 조용히 대체되지 않는다 — 자동(auto/None) 선택과 구분.
ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"          # 지목한 엔진을 쓸 수 없음(대체 금지, 실패로 종료)
ENGINE_NAME_INVALID = "ENGINE_NAME_INVALID"        # 알 수 없는 엔진 이름(기본 엔진으로 흘리지 않음)
# 배치형 Qwen('qwen3')은 ENGINES 레지스트리(문장별 엔진)에 없으므로 따로 합집합을 만든다.
_VALID_ENGINE_NAMES = frozenset(ENGINES) | {"qwen3"}

# Engine instances are cached so loaded models survive across segments —
# creating a new instance per sentence reloads the model every time.
_engine_cache = {}


def _get_engine(name):
    if name not in _engine_cache:
        _engine_cache[name] = ENGINES[name]()
    return _engine_cache[name]


def _detect_language(text):
    """Simple language detection from text."""
    korean = sum(1 for c in text if '\uac00' <= c <= '\ud7a3')
    japanese = sum(1 for c in text if '\u3040' <= c <= '\u30ff' or '\u31f0' <= c <= '\u31ff')
    chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    total = len(text.replace(' ', ''))
    if total == 0:
        return "en"
    if korean / max(total, 1) > 0.3:
        return "ko"
    if japanese / max(total, 1) > 0.3:
        return "ja"
    if chinese / max(total, 1) > 0.3:
        return "zh"
    return "en"


def _select_engine(text, preferred_engine=None):
    """Select best engine for the given text.
    Priority: user preference > GPT-SoVITS (ko/ja) > Kokoro (ja/zh) > F5-TTS (en)

    명시 요청이 문장별 레지스트리에 있으면 그것을 쓴다. 알 수 없는 이름은 '자동'으로 흘리지 않고
    검증 오류로 끊는다(조용한 기본 엔진 대체 금지). auto/None 만 언어 기반 자동 선택이다.
    """
    if preferred_engine and preferred_engine in ENGINES:
        return _get_engine(preferred_engine)
    if preferred_engine not in (None, "", "auto") and preferred_engine not in _VALID_ENGINE_NAMES:
        e = RuntimeError("알 수 없는 음성 엔진 이름입니다 — 지원되는 엔진을 선택하세요.")
        e.error_payload = {"code": ENGINE_NAME_INVALID}
        raise e

    lang = _detect_language(text)

    # Korean/Japanese → GPT-SoVITS (best quality), fallback to Kokoro
    if lang in ("ko", "ja"):
        try:
            engine = _get_engine("gptsovits")
            engine.load()  # Check if venv exists
            return engine
        except Exception:
            return _get_engine("kokoro")

    # Chinese → Kokoro
    if lang == "zh":
        return _get_engine("kokoro")

    # English → F5-TTS (voice cloning)
    return _get_engine("f5tts")


def _select_job_engine(text, preferred_engine=None):
    """작업 전체를 배치형 Qwen으로 라우팅할지 결정. 반환 'qwen3'(배치) 또는 None(문장별 기존 경로).
    한국어 Auto 우선순위: Qwen3 → (미설치 시) 기존 GPT-SoVITS→폴백 경로."""
    # 엔진명 검증 — 알 수 없는 값을 '자동'으로 흘려보내지 않는다. 사용자가 특정 엔진을 지목했는데
    # 오타/구값 때문에 조용히 다른 엔진이 쓰이면, 결과물만 보고는 무엇으로 합성됐는지 알 수 없다.
    if preferred_engine not in (None, "", "auto") and preferred_engine not in _VALID_ENGINE_NAMES:
        e = RuntimeError("알 수 없는 음성 엔진 이름입니다 — 지원되는 엔진을 선택하세요.")
        e.error_payload = {"code": ENGINE_NAME_INVALID}
        raise e

    qwen = _get_qwen_engine()
    if preferred_engine == "qwen3":
        if qwen.available():
            return "qwen3"
        # 명시적으로 Qwen 을 지목했는데 쓸 수 없다 → 다른 엔진(kokoro 등)·CPU 로 조용히 대체하지 않는다.
        # 대체하면 사용자는 '요청한 엔진으로 합성됐다'고 오해한다. 자동 선택(auto)과는 다른 계약이다.
        e = RuntimeError("Qwen 음성 엔진을 사용할 수 없습니다 — 런타임/모델 구성을 확인하세요.")
        e.error_payload = {"code": ENGINE_UNAVAILABLE, "requested_engine": "qwen3"}
        raise e
    if preferred_engine:  # 다른 엔진 명시 → 문장별 기존 경로
        return None
    if _detect_language(text) == "ko" and qwen.available():
        return "qwen3"
    return None


_qwen_ref_text_cache = {}
# 방어적 상한 — GPT 전사 캐시(_TRANSCRIPT_CACHE_MAX)와 동일 방식. 키는 (path,size,mtime)로
# 파일 변경 시 자동 무효화되지만, 서로 다른 파일이 누적되며 무한히 커지지 않도록 상한을 둔다.
_QWEN_REF_TEXT_CACHE_MAX = 128

# Qwen 전용 여유 VRAM 임계(MiB). 근거: 실측 peak(프로세스) ~2569MiB(CUDA 1문장 배치, torch.cuda
# max_memory_allocated) + 안전 여유(allocator 단편화·로딩 스파이크·다문장) → 4000MiB.
# conversation(gpu_policy DEFAULT 1500)과 분리해 작업별로 다르게 적용.
_QWEN_MIN_FREE_MB = 4000


# Qwen 참조 자동 전사에 쓰는 Whisper 모델 이름. GPT 경로와 같은 'small'을 써서 결과가 일치한다.
_QWEN_REF_TRANSCRIBE_MODEL = "small"

# 강등 사유 코드(C2). 앞 두 개는 reference_transcript의 issue code를 그대로 재사용한다.
#   TRANSCRIPTION_FAILED    전사 호출/파싱 자체가 실패
#   EMPTY_TRANSCRIPT        전사가 비었음
#   REF_FREE_USER           사용자가 명시적으로 ref-free 선택(실패 아님 — 의도된 강등)
#   TRANSCRIPT_UNAVAILABLE  status는 비-ok인데 error_code가 없는 경우의 보수적 기본값
REF_DEGRADE_TRANSCRIPT_UNAVAILABLE = "TRANSCRIPT_UNAVAILABLE"

# transcript_status 값: ok | empty | failed | manual | user_ref_free
# 수동 전사 정렬 검증 결과 캐시 — 같은 (참조 파일, 수동 문장)이면 감정마다 다시 전사하지 않는다.
_qwen_manual_verify_cache = {}

# 수동 프롬프트 검증 실패 사유 코드
REF_MANUAL_MISALIGNED = "REF_MANUAL_MISALIGNED"        # 오디오에 없는 말이 수동 전사에 있다(또는 반대)
REF_MANUAL_UNVERIFIABLE = "REF_MANUAL_UNVERIFIABLE"    # 전사 자체가 실패해 검증할 수 없다


# ── 참조 conditioning 모드(단일 권위 계약, 참조혼입 대응) ──
# renderer store → config(ttsReferenceConditioningMode) → separate.py → synthesize() 전 구간이
# 이 한 값을 그대로 나른다. **segment 단위 전환은 여전히 없다** — 한 번 정한 실행 모드는 그 job 의
# 전 segment 에 그대로 적용된다. 유일한 예외가 auto 이며, 그 전환도 job 을 통째로 다시 도는
# '작업 단위 1회'다(segment 중간에 모드가 갈리는 일은 어느 모드에서도 없다).
#   auto             : 자동(사용자 표시 기본 선택). high_quality_icl 로 **먼저 한 번** 시도하고,
#                      경계 정렬이 실패하면 그 ICL 결과를 **폐기**한 뒤 같은 작업 안에서
#                      safe_xvector 로 **정확히 1회** 전환해 결과를 만든다. 전환은 최대 1회이며
#                      safe 까지 실패하면 그대로 실패한다(반복 재시도 없음).
#                      정렬 실패분은 절대 발행하지 않으므로 '참조 대사가 섞인 결과'가 나갈 통로는
#                      auto 에서도 열리지 않는다 — 바뀌는 것은 "실패로 끝나는가"뿐이다.
#   safe_xvector     : 안전 음성 복제. 모든 segment 를 x_vector_only=True 로 강제하고 참조 전사
#                      (ref_text)를 vendor 호출에 전달하지 않는다 → 참조 대사 혼입(conditioning echo)이
#                      구조적으로 없다. 음색·감정은 다소 평탄할 수 있다(강등이 아니라 모드의 특성).
#   high_quality_icl : 참조 억양 반영(ICL) + controlled-prefix. 참조 전사를 목표 대사 앞에 붙여
#                      '의도적으로' 먼저 발화시킨다. 그 다음이 핵심인데, **파형만으로는 목표 대사
#                      시작을 특정할 수 없다** — 참조 발화 내부의 문장 간 무음이 진짜 경계보다 길 수
#                      있어 전역 탐색은 참조 안쪽을 목표 onset 으로 오검출한다(실측, prefix_alignment §D).
#                      그래서 부모가 ASR 로 목표 대사의 anchor 위치를 먼저 특정하고(_align_icl_chunks),
#                      그 좁은 창 안에서만 파형 경계 규칙을 적용해 앞을 잘라낸다. bridge 가 낸 raw 는
#                      중간 산출물이고, 이 정렬을 통과해야만 결과가 확정된다. 어느 신호든 어긋나면
#                      결과를 발행하지 않고 실패한다
#                      (ICL_BOUNDARY_ALIGNMENT_FAILED — 이 모드 단독으로는 safe 로 갈아타지 않는다.
#                       자동 전환을 원하면 auto 를 고른다).
REF_CONDITIONING_AUTO = "auto"
REF_CONDITIONING_SAFE_XVECTOR = "safe_xvector"
REF_CONDITIONING_HIGH_QUALITY_ICL = "high_quality_icl"
REF_CONDITIONING_MODES = (REF_CONDITIONING_AUTO, REF_CONDITIONING_SAFE_XVECTOR,
                          REF_CONDITIONING_HIGH_QUALITY_ICL)
INVALID_REFERENCE_CONDITIONING_MODE = "INVALID_REFERENCE_CONDITIONING_MODE"
# high_quality_icl 실패 사유(비민감 code). 전자는 경계 검출 실패, 후자는 붙일 참조 전사 자체가 없음.
ICL_BOUNDARY_ALIGNMENT_FAILED = "ICL_BOUNDARY_ALIGNMENT_FAILED"
ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE = "ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE"
# 두 실패 모두 같은 안내로 끝난다 — 지금 결과가 필요하면 안전 모드를 고르라는 것.
_ICL_SAFE_MODE_HINT = ("'안전 음성 복제' 모드를 선택하면 참조 대사 혼입 없이 바로 합성할 수 있습니다.")

# ── auto 의 전환 방아쇠(정확히 이 code 들만) ──────────────────────────────────
# **ICL 이라는 방식 자체가 성립하지 않은 경우**만 담는다: 경계를 확정하지 못했거나(정렬 실패),
# 애초에 붙일 참조 전사가 없었거나. 이때 safe_xvector 는 같은 입력으로 성공할 수 있는 다른 방식이다.
# 여기에 없는 실패(GENERATION_LIMIT_EXCEEDED / TEXT_SEGMENT_TOO_LONG / 참조 품질 게이트 / OOM /
# 취소 / INVALID_* 등)는 모드를 바꾼다고 해결되는 문제가 아니므로 **전환하지 않고 그대로 실패**한다
# — 방아쇠를 넓히면 "무엇을 고쳐야 하는지"가 사용자에게서 사라지고 시간만 두 배로 쓴다.
MISSING_OR_INVALID_VENDOR_CROP_RECORD = "MISSING_OR_INVALID_VENDOR_CROP_RECORD"
AUTO_FALLBACK_TRIGGER_CODES = (ICL_BOUNDARY_ALIGNMENT_FAILED,
                               ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE,
                               # vendor native ICL 경로의 발행 근거가 없거나 무효인 경우도
                               # auto 에서는 safe 로 **정확히 1회** 전환한다. 명시
                               # high_quality_icl 요청은 여기 해당하지 않고 fail-closed 다.
                               MISSING_OR_INVALID_VENDOR_CROP_RECORD)
# auto 전환 시 사용자에게 보여 주는 **유일한** 문구. 내부 code(ICL_BOUNDARY_ALIGNMENT_FAILED 등)는
# 여기 섞지 않는다 — code 는 metadata(reference_conditioning_failure_code)에만 남고 UI 의 접힌
# 상세 진단에서만 보인다.
REFERENCE_CONDITIONING_FALLBACK_NOTICE = "목소리 느낌을 더 살리는 데 실패해 안정 방식으로 만들었습니다."

# ── 모드의 '품질 특성'(강등과는 다른 축) ──────────────────────────────────────
# reference_conditioning_degraded 는 **'요청한 모드를 그대로 실행했는가'** 만 말한다(조용한 대체
# 여부). 그 값이 False 라고 해서 '품질 제약이 없다'는 뜻이 아니다 — safe_xvector 는 설계상
# 참조의 억양/감정을 옮기지 않는 **안전 모드**이고, 그건 실패가 아니라 그 모드의 특성이다.
# 두 사실이 한 필드에 뭉개지면 metadata 만 보고 "제약 없음"으로 오독된다. 그래서 특성은 별도
# 필드(reference_conditioning_constraints)에 비민감 enum 토큰으로 따로 적는다.
# UI 문구("참조 대사 섞임 없음 · 감정 표현은 다소 평탄할 수 있음")와 같은 사실을 가리킨다.
CONSTRAINT_PROSODY_NOT_TRANSFERRED = "reference_prosody_not_transferred"
CONSTRAINT_EMOTION_MAY_FLATTEN = "emotion_expression_may_flatten"
_REF_CONDITIONING_CONSTRAINTS = {
    # auto 는 '요청'이지 실행이 아니다 — 실제 제약은 어느 쪽으로 끝났느냐(effective)가 정한다.
    # 그래서 metadata 는 항상 effective 모드로 이 표를 조회한다(auto 로 조회할 일이 없어야 정상).
    REF_CONDITIONING_AUTO: (),
    REF_CONDITIONING_SAFE_XVECTOR: (CONSTRAINT_PROSODY_NOT_TRANSFERRED,
                                    CONSTRAINT_EMOTION_MAY_FLATTEN),
    REF_CONDITIONING_HIGH_QUALITY_ICL: (),
}


def reference_conditioning_constraints(mode):
    """그 모드가 **설계상** 갖는 품질 제약 토큰 목록(빈 목록 = 알려진 제약 없음).

    강등(degraded)과 구분하기 위한 별도 축이다 — 정상 실행이어도 제약은 있을 수 있다."""
    return list(_REF_CONDITIONING_CONSTRAINTS.get(mode, ()))


def _reference_conditioning_meta(requested, effective, *, icl_attempted, icl_published,
                                 auto_fallback, failure_code=None, attempts=1):
    """참조 conditioning 재현 metadata 한 벌(모든 키 상시 존재, 비민감).

    **결과가 확정된 뒤에** 부른다 — 무엇을 실행했는지 다 알고 나서 기록해야 requested/effective 가
    실제와 어긋나지 않는다(시도 전에 미리 쓰면 auto 전환이 기록에 반영되지 않는다).
    constraints 는 항상 **effective** 로 조회한다: 사용자가 auto 를 골랐어도 실제 제약은 어느
    쪽으로 끝났느냐가 정한다."""
    return {
        "reference_conditioning_mode_requested": requested,
        "reference_conditioning_mode_effective": effective,
        "reference_conditioning_degraded": bool(auto_fallback),
        "reference_conditioning_constraints": reference_conditioning_constraints(effective),
        "reference_conditioning_failure_code": failure_code,
        "reference_conditioning_icl_attempted": bool(icl_attempted),
        "reference_conditioning_icl_published": bool(icl_published),
        "reference_conditioning_auto_fallback": bool(auto_fallback),
        "reference_conditioning_attempts": int(attempts),
        # 사용자 표시 문구는 전환했을 때 하나뿐. 내부 code 는 여기 섞지 않는다.
        "reference_conditioning_notice": (REFERENCE_CONDITIONING_FALLBACK_NOTICE
                                          if auto_fallback else None),
    }


def resolve_reference_conditioning_mode(value):
    """config 경계의 단일 해석. 부재(None/'') = safe_xvector(안전 기본 — legacy 세션 포함).
    잘못된 값은 조용히 강등하지 않고 구조화 오류(code=INVALID_REFERENCE_CONDITIONING_MODE)로
    크게 실패한다(GENERATION_LIMIT_EXCEEDED 등 기존 오류 코드 관례와 동일한 error_payload 형태).
    payload 에는 원시값을 담지 않는다(타입 이름만) — 비민감 payload 규칙."""
    if value is None or value == "":
        return REF_CONDITIONING_SAFE_XVECTOR
    if value in REF_CONDITIONING_MODES:
        return value
    e = RuntimeError(
        "참조 사용 방식 설정이 올바르지 않습니다 — '자동(auto)', '안전 음성 복제(safe_xvector)', "
        "'참조 억양 반영(high_quality_icl)'만 선택할 수 있습니다.")
    e.error_payload = {"code": INVALID_REFERENCE_CONDITIONING_MODE,
                       "raw_type": type(value).__name__}
    raise e


class QwenReferenceMisalignedError(RuntimeError):
    """수동 참조 전사가 참조 오디오와 어긋남 — 생성 시작 전에 막는다(fail-closed).

    왜 경고가 아니라 차단인가: 이 불일치가 곧 참조 대사 혼입의 원인이고, 경고는 무시된다.
    실제로 2026-08-27 실행은 잘린 9.0초 클립에 원문 63자 전사를 manual 로 붙인 config 3개로
    돌았고, manual 이라는 이유로 정렬 검증을 건너뛴 채 통과했다."""

    def __init__(self, reason_code, insertions, deletions, substitutions,
                 ref_syllables, clip_syllables):
        self.reason_code = reason_code
        self.insertions = int(insertions)
        self.deletions = int(deletions)
        self.substitutions = int(substitutions)
        self.ref_syllables = int(ref_syllables)
        self.clip_syllables = int(clip_syllables)
        super().__init__(
            "참조 음성과 수동 전사가 맞지 않습니다("
            f"{reason_code}: 삽입 {self.insertions} / 삭제 {self.deletions}, "
            f"전사 {self.ref_syllables}음절 vs 참조 음성 {self.clip_syllables}음절). "
            "참조 구간을 문장이 끝나는 지점까지 넓히거나, 참조 음성에 실제로 들어 있는 부분만 "
            "전사에 남기세요.")


def _verify_manual_prompt_alignment(ref_audio, manual_text, emit_fn=None):
    """수동 전사를 자동 전사와 **같은 기준으로** 검증한다. 통과하면 지표 dict, 아니면 예외.

    자동 경로는 클립 자체를 전사해 쓰므로 정렬이 구조적으로 보장되지만, 수동 경로는 사용자가
    준 문장을 그대로 믿었다. 그 우회로가 이번 사고의 직접 통로였다.
    삽입·삭제(시간 정렬)만 차단하고 치환(인식기 편차)은 통과시킨다 — 원본·수정본·재현본
    세 클립 모두 클립 한가운데에서 같은 치환 2음절이 나왔고, 그것까지 막으면 정상 참조도 막힌다."""
    import hashlib
    import korean_cer as kc
    import reference_alignment as ra
    from reference_transcript import transcribe_reference, STATUS_OK

    try:
        st = os.stat(ref_audio)
        key = (os.path.abspath(ref_audio), st.st_size, st.st_mtime_ns,
               hashlib.sha256(manual_text.encode("utf-8")).hexdigest())
    except OSError:
        key = (os.path.abspath(ref_audio), None, None,
               hashlib.sha256(manual_text.encode("utf-8")).hexdigest())
    if key in _qwen_manual_verify_cache:
        return _qwen_manual_verify_cache[key]

    t = transcribe_reference(ref_audio, _QWEN_REF_TRANSCRIBE_MODEL)
    if t.status != STATUS_OK or not (t.text or "").strip():
        raise QwenReferenceMisalignedError(REF_MANUAL_UNVERIFIABLE, 0, 0, 0,
                                           len(kc.syllable_units(kc.normalize_text(manual_text))), 0)
    ref_units = kc.syllable_units(kc.normalize_text(manual_text))
    clip_units = kc.syllable_units(kc.normalize_text(t.text))
    v = ra.verify_clip_transcript(ref_units, clip_units, kc.edit_counts)
    if emit_fn:
        emit_fn("tts_reference_alignment", checked=True,
                insertions=v["insertions"], deletions=v["deletions"],
                substitutions=v["substitutions"], aligned=v["aligned"],
                ref_syllables=v["ref_syllables"], clip_syllables=v["clip_asr_syllables"],
                model=_QWEN_REF_TRANSCRIBE_MODEL)
    if not v["aligned"]:
        raise QwenReferenceMisalignedError(
            REF_MANUAL_MISALIGNED, v["insertions"], v["deletions"], v["substitutions"],
            v["ref_syllables"], v["clip_asr_syllables"])
    if len(_qwen_manual_verify_cache) < _QWEN_REF_TEXT_CACHE_MAX:
        _qwen_manual_verify_cache[key] = v
    return v


# transcript status
_REF_STATUS_MANUAL = "manual"
_REF_STATUS_USER_REF_FREE = "user_ref_free"


def _ref_record(emotion_id, prompt_source, degraded, reason_code, transcript_status, model):
    """참조 프롬프트 결정의 '비민감 요약' 1건.

    보안 불변식: 경로·전사 전문·예외 메시지는 절대 담지 않는다.
    특히 reference_transcript.transcribe_reference 는 error_message 에 str(e)[:300] 을 담는데,
    FileNotFoundError 등은 거기에 전체 경로가 들어간다 — 그래서 error_code 만 옮기고
    error_message 는 의도적으로 버린다."""
    return {"emotion_id": emotion_id, "prompt_source": prompt_source,
            "degraded": bool(degraded), "reason_code": reason_code,
            "transcript_status": transcript_status, "model": model}


def _resolve_qwen_ref_text(ref_audio, overrides_by_path, warned, degrade_sink=None,
                           emotion_id=None):
    """Qwen용 (ref_text, x_vector_only) 결정 — 수동/자동/ref-free 정책 재사용.
    수동·자동 전사가 비어있지 않으면 ICL(x_vector_only=False). 명시적 ref-free / 전사 실패 / 빈 전사는
    x-vector-only(True, ref_text 무시). Qwen 공식 구현은 ref_text=""+x_vector_only=False를 거부하므로 필수.

    C2: 예전에는 t.status 만 읽고 t.error_code 를 버려서, 전사가 실패해도 사용자에게는 스쳐 지나가는
    progress 한 줄뿐이었고 실행은 조용히 낮은 품질(x-vector-only)로 계속됐다. 이제 호출마다
    비민감 요약 1건을 degrade_sink 에 남기고, 강등일 때만 tts_reference_degraded 이벤트를 낸다.
    x-vector-only 자체는 그대로 유지된다 — 없애는 게 아니라 '보이게' 만드는 변경이다.

    반환 arity는 (ref_text, x_vector_only) 2-tuple 그대로다(기존 호출부·회귀 테스트 보존).
    degrade_sink/emotion_id 는 keyword 선택 인자다."""
    from reference_transcript import transcribe_reference, MODE_REF_FREE, STATUS_OK

    def _record(rec):
        if degrade_sink is not None:
            degrade_sink.append(rec)
        return rec

    def _announce(rec, ap):
        """강등일 때만, 참조 1개당 1회 구조화 이벤트. 경로·전사 없음."""
        if not rec["degraded"]:
            return
        if ("degraded", ap, rec["reason_code"]) in warned:
            return
        warned.add(("degraded", ap, rec["reason_code"]))
        emit("tts_reference_degraded", emotion_id=rec["emotion_id"],
             prompt_source=rec["prompt_source"], degraded_to="x_vector_only",
             reason_code=rec["reason_code"], transcript_status=rec["transcript_status"],
             model=rec["model"])

    ap = os.path.abspath(ref_audio)
    ov = (overrides_by_path or {}).get(ap)
    if ov:
        if ov.get("mode") == MODE_REF_FREE:
            rec = _record(_ref_record(emotion_id, "x-vector-only", True, "REF_FREE_USER",
                                      _REF_STATUS_USER_REF_FREE, ""))
            if ("reffree", ap) not in warned:
                warned.add(("reffree", ap))
                emit("progress", percent=7,
                     message="ref-free → Qwen x-vector-only로 강등(ICL 아님, 참조 전사 미사용)")
            _announce(rec, ap)
            return "", True
        manual = (ov.get("manual_text") or "").strip()
        if manual:
            # 수동도 자동과 같은 정렬 검증을 통과해야 한다. 실패하면 여기서 예외 →
            # 세그먼트를 만들기 전에 멈추므로 생성이 시작되지 않는다(fail-closed).
            _verify_manual_prompt_alignment(ref_audio, manual, emit_fn=emit)
            _record(_ref_record(emotion_id, "manual", False, None, _REF_STATUS_MANUAL, ""))
            if ("manual", ap) not in warned:
                warned.add(("manual", ap))
                emit("progress", percent=7, message=f"참조 전사(수동, ICL): {len(manual)}자")
            return manual, False
    try:
        st = os.stat(ref_audio)
        key = (ap, st.st_size, st.st_mtime_ns)
    except OSError:
        key = (ap, None, None)
    if key in _qwen_ref_text_cache:
        # 캐시 적중이어도 요약은 남긴다 — 같은 참조를 쓰는 다른 감정도 메타데이터에 집계돼야 한다.
        res, crec = _qwen_ref_text_cache[key]
        _record(dict(crec, emotion_id=emotion_id))
        return res
    t = transcribe_reference(ref_audio, _QWEN_REF_TRANSCRIBE_MODEL)
    if t.status == STATUS_OK and (t.text or "").strip():
        res = (t.text, False)
        rec = _ref_record(emotion_id, "auto", False, None, t.status, _QWEN_REF_TRANSCRIBE_MODEL)
        if ("auto", ap) not in warned:
            warned.add(("auto", ap))
            emit("progress", percent=9, message=f"참조 전사(자동, ICL): {t.language}, {len(t.text)}자")
    else:
        res = ("", True)
        # error_code 만 옮긴다(error_message 는 경로를 담을 수 있어 절대 옮기지 않는다).
        rec = _ref_record(emotion_id, "x-vector-only", True,
                          t.error_code or REF_DEGRADE_TRANSCRIPT_UNAVAILABLE,
                          t.status, _QWEN_REF_TRANSCRIBE_MODEL)
        if ("autofail", ap) not in warned:
            warned.add(("autofail", ap))
            emit("progress", percent=9,
                 message=f"참조 전사 실패/빈 결과({t.status}) → Qwen x-vector-only로 강등(ICL 아님)")
    _record(rec)
    _announce(rec, ap)
    if len(_qwen_ref_text_cache) < _QWEN_REF_TEXT_CACHE_MAX:  # 방어적 상한
        _qwen_ref_text_cache[key] = (res, rec)
    return res


def _summarize_ref_degradation(records, default_emotion_id):
    """참조 결정 요약 리스트 → 재현 메타데이터 5필드(비민감).
    default 참조의 상태를 대표값으로 쓰고, 강등된 감정 ID 목록을 따로 남긴다."""
    if not records:
        return {"reference_prompt_degraded": None, "reference_degrade_reason": None,
                "reference_transcript_status": None, "reference_transcript_model": None,
                "reference_degraded_emotions": None}
    degraded = [r for r in records if r["degraded"]]
    rep = None
    for r in records:
        if r["emotion_id"] == default_emotion_id:
            rep = r
            break
    if rep is None:
        rep = degraded[0] if degraded else records[0]
    emos = sorted({str(r["emotion_id"]) for r in degraded if r["emotion_id"] is not None})
    return {
        "reference_prompt_degraded": bool(degraded),
        "reference_degrade_reason": (rep["reason_code"] if rep["degraded"]
                                     else (degraded[0]["reason_code"] if degraded else None)),
        "reference_transcript_status": rep["transcript_status"],
        "reference_transcript_model": rep["model"],
        "reference_degraded_emotions": emos or None,
    }


def _atempo_segment(inp, speed):
    """세그먼트 raw wav에 ffmpeg atempo 적용(후처리). 실패를 조용히 raw로 넘기지 않고 명확한 예외.
    out 경로를 미리 계산하고, timeout/OSError/returncode 실패/0바이트에서는 ffmpeg가 만든 부분 출력을
    직접 삭제한 뒤 예외를 던진다(성공했을 때만 경로 반환). 부분 파일이 뒤에 남지 않게."""
    from audio_utils import find_ffmpeg
    import subprocess
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("속도 적용 실패 — ffmpeg 없음")
    out = inp.replace(".wav", f"_x{speed:.2f}.wav")  # 미리 계산

    def _rm_partial():
        try:
            if os.path.exists(out):
                os.remove(out)
        except OSError:
            pass

    try:
        proc = subprocess.run([ff, "-y", "-i", inp, "-filter:a", f"atempo={speed:.4f}", out],
                              capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:  # TimeoutExpired 포함
        _rm_partial()
        raise RuntimeError(f"속도 적용 중 오류: {e}")
    if proc.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        _rm_partial()  # ffmpeg가 부분 파일을 만들고 실패했을 수 있음
        raise RuntimeError(f"속도 적용 실패: {(proc.stderr or b'')[-200:]}")
    return out


def _positive_int_or_none(v):
    """양의 정수만 통과, 그 외는 None(= telemetry 규약상 'unavailable').
    거르는 값: None / bool / 비수치 / NaN / ±Inf / 0 / 음수. 0 같은 위조값을 절대 남기지 않는다.
    metadata는 합성을 깨뜨리지 않는다는 기존 원칙(frames 조건부 기록과 동일)에 따라 예외를 던지지 않는다."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v in (float("inf"), float("-inf")):   # NaN / ±Inf
        return None
    n = int(v)
    return n if n > 0 else None


def _positive_float_or_none(v):
    """양의 실수만 통과, 그 외는 None(= 'unavailable'). _positive_int_or_none 의 실수판.

    0 을 거르는 이유: 생성 구간은 monotonic 차이라 0.0 이 나오려면 시계 분해능 아래여야 하는데,
    그건 '측정 안 됨' 과 구분할 수 없다. 나눗셈에서 0 은 조용한 division-by-zero 원인이 되므로
    통과시키지 않는다. bool 은 int 의 서브클래스라 명시적으로 먼저 거른다."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v in (float("inf"), float("-inf")):   # NaN / ±Inf
        return None
    f = float(v)
    return f if f > 0.0 else None


_METADATA_KEYS = [
    "requested_engine", "actual_engine", "model_name", "model_revision", "device",
    "device_selection_source", "prompt_source", "x_vector_only_mode",
    "original_reference_path", "effective_reference_path", "reference_region",
    "reference_transcript_language", "reference_transcript_len", "reference_transcript_sha8",
    # C2 — 참조 프롬프트 강등 가시화. 사유 코드/상태/모델명만(경로·전사 전문·예외 메시지 없음).
    # x-vector-only 능력은 그대로 유지되고, '왜 그렇게 됐는지'만 기록에 남는다.
    "reference_prompt_degraded", "reference_degrade_reason", "reference_transcript_status",
    "reference_transcript_model", "reference_degraded_emotions",
    "target_language", "seed", "seed_supported", "speed", "speed_postprocessed", "silence_gap",
    "fallback", "fallback_reason", "elapsed_seconds", "output_sample_rate",
    # pitch 후처리(계약 §2.1) — pitch_method는 production에서 "rubberband" | None 둘뿐.
    "pitch_semitones", "pitch_method", "pitch_postprocessed",
    # 생성 안전장치(계약 A) — termination_reason 은 "completed_before_limit" | "generation_limit".
    # completed_before_limit 은 EOS 직접 관측이 아니라 '동적 상한 전 자연 반환'이라는 운영 상태.
    "generation_limit", "generated_iterations", "termination_reason",
    # 자동 분할(계약 B) 재현 배열 — 내용/경로/전사 없이 index·count·token·iter·사유·emotion_id만.
    "generation_chunks",
    # 공용 마감 I4 — 파서 plan 재현(비민감: 수치/해시8만, 대사 전문·전사·경로 없음). parsed_plan_sha8은 full sha256의 앞 8자.
    "parser_version", "parsed_plan_sha8", "segment_count", "chunk_count",
    "explicit_pause_count", "total_pause_ms",
    # 말끝 finishing 재현(계약 §2·추가4) + 감정 전환 경계 모드.
    "tail_mode", "tail_pad_ms", "tail_fade_ms", "tail_fade_applied", "emotion_boundary_mode",
    # 경계 envelope 재현 — 최종 조립물 **바깥쪽** 시작·끝에 실제로 적용한 샘플 수(길이는 불변).
    # offset 0 = tail auto 가 말끝 fade 를 가져갔거나 배열이 짧아 clamp 된 경우.
    "boundary_onset_samples", "boundary_offset_samples",
    # B envelope 1단계 — 조립 중 열린 **내부 segment 경계**에 건 envelope 재현.
    # onset/offset_count 는 실제로 샘플이 걸린 chunk 수, kind_counts 는 경계 종류별 횟수,
    # applied 는 경계마다 (앞 chunk 끝 / 뒤 chunk 시작) 좌표와 샘플 수. 대사·경로 없음.
    # 최종 파일 양 끝은 boundary_onset_samples/boundary_offset_samples 가 따로 말한다(중복 아님).
    "segment_envelope_onset_count", "segment_envelope_offset_count",
    "segment_envelope_kind_counts", "segment_envelope_applied",
    # macro gain drift 보정(연기·믹싱·공간 세 축 분리) — 조립 트랙 하나에 한 번 건 보정의 재현값.
    # reason 은 APPLIED / BELOW_GATE / TOO_SHORT / NO_ACTIVE_SPEECH / FULLY_PROTECTED / UNAVAILABLE.
    # curve_sha8 은 보정 곡선 수치 배열의 지문이다(대사·경로가 아니다).
    "macro_gain_applied", "macro_gain_reason", "macro_gain_statistic_db", "macro_gain_gate_db",
    "macro_gain_max_boost_db", "macro_gain_curve_sha8", "macro_gain_headroom_cap_db",
    "macro_gain_protected_span_count", "macro_gain_trend_window_sec",
    "macro_gain_level_window_sec",
    # 표현형 모드(계약 §10). ⚠️ 이웃이 snake_case 라도 이 키만은 camelCase 가 정본이다 —
    # session/config/metadata 세 캐리어가 '같은 필드 이름'이어야 하고, 계약이 별칭
    # (tts_expressive_mode)을 명시적으로 금지했다(권위가 둘이 되는 편이 더 나쁘다).
    "ttsExpressiveMode",
    # 참조 conditioning 모드(참조혼입 대응). requested=사용자 요청('auto' 포함), effective=실제로
    # 결과를 만든 모드. 두 값이 다를 수 있는 경우는 **auto 뿐**이다(auto→high_quality_icl 또는
    # auto→safe_xvector). safe_xvector·high_quality_icl 를 명시 요청했으면 두 값은 항상 같고,
    # 같지 않을 바에는 실행이 실패한다(조용한 대체 없음은 그대로다).
    # ★degraded 의 의미는 **'사용자가 기대한 품질 경로를 그대로 실행했는가'** 하나뿐이다 —
    # auto 가 ICL 실패로 safe 로 전환했을 때만 True 다. degraded=False 는 '품질 제약이 없다'는
    # 뜻이 **아니다**(모드가 설계상 갖는 제약은 reference_conditioning_constraints 가 말한다).
    # reference_alignment / reference_cut_sample 은 ICL 이 실제로 controlled-prefix 를
    # 잘라냈을 때만 값이 들어간다(샘플 인덱스·dB 만). safe_xvector 는 정렬·절단을 하지 않으므로 null.
    "reference_conditioning_mode_requested", "reference_conditioning_mode_effective",
    "reference_conditioning_degraded", "reference_alignment", "reference_cut_sample",
    # 전환을 부른 canonical code(ICL_BOUNDARY_ALIGNMENT_FAILED 등). 전환이 없었으면 null.
    # ⚠️ 이 code 는 기본 UI 에 띄우지 않는다 — 사용자 문구는 notice 하나뿐이고 code 는 상세 진단용.
    "reference_conditioning_failure_code",
    # 그 모드가 설계상 갖는 품질 제약(비민감 enum 토큰 목록). 빈 목록 = 알려진 제약 없음.
    "reference_conditioning_constraints",
    # ── auto(자동 모드) 재현 3필드 + 사용자 문구 ──
    # icl_attempted : ICL 시도를 실제로 걸었는가(safe 요청/ICL 단계가 없는 엔진이면 False).
    # icl_published : **ICL 로 만든 결과를 발행했는가**. 정렬 실패분은 폐기되므로 그때 False 다 —
    #                 "참조 대사가 섞였을 수 있는 결과가 나갔는가"를 사후에 판정하는 필드.
    # auto_fallback : ICL 실패로 safe_xvector 로 **자동 전환**했는가(전환은 작업당 최대 1회).
    # attempts      : 이 작업에서 실제로 돌린 합성 시도 횟수. auto 전환 시 2, 그 외 항상 1.
    #                 2 를 넘는 값이 나오면 그것 자체가 '반복 재시도 금지' 계약 위반의 증거다.
    # notice        : 사용자에게 보여 줄 단 하나의 문구(전환했을 때만, 그 외 null).
    "reference_conditioning_icl_attempted", "reference_conditioning_icl_published",
    "reference_conditioning_auto_fallback", "reference_conditioning_attempts",
    "reference_conditioning_notice",

    # GPT-SoVITS device 계보(bridge 보고값 그대로)
    "requested_device", "actual_device",
]


def _build_tts_metadata(**kw):
    """결과 재현 메타데이터의 고정 형태(모든 키 존재, JSON 직렬화 가능).
    보안: 참조 전사 '전문'은 절대 포함하지 않는다 — 언어/글자수/짧은 해시(source)만."""
    return {k: kw.get(k) for k in _METADATA_KEYS}


def _parse_device_source(reason):
    """select_device 사유 문자열에서 측정 출처(source=...)를 추출. 없으면 사유 자체를 요약."""
    if not reason:
        return None
    m = re.search(r"source=([\w.\-]+)", reason)
    if m:
        return m.group(1)
    if "측정 실패" in reason:
        return "nvidia-smi(측정실패→CPU)"
    return None


def _prompt_source_for(ref, overrides_by_path, xvo):
    """참조의 프롬프트 출처 라벨: x-vector-only / manual / auto."""
    if xvo:
        return "x-vector-only"
    ov = (overrides_by_path or {}).get(os.path.abspath(ref)) or {}
    if (ov.get("manual_text") or "").strip():
        return "manual"
    return "auto"


def _transcript_meta(ref_text):
    """전사문에서 GUI/세션용 비민감 요약만: (언어, 글자수, sha8). 전문은 반환하지 않는다."""
    t = (ref_text or "").strip()
    if not t:
        return None, 0, None
    import hashlib
    return _detect_language(t), len(t), hashlib.sha256(t.encode("utf-8")).hexdigest()[:8]


def _finish_and_place(candidate, final_path, pitch, work_dir, tail_cfg=None,
                      macro_protected_spans=None):
    """엔진 무관 공통 최종 단계 + 경계 envelope + 말끝 finishing
    (계약 §2 순서: … → 전체 pitch → 경계 envelope → 최종 조건부 fade → 최종 0 padding → 검증 → 원자 교체).

    여기가 **조립이 끝난 최종 배열을 보는 단 하나의 지점**이다. 단문이든 장문이든 이 함수는 결과물
    하나만 보므로, 경계 envelope 을 여기에 걸면 자동으로 "바깥쪽 시작·끝에만 한 번" 이 된다.
    내부 chunk 경계에는 걸리지 않는다(청크 결합은 _concat_with_boundaries 소관이고 거기는 무변경).

    - 경계 envelope: tail 설정과 **무관하게 항상** 적용된다. 사용자 청취로 확정된 결함(시작·끝이
      S자 없이 딱 켜지고 꺼짐)의 수정이라 옵션이 아니다. 길이·sr·cache key 를 바꾸지 않는다
      (gain 곱셈뿐, padding 없음). 적용 샘플 수는 반환 dict 에 담겨 metadata 로 나간다.
    - tail off/부재(기본) → tail 은 아무것도 하지 않는다(padding·fade 0). 경계 envelope 만 적용.
      길이·subtype·pitch 결과는 레거시와 같고, 달라지는 건 양 끝 gain 뿐이다.
    - tail 'auto'(명시 설정 시) → 기존대로 조건부 cosine fade + 0 padding 까지. 이때 말끝의 권위는
      tail 계약이 가지므로 경계 envelope 은 offset 을 0 으로 **양보**한다(이중 fade 금지).

    처리는 pitch를 work_dir 내부 staged로 배치(final 미접촉) → array로 읽어 audio_finishing 적용 →
    검증(mono·finite·non-empty·sr) → work_dir 내부 finished temp에 write → os.replace로 **이 함수만**
    최종 final_path를 원자 교체하는 순서다.

    무손상 계약: final_path는 모든 검증 통과 후 마지막 os.replace 한 번에만 바뀐다. 그 이전
    어떤 예외(pitch/검증/finishing)도 final_path(이전 합성 결과)를 건드리지 않는다. staged/finished temp는
    work_dir 안이라 정상/오류/취소(부모 정리) 모두에서 청소된다. pitch_shift.py·K2 취소 권위는 무변경.
    반환: place_final_with_pitch와 동형 dict(pitch_* + output_sample_rate + tail_* + boundary_*)."""
    import pitch_shift as _ps
    import audio_finishing as _af  # numpy 지연 로드(모듈 최상단 import 회피 — import tts_worker는 numpy 불요)

    import macro_gain as _mg   # numpy 지연 로드 — audio_finishing 과 같은 이유다

    tail = _af.parse_tail_config(tail_cfg)  # 범위 밖이면 INVALID_TTS_CONFIG(조용한 clamp 없음)

    # 원자 교체 전 모든 불변식(A/B/C)을 강제한다. 비유한은 **write 이전에** 차단하고, pending은
    # **write 후 재오픈**해 다시 검증한다. 어느 단계든 실패면 AudioFinishingError로 pending 삭제 + 기존
    # synthesized.wav 무손상(os.replace 미도달). 오류엔 경로/대사/전사를 담지 않는다.
    import os as _os
    import soundfile as _sf
    staged = _os.path.join(work_dir, ".af-staged.wav")
    finished_tmp = _os.path.join(work_dir, ".af-finished.wav")

    # 불변식 A(source) — pitch/write 이전에 **원본 후보 array**를 직접 검증한다. PCM 저장이 NaN/inf를
    # 유한값으로 바꾸기 전 단계는 없지만(파일에서 읽는 순간 이미 변환됨), FLOAT 후보의 비유한은 여기서
    # AudioFinishingError로 차단된다(pitch_shift의 PitchError보다 앞서 올바른 오류 타입·순서로).
    try:
        _src, _src_sr = _sf.read(candidate, dtype="float32")
    except _af.AudioFinishingError:
        raise
    except Exception as e:
        raise _af.AudioFinishingError("최종 후보 디코드 실패", code="AUDIO_INVALID") from e
    _af.require_valid_mono(_af.validate_audio_array(_src, _src_sr))

    pinfo = _ps.place_final_with_pitch(candidate, staged, pitch, work_dir)  # 실패→예외, final 무접촉
    try:
        # 불변식 A(staged) — pitch 후 staged를 다시 검증(pitch가 비유한을 만들지 않았는지).
        data, sr = _sf.read(staged, dtype="float32")
        _af.require_valid_mono(_af.validate_audio_array(data, sr))
        # 서브타입 패리티: pending은 staged(=레거시가 이 pitch로 이미 만든 결과)와 같은 subtype으로 쓴다.
        #   pitch 0 → staged=PCM_16 → pending PCM_16(== 레거시 off pitch0). pitch!=0 → staged=FLOAT →
        #   pending FLOAT(== 레거시 off pitch+1). FLOAT 하드코딩(비패리티) 금지. pitch_shift.py 무변경.
        staged_subtype = _sf.info(staged).subtype
        # tail plan 은 **envelope 적용 전 원본**으로 산출한다 — already_silent 판정(마지막 5ms peak)이
        # 우리 offset fade 때문에 뒤바뀌면 tail 계약의 의미가 달라진다. 순서: plan(원본) → envelope → tail.
        plan = _af.compute_tail_plan(data, sr, tail)
        # macro gain — **조립이 끝난 트랙 하나**에 한 번만 건다. chunk 별로 걸지 않는다.
        # 경계 envelope 보다 **먼저** 두어 바깥쪽 10 ms/20 ms fade 가 말끝의 마지막 권위로 남는다.
        # tail plan 은 위에서 이미 원본으로 산출했다 — boost 가 already_silent 판정을 뒤집지 않는다.
        mgplan = _mg.compute_macro_gain_plan(data, sr, protected_spans=macro_protected_spans)
        corrected = _mg.apply_macro_gain(data, sr, mgplan)
        if len(corrected) != len(data):
            raise _af.AudioFinishingError("macro gain 이 길이를 바꿨습니다", code="AUDIO_INVALID")
        # tail 이 실제로 cosine fade 를 걸 때만 말끝을 양보한다(이중 fade 방지). 시작 쪽은 겹칠 게 없다.
        bplan = _af.compute_boundary_plan(len(corrected), sr, tail_owns_offset=bool(plan.fade_applied))
        enveloped = _af.apply_boundary_envelope(corrected, sr, bplan)
        finished = _af.apply_final_tail(enveloped, sr, plan)
        # 불변식 B — in-memory: mono·non-empty·finite + 예상 프레임 수 + padding 정확히 0.
        # (여기서 finite가 이미 보장되므로 PCM_16으로 써도 비유한을 숨길 수 없다 — write 전 in-memory 검증.)
        # envelope 은 길이를 바꾸지 않으므로 기대 프레임 수의 기준은 여전히 len(data)다.
        _af.require_valid_finished(finished, sr, plan, len(data))
        try:
            _sf.write(finished_tmp, finished, sr, subtype=staged_subtype)
        except Exception as e:
            raise _af.AudioFinishingError("pending write 실패", code="AUDIO_INVALID") from e
        if not (_os.path.exists(finished_tmp) and _os.path.getsize(finished_tmp) > 0):
            raise _af.AudioFinishingError("pending 0바이트/미생성", code="AUDIO_INVALID")
        # 불변식 C — 파일 재오픈 검증: 디코드·메타 sr==실제 sr·mono·non-empty·finite·프레임 수·peak
        #   + subtype == staged subtype(패리티 보증).
        try:
            _rd, _rd_sr = _sf.read(finished_tmp, dtype="float32")
            _meta = _sf.info(finished_tmp)
        except Exception as e:
            raise _af.AudioFinishingError("pending 재오픈 실패", code="AUDIO_INVALID") from e
        _af.require_valid_reopened(_rd, _rd_sr, _meta.samplerate, _meta.frames, len(finished),
                                   actual_subtype=_meta.subtype, expected_subtype=staged_subtype)
        _os.replace(finished_tmp, final_path)  # 이 시점에만 final 교체(원자적)
    finally:
        for p in (staged, finished_tmp):
            if _os.path.exists(p):
                try:
                    _os.remove(p)
                except OSError:
                    pass
    out = dict(pinfo)
    out["output_sample_rate"] = int(sr)
    # I4 재현 메타: tail 적용값(계약 §2). off면 padding/fade 0. fade_applied는 실제 fade 수행 여부.
    if plan.mode == "auto":
        out.update(tail_mode="auto", tail_pad_ms=int(round(plan.pad_ms)),
                   tail_fade_ms=int(round(plan.fade_ms)), tail_fade_applied=bool(plan.fade_applied))
    else:
        out.update(tail_mode="off", tail_pad_ms=0, tail_fade_ms=0, tail_fade_applied=False)
    # 경계 envelope 재현 메타 — **실제로 적용한 샘플 수**(clamp 결과 포함). offset 0 은 tail 이 말끝을
    # 가져갔거나(offset_yielded_to_tail) 배열이 너무 짧아 clamp 된 경우다.
    out.update(boundary_onset_samples=int(bplan.onset_samples),
               boundary_offset_samples=int(bplan.offset_samples))
    # macro gain 재현 메타 — 적용 여부·통계·게이트·최대 boost·곡선 지문. 대사·경로 없음.
    out.update(_mg.plan_metadata(mgplan))
    return out


_ALIGNMENT_SUMMARY_KEYS = ("align_anchor_kind", "align_anchor_units", "align_stage",
                           # 어떤 anchor 로 경계를 잡았는가(TARGET_HEAD=목표 머리 / REFERENCE_TAIL=
                           # 참조 꼬리 보조 경로)와 머리 anchor 가 얼마나 맞았는가. 비민감 enum·수치.
                           "align_head_longest_units", "align_ref_tail_longest_units",
                           "sample_rate", "noise_floor_dbfs", "tail_end_sample", "valley_sample",
                           "onset_sample", "cut_sample", "valley_dbfs", "lead_samples",
                           # 창 한정 탐색이었다는 사실(전역 탐색이 아니었다는 증거). 수치만.
                           "window_start_sample", "window_end_sample", "anchor_start_sample",
                           # 창을 무엇으로 브래킷했고 anchor 와 얼마나 어긋났는가(수치만).
                           "prev_word_end_sample", "anchor_offset_samples",
                           # 어떤 신호로 개시를 인정했는가 — '유성음만 보고 자르지 않았다'는 증거.
                           "onset_dbfs", "onset_flux", "onset_zcr", "onset_hb_dbfs",
                           "onset_evidence", "onset_flux_threshold", "baseline_dbfs",
                           "quiet_frame_count",
                           # 최저 valley 가 최소 여백을 못 지켜 보조 후보로 잘랐는가(§B5-1).
                           "lead_fallback_applied", "lead_fallback_cut_sample")


# chunk 별 누적 요약에 담을 항목(전부 수치이거나 canonical 대문자 enum — 진단 필터를 통과한다).
# '앞에서 성공한 chunk 들이 어디를 어떻게 잘랐는가'를 실패 진단 안에 함께 남기기 위한 것이다.
_ICL_CHUNK_HISTORY_KEYS = ("align_anchor_kind", "align_stage", "tail_end_sample", "onset_sample",
                           "valley_sample", "cut_sample", "lead_samples",
                           "lead_fallback_applied", "lead_fallback_cut_sample")


def _icl_chunk_record(entry, source, reason_code, ok):
    """chunk 하나의 비민감 요약(수치·enum 만) — 전사 원문·대사·경로는 애초에 담지 않는다."""
    rec = {"segment_index": entry.get("original_segment_index"),
           "chunk_index": entry.get("chunk_index"),
           "ok": 1 if ok else 0,
           "reason_code": reason_code}
    for k in _ICL_CHUNK_HISTORY_KEYS:
        v = (source or {}).get(k)
        if v is not None:
            rec[k] = v
    return {k: v for k, v in rec.items() if v is not None}


def _icl_transcribe_fn():
    """controlled-prefix 정렬용 ASR 진입점 — **기존 경로 그대로 재사용**한다(새 패키지·새 모델 0).

    reference_transcript.py 와 같은 진입점(transcribe_worker._get_whisper_model / run_transcribe)
    이고 모델도 참조 자동 전사와 같은 _QWEN_REF_TRANSCRIBE_MODEL 이다. run_transcribe 는 이미
    word_timestamps=True 라 segments[*].words[*]{word,start,end} 를 준다 — 우리가 필요한 건 그것뿐이다.

    language=None(자동): chunk 에는 참조 전사와 목표 대사가 함께 들어 있어 한쪽 언어를 강제하면
    다른 쪽이 손해를 본다. 참조 전사 검증 경로(_verify_manual_prompt_alignment)도 None 을 쓴다.

    GPU 직렬화: 이 함수는 bridge subprocess 가 끝난 뒤에만 불린다 — Qwen 이 이미 내려간 뒤라
    whisper 와 동시 적재되지 않는다(별도 락 불필요)."""
    from transcribe_worker import _get_whisper_model, run_transcribe
    model = _get_whisper_model(_QWEN_REF_TRANSCRIBE_MODEL)
    return lambda path: run_transcribe(model, path, None)


def _align_icl_chunks(seg_out, transcribe_factory=_icl_transcribe_fn, output_dir=None):
    """controlled-prefix raw chunk 들을 정렬·절단해 **최종 chunk 로 확정**한다(부모 소유 단계).

    bridge 가 준 raw 는 중간 산출물이다 — 이 단계를 통과하기 전에는 어떤 결과도 확정되지 않는다.
    실패는 QwenIclBoundaryError(구조화) 로 올려 기존 계약(_synthesize_qwen_job 의 except)이 그대로
    사용자 오류를 만든다: 결과 미발행 + safe_xvector 로의 조용한 전환 없음 + 자동 재시도 없음.

    정렬 입력(alignment_request)은 여기서 소비하고 즉시 버린다 — 전사 원문이 metadata·세션·로그로
    새 나가지 않게 하는 유일한 소유 지점이다."""
    import icl_alignment
    todo = [e for e in seg_out if e.get("needs_alignment")]
    if not todo:
        for e in seg_out:      # 정렬 대상이 아니어도 텍스트는 남기지 않는다
            e.pop("alignment_request", None)
        return seg_out
    # global chunk index 를 여기서 못박는다. segment-local chunk_index 를 그대로 쓰면
    # segment 가 둘 이상일 때 0,1,2 / 0,1 이 겹쳐 raw·aligned 가 서로를 덮어쓴다
    # (실측으로 확인한 결함 — final 은 조립 순서라 global 이었고 둘이 어긋났다).
    for _g, _e in enumerate(seg_out):
        _e["global_chunk_index"] = _g
    todo.sort(key=lambda e: (e.get("original_segment_index"), e.get("chunk_index")))
    # 계측(opt-in). 비활성이면 recorder.active=False 라 아래 호출들이 즉시 반환한다 —
    # 배열 복사·SHA·무음 분석·폴더 생성이 하나도 일어나지 않는다.
    import chunk_publish
    global _CONCAT_RECORDER
    # 기록은 synthesize 입구에서 이미 열렸다 — 여기서 새로 만들면 legacy 경로에만 기록이 생긴다
    # (실측 결함: vendor native ICL 은 이 함수를 지나지 않아 번들이 통째로 비었다).
    _rec = _CONCAT_RECORDER if (_CONCAT_RECORDER is not None
                                and _CONCAT_RECORDER.active) else _diag_recorder()
    if _rec is not None and _rec.active:
        _CONCAT_RECORDER = _rec
    tf = transcribe_factory()
    total = len(todo)
    history = []   # 여기까지 처리한 chunk 의 비민감 요약(성공분 포함) — 실패 진단에 함께 남긴다
    for i, e in enumerate(todo):
        # 정렬 중에도 진행 표시가 계속 나간다(Electron watchdog 은 progress 로만 리셋된다).
        emit("progress", percent=90,
             message=f"참조 구간 경계 정렬 중... ({i + 1}/{total})")
        req = e.get("alignment_request") or {}
        if _rec is not None and _rec.active:
            _diag_stage(_rec, "raw", e)
        try:
            r = icl_alignment.align_and_trim(e["out_path"], req.get("prefix_text"),
                                             req.get("target_text"), tf)
        except icl_alignment.IclAlignmentFailed as af:
            # 실패하면 job_dir 이 통째로 사라진다 — 그 전에 raw 와 수치 진단을 진단 전용 폴더에
            # 남긴다(결과가 아니다: 발행하지 않고, 절대경로도 남기지 않는다).
            import icl_diagnostics
            # 실패한 chunk 도 같은 형식으로 이력에 넣는다 — 앞의 성공들과 한 줄에 놓고 봐야
            # '어디까지 되다가 무엇이 막혔는지'가 읽힌다.
            history.append(_icl_chunk_record(e, af.detection, af.reason_code, False))
            kept = icl_diagnostics.preserve_failure(
                output_dir, e.get("out_path"), af.reason_code, af.detection,
                e.get("original_segment_index"), e.get("chunk_index"), e.get("emotion_id"),
                chunk_history=history)
            err = QwenIclBoundaryError(e.get("original_segment_index"), e.get("chunk_index"),
                                       e.get("emotion_id"), af.reason_code)
            err.diagnostic_dir_name = kept
            raise err from None
        e["reference_alignment"] = r["summary"]
        e["reference_cut_sample"] = r["cut_sample"]
        e["needs_alignment"] = False
        if _rec is not None and _rec.active:
            _diag_stage(_rec, "aligned", e,
                        anchor_kind=(r["summary"] or {}).get("anchor_kind"),
                        reference_cut_sample=r.get("cut_sample"))
        history.append(_icl_chunk_record(e, r["summary"],
                                         icl_alignment.pa.REASON_BOUNDARY_OK, True))
    for e in seg_out:
        e.pop("alignment_request", None)   # 텍스트는 이 줄에서 사라진다(전 entry 일괄)
    return seg_out


VENDOR_CROP_SCHEMA = "af-vendor-internal-crop/2"
_VENDOR_CROP_REQUIRED = (
    "schema_version", "crop_contract_version", "model_revision", "sample_rate",
    "prefix_text_enabled", "x_vector_only_mode", "reference_audio_sha256",
    "reference_text_sha256", "target_script_sha256", "ref_code_frames",
    "generated_code_frames", "total_code_frames", "returned_samples",
    "returned_pcm_sha256", "crop_authority", "crop_coordinates_observed",
    "termination_reason", "external_alignment_calls")


def validate_vendor_crop_record(rec, wav_path):
    """vendor native ICL 발행 근거 검증. 통과하면 None, 실패하면 사유 문자열.

    ASR alignment record 와 **다른 권위**다. 값을 보정하지 않고 불일치면 실패시킨다.
    observed_crop_frame_delta 는 기록만 하고 특정 값을 정상으로 못박지 않는다."""
    import hashlib
    import numpy as _np
    import soundfile as _sf
    if not isinstance(rec, dict):
        return "record_not_dict"
    if rec.get("schema_version") != VENDOR_CROP_SCHEMA:
        return "schema_mismatch"
    for k in _VENDOR_CROP_REQUIRED:
        if rec.get(k) is None:
            return "missing_field:" + k
    if rec.get("prefix_text_enabled") is not False:
        return "prefix_text_enabled_must_be_false"
    if rec.get("x_vector_only_mode") is not False:
        return "x_vector_only_mode_must_be_false"
    if rec.get("termination_reason") != "completed_before_limit":
        return "termination_not_completed_before_limit"
    if int(rec["external_alignment_calls"]) != 0:   # 0 은 falsy — or 기본값 금지
        return "external_alignment_calls_not_zero"
    if rec.get("crop_authority") != "vendor_native_ref_code":
        return "crop_authority_mismatch"
    if rec.get("crop_coordinates_observed") is not False:
        return "crop_coordinates_observed_must_be_false"
    ref_f, gen_f = int(rec["ref_code_frames"]), int(rec["generated_code_frames"])
    tot_f, ret = int(rec["total_code_frames"]), int(rec["returned_samples"])
    if ref_f <= 0 or gen_f <= 0 or tot_f != ref_f + gen_f:
        return "frame_invariant_failed"
    if ret <= 0:
        return "returned_samples_not_positive"
    try:
        arr, sr = _sf.read(wav_path, dtype="float32")
    except Exception:
        return "wav_unreadable"
    if getattr(arr, "ndim", 1) > 1:
        arr = arr.mean(axis=1)
    if int(sr) != int(rec["sample_rate"]):
        return "sample_rate_mismatch"
    if int(arr.shape[0]) != ret:
        return "returned_samples_length_mismatch"
    if int(arr.shape[0]) == 0:
        return "empty_waveform"
    if not bool(_np.all(_np.isfinite(arr))):
        return "nan_or_inf"
    if int(_np.sum(_np.abs(arr) >= 0.999)) > 0:
        return "clipping"
    try:
        if hashlib.sha256(open(wav_path, "rb").read()).hexdigest() != rec["returned_pcm_sha256"]:
            return "pcm_sha_mismatch"
    except Exception:
        return "wav_unreadable"
    return None


def _summarize_reference_alignment(ordered_entries):
    """controlled-prefix 절단 사실을 metadata 용으로 축약한다(샘플 인덱스와 dB 만).

    chunk 마다 자기 경계를 검출하므로 값이 여러 개다. 대표값(첫 chunk)과 전체 범위·합계를 함께
    남겨 '어디를 얼마나 잘랐는가'가 사후에 확인 가능하게 한다.
    반환: (alignment_dict, representative_cut_sample).
    ICL 인데 어떤 chunk 라도 절단 기록이 없으면 — 즉 잘렸는지 확인할 수 없으면 — 조용히 통과시키지
    않고 RuntimeError(구조화 code)로 실패한다(fail-closed)."""
    firsts = None
    cuts = []
    kinds = []
    for e in ordered_entries:
        rec = e.get("reference_alignment")
        cut = e.get("reference_cut_sample")
        vrec = e.get("vendor_crop_record")
        has_asr = isinstance(rec, dict) and isinstance(cut, int) and cut > 0
        has_vendor = isinstance(vrec, dict)
        if has_asr and has_vendor:
            # 두 권위가 동시에 있으면 이중 절단 경로다. 조용히 하나를 고르지 않는다.
            _e = RuntimeError(
                "참조 절단 기록이 두 종류로 동시에 존재합니다 — 어느 경로로 잘렸는지 확정할 수 "
                "없는 결과는 발행하지 않습니다. " + _ICL_SAFE_MODE_HINT)
            _e.error_payload = {"code": ICL_BOUNDARY_ALIGNMENT_FAILED,
                                "segment_index": e.get("original_segment_index"),
                                "chunk_index": e.get("chunk_index"),
                                "emotion_id": e.get("emotion_id"),
                                "boundary_reason": "DUAL_CROP_RECORD"}
            raise _e
        if has_vendor:
            _why = validate_vendor_crop_record(vrec, e.get("out_path"))
            if _why:
                _e = RuntimeError(
                    "vendor 참조 절단 기록이 유효하지 않습니다 — 검증되지 않은 결과는 발행하지 "
                    "않습니다. " + _ICL_SAFE_MODE_HINT)
                _e.error_payload = {"code": MISSING_OR_INVALID_VENDOR_CROP_RECORD,
                                    "segment_index": e.get("original_segment_index"),
                                    "chunk_index": e.get("chunk_index"),
                                    "emotion_id": e.get("emotion_id"),
                                    "boundary_reason": _why}
                raise _e
            continue          # vendor 권위로 통과 — ASR 요약에는 넣지 않는다
        if not has_asr:
            _e = RuntimeError(
                "참조 억양 반영 모드인데 참조 구간 절단 기록이 없습니다 — 잘렸는지 확인할 수 없는 "
                "결과는 발행하지 않습니다. " + _ICL_SAFE_MODE_HINT)
            _e.error_payload = {"code": ICL_BOUNDARY_ALIGNMENT_FAILED,
                                "segment_index": e.get("original_segment_index"),
                                "chunk_index": e.get("chunk_index"),
                                "emotion_id": e.get("emotion_id"),
                                "boundary_reason": "MISSING_ALIGNMENT_RECORD"}
            raise _e
        cuts.append(cut)
        kinds.append(rec.get("align_anchor_kind"))
        if firsts is None:
            firsts = {k: rec.get(k) for k in _ALIGNMENT_SUMMARY_KEYS}
    if firsts is None:
        return None, None
    # chunk 별 절단 지점과 anchor 종류를 순서대로 남긴다(대표값 first 만으로는 '어떤 chunk 가
    # 보조 경로로 풀렸는가'를 사후에 알 수 없다). 값은 샘플 인덱스와 비민감 enum 뿐이다.
    return ({"chunk_count": len(cuts), "first": firsts,
             "cut_samples": list(cuts), "anchor_kinds": list(kinds),
             "cut_sample_min": min(cuts), "cut_sample_max": max(cuts),
             "trimmed_samples_total": sum(cuts)}, cuts[0])


def _synthesize_qwen_job(parsed, ref_cache, overrides_by_path, output_dir, speed, silence_gap,
                         pitch=0.0, tail_cfg=None, boundary_gaps=None, boundary_kinds=None,
                         reference_conditioning_mode=None, ref_table=None,
                         speaker_labels=None):
    """Qwen 배치 합성 — 2B 품질 게이트 재사용, Qwen 전용 VRAM 임계로 장치 선택(ComfyUI 병행 안전),
    모델 1회 로딩. speed: chunk별 atempo 후 결합(1.0은 raw). 임시파일 finally 정리.
    ⚠️ **결합 무음은 원 segment 경계에만 들어간다.** 한 문장이 자동분할된 내부 chunk 경계의 gap은
      언제나 0.0이다(§5 불변, 아래 gaps 루프가 그 규칙의 단일 소스). '문장 안에서도 chunk마다
      silence_gap만큼 무음이 들어간다'는 해석은 사실이 아니다 — 실측(생성물 결합 layout)에서도
      gap_before_samples가 0이 아닌 자리는 원 segment 경계뿐이었다.
    boundary_kinds: segment i '앞' 경계의 의미 종류 목록(_boundary_gaps_from_plan 3번째 반환값).
      gap 초와 **같은 경계**를 가리키는 짝이며, B envelope 1단계가 '어느 경계에 fade 를 열지'를
      이 값만으로 판정한다(텍스트 재파싱·문장부호 규칙 없음). None 이면 envelope 적용 0.
    pitch: 결합본(pending)에 rubberband 음높이 후처리(0=무후처리, 계약 §6·§7). 실패는 os.replace 직전
    예외 → finally가 job_dir 정리 → 기존 synthesized.wav 무손상.
    reference_conditioning_mode: 참조 conditioning 모드. safe_xvector 면 전 segment 를
      x_vector_only=True 로 강제하고 참조 전사를 vendor 에 전달하지 않는다(_resolve_qwen_ref_text 를
      아예 타지 않는 상위 게이트 — Whisper 호출 0). high_quality_icl 이면 segment 마다 참조 전사를
      결정해 ICL 조건으로 넘기고, 동시에 그 전사를 prefix_text 로 실어 controlled-prefix 로 생성한다.
      bridge 는 자르지 않고 raw 를 돌려주며, run_job 반환 뒤 _align_icl_chunks 가 ASR 정렬 → 창 한정
      경계 검출 → 절단까지 마쳐야 chunk 가 확정된다. 모드는 job 단위 고정이다.
      ⚠️ **여기에는 'auto' 가 오지 않는다** — auto 의 해석(ICL 시도 → 실패 시 safe 1회 전환)은 호출부
      (synthesize)가 소유하고, 이 함수는 언제나 '실행할 구체 모드' 하나만 받는다. 구체값이 아닌 값이
      들어오면 아래에서 즉시 실패한다(모르는 모드를 조용히 ICL 처럼 도는 통로를 막는다).
    반환: (final_path, info) — info는 재현 메타데이터의 런타임 사실(device/source/prompt_source/전사요약 등)."""
    import time
    from reference_audio import assess_reference_file, GPTSOVITS_POLICY
    from gpu_policy import select_device, is_cuda_oom
    qwen = _get_qwen_engine()
    t_start = time.monotonic()

    dev, reason = select_device("auto", min_free_mb=_QWEN_MIN_FREE_MB)
    device = "cuda:0" if dev == "cuda" else "cpu"
    device_source = _parse_device_source(reason)
    if device == "cpu":
        emit("progress", percent=6, message=f"Qwen 장치: CPU ({reason}) — 문장당 ~30초로 느릴 수 있음")
    else:
        emit("progress", percent=6, message=f"Qwen 장치: {device} ({reason})")

    # 참조 품질 게이트(기본 + 감정별) — 모델 로딩 전 실패. 고유 경로 1회 검사하되 어떤 참조인지 명시.
    # 10초 초과(TOO_LONG)는 감정 ID·파일명과 함께 '구간 선택 필요'를 안내. 원본을 모델 참조로 직접
    # 넘기지 않으므로(override가 정석) 긴 원본/긴 감정참조는 여기서 차단되고 run_job(모델 로딩)에 도달하지 않는다.
    seen_refs = set()
    for emo_id, ref in ref_cache.items():
        if ref in seen_refs:
            continue
        seen_refs.add(ref)
        a = assess_reference_file(ref, GPTSOVITS_POLICY)
        if a.valid:
            continue
        base = os.path.basename(ref)
        who = "기본 참조" if emo_id == "default" else f"감정 '{emo_id}' 참조"
        if any(e.code == "TOO_LONG" for e in a.errors):
            raise RuntimeError(f"{who}({base})가 10초를 초과합니다 — 3~10초 구간을 선택·확정한 뒤 합성하세요.")
        codes = "; ".join(f"[{e.code}] {e.message}" for e in a.errors)
        raise RuntimeError(f"참조 음성 부적합(Qwen): {who} {base} — {codes}")

    import tempfile
    import shutil
    # 실행별 전용 임시 폴더 — 모든 중간 산출물(segment/atempo/pending)을 이 안에만 둔다.
    # output_dir 내부에 두어 최종 os.replace가 동일 파일시스템 이동(원자적)이 되게 한다.
    # 정상/오류 경로는 finally가 폴더 전체를 삭제하고, 취소(taskkill /T /F로 finally 미실행) 경로는
    # Electron 부모가 자식 종료 확인 후 output_dir의 .qwen-job-* 를 삭제한다.
    job_dir = tempfile.mkdtemp(prefix=".qwen-job-", dir=output_dir)
    final_path = os.path.join(output_dir, "synthesized.wav")
    pending_path = os.path.join(job_dir, "pending.wav")
    default_ref = ref_cache["default"]
    if ref_table is None:
        # 표가 없으면 오늘까지의 규칙(감정 → 기본)만 있는 표를 세운다. 화자 없는 호출
        # (구 경로·테스트)에서 동작이 달라지지 않게 하기 위한 것이고, 화자가 있으면
        # 호출부가 반드시 표를 넘긴다.
        ref_table = _sr.ReferenceTable(
            default_ref=default_ref,
            emotion_refs={k: v for k, v in ref_cache.items() if k != "default"})
    reference_rows = []
    def_source = None
    def_xvo = None
    def_tr_lang = def_tr_len = def_tr_sha = None
    lang_codes = []
    fallback = False
    fallback_reason = None
    actual_device = device
    try:
        warned = set()
        segments = []
        degrade_records = []     # 참조 프롬프트 결정 요약(C2) — 비민감, 세그먼트 수만큼 유계
        def_emotion_id = None    # 기본 참조를 쓰는 첫 감정 ID(요약의 대표값 선택용)
        safe_mode = reference_conditioning_mode == REF_CONDITIONING_SAFE_XVECTOR
        icl_mode = reference_conditioning_mode == REF_CONDITIONING_HIGH_QUALITY_ICL
        if reference_conditioning_mode is not None and not (safe_mode or icl_mode):
            # 값이 있는데 구체 모드가 아니면(auto 나 오타) 조용히 ICL 처럼 돌지 않는다.
            # auto 의 해석은 synthesize 소유이므로 여기까지 내려오면 배선이 깨진 것이다.
            # (None 은 이 함수를 직접 부르는 구 호출부/단위테스트의 legacy 경로라 건드리지 않는다 —
            #  production 은 synthesize 가 언제나 해석된 구체값을 넘긴다.)
            _e = RuntimeError("참조 사용 방식이 확정되지 않은 채 합성에 진입했습니다.")
            _e.error_payload = {"code": INVALID_REFERENCE_CONDITIONING_MODE,
                                "raw_type": type(reference_conditioning_mode).__name__}
            raise _e
        if safe_mode:
            # 안전 모드 사실을 로그에 1회 명시(조용한 모드 아님 — 사용자가 어떤 조건으로 합성됐는지 안다).
            emit("progress", percent=5,
                 message="안전 음성 복제 모드 — 참조 대사(전사)는 합성 조건으로 전달되지 않습니다")
        elif icl_mode:
            emit("progress", percent=5,
                 message="참조 억양 반영 모드 — 참조 대사를 먼저 생성한 뒤 경계를 찾아 잘라냅니다"
                         "(생성 길이가 늘어 처리 시간이 더 걸립니다)")
        # OVERTEST 진단 전용: parser 가 빈 줄로 나눈 문단을 **호출 단위로만** 하나로 합친다.
        # 글자·문장부호·문단 순서를 바꾸지 않고 줄바꿈으로 이어 붙인다(원문 보존).
        # 감정 태그가 서로 다르면 합치지 않는다 — 생성 조건이 달라지기 때문이다.
        if os.environ.get("AUDIOFORGE_DIAG_MERGE_SEGMENTS") == "1":
            _eids = {e for e, _t, _sp in parsed}
            if len(_eids) > 1:
                raise RuntimeError(
                    "DIAG_MERGE_REFUSED: 감정 태그가 %d 종류라 합치면 조건이 달라진다" % len(_eids))
            # 화자가 다르면 더더욱 합칠 수 없다 — 목소리가 달라진다.
            _spks = {sp for _e, _t, sp in parsed}
            if len(_spks) > 1:
                raise RuntimeError(
                    "DIAG_MERGE_REFUSED: 화자가 %d 명이라 합치면 목소리가 달라진다" % len(_spks))
            _merged = chr(10).join(t for _e, t, _sp in parsed)
            parsed = [(parsed[0][0], _merged, parsed[0][2])]
            emit("stage", stage="diagnostic_merge_segments", segments=1, chars=len(_merged))
        for i, (emotion_id, line_text, speaker_id) in enumerate(parsed):
            # 참조는 표 하나가 정한다(speaker_refs.ReferenceTable). 여기서 폴백 규칙을
            # 다시 쓰지 않는다 — 조용한 대체가 생기는 자리가 정확히 여기였다.
            # 감정 프로필 선택까지 포함한 조회. 프로필이 없으면 resolve() 와 같은 답이다.
            # 얼린 스냅샷이 이 parsed 와 맞으면 그것을 읽는다(재조회 없음). 진단 병합 등으로 발화 수가
            # 달라졌을 때만 표에 다시 묻는다 — 그 경우도 규칙은 같은 표가 정한다.
            _frozen = getattr(ref_table, "routing", None)
            _rr_row = (dict(_frozen[i]) if _frozen is not None and len(_frozen) == len(parsed)
                       else ref_table.resolve_with_emotion(speaker_id, emotion_id))
            ref = _rr_row["path"]
            reference_rows.append(dict(_rr_row, segment_index=i))
            prefix_text = None
            if safe_mode:
                # 상위 게이트: 전사 기반 ICL 결정(_resolve_qwen_ref_text)을 아예 타지 않는다.
                # 수동 전사(ttsReferencePrompts)는 라이브러리 표시·검증용으로 보존될 뿐 합성 조건으로는
                # 전달 0(ref_text=""), Whisper 호출 0, 정렬 검증 호출 0. job 내 전 세그먼트 고정 —
                # 어떤 segment 도 ICL 로 되돌아가지 않는다(자동 fallback 금지).
                ref_text, xvo = "", True
            else:
                ref_text, xvo = _resolve_qwen_ref_text(ref, overrides_by_path, warned,
                                                       degrade_sink=degrade_records,
                                                       emotion_id=emotion_id)
                if icl_mode:
                    # 참조 억양 반영은 '참조 전사'가 있어야 성립한다. 전사가 없거나(실패/빈 전사)
                    # 사용자가 ref-free 를 골라 x-vector 로 떨어졌다면, 조용히 안전 모드처럼 돌지 않고
                    # 여기서 명시적으로 실패한다(요청한 모드와 다른 결과를 무신호로 주지 않는다).
                    if xvo or not (ref_text or "").strip():
                        _e = RuntimeError(
                            "참조 억양 반영 모드는 참조 음성의 대사(전사)가 필요합니다 — 참조 전사를 "
                            "직접 입력하거나, 자동 전사가 가능한 참조 구간을 선택하세요. " + _ICL_SAFE_MODE_HINT)
                        _e.error_payload = {"code": ICL_REFERENCE_TRANSCRIPT_UNAVAILABLE,
                                            "segment_index": i, "emotion_id": emotion_id}
                        raise _e
                    prefix_text = ref_text
            lang_code = _detect_language(line_text)  # 세그먼트별 언어
            lang_codes.append(lang_code)
            lang_name = _QWEN_LANG_NAME.get(lang_code)
            if not lang_name:
                raise RuntimeError(f"Qwen 미지원 언어(감지 {lang_code}) — 문장: {line_text[:20]}")
            if ref == default_ref and def_source is None:  # 기본 참조의 메타(전문 아닌 요약)
                def_emotion_id = emotion_id
                def_xvo = bool(xvo)
                def_source = _prompt_source_for(ref, overrides_by_path, xvo)
                def_tr_lang, def_tr_len, def_tr_sha = _transcript_meta(ref_text)
            out_path = os.path.join(job_dir, f"segment_qwen_{i + 1:03d}.wav")
            seg = {"index": i, "text": line_text, "ref_audio": ref, "ref_text": ref_text,
                   "x_vector_only": xvo, "language_name": lang_name, "out_path": out_path,
                   # 태그(비민감) — bridge 가 결과·오류에 그대로 반환한다. 화자는 불투명
                   # 토큰으로만 싣는다(표시 이름은 private 기록의 몫).
                   "emotion_id": emotion_id,
                   "speaker_ref": _rr_row["speaker_ref"],
                   "reference_id": _rr_row["reference_id"],
                   "reference_source": _rr_row["source"]}
            # 기본 경로 = vendor native ICL(ref_code conditioning + vendor 내부 crop).
            # controlled-prefix 는 legacy rollback 전용 opt-in 이다 —
            # 참조를 목표 앞에 재발화시키고 외부 ASR 로 잘라내던 경로다.
            if prefix_text and os.environ.get("AUDIOFORGE_LEGACY_CONTROLLED_PREFIX") == "1":
                # 진단 전용: controlled-prefix 주입을 끄고 vendor native ICL 만 쓴다.
                # ref_text 는 seg 에 그대로 남아 vendor conditioning 으로 전달된다.
                # controlled-prefix: bridge 가 chunk 마다 [참조 전사][종결][개행][목표 대사]로 조립하고
                # 생성 뒤 경계를 찾아 앞을 잘라낸다. 자동분할된 chunk 각각이 자기 prefix 를 갖는다.
                seg["prefix_text"] = prefix_text
            segments.append(seg)

        # 감정 음향 판정(계약: emotion_acoustic.py) — '이 감정이 실제로 감정처럼 들리는가'.
        # 여기서 아는 것은 '어떤 참조 파일이 들어갔는가' 뿐이다. 같은 참조면 모델 입력이 동일하므로
        # 감정 차이가 나올 통로가 없다 → degraded. 전용 참조가 있어도 측정 전에는 unknown 이며,
        # supported 는 생성 결과를 실제로 재야만 열린다(오늘 이 경로에는 그 측정이 없다).
        # 기록은 비민감 토큰만: emotion_id / role / state / reason.
        import emotion_acoustic as _ea
        _emotion_keys = {eid: ref_cache.get(eid) for eid, _t, _sp in parsed if eid != "default"}
        emotion_acoustic_records = _ea.resolve_emotion_set(default_ref, _emotion_keys)
        emotion_acoustic_summary = _ea.emotion_set_summary(emotion_acoustic_records)

        # 발화 → 화자·참조 표를 기록에 올린다. chunk 행이 이 표를 보고 자기 화자를 채운다
        # (chunk 가 갈려도 같은 발화의 chunk 는 같은 화자·참조를 갖는다).
        if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
            try:
                _CONCAT_RECORDER.set_speaker_map(reference_rows, labels=speaker_labels)
                # 이 작업이 돌 때 모델이 감정을 **직접** 받을 수 있었는가. 참조 선택 근거만
                # 남기면 나중에 "그때는 모델이 감정을 받았나?"를 다시 알 수 없다.
                import expressive_capability as _cap_audit
                _CONCAT_RECORDER.set_run_header(
                    emotion_capability=_cap_audit.audit_summary())
            except Exception:
                pass               # 기록 실패가 합성을 막지 않는다

        try:
            try:
                _job_clock = JobWallClock()
                seg_out = qwen.run_job(segments, device)
                # 생성이 끝난 직후에 본다 — 정렬·조립 전에 초과를 확정해
                # 헛수고를 늘리지 않는다. partial 은 진단에만 남는다.
                _job_clock.check(completed_chunks=len(seg_out or []))
            except RuntimeError as e:
                # CUDA OOM만 CPU로 1회 가시적 재시도(조용한 재시도 아님). 상한 도달·그 외 예외는 전파.
                if (device == "cuda:0" and is_cuda_oom(e)
                        and not isinstance(e, (QwenGenerationLimitError, QwenIclBoundaryError))):
                    emit("progress", percent=30, message="GPU 메모리 부족(OOM) → CPU로 1회 재시도(느림)")
                    fallback = True
                    fallback_reason = "CUDA OOM → CPU 재시도"
                    actual_device = "cpu"
                    seg_out = qwen.run_job(segments, "cpu")
                else:
                    raise
            # bridge 의 controlled-prefix raw 는 중간 산출물이다 — 여기(부모)에서 ASR 정렬로 목표
            # 대사 위치를 특정하고 그 좁은 창 안에서 경계를 찾아 잘라낸 뒤에야 chunk 가 확정된다.
            # bridge subprocess 는 이미 종료됐으므로 Qwen 과 whisper 는 동시 적재되지 않는다.
            seg_out = _align_icl_chunks(seg_out, output_dir=output_dir)
        except QwenIclBoundaryError as ibe:
            # 경계 미확정 → 잘라내지 않은 결과를 발행하지 않는다. safe_xvector 로 자동 전환하지 않고
            # 사용자에게 모드 선택을 돌려준다(요청한 모드와 다른 결과를 무신호로 주지 않는다).
            emo = ibe.emotion_id
            si = ibe.segment_index
            if emo is None:
                emo = (parsed[si][0] if isinstance(si, int) and 0 <= si < len(parsed) else "?")
            _e = RuntimeError(
                f"ICL_BOUNDARY_ALIGNMENT_FAILED — 감정 '{emo}' 문장에서 참조 대사와 목표 대사의 "
                f"경계를 확정하지 못해 결과를 발행하지 않았습니다({ibe.boundary_reason}). "
                f"참조 구간을 문장 단위로 다시 확정하거나, " + _ICL_SAFE_MODE_HINT)
            _e.error_payload = {
                "code": ICL_BOUNDARY_ALIGNMENT_FAILED,
                "segment_index": si if isinstance(si, int) else None,
                "chunk_index": ibe.chunk_index,
                "emotion_id": emo,
                "boundary_reason": ibe.boundary_reason,
                # 진단 자료가 남은 폴더 '이름'(출력 폴더 하위 .af-icl-diagnostics 안). 절대경로 아님.
                "diagnostic_dir_name": getattr(ibe, "diagnostic_dir_name", None),
            }
            raise _e from None
        except QwenGenerationLimitError as gle:
            # 상한 도달 → 잘린 WAV 미채택. 감정 ID로만 재해석(전사·문장·경로 미포함).
            # 이 예외로 place_final_with_pitch 이전에 빠져나가므로 finally가 job_dir을 지우고
            # 기존 synthesized.wav는 output_dir(=job_dir 밖)에 그대로 보존된다(원자 보존).
            si = gle.segment_index
            emo = gle.emotion_id
            if emo is None:  # bridge가 못 준 경우만 parsed로 보강(offending segment 기준)
                emo = (parsed[si][0] if isinstance(si, int) and 0 <= si < len(parsed) else "?")
            ck = f", 조각 {gle.chunk_index}" if gle.chunk_index is not None else ""
            # ICL(controlled-prefix)은 참조 대사까지 함께 생성하므로 같은 대사라도 상한에 더 쉽게 닿는다.
            # 그 사실을 안내에 명시한다(원인을 참조 불일치로만 오인하지 않도록).
            _icl_note = (" 참조 억양 반영 모드는 참조 대사를 함께 생성하므로 상한에 더 쉽게 도달합니다 — "
                         "참조 구간을 더 짧은 한 문장으로 줄이거나 '안전 음성 복제' 모드를 사용하세요."
                         if reference_conditioning_mode == REF_CONDITIONING_HIGH_QUALITY_ICL else "")
            _e = RuntimeError(
                f"GENERATION_LIMIT_EXCEEDED — 감정 '{emo}' 문장{ck}이 동적 생성 상한"
                f"(max_new_tokens={gle.generation_limit})에 도달했습니다(생성 반복 {gle.generated_iterations}). "
                f"참조 오디오와 전사 내용이 맞지 않을 때 나타날 수 있습니다 — 참조 구간/전사를 확인한 뒤 다시 시도하세요."
                + _icl_note
            )
            # 구조화 payload(renderer까지 정식 code 전달 — 문자열 prefix 추론 금지).
            # 감정 ID·index·수치만 담는다: 전사·문장·전체경로 없음(§미디어 정책).
            _e.error_payload = {
                "code": "GENERATION_LIMIT_EXCEEDED",
                "segment_index": si if isinstance(si, int) else None,
                "chunk_index": gle.chunk_index,
                "emotion_id": emo,
                "generated_iterations": gle.generated_iterations,
                "generation_limit": gle.generation_limit,
            }
            raise _e from None
        except QwenTextSegmentTooLongError as tle:
            # 자동 분할로도 상한 이내로 못 만든 줄 → 명확히 실패(내용 미포함). 기존 synthesized.wav 보존.
            si = tle.segment_index
            emo = tle.emotion_id
            if emo is None:
                emo = (parsed[si][0] if isinstance(si, int) and 0 <= si < len(parsed) else "?")
            _e = RuntimeError(
                f"TEXT_SEGMENT_TOO_LONG — 감정 '{emo}' 줄이 안전한 단일 합성 길이를 초과합니다. "
                f"문장별로 나누거나 줄바꿈을 추가하세요. (production 토큰 {tle.production_tokens}, 허용 {tle.allowed})"
            )
            _e.error_payload = {
                "code": "TEXT_SEGMENT_TOO_LONG",
                "segment_index": si if isinstance(si, int) else None,
                "emotion_id": emo,
                "production_tokens": tle.production_tokens,
                "allowed": tle.allowed,
            }
            raise _e from None

        # chunk 정렬: (original_segment_index, chunk_index). 순서 보존 = 원문 순서.
        ordered_entries = sorted(seg_out, key=lambda x: (x["original_segment_index"], x["chunk_index"]))
        ordered = [e["out_path"] for e in ordered_entries]

        # controlled-prefix 절단 기록(ICL 전용). 안전 모드/legacy 는 (None, None) — 기록 없음이 정상.
        align_meta, align_cut = (_summarize_reference_alignment(ordered_entries)
                                 if icl_mode else (None, None))

        # 생성 안전장치 metadata(계약 A/B). 여기 도달 = 전 chunk가 completed_before_limit.
        # scalar 3필드 대표 = generated_iterations/generation_limit 비율 최대 chunk(동률은 (osi,ci) 최소) 한 쌍.
        _cand = [((e["original_segment_index"], e["chunk_index"]), e["generated_iterations"], e["generation_limit"])
                 for e in ordered_entries if isinstance(e.get("generated_iterations"), int)
                 and isinstance(e.get("generation_limit"), int) and e.get("generation_limit") > 0]
        if _cand:
            _rep = min(_cand, key=lambda c: (-(c[1] / c[2]), c[0]))
            meta_gen_iters, meta_gen_limit = int(_rep[1]), int(_rep[2])
            meta_term = "completed_before_limit"
        else:
            meta_gen_iters = meta_gen_limit = meta_term = None
        # 분할 재현 배열(내용·경로·전사 없음)
        gen_chunks = [{"original_segment_index": e["original_segment_index"], "chunk_index": e["chunk_index"],
                       "chunk_count": e["chunk_count"], "production_tokens": e.get("production_tokens"),
                       "generation_limit": e.get("generation_limit"),
                       "generated_iterations": e.get("generated_iterations"),
                       "termination_reason": e.get("termination_reason"), "emotion_id": e.get("emotion_id"),
                       # 진단 추가(가산): chunk 행을 자가 완결로 만든다. 이 값이 없으면 소비자가 frames를
                       # 초로 바꾸려고 상위 dict와 join해야 했다. 출처는 그 chunk를 실제로 기록한 값과
                       # 동일한 bridge의 int(g["sr"]) (= entry["sr"]) — 두 번째 진실 소스를 만들지 않는다.
                       "output_sample_rate": _positive_int_or_none(e.get("sr")),
                       # blocking 생성 구간만 잰 값(가산). qwen_bridge 가 model.generate_voice_clone
                       # 호출 하나만 감싸 측정한다 — 작업 전체 시간인 elapsed_seconds 와 다른 값이다.
                       # 없거나 비정상이면 None(= unavailable). 0 으로 위조하지 않는다.
                       "generation_elapsed_sec": _positive_float_or_none(
                           e.get("generation_elapsed_sec"))}
                      for e in ordered_entries]

        # speed: 1.0=raw, 그 외 chunk별 atempo 후 결합.
        use = ordered
        if abs(float(speed) - 1.0) > 1e-6:
            use = [_atempo_segment(p, float(speed)) for p in ordered]  # 실패는 명확한 예외

        # B envelope 1단계 — 결합 **직전**, 아직 조각이 개별 파일일 때 segment 경계 안쪽 양면에 fade.
        # kind 가 line/paragraph/explicitPause 인 경계에만 걸고 internal/emotion 은 0 이다.
        # 길이 불변이라 아래 layout 진단(frames/start_sample)은 이 단계와 무관하게 그대로 유효하다.
        # _assert_concat_ready 보다 **먼저** 두어 envelope 산출물까지 같은 검증을 통과하게 한다.
        use, segenv_meta = _apply_segment_envelopes(use, ordered_entries, boundary_kinds, job_dir)

        # 결합 직전 재검증(P0-3): speed 후처리 포함 모든 chunk가 동일 sr·mono·finite·non-empty.
        # (첫 파일 sr로 저장하므로 sr 혼입 시 뒤 chunk 속도/길이 변질 → 명확히 중단, 기존 wav 보존.)
        _assert_concat_ready(use)

        # gap(계약 I2·추가3): 자동분할 내부 chunk 경계는 항상 0(연속, §5 불변). 원 segment 경계에는
        # 파서가 결정한 boundary별 gap(explicit pause / line silence / emotion transition)을 쓴다 —
        # boundary_gaps[osi] = segment osi '앞' 무음 초. 미전달(구 경로/테스트)이면 레거시 silence_gap로 폴백.
        gaps = []
        prev_osi = None
        for e in ordered_entries:
            osi = e["original_segment_index"]
            if prev_osi is None or osi == prev_osi:
                gaps.append(0.0)
            elif boundary_gaps is not None and 0 <= osi < len(boundary_gaps):
                gaps.append(float(boundary_gaps[osi]))
            else:
                gaps.append(float(silence_gap))
            prev_osi = osi

        if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
            # vendor native·legacy·safe_xvector 어느 경로든 여기를 지난다.
            _run_record_entries(_CONCAT_RECORDER, ordered_entries)
            _diag_annotate(_CONCAT_RECORDER, ordered_entries, boundary_kinds,
                           segenv_meta, gaps)

        emit("progress", percent=90, message="문장 이어붙이기 중...")
        _layout = _concat_with_boundaries(use, gaps, pending_path)  # 내부 0 / 원 segment 경계 silence_gap
        if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
            # 결합본은 join preview 파생용으로 **들고만** 있는다. manifest 는 synthesize 가
            # 마지막에 한 번 발행한다(manifest 존재 = 번들 완결이라는 계약을 지키기 위해서다).
            try:
                import soundfile as _sf
                _fin, _fsr = _sf.read(pending_path, dtype="float32")
                _CONCAT_RECORDER.stash_final(_fin, _fsr)
                _CONCAT_RECORDER.set_run_header(layout_chunks=len(_layout))
            except Exception as _exc:
                try:
                    _CONCAT_RECORDER.set_run_header(
                        instrumentation_error=type(_exc).__name__)
                except Exception:
                    pass
        # 진단 전용: 각 chunk의 결합본 내 위치를 metadata에 남긴다(오디오 출력 불변, 수치만).
        # 이 값이 없으면 join 지점을 사후에 찾을 수 없어 경계 품질을 실측할 수 없다.
        # 기준 파일은 **pitch 적용 전 pending**이다. pitch=0이면 최종 synthesized.wav와 동일 좌표지만,
        # pitch!=0이면 rubberband가 전체 길이를 바꾸므로 이 위치는 최종 파일에 선형 대응하지 않는다.
        # gen_chunks/ordered_entries/use/gaps는 모두 같은 순서·같은 길이(위 루프들이 ordered_entries 기준).
        # 진단 정보는 합성을 절대 깨뜨리지 않는다: layout이 없거나(테스트 스텁 등) 길이가 어긋나면
        # 부분 기록으로 잘못된 join 위치를 남기는 대신 그냥 붙이지 않는다(오디오 출력에는 무관).
        if isinstance(_layout, list) and len(_layout) == len(gen_chunks):
            for _e, _lay in zip(gen_chunks, _layout):
                _e["frames"] = _lay["frames"]
                _e["gap_before_samples"] = _lay["gap_before_samples"]
                _e["start_sample"] = _lay["start_sample"]

        # 공통 최종 단계(계약 §6.1): pitch(후처리 축)를 speed·결합이 끝난 최종 후보에 적용하고
        # 원자적으로 synthesized.wav에 배치. 검증·os.replace·실패격리(기존 wav 무손상)는 공통 함수가 책임.
        # 0=무호출(바이트 불변). rubberband 부재+pitch!=0 → PITCH_UNAVAILABLE 예외(조용한 폴백 없음).
        import pitch_shift as _ps
        if _ps.clamp_quantize(pitch) != 0.0:
            emit("progress", percent=93, message=f"음높이 보정 중 ({_ps.clamp_quantize(pitch):+.1f}반음)...")
        # pending은 job_dir 내부(output_dir 하위) → os.replace가 동일 파일시스템 원자 이동.
        # pitch 뒤 경계 envelope(항상) + tail auto면 조건부 fade+0 padding까지(계약 §2).
        # 경계 envelope 은 이 최종 조립물의 양 끝에만 걸린다 — 내부 문장 경계는 건드리지 않는다.
        pinfo = _finish_and_place(pending_path, final_path, pitch, job_dir, tail_cfg)
        sr = pinfo["output_sample_rate"]
        import time as _time
        # target_language: 세그먼트 언어 중 최빈값
        tgt = max(set(lang_codes), key=lang_codes.count) if lang_codes else None
        info = {
            "actual_engine": "qwen3", "model_name": _QWEN_REPO, "model_revision": _QWEN_REVISION,
            "device": actual_device, "device_selection_source": device_source,
            "prompt_source": def_source, "x_vector_only_mode": def_xvo,
            "reference_transcript_language": def_tr_lang, "reference_transcript_len": def_tr_len,
            "reference_transcript_sha8": def_tr_sha, "target_language": tgt,
            **_summarize_ref_degradation(degrade_records, def_emotion_id),
            "seed": None, "seed_supported": False,
            "speed_postprocessed": bool(abs(float(speed) - 1.0) > 1e-6),
            "fallback": fallback, "fallback_reason": fallback_reason,
            "elapsed_seconds": round(_time.monotonic() - t_start, 2), "output_sample_rate": int(sr),
            "pitch_semitones": pinfo["pitch_semitones"], "pitch_method": pinfo["pitch_method"],
            "pitch_postprocessed": pinfo["pitch_postprocessed"],
            "generation_limit": meta_gen_limit, "generated_iterations": meta_gen_iters,
            "termination_reason": meta_term, "generation_chunks": gen_chunks,
            # controlled-prefix 절단 실측(ICL 전용, 비민감 수치만). 안전 모드/legacy 는 None.
            "reference_alignment": align_meta, "reference_cut_sample": align_cut,
            # I4: 말끝 finishing 재현(off/auto·pad·fade·적용여부). _finish_and_place가 반환.
            "tail_mode": pinfo.get("tail_mode"), "tail_pad_ms": pinfo.get("tail_pad_ms"),
            "tail_fade_ms": pinfo.get("tail_fade_ms"), "tail_fade_applied": pinfo.get("tail_fade_applied"),
            # 경계 envelope 재현 — 실제 적용 샘플 수.
            "boundary_onset_samples": pinfo.get("boundary_onset_samples"),
            "boundary_offset_samples": pinfo.get("boundary_offset_samples"),
            # macro gain drift 보정 재현값(연기·믹싱·공간 세 축 분리).
            **{k: pinfo.get(k) for k in _MACRO_GAIN_META_KEYS},
            # B envelope 1단계 재현 — 내부 segment 경계에 실제로 건 onset/offset 횟수와 kind별 횟수.
            # 최종 파일 양 끝(boundary_*_samples)과는 서로 다른 자리다(구조적 중복 차단).
            **segenv_meta,
            # 감정 음향 판정(비민감 토큰만). '태그가 붙었다'와 '감정이 실렸다'를 구분해 남긴다 —
            # 이 기록이 없으면 결과물만 보고 감정이 반영됐다고 오해할 길이 열린다.
            "emotion_acoustic": emotion_acoustic_records,
            "emotion_acoustic_summary": emotion_acoustic_summary,
        }
        return final_path, info
    finally:
        # 실행별 폴더 전체 삭제(정상/오류 공통). 성공 시 pending은 이미 replace로 빠져나갔고 나머지 중간물만 남음.
        # 기존 synthesized.wav·다른 작업 결과는 job_dir 밖이라 절대 건드리지 않는다.
        shutil.rmtree(job_dir, ignore_errors=True)


# ── Helpers ──

# (레거시 _parse_line 제거 — 공용 마감 I2에서 합성 파싱 권위를 A 소유 tts_grammar.parse_tts_script 단일 소스로
#  일원화했다. 줄단위 감정 태그만 알던 옛 파서는 인라인 감정·명시적 쉼·경계 우선순위를 몰라 이중 소스 위험이었다.)

def _prepare_ref(ref_path):
    """참조 음성을 mono PCM WAV로 준비. 실패를 조용히 원본 반환으로 넘기지 않고 명확히 실패한다.
    정상 WAV는 그대로 사용(기존 흐름 유지)."""
    # 입력 존재 확인
    if not os.path.exists(ref_path):
        raise RuntimeError(f"참조 음성 파일을 찾을 수 없습니다: {ref_path}")
    # 정상 WAV는 변환 없이 사용
    if ref_path.lower().endswith('.wav'):
        return ref_path, None
    # 비 WAV → ffmpeg 필요
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(f"WAV가 아닌 참조 음성 변환에는 ffmpeg가 필요합니다(미설치): {ref_path}")
    import tempfile, subprocess, shutil
    tmp_dir = tempfile.mkdtemp(prefix="audioforge_tts_")
    tmp_wav = os.path.join(tmp_dir, "ref.wav")
    # 출력은 명시적으로 mono / 24kHz / PCM s16le
    # timeout=120s 근거: PCM WAV 트랜스코딩은 I/O 위주로 실시간보다 훨씬 빠르다(수분짜리도
    # 수초). 참조 음성은 원래 수 초짜리라 정상 파일을 과도 차단하지 않으면서, 멈춘 ffmpeg의
    # 무한 대기만 끊는다.
    try:
        proc = subprocess.run(
            [ffmpeg, "-y", "-i", ref_path, "-ar", "24000", "-ac", "1",
             "-acodec", "pcm_s16le", tmp_wav],
            capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        # ffmpeg 실행 자체 실패(경로/권한) 또는 timeout 등 → 임시 폴더 정리 후 명확히 실패
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"참조 음성 변환 중 오류({ref_path}): {e}")
    ok = proc.returncode == 0 and os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 0
    if not ok:
        stderr_tail = ""
        try:
            stderr_tail = proc.stderr.decode("utf-8", errors="replace")[-300:]
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"참조 음성 변환 실패({ref_path}): {stderr_tail}")
    return tmp_wav, tmp_dir


def _concat_with_silence(segment_paths, output_path, silence_sec=0.5):
    import soundfile as sf
    import numpy as np
    all_audio = []
    target_sr = None
    for path in segment_paths:
        data, sr = sf.read(path, dtype="float32")
        if target_sr is None:
            target_sr = sr
        all_audio.append(data)
        if silence_sec > 0:
            all_audio.append(np.zeros(int(silence_sec * sr), dtype=np.float32))
    if silence_sec > 0 and len(all_audio) > 1:
        all_audio.pop()
    combined = np.concatenate(all_audio)
    sf.write(output_path, combined, target_sr)


def _assert_concat_ready(paths):
    """결합 직전 일관성 단언(P0-3): 전 파일 동일 sr·mono(1-D)·non-empty·finite. 위반 시 명확한 예외."""
    import soundfile as sf
    import numpy as np
    common_sr = None
    for p in paths:
        d, sr = sf.read(p, dtype="float32")
        if not (isinstance(sr, (int, float)) and sr > 0):
            raise RuntimeError(f"결합 전 sr 이상: {os.path.basename(p)}")
        if common_sr is None:
            common_sr = int(sr)
        elif int(sr) != common_sr:
            raise RuntimeError(f"결합 전 sr 불일치: {common_sr} vs {sr}")
        d = np.asarray(d)
        if d.ndim != 1:
            raise RuntimeError(f"결합 전 mono 아님(ndim={d.ndim}): {os.path.basename(p)}")
        if d.size == 0 or not np.all(np.isfinite(d)):
            raise RuntimeError(f"결합 전 빈/비유한 오디오: {os.path.basename(p)}")


# segment envelope 를 여는 경계 종류. 여기 없는 종류(internal/emotion)는 **적용 0** 이다.
#  - internal    : 같은 문장 안(자동분할 chunk 경계 포함) — 붙여 놓으면 연속이라 건드릴 자리가 아니다.
#  - emotion     : 감정 전환. 분할 사유가 아니고(planner 규칙 4) 사용자가 적용 대상에서 제외했다.
# line/paragraph/explicitPause 만이 '독립 생성된 segment 를 조립하며 휴지가 존재하는 경계'다.
SEGMENT_ENVELOPE_KINDS = ("line", "paragraph", "explicitPause")


def _segment_envelope_plan(length, sr, want_onset, want_offset):
    """chunk 하나에 걸 segment envelope 계획. 창 길이·곡선은 audio_finishing 계약 그대로 재사용한다
    (onset 10ms / offset 20ms / smoothstep 3u²−2u³). 여기서 새 임계값을 만들지 않는다.
    짧은 배열에서 두 창이 겹치지 않게 compute_boundary_plan 과 같은 규칙으로 clamp 한다."""
    import audio_finishing as _af
    sr = int(sr)
    n = int(length)
    onset = int(round(_af.BOUNDARY_ONSET_MS * sr / 1000.0)) if want_onset else 0
    offset = int(round(_af.BOUNDARY_OFFSET_MS * sr / 1000.0)) if want_offset else 0
    onset = max(0, min(onset, n // 2))
    offset = max(0, min(offset, n - onset))
    return _af.BoundaryEnvelopePlan(onset_samples=onset, offset_samples=offset, sr=sr)


def _apply_segment_envelopes(paths, ordered_entries, boundary_kinds, work_dir):
    """B envelope 1단계 — **조립 중 열리는 segment 경계**의 안쪽 양면에 fade 를 건다(길이 불변).

    무엇을 하는가: ordered_entries 를 original_segment_index 로 묶어 segment 그룹을 만들고,
    그룹 사이 경계의 kind 가 SEGMENT_ENVELOPE_KINDS 면 **앞 그룹의 마지막 chunk 끝**에 inverted
    ease-out(1→0)을, **뒤 그룹의 첫 chunk 시작**에 ease-in(0→1)을 곱한다. 그 외 경계는 손대지 않는다.

    왜 여기인가: 이 지점이 '독립 생성된 조각들'을 아직 개별 파일로 들고 있는 마지막 자리다.
    _concat_with_boundaries 뒤에는 무음이 이미 삽입돼 어디가 경계였는지 배열만 보고는 알 수 없다.

    ★최종 파일 양 끝과의 중복은 **구조적으로** 막힌다: 경계는 그룹과 그룹 '사이'에만 있으므로
      첫 그룹의 첫 chunk 시작과 마지막 그룹의 마지막 chunk 끝은 후보 집합에 들어갈 수 없다.
      그 둘은 _finish_and_place 의 단일 권위 몫이다. 아래에서 그 사실을 실제로 단언한다.

    길이 불변: gain 곱셈뿐이라 프레임 수가 바뀌지 않는다 → _concat_with_boundaries 가 내는
    frames/gap_before_samples/start_sample 진단은 이 단계 전후로 동일하다.

    원본 chunk 파일은 덮어쓰지 않는다(진단·정렬 산출물 보존). 수정본은 work_dir 안 새 파일로 쓰고
    그 경로로 바꾼 리스트를 돌려준다.

    반환: (new_paths, meta). meta 는 metadata 로 나가는 수치만 담는다(경로·대사 없음).
    """
    import soundfile as sf
    import audio_finishing as _af

    meta = {"segment_envelope_onset_count": 0, "segment_envelope_offset_count": 0,
            "segment_envelope_kind_counts": {}, "segment_envelope_applied": []}
    if not paths or len(paths) != len(ordered_entries) or not boundary_kinds:
        # 진단/구 경로 안전: 정렬이 어긋나면 잘못된 자리에 거는 대신 아무것도 하지 않는다.
        return list(paths), meta

    # 1) chunk 위치를 원 segment 로 묶는다(ordered_entries 는 이미 (osi, ci) 정렬).
    groups = []            # [[osi, first_pos, last_pos], ...]
    for pos, e in enumerate(ordered_entries):
        osi = e["original_segment_index"]
        if groups and groups[-1][0] == osi:
            groups[-1][2] = pos
        else:
            groups.append([osi, pos, pos])

    # 2) 경계마다 '열렸는가'를 kind 로만 판정한다(텍스트 재파싱 없음).
    want_onset, want_offset = {}, {}
    for gi in range(1, len(groups)):
        osi = groups[gi][0]
        kind = boundary_kinds[osi] if 0 <= osi < len(boundary_kinds) else None
        if kind not in SEGMENT_ENVELOPE_KINDS:
            continue
        prev_last, cur_first = groups[gi - 1][2], groups[gi][1]
        want_offset[prev_last] = kind
        want_onset[cur_first] = kind
        meta["segment_envelope_applied"].append({
            "boundary_segment_index": int(osi), "kind": kind,
            "offset_chunk": [int(ordered_entries[prev_last]["original_segment_index"]),
                             int(ordered_entries[prev_last]["chunk_index"])],
            "onset_chunk": [int(ordered_entries[cur_first]["original_segment_index"]),
                            int(ordered_entries[cur_first]["chunk_index"])],
        })

    # ★중복 차단 단언 — 첫 chunk 의 시작과 마지막 chunk 의 끝은 절대 대상이 아니다.
    if 0 in want_onset or (len(paths) - 1) in want_offset:
        raise RuntimeError("segment envelope: 최종 파일 양 끝은 _finish_and_place 권위다(중복 금지)")

    if not want_onset and not want_offset:
        return list(paths), meta

    # 3) 대상 chunk 만 새 파일로 다시 쓴다(원본 무변경, sr·subtype·프레임 수 보존).
    new_paths = list(paths)
    for pos in sorted(set(want_onset) | set(want_offset)):
        src = paths[pos]
        data, sr = sf.read(src, dtype="float32")
        subtype = sf.info(src).subtype
        plan = _segment_envelope_plan(len(data), sr, pos in want_onset, pos in want_offset)
        out = _af.apply_boundary_envelope(data, sr, plan)
        if len(out) != len(data):
            raise RuntimeError("segment envelope: 길이가 변했습니다(계약 위반)")
        dst = os.path.join(work_dir, ".af-segenv-%04d.wav" % pos)
        sf.write(dst, out, sr, subtype=subtype)
        new_paths[pos] = dst
        if plan.onset_samples > 0:
            meta["segment_envelope_onset_count"] += 1
        if plan.offset_samples > 0:
            meta["segment_envelope_offset_count"] += 1
        for rec in meta["segment_envelope_applied"]:
            if pos in want_onset and rec["onset_chunk"] == [
                    int(ordered_entries[pos]["original_segment_index"]),
                    int(ordered_entries[pos]["chunk_index"])]:
                rec["onset_samples"] = int(plan.onset_samples)
            if pos in want_offset and rec["offset_chunk"] == [
                    int(ordered_entries[pos]["original_segment_index"]),
                    int(ordered_entries[pos]["chunk_index"])]:
                rec["offset_samples"] = int(plan.offset_samples)

    counts = {}
    for rec in meta["segment_envelope_applied"]:
        counts[rec["kind"]] = counts.get(rec["kind"], 0) + 1
    meta["segment_envelope_kind_counts"] = counts
    return new_paths, meta


#: 조립 단계 계측용 recorder(모듈 전역). 비활성이면 None 이라 조립 경로가 기존과 동일하다.
_CONCAT_RECORDER = None


def _diag_recorder():
    """계측이 켜져 있을 때만 recorder 를 만든다. 꺼져 있으면 None."""
    try:
        import chunk_publish
        if not chunk_publish.enabled():
            return None
        return chunk_publish.ChunkRecorder()
    except Exception:
        return None            # 계측 실패가 합성을 막지 않는다


# ── run bundle 수명 — **모든** TTS 생성이 기록을 남긴다(진단 스위치와 무관) ──────────
#: 결과 metadata 에서 헤더로 승격할 비민감 키. 경로·대사·전사는 여기 없다.
#: _finish_and_place 가 돌려주는 macro gain 재현 키(단일 출처).
_MACRO_GAIN_META_KEYS = (
    "macro_gain_applied", "macro_gain_reason", "macro_gain_statistic_db", "macro_gain_gate_db",
    "macro_gain_max_boost_db", "macro_gain_curve_sha8", "macro_gain_headroom_cap_db",
    "macro_gain_protected_span_count", "macro_gain_trend_window_sec",
    "macro_gain_level_window_sec")

_RUN_HEADER_FROM_METADATA = (
    "actual_engine", "model_name", "model_revision", "device", "device_selection_source",
    "target_language", "output_sample_rate", "generation_limit", "generated_iterations",
    "termination_reason", "parser_version", "parsed_plan_sha8", "segment_count", "chunk_count",
    "reference_conditioning_mode_requested", "reference_conditioning_mode_effective",
    "reference_conditioning_auto_fallback", "reference_conditioning_attempts",
    "reference_conditioning_icl_published", "fallback", "fallback_reason",
    "speed_postprocessed", "pitch_postprocessed", "silence_gap",
    "boundary_onset_samples", "boundary_offset_samples",
    "segment_envelope_onset_count", "segment_envelope_offset_count",
    "macro_gain_applied", "macro_gain_reason", "macro_gain_max_boost_db",
    "macro_gain_statistic_db", "macro_gain_curve_sha8", "elapsed_seconds")

#: 부분 결과를 보존한 채 끝난 실패 코드. 이 경우 상태는 failed 가 아니라 partial 이다.
_PARTIAL_ERROR_CODES = ("GENERATION_LIMIT_EXCEEDED", "JOB_WALL_TIME_EXCEEDED")
_CANCEL_ERROR_CODES = ("CANCELLED", "TTS_CANCELLED")


def _run_record_begin(text, output_dir, rc_mode, speed, silence_gap, pitch, expressive_mode):
    """작업 시작 즉시 중간 기록을 남긴다 — 취소·강제 종료로 manifest 에 못 가도 흔적이 있다."""
    global _CONCAT_RECORDER
    _CONCAT_RECORDER = None
    try:
        import hashlib
        import chunk_publish
        rec = chunk_publish.ChunkRecorder()
        if not rec.active:
            return None
        rec.set_run_header(
            input_chars=len(text or ""),
            raw_text_sha256=hashlib.sha256((text or "").encode("utf-8")).hexdigest(),
            reference_conditioning_mode_requested=rc_mode,
            speed=float(speed), silence_gap=float(silence_gap),
            pitch_semitones=float(pitch), expressive_mode=expressive_mode,
            # 절대경로는 남기지 않는다 — 폴더 이름만.
            output_dir_basename=os.path.basename(os.path.normpath(output_dir or "")))
        # 대본 원문은 private JSON 에만 들어간다(manifest 로는 SHA·길이만 나간다).
        rec.set_script(text or "", None)
        rec.open()
        _CONCAT_RECORDER = rec
        return rec
    except Exception:
        return None            # 기록 실패가 합성을 막지 않는다


def _run_record_normalized(text):
    """정규화 대본을 private 기록에 덧붙인다. 파서가 권위이고 여기서 재해석하지 않는다."""
    rec = _CONCAT_RECORDER
    if rec is None or not rec.active:
        return
    try:
        import tts_grammar
        segs = tts_grammar.parse_tts_script(text or "")["plan"]["segments"]
        rec.set_script(text or "",
                       chr(10).join(s.get("spoken_text", "") for s in segs))
    except Exception:
        pass                   # 기록 실패가 합성을 막지 않는다


def _run_record_entries(rec, ordered_entries):
    """chunk 좌표·대사·생성 근거를 기록한다. 대사는 private, 좌표·수치는 manifest."""
    if rec is None or not rec.active:
        return
    try:
        for g, e in enumerate(ordered_entries):
            rec.record_chunk_text(
                g, e.get("text") or "",
                production_tokens=e.get("production_tokens"),
                segment=e.get("original_segment_index"),
                local_chunk_index=e.get("chunk_index"), model_call_index=g)
            vcr = e.get("vendor_crop_record")
            rec.record_generation(
                g, generation_limit=e.get("generation_limit"),
                generated_iterations=e.get("generated_iterations"),
                termination_reason=e.get("termination_reason"),
                vendor_crop_record=vcr,
                external_alignment_calls=(0 if vcr is not None else None),
                elapsed_sec=e.get("generation_elapsed_sec"))
            # vendor native 는 반환 PCM 이 곧 chunk 파형이다 — 그 사실을 단계로 남긴다.
            _diag_stage(rec, "vendor_returned" if not e.get("controlled_prefix") else "raw",
                        e, gidx=g)
    except Exception:
        pass                   # 기록 실패가 합성을 막지 않는다


def _run_record_finish(status, error_code=None, extra=None):
    """manifest 를 **마지막에 한 번** 발행한다. 실패해도 사용자 WAV 를 건드리지 않는다."""
    rec = _CONCAT_RECORDER
    if rec is None or not getattr(rec, "active", False):
        return
    try:
        if error_code:
            rec.set_run_header(error_code=str(error_code))
        rec.write(status, extra=extra)
    except Exception as exc:
        # 기록 실패는 원래 오류를 덮지 않는다. WAV 는 이미 발행됐고 그대로 둔다.
        rec.record_error = type(exc).__name__
        try:
            import chunk_publish
            chunk_publish._atomic_json(
                {"schema": chunk_publish.SCHEMA_VERSION, "run_id": chunk_publish.run_id(),
                 "status": "RECORD_INCOMPLETE", "reason": type(exc).__name__,
                 "recoverable": True},
                os.path.join(rec.root, "record-incomplete.json"))
        except Exception:
            pass
        try:
            emit("warning", code="RECORD_INCOMPLETE", reason=type(exc).__name__)
        except Exception:
            pass


def _run_record_status_for(exc):
    """예외를 상태·코드로 옮긴다. 부분 보존 실패는 failed 가 아니라 partial 이다."""
    if exc is None:
        return "ok", None
    # 구조화 payload 가 이 프로젝트의 오류 code 권위다(문자열 prefix 추론 금지).
    payload = getattr(exc, "error_payload", None)
    code = ((payload or {}).get("code") if isinstance(payload, dict) else None)
    code = str(code or getattr(exc, "code", None) or type(exc).__name__)
    if code in _CANCEL_ERROR_CODES:
        return "cancelled", code
    if code in _PARTIAL_ERROR_CODES or isinstance(exc, QwenGenerationLimitError):
        return "partial", ("GENERATION_LIMIT_EXCEEDED"
                           if isinstance(exc, QwenGenerationLimitError) else code)
    return "failed", code


def _diag_annotate(rec, ordered_entries, boundary_kinds, segenv_meta, gaps):
    """조립 직전에 경계 종류·segment-local 번호·envelope 적용을 recorder 에 기록한다.

    추론으로 채우지 않는다 — 근거가 없는 항목은 'unknown' 으로 남긴다.
    chunk 의 원문 텍스트는 여기서 읽지 않는다(해시·인덱스만 다룬다)."""
    try:
        import chunk_publish
        # segment 별로 몇 번째 chunk 인지 세어 segment-local 번호를 복원한다.
        local, seen = {}, {}
        prev_osi = None
        for g, e in enumerate(ordered_entries):
            osi = e.get("original_segment_index")
            seen[osi] = seen.get(osi, -1) + 1
            local[g] = seen[osi]
        # envelope 좌표: _apply_segment_envelopes 가 돌려준 메타에서 chunk 위치를 찾는다.
        # segment_envelope_applied 는 (segment_index, segment-local chunk_index) 쌍을 준다.
        # ordered_entries 를 훑어 그 쌍을 global index 로 되돌린다.
        pair_to_g = {}
        for g, e in enumerate(ordered_entries):
            pair_to_g[(e.get("original_segment_index"), e.get("chunk_index"))] = g
        env_at = {}
        for rec_e in ((segenv_meta or {}).get("segment_envelope_applied") or ()):
            for side in ("offset_chunk", "onset_chunk"):
                pair = rec_e.get(side)
                if not pair:
                    continue
                g = pair_to_g.get((pair[0], pair[1]))
                if g is None:
                    continue
                slot = env_at.setdefault(g, {"applied": True, "sides": [],
                                             "kind": rec_e.get("kind")})
                slot["sides"].append(side.replace("_chunk", ""))
        prev_osi = None
        for g, e in enumerate(ordered_entries):
            osi = e.get("original_segment_index")
            same_segment = (prev_osi is not None and osi == prev_osi)
            kind = "unknown"
            if g == 0:
                kind = None                      # 첫 chunk 앞에는 경계가 없다
            elif not same_segment:
                bk = None
                if boundary_kinds is not None and 0 <= osi < len(boundary_kinds):
                    bk = boundary_kinds[osi]
                kind = {"line": "line_break", "paragraph": "blank_line_paragraph",
                        "explicitPause": "explicit_pause", "emotion": "emotion_change",
                        "sentence": "same_line_sentence"}.get(bk, "unknown")
            else:
                # 같은 segment 안의 분할 — 앞 chunk 텍스트의 마지막 글자로만 판정한다.
                prev_text = (ordered_entries[g - 1] or {}).get("text")
                kind = (chunk_publish.classify_boundary(prev_text, True, 0, False, None)
                        if prev_text else "unknown")
            rec.note(g, segment=osi, segment_chunk_index=local[g],
                     boundary_kind=kind,
                     envelope=env_at.get(g, {"applied": False}))
            prev_osi = osi
    except Exception:
        pass                                     # 계측 실패가 합성을 막지 않는다


def _diag_stage(rec, stage, e, gidx=None, **meta):
    """entry 의 현재 WAV 를 해당 단계로 발행. 실패해도 합성 결과를 바꾸지 않는다.

    gidx 를 명시하지 않으면 entry 가 들고 있는 global index 를 쓴다. 조립 경로처럼 entry 에
    global index 가 아직 없는 곳에서는 **반드시** 넘겨야 한다 — 안 그러면 segment-local
    chunk_index 로 떨어져 서로 덮어쓴다(실측 결함)."""
    try:
        import soundfile as sf
        p = e.get("out_path")
        if not p or not os.path.isfile(p):
            return
        arr, sr = sf.read(p, dtype="float32")
        if gidx is None:
            gidx = int(e.get("global_chunk_index", e.get("chunk_index") or 0))
        gidx = int(gidx)
        fn = {"raw": rec.raw, "vendor_returned": rec.vendor_returned}.get(stage, rec.aligned)
        fn(gidx, arr, sr,
           segment=e.get("original_segment_index"),
           segment_chunk_index=e.get("chunk_index"),
           emotion_id=e.get("emotion_id"), **meta)
    except Exception as exc:                      # 계측 실패는 기록만 하고 넘어간다
        try:
            rec.note(int(e.get("global_chunk_index", e.get("chunk_index") or 0)),
                     instrumentation_error="%s:%s" % (stage, type(exc).__name__))
        except Exception:
            pass


def _concat_with_boundaries(paths, gaps_before, output_path):
    """paths를 순서대로 이어붙이되 각 항목 '앞'에 gaps_before[i]초 무음 삽입(계약 B).
    자동분할 내부 chunk 사이 gap=0(연속), 원래 segment 경계에만 사용자 silence_gap. gaps_before[0]은 0.
    무음은 각 파일 sr 기준(첫 파일 sr을 target으로 사용). 무작위 무음 삽입 아님 — 호출부가 경계에서만 지정.

    반환(진단 전용, 오디오 출력에는 영향 없음): [{frames, gap_before_samples, start_sample}, ...]
      - frames             : 이 chunk가 결합본에 기여한 샘플 수(speed 후처리까지 끝난 실제 길이)
      - gap_before_samples : 이 chunk '앞'에 실제로 삽입된 무음 샘플 수(초→샘플 절단 규칙 그대로)
      - start_sample       : 결합본에서 이 chunk의 첫 샘플 위치(= 직전 chunk와의 join 지점)
    join 지점을 나중에 되찾을 방법이 없어(작업 디렉터리는 정리되고 metadata에 길이가 없다) 경계 품질을
    실측할 수 없었다. 여기서 실제 삽입값을 그대로 돌려주고 호출부가 metadata에 싣는다.
    """
    import soundfile as sf
    import numpy as np
    if len(paths) != len(gaps_before):
        raise RuntimeError("concat: paths와 gaps 길이 불일치")
    out = []
    layout = []
    target_sr = None
    cursor = 0
    for i, path in enumerate(paths):
        data, sr = sf.read(path, dtype="float32")
        if target_sr is None:
            target_sr = sr
        g = float(gaps_before[i])
        gap_samples = 0
        if i > 0 and g > 0:
            # 절단(int) — 아래 layout에 기록하는 값도 반드시 '실제 삽입한' 이 값이어야 한다.
            gap_samples = int(g * target_sr)
            out.append(np.zeros(gap_samples, dtype=np.float32))
            cursor += gap_samples
        frames = int(data.shape[0])
        layout.append({"frames": frames, "gap_before_samples": gap_samples, "start_sample": cursor})
        if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
            # 여기 data 가 곧 결합본에 들어가는 파형이다 — final 의 SHA 가 이것과 같아야 한다.
            _CONCAT_RECORDER.final(i, data, target_sr, cursor, gap_samples,
                                   envelope=None)   # 주석 단계에서 넣은 값을 유지
        out.append(data)
        cursor += frames
    combined = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
    sf.write(output_path, combined, target_sr)
    return layout


import speaker_refs as _sr


def _boundary_gaps_from_plan(plan, silence_gap, emotion_boundary_mode="pause",
                             emotion_boundary_pause_ms=200, paragraph_gap=None,
                             model_tail_ms=None, model_lead_ms=None):
    """공용 마감 I2 — A 소유 파서(tts_grammar) plan → (parsed, gaps_before). 순수(numpy/soundfile 불요).

    합성 권위는 Python 파서다. renderer가 보낸 것과 동일 raw를 파서가 이미 (separate.py I1 parity로) 검증했고,
    여기선 그 plan을 합성 입력으로 환산만 한다(재-strip·재해석·조용한 default 강등 금지).

    - parsed: [(emotion_id, spoken_text), ...] — 레거시 shape 유지. emotion 없으면 'default'(기존 라우팅 그대로).
      spoken_text는 **파서 산출 그대로**(정규화 단일 소스=A 파서; parity 해시도 이 값 기준).
    - gaps_before[i]: segment i '앞' 무음 초. [0]=0.0. 경계 우선순위(계약 추가3)는 파서가 boundary_type로
      **단일 결정**(explicitPause > lineSilenceGap > emotionBoundaryPause > internal) → 여기선 gap 초로 환산만(합산 없음).
    - kinds[i]: segment i '앞' 경계의 **의미 종류**(classify_plan_boundaries 의 kind 그대로:
      internal|emotion|line|paragraph|explicitPause). 예전엔 gap 초만 꺼내고 이 값을 버렸다 —
      그래서 "휴지가 있는 진짜 문장 경계"와 "감정 전환/문장 내부"를 오디오 조립 단계에서 구분할 수
      없었다. 여기서 함께 돌려주고 조립부가 segment envelope 판단에 쓴다(재파싱·문장부호 규칙 없음).

    환산은 semantic_chunk_planner 가 소유한다(C2). 이 함수는 그 결과를 받아 shape 만 맞춘다.
    새 선택 인자는 전부 기본 None 이며, 주지 않으면 값이 이전과 완전히 동일하다:
      paragraph_gap : 빈 줄(문단) 경계 전용 무음 초. None → 일반 줄바꿈과 같은 silence_gap.
      model_tail_ms / model_lead_ms : 모델이 낸 말미/앞머리 무음 '측정값'(잰 주체는 이 모듈이 아니다).
        주면 '말미 + 앱 gap + 앞머리 = 목표' 가 되도록 앱 gap 을 줄인다(합산 방지). 안 주면 보정 없음.
    감정 전환은 immediate|pause만(계약 정정6·정정7). smooth/crossfade는 환산하지 않는다(미지원).
    """
    segs = plan.get("segments", [])
    # 행 모양: (emotion_id, spoken_text, speaker_id). 앞의 두 자리는 v1.3.0 과 같아서
    # 기존 소비자가 그대로 동작하고, 화자만 뒤에 실려 chunk 까지 따라간다.
    # 여기가 계획이 좁아지는 **유일한 지점**이라 화자도 이 한 곳에서 넓힌다.
    parsed = [(s.get("emotion_id") or "default", s.get("spoken_text", ""), s.get("speaker_id"))
              for s in segs]
    entries = semantic_chunk_planner.resolve_boundary_gaps(
        plan, silence_gap, emotion_boundary_mode, emotion_boundary_pause_ms,
        paragraph_gap, model_tail_ms, model_lead_ms)
    return parsed, [e["gap_sec"] for e in entries], [e["kind"] for e in entries]


# ── Main synthesize function ──

def resolve_reference_input(override, input_path):
    """기본 참조 경로 결정. override(확정 파생 클립)가 지정됐는데 파일이 없으면 원본으로 조용히
    폴백하지 않고 명확한 오류(만료). override 없으면 원본 사용."""
    ov = (override or "").strip()
    if ov:
        if not os.path.exists(ov):
            raise RuntimeError("확정한 참조 클립이 만료되었습니다 — 참조 구간을 다시 확정하세요.")
        return ov
    return input_path


def synthesize(reference_audio, text, output_dir, speed=1.0, silence_gap=0.5,
               emotion_refs=None, emotion_ref_sources=None, preferred_engine=None, reference_prompts=None, pitch=0.0,
               tail_cfg=None, emotion_boundary_mode="pause", emotion_boundary_pause_ms=200,
               expressive_mode="legacy_v2", reference_conditioning_mode=None,
               speaker_refs=None, speaker_ref_sources=None, speaker_emotion_refs=None,
               emotion_candidate_selections=None,
               speaker_labels=None):
    """Synthesize speech. Auto-selects engine by language.
    reference_prompts: 식별자(default/emotionId) → {manual_text, prompt_lang, mode} 사용자 override.
    emotion_refs: emotionId → 합성에 쓸 effective 참조 경로(3~10초 클립/유효 원본).
    emotion_ref_sources: emotionId → 사용자 등록 원본 경로(등록 사실). 만료 판정 기준(계약 §5).
    pitch: 결과 WAV 음높이 보정(반음, 후처리 축). 0=무후처리. 정규화 권위는 pitch_shift.clamp_quantize.
    tail_cfg: 말끝 finishing 설정({'mode':'off'|'auto','pad_ms','fade_ms'}) 또는 None. **None/off(기본)면
      동작 변화 0(레거시 회귀 보존)**. 'auto'는 통합 담당이 config에서 배선할 때만 전달된다(계약 §3).
    emotion_boundary_mode: 감정 전환 경계 정책 immediate|pause(계약 정정6·추가3). 기본 pause(현행 동치, smooth 미지원).
    emotion_boundary_pause_ms: pause 모드의 감정전환 경계 무음 ms. 기본 200(계약 추가4). 두 값은 I3에서 config로
      배선되며 그 전까지 인라인 감정전환 경계에만 영향(레거시 줄단위 입력은 lineSilenceGap이라 무영향=회귀 보존).
    expressive_mode: 표현형 파서 모드(계약 §10) — result metadata 에 '어느 모드로 만든 결과인가'를 기록해
      session/config/metadata 3중 일치를 성립시키기 위한 값이다. ⚠️ 합성 동작에는 쓰지 않는다.
      오늘 이 함수에 도달하는 값은 항상 'legacy_v2' 다(separate.py 가 v3 를 모델 로딩 전에 차단한다).
      v3 합성이 구현되기 전까지 이 인자로 분기하지 말 것 — 분기하면 그 순간 조용한 v3 경로가 생긴다.
    reference_conditioning_mode: 참조 conditioning 모드(참조혼입 대응, 단일 권위 계약).
      production 은 separate.py 가 항상 명시 값을 전달한다. **None/'' 도 safe_xvector 로 해석한다**
      — 전사 기반 ICL 로 가는 '모드 없는 기본 경로'는 존재하지 않는다(함수 레벨까지 안전 기본).
      값 검증·fail-closed 는 이 입구가 단일 소유: 잘못된 값 → INVALID_REFERENCE_CONDITIONING_MODE.
      'auto' 는 ICL 1회 시도 후 정렬 실패 시 safe_xvector 로 정확히 1회 전환한다(아래 Qwen 분기).
    speaker_refs: 화자 id → 합성에 쓸 참조 경로. `speaker_ref_sources` 는 등록 사실(원본 경로)이고
      둘의 역할이 다르다 — 등록됐는데 파일이 없으면 조용히 다른 목소리로 대체하지 않고 막는다.
    speaker_emotion_refs: `speaker_refs.emotion_key(화자, 감정)` → 경로. `(화자, 감정)` 전용 참조.
    speaker_labels: 화자 id → 사용자가 쓴 표시 이름. **기록 전용**이며 private JSON 에만 남는다.
      합성 조건으로는 쓰이지 않는다(같은 사람을 다르게 적었을 뿐이면 목소리는 같다)."""
    # ── 참조 conditioning 모드 판정 — 어떤 파싱/참조 준비/모델 작업보다 먼저(모델 미로딩 차단). ──
    rc_mode = resolve_reference_conditioning_mode(reference_conditioning_mode)  # invalid → 구조화 오류
    # 재현 메타는 **결과가 확정된 뒤** _reference_conditioning_meta 로 만든다(여기서 미리 만들면
    # auto 전환이 기록에 반영되지 않는다). reference_alignment / reference_cut_sample 도 여기서
    # 만들지 않는다 — 실제 절단을 수행한 합성 경로(info)가 채우고, 수행하지 않은 경로는
    # _build_tts_metadata 가 None 으로 채운다(권위 하나).
    emit("status", message="음성 합성 시작", percent=0)
    # 기록은 **모든** 생성에서 열린다. 진단 스위치는 stage WAV 를 켤 뿐이다.
    _run_record_begin(text, output_dir, rc_mode, speed, silence_gap, pitch, expressive_mode)
    _rr = {"status": "failed", "error_code": None}

    if not emotion_refs:
        emotion_refs = {}
    if not emotion_ref_sources:
        emotion_ref_sources = {}

    import time as _time
    _t0 = _time.monotonic()
    requested_engine = preferred_engine or "auto"

    # 공용 마감 I2 — A 소유 파서(tts_grammar) 단일 소스로 파싱(합성 권위=Python). 인라인 감정·명시적 쉼·경계
    # 우선순위를 파서가 결정하고, 여기선 그 plan을 (parsed, boundary_gaps)로 환산만 한다(재-strip·재해석 금지).
    # 파싱 오류는 정상 흐름상 separate.py의 I1 parity 게이트가 모델 로딩 전에 이미 차단하지만(대사 전문 미출력),
    # 방어적으로 여기서도 구조화 code로 명확히 실패한다(조용한 default 강등·발음 금지 — 계약 정정2).
    import tts_grammar as _tg
    _pres = _tg.parse_tts_script(text)
    if not _pres.get("ok"):
        _err = (_pres.get("errors") or [{}])[0]
        _e = RuntimeError("대사 태그를 처리할 수 없습니다.")
        _e.error_payload = {"code": _err.get("code", "TTS_PARSE_ERROR")}
        raise _e
    _plan = _pres["plan"]
    _run_record_normalized(text)
    parsed, boundary_gaps, boundary_kinds = _boundary_gaps_from_plan(
        _plan, silence_gap, emotion_boundary_mode, emotion_boundary_pause_ms)
    if not parsed:
        emit("error", message="합성할 텍스트가 없습니다.")
        return
    # I4 파서 plan 재현 메타(비민감: 수치·해시8만, 대사 전문/전사/경로 없음). 두 합성 경로 메타에 공통 병합.
    _sm = _plan.get("summary", {})
    _plan_meta = {
        "parser_version": _sm.get("parser_version"),
        "parsed_plan_sha8": _sm.get("plan_sha8"),
        "segment_count": _sm.get("segment_count"),
        "chunk_count": _sm.get("chunk_count"),
        "explicit_pause_count": _sm.get("explicit_pause_count"),
        "total_pause_ms": _sm.get("total_pause_ms"),
        "emotion_boundary_mode": emotion_boundary_mode,
        # 표현형 모드 캐리어(계약 §10) — camelCase 가 세 캐리어 공통 정본 키.
        "ttsExpressiveMode": expressive_mode,
    }
    emit("progress", percent=5, message=f"{len(parsed)}개 문장 합성 준비")

    # 참조 준비부터 finally 정리 범위에 포함 — 기본 참조 준비로 임시 폴더가 생긴 뒤
    # 감정 참조 준비가 실패해도, 이미 만든 임시 폴더가 새지 않게 한다.
    tmp_dirs = []
    try:
        ref_wav, tmp_ref_dir = _prepare_ref(reference_audio)
        if tmp_ref_dir:
            tmp_dirs.append(tmp_ref_dir)
        ref_cache = {"default": ref_wav}

        # 감정 참조(계약 §5 4불변식) — 실제 대사에서 '사용된' 감정만 검증한다(미사용은 무시·bridge 미전달).
        #  등록 기준 = emotion_ref_sources(원본 등록 사실). 등록됐는데 effective가 없거나 만료면 명확한 오류를
        #  던진다(silent fallback 금지 — 예전엔 파일 없으면 조용히 건너뛰어 기본 참조로 대체됐다).
        #  미등록 사용 감정은 ref_cache에 넣지 않아 아래 라우팅에서 기본 참조로 폴백된다.
        used_emotion_ids = {eid for eid, _t, _sp in parsed if eid != "default"}
        for eid in used_emotion_ids:
            # 등록 판정: sources(원본 등록, 계약상 진실) 또는 effective(refs)에 존재. production은 sources가
            # 준비된 것(refs)을 포함하므로 sources 기준과 동치이고, sources 없이 refs만 주어지는 호출(구 경로/
            # 테스트)도 등록으로 보아 effective 유효성을 검증한다 — 어느 경우든 "등록됐는데 effective 없음"은 오류.
            if eid not in emotion_ref_sources and eid not in emotion_refs:
                continue  # (1) 미등록 → 기본 참조 폴백(정상)
            eff = emotion_refs.get(eid)
            if not (eff and os.path.exists(eff)):  # (3) 등록됐는데 effective 없음/만료 → 명확한 오류
                label = next((k for k, v in EMOTION_TAGS.items() if v == eid), eid)
                raise RuntimeError(
                    f"감정 참조가 만료되었거나 유효하지 않습니다 — [{label}] 참조 구간을 다시 확정하세요.")
            wav, tmp = _prepare_ref(eff)  # (2) 등록 + effective 유효 → 사용
            if tmp:
                tmp_dirs.append(tmp)
            ref_cache[eid] = wav
        # (4) 미사용 감정은 위 루프(used_emotion_ids)에 없으므로 준비·검증·전달되지 않는다.

        # ── 화자별 참조 준비 ─────────────────────────────────────────────
        # 감정 참조와 같은 방식으로 준비한다(같은 `_prepare_ref`). 대본에 실제로 나온
        # 화자만 준비하고, 등록되지 않았거나 파일이 없으면 **모델을 올리기 전에** 막는다.
        _used_speaker_ids = [sp for _e, _t, sp in parsed if sp]
        _registered_speakers = set((speaker_ref_sources or {}).keys()) | set(
            (speaker_refs or {}).keys())
        _prepared_speaker = {}
        _prepared_pair = {}
        for sid in dict.fromkeys(_used_speaker_ids):
            if sid not in _registered_speakers:
                raise _sr.SpeakerReferenceError(_sr.SPEAKER_NOT_REGISTERED, sid)
            src = (speaker_refs or {}).get(sid)
            if not (src and os.path.exists(src)):
                raise _sr.SpeakerReferenceError(_sr.SPEAKER_REFERENCE_NOT_READY, sid)
            wav, tmp = _prepare_ref(src)
            if tmp:
                tmp_dirs.append(tmp)
            _prepared_speaker[sid] = wav
        for key, src in (speaker_emotion_refs or {}).items():
            sid = str(key).split(chr(31))[0]
            if sid not in _prepared_speaker:
                continue          # 대본에 안 나온 화자의 전용 참조는 준비하지 않는다
            if not (src and os.path.exists(src)):
                raise _sr.SpeakerReferenceError(_sr.SPEAKER_REFERENCE_NOT_READY, sid)
            wav, tmp = _prepare_ref(src)
            if tmp:
                tmp_dirs.append(tmp)
            _prepared_pair[key] = wav

        # ── 감정 프로필(참조 선택용) ─────────────────────────────────
        # GPU 없음. 감정 참조 클립을 emotion_acoustic 의 v3 분석기로 재서 "이 감정이
        # 어떻게 들리는가"의 기준을 만들고, 화자의 클립 중 그 기준에 가까운 것을 고르게
        # 한다. 분석이 실패하면 **감정 선택만 포기**한다 — 합성은 그대로 간다.
        # 이 값들은 참조를 고르는 데만 쓰이며 모델 호출 인자를 한 글자도 바꾸지 않는다.
        import emotion_acoustic as _ea_profile
        _v3_cache = {}

        def _profile_of_ref(_path):
            if _path in _v3_cache:
                return _v3_cache[_path]
            _profile = None
            try:
                import soundfile as _sf_p
                _data, _sr_hz = _sf_p.read(_path, dtype="float64", always_2d=True)
                _profile = _ea_profile.analyze_profile_v3(_data[:, 0], _sr_hz)
            except Exception:
                _profile = None     # 못 재면 모른다고 둔다(지어내지 않는다)
            _v3_cache[_path] = _profile
            return _profile

        _target_profiles = {}
        for _eid_p, _epath_p in ref_cache.items():
            if _eid_p == "default":
                continue
            _p = _profile_of_ref(_epath_p)
            if _p is not None:
                _target_profiles[_eid_p] = _p
        if _target_profiles:
            emit("stage", stage="emotion_profile_analyzed",
                 emotions=len(_target_profiles))

        # ── 사용자 선택 id 옮기기 ─────────────────────────────────────
        # 화면이 준 참조 id 는 **원본 파일** 내용에서 나온 값이다. 준비 단계(`_prepare_ref`)가
        # 파일을 변환하면 내용이 달라져 id 도 달라진다. 옮겨 주지 않으면 사용자의 선택이
        # "후보에 없는 값"으로 보여 조용히 자동 제안으로 떨어진다 — 가장 나쁜 실패다.
        _id_probe = _sr.ReferenceTable(default_ref=ref_wav)
        _orig_to_prepared = {}
        for _sid, _src in (speaker_refs or {}).items():
            _prep = _prepared_speaker.get(_sid)
            if _src and _prep:
                _orig_to_prepared[_id_probe.reference_id(_src)] = _id_probe.reference_id(_prep)
        for _key, _src in (speaker_emotion_refs or {}).items():
            _prep = _prepared_pair.get(_key)
            if _src and _prep:
                _orig_to_prepared[_id_probe.reference_id(_src)] = _id_probe.reference_id(_prep)
        _prepared_selections = {}
        for _key, _choice in (emotion_candidate_selections or {}).items():
            if not isinstance(_choice, str) or not _choice.strip():
                continue
            _prepared_selections[_key] = (
                _choice if _choice in _sr.USER_CHOICES
                else _orig_to_prepared.get(_choice, _choice))

        # 참조 선택의 단일 권위. 폴백 규칙을 생성 루프에서 다시 쓰지 않는다.
        ref_table = _sr.ReferenceTable(
            default_ref=ref_wav,
            emotion_refs={k: v for k, v in ref_cache.items() if k != "default"},
            speaker_refs=_prepared_speaker,
            speaker_emotion_refs=_prepared_pair,
            registered_speakers=set(_prepared_speaker.keys()),
            target_profiles=_target_profiles,
            profile_of=_profile_of_ref,
            # 사용자가 후보 비교 화면에서 고른 것. 잠정 제안이 사람의 선택을 덮지 않는다.
            user_selections=_prepared_selections)
        # 전수 점검을 먼저 한다 — 모델을 올린 뒤 절반 만들고 막히면 헛수고가 된다.
        ref_table.preflight([(sp, e) for e, _t, sp in parsed])
        # 라우팅 스냅샷 — 발화별 참조를 여기서(모델 로딩 전) 확정하고 작업이 끝날 때까지 바꾸지 않는다.
        _routing = ref_table.freeze_routing(parsed)
        emit("stage", stage="routing_snapshot", utterances=len(_routing),
             rules=_routing.rule_counts())
        _speaker_duplicates = ref_table.duplicate_paths()
        if _speaker_duplicates:
            # 막지 않는다(같은 목소리를 여럿에 쓰는 것은 사용자의 선택). 사실만 알린다.
            emit("stage", stage="speaker_reference_shared",
                 groups=len(_speaker_duplicates),
                 speakers=sum(len(v) for v in _speaker_duplicates.values()))
        _speaker_label_map = {}
        for sid in _prepared_speaker:
            _label = (speaker_labels or {}).get(sid)
            if _label:
                _speaker_label_map[_sr.opaque_speaker_ref(sid)] = _label

        # 사용자 프롬프트 override(식별자 기준)를 준비된 참조 '경로' 기준으로 매핑해 GPT 엔진에 전달.
        # 항상 설정(빈 dict 포함)해 이전 작업의 override가 남지 않게 한다.
        overrides_by_path = {}
        for ident, ov in (reference_prompts or {}).items():
            p = ref_cache.get(ident)
            if p and isinstance(ov, dict):
                overrides_by_path[os.path.abspath(p)] = ov
        # override가 있거나 GPT 엔진이 이미 존재할 때만 설정(없으면 굳이 인스턴스화하지 않음).
        # 이미 존재하면 빈 dict로 덮어써 이전 작업의 override 잔재를 해제.
        if overrides_by_path or "gptsovits" in _engine_cache:
            _get_engine("gptsovits").set_prompt_overrides(overrides_by_path)

        # 배치형 엔진(Qwen3) 라우팅: 한국어 Auto 우선순위 Qwen3 → GPT-SoVITS → 폴백.
        # 모델 1회 로딩으로 전 문장 처리(문장별 프로세스 금지).
        if _select_job_engine(text, preferred_engine) == "qwen3":
            # ── auto: ICL 먼저 1회 → 정렬 실패면 그 결과를 버리고 safe 로 정확히 1회 전환 ──
            # 전환을 **여기**에서 하는 이유: _synthesize_qwen_job 은 실패하면 job_dir 을 통째로 지우고
            # final_path(=synthesized.wav)에 손대지 않은 채 예외로 나온다. 즉 정렬 실패분은 이 지점에
            # 도달할 때 이미 폐기돼 있고(디스크에 남지 않고, tracks 로도 나가지 않는다), emit("result")
            # 는 아래에서 성공한 한 번만 나간다 — terminal 중복이 생길 통로가 없다.
            _auto = rc_mode == REF_CONDITIONING_AUTO
            _attempt_mode = REF_CONDITIONING_HIGH_QUALITY_ICL if _auto else rc_mode
            _icl_attempted = _attempt_mode == REF_CONDITIONING_HIGH_QUALITY_ICL
            _auto_fallback = False
            _failure_code = None
            _attempts = 1
            try:
                final_path, info = _synthesize_qwen_job(parsed, ref_cache, overrides_by_path,
                                                        output_dir, speed, silence_gap, pitch, tail_cfg,
                                                        boundary_gaps=boundary_gaps,
                                                        boundary_kinds=boundary_kinds,
                                                        reference_conditioning_mode=_attempt_mode,
                                                        ref_table=ref_table,
                                                        speaker_labels=_speaker_label_map)
            except RuntimeError as _icl_err:
                _code = (getattr(_icl_err, "error_payload", None) or {}).get("code")
                if not (_auto and _code in AUTO_FALLBACK_TRIGGER_CODES):
                    raise      # auto 가 아니거나 ICL 성립 실패가 아닌 오류 → 그대로 실패(전환 없음)
                # 전환은 여기 한 곳뿐이고 재시도 루프가 아니다. 아래 호출은 try 밖이라
                # safe 까지 실패하면 그 예외가 그대로 올라간다(2회를 넘는 시도가 구조적으로 불가능).
                _auto_fallback = True
                _failure_code = _code
                _attempt_mode = REF_CONDITIONING_SAFE_XVECTOR
                _attempts = 2
                # job_restarted: 1회차 산출물을 통째로 버리고 처음부터 다시 만든다는 **기계용** 선언.
                # Electron 감시(longform-job)는 조각 완료를 단조 원장으로 세므로, 이 신호가 없으면
                # 2회차의 같은 번호 조각들이 전부 '재전송'으로 보여 긴 작업이 무진행으로 오판돼 죽는다.
                # 사용자에게 나가는 것은 message 하나뿐이고 내부 code 는 여기 싣지 않는다.
                emit("progress", percent=5, message=REFERENCE_CONDITIONING_FALLBACK_NOTICE,
                     job_restarted=True)
                final_path, info = _synthesize_qwen_job(parsed, ref_cache, overrides_by_path,
                                                        output_dir, speed, silence_gap, pitch, tail_cfg,
                                                        boundary_gaps=boundary_gaps,
                                                        boundary_kinds=boundary_kinds,
                                                        reference_conditioning_mode=_attempt_mode,
                                                        ref_table=ref_table,
                                                        speaker_labels=_speaker_label_map)
            _rc_meta = _reference_conditioning_meta(
                rc_mode, _attempt_mode, icl_attempted=_icl_attempted,
                # 발행된 결과가 ICL 산이었을 때만 True — 전환했다면 발행된 것은 safe 결과다.
                icl_published=(_attempt_mode == REF_CONDITIONING_HIGH_QUALITY_ICL),
                auto_fallback=_auto_fallback, failure_code=_failure_code, attempts=_attempts)
            meta = _build_tts_metadata(
                requested_engine=requested_engine,
                original_reference_path=reference_audio, effective_reference_path=reference_audio,
                reference_region=None, speed=float(speed), silence_gap=float(silence_gap),
                **_rc_meta, **_plan_meta, **info)
            tracks = [{"name": "synthesized", "label": f"합성 음성 ({len(parsed)}문장)", "path": final_path}]
            _rr["status"] = "ok"
            if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
                _CONCAT_RECORDER.set_result(final_path)
                _CONCAT_RECORDER.set_run_header(
                    **{k: meta.get(k) for k in _RUN_HEADER_FROM_METADATA if k in meta})
            emit("progress", percent=99, message="완료!")
            emit("result", tracks=tracks, outputDir=output_dir, metadata=meta)
            return final_path   # C3: 호출부(separate.py)가 실제 산출물을 검증할 수 있게

        segment_paths = []
        seg_engines = []

        for i, (emotion_id, line_text, speaker_id) in enumerate(parsed):
            pct = 25 + int((i / len(parsed)) * 60)
            # 화면·Qwen 경로와 같은 표를 같은 방식으로 본다(두 경로가 다른 참조를 쓰면 안 된다).
            _frozen = getattr(ref_table, "routing", None)
            ref = (_frozen[i]["path"] if _frozen is not None and len(_frozen) == len(parsed)
                   else ref_table.resolve_with_emotion(speaker_id, emotion_id)["path"])
            emotion_label = next((k for k, v in EMOTION_TAGS.items() if v == emotion_id), emotion_id)

            # Select engine based on text language
            engine = _select_engine(line_text, preferred_engine)
            engine_name = engine.name
            seg_engines.append(engine_name)

            emit("progress", percent=pct, message=f"[{engine_name}] [{emotion_label}] {line_text[:25]}...")

            seg_path = os.path.join(output_dir, f"segment_{i+1:03d}.wav")

            if isinstance(engine, KokoroEngine):
                lang = _detect_language(line_text)
                engine.load(lang)

            engine.synthesize_segment(line_text, ref, emotion_id, speed, seg_path)
            segment_paths.append(seg_path)

        # Concatenate
        emit("progress", percent=88, message="문장 이어붙이기 중...")
        final_path = os.path.join(output_dir, "synthesized.wav")

        # 최종 후보 WAV 완성(단일=세그먼트 그대로, 복수=결합 임시본). speed는 세그먼트 합성 시 이미 반영.
        # 그 뒤 Qwen과 '동일한' 공통 최종 단계(place_final_with_pitch)로 pitch 후처리 + 원자적 배치(계약 §6.1).
        import pitch_shift as _ps
        concat_tmp = None
        try:
            if len(segment_paths) == 1:
                candidate = segment_paths[0]       # output_dir 내부 → os.replace 원자적
            else:
                concat_tmp = os.path.join(output_dir, ".synth-concat.wav")
                # 결합 직전 재검증(P0-3): 전 세그먼트가 동일 sr·mono·finite·non-empty.
                # 이 경로는 _select_engine이 **세그먼트마다** 엔진을 고르므로(ttsEngine 기본 'auto'
                # → preferred_engine None → 언어별 GPT-SoVITS/Kokoro/F5 혼재) 세그먼트 sr이 서로
                # 다를 수 있다. 두 결합 함수는 모두 **첫 파일 sr**로 전체를 기록하므로, 섞이면 뒤
                # 세그먼트가 그 sr로 재해석돼 피치·길이가 통째로 변질된다(경계에서 튄다).
                # 계측 실측(SYNTHETIC): 32000 생성분을 24000으로 기록 시 경계 F0 계단 -4.904반음
                # (이론 12*log2(24000/32000)=-4.980), 재생 길이 +33.3%, join mel 거리 0.0000→1.6723.
                # Qwen 경로(_synthesize_qwen_job)는 같은 위험에 이미 이 가드를 쓴다 — 같은 가드를
                # 이 경로에도 건다(조용한 변질 대신 명확한 중단 + 기존 synthesized.wav 보존).
                _assert_concat_ready(segment_paths)
                # I2: 경계별 gap(explicit/line/emotion). segment_paths와 boundary_gaps는 parsed 기준 1:1 정렬
                # (gaps_before[0]은 무시). 미전달 시 전 경계 silence_gap로 폴백(레거시 동치).
                if boundary_gaps is not None and len(boundary_gaps) == len(segment_paths):
                    _concat_with_boundaries(segment_paths, boundary_gaps, concat_tmp)
                else:
                    _concat_with_silence(segment_paths, concat_tmp, silence_gap)
                candidate = concat_tmp
            if _ps.clamp_quantize(pitch) != 0.0:
                emit("progress", percent=93, message=f"음높이 보정 중 ({_ps.clamp_quantize(pitch):+.1f}반음)...")
            pinfo2 = _finish_and_place(candidate, final_path, pitch, output_dir, tail_cfg)
        finally:
            # 후보/세그먼트 정리(성공 시 candidate는 os.replace로 소비됐을 수 있음). 실패 시 final_path는
            # os.replace 미도달로 기존 파일 보존. 공통 함수의 pitch 임시본은 함수가 자체 정리.
            leftovers = list(segment_paths)
            if concat_tmp:
                leftovers.append(concat_tmp)
            for p in leftovers:
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
        pitch_st2 = pinfo2["pitch_semitones"]
        pitch_method2 = pinfo2["pitch_method"]

        # per-segment(GPT-SoVITS/F5/Kokoro) 메타데이터
        import soundfile as _sf2
        try:
            out_sr = int(_sf2.info(final_path).samplerate)
        except Exception:
            out_sr = None
        default_ref = ref_cache["default"]
        ov_def = (overrides_by_path or {}).get(os.path.abspath(default_ref)) or {}
        if ov_def.get("mode") == "ref_free":
            p_src = "x-vector-only"
        elif (ov_def.get("manual_text") or "").strip():
            p_src = "manual"
        else:
            p_src = "auto"
        lang_codes2 = [_detect_language(t) for _e, t, _sp in parsed]
        tgt2 = max(set(lang_codes2), key=lang_codes2.count) if lang_codes2 else None
        engines_used = sorted(set(seg_engines))
        # qwen3를 요청했는데 per-segment로 왔으면 폴백(미설치/미선택)
        fb = (requested_engine == "qwen3")
        # GPT-SoVITS 가 실제로 어떤 device 로 돌았는지 bridge 가 보고한 값을 그대로 싣는다.
        # 여기서 추측해 채우지 않는다 — 모르면 없는 채로 둔다.
        _gsv_dev = {}
        try:
            if "gptsovits" in _engine_cache:
                _gsv_dev = dict(getattr(_engine_cache["gptsovits"], "_last_device_info", {}) or {})
        except Exception:
            _gsv_dev = {}
        meta = _build_tts_metadata(
            requested_engine=requested_engine, actual_engine=",".join(engines_used),
            device=_gsv_dev.get("actual_device"),
            device_selection_source=_gsv_dev.get("device_selection_source"),
            prompt_source=p_src,
            x_vector_only_mode=None, original_reference_path=reference_audio,
            effective_reference_path=reference_audio, reference_region=None,
            target_language=tgt2, seed=None, seed_supported=False,
            speed=float(speed), speed_postprocessed=False, silence_gap=float(silence_gap),
            fallback=fb, fallback_reason=("Qwen3 사용 불가 → 기존 엔진 폴백" if fb else None),
            elapsed_seconds=round(_time.monotonic() - _t0, 2), output_sample_rate=out_sr,
            pitch_semitones=pitch_st2, pitch_method=pitch_method2,
            pitch_postprocessed=bool(pitch_st2 != 0.0),
            # I4: 파서 plan 재현 + 말끝 finishing(pinfo2가 반환) + 경계 envelope 적용 샘플 수.
            tail_mode=pinfo2.get("tail_mode"), tail_pad_ms=pinfo2.get("tail_pad_ms"),
            tail_fade_ms=pinfo2.get("tail_fade_ms"), tail_fade_applied=pinfo2.get("tail_fade_applied"),
            # B(경계 envelope)의 적용 사실과 leak(참조 conditioning 모드)의 재현 메타를 함께 남긴다 —
            # 두 기능은 역할이 다르므로 어느 쪽도 다른 쪽을 대체하지 않는다.
            boundary_onset_samples=pinfo2.get("boundary_onset_samples"),
            boundary_offset_samples=pinfo2.get("boundary_offset_samples"),
            **{k: pinfo2.get(k) for k in _MACRO_GAIN_META_KEYS},
            # per-segment 엔진(GPT-SoVITS/F5/Kokoro)에는 controlled-prefix ICL 단계 자체가 없다 —
            # 시도도 발행도 전환도 없었다는 사실을 그대로 적는다(effective 를 임의의 구체값으로
            # 바꿔 적으면 하지 않은 일을 했다고 기록하게 된다). 무엇을 실제로 돌렸는지는
            # actual_engine 이 말한다.
            **{k: v for k, v in _gsv_dev.items()
               if k in ("requested_device", "actual_device", "fallback_reason")},
            **_reference_conditioning_meta(rc_mode, rc_mode, icl_attempted=False,
                                           icl_published=False, auto_fallback=False),
            **_plan_meta)
        tracks = [{"name": "synthesized", "label": f"합성 음성 ({len(parsed)}문장)", "path": final_path}]
        _rr["status"] = "ok"
        if _CONCAT_RECORDER is not None and _CONCAT_RECORDER.active:
            _CONCAT_RECORDER.set_result(final_path)
            _CONCAT_RECORDER.set_run_header(
                **{k: meta.get(k) for k in _RUN_HEADER_FROM_METADATA if k in meta})
        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=output_dir, metadata=meta)
        return final_path   # C3: 호출부(separate.py)가 실제 산출물을 검증할 수 있게

    finally:
        # manifest 를 **마지막에 한 번** 발행한다. 여기까지 못 오면(취소·강제 종료) 번들에는
        # run-open.json 만 남고 읽는 쪽이 INCOMPLETE 로 판정한다.
        try:
            _exc = sys.exc_info()[1]
            _st, _code = ((_rr["status"], None) if _exc is None
                          else _run_record_status_for(_exc))
            if _rr["status"] == "ok" and _exc is None:
                _st, _code = "ok", None
            _run_record_finish(_st, _code,
                               extra={"elapsed_seconds": round(_time.monotonic() - _t0, 3)})
        except Exception:
            pass                     # 기록 마감 실패가 사용자 WAV 나 원래 오류를 덮지 않는다
        for d in tmp_dirs:
            try:
                import shutil
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
