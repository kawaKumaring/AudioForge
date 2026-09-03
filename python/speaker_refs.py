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
MATCH_STATES = (MATCH_MATCHED, MATCH_INSUFFICIENT, MATCH_NO_RELIABLE,
                MATCH_NO_TARGET, MATCH_UNSUPPORTED)

#: 이 점수 미만이면 고르지 않는다. 유사도가 1/(1+거리) 이므로 0.55 는 거리 0.818 이고,
#: 지배적인 F0 축으로 환산하면 RMS 약 2.5 반음 차이다. 그보다 벌어진 후보를
#: "요청한 감정에 맞다"고 말하지 않는다.
EMOTION_MATCH_MIN_SCORE = 0.55

#: 이 단계에서 절대 참이 될 수 없는 적용 상태. 테스트가 이 사실을 고정한다.
NEVER_APPLIED_STATES = ("model_applied", "post_applied")


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
                 match_min_score=None, compare=None):
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

        pair = self.speaker_emotion_refs.get(emotion_key(speaker_id, eid))
        if pair and self._usable(pair):
            # 사용자가 직접 지정한 것보다 점수가 앞설 이유가 없다. 대조하지 않는다.
            return dict(self._row(pair, SOURCE_SPEAKER_EMOTION, speaker_id),
                        emotion_match=self._match_record(
                            speaker_id, eid, MATCH_MATCHED, SELECTION_EXPLICIT,
                            reference_id=self.reference_id(pair)))

        candidates = self.speaker_candidates(speaker_id)
        if not candidates:
            # 등록은 했지만 쓸 수 있는 클립이 없다 — 전역 기본으로 내려가지 않는다.
            raise SpeakerReferenceError(SPEAKER_REFERENCE_NOT_READY, speaker_id, eid)

        target = self.target_profiles.get(eid) if eid != "default" else None
        if target is None:
            state = MATCH_NO_TARGET if eid != "default" else MATCH_UNSUPPORTED
            reason = "NO_TARGET_PROFILE" if eid != "default" else "NO_EMOTION_REQUESTED"
            return self._fallback(speaker_id, eid, candidates, state, reason=reason)
        if len(candidates) < 2:
            # 하나뿐인 것을 "가장 잘 맞는다"고 말할 수는 없다.
            return self._fallback(speaker_id, eid, candidates, MATCH_INSUFFICIENT,
                                  reason="ONLY_ONE_CANDIDATE")

        compare = self._compare
        if compare is None:
            import emotion_acoustic as _ea
            compare = _ea.compare_profiles_v3

        scored, no_profile = [], 0
        for cand in candidates:
            profile = self.candidate_profile(cand["path"])
            if profile is None:
                no_profile += 1
                continue
            result = compare(target, profile)
            if result.get("score") is None:
                no_profile += 1     # 비교 가능한 축이 하나도 없다 = 판단 자료 없음
                continue
            scored.append((result["score"], cand, result))
        if not scored:
            return self._fallback(speaker_id, eid, candidates, MATCH_NO_RELIABLE,
                                  reason="NO_CANDIDATE_PROFILE", no_profile=no_profile)
        # 점수 내림차순, 같으면 reference_id 오름차순 — 결정적이다.
        scored.sort(key=lambda s: (-s[0], s[1]["reference_id"]))
        best_score, best, best_result = scored[0]
        runner_up = scored[1][0] if len(scored) > 1 else None
        if best_score < self.match_min_score:
            return self._fallback(speaker_id, eid, candidates, MATCH_NO_RELIABLE,
                                  reason="BELOW_MIN_SCORE", best_score=best_score,
                                  no_profile=no_profile, considered=len(scored),
                                  target_profile_id=target.get("profile_id"))
        # 고른 것은 어디까지나 그 화자의 참조다(우선순위 2번 안쪽의 선택).
        return dict(self._row(best["path"], SOURCE_SPEAKER, speaker_id),
                    emotion_match=self._match_record(
                        speaker_id, eid, MATCH_MATCHED, SELECTION_PROFILE_MATCH,
                        reference_id=best["reference_id"], score=best_score,
                        runner_up=runner_up, considered=len(scored),
                        no_profile=no_profile, comparison=best_result,
                        target_profile_id=target.get("profile_id")))

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
                      target_profile_id=None):
        """기록으로 나가는 선택 근거. 표시 이름·경로·대사가 들어갈 자리가 없다."""
        matched = state == MATCH_MATCHED
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
            "application_states": _application_states(
                analyzed=comparison is not None or target_profile_id is not None,
                matched=matched),
        }
        if reason:
            rec["reason"] = reason
        if comparison is not None:
            rec["axes_used"] = comparison.get("axes_used")
            rec["axes_excluded"] = comparison.get("axes_excluded")
            rec["candidate_profile_id"] = comparison.get("candidate_profile_id")
            rec["axis_scores"] = {a: v.get("similarity")
                                  for a, v in (comparison.get("axes") or {}).items()}
        return rec
