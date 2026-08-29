# -*- coding: utf-8 -*-
"""controlled-prefix 정렬 실패의 **사후 분석 자료**를 job_dir 정리 밖에 남긴다.

왜 필요한가
  정렬이 실패하면 결과를 발행하지 않고(fail-closed) job_dir 을 통째로 지운다. 그래서 지금까지는
  '무엇을 보고 실패했는지'가 실패한 그 순간에 사라졌다 — 실측 없이 임계값만 추측하게 되는 원인이다.
  이 모듈은 실패한 raw chunk 와 수치 진단을 output_dir 아래 **진단 전용 서브폴더**에 남긴다.

경계(어기면 이 모듈의 존재 이유가 무너진다)
  - 여기 남는 것은 **결과가 아니다**. 최종 사용자 결과 경로로 발행하지 않고, 결과 metadata 에도
    절대경로를 싣지 않는다(남기는 것은 폴더 '이름'뿐).
  - 전사 원문·목표 대사·절대경로를 쓰지 않는다. 수치와 비민감 enum, 그리고 raw 의 sha8 만.
    (실패 chunk 앞에서 **성공한** chunk 들의 누적 요약도 같은 필터를 통과한 수치뿐이다.)
  - 어떤 실패도 위로 던지지 않는다. 진단 보존이 실패했다고 합성 실패의 사유가 바뀌면 안 된다.
  - 무한히 쌓이지 않는다(MAX_KEPT 개 초과분은 오래된 것부터 지운다).
"""
import hashlib
import json
import os
import shutil
import time

DIAGNOSTIC_DIR_NAME = ".af-icl-diagnostics"
RAW_NAME = "raw.wav"
REPORT_NAME = "diagnostic.json"
SCHEMA = "af-icl-diagnostic/1"
MAX_KEPT = 5


def _numbers_only(detection):
    """detection 에서 수치와 비민감 enum 문자열만 남긴다(전사·경로가 섞일 여지를 없앤다).

    문자열은 reason_code 계열(대문자·밑줄·숫자)만 통과시킨다 — 그 외 문자열은 통째로 버린다."""
    out = {}
    if not isinstance(detection, dict):
        return out
    for k, v in detection.items():
        if isinstance(v, bool) or isinstance(v, (int, float)):
            out[k] = v
        elif isinstance(v, str) and v and all(c.isupper() or c.isdigit() or c == "_" for c in v):
            out[k] = v
    return out


def _chunk_history(items):
    """chunk 별 누적 요약을 detection 과 **같은 필터**로 통과시킨다(수치·대문자 enum 만).

    왜 필요한가: 정렬은 chunk 를 앞에서부터 처리하다가 하나가 막히면 거기서 job 이 끝난다.
    지금까지 남는 것은 '막힌 그 chunk' 뿐이라, 앞의 chunk 들이 어떤 anchor 로 어디를 잘라
    성공했는지는 실패와 함께 사라졌다(실측: 9개 중 6개 성공 후 s1-c2 에서 실패 — 그 6개의
    좌표가 남지 않았다). 성공 chunk 의 **수치**만 함께 남기면 실패를 그 흐름 안에서 읽을 수 있다.

    ★남는 것은 여전히 수치와 비민감 enum 뿐이다 — _numbers_only 를 그대로 재사용하므로
    전사 원문·목표 대사·절대경로는 필터를 통과할 수 없다(소문자·슬래시·공백이 섞인 문자열은
    전부 버려진다). 성공 chunk 의 WAV 를 남기는 것은 이 함수의 일이 아니다."""
    out = []
    if not isinstance(items, (list, tuple)):
        return out
    for item in items:
        rec = _numbers_only(item)
        if rec:
            out.append(rec)
    return out


def _sha8(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()[:8]
    except OSError:
        return None


def _prune(root, keep=MAX_KEPT):
    try:
        names = sorted(n for n in os.listdir(root)
                       if os.path.isdir(os.path.join(root, n)))
    except OSError:
        return
    for name in names[:-keep] if len(names) > keep else []:
        shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def preserve_failure(output_dir, wav_path, reason_code, detection=None,
                     segment_index=None, chunk_index=None, emotion_id=None,
                     chunk_history=None):
    """실패한 raw 와 수치 진단을 남기고 **폴더 이름**을 돌려준다(절대경로 아님).

    어떤 예외도 밖으로 내지 않는다 — 실패하면 None 을 돌려주고 조용히 포기한다."""
    try:
        if not output_dir or not os.path.isdir(output_dir):
            return None
        root = os.path.join(output_dir, DIAGNOSTIC_DIR_NAME)
        os.makedirs(root, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        name = "{0}-s{1}-c{2}".format(stamp,
                                      segment_index if isinstance(segment_index, int) else "x",
                                      chunk_index if isinstance(chunk_index, int) else "x")
        target = os.path.join(root, name)
        suffix = 0
        while os.path.exists(target):     # 같은 초에 두 번 실패해도 덮어쓰지 않는다
            suffix += 1
            target = os.path.join(root, "{0}-{1}".format(name, suffix))
        os.makedirs(target)

        raw_sha = None
        frames = None
        sample_rate = None
        if wav_path and os.path.isfile(wav_path):
            raw_sha = _sha8(wav_path)
            try:
                shutil.copyfile(wav_path, os.path.join(target, RAW_NAME))
            except OSError:
                pass
            try:
                import soundfile as sf
                info = sf.info(wav_path)
                frames, sample_rate = int(info.frames), int(info.samplerate)
            except Exception:
                pass

        report = {
            "schema": SCHEMA,
            "note": "alignment failure diagnostic - not a synthesis result",
            "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "reason_code": reason_code if isinstance(reason_code, str) else None,
            "segment_index": segment_index if isinstance(segment_index, int) else None,
            "chunk_index": chunk_index if isinstance(chunk_index, int) else None,
            "emotion_id": emotion_id if isinstance(emotion_id, str) else None,
            "raw_sha8": raw_sha,
            "raw_frames": frames,
            "raw_sample_rate": sample_rate,
            "detection": _numbers_only(detection),
            # 이 job 에서 여기까지 처리한 chunk 들의 비민감 요약(성공분 포함) — 실패한 chunk 만
            # 남기면 '앞에서 무엇이 성공했는지'가 사라진다.
            "chunks": _chunk_history(chunk_history),
        }
        with open(os.path.join(target, REPORT_NAME), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2, sort_keys=True)
        _prune(root)
        return os.path.basename(target)
    except Exception:
        return None
