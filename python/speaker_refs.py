# -*- coding: utf-8 -*-
"""화자별 참조 선택 — **어느 목소리로 이 말을 만들 것인가**의 단일 권위.

왜 별도 모듈인가
----------------
`tts_worker` 는 모델·오디오 의존이 있어 이 표를 검증하려면 GPU 환경이 필요해진다. 선택
규칙은 순수 함수이고 가장 많이 바뀔 부분이라, stdlib 만 쓰는 자리에 떼어 놓고 mock 없이
직접 검증한다. 파서·planner·IPC·recorder 를 새로 만드는 것이 아니다 — 기존 흐름
(config → separate.py → tts_worker)이 이 함수를 부른다.

우선순위(확정)
--------------
1. `(speaker_id, emotion_id)` 전용 참조
2. 그 화자의 기본 참조
3. **화자 표기가 없는 대본에서만** 기존 감정별 참조
4. 전역 기본 참조

3번이 화자 있는 발화에 적용되지 않는 것이 핵심이다. 민수의 말을 감정 참조(다른 사람의
목소리일 수 있다)로 만들면 사용자가 지정하지 않은 인물이 말하게 된다.

조용한 대체를 하지 않는다
-------------------------
화자가 명시됐는데 등록되지 않았거나 참조가 준비되지 않으면 **생성 전에 막는다.** 전역
기본 목소리로 대신 만들면 사용자는 다른 사람 목소리로 만들어진 결과를 받고도 그 사실을
모른다. 한 화자의 실패가 다른 화자의 참조를 재사용하는 일도 없다 — 이 함수는 요청된
화자의 항목만 본다.

기록에 이름을 남기지 않는다
---------------------------
manifest 로 나가는 것은 불투명 id 뿐이다(`spk_…` / `ref_…`). 사용자가 쓴 화자 표시 이름과
파일 경로는 private JSON 의 몫이다.
"""
import hashlib
import os

SCHEMA_VERSION = 1

# 어느 규칙이 실제로 쓰였는가(비민감 enum). run bundle 과 화면이 같은 값을 쓴다.
SOURCE_SPEAKER_EMOTION = "speaker_emotion"
SOURCE_SPEAKER = "speaker"
SOURCE_EMOTION = "emotion"
SOURCE_DEFAULT = "default"

REFERENCE_SOURCES = (SOURCE_SPEAKER_EMOTION, SOURCE_SPEAKER, SOURCE_EMOTION, SOURCE_DEFAULT)

# fail-closed 코드. 모델 로딩 전에 막는다.
SPEAKER_NOT_REGISTERED = "SPEAKER_NOT_REGISTERED"
SPEAKER_REFERENCE_NOT_READY = "SPEAKER_REFERENCE_NOT_READY"
DEFAULT_REFERENCE_MISSING = "DEFAULT_REFERENCE_MISSING"


class SpeakerReferenceError(RuntimeError):
    """참조를 정할 수 없다. 조용히 다른 목소리로 대체하지 않고 여기서 멈춘다."""

    def __init__(self, code, speaker_id=None, emotion_id=None, message=None):
        super().__init__(message or code)
        self.code = code
        # payload 에 표시 이름·경로를 담지 않는다. 화자 id 는 불투명 형태로만 나간다.
        self.error_payload = {
            "code": code,
            "speaker_ref": opaque_speaker_ref(speaker_id) if speaker_id else None,
            "emotion_id": emotion_id,
        }


def opaque_speaker_ref(speaker_id):
    """화자 id → manifest 용 불투명 토큰. 이름을 되돌릴 수 없다."""
    if speaker_id is None:
        return None
    return "spk_" + hashlib.sha256(str(speaker_id).encode("utf-8")).hexdigest()[:12]


def emotion_key(speaker_id, emotion_id):
    """`(화자, 감정)` 전용 참조의 config 키. 화자와 감정 사이에 구분자를 둔다."""
    return "%s%s%s" % (speaker_id or "", chr(31), emotion_id or "default")


def _clean(mapping):
    """빈 값·비문자 경로를 버린다. 조용히 고치지 않고 없는 것으로 본다."""
    out = {}
    for k, v in (mapping or {}).items():
        if isinstance(v, str) and v.strip():
            out[str(k)] = v.strip()
    return out


