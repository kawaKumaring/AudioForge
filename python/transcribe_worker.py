"""Whisper transcription + NLLB-200 translation."""

import os
from audio_utils import emit, fmt_time, fmt_srt_time, get_device

# Whisper language code → NLLB-200 language code
LANG_TO_NLLB = {
    "ja": "jpn_Jpan", "en": "eng_Latn", "zh": "zho_Hans", "ko": "kor_Hang",
    "fr": "fra_Latn", "de": "deu_Latn", "es": "spa_Latn", "it": "ita_Latn",
    "pt": "por_Latn", "ru": "rus_Cyrl", "ar": "arb_Arab", "th": "tha_Thai",
    "vi": "vie_Latn", "id": "ind_Latn", "tr": "tur_Latn", "nl": "nld_Latn",
    "pl": "pol_Latn", "sv": "swe_Latn", "da": "dan_Latn", "fi": "fin_Latn",
    "cs": "ces_Latn", "ro": "ron_Latn", "hu": "hun_Latn", "el": "ell_Grek",
    "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml", "uk": "ukr_Cyrl",
}

# NLLB 모델 선택: 600M(기본, 가벼움) / 1.3B(고품질, ~5GB·VRAM↑)
_NLLB_MODELS = {
    "600m": "facebook/nllb-200-distilled-600M",
    "1.3b": "facebook/nllb-200-distilled-1.3B",
}
_DEFAULT_NLLB = _NLLB_MODELS["600m"]

# NLLB model cache (name = 현재 로드된 모델 이름)
_nllb_cache = {"model": None, "tokenizer": None, "src_lang": None, "name": _DEFAULT_NLLB}


def set_nllb_model(size):
    """번역 모델 크기 지정 ('600m'/'1.3b'). 바뀌면 캐시 무효화."""
    name = _NLLB_MODELS.get((size or "600m").lower(), _DEFAULT_NLLB)
    if _nllb_cache.get("name") != name:
        _nllb_cache.update({"model": None, "tokenizer": None, "src_lang": None, "name": name})


# ── 번역 백엔드 선택 (NLLB / 로컬 LLM) ──────────────────────────────────────
# LLM 백엔드: 이미 설치된 transformers+torch를 그대로 재사용 (새 venv/빌드/설치 없음).
# NLLB-600M보다 구어체·문맥 번역이 낫지만 느리고 VRAM을 더 쓴다. 기본은 NLLB 유지.
_QWEN_MODEL = "Qwen/Qwen2.5-3B-Instruct"
_LLM_BACKEND_VALUES = {"llm", "qwen", "qwen3b", "qwen2.5-3b"}
_translate_backend = {"mode": "nllb"}

# LLM 프롬프트용 소스 언어 한국어 이름 (없으면 코드 그대로)
_LANG_KO_NAME = {
    "ja": "일본어", "en": "영어", "zh": "중국어", "fr": "프랑스어", "de": "독일어",
    "es": "스페인어", "it": "이탈리아어", "pt": "포르투갈어", "ru": "러시아어",
    "th": "태국어", "vi": "베트남어", "id": "인도네시아어", "tr": "터키어",
}


def set_translate_model(value):
    """번역 백엔드/모델 선택. 'google' → 구글(네트워크), 'llm'/'qwen3b' → 로컬 LLM,
    그 외 → NLLB(600m/1.3b)."""
    v = (value or "600m").lower()
    if v == "google":
        _translate_backend["mode"] = "google"
    elif v in _LLM_BACKEND_VALUES:
        _translate_backend["mode"] = "llm"
    else:
        _translate_backend["mode"] = "nllb"
        set_nllb_model(v)

HF_ROOT_ENV = "AUDIOFORGE_HF_ROOT"


class OptionalModelNotInstalled(Exception):
    """사용자가 고를 수 있는 모델인데 어디에도 설치돼 있지 않다.

    조용히 인터넷에서 받아 오지 않는다 — 그건 오프라인 계약을 깨고, 사용자는 수 GB 가
    받아지는 줄도 모른 채 기다리게 된다. 어떤 모델이 왜 없는지 알려주고 멈춘다."""

    def __init__(self, repo_id, searched):
        self.repo_id = repo_id
        self.searched = searched
        super().__init__("OPTIONAL_MODEL_NOT_INSTALLED: %s" % repo_id)


def hf_model_root():
    """앱이 관리하는 HF 형식 모델 위치(externals). 전역 캐시와 분리한다."""
    override = os.environ.get(HF_ROOT_ENV)
    if override:
        return os.path.abspath(override)
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import app_runtime
        return os.path.join(app_runtime.assets_root(), "hf_models")
    except Exception:
        return os.path.join(os.path.dirname(here), "externals", "hf_models")


