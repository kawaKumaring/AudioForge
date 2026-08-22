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
        self._venv_python = os.path.join(base_dir, "externals", "gptsovits_venv", "Scripts", "python.exe")
        self._bridge_script = os.path.join(base_dir, "python", "gptsovits_bridge.py")

        if not os.path.exists(self._venv_python):
            raise RuntimeError("GPT-SoVITS venv가 설치되지 않았습니다. externals/gptsovits_venv를 확인하세요.")

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
_QWEN_INACTIVITY_SEC = 280


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

    def run_job(self, segments, device):
        """모델 1회 로딩 후 전 세그먼트 합성. Popen으로 stdout JSON을 실시간 읽어 즉시 progress emit.
        무응답 시 프로세스 종료·정리 후 명확한 오류. 오프라인(HF_HOME 고정 + bridge local_files_only)."""
        import subprocess
        import threading
        import queue
        import json as _json
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
        while True:
            try:
                line = q.get(timeout=_QWEN_INACTIVITY_SEC)
            except queue.Empty:
                _kill_proc_tree(proc)
                raise RuntimeError(f"Qwen 무응답 {_QWEN_INACTIVITY_SEC}s 초과 — 프로세스 종료")
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
        """chunk 결과 검증(계약 B §2): 경로 job_dir 내부·original_segment_index 연속성·chunk_index 0..cc-1
        중복/누락 없음·같은 segment의 chunk_count 일치·status=ok·파일 존재/0바이트 아님·sr>0·finite."""
        import soundfile as sf
        import numpy as np
        n = len(segments)
        if not segments:
            raise RuntimeError("검증할 세그먼트 없음")
        job_dir = os.path.abspath(os.path.dirname(segments[0]["out_path"]))
        by_seg = {}   # osi -> {"cc":int, "chunks":{ci:entry}}
        for r in seg_out:
            if r.get("status") != "ok":
                raise RuntimeError(f"비정상 chunk status={r.get('status')} (seg {r.get('original_segment_index')})")
            osi = r.get("original_segment_index")
            ci = r.get("chunk_index")
            cc = r.get("chunk_count")
            if not (isinstance(osi, int) and isinstance(ci, int) and isinstance(cc, int) and cc >= 1
                    and 0 <= ci < cc):
                raise RuntimeError(f"chunk 메타 필드 이상: seg={osi} chunk={ci} count={cc}")
            gp = r.get("out_path")
            if not gp or os.path.abspath(os.path.dirname(gp)) != job_dir:
                raise RuntimeError(f"chunk 경로 job_dir 이탈: seg {osi} chunk {ci}")
            if not (os.path.exists(gp) and os.path.getsize(gp) > 0):
                raise RuntimeError(f"chunk 출력 없음/0바이트: seg {osi} chunk {ci}")
            d, sr = sf.read(gp, dtype="float32")
            if not (isinstance(sr, (int, float)) and sr > 0):
                raise RuntimeError(f"chunk sr 이상: seg {osi} chunk {ci}")
            d = np.asarray(d)
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
    """
    if preferred_engine and preferred_engine in ENGINES:
        return _get_engine(preferred_engine)

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
    qwen = _get_qwen_engine()
    if preferred_engine == "qwen3":
        if qwen.available():
            return "qwen3"
        emit("progress", percent=4, message="Qwen 미설치 → GPT-SoVITS/폴백으로 전환")
        return None
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


def _resolve_qwen_ref_text(ref_audio, overrides_by_path, warned):
    """Qwen용 (ref_text, x_vector_only) 결정 — 수동/자동/ref-free 정책 재사용.
    수동·자동 전사가 비어있지 않으면 ICL(x_vector_only=False). 명시적 ref-free / 전사 실패 / 빈 전사는
    x-vector-only(True, ref_text 무시). Qwen 공식 구현은 ref_text=""+x_vector_only=False를 거부하므로 필수."""
    from reference_transcript import transcribe_reference, MODE_REF_FREE, STATUS_OK
    ap = os.path.abspath(ref_audio)
    ov = (overrides_by_path or {}).get(ap)
    if ov:
        if ov.get("mode") == MODE_REF_FREE:
            if ("reffree", ap) not in warned:
                warned.add(("reffree", ap))
                emit("progress", percent=7,
                     message="ref-free → Qwen x-vector-only로 강등(ICL 아님, 참조 전사 미사용)")
            return "", True
        manual = (ov.get("manual_text") or "").strip()
        if manual:
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
        return _qwen_ref_text_cache[key]
    t = transcribe_reference(ref_audio, "small")
    if t.status == STATUS_OK and (t.text or "").strip():
        res = (t.text, False)
        if ("auto", ap) not in warned:
            warned.add(("auto", ap))
            emit("progress", percent=9, message=f"참조 전사(자동, ICL): {t.language}, {len(t.text)}자")
    else:
        res = ("", True)
        if ("autofail", ap) not in warned:
            warned.add(("autofail", ap))
            emit("progress", percent=9,
                 message=f"참조 전사 실패/빈 결과({t.status}) → Qwen x-vector-only로 강등(ICL 아님)")
    if len(_qwen_ref_text_cache) < _QWEN_REF_TEXT_CACHE_MAX:  # 방어적 상한
        _qwen_ref_text_cache[key] = res
    return res


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


_METADATA_KEYS = [
    "requested_engine", "actual_engine", "model_name", "model_revision", "device",
    "device_selection_source", "prompt_source", "x_vector_only_mode",
    "original_reference_path", "effective_reference_path", "reference_region",
    "reference_transcript_language", "reference_transcript_len", "reference_transcript_sha8",
    "target_language", "seed", "seed_supported", "speed", "speed_postprocessed", "silence_gap",
    "fallback", "fallback_reason", "elapsed_seconds", "output_sample_rate",
    # pitch 후처리(계약 §2.1) — pitch_method는 production에서 "rubberband" | None 둘뿐.
    "pitch_semitones", "pitch_method", "pitch_postprocessed",
    # 생성 안전장치(계약 A) — termination_reason 은 "completed_before_limit" | "generation_limit".
    # completed_before_limit 은 EOS 직접 관측이 아니라 '동적 상한 전 자연 반환'이라는 운영 상태.
    "generation_limit", "generated_iterations", "termination_reason",
    # 자동 분할(계약 B) 재현 배열 — 내용/경로/전사 없이 index·count·token·iter·사유·emotion_id만.
    "generation_chunks",
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


def _synthesize_qwen_job(parsed, ref_cache, overrides_by_path, output_dir, speed, silence_gap, pitch=0.0):
    """Qwen 배치 합성 — 2B 품질 게이트 재사용, Qwen 전용 VRAM 임계로 장치 선택(ComfyUI 병행 안전),
    모델 1회 로딩. speed: 세그먼트별 atempo 후 사용자 silence_gap으로 결합(1.0은 raw). 임시파일 finally 정리.
    pitch: 결합본(pending)에 rubberband 음높이 후처리(0=무후처리, 계약 §6·§7). 실패는 os.replace 직전
    예외 → finally가 job_dir 정리 → 기존 synthesized.wav 무손상.
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
        for i, (emotion_id, line_text) in enumerate(parsed):
            ref = ref_cache.get(emotion_id, ref_cache["default"])
            ref_text, xvo = _resolve_qwen_ref_text(ref, overrides_by_path, warned)
            lang_code = _detect_language(line_text)  # 세그먼트별 언어
            lang_codes.append(lang_code)
            lang_name = _QWEN_LANG_NAME.get(lang_code)
            if not lang_name:
                raise RuntimeError(f"Qwen 미지원 언어(감지 {lang_code}) — 문장: {line_text[:20]}")
            if ref == default_ref and def_source is None:  # 기본 참조의 메타(전문 아닌 요약)
                def_xvo = bool(xvo)
                def_source = _prompt_source_for(ref, overrides_by_path, xvo)
                def_tr_lang, def_tr_len, def_tr_sha = _transcript_meta(ref_text)
            out_path = os.path.join(job_dir, f"segment_qwen_{i + 1:03d}.wav")
            segments.append({"index": i, "text": line_text, "ref_audio": ref, "ref_text": ref_text,
                             "x_vector_only": xvo, "language_name": lang_name, "out_path": out_path,
                             "emotion_id": emotion_id})  # 태그(비민감) — bridge가 결과·오류에 반환

        try:
            try:
                seg_out = qwen.run_job(segments, device)
            except RuntimeError as e:
                # CUDA OOM만 CPU로 1회 가시적 재시도(조용한 재시도 아님). 상한 도달·그 외 예외는 전파.
                if (device == "cuda:0" and is_cuda_oom(e)
                        and not isinstance(e, QwenGenerationLimitError)):
                    emit("progress", percent=30, message="GPU 메모리 부족(OOM) → CPU로 1회 재시도(느림)")
                    fallback = True
                    fallback_reason = "CUDA OOM → CPU 재시도"
                    actual_device = "cpu"
                    seg_out = qwen.run_job(segments, "cpu")
                else:
                    raise
        except QwenGenerationLimitError as gle:
            # 상한 도달 → 잘린 WAV 미채택. 감정 ID로만 재해석(전사·문장·경로 미포함).
            # 이 예외로 place_final_with_pitch 이전에 빠져나가므로 finally가 job_dir을 지우고
            # 기존 synthesized.wav는 output_dir(=job_dir 밖)에 그대로 보존된다(원자 보존).
            si = gle.segment_index
            emo = gle.emotion_id
            if emo is None:  # bridge가 못 준 경우만 parsed로 보강(offending segment 기준)
                emo = (parsed[si][0] if isinstance(si, int) and 0 <= si < len(parsed) else "?")
            ck = f", 조각 {gle.chunk_index}" if gle.chunk_index is not None else ""
            raise RuntimeError(
                f"GENERATION_LIMIT_EXCEEDED — 감정 '{emo}' 문장{ck}이 동적 생성 상한"
                f"(max_new_tokens={gle.generation_limit})에 도달했습니다(생성 반복 {gle.generated_iterations}). "
                f"참조 오디오와 전사 내용이 맞지 않을 때 나타날 수 있습니다 — 참조 구간/전사를 확인한 뒤 다시 시도하세요."
            ) from None
        except QwenTextSegmentTooLongError as tle:
            # 자동 분할로도 상한 이내로 못 만든 줄 → 명확히 실패(내용 미포함). 기존 synthesized.wav 보존.
            si = tle.segment_index
            emo = tle.emotion_id
            if emo is None:
                emo = (parsed[si][0] if isinstance(si, int) and 0 <= si < len(parsed) else "?")
            raise RuntimeError(
                f"TEXT_SEGMENT_TOO_LONG — 감정 '{emo}' 줄이 안전한 단일 합성 길이를 초과합니다. "
                f"문장별로 나누거나 줄바꿈을 추가하세요. (production 토큰 {tle.production_tokens}, 허용 {tle.allowed})"
            ) from None

        # chunk 정렬: (original_segment_index, chunk_index). 순서 보존 = 원문 순서.
        ordered_entries = sorted(seg_out, key=lambda x: (x["original_segment_index"], x["chunk_index"]))
        ordered = [e["out_path"] for e in ordered_entries]

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
                       "termination_reason": e.get("termination_reason"), "emotion_id": e.get("emotion_id")}
                      for e in ordered_entries]

        # speed: 1.0=raw, 그 외 chunk별 atempo 후 결합.
        use = ordered
        if abs(float(speed) - 1.0) > 1e-6:
            use = [_atempo_segment(p, float(speed)) for p in ordered]  # 실패는 명확한 예외

        # gap: 자동분할 내부 chunk 사이 0초, 원래 segment(사용자 줄바꿈) 경계에만 사용자 silence_gap.
        gaps = []
        prev_osi = None
        for e in ordered_entries:
            osi = e["original_segment_index"]
            gaps.append(0.0 if (prev_osi is None or osi == prev_osi) else float(silence_gap))
            prev_osi = osi

        emit("progress", percent=90, message="문장 이어붙이기 중...")
        _concat_with_boundaries(use, gaps, pending_path)  # 내부 0 / 원 segment 경계 silence_gap

        # 공통 최종 단계(계약 §6.1): pitch(후처리 축)를 speed·결합이 끝난 최종 후보에 적용하고
        # 원자적으로 synthesized.wav에 배치. 검증·os.replace·실패격리(기존 wav 무손상)는 공통 함수가 책임.
        # 0=무호출(바이트 불변). rubberband 부재+pitch!=0 → PITCH_UNAVAILABLE 예외(조용한 폴백 없음).
        import pitch_shift as _ps
        if _ps.clamp_quantize(pitch) != 0.0:
            emit("progress", percent=93, message=f"음높이 보정 중 ({_ps.clamp_quantize(pitch):+.1f}반음)...")
        # pending은 job_dir 내부(output_dir 하위) → os.replace가 동일 파일시스템 원자 이동.
        pinfo = _ps.place_final_with_pitch(pending_path, final_path, pitch, job_dir)
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
            "seed": None, "seed_supported": False,
            "speed_postprocessed": bool(abs(float(speed) - 1.0) > 1e-6),
            "fallback": fallback, "fallback_reason": fallback_reason,
            "elapsed_seconds": round(_time.monotonic() - t_start, 2), "output_sample_rate": int(sr),
            "pitch_semitones": pinfo["pitch_semitones"], "pitch_method": pinfo["pitch_method"],
            "pitch_postprocessed": pinfo["pitch_postprocessed"],
            "generation_limit": meta_gen_limit, "generated_iterations": meta_gen_iters,
            "termination_reason": meta_term, "generation_chunks": gen_chunks,
        }
        return final_path, info
    finally:
        # 실행별 폴더 전체 삭제(정상/오류 공통). 성공 시 pending은 이미 replace로 빠져나갔고 나머지 중간물만 남음.
        # 기존 synthesized.wav·다른 작업 결과는 job_dir 밖이라 절대 건드리지 않는다.
        shutil.rmtree(job_dir, ignore_errors=True)


