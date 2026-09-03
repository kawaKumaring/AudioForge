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


# ─────────────────────────────────────────────────────────────────────────────
# 감정 프로필 기반 참조 선택 (PHASE E2)
#
#   확정된 우선순위를 바꾸지 않는다. 바뀌는 것은 **2번 안쪽**뿐이다 —
#   `(화자, 감정)` 전용 참조가 없을 때 지금까지는 그 화자의 기본 참조로 곧장 갔지만,
#   이제는 그 화자가 가진 클립들 중 요청한 감정 프로필에 가장 가까운 것을 고른다.
#   후보는 언제나 같은 화자의 것뿐이다 — 다른 화자의 클립은 점수가 아무리 높아도
#   후보 목록에 들어오지 않는다. 들어오면 사용자가 고르지 않은 사람이 말하게 된다.
#
#   고른 결과를 "감정을 입혔다"고 적지 않는다. 이 단계에서 참일 수 있는 것은
#   reference_matched 까지이며 model_applied·post_applied 는 항상 거짓이다.
# ─────────────────────────────────────────────────────────────────────────────

EMOTION_SELECTION_SCHEMA_VERSION = 1

# 어떻게 골랐는가.
SELECTION_EXPLICIT = "explicit"                # 사용자가 (화자, 감정)에 직접 지정했다
SELECTION_PROFILE_MATCH = "profile_match"      # 프로필 대조로 골랐다
SELECTION_SPEAKER_DEFAULT = "speaker_default"  # 감정 판단 없이 화자 기본으로 갔다
SELECTION_METHODS = (SELECTION_EXPLICIT, SELECTION_PROFILE_MATCH, SELECTION_SPEAKER_DEFAULT)

# 감정 축이 어디까지 갔는가. 적용 상태와 다른 축이다 — 이것은 "선택"의 결과다.
MATCH_MATCHED = "reference_matched"
MATCH_INSUFFICIENT = "insufficient_candidates"   # 후보가 하나뿐 → 최적이라 말하지 않는다
MATCH_NO_RELIABLE = "no_reliable_candidate"      # 문턱을 넘은 후보가 없다
MATCH_NO_TARGET = "no_target_profile"            # 요청 감정의 기준 프로필이 없다
MATCH_UNSUPPORTED = "unsupported"                # 이 발화에 감정 선택이 성립하지 않는다
#: 사용자가 직접 고른 경우. 잠정 추천보다 강한 근거다 — 사람이 듣고 골랐기 때문이다.
MATCH_USER_SELECTED = "user_selected"
#: 사용자가 감정 참조를 쓰지 않기로 했거나 기본 목소리로 돌아간 경우.
MATCH_USER_DEFAULT = "user_speaker_default"
MATCH_STATES = (MATCH_MATCHED, MATCH_INSUFFICIENT, MATCH_NO_RELIABLE,
                MATCH_NO_TARGET, MATCH_UNSUPPORTED,
                MATCH_USER_SELECTED, MATCH_USER_DEFAULT)

#: 이 점수 미만이면 고르지 않는다. 유사도가 1/(1+거리) 이므로 0.55 는 거리 0.818 이고,
#: 지배적인 F0 축으로 환산하면 RMS 약 2.5 반음 차이다. 그보다 벌어진 후보를
#: "요청한 감정에 맞다"고 말하지 않는다.
EMOTION_MATCH_MIN_SCORE = 0.55

#: 이 단계에서 절대 참이 될 수 없는 적용 상태. 테스트가 이 사실을 고정한다.
NEVER_APPLIED_STATES = ("model_applied", "post_applied")


# ─────────────────────────────────────────────────────────────────────────────
# 후보 목록과 사용자 선택 (PHASE E4)
#
#   자동 추천 기준값이 잠정치인데 사용자가 결과를 보거나 바꿀 수 없으면, 잠정치가 정답처럼
#   행세한다. 그래서 사용자의 선택이 자동 추천보다 **위에** 있다.
#
#   선택은 파일을 건드리지 않는다. 남는 것은 어느 후보를 골랐는지(불투명 id)와 그 사유뿐이다.
# ─────────────────────────────────────────────────────────────────────────────