class ReferenceTable:
    """이번 작업이 쓸 참조 표. 한 번 만들고 chunk 마다 조회한다.

    `exists` 는 주입받는다 — 파일 확인을 실제로 하되 테스트가 디스크 없이 표를 검증할 수
    있어야 하기 때문이다. 기본값은 실제 파일 시스템이다.
    """

    def __init__(self, default_ref, emotion_refs=None, speaker_refs=None,
                 speaker_emotion_refs=None, registered_speakers=None, exists=None,
                 sha256_of=None):
        self.default_ref = (default_ref or "").strip()
        self.emotion_refs = _clean(emotion_refs)
        self.speaker_refs = _clean(speaker_refs)
        self.speaker_emotion_refs = _clean(speaker_emotion_refs)
        # 등록 사실은 참조 경로 유무와 별개다 — "등록했지만 파일이 사라졌다" 를 구분한다.
        self.registered_speakers = set(registered_speakers or self.speaker_refs.keys())
        self._exists = exists if exists is not None else os.path.exists
        self._sha256_of = sha256_of
        self._sha_cache = {}

    # ── 조회 ──────────────────────────────────────────────────────────────
    def resolve(self, speaker_id, emotion_id):
        """이 발화가 쓸 참조. 정할 수 없으면 `SpeakerReferenceError`.

        반환 dict: path / source / reference_id / speaker_ref.
        """
        eid = emotion_id or "default"
        if speaker_id is None:
            # 화자 표기가 없는 기존 대본 — v1.3.0 과 같은 경로다.
            path = self.emotion_refs.get(eid)
            if path and self._usable(path):
                return self._row(path, SOURCE_EMOTION, None)
            if not self.default_ref:
                raise SpeakerReferenceError(DEFAULT_REFERENCE_MISSING, emotion_id=eid)
            return self._row(self.default_ref, SOURCE_DEFAULT, None)

        if speaker_id not in self.registered_speakers:
            # 등록하지 않은 화자를 전역 기본 목소리로 대신 만들지 않는다.
            raise SpeakerReferenceError(SPEAKER_NOT_REGISTERED, speaker_id, eid)

        pair = self.speaker_emotion_refs.get(emotion_key(speaker_id, eid))
        if pair and self._usable(pair):
            return self._row(pair, SOURCE_SPEAKER_EMOTION, speaker_id)
        own = self.speaker_refs.get(speaker_id)
        if own and self._usable(own):
            return self._row(own, SOURCE_SPEAKER, speaker_id)
        # 여기서 감정 참조나 전역 기본으로 내려가지 않는다 — 다른 사람 목소리가 된다.
        raise SpeakerReferenceError(SPEAKER_REFERENCE_NOT_READY, speaker_id, eid)

    def preflight(self, utterances):
        """생성 전 전수 점검. 첫 실패에서 멈춘다(모델을 올리기 전에 알아야 한다).

        utterances: (speaker_id, emotion_id) 순서열. 계획의 발화 순서 그대로 넣는다.
        """
        seen = set()
        for speaker_id, emotion_id in utterances:
            key = (speaker_id, emotion_id or "default")
            if key in seen:
                continue
            seen.add(key)
            self.resolve(speaker_id, emotion_id)
        return True

    # ── 기록용 ────────────────────────────────────────────────────────────
    def duplicate_paths(self):
        """같은 파일을 두 화자 이상에 지정했는가. 막지 않고 알려 주기 위한 값이다."""
        by_path = {}
        for sid, path in self.speaker_refs.items():
            by_path.setdefault(path, []).append(sid)
        return {p: sorted(v) for p, v in by_path.items() if len(v) > 1}

    def _usable(self, path):
        return bool(path) and bool(self._exists(path))

    def _row(self, path, source, speaker_id):
        return {
            "path": path,
            "source": source,
            "reference_id": self.reference_id(path),
            "reference_sha256": self.reference_sha256(path),
            "speaker_ref": opaque_speaker_ref(speaker_id),
        }

    def reference_sha256(self, path):
        """참조 파일 내용의 SHA. 못 구하면 None(0 으로 위조하지 않는다)."""
        if path in self._sha_cache:
            return self._sha_cache[path]
        sha = None
        try:
            if self._sha256_of is not None:
                sha = self._sha256_of(path)
            else:
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    for block in iter(lambda: f.read(1024 * 1024), b""):
                        h.update(block)
                sha = h.hexdigest()
        except Exception:
            sha = None
        self._sha_cache[path] = sha
        return sha

    def reference_id(self, path):
        """manifest 용 불투명 참조 id. **내용**에서 나오므로 경로가 새지 않는다.

        같은 파일을 두 화자에 지정하면 같은 id 가 된다 — 중복 사용이 기록에서도 드러난다.
        내용을 읽을 수 없으면 경로 자체를 해싱한 형태로 물러난다(그래도 경로는 노출되지
        않는다). 두 경우를 접두어로 구분해 사후에 오해하지 않게 한다.
        """
        sha = self.reference_sha256(path)
        if sha:
            return "ref_" + sha[:16]
        return "refp_" + hashlib.sha256((path or "").encode("utf-8")).hexdigest()[:16]