# ── Helpers ──

def _parse_line(line):
    match = re.match(r'^\[([^\]]+)\]\s*(.+)', line.strip())
    if match:
        tag = match.group(1).strip()
        text = match.group(2).strip()
        return EMOTION_TAGS.get(tag, "default"), text
    return "default", line.strip()


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


def _concat_with_boundaries(paths, gaps_before, output_path):
    """paths를 순서대로 이어붙이되 각 항목 '앞'에 gaps_before[i]초 무음 삽입(계약 B).
    자동분할 내부 chunk 사이 gap=0(연속), 원래 segment 경계에만 사용자 silence_gap. gaps_before[0]은 0.
    무음은 각 파일 sr 기준(첫 파일 sr을 target으로 사용). 무작위 무음 삽입 아님 — 호출부가 경계에서만 지정."""
    import soundfile as sf
    import numpy as np
    if len(paths) != len(gaps_before):
        raise RuntimeError("concat: paths와 gaps 길이 불일치")
    out = []
    target_sr = None
    for i, path in enumerate(paths):
        data, sr = sf.read(path, dtype="float32")
        if target_sr is None:
            target_sr = sr
        g = float(gaps_before[i])
        if i > 0 and g > 0:
            out.append(np.zeros(int(g * target_sr), dtype=np.float32))
        out.append(data)
    combined = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
    sf.write(output_path, combined, target_sr)


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
               emotion_refs=None, emotion_ref_sources=None, preferred_engine=None, reference_prompts=None, pitch=0.0):
    """Synthesize speech. Auto-selects engine by language.
    reference_prompts: 식별자(default/emotionId) → {manual_text, prompt_lang, mode} 사용자 override.
    emotion_refs: emotionId → 합성에 쓸 effective 참조 경로(3~10초 클립/유효 원본).
    emotion_ref_sources: emotionId → 사용자 등록 원본 경로(등록 사실). 만료 판정 기준(계약 §5).
    pitch: 결과 WAV 음높이 보정(반음, 후처리 축). 0=무후처리. 정규화 권위는 pitch_shift.clamp_quantize."""
    emit("status", message="음성 합성 시작", percent=0)

    if not emotion_refs:
        emotion_refs = {}
    if not emotion_ref_sources:
        emotion_ref_sources = {}

    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if not lines:
        emit("error", message="합성할 텍스트가 없습니다.")
        return

    import time as _time
    _t0 = _time.monotonic()
    requested_engine = preferred_engine or "auto"
    parsed = [_parse_line(l) for l in lines]
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
        used_emotion_ids = {eid for eid, _ in parsed if eid != "default"}
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
            final_path, info = _synthesize_qwen_job(parsed, ref_cache, overrides_by_path,
                                                    output_dir, speed, silence_gap, pitch)
            meta = _build_tts_metadata(
                requested_engine=requested_engine,
                original_reference_path=reference_audio, effective_reference_path=reference_audio,
                reference_region=None, speed=float(speed), silence_gap=float(silence_gap), **info)
            tracks = [{"name": "synthesized", "label": f"합성 음성 ({len(parsed)}문장)", "path": final_path}]
            emit("progress", percent=99, message="완료!")
            emit("result", tracks=tracks, outputDir=output_dir, metadata=meta)
            return

        segment_paths = []
        seg_engines = []

        for i, (emotion_id, line_text) in enumerate(parsed):
            pct = 25 + int((i / len(parsed)) * 60)
            ref = ref_cache.get(emotion_id, ref_cache["default"])
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
        if len(segment_paths) == 1:
            candidate = segment_paths[0]           # output_dir 내부 → os.replace 원자적
            concat_tmp = None
        else:
            concat_tmp = os.path.join(output_dir, ".synth-concat.wav")
            _concat_with_silence(segment_paths, concat_tmp, silence_gap)
            candidate = concat_tmp
        try:
            if _ps.clamp_quantize(pitch) != 0.0:
                emit("progress", percent=93, message=f"음높이 보정 중 ({_ps.clamp_quantize(pitch):+.1f}반음)...")
            pinfo2 = _ps.place_final_with_pitch(candidate, final_path, pitch, output_dir)
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
        lang_codes2 = [_detect_language(t) for _, t in parsed]
        tgt2 = max(set(lang_codes2), key=lang_codes2.count) if lang_codes2 else None
        engines_used = sorted(set(seg_engines))
        # qwen3를 요청했는데 per-segment로 왔으면 폴백(미설치/미선택)
        fb = (requested_engine == "qwen3")
        meta = _build_tts_metadata(
            requested_engine=requested_engine, actual_engine=",".join(engines_used),
            device=None, device_selection_source=None, prompt_source=p_src,
            x_vector_only_mode=None, original_reference_path=reference_audio,
            effective_reference_path=reference_audio, reference_region=None,
            target_language=tgt2, seed=None, seed_supported=False,
            speed=float(speed), speed_postprocessed=False, silence_gap=float(silence_gap),
            fallback=fb, fallback_reason=("Qwen3 사용 불가 → 기존 엔진 폴백" if fb else None),
            elapsed_seconds=round(_time.monotonic() - _t0, 2), output_sample_rate=out_sr,
            pitch_semitones=pitch_st2, pitch_method=pitch_method2,
            pitch_postprocessed=bool(pitch_st2 != 0.0))
        tracks = [{"name": "synthesized", "label": f"합성 음성 ({len(parsed)}문장)", "path": final_path}]
        emit("progress", percent=99, message="완료!")
        emit("result", tracks=tracks, outputDir=output_dir, metadata=meta)

    finally:
        for d in tmp_dirs:
            try:
                import shutil
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