CANDIDATE_VIEW_SCHEMA_VERSION = 1

#: 후보 대신 고를 수 있는 두 가지. 참조 id 가 아니라 뜻을 담은 토큰이다.
USER_CHOICE_SPEAKER_DEFAULT = "speaker_default"    # 이 인물의 기본 목소리로 돌아간다
USER_CHOICE_NO_EMOTION_REF = "no_emotion_ref"      # 감정 참조를 쓰지 않는다
USER_CHOICES = (USER_CHOICE_SPEAKER_DEFAULT, USER_CHOICE_NO_EMOTION_REF)

#: 사용자 선택으로 정해진 경우의 선택 방법.
SELECTION_USER = "user"

#: 왜 이 참조가 되었는가(비민감 enum). 화면과 기록이 같은 값을 쓴다.
REASON_USER_KEPT_RECOMMENDATION = "USER_KEPT_RECOMMENDATION"
REASON_USER_CHANGED_CANDIDATE = "USER_CHANGED_CANDIDATE"
REASON_USER_CHOSE_SPEAKER_DEFAULT = "USER_CHOSE_SPEAKER_DEFAULT"
REASON_USER_DECLINED_EMOTION_REFERENCE = "USER_DECLINED_EMOTION_REFERENCE"
REASON_USER_SELECTION_NOT_A_CANDIDATE = "USER_SELECTION_NOT_A_CANDIDATE"
REASON_AUTO_PROVISIONAL = "AUTO_PROVISIONAL_RECOMMENDATION"
REASON_EXPLICIT_ASSIGNMENT = "EXPLICIT_EMOTION_ASSIGNMENT"
SELECTION_REASONS = (
    REASON_USER_KEPT_RECOMMENDATION, REASON_USER_CHANGED_CANDIDATE,
    REASON_USER_CHOSE_SPEAKER_DEFAULT, REASON_USER_DECLINED_EMOTION_REFERENCE,
    REASON_USER_SELECTION_NOT_A_CANDIDATE, REASON_AUTO_PROVISIONAL,
    REASON_EXPLICIT_ASSIGNMENT,
)

#: 자동 추천 대상에서 빠지는 이유.
EXCLUDED_SEPARATED_STEM = "SEPARATED_STEM_NOT_RECOMMENDED"
EXCLUDED_NO_PROFILE = "PROFILE_UNAVAILABLE"
EXCLUDED_QUALITY_INVALID = "REFERENCE_QUALITY_INVALID"
CANDIDATE_EXCLUSIONS = (EXCLUDED_SEPARATED_STEM, EXCLUDED_NO_PROFILE,
                        EXCLUDED_QUALITY_INVALID)

#: 후보의 참조 품질 상태. `reference_audio` 판정을 그대로 옮긴 값이다(새 판정 아님).
QUALITY_OK = "ok"
QUALITY_WARNING = "warning"
QUALITY_INVALID = "invalid"
QUALITY_UNKNOWN = "unknown"          # 아직 분석하지 않았다
CANDIDATE_QUALITY_STATES = (QUALITY_OK, QUALITY_WARNING, QUALITY_INVALID,
                            QUALITY_UNKNOWN)


def _application_states(analyzed, matched):
    """여섯 상태 기록. 앞 단계를 뒤 단계로 승격하지 않는다."""
    return {
        "requested": True,
        "analyzed": bool(analyzed),
        "reference_matched": bool(matched),
        # 모델에 감정 제어값을 넘기는 통로가 없다(E3 감사 참조). 후처리도 하지 않는다.
        "model_applied": False,
        "post_applied": False,
        "unsupported": not bool(matched),
    }


