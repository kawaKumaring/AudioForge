"""pyannote Community-1 화자 분석 — **격리 venv 안에서 도는 다리**.

왜 따로 도는가: `pyannote.audio` 는 제 torch·torchcodec·lightning 을 끌고 온다. 앱 파이썬은
ComfyUI 내장 파이썬이고 거기엔 이미 합성 환경이 있다 — 같은 자리에 섞으면 그것을 흔든다.
그래서 `externals/diarization_venv` 안에서 돌리고 결과 JSON 만 건넨다(기존 다리들과 같은 방식).

지키는 것
  ★**밖으로 아무것도 보내지 않는다.** 텔레메트리를 끄고(PYANNOTE_METRICS_ENABLED=false),
    클라우드 SDK(pyannoteai)를 쓰지 않으며, 추론은 로컬 가중치로만 한다.
  ★모델은 **로컬 절대경로**로만 적재한다. 실행 중 자동 다운로드를 막는다(HF_HUB_OFFLINE=1).
  ★실제 장치를 기록하고 **몰래 CPU 로 바꾸지 않는다.** 요청한 장치를 못 쓰면 사유를 들고 실패한다.
  ★**exclusive 결과와 일반 결과를 구분해** 돌려준다. 겹침을 찾았다는 것은 겹친 목소리를
    갈라냈다는 뜻이 아니다 — 그 말은 이 파일도 하지 않는다.
"""

import argparse
import json
import os
import sys
import time

# ── 밖으로 나가는 길을 **import 전에** 막는다 ────────────────────────────────
os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "false")   # 텔레메트리 끄기
os.environ.setdefault("HF_HUB_OFFLINE", "1")                 # 실행 중 다운로드 금지
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _load_audio(path):
    """앱의 다른 경로와 같은 규칙 — soundfile 로 읽고 **모노 16kHz** 로 맞춘다.

    ★이것은 **분석용** 신호다. 최종 화자 트랙은 이 신호로 만들지 않는다 —
      원본 시간축·음질을 기준으로 따로 재구성한다(python/dialogue_rebuild.py).
    """
    import numpy as np
    import soundfile as sf
    import torch

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T.copy())            # (채널, 표본)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    if sr != 16000:
        import torchaudio
        wav = torchaudio.functional.resample(wav, sr, 16000)
        sr = 16000
    return wav, sr


def _annotation_to_segments(ann):
    out = []
    for segment, _track, label in ann.itertracks(yield_label=True):
        out.append({"start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "speaker": str(label)})
    out.sort(key=lambda s: (s["start"], s["end"]))
    return out


def _overlap_spans(segments):
    """두 사람 이상이 **동시에** 잡힌 구간. 겹침이 '있다'는 사실만 적는다.

    ★이것은 겹친 목소리를 갈라낸 결과가 아니다. 그런 구간이 어디인지 알려 줄 뿐이다.
    """
    events = []
    for s in segments:
        events.append((s["start"], 1))
        events.append((s["end"], -1))
    events.sort()
    spans, depth, start = [], 0, None
    for t, d in events:
        was = depth
        depth += d
        if was < 2 <= depth:
            start = t
        elif was >= 2 > depth and start is not None:
            if t > start:
                spans.append({"start": round(start, 3), "end": round(t, 3)})
            start = None
    return spans


def run(audio_path, model_dir, device, num_speakers=None):
    import torch
    from pyannote.audio import Pipeline

    if device == "cuda" and not torch.cuda.is_available():
        # 몰래 CPU 로 바꾸지 않는다 — 요청한 장치를 못 쓰면 그대로 실패한다.
        raise SystemExit("DIARIZE_CUDA_UNAVAILABLE: GPU 를 쓸 수 없습니다.")

    t0 = time.time()
    # 로컬 절대경로로만 적재한다. config.yaml 이 가리키는 가중치도 같은 폴더 안에 있어야 한다.
    pipeline = Pipeline.from_pretrained(model_dir)
    if pipeline is None:
        raise SystemExit("DIARIZE_PIPELINE_NONE: 모델 설정을 읽지 못했습니다.")
    pipeline.to(torch.device(device))
    load_sec = time.time() - t0

    wav, sr = _load_audio(audio_path)
    audio_sec = wav.shape[1] / float(sr)

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t1 = time.time()
    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = int(num_speakers)
    output = pipeline({"waveform": wav, "sample_rate": sr}, **kwargs)
    run_sec = time.time() - t1
    peak_mb = (torch.cuda.max_memory_allocated() / 1e6) if device == "cuda" else None

    # 일반 diarization = 겹침이 있을 수 있다. exclusive = 한 시점에 한 화자.
    general = _annotation_to_segments(getattr(output, "speaker_diarization", output))
    excl_ann = getattr(output, "exclusive_speaker_diarization", None)
    exclusive = _annotation_to_segments(excl_ann) if excl_ann is not None else []

    return {
        # 트랙 배정·구간 수정에 쓰는 것은 **exclusive** 다(한 시점에 한 화자).
        "segments": exclusive or general,
        "exclusiveAvailable": bool(exclusive),
        # 겹침 정보는 **따로** 보존한다. 같은 목록에 섞지 않는다.
        "overlaps": _overlap_spans(general),
        "speakers": sorted({s["speaker"] for s in (exclusive or general)}),
        "_run": {
            "engine": "pyannote-community-1",
            "pyannoteVersion": _pkg_version("pyannote.audio"),
            "torchVersion": __import__("torch").__version__,
            "modelDir": model_dir,
            "device": device,
            "gpuName": (torch.cuda.get_device_name(0) if device == "cuda" else None),
            "numSpeakersRequested": int(num_speakers) if num_speakers else None,
            "audioDurationSec": round(audio_sec, 2),
            "analysisSampleRate": sr,
            "loadSec": round(load_sec, 2),
            "diarizeSec": round(run_sec, 2),
            "peakGpuMemoryMB": (round(peak_mb, 1) if peak_mb is not None else None),
            "generalSegmentCount": len(general),
            "exclusiveSegmentCount": len(exclusive),
            "overlapSpanCount": len(_overlap_spans(general)),
            "telemetry": os.environ.get("PYANNOTE_METRICS_ENABLED"),
            "hubOffline": os.environ.get("HF_HUB_OFFLINE"),
        },
    }


def _pkg_version(mod):
    try:
        import importlib.metadata as md
        return md.version(mod)
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--num-speakers", type=int, default=0)
    a = ap.parse_args()

    if not os.path.isdir(a.model_dir):
        raise SystemExit("DIARIZE_MODEL_MISSING: %s" % a.model_dir)

    result = run(a.audio, os.path.abspath(a.model_dir), a.device,
                 a.num_speakers or None)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    r = result["_run"]
    # 본문·경로는 찍지 않는다. 무엇으로 어디서 돌았는지만 남긴다.
    print(f"[diarize] done engine={r['engine']} v={r['pyannoteVersion']} device={r['device']} "
          f"gpu={r['gpuName']} audio={r['audioDurationSec']}s load={r['loadSec']}s "
          f"run={r['diarizeSec']}s peakGPU={r['peakGpuMemoryMB']}MB "
          f"segments={r['exclusiveSegmentCount']}/{r['generalSegmentCount']} "
          f"overlaps={r['overlapSpanCount']} telemetry={r['telemetry']}", flush=True)


if __name__ == "__main__":
    main()
