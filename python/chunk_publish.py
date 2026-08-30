# -*- coding: utf-8 -*-
"""chunk 산출물 원자 발행 + 연결부 진단 — **개발 계측 전용, opt-in**.

왜 필요한가: "chunk 마다 목소리가 다르다" 와 "이어붙인 자리가 끊긴다" 는 서로 다른 문제인데
최종 WAV 하나로는 가를 수 없다. 그래서 한 chunk 를 세 시점에 남긴다.

  raw      모델이 생성한 원본(ICL 이면 참조 재발화가 앞에 붙어 있다)
  aligned  참조 선행부를 정렬·절단한 결과
  final    실제 최종 조립에 투입된 파형(envelope 적용 후)

세 단계가 같은 파형이면 WAV 를 중복 저장하지 않고 manifest 에 `same_as` 로 적는다 —
어느 단계가 동일했는지는 반드시 드러난다.

join preview 는 **앞 chunk 말끝 1.5s + 실제 삽입 gap 전체 + 뒤 chunk 첫말 1.5s** 다.
진단용 무음을 임의로 덧대지 않는다 — 실제 간격을 그대로 들어야 하기 때문이다.

활성화: AUDIOFORGE_DIAG_CHUNK_PUBLISH=<run-id>. 없으면 이 모듈은 아무 일도 하지 않는다.
사용자 최종 출력 폴더에는 아무것도 쓰지 않는다.
manifest 에 대사 원문·전사·절대경로를 넣지 않는다(해시와 좌표만).
"""
import hashlib
import json
import os

ENV = "AUDIOFORGE_DIAG_CHUNK_PUBLISH"
PREVIEW_SIDE_SEC = 1.5

#: 경계 종류 — 원문 구조에서 오는 것만 여기 둔다(신호 판정과 섞지 않는다).
BOUNDARY_KINDS = (
    "internal_split",        # 같은 문장 내부에서 강제로 분할
    "period",                # 마침표
    "question",              # 물음표
    "exclamation",           # 느낌표
    "same_line_sentence",    # 같은 줄의 다음 문장
    "line_break",            # 줄바꿈
    "blank_line_paragraph",  # 빈 줄 문단
    "emotion_change",        # 감정 전환
    "explicit_pause",        # 명시적 쉼
)

_MARK_KIND = {".": "period", "?": "question", "!": "exclamation",
              "…": "period", "。": "period", "！": "exclamation", "？": "question"}


def classify_boundary(prev_text, same_segment, blank_lines_before,
                      emotion_changed, explicit_pause_ms):
    """경계 종류를 원문 구조만으로 정한다. 신호(무음·F0)는 여기 개입하지 않는다."""
    if explicit_pause_ms:
        return "explicit_pause"
    if emotion_changed:
        return "emotion_change"
    if blank_lines_before:
        return "blank_line_paragraph"
    if not same_segment:
        return "line_break"
    tail = (prev_text or "").rstrip()
    if tail and tail[-1] in _MARK_KIND:
        return _MARK_KIND[tail[-1]]
    return "internal_split"


def run_id():
    v = (os.environ.get(ENV) or "").strip()
    return v or None


def enabled():
    return run_id() is not None


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _arr_sha(arr):
    import numpy as np
    return hashlib.sha256(np.ascontiguousarray(
        np.asarray(arr, dtype="float32")).tobytes()).hexdigest()


def _atomic_wav(arr, sr, dst, root):
    """temp → WAV 검증 → atomic rename. 반쯤 쓰인 파일이 남지 않는다."""
    import numpy as np
    import soundfile as sf
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    # .part 는 확장자로 포맷을 못 읽으므로 명시한다.
    sf.write(tmp, np.ascontiguousarray(np.asarray(arr, dtype="float32")), int(sr),
             format="WAV", subtype="PCM_16")
    info = sf.info(tmp)
    if info.frames <= 0 or int(info.samplerate) != int(sr):
        os.remove(tmp)
        raise RuntimeError("CHUNK_PUBLISH_INVALID_WAV")
    os.replace(tmp, dst)
    return {"file": os.path.relpath(dst, root).replace("\\", "/"),
            "frames": int(info.frames), "sample_rate": int(info.samplerate),
            "duration_sec": round(info.frames / float(info.samplerate), 4),
            "sha256": _sha(dst)}