def _hub_dir_name(repo_id):
    return "models--" + repo_id.replace("/", "--")


def resolve_hf_cache_dir(repo_id):
    """(cache_dir, source) — from_pretrained 에 넘길 캐시 루트를 **명시**한다.

    1) 앱 관리 위치에 해당 repo 가 있으면 그것
    2) 없으면 기존 전역 캐시에 **이미 있는** repo 만 사용(다운로드 아님)
    3) 둘 다 없으면 OptionalModelNotInstalled — 자동 다운로드 금지
    전역 캐시는 다른 앱 소유일 수 있으므로 읽기만 하고 건드리지 않는다.
    """
    # cache_dir 는 `models--*` 를 **직접** 담은 디렉터리다(= HUGGINGFACE_HUB_CACHE).
    # 그 부모(HF_HOME)를 넘기면 transformers 가 못 찾고 네트워크로 나간다.
    name = _hub_dir_name(repo_id)
    searched = []
    internal = hf_model_root()
    for cand in (os.path.join(internal, "hub"), internal):
        searched.append(cand)
        if os.path.isdir(os.path.join(cand, name)):
            return cand, "internal"
    hf_home = os.environ.get("HF_HOME")
    legacy = (os.path.join(hf_home, "hub") if hf_home
              else os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"))
    searched.append(legacy)
    if os.path.isdir(os.path.join(legacy, name)):
        return legacy, "external_cache"
    raise OptionalModelNotInstalled(repo_id, searched)


# Whisper model cache
_whisper_cache = {"model": None, "name": None, "source": None, "root": None}


WHISPER_ROOT_ENV = "AUDIOFORGE_WHISPER_ROOT"


class WhisperModelMissing(Exception):
    """요청한 Whisper 모델 파일이 내부에도 기존 캐시에도 없다.

    예전에는 이 상황에서 whisper 가 조용히 인터넷에서 내려받았다. 오프라인 계약이 있는
    앱에서 그건 '성공' 이 아니라 숨은 네트워크 의존이므로, 이제 명시적으로 실패한다."""


def whisper_model_root():
    """앱이 소유한 Whisper 가중치 위치. externals 는 이미 모델의 집이다."""
    override = os.environ.get(WHISPER_ROOT_ENV)
    if override:
        return os.path.abspath(override)
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import app_runtime
        return os.path.join(app_runtime.assets_root(), "whisper_models")
    except Exception:
        return os.path.join(os.path.dirname(here), "externals", "whisper_models")


def resolve_whisper_root(model_name):
    """(download_root, source) — 어디서 온 가중치인지 숨기지 않는다.

    1) 앱 내부(externals/whisper_models)에 <이름>.pt 가 있으면 그것.
    2) 없으면 기존 전역 캐시에 **이미 존재하는** 파일만 쓴다(다운로드 아님).
    3) 둘 다 없으면 WhisperModelMissing — 조용히 내려받지 않는다.
    """
    fn = "%s.pt" % model_name
    internal = whisper_model_root()
    if os.path.isfile(os.path.join(internal, fn)):
        return internal, "internal"
    legacy = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    if os.path.isfile(os.path.join(legacy, fn)):
        return legacy, "external_cache"
    raise WhisperModelMissing(
        "WHISPER_MODEL_MISSING: %s — 내부 모델 위치에도 기존 캐시에도 없습니다. "
        "자동 다운로드는 하지 않습니다." % fn)


def _get_whisper_model(model_name="large-v3"):
    """Load or reuse cached Whisper model.

    download_root 를 **명시 전달**한다. 예전에는 인자를 주지 않아 whisper 가 ~/.cache 를
    조용히 뒤지고 없으면 내려받았다 — 오프라인 검증이 불가능한 구조였다."""
    import whisper
    import torch
    if _whisper_cache["model"] is None or _whisper_cache["name"] != model_name:
        root, source = resolve_whisper_root(model_name)
        device = get_device(timeout_sec=10)
        _whisper_cache["model"] = whisper.load_model(model_name, device=device, download_root=root)
        _whisper_cache["name"] = model_name
        _whisper_cache["source"] = source
        _whisper_cache["root"] = root
    return _whisper_cache["model"]


def _norm_lang(lang):
    """Normalize a UI language value to a Whisper code or None (auto-detect)."""
    if not lang or lang in ("auto", "none", ""):
        return None
    return lang


def _emit_silence_shadow(rms_values, durations, raw_legacy_kept, threshold):
    """무음 게이트 shadow 관측(Phase 1) — canonical apply_silence_policy '후보'를
    legacy 결과와 카운트만 비교해 emit 한다. **관측 전용**: 실제 keep/drop 은
    _filter_silent_segments 의 legacy 로직이 그대로 결정하며, 이 함수는 어떤 것도
    바꾸지 않는다(threshold 불변). payload 는 안전한 정수/불리언만 — 전사 본문·경로
    미포함. 실패해도 전사·출력에 영향 없음(unavailable 상태만 emit)."""
    try:
        import asr_canonical as ac
        n = len(rms_values)
        legacy_guard = raw_legacy_kept < n * 0.4
        legacy_kept = n if legacy_guard else raw_legacy_kept
        # 정책 후보는 legacy 와 동일한 (rms, 0길이=측정불가) 입력으로 계산 —
        # 카운트가 일치해야(agreement=True) 배선 전 정합이 확인된다.
        dec = ac.apply_silence_policy(rms_values, threshold=threshold, durations=durations)
        emit("asrSilenceShadow",
             segmentCount=int(n),
             legacyKept=int(legacy_kept),
             policyKept=int(dec.kept_count),
             guardTriggered=bool(dec.guard_tripped),
             agreement=bool(legacy_kept == dec.kept_count
                            and legacy_guard == dec.guard_tripped),
             thresholdSnapshot=float(threshold))
    except Exception:
        # shadow 실패는 비치명적 — 관측만, 결정에 영향 없음. 안전 코드만 노출.
        emit("asrSilenceShadow", status="unavailable")


def _filter_silent_segments(result, audio_path, rms_threshold=0.005):
    """무음 구간에 지어낸 환각 세그먼트 제거(에너지 게이트).
    각 세그먼트 구간의 실제 오디오 RMS가 임계 미만(=사실상 무음)이면 버린다.
    분리된 보컬 스템은 노래 없는 구간이 실제로 무음이라, 거기 전사된 텍스트('시청 감사'
    류 아웃로 등)는 환각으로 간주. 측정: 진짜 무음 RMS≈0.0002 ≪ 실제 가사 RMS≈0.11 →
    임계 0.005는 양쪽에서 20배 이상 여유. 진짜 말/노래는 임계를 훨씬 넘어 안전.
    과삭제 방지 가드: 세그먼트의 60% 초과를 지우게 되면(레벨 이상 의심) 필터를 건너뛴다."""
    segs = result.get("segments") or []
    if not segs:
        return result
    try:
        import soundfile as sf
        import numpy as np
        data, sr = sf.read(audio_path, dtype="float32")
    except Exception:
        return result  # 측정 불가 시 원본 유지(안전)
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    total = len(data)
    kept = []
    shadow_rms = []    # shadow 관측용: 세그먼트별 RMS(측정 불가=None)
    shadow_dur = []    # shadow 관측용: 측정가능=1.0 / 0길이(b<=a)=0.0 (legacy 정합)
    for s in segs:
        a = int(max(0.0, s.get("start", 0.0)) * sr)
        b = int(min(total / sr, s.get("end", 0.0)) * sr)
        if b <= a:
            kept.append(s)
            shadow_rms.append(None)
            shadow_dur.append(0.0)
            continue
        seg = data[a:b]
        rms = float(np.sqrt(np.mean(seg ** 2)))
        shadow_rms.append(rms)
        shadow_dur.append(1.0)
        if rms >= rms_threshold:
            kept.append(s)
    # shadow 관측(카운트 비교만, 결정 미변경) — legacy 의 실제 keep 수(raw)를 넘긴다.
    _emit_silence_shadow(shadow_rms, shadow_dur, len(kept), rms_threshold)
    # 과삭제 가드: 너무 많이 지우면(레벨 스케일 이상) 원본 유지
    if len(kept) < len(segs) * 0.4:
        return result
    if len(kept) != len(segs):
        result["segments"] = kept
        result["text"] = "".join(s.get("text", "") for s in kept).strip()
    return result


def run_transcribe(model, audio_path, language=None):
    """Whisper 전사 — 분리/무음이 많은 트랙의 환각을 억제한 공통 호출부.

    환각(hallucination) 억제 3중 장치:
    - condition_on_previous_text=False: 이전 문장을 조건으로 쓰지 않아 무음/연주
      구간에서 같은 문장이 반복되는 대표적 환각을 억제.
    - word_timestamps=True + hallucination_silence_threshold: 단어 단위 타임스탬프로
      무음 구간을 식별해, 무음(>2초) 위에 지어낸 상투 자막('작사·작곡…', '시청 감사합니다'
      류)을 폐기한다. 음악 모드는 보컬 스템만 전사하므로 인트로/아웃로가 실제로
      거의 무음 → 이 장치가 특히 잘 듣는다.
    - no_speech/logprob 임계는 whisper 기본값(0.6 / -1.0)을 그대로 쓴다.

    language: None이면 자동 감지, 코드(예: 'ja')를 주면 강제 — 짧은 클립의
    언어 오판(일본어 노래를 영어로 감지 등) 방지.
    """
    result = model.transcribe(
        audio_path,
        language=_norm_lang(language),
        task="transcribe",
        verbose=False,
        condition_on_previous_text=False,
        word_timestamps=True,
        hallucination_silence_threshold=2.0,
    )
    # 에너지 게이트: 무음 구간의 잔존 환각(아웃로 '시청 감사' 등) 제거.
    # hallucination_silence_threshold가 못 잡는, 옅게 깔린 무음 위 환각까지 걸러낸다.
    return _filter_silent_segments(result, audio_path)


# NLLB max_length=512 대비: 한 문장이 이보다 길면 잘린 만큼 조용히 유실되므로
# CJK 문장부호로도 분리하고, 그래도 긴 문장은 하드 청크로 나눈다 (CJK ≈ 1char/token)
_MAX_SENT_CHARS = 400


def _split_sentences(text: str):
    """Split text into translation units. Handles CJK punctuation (。！？)
    that '. '-splitting misses; hard-chunks oversized sentences."""
    import re
    raw = re.split(r'(?<=[。．！？])\s*|(?<=[.!?])\s+|\n+', text)
    sentences = []
    for sent in raw:
        sent = sent.strip() if sent else ''
        if not sent:
            continue
        while len(sent) > _MAX_SENT_CHARS:
            cut = sent.rfind(' ', _MAX_SENT_CHARS // 2, _MAX_SENT_CHARS)
            if cut == -1:
                cut = _MAX_SENT_CHARS  # no space (CJK) — hard cut
            sentences.append(sent[:cut].strip())
            sent = sent[cut:].strip()
        if sent:
            sentences.append(sent)
    return sentences


def translate_to_korean(text: str, src_lang: str):
    """소스 언어 텍스트를 한국어로 번역. 백엔드(NLLB/LLM/구글)는 set_translate_model로 선택."""
    if src_lang == "ko":
        return text
    mode = _translate_backend["mode"]
    if mode == "google":
        return _translate_google(text, src_lang) or _translate_nllb(text, src_lang)
    if mode == "llm":
        return _translate_llm(text, src_lang)
    return _translate_nllb(text, src_lang)


# ── 구글 번역 백엔드 (비공식 무료 엔드포인트, 네트워크 필요·API키 불필요) ──────────
# 공식이 아니므로 막히거나 레이트리밋될 수 있다 → 실패 시 None 반환, 상위에서 NLLB 폴백.
# 전사 텍스트가 구글로 전송됨(프라이버시). 사용자가 'google' 백엔드를 명시 선택할 때만 작동.
_GOOGLE_LANG = {"zh": "zh-CN"}  # 구글 코드가 다른 것만 매핑, 나머지는 whisper 코드 그대로


def _translate_google(text: str, src_lang: str):
    """구글 무료 엔드포인트로 한국어 번역. 실패 시 None."""
    if not text or not text.strip():
        return text
    try:
        import requests
    except ImportError:
        return None
    sl = _GOOGLE_LANG.get(src_lang, src_lang or "auto")
    try:
        r = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": sl, "tl": "ko", "dt": "t", "q": text},
            headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        r.raise_for_status()
        data = r.json()
        parts = [seg[0] for seg in data[0] if seg and seg[0]]
        out = "".join(parts).strip()
        return out or None
    except Exception:
        return None


def _translate_segments_google(segments, src_lang):
    """세그먼트별 구글 번역(1:1 정합). 실패한 세그먼트만 NLLB 폴백."""
    out = []
    for s in segments:
        if not s.strip():
            out.append("")
            continue
        g = _translate_google(s, src_lang)
        if g is None:
            g = _translate_nllb(s, src_lang) or ""  # 네트워크 실패/차단 시 로컬 폴백
        out.append(g)
    return out


# ── LLM 번역 백엔드 (Qwen2.5-3B-Instruct) ───────────────────────────────────
_llm_cache = {"model": None, "tokenizer": None, "name": None}
# 여러 문장을 한 번에 넘겨 문맥을 살리고 generate 호출 수를 줄인다 (CJK ≈ 1char/token)
_LLM_CHUNK_CHARS = 1200


def _get_llm(model_name):
    """로컬 LLM 로드/재사용. transformers+torch(설치됨)만 사용 — 새 의존성 없음."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    if _llm_cache["model"] is None or _llm_cache["name"] != model_name:
        device = get_device(timeout_sec=10)
        emit("progress", percent=72,
             message=f"LLM 번역 모델 로딩 중... ({model_name.split('/')[-1]}, 최초 1회 대용량 다운로드)")
        tok = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForCausalLM.from_pretrained(
            model_name, torch_dtype=torch.bfloat16).to(device)
        model.eval()
        _llm_cache.update({"model": model, "tokenizer": tok, "name": model_name})
    return _llm_cache["model"], _llm_cache["tokenizer"]


def _llm_chunks(sentences):
    """문장 리스트를 _LLM_CHUNK_CHARS 이하 블록으로 묶는다."""
    chunks, cur, cur_len = [], [], 0
    for s in sentences:
        if cur and cur_len + len(s) > _LLM_CHUNK_CHARS:
            chunks.append("\n".join(cur))
            cur, cur_len = [], 0
        cur.append(s)
        cur_len += len(s) + 1
    if cur:
        chunks.append("\n".join(cur))
    return chunks


def _translate_llm(text: str, src_lang: str):
    """로컬 LLM으로 한국어 번역. 그리디 디코딩(결정적) + 번역문만 추출."""
    import torch
    model, tok = _get_llm(_QWEN_MODEL)
    device = next(model.parameters()).device
    src_name = _LANG_KO_NAME.get(src_lang, src_lang)
    system = ("당신은 전문 번역가입니다. 주어진 텍스트를 자연스러운 한국어 구어체로 "
              "번역하세요. 줄바꿈 구조는 유지하고, 번역 결과만 출력하세요. "
              "설명·주석·원문·따옴표를 덧붙이지 마세요.")

    out_parts = []
    for chunk in _llm_chunks(_split_sentences(text)):
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"다음 {src_name} 텍스트를 한국어로 번역:\n\n{chunk}"},
        ]
        prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tok(prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            gen = model.generate(**inputs, max_new_tokens=1024, do_sample=False,
                                 repetition_penalty=1.05,
                                 pad_token_id=tok.eos_token_id)
        new_tokens = gen[0][inputs["input_ids"].shape[1]:]
        out = tok.decode(new_tokens, skip_special_tokens=True).strip()
        if out:
            out_parts.append(out)

    return "\n".join(out_parts) if out_parts else None


# ── 세그먼트(타임라인) 번역 — 1:1 정합 유지 ──────────────────────────────────
# 타임라인은 각 세그먼트가 정확히 한 줄로 대응돼야 한다. 예전엔 줄마다 따로 번역해
# 조각(예: "異郷の月")마다 문맥이 없어 소형 LLM이 중국어·영어를 섞는 문제가 있었다.
# 이제 전 세그먼트를 '한 번에' 번역(문맥 확보)하고 번호로 되돌린다.
_LLM_SEG_SYSTEM = (
    "당신은 전문 자막 번역가입니다. 입력은 '번호. 원문' 형식의 여러 줄입니다. "
    "각 줄을 자연스러운 한국어 구어체로 번역하되, 반드시 '번호. 번역' 형식으로 "
    "입력과 같은 번호·같은 줄 수로만 출력하세요. 반드시 한국어(한글)로만 쓰고, "
    "한자·일본어 가나·영어 원문을 남기지 마세요. 설명·따옴표·원문을 덧붙이지 마세요."
)


def _seg_chunks(segments):
    """세그먼트 인덱스를 _LLM_CHUNK_CHARS 문자 예산 이하 청크로 묶는다."""
    chunks, cur, cur_len = [], [], 0
    for idx, s in enumerate(segments):
        if cur and cur_len + len(s) > _LLM_CHUNK_CHARS:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(idx)
        cur_len += len(s) + 8  # "NN. " 번호 오버헤드 여유
    if cur:
        chunks.append(cur)
    return chunks


def _translate_segments_llm(segments, src_lang):
    """세그먼트 리스트를 LLM으로 '한 번에'(청크 단위) 번역. 번호로 1:1 되돌림.
    줄 수/번호가 어긋나면 그 청크만 세그먼트별 NLLB 폴백(언어 혼입·유실 방지)."""
    import torch
    import re
    model, tok = _get_llm(_QWEN_MODEL)
    device = next(model.parameters()).device
    src_name = _LANG_KO_NAME.get(src_lang, src_lang)
    out = [""] * len(segments)

    for chunk in _seg_chunks(segments):
        numbered = "\n".join(f"{n + 1}. {segments[gi]}" for n, gi in enumerate(chunk))
        messages = [
            {"role": "system", "content": _LLM_SEG_SYSTEM},
            {"role": "user", "content": f"다음 {src_name} 자막을 한국어로 번역:\n\n{numbered}"},
        ]
        prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tok(prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            gen = model.generate(**inputs, max_new_tokens=2048, do_sample=False,
                                 repetition_penalty=1.05, pad_token_id=tok.eos_token_id)
        text = tok.decode(gen[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()

        parsed = {}
        for line in text.splitlines():
            m = re.match(r'^\s*(\d+)\s*[.)]\s*(.*)$', line)
            if m:
                parsed[int(m.group(1))] = m.group(2).strip()

        if len(parsed) == len(chunk) and all((n + 1) in parsed for n in range(len(chunk))):
            for n, gi in enumerate(chunk):
                out[gi] = parsed[n + 1]
        else:
            # 정합 실패 → 안전하게 세그먼트별 NLLB로 폴백 (코드 스위칭 없는 결과 보장)
            for gi in chunk:
                seg = segments[gi]
                out[gi] = (_translate_nllb(seg, src_lang) or seg) if seg.strip() else ""

    # 잔재 글자 수리: LLM이 문장은 옮겼어도 원문 한 글자(한자/가나)를 베끼는 경우가 있다.
    # 그런 줄만 NLLB로 재번역(NLLB는 JA→KO 혼입 없음). 깨끗한 줄은 LLM 그대로 둔다.
    _cjk = re.compile(r'[一-鿿぀-ヿ]')
    for i, seg in enumerate(segments):
        if out[i] and _cjk.search(out[i]) and seg.strip():
            fixed = _translate_nllb(seg, src_lang)
            if fixed and not _cjk.search(fixed):
                out[i] = fixed
    return out


def translate_segments_to_korean(segments, src_lang):
    """세그먼트 리스트를 1:1 매핑 유지하며 한국어로 번역(타임라인용).
    - ko: 그대로. - 구글: 세그먼트별(실패 시 NLLB 폴백).
    - NLLB: 세그먼트별(짧은 조각에도 안정적, 코드 스위칭 없음).
    - LLM: 번호 매겨 한 번에 번역 후 번호로 되돌림(문맥 확보) + 잔재 글자 NLLB 수리."""
    if src_lang == "ko":
        return list(segments)
    mode = _translate_backend["mode"]
    if mode == "google":
        return _translate_segments_google(segments, src_lang)
    if mode == "llm":
        return _translate_segments_llm(segments, src_lang)
    return [((_translate_nllb(s, src_lang) or "") if s.strip() else "") for s in segments]


def _translate_nllb(text: str, src_lang: str):
    """Translate text to Korean using NLLB-200 with GPU acceleration."""
    nllb_src = LANG_TO_NLLB.get(src_lang)
    if not nllb_src:
        return None

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    import torch

    device = get_device(timeout_sec=10)
    model_name = _nllb_cache.get("name") or _DEFAULT_NLLB

    if _nllb_cache["model"] is None or _nllb_cache["src_lang"] != nllb_src:
        emit("progress", percent=72, message=f"번역 모델 로딩 중... ({model_name.split('-')[-1]})")
        # cache_dir 를 명시하지 않으면 전역 캐시를 조용히 뒤지고 없으면 내려받는다.
        cdir, csrc = resolve_hf_cache_dir(model_name)
        _nllb_cache["source"] = csrc
        _nllb_cache["tokenizer"] = AutoTokenizer.from_pretrained(
            model_name, src_lang=nllb_src, cache_dir=cdir, local_files_only=True)
        if _nllb_cache["model"] is None:
            _nllb_cache["model"] = AutoModelForSeq2SeqLM.from_pretrained(
                model_name, cache_dir=cdir, local_files_only=True).to(device)
        _nllb_cache["src_lang"] = nllb_src

    tokenizer = _nllb_cache["tokenizer"]
    model = _nllb_cache["model"]
    kor_id = tokenizer.convert_tokens_to_ids("kor_Hang")

    sentences = _split_sentences(text)
    translated_parts = []

    for sent in sentences:
        inputs = tokenizer(sent, return_tensors="pt", truncation=True, max_length=512).to(device)
        with torch.no_grad():
            output = model.generate(**inputs, forced_bos_token_id=kor_id, max_length=512)
        translated_parts.append(tokenizer.batch_decode(output, skip_special_tokens=True)[0])

    return " ".join(translated_parts)


def write_translation_timeline(output_dir, base, src_lang):
    """세그먼트별 타임라인 번역 파일 생성: {base}_korean_timeline.txt.
    {base}_timestamps.txt(전사 타임라인)를 읽어, 전 세그먼트를 '한 번에' 번역한 뒤
    타임스탬프에 되돌려 붙인다. (예전엔 줄마다 따로 번역 → 문맥이 없어 소형 LLM이
    조각마다 중국어·영어를 섞는 문제가 있었다.) 현재 백엔드(set_translate_model)를
    그대로 사용. timestamps 없으면 None."""
    import re
    ts_path = os.path.join(output_dir, f"{base}_timestamps.txt")
    if not os.path.exists(ts_path):
        return None
    with open(ts_path, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f if ln.strip()]

    # 각 줄을 (스탬프, 원문) 또는 비정형(passthrough)으로 분해
    stamps, texts, passthrough = [], [], []
    for line in lines:
        m = re.match(r'^(\[[^\]]*\])\s*(.*)$', line)
        if m:
            stamps.append(m.group(1))
            texts.append(m.group(2).strip())
            passthrough.append(None)
        else:
            stamps.append(None)
            texts.append(None)
            passthrough.append(line)

    # 실제 텍스트가 있는 세그먼트만 모아 한 번에 번역 (1:1 정합 유지)
    idxs = [i for i, t in enumerate(texts) if t]
    emit("progress", percent=97, message=f"타임라인 번역 {len(idxs)}개 세그먼트")
    if src_lang == "ko":
        translated = {i: texts[i] for i in idxs}
    else:
        tr_list = translate_segments_to_korean([texts[i] for i in idxs], src_lang)
        translated = {i: (tr_list[k] or "") for k, i in enumerate(idxs)}

    out_lines = []
    for i in range(len(stamps)):
        if passthrough[i] is not None:
            out_lines.append(passthrough[i])
        elif texts[i]:
            out_lines.append(f"{stamps[i]} {translated.get(i, '')}".rstrip())
        else:
            out_lines.append(stamps[i])

    tl_path = os.path.join(output_dir, f"{base}_korean_timeline.txt")
    with open(tl_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    return tl_path


def _redacted_segment(seg_dict):
    """canonical 세그먼트 dict 에서 전사 본문(segment.text / word.text)만 제거한
    body-free 뷰. timing·confidence·status·word 타임스탬프 구조는 보존한다.
    (본문은 이미 TXT/SRT 파일에만 존재 — 이벤트/로그 채널로는 내보내지 않는다.)"""
    d = {k: v for k, v in seg_dict.items() if k != "text"}
    d["words"] = [{k: v for k, v in w.items() if k != "text"}
                  for w in seg_dict.get("words", [])]
    return d


def _asr_sidecar_payload(result, language):
    """canonical ASR sidecar 를 in-memory versioned payload 로 생성(순수, Phase 1).

    ★ 파일을 절대 쓰지 않는다(영속화는 atomic publish 계약 전까지 보류). 이 payload 는
      앱 내부 이벤트(asrTranscriptSidecar)로만 흐르며, 기존 TXT/timestamps/SRT/timeline
      출력에는 전혀 관여하지 않는다(그 파일들은 이미 확정·저장됨).
    ★ 전사 본문(segment.text / word.text)은 payload 에 넣지 않는다 — 본문은 TXT/SRT
      파일에만 두고, 이벤트에는 timing·provenance·confidence·status 구조만 싣는다.
      provenance 는 재현/감사용 메타(모델·task·게이트 파라미터)만 담는다.

    모델명은 로드된 whisper 캐시에서 읽어 시그니처를 바꾸지 않는다(순수 additive).
    결정적: canonical 정렬 + 고정 소수 → 같은 입력=같은 payload.
    """
    import asr_canonical as ac
    segs = ac.segments_from_whisper(result.get("segments") or [], language=language)
    transcript = ac.CanonicalTranscript(
        segments=segs,
        language=language,
        provenance={
            "model": str(_whisper_cache.get("name") or "unknown"),
            "task": "transcribe",
            "hallucination_silence_threshold": str(ac.HALLUCINATION_SILENCE_SEC),
            "rms_threshold": str(ac.DEFAULT_RMS_THRESHOLD),
        },
    )
    prov = transcript.provenance
    return {
        "schema": ac.SCHEMA_ID,
        "schemaVersion": ac.SCHEMA_VERSION,
        "language": language,
        "segmentCount": len(segs),
        "provenance": {k: prov[k] for k in sorted(prov)},
        # body-free 세그먼트 구조(timing·confidence·status·word 타임스탬프, 본문 제외).
        "segments": [_redacted_segment(s.to_dict()) for s in transcript.sorted_segments()],
        "summary": ac.log_safe_summary(transcript),  # 본문 없는 감사용 요약
    }


def _save_transcription(result, audio_path, output_dir, do_srt=False, do_translate=False,
                        base_name=None):
    """Save transcription results (txt, timestamps, srt, translation).
    base_name: 출력 파일 접두어. None이면 audio_path에서 유도 —
    임시 변환 파일(converted.wav)을 넘길 때는 원본명을 명시해야 함."""
    text = result["text"].strip()
    language = result.get("language", "unknown")
    base = base_name or os.path.splitext(os.path.basename(audio_path))[0]

    txt_path = os.path.join(output_dir, f"{base}.txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)

    ts_path = os.path.join(output_dir, f"{base}_timestamps.txt")
    with open(ts_path, "w", encoding="utf-8") as f:
        for seg in result["segments"]:
            f.write(f"[{fmt_time(seg['start'])} → {fmt_time(seg['end'])}] {seg['text'].strip()}\n")

    if do_srt:
        srt_path = os.path.join(output_dir, f"{base}.srt")
        with open(srt_path, "w", encoding="utf-8") as f:
            for si, seg in enumerate(result["segments"], 1):
                f.write(f"{si}\n{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}\n{seg['text'].strip()}\n\n")

    translated = None
    if do_translate and language != "ko":
        translated = translate_to_korean(text, language)
        if translated:
            kr_path = os.path.join(output_dir, f"{base}_korean.txt")
            with open(kr_path, "w", encoding="utf-8") as f:
                f.write(translated)
        # 세그먼트별 타임라인 번역 파일도 생성 ([시작 → 끝] 번역)
        write_translation_timeline(output_dir, base, language)

    # ── canonical ASR sidecar (in-memory, versioned payload) — Phase 1 additive ──
    # 위 TXT/timestamps/SRT/timeline 은 이미 확정·저장됨(바이트 불변). 여기서는 같은
    # result 를 canonical 로 표준화해 versioned payload 로만 방출한다(파일 미생성).
    # 실패해도 전사 파일 산출에는 영향 없음 — 안전 상태만 emit(본문·경로·traceback 금지).
    try:
        emit("asrTranscriptSidecar", **_asr_sidecar_payload(result, language))
    except Exception:
        emit("asrTranscriptSidecarError", status="unavailable")

    return {"text": text, "language": language, "txt_path": txt_path, "translated_text": translated}


def transcribe_file(audio_path, output_dir, whisper_model_name="large-v3",
                    do_translate=False, do_srt=False, whisper_lang=None, base_name=None):
    """Transcribe a single file (standalone mode).
    base_name: 출력 파일명 접두어 (임시 wav를 넘길 때 원본명 지정용)."""
    emit("progress", percent=10, message="Whisper 모델 로딩 중...")
    model = _get_whisper_model(whisper_model_name)

    emit("progress", percent=30, message="텍스트 변환 중...")
    result = run_transcribe(model, audio_path, whisper_lang)

    emit("progress", percent=70, message="저장 중...")
    info = _save_transcription(result, audio_path, output_dir, do_srt, do_translate, base_name)
    return info


def transcribe_tracks(tracks, output_dir, whisper_model_name="large-v3",
                      do_translate=False, do_srt=False, whisper_lang=None):
    """Transcribe multiple tracks (post-processing). Model loaded once."""
    emit("progress", percent=94, message="Whisper 모델 로딩 중...")
    model = _get_whisper_model(whisper_model_name)

    for i, t in enumerate(tracks):
        pct = 95 + int((i / max(len(tracks), 1)) * 4)
        emit("progress", percent=pct, message=f"텍스트 변환: {t['label']}")

        result = run_transcribe(model, t["path"], whisper_lang)

        if do_translate:
            lang = result.get("language", "unknown")
            emit("progress", percent=pct + 1, message=f"{t['label']}: {lang}→한국어 번역 중...")

        info = _save_transcription(result, t["path"], output_dir, do_srt, do_translate)
        t["text"] = info["text"]
        t["language"] = info["language"]
        t["txt_path"] = info["txt_path"]
        if info.get("translated_text"):
            t["translated_text"] = info["translated_text"]
