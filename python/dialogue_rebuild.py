"""수정한 구간으로 화자별 트랙을 **다시 만든다** — 모델은 다시 돌리지 않는다.

사용자가 화면에서 배정과 경계만 고친 경우를 위한 길이다. 화자 분석(VAD·임베딩·군집)은
이미 끝났고 그 결과를 사람이 손본 것이므로, **다시 들을 이유가 없다.** 원본에서 그 구간을
그대로 떠다 화자별 트랙에 올린다.

★겹친 목소리를 갈라내지 않는다. 이것은 **원본 구간을 화자별 트랙에 배정**하는 일이다.
  두 사람이 동시에 말한 자리를 한 사람의 깨끗한 목소리로 만들어 주지 않는다.
★경계 페이드는 기존 재구성과 **같은 규칙**을 쓴다(15ms, 구간 길이의 절반으로 제한).
  그 제한이 없으면 짧은 구간에서 시작·끝 램프가 겹쳐 두 번 곱해진다.
"""

import os

FADE_SEC = 0.015


def _safe_name(label):
    return "".join(c for c in (label or "") if c not in r'\/:*?"<>|').strip()


def normalize_segments(segments, duration_sec):
    """시간 범위 오류를 막는다 — 뒤집힌 구간·범위 밖·빈 구간을 **조용히 고치지 않고 거른다**.

    반환 (쓸 수 있는 구간, 버린 사유 목록). 사유는 번호와 까닭만 담는다(본문·경로 없음).
    """
    good, dropped = [], []
    for i, s in enumerate(segments or []):
        try:
            start = float(s.get("start"))
            end = float(s.get("end"))
        except (TypeError, ValueError):
            dropped.append({"index": i, "reason": "NOT_A_NUMBER"})
            continue
        spk = s.get("speaker")
        if not isinstance(spk, str) or not spk.strip():
            dropped.append({"index": i, "reason": "NO_SPEAKER"})
            continue
        if not (start < end):
            dropped.append({"index": i, "reason": "END_BEFORE_START"})
            continue
        if end <= 0 or start >= duration_sec:
            dropped.append({"index": i, "reason": "OUT_OF_RANGE"})
            continue
        # 원본 길이를 넘는 끝은 잘라 준다(이건 사유를 남긴다 — 조용히 바꾸지 않는다).
        clipped = False
        if start < 0:
            start, clipped = 0.0, True
        if end > duration_sec:
            end, clipped = float(duration_sec), True
        if clipped:
            dropped.append({"index": i, "reason": "CLIPPED_TO_RANGE"})
        good.append({"start": start, "end": end, "speaker": spk.strip()})
    good.sort(key=lambda s: (s["start"], s["end"]))
    return good, dropped


def rebuild_speaker_tracks(wav, sr, segments, output_dir, prefix="edited"):
    """wav(1×N torch 텐서) 에서 구간을 떠 화자별 트랙으로 쓴다.

    반환 [{name,label,path,segments}] — 실제로 소리가 들어간 화자만.
    """
    import numpy as np
    import torch
    from audio_utils import save_audio

    n_samples = wav.shape[1]
    duration = n_samples / float(sr)
    good, dropped = normalize_segments(segments, duration)

    by_speaker = {}
    for s in good:
        by_speaker.setdefault(s["speaker"], []).append(s)

    fade_samples = int(FADE_SEC * sr)
    tracks = []
    for label in sorted(by_speaker):
        out = torch.zeros(1, n_samples)
        spans = []
        for s in by_speaker[label]:
            a = max(0, int(s["start"] * sr))
            b = min(n_samples, int(s["end"] * sr))
            if b <= a:
                continue
            out[:, a:b] = wav[:, a:b]
            spans.append((a, b))
        if not spans:
            continue
        # 경계 페이드 — 기존 재구성과 같은 규칙.
        arr = out.squeeze().numpy()
        for (a, b) in spans:
            n = b - a
            if n <= 1:
                continue
            f = min(fade_samples, n // 2)
            if f <= 0:
                continue
            arr[a:a + f] *= np.linspace(0.0, 1.0, f, dtype=arr.dtype)
            arr[b - f:b] *= np.linspace(1.0, 0.0, f, dtype=arr.dtype)
        out = torch.from_numpy(arr).unsqueeze(0)

        safe = _safe_name(label) or "speaker"
        name = "%s_%s" % (prefix, safe)
        path = os.path.join(output_dir, "%s.wav" % name)
        save_audio(path, out, sr)
        tracks.append({"name": name, "label": label, "path": path,
                       "segments": len(spans)})
    return tracks, dropped