def low_energy_run(arr, sr, from_end=False, floor_db=-50.0, max_ms=2000):
    """끝(또는 앞)에서부터 이어지는 저에너지 길이(ms). 생성 무음을 재는 용도."""
    import numpy as np
    a = np.asarray(arr, dtype="float32")
    if a.size == 0:
        return 0.0
    fr = max(1, int(0.010 * sr))
    thr = 10.0 ** (floor_db / 20.0)
    n = 0
    lim = int(max_ms / 1000.0 * sr)
    idx = a.size
    while n < lim:
        s = (idx - fr) if from_end else n
        e = idx if from_end else (n + fr)
        if s < 0 or e > a.size:
            break
        seg = a[s:e]
        if float(np.sqrt(np.mean(seg ** 2))) >= thr:
            break
        n += fr
        idx -= fr
    return round(n / sr * 1000.0, 1)


PRIVATE_SUFFIX = ".private.json"
PRIVACY_PRIVATE = "private"
PRIVACY_NON_SENSITIVE = "non_sensitive"


def _atomic_json(payload, dst):
    """temp write -> 재읽기 SHA 검증 -> atomic rename. 검증 실패 시 .part 를 남기고 예외."""
    import hashlib
    tmp = dst + ".part"
    body = json.dumps(payload, ensure_ascii=False, indent=1)
    with open(tmp, "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(body)
    raw = open(tmp, "rb").read()
    if hashlib.sha256(raw).hexdigest() != hashlib.sha256(body.encode("utf-8")).hexdigest():
        raise RuntimeError("RUN_BUNDLE_JSON_VERIFY_FAILED: " + os.path.basename(dst))
    os.replace(tmp, dst)
    return hashlib.sha256(raw).hexdigest()


class ChunkRecorder:
    """한 run 의 chunk 기록. 비활성이면 모든 메서드가 즉시 반환한다."""

    def __init__(self):
        self.active = enabled()
        self.rows = {}
        self.root = None
        self.script = None          # script.private.json 내용(원문 포함)
        self.script_sha = None      # 단계별 추적용 script SHA
        self.artifacts = []         # {path, sha256, privacy_class, export_allowed}
        self.chunk_private = {}     # global chunk index -> chunk-NNN.private.json 내용
        if self.active:
            import local_assets
            self.root = local_assets.run_output_dir(run_id())
            local_assets.assert_inside_local(self.root)

    def _row(self, gidx):
        return self.rows.setdefault(int(gidx), {"chunk_index": int(gidx)})

    def _stage(self, gidx, stage, arr, sr):
        r = self._row(gidx)
        digest = _arr_sha(arr)
        for prev in ("raw", "aligned"):
            if prev in r and r[prev].get("array_sha256") == digest:
                r[stage] = {"same_as": prev, "array_sha256": digest,
                            "frames": r[prev]["frames"],
                            "duration_sec": r[prev]["duration_sec"]}
                return
        info = _atomic_wav(arr, sr, os.path.join(
            self.root, "chunks", "chunk-%03d-%s.wav" % (gidx, stage)), self.root)
        info["array_sha256"] = digest
        r[stage] = info

    def raw(self, gidx, arr, sr, **meta):
        if not self.active:
            return
        self._stage(gidx, "raw", arr, sr)
        self.note(gidx, **meta)

    def aligned(self, gidx, arr, sr, **meta):
        if not self.active:
            return
        self._stage(gidx, "aligned", arr, sr)
        r = self._row(gidx)
        r["lead_silence_ms"] = low_energy_run(arr, sr, from_end=False)
        r["tail_silence_ms"] = low_energy_run(arr, sr, from_end=True)
        self.note(gidx, **meta)

    def final(self, gidx, arr, sr, start_sample, gap_before, envelope=None, **meta):
        if not self.active:
            return
        self._stage(gidx, "final", arr, sr)
        r = self._row(gidx)
        r["final_start_sample"] = int(start_sample)
        r["final_end_sample"] = int(start_sample) + int(len(arr))
        r["final_start_sec"] = round(start_sample / float(sr), 4)
        r["final_end_sec"] = round((start_sample + len(arr)) / float(sr), 4)
        r["gap_before_samples"] = int(gap_before)
        r["gap_before_ms"] = round(gap_before / float(sr) * 1000.0, 1)
        if envelope is not None:
            r["envelope"] = envelope
        elif "envelope" not in r:                # 주석 단계에서 넣었으면 덮어쓰지 않는다
            r["envelope"] = {"applied": False}
        al = r.get("aligned") or {}
        if al.get("frames"):
            r["assembly_delta_samples"] = int(len(arr)) - int(al["frames"])
        self.note(gidx, **meta)

    def note(self, gidx, **meta):
        if not self.active:
            return
        self._row(gidx).update({k: v for k, v in meta.items() if v is not None})

    def ordered(self):
        return [self.rows[k] for k in sorted(self.rows)]

    # ── join preview ─────────────────────────────────────────────────────
    def build_joins(self, final_arr, sr):
        """최종 WAV 좌표로 join preview 를 파생한다. 원본은 수정하지 않는다."""
        if not self.active:
            return []
        import numpy as np
        rows = self.ordered()
        side = int(PREVIEW_SIDE_SEC * sr)
        joins = []
        for i in range(1, len(rows)):
            a, b = rows[i - 1], rows[i]
            if "final_end_sample" not in a or "final_start_sample" not in b:
                continue
            cut = int(b["final_start_sample"])
            gap = int(b.get("gap_before_samples") or 0)
            s = max(0, int(a["final_end_sample"]) - side)
            e = min(len(final_arr), cut + side)
            seg = np.ascontiguousarray(final_arr[s:e])
            info = _atomic_wav(seg, sr, os.path.join(
                self.root, "joins", "join-%03d-preview.wav" % (i - 1)), self.root)
            tail = a.get("tail_silence_ms") or 0.0
            lead = b.get("lead_silence_ms") or 0.0
            gap_ms = round(gap / float(sr) * 1000.0, 1)
            joins.append({
                "join_index": i - 1, "left_chunk": a["chunk_index"], "right_chunk": b["chunk_index"],
                "boundary_kind": b.get("boundary_kind"),
                "tail_silence_ms": tail, "app_gap_ms": gap_ms, "lead_silence_ms": lead,
                "perceived_gap_ms": round(tail + gap_ms + lead, 1),
                "envelope_applied": bool((b.get("envelope") or {}).get("applied")),
                "preview": info["file"], "preview_sha256": info["sha256"],
            })
        return joins

    # ── run bundle 확장 ────────────────────────────────────────────────────
    def _register(self, rel, sha, private):
        self.artifacts.append({"path": rel, "sha256": sha,
                               "privacy_class": PRIVACY_PRIVATE if private else PRIVACY_NON_SENSITIVE,
                               "export_allowed": not private})

    def set_script(self, raw_text, normalized_text, paragraphs=None, sentences=None):
        """원문·정규화 문자열은 private JSON 에만 남기고, 밖으로는 SHA·길이·수치만 낸다."""
        if not self.active:
            return None
        import hashlib
        self.script_sha = hashlib.sha256((raw_text or "").encode("utf-8")).hexdigest()
        self.script = {
            "schema": "af-run-script-private/1", "run_id": run_id(), "private": True,
            "raw_text": raw_text, "raw_sha256": self.script_sha,
            "normalized_text": normalized_text,
            "normalized_sha256": hashlib.sha256((normalized_text or "").encode("utf-8")).hexdigest(),
            "chars": len(raw_text or ""),
            "paragraphs": paragraphs or [], "sentences": sentences or [],
        }
        return self.script_sha

    def record_chunk_text(self, gidx, chunk_text, source_char_range=None,
                          production_tokens=None, combined_prompt_tokens=None,
                          controlled_prefix_text=None, reference_transcript=None,
                          segment=None, paragraph=None, local_chunk_index=None,
                          model_call_index=None):
        """이 호출에 실제로 넘어간 대사. 원문은 private, 좌표·수치는 manifest 로 간다."""
        if not self.active:
            return
        import hashlib
        g = int(gidx)
        self.chunk_private[g] = {
            "schema": "af-run-chunk-private/1", "run_id": run_id(), "private": True,
            "chunk_index": g, "chunk_text": chunk_text,
            "chunk_text_sha256": hashlib.sha256((chunk_text or "").encode("utf-8")).hexdigest(),
            "controlled_prefix_text": controlled_prefix_text,
            "reference_transcript": reference_transcript,
        }
        r = self._row(g)
        r.update({k: v for k, v in (
            ("source_char_range", source_char_range),
            ("production_tokens", production_tokens),
            ("combined_prompt_tokens", combined_prompt_tokens),
            ("segment_index", segment), ("paragraph_index", paragraph),
            ("local_chunk_index", local_chunk_index),
            ("model_call_index", model_call_index),
            ("chunk_text_sha256", self.chunk_private[g]["chunk_text_sha256"]),
            ("script_sha256", self.script_sha),
        ) if v is not None})

    def record_generation(self, gidx, generation_limit=None, generated_iterations=None,
                          termination_reason=None, vendor_crop_record=None,
                          external_alignment_calls=None, fallback=None, retries=None,
                          elapsed_sec=None, partial=None):
        """생성·종료·발행 근거. vendor crop record 는 SHA 만 승격하고 원본은 chunk private 에."""
        if not self.active:
            return
        r = self._row(int(gidx))
        r.update({k: v for k, v in (
            ("generation_limit", generation_limit),
            ("generated_iterations", generated_iterations),
            ("termination_reason", termination_reason),
            ("external_alignment_calls", external_alignment_calls),
            ("fallback", fallback), ("retries", retries),
            ("elapsed_sec", elapsed_sec), ("partial", partial),
        ) if v is not None})
        if vendor_crop_record is not None:
            r["vendor_crop_record"] = vendor_crop_record
            r["crop_authority"] = vendor_crop_record.get("crop_authority")

    def write(self, status, final_arr=None, sr=None, extra=None):
        """manifest.json + timeline.json. status: ok | failed."""
        if not self.active:
            return None
        joins = self.build_joins(final_arr, sr) if final_arr is not None else []
        doc = {"schema": 1, "run_id": run_id(), "status": status,
               "chunk_count": len(self.rows), "chunks": self.ordered(), "joins": joins}
        if extra:
            doc.update({k: v for k, v in extra.items()
                        if k not in ("text", "transcript", "ttsText")})
        # ① private JSON 을 먼저 쓴다(원문·전사는 여기에만 있다).
        for rel, payload in ([("script" + PRIVATE_SUFFIX, self.script)] if self.script else []) +                 [("chunks/chunk-%03d%s" % (g, PRIVATE_SUFFIX), pv)
                 for g, pv in sorted(self.chunk_private.items())]:
            dst = os.path.join(self.root, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            self._register(rel, _atomic_json(payload, dst), private=True)

        # ② timeline. 좌표·수치만 담는다.
        tl = {"schema": 1, "run_id": run_id(), "sample_rate": sr,
              "chunks": [{k: c.get(k) for k in
                          ("chunk_index", "segment", "segment_index", "paragraph_index",
                           "local_chunk_index", "model_call_index", "boundary_kind",
                           "source_char_range", "final_start_sample", "final_end_sample",
                           "final_start_sec", "final_end_sec", "gap_before_samples")}
                         for c in self.ordered()],
              "joins": joins}
        self._register("timeline.json",
                       _atomic_json(tl, os.path.join(self.root, "timeline.json")), private=False)

        # ③ manifest 는 **마지막**에 발행한다 — 존재 자체가 번들 완결 신호다.
        #    자기 SHA 는 담지 않는다(자기 참조 불가). 분류 없는 artifact 는 private 취급이다.
        doc["script_sha256"] = self.script_sha
        doc["artifacts"] = list(self.artifacts)
        doc["private_files"] = [a["path"] for a in self.artifacts
                                if a["privacy_class"] == PRIVACY_PRIVATE]
        _atomic_json(doc, os.path.join(self.root, "manifest.json"))
        return self.root
