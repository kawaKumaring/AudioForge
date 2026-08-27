# -*- coding: utf-8 -*-
"""진단 1/2/3 — ASR 재검사(전체 / 머리 1.5s / 꼬리 1.5s), 짧은 n-gram·자모 비교,
그리고 '말한 시간 예산' 대조.

전사 원문은 파일로만 남기고 콘솔에는 지표만 낸다.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
os.chdir(os.path.join(ROOT, "python"))

import korean_cer as kc  # noqa: E402

SRC = r"E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3"
EMO = ("happy", "angry", "sad")
TMP = os.path.join(HERE, "slices")
os.makedirs(TMP, exist_ok=True)

# 한국어 흔한 조사·어미 — reference-only 단어 판정에서 제외(진단 2)
PARTICLES = {
    "은", "는", "이", "가", "을", "를", "에", "의", "도", "와", "과", "로", "으로",
    "에서", "에게", "한테", "부터", "까지", "만", "요", "죠", "지", "고", "서", "며",
    "습니다", "합니다", "입니다", "해요", "예요", "이에요", "에요", "네요", "거든요",
    "하고", "했다", "한다", "하는", "해서", "라고", "라는", "다", "야", "아", "어",
    "그", "저", "것", "거", "수", "때", "게", "걸", "들",
}


def load(p):
    d, sr = sf.read(p, dtype="float32", always_2d=False)
    if d.ndim > 1:
        d = d.mean(axis=1)
    return np.asarray(d, np.float64), int(sr)


def ngrams(units, n):
    return {"".join(units[i:i + n]) for i in range(len(units) - n + 1)}


def active_sec(sig, sr, thr_db=-40.0, frame_ms=20.0, hop_ms=10.0):
    """RMS 임계 위 프레임의 총 시간(초). audio_utils.trim_silence 와 같은 -40dB 기준."""
    n = int(sr * frame_ms / 1000)
    h = int(sr * hop_ms / 1000)
    thr = 10.0 ** (thr_db / 20.0)
    k = max(0, (sig.size - n) // h + 1)
    cnt = 0
    for i in range(k):
        w = sig[i * h:i * h + n]
        if np.sqrt(np.mean(w * w)) >= thr:
            cnt += 1
    return round(cnt * hop_ms / 1000.0, 3), k


def main():
    import whisper
    import torch
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = whisper.load_model("large-v3", device=dev)

    def tr(path, lang="ko"):
        r = model.transcribe(path, language=lang, temperature=0.0,
                             condition_on_previous_text=False,
                             word_timestamps=True, verbose=False)
        words = []
        for s in r.get("segments", []):
            for w in s.get("words", []) or []:
                words.append({"w": w["word"], "s": round(float(w["start"]), 3),
                              "e": round(float(w["end"]), 3),
                              "p": round(float(w.get("probability", 0.0)), 3)})
        return {"text": (r.get("text") or "").strip(), "words": words}

    cfg = json.load(open(os.path.join(SRC, "config_happy.json"), encoding="utf-8"))
    ref_text = cfg["ttsReferencePrompts"]["default"]["manual_text"]
    ref_norm = kc.normalize_text(ref_text)
    ref_syl = kc.syllable_units(ref_norm)
    ref_jamo = kc.jamo_units(ref_norm)

    out = {"ref_text_len_raw": len(ref_text), "ref_syllables": len(ref_syl),
           "ref_jamo": len(ref_jamo), "device": dev}

    # 참조 자체 ASR (수동 전사와 정렬 확인 — 진단 8 재료)
    ra = tr(os.path.join(SRC, "reference_clip.wav"))
    ra_norm = kc.normalize_text(ra["text"])
    ra_syl = kc.syllable_units(ra_norm)
    ec = kc.edit_counts(ref_syl, ra_syl)
    ref_sig, sr = load(os.path.join(SRC, "reference_clip.wav"))
    r_act, _ = active_sec(ref_sig, sr)
    out["reference"] = {
        "asr_syllables": len(ra_syl),
        "cer_vs_manual": round((ec.substitutions + ec.deletions + ec.insertions) / max(len(ref_syl), 1), 4),
        "sub": ec.substitutions, "del": ec.deletions, "ins": ec.insertions,
        "dur_sec": round(ref_sig.size / sr, 3),
        "active_sec": r_act,
        "syll_per_active_sec": round(len(ref_syl) / max(r_act, 1e-6), 3),
        "asr_word_count": len(ra["words"]),
        "asr_word_span_sec": round(sum(w["e"] - w["s"] for w in ra["words"]), 3),
    }

    ref_2g, ref_3g = ngrams(ref_syl, 2), ngrams(ref_syl, 3)
    ref_j4, ref_j5, ref_j6 = ngrams(ref_jamo, 4), ngrams(ref_jamo, 5), ngrams(ref_jamo, 6)
    ref_words = {w.strip() for w in ref_text.replace("!", " ").replace("?", " ")
                 .replace(".", " ").replace(",", " ").split() if w.strip()}

    dump = {"reference_asr": ra}
    per = {}
    for e in EMO:
        c = json.load(open(os.path.join(SRC, f"config_{e}.json"), encoding="utf-8"))
        tgt = c["ttsText"]
        tgt_norm = kc.normalize_text(tgt)
        tgt_syl = kc.syllable_units(tgt_norm)
        tgt_jamo = kc.jamo_units(tgt_norm)

        raw_path = os.path.join(SRC, f"{e}_raw.wav")
        sig, sr = load(raw_path)
        full = tr(raw_path)
        dump[e] = {"full": full}

        # 머리/꼬리 1.5초 분리 전사(진단 3)
        edge = {}
        n = int(sr * 1.5)
        for tag, seg in (("head", sig[:n]), ("tail", sig[-n:])):
            p = os.path.join(TMP, f"{e}_{tag}.wav")
            sf.write(p, seg.astype(np.float32), sr)
            edge[tag] = tr(p)
        dump[e]["edge"] = edge

        a_norm = kc.normalize_text(full["text"])
        a_syl = kc.syllable_units(a_norm)
        a_jamo = kc.jamo_units(a_norm)

        # 진단 1: 2/3음절 + 자모 4/5/6-gram 교집합 (target 에도 있는 것은 제외)
        tg2, tg3 = ngrams(tgt_syl, 2), ngrams(tgt_syl, 3)
        tj4, tj5, tj6 = ngrams(tgt_jamo, 4), ngrams(tgt_jamo, 5), ngrams(tgt_jamo, 6)
        a2, a3 = ngrams(a_syl, 2), ngrams(a_syl, 3)
        aj4, aj5, aj6 = ngrams(a_jamo, 4), ngrams(a_jamo, 5), ngrams(a_jamo, 6)

        hit = {
            "syll2": sorted((a2 & ref_2g) - tg2),
            "syll3": sorted((a3 & ref_3g) - tg3),
            "jamo4": sorted((aj4 & ref_j4) - tj4),
            "jamo5": sorted((aj5 & ref_j5) - tj5),
            "jamo6": sorted((aj6 & ref_j6) - tj6),
        }
        # 가장자리(머리/꼬리) 전사에서도 같은 검사
        edge_hit = {}
        for tag in ("head", "tail"):
            en = kc.normalize_text(edge[tag]["text"])
            es = kc.syllable_units(en)
            ej = kc.jamo_units(en)
            edge_hit[tag] = {
                "syllables": len(es),
                "syll2": sorted((ngrams(es, 2) & ref_2g) - tg2),
                "syll3": sorted((ngrams(es, 3) & ref_3g) - tg3),
                "jamo5": sorted((ngrams(ej, 5) & ref_j5) - tj5),
            }

        # 진단 2: reference-only 단어(조사·어미 제외)
        a_words = {w.strip() for w in full["text"].replace("!", " ").replace("?", " ")
                   .replace(".", " ").replace(",", " ").split() if w.strip()}
        ronly = sorted((a_words & ref_words) - PARTICLES - {t for t in tgt.split()})

        # 시간 예산: 인식된 단어가 덮는 시간 vs 실제 발화(비무음) 시간
        act, frames = active_sec(sig, sr)
        wspan = sum(w["e"] - w["s"] for w in full["words"])
        ecs = kc.edit_counts(tgt_syl, a_syl)

        per[e] = {
            "dur_sec": round(sig.size / sr, 3),
            "active_sec": act,
            "target_syllables": len(tgt_syl),
            "asr_syllables": len(a_syl),
            "cer_syllable": round((ecs.substitutions + ecs.deletions + ecs.insertions) / max(len(tgt_syl), 1), 4),
            "sub": ecs.substitutions, "del": ecs.deletions, "ins": ecs.insertions,
            "asr_word_count": len(full["words"]),
            "asr_word_span_sec": round(wspan, 3),
            "unexplained_active_sec": round(act - wspan, 3),
            "syll_per_active_sec": round(len(tgt_syl) / max(act, 1e-6), 3),
            "first_word_start_sec": full["words"][0]["s"] if full["words"] else None,
            "last_word_end_sec": full["words"][-1]["e"] if full["words"] else None,
            "min_word_prob": round(min([w["p"] for w in full["words"]], default=0.0), 3),
            "ref_ngram_hits": {k: {"n": len(v), "items": v[:12]} for k, v in hit.items()},
            "reference_only_words": ronly,
            "edge_asr": edge_hit,
            "edge_head_syll_count": edge_hit["head"]["syllables"],
            "edge_tail_syll_count": edge_hit["tail"]["syllables"],
        }
    out["per_emotion"] = per

    with open(os.path.join(HERE, "a3_asr.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    # 전사 원문은 별도 파일에만(보고서 미출력)
    with open(os.path.join(HERE, "a3_transcripts_PRIVATE.json"), "w", encoding="utf-8") as f:
        json.dump(dump, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
