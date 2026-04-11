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

# NLLB model cache
_nllb_cache = {"model": None, "tokenizer": None, "src_lang": None}

# Whisper model cache
_whisper_cache = {"model": None, "name": None}


def _get_whisper_model(model_name="large-v3"):
    """Load or reuse cached Whisper model."""
    import whisper
    import torch
    if _whisper_cache["model"] is None or _whisper_cache["name"] != model_name:
        device = get_device(timeout_sec=10)
        _whisper_cache["model"] = whisper.load_model(model_name, device=device)
        _whisper_cache["name"] = model_name
    return _whisper_cache["model"]


def translate_to_korean(text: str, src_lang: str):
    """Translate text to Korean using NLLB-200 with GPU acceleration."""
    if src_lang == "ko":
        return text

    nllb_src = LANG_TO_NLLB.get(src_lang)
    if not nllb_src:
        return None

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    device = get_device(timeout_sec=10)
    model_name = "facebook/nllb-200-distilled-600M"

    if _nllb_cache["model"] is None or _nllb_cache["src_lang"] != nllb_src:
        _nllb_cache["tokenizer"] = AutoTokenizer.from_pretrained(model_name, src_lang=nllb_src)
        if _nllb_cache["model"] is None:
            _nllb_cache["model"] = AutoModelForSeq2SeqLM.from_pretrained(model_name).to(device)
        _nllb_cache["src_lang"] = nllb_src

    tokenizer = _nllb_cache["tokenizer"]
    model = _nllb_cache["model"]
    kor_id = tokenizer.convert_tokens_to_ids("kor_Hang")

    sentences = [s.strip() for s in text.replace('\n', '. ').split('. ') if s.strip()]
    translated_parts = []

    for sent in sentences:
        inputs = tokenizer(sent, return_tensors="pt", truncation=True, max_length=512).to(device)
        with torch.no_grad():
            output = model.generate(**inputs, forced_bos_token_id=kor_id, max_length=512)
        translated_parts.append(tokenizer.batch_decode(output, skip_special_tokens=True)[0])

    return " ".join(translated_parts)


def _save_transcription(result, audio_path, output_dir, do_srt=False, do_translate=False):
    """Save transcription results (txt, timestamps, srt, translation)."""
    text = result["text"].strip()
    language = result.get("language", "unknown")
    base = os.path.splitext(os.path.basename(audio_path))[0]

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

    return {"text": text, "language": language, "txt_path": txt_path, "translated_text": translated}


def transcribe_file(audio_path, output_dir, whisper_model_name="large-v3",
                    do_translate=False, do_srt=False):
    """Transcribe a single file (standalone mode)."""
    emit("progress", percent=10, message="Whisper 모델 로딩 중...")
    model = _get_whisper_model(whisper_model_name)

    emit("progress", percent=30, message="텍스트 변환 중...")
    result = model.transcribe(audio_path, language=None, task="transcribe", verbose=False)

    emit("progress", percent=70, message="저장 중...")
    info = _save_transcription(result, audio_path, output_dir, do_srt, do_translate)
    return info


def transcribe_tracks(tracks, output_dir, whisper_model_name="large-v3",
                      do_translate=False, do_srt=False):
    """Transcribe multiple tracks (post-processing). Model loaded once."""
    emit("progress", percent=94, message="Whisper 모델 로딩 중...")
    model = _get_whisper_model(whisper_model_name)

    for i, t in enumerate(tracks):
        pct = 95 + int((i / max(len(tracks), 1)) * 4)
        emit("progress", percent=pct, message=f"텍스트 변환: {t['label']}")

        result = model.transcribe(t["path"], language=None, task="transcribe", verbose=False)

        if do_translate:
            lang = result.get("language", "unknown")
            emit("progress", percent=pct + 1, message=f"{t['label']}: {lang}→한국어 번역 중...")

        info = _save_transcription(result, t["path"], output_dir, do_srt, do_translate)
        t["text"] = info["text"]
        t["language"] = info["language"]
        t["txt_path"] = info["txt_path"]
        if info.get("translated_text"):
            t["translated_text"] = info["translated_text"]