class ReferenceTable:
    """이번 작업이 쓸 참조 표. 한 번 만들고 chunk 마다 조회한다.

    `exists` 는 주입받는다 — 파일 확인을 실제로 하되 테스트가 디스크 없이 표를 검증할 수
    있어야 하기 때문이다. 기본값은 실제 파일 시스템이다.
    """

    def __init__(self, default_ref, emotion_refs=None, speaker_refs=None,
                 speaker_emotion_refs=None, registered_speakers=None, exists=None,
                 sha256_of=None, target_profiles=None, profile_of=None,
                 match_min_score=None, compare=None, user_selections=None,
                 candidate_meta=None):
        # 사용자 선택: emotion_key(화자, 감정) → 참조 id 또는 USER_CHOICES 토큰.
        # 비어 있으면 예전과 같이 자동 추천만 돈다.
        self.user_selections = {str(k): str(v) for k, v in (user_selections or {}).items()
                                if isinstance(v, str) and v.strip()}
        # 후보 표시 재료: 경로 → {duration_sec, source_kind, quality_state, quality_codes}.
        # 값은 기존 `reference_audio` 분석 결과를 옮긴 것이고 여기서 새로 재지 않는다.
        self.candidate_meta = dict(candidate_meta or {})
        # 감정 선택 재료. 하나도 주지 않으면 표는 v1.3.0 과 똑같이 동작한다.
        self.target_profiles = target_profiles or {}
        self._profile_of = profile_of
        self.match_min_score = float(EMOTION_MATCH_MIN_SCORE if match_min_score is None
                                     else match_min_score)
        self._compare = compare
        self._profile_cache = {}
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


    # ── 감정 프로필 선택 (PHASE E2) ──────────────────────────────────────
    def speaker_candidates(self, speaker_id):
        """이 화자가 가진 쓸 수 있는 클립 전부. 다른 화자의 것은 여기 없다.

        후보 목록을 화자별로 만드는 것이 교차 오염을 막는 구조적 장치다 — 점수를 매긴
        뒤에 걸러내는 것이 아니라, 애초에 다른 사람의 클립이 목록에 오르지 않는다.
        """
        if speaker_id is None:
            return []
        paths, prefix = [], "%s%s" % (speaker_id, chr(31))
        own = self.speaker_refs.get(speaker_id)
        if own:
            paths.append(own)
        for key, path in self.speaker_emotion_refs.items():
            if key.startswith(prefix):
                paths.append(path)
        out, seen = [], set()
        for p in paths:
            if p in seen or not self._usable(p):
                continue
            seen.add(p)
            out.append({"path": p, "reference_id": self.reference_id(p)})
        # 같은 입력이면 같은 순서 — 점수가 같아도 결과가 흔들리지 않는다.
        out.sort(key=lambda r: r["reference_id"])
        return out

    def candidate_profile(self, path):
        """후보 클립의 v3 프로필. 못 구하면 None — 지어내지 않는다."""
        if self._profile_of is None:
            return None
        if path in self._profile_cache:
            return self._profile_cache[path]
        try:
            profile = self._profile_of(path)
        except Exception:
            profile = None      # 분석 실패가 합성을 막지 않는다. 감정 선택만 포기한다.
        self._profile_cache[path] = profile
        return profile

    def resolve_with_emotion(self, speaker_id, emotion_id):
        """resolve() 의 결과 + 감정 선택 근거.

        반환 dict 는 resolve() 와 같은 키에 emotion_match 가 더해진 것이다. 실패 조건도
        resolve() 와 같다 — 명시된 화자를 다른 목소리로 대신하지 않는다.
        """
        eid = emotion_id or "default"
        if speaker_id is None:
            # 화자 표기가 없는 기존 대본 — v1.3.0 경로 그대로다. 선택 계층이 끼지 않는다.
            row = self.resolve(None, emotion_id)
            return dict(row, emotion_match=self._match_record(
                None, eid, MATCH_UNSUPPORTED, SELECTION_SPEAKER_DEFAULT,
                reason="NO_SPEAKER_NOTATION"))

        if speaker_id not in self.registered_speakers:
            raise SpeakerReferenceError(SPEAKER_NOT_REGISTERED, speaker_id, eid)

        # 사용자가 이 (화자, 감정)에 대해 직접 고른 것이 있으면 그것이 최우선이다.
        # 잠정 기준값으로 뽑은 추천이 사람의 선택을 덮을 수는 없다.
        choice = self.user_selections.get(emotion_key(speaker_id, eid))
        if choice:
            row = self._resolve_user_choice(speaker_id, eid, choice)
            if row is not None:
                return row
            # 고른 후보가 더 이상 이 화자의 후보가 아니다(파일이 빠졌다) → 자동으로 내려가되
            # 그 사실을 사유로 남긴다. 다른 화자의 파일로 대체하지 않는다.

        pair = self.speaker_emotion_refs.get(emotion_key(speaker_id, eid))
        if pair and self._usable(pair):
            # 사용자가 직접 지정한 것보다 점수가 앞설 이유가 없다. 대조하지 않는다.
            return dict(self._row(pair, SOURCE_SPEAKER_EMOTION, speaker_id),
                        emotion_match=self._match_record(
                            speaker_id, eid, MATCH_MATCHED, SELECTION_EXPLICIT,
                            reference_id=self.reference_id(pair),
                            selection_reason=REASON_EXPLICIT_ASSIGNMENT,
                            stale_user_choice=bool(choice)))

        candidates = self.speaker_candidates(speaker_id)
        if not candidates:
            # 등록은 했지만 쓸 수 있는 클립이 없다 — 전역 기본으로 내려가지 않는다.
            raise SpeakerReferenceError(SPEAKER_REFERENCE_NOT_READY, speaker_id, eid)

        target = self.target_profiles.get(eid) if eid != "default" else None
        if target is None:
            state = MATCH_NO_TARGET if eid != "default" else MATCH_UNSUPPORTED
            reason = "NO_TARGET_PROFILE" if eid != "default" else "NO_EMOTION_REQUESTED"
            return self._fallback(speaker_id, eid, candidates, state, reason=reason,
                                  stale_user_choice=bool(choice))
        if len(candidates) < 2:
            # 하나뿐인 것을 "가장 잘 맞는다"고 말할 수는 없다.
            return self._fallback(speaker_id, eid, candidates, MATCH_INSUFFICIENT,
                                  reason="ONLY_ONE_CANDIDATE",
                                  stale_user_choice=bool(choice))

        rows = self._score_candidates(speaker_id, eid, candidates, target)
        eligible = [r for r in rows if r["excluded"] is None]
        no_profile = sum(1 for r in rows if r["excluded"] == EXCLUDED_NO_PROFILE)
        if not eligible:
            return self._fallback(speaker_id, eid, candidates, MATCH_NO_RELIABLE,
                                  reason="NO_CANDIDATE_PROFILE", no_profile=no_profile,
                                  stale_user_choice=bool(choice))
        best = eligible[0]
        runner_up = eligible[1]["score"] if len(eligible) > 1 else None
        if best["score"] < self.match_min_score:
            return self._fallback(speaker_id, eid, candidates, MATCH_NO_RELIABLE,
                                  reason="BELOW_MIN_SCORE", best_score=best["score"],
                                  no_profile=no_profile, considered=len(eligible),
                                  target_profile_id=target.get("profile_id"),
                                  stale_user_choice=bool(choice))
        # 고른 것은 어디까지나 그 화자의 참조다(우선순위 2번 안쪽의 선택).
        return dict(self._row(best["path"], SOURCE_SPEAKER, speaker_id),
                    emotion_match=self._match_record(
                        speaker_id, eid, MATCH_MATCHED, SELECTION_PROFILE_MATCH,
                        reference_id=best["reference_id"], score=best["score"],
                        runner_up=runner_up, considered=len(eligible),
                        no_profile=no_profile, comparison=best["comparison"],
                        target_profile_id=target.get("profile_id"),
                        recommended_reference=best["reference_id"],
                        selection_reason=REASON_AUTO_PROVISIONAL,
                        stale_user_choice=bool(choice)))

    # ── 채점: 추천과 화면이 같은 계산을 쓴다(두 벌 만들지 않는다) ─────────
    def _score_candidates(self, speaker_id, eid, candidates=None, target=None):
        """후보마다 점수와 **자동 추천에서 빠진 사유**. 점수 높은 것이 앞이다.

        빠지는 사유는 셋이다.
          · 참조 품질이 부적합하다(기존 `reference_audio` 판정을 그대로 옮긴 값)
          · 음악에서 분리한 보컬이다 — 반주 잔향이 연기로 측정되므로 추천하지 않는다
          · 프로필을 못 쟀다(비교 자료 없음)

        빠진 후보도 목록에서 사라지지 않는다. 사용자가 직접 고를 수는 있어야 한다.
        """
        if candidates is None:
            candidates = self.speaker_candidates(speaker_id)
        if target is None:
            target = self.target_profiles.get(eid) if eid != "default" else None
        compare = self._compare
        if compare is None:
            import emotion_acoustic as _ea
            compare = _ea.compare_profiles_v3

        rows = []
        for cand in candidates:
            meta = self.candidate_meta.get(cand["path"]) or {}
            row = dict(cand, score=None, comparison=None, excluded=None,
                       source_kind=meta.get("source_kind") or "unknown",
                       duration_sec=meta.get("duration_sec"),
                       quality_state=meta.get("quality_state") or QUALITY_UNKNOWN,
                       quality_codes=list(meta.get("quality_codes") or ()))
            profile = self.candidate_profile(cand["path"]) if target is not None else None
            if profile is not None:
                result = compare(target, profile)
                if result.get("score") is not None:
                    row["score"] = result["score"]
                    row["comparison"] = result
            if row["quality_state"] == QUALITY_INVALID:
                row["excluded"] = EXCLUDED_QUALITY_INVALID
            elif row["source_kind"] == "separated_stem":
                row["excluded"] = EXCLUDED_SEPARATED_STEM
            elif row["score"] is None:
                row["excluded"] = EXCLUDED_NO_PROFILE
            rows.append(row)
        # 점수 내림차순, 같으면 reference_id 오름차순 — 결정적이다. 제외된 후보는 뒤로.
        rows.sort(key=lambda r: (r["excluded"] is not None,
                                 -(r["score"] if r["score"] is not None else -1.0),
                                 r["reference_id"]))
        return rows

    def recommended_candidate(self, speaker_id, emotion_id):
        """지금 자동으로 추천되는 후보. 없으면 None.

        후보가 하나뿐이면 **추천하지 않는다** — 고를 여지가 없는 것을 최적이라 부르지 않는다.
        """
        eid = emotion_id or "default"
        target = self.target_profiles.get(eid) if eid != "default" else None
        if target is None:
            return None
        candidates = self.speaker_candidates(speaker_id)
        if len(candidates) < 2:
            return None
        rows = self._score_candidates(speaker_id, eid, candidates, target)
        eligible = [r for r in rows if r["excluded"] is None]
        if not eligible or eligible[0]["score"] < self.match_min_score:
            return None
        best = eligible[0]
        return dict(best, runner_up_score=(eligible[1]["score"]
                                           if len(eligible) > 1 else None),
                    eligible_count=len(eligible))

    # ── 사용자 선택 ───────────────────────────────────────────────────────
    def _resolve_user_choice(self, speaker_id, eid, choice):
        """사용자가 고른 것을 그대로 쓴다. 고를 수 없는 값이면 None(자동으로 내려간다).

        어떤 경우에도 **다른 화자의 파일로 가지 않는다** — 후보 목록 자체가 이 화자의
        것뿐이기 때문이다.
        """
        candidates = self.speaker_candidates(speaker_id)
        if not candidates:
            raise SpeakerReferenceError(SPEAKER_REFERENCE_NOT_READY, speaker_id, eid)

        if choice in USER_CHOICES:
            own = self.speaker_refs.get(speaker_id)
            path = own if (own and self._usable(own)) else candidates[0]["path"]
            reason = (REASON_USER_DECLINED_EMOTION_REFERENCE
                      if choice == USER_CHOICE_NO_EMOTION_REF
                      else REASON_USER_CHOSE_SPEAKER_DEFAULT)
            return dict(self._row(path, SOURCE_SPEAKER, speaker_id),
                        emotion_match=self._match_record(
                            speaker_id, eid, MATCH_USER_DEFAULT, SELECTION_USER,
                            reference_id=self.reference_id(path),
                            selection_reason=reason, user_selected_reference=choice,
                            considered=len(candidates)))

        for cand in candidates:
            if cand["reference_id"] != choice:
                continue
            rec = self.recommended_candidate(speaker_id, eid)
            same = bool(rec) and rec["reference_id"] == choice
            reason = (REASON_USER_KEPT_RECOMMENDATION if same
                      else REASON_USER_CHANGED_CANDIDATE)
            return dict(self._row(cand["path"], SOURCE_SPEAKER, speaker_id),
                        emotion_match=self._match_record(
                            speaker_id, eid, MATCH_USER_SELECTED, SELECTION_USER,
                            reference_id=choice, selection_reason=reason,
                            user_selected_reference=choice,
                            recommended_reference=(rec["reference_id"] if rec else None),
                            score=(rec["score"] if same else None),
                            comparison=(rec["comparison"] if same else None),
                            considered=len(candidates)))
        return None      # 고른 후보가 사라졌다 — 호출부가 자동으로 내려간다

    # ── 화면용 후보 목록 ──────────────────────────────────────────────────
    def candidate_view(self, speaker_id, emotion_id):
        """화면이 그릴 후보 목록.

        ⚠️ **파일 이름이 들어 있다.** 화면 전용이며 manifest·run bundle 로 내보내지 않는다.
        기록으로 나가는 것은 `selection`(불투명 id 와 사유뿐) 하나다.
        """
        eid = emotion_id or "default"
        candidates = self.speaker_candidates(speaker_id)
        target = self.target_profiles.get(eid) if eid != "default" else None
        rows = self._score_candidates(speaker_id, eid, candidates, target)
        rec = self.recommended_candidate(speaker_id, eid)
        rec_id = rec["reference_id"] if rec else None

        selection, error = None, None
        try:
            selection = self.resolve_with_emotion(speaker_id, emotion_id)["emotion_match"]
        except SpeakerReferenceError as exc:
            error = exc.code
        resolved = selection.get("resolved_reference") if selection else None

        out = []
        for row in rows:
            detail = None
            if row["comparison"] is not None:
                detail = {
                    "score": row["score"],
                    "axis_scores": {a: v.get("similarity") for a, v
                                    in (row["comparison"].get("axes") or {}).items()},
                    "axes_excluded": row["comparison"].get("axes_excluded"),
                    "candidate_profile_id": row["comparison"].get("candidate_profile_id"),
                }
            out.append({
                "reference_id": row["reference_id"],
                # 사용자가 자기가 고른 파일을 알아볼 수 있어야 한다 — 폴더는 넣지 않는다.
                "file_label": os.path.basename(row["path"]),
                "duration_sec": row["duration_sec"],
                "source_kind": row["source_kind"],
                "quality_state": row["quality_state"],
                "quality_codes": row["quality_codes"],
                "analyzable": row["score"] is not None,
                "recommended": row["reference_id"] == rec_id,
                "selected": row["reference_id"] == resolved,
                "excluded_reason": row["excluded"],
                "detail": detail,
            })
        return {
            "schema": "af-emotion-candidates/%d" % CANDIDATE_VIEW_SCHEMA_VERSION,
            "speaker_ref": opaque_speaker_ref(speaker_id),
            "emotion_id": eid,
            "candidate_count": len(candidates),
            # 후보가 하나뿐이면 화면이 "가장 적합"이라 말하지 못하게 한다.
            "insufficient_candidates": len(candidates) < 2,
            "provisional_threshold": round(self.match_min_score, 4),
            "threshold_provisional": True,
            "candidates": out,
            "selection": selection,
            "blocked": error,
        }

    def _fallback(self, speaker_id, eid, candidates, state, reason=None, **extra):
        """감정 선택을 못 했다 — 화자 기본 참조로 간다. 성공으로 적지 않는다."""
        own = self.speaker_refs.get(speaker_id)
        path = own if (own and self._usable(own)) else candidates[0]["path"]
        considered = extra.pop("considered", len(candidates))
        return dict(self._row(path, SOURCE_SPEAKER, speaker_id),
                    emotion_match=self._match_record(
                        speaker_id, eid, state, SELECTION_SPEAKER_DEFAULT, reason=reason,
                        reference_id=self.reference_id(path), considered=considered,
                        **extra))

    def _match_record(self, speaker_id, emotion_id, state, method, reason=None,
                      reference_id=None, score=None, runner_up=None, considered=0,
                      no_profile=0, comparison=None, best_score=None,
                      target_profile_id=None, selection_reason=None,
                      recommended_reference=None, user_selected_reference=None,
                      stale_user_choice=False):
        """기록으로 나가는 선택 근거. 표시 이름·경로·대사가 들어갈 자리가 없다."""
        matched = state in (MATCH_MATCHED, MATCH_USER_SELECTED)
        shown = score if score is not None else best_score
        rec = {
            "schema": "af-emotion-selection/%d" % EMOTION_SELECTION_SCHEMA_VERSION,
            "emotion_id": emotion_id,
            "speaker_ref": opaque_speaker_ref(speaker_id),
            "state": state,
            "selection_method": method,
            "candidates_considered": int(considered),
            "candidates_without_profile": int(no_profile),
            "min_score": round(self.match_min_score, 4),
            "score": round(float(shown), 4) if shown is not None else None,
            "runner_up_score": round(float(runner_up), 4) if runner_up is not None else None,
            "reference_id": reference_id,
            "target_profile_id": target_profile_id,
            # ── 구분해 남기는 여섯 상태 (PHASE E4) ──────────────────────
            # 추천과 사용자 선택과 실제 결과를 한 칸에 뭉개지 않는다.
            "recommended_reference": recommended_reference,
            "user_selected_reference": user_selected_reference,
            "resolved_reference": reference_id,
            "selection_reason": selection_reason,
            "provisional_threshold": round(self.match_min_score, 4),
            # 이 문턱은 실측 교정 전이다 — 정답 기준처럼 쓰지 않는다.
            "threshold_provisional": True,
            "insufficient_candidates": state == MATCH_INSUFFICIENT,
            "application_states": _application_states(
                analyzed=comparison is not None or target_profile_id is not None,
                matched=matched),
        }
        if reason:
            rec["reason"] = reason
        if stale_user_choice:
            # 사용자가 골랐던 후보가 사라져 자동으로 내려갔다는 사실을 숨기지 않는다.
            rec["user_selection_stale"] = True
            rec["selection_reason"] = REASON_USER_SELECTION_NOT_A_CANDIDATE
        if comparison is not None:
            rec["axes_used"] = comparison.get("axes_used")
            rec["axes_excluded"] = comparison.get("axes_excluded")
            rec["candidate_profile_id"] = comparison.get("candidate_profile_id")
            rec["axis_scores"] = {a: v.get("similarity")
                                  for a, v in (comparison.get("axes") or {}).items()}
        return rec
