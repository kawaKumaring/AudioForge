# -*- coding: utf-8 -*-
"""감정·표현 고정 대사 fixture 로더(Python 쪽 유일 소비 지점).

권위는 `python/fixtures/emotion-scripts.v2.json` **파일 하나**다. 이 모듈은 문자열 사본을
갖지 않으며, 대사를 여기에 하드코딩하지 않는다. TypeScript 쪽 로더(src/shared/emotionScripts.ts)는
같은 파일을 import 해서 같은 값을 얻는다 — 생성된 mirror 파일은 존재하지 않는다.

경로 규칙: 이 모듈 옆의 `fixtures/` 를 본다. python/ 디렉터리는 개발에서는 저장소 루트 아래,
패키징 시에는 `<resourcesPath>/python` 으로 통째 복사되는 유일한 자산 디렉터리이므로
(src/main/services/python-runner.ts getScriptPath 참고) 두 환경에서 같은 상대 위치가 유지된다.

폴백 금지: 파일이 없거나 schema/지문이 어긋나면 **조용히 내장 사본으로 대체하지 않고** 예외를 던진다.
내장 사본 자체가 없으므로 대체할 대상도 없다.
"""
import json
import os
import hashlib

SCHEMA_VERSION = 2
FIXTURE_FILENAME = "emotion-scripts.v2.json"
SCRIPT_KINDS = ("preview_short", "validation_medium", "continuity_long")


class EmotionScriptsError(Exception):
    """fixture 부재·손상·지문 불일치. 조용한 폴백 대신 이 예외로 즉시 실패한다."""


#: 패키징 환경 주입점. 설정되면 `<이 값>/python/fixtures/<파일>` 을 본다.
#: source tree 가 없는 설치 환경에서 main 프로세스가 process.resourcesPath 를 넘겨 주는 자리이며,
#: 테스트는 임시 디렉터리를 넣어 그 환경을 모사한다.
RESOURCES_ENV = "AUDIOFORGE_RESOURCES_PATH"


def fixture_path():
    """fixture 실제 경로. 주입된 resourcesPath 가 있으면 그쪽만 본다 — 개발 트리로 되돌아가지 않는다.

    구버전 파일명으로의 조용한 fallback 은 없다. v2 가 없으면 v1 이 있어도 실패한다."""
    root = os.environ.get(RESOURCES_ENV)
    if root:
        return os.path.join(root, "python", "fixtures", FIXTURE_FILENAME)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", FIXTURE_FILENAME)


def _canon(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compute_fingerprint(doc):
    """지문 계산 규칙 — TS 로더와 **문자 단위로 동일**해야 한다(parity 테스트가 대조).
    규칙: fixture_fingerprint 키를 뺀 나머지를 sort_keys + 공백없는 구분자로 직렬화한 뒤 sha256."""
    return hashlib.sha256(
        _canon({k: v for k, v in doc.items() if k != "fixture_fingerprint"}).encode("utf-8")
    ).hexdigest()


_cache = None
_cache_key = None


def reset_cache():
    """주입 경로를 바꾼 뒤 다시 읽게 한다(테스트용)."""
    global _cache, _cache_key
    _cache = None
    _cache_key = None


def load(verify=True):
    """fixture 를 읽어 dict 로 반환. verify=True 면 schema/지문까지 검사한다."""
    global _cache, _cache_key
    p = fixture_path()
    if _cache is not None and _cache_key == p:
        return _cache
    if not os.path.isfile(p):
        # 절대 경로는 담지 않는다 — 오류 메시지가 개발 트리 위치를 노출하면 안 된다.
        raise EmotionScriptsError(
            "FIXTURE_NOT_FOUND: %s 없음 — 내장 사본으로 대체하지 않는다." % FIXTURE_FILENAME)
    try:
        with open(p, encoding="utf-8") as f:
            doc = json.load(f)
    except Exception as e:
        raise EmotionScriptsError("FIXTURE_UNREADABLE: %s" % type(e).__name__)
    if verify:
        if doc.get("schema_version") != SCHEMA_VERSION:
            raise EmotionScriptsError(
                "FIXTURE_SCHEMA_MISMATCH: %r != %d" % (doc.get("schema_version"), SCHEMA_VERSION))
        want = compute_fingerprint(doc)
        if doc.get("fixture_fingerprint") != want:
            raise EmotionScriptsError("FIXTURE_FINGERPRINT_MISMATCH")
    _cache = doc
    _cache_key = p
    return doc


def fixture_fingerprint():
    return load()["fixture_fingerprint"]


def emotion_ids():
    return tuple(e["emotion_id"] for e in load()["emotions"])


def entry(emotion_id):
    for e in load()["emotions"]:
        if e["emotion_id"] == emotion_id:
            return e
    raise EmotionScriptsError("EMOTION_SCRIPTS_UNKNOWN_ID: %s" % emotion_id)


def contextual_text(emotion_id, kind):
    """상황 대사(감정마다 다름). kind ∈ SCRIPT_KINDS."""
    if kind not in SCRIPT_KINDS:
        raise EmotionScriptsError("EMOTION_SCRIPTS_UNKNOWN_KIND: %s" % kind)
    return entry(emotion_id)["contextual"][kind]["text"]


def controlled_text(emotion_id):
    """통제 대사 — 태그만 다르고 발화문은 모든 감정에서 동일하다."""
    return entry(emotion_id)["controlled"]["text"]


def controlled_base_text():
    """태그 없는 통제 발화문 원본."""
    return load()["controlled_text"]


def expression_rows():
    return tuple(load()["expression_fixtures"])


def expression_text(row_id):
    for r in load()["expression_fixtures"]:
        if r["row_id"] == row_id:
            return r["text"]
    raise EmotionScriptsError("EMOTION_SCRIPTS_UNKNOWN_ROW: %s" % row_id)
