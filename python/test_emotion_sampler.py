# -*- coding: utf-8 -*-
"""감정 샘플러 단위테스트 (Agent C 소유). 합성 데이터만 — GPU·모델·오디오·파일 생성 없음.

검증 축:
  1) 캐시 키 결정성 + 입력 차원별 독립 변화
  2) hit → 재사용(생성 호출 0), 재생성 차단
  3) 실패/강등 상태 각각이 서로 다른 문구로 렌더 가능
  4) '전 감정 일괄 생성' 진입점 부재(소스 파싱 + 런타임 시그니처)
  5) 문구 버전 bump → 캐시 무효화, 문구 변경 시 버전 강제
  6) 위생: 경로/전사문/프롬프트가 상태 dict·캐시 키에 들어갈 수 없음
  7) parity: src/shared/emotionSampler.ts 소스를 파싱해 상수·직렬화·코드 문자열 대조
     (레포의 parity-by-parsing 선례 — test_tts_grammar_parity 가 tts_worker.py 를 ast 로 읽는 방식)

실행:
  python -m unittest discover -s python -p "test_emotion_sampler.py"
"""
import inspect
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import emotion_sampler as es  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_PATH = os.path.join(REPO_ROOT, "src", "shared", "emotionSampler.ts")
PY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "emotion_sampler.py")


def _read_source(path):
    """⚠️ core.autocrlf=true 인 레포다 — 새 체크아웃에서는 CRLF 로 내려온다.
    소스를 '파싱'하는 테스트라 개행을 먼저 LF 로 정규화해야 정규식이 체크아웃 방식에 흔들리지 않는다."""
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


TS_SRC = _read_source(TS_PATH)
PY_SRC = _read_source(PY_PATH)

FP_A = "a" * 64
FP_B = "b" * 64


def make_input(**over):
    inp = {
        "voice_content_sha256": FP_A,
        "engine_id": "qwen",
        "model_id": "qwen3-omni-flash",
        "emotion_id": "happy",
        "config": dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG),
    }
    inp.update(over)
    return inp


KEY_A = es.build_cache_key(make_input())


def _strip_comments(src):
    """주석 제거 — 설명 주석이 금지 패턴에 걸려 거짓 실패하는 것을 막는다."""
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"^[ \t]*//.*$", "", src, flags=re.MULTILINE)
    return src


TS_CODE = _strip_comments(TS_SRC)


def _strip_py_comments(src):
    # 독스트링과 # 주석을 걷어낸 '실제 코드'만 남긴다.
    # 설명 주석에 적힌 단어(예: mtimeMs)가 금지 패턴 검사에 걸려 거짓 실패하는 것을 막는다.
    src = re.sub(r'"""[\s\S]*?"""', "", src)
    src = re.sub(r"'''[\s\S]*?'''", "", src)
    src = re.sub(r"#.*$", "", src, flags=re.MULTILINE)
    return src


PY_CODE = _strip_py_comments(PY_SRC)


# ── TS 소스 파서(parity-by-parsing) ────────────────────────────────────────
def ts_int(name):
    m = re.search(r"^export const %s = (-?\d+)$" % re.escape(name), TS_SRC, re.MULTILINE)
    assert m, "TS 상수 %s 를 찾지 못함" % name
    return int(m.group(1))


def ts_str(name):
    m = re.search(r"export const %s\b[^=]*=\s*'((?:[^'\\]|\\.)*)'" % re.escape(name), TS_SRC)
    assert m, "TS 문자열 상수 %s 를 찾지 못함" % name
    return m.group(1)


def ts_array(name):
    m = re.search(r"export const %s\b[^=]*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]" % re.escape(name), TS_SRC)
    assert m, "TS 배열 %s 를 찾지 못함" % name
    return re.findall(r"'([^']*)'", m.group(1))


def ts_record(name):
    m = re.search(r"export const %s\b[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)" % re.escape(name), TS_SRC)
    assert m, "TS 레코드 %s 를 찾지 못함" % name
    return dict(re.findall(r"(\w+):\s*'([^']*)'", m.group(1)))


# ─────────────────────────────────────────────────────────────────────────────
class CacheKeyTest(unittest.TestCase):
    def test_deterministic_hex64(self):
        self.assertRegex(KEY_A, r"^[0-9a-f]{64}$")
        for _ in range(5):
            self.assertEqual(es.build_cache_key(make_input()), KEY_A)
        # dict 인스턴스가 달라도 값이 같으면 같은 키
        self.assertEqual(es.build_cache_key(json.loads(json.dumps(make_input()))), KEY_A)

    def test_canonical_payload_shape(self):
        payload = es.canonical_cache_key_payload(make_input())
        self.assertNotRegex(payload, r"\s", "canonical payload 에 공백 없음")
        self.assertNotRegex(payload, r"\d\.\d", "canonical payload 에 float 없음")
        parsed = json.loads(payload)
        self.assertEqual(list(parsed.keys()), [
            "config", "emotion_id", "engine_id", "key_version", "model_id", "phrase_version", "voice_content_sha256",
        ])
        self.assertEqual(list(parsed["config"].keys()), [
            "pitch_centi", "speed_milli", "tail_fade_ms", "tail_mode", "tail_padding_ms",
        ])
        self.assertEqual(es.build_cache_key(make_input()), es.sampler_sha256_hex(payload))

    def test_pinned_parity_vector(self):
        self.assertEqual(es.canonical_cache_key_payload(es.EMOTION_SAMPLER_PARITY_INPUT),
                         es.EMOTION_SAMPLER_PARITY_PAYLOAD)
        self.assertEqual(es.build_cache_key(es.EMOTION_SAMPLER_PARITY_INPUT), es.EMOTION_SAMPLER_PARITY_KEY)

    # ── 계약 3: 각 차원이 '독립적으로' 키를 바꾼다 ──
    def test_voice_content_sha256_changes_key(self):
        self.assertNotEqual(es.build_cache_key(make_input(voice_content_sha256=FP_B)), KEY_A)

    def test_engine_changes_key(self):
        self.assertNotEqual(es.build_cache_key(make_input(engine_id="gptsovits")), KEY_A)

    def test_model_changes_key(self):
        self.assertNotEqual(es.build_cache_key(make_input(model_id="qwen3-omni-instruct")), KEY_A)

    def test_emotion_changes_key_and_no_collision(self):
        self.assertNotEqual(es.build_cache_key(make_input(emotion_id="sad")), KEY_A)
        ids = ["happy", "sad", "angry", "surprise", "whisper", "serious", "cheerful", "narration", "default"]
        keys = {es.build_cache_key(make_input(emotion_id=i)) for i in ids}
        self.assertEqual(len(keys), len(ids), "감정별 키 충돌 없음")

    def test_each_config_field_changes_key(self):
        base = dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG)
        variants = [
            dict(base, speed=1.05),
            dict(base, pitch=-0.5),
            dict(base, tail_mode="off"),
            dict(base, tail_padding_ms=121),
            dict(base, tail_fade_ms=9),
        ]
        seen = {KEY_A}
        for cfg in variants:
            k = es.build_cache_key(make_input(config=cfg))
            self.assertNotEqual(k, KEY_A, "config 변경이 키를 바꿔야 함: %r" % (cfg,))
            self.assertNotIn(k, seen, "config 변형끼리도 키가 서로 다름")
            seen.add(k)

    def test_phrase_version_bump_invalidates(self):
        bumped = es.build_cache_key_at(make_input(), es.EMOTION_SAMPLER_PHRASE_VERSION + 1,
                                       es.EMOTION_SAMPLER_KEY_VERSION)
        self.assertNotEqual(bumped, KEY_A)
        self.assertEqual(es.build_cache_key_at(make_input(), es.EMOTION_SAMPLER_PHRASE_VERSION,
                                               es.EMOTION_SAMPLER_KEY_VERSION), KEY_A)

    def test_key_version_bump_invalidates(self):
        self.assertNotEqual(
            es.build_cache_key_at(make_input(), es.EMOTION_SAMPLER_PHRASE_VERSION,
                                  es.EMOTION_SAMPLER_KEY_VERSION + 1),
            KEY_A)

    def test_out_of_range_config_raises_not_clamps(self):
        bad = [
            {"speed": 0.4}, {"speed": 2.1}, {"pitch": -2.5}, {"pitch": 2.5},
            {"tail_padding_ms": 301}, {"tail_padding_ms": -1}, {"tail_fade_ms": 21},
            {"tail_padding_ms": 120.5}, {"tail_fade_ms": 8.5},
            {"tail_padding_ms": True}, {"speed": float("nan")}, {"speed": float("inf")},
            {"speed": "1.0"},
        ]
        for patch in bad:
            cfg = dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG)
            cfg.update(patch)
            with self.assertRaises(es.EmotionSamplerInputError, msg="범위 밖 설정 거부: %r" % (patch,)) as cm:
                es.build_cache_key(make_input(config=cfg))
            self.assertEqual(cm.exception.code, "SAMPLER_INVALID_CONFIG")
        with self.assertRaises(es.EmotionSamplerInputError):
            cfg = dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG, tail_mode="weird")
            es.build_cache_key(make_input(config=cfg))

    def test_quantize_half_away_from_zero(self):
        zero = es.canonical_cache_key_payload(make_input(
            config=dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG, pitch=0.0)))
        self.assertIn('"pitch_centi":0', zero)
        self.assertNotIn(":-0", zero)
        neg = es.canonical_cache_key_payload(make_input(
            config=dict(es.EMOTION_SAMPLER_DEFAULT_CONFIG, pitch=-1.5)))
        self.assertIn('"pitch_centi":-150', neg)
        # banker's rounding 이면 0.005 → 0 이 되는 지점을 부호 대칭으로 처리
        self.assertEqual(es._quantize(0.5, 1, "x", -10, 10), 1)
        self.assertEqual(es._quantize(-0.5, 1, "x", -10, 10), -1)
        self.assertEqual(es._quantize(1.5, 1, "x", -10, 10), 2)
        self.assertEqual(es._quantize(2.5, 1, "x", -10, 10), 3)   # round() 였다면 2


class PhraseSetTest(unittest.TestCase):
    def test_short_and_pinned_digest(self):
        self.assertTrue(1 <= len(es.EMOTION_SAMPLER_PHRASES) <= 4, "문구 세트는 짧게 유지")
        for p in es.EMOTION_SAMPLER_PHRASES:
            self.assertTrue(0 < len(p) <= 40, "각 문구는 짧게")
        self.assertLessEqual(len(es.phrase_script()), 80, "표준 대본 전체가 짧아야 한다")
        # ⚠️ 여기서 깨지면 문구를 바꾼 것이다 → EMOTION_SAMPLER_PHRASE_VERSION 을 올리고 상수를 갱신할 것.
        self.assertEqual(es.phrase_set_digest(), es.EMOTION_SAMPLER_PHRASE_SET_SHA256)

    def test_phrase_text_not_in_cache_key_input(self):
        payload = es.canonical_cache_key_payload(make_input())
        for p in es.EMOTION_SAMPLER_PHRASES:
            self.assertNotIn(p, payload, "문구 원문이 키 입력에 없음")
        self.assertIn('"phrase_version":', payload)

    def test_phrases_have_no_emotion_tag(self):
        script = es.phrase_script()
        self.assertNotIn("[", script)
        self.assertNotIn("]", script)


class StatesAndReasonsTest(unittest.TestCase):
    def test_labels_unique_and_nonempty(self):
        self.assertEqual(len(set(es.EMOTION_SAMPLE_STATES)), len(es.EMOTION_SAMPLE_STATES))
        self.assertEqual(len(set(es.EMOTION_SAMPLE_REASON_CODES)), len(es.EMOTION_SAMPLE_REASON_CODES))
        state_labels = [es.EMOTION_SAMPLE_STATE_LABEL[s] for s in es.EMOTION_SAMPLE_STATES]
        self.assertEqual(len(set(state_labels)), len(state_labels), "상태 라벨이 서로 구별됨")
        self.assertTrue(all(l.strip() for l in state_labels))
        reason_labels = [es.EMOTION_SAMPLE_REASON_LABEL[r] for r in es.EMOTION_SAMPLE_REASON_CODES]
        self.assertEqual(len(set(reason_labels)), len(reason_labels), "사유 라벨이 서로 구별됨")
        self.assertTrue(all(l.strip() for l in reason_labels))

    def test_reason_belongs_to_exactly_one_state(self):
        seen = {}
        for s in es.EMOTION_SAMPLE_STATES:
            for r in es.EMOTION_SAMPLE_STATE_REASONS[s]:
                self.assertNotIn(r, seen, "사유 %s 중복 배정" % r)
                seen[r] = s
        self.assertEqual(sorted(seen), sorted(es.EMOTION_SAMPLE_REASON_CODES))
        # 계약 4 세 갈래가 각각 '이름 있는' 상태다.
        for name in ("failed", "limitExceeded", "degraded"):
            self.assertIn(name, es.EMOTION_SAMPLE_STATES)
        self.assertEqual(es.EMOTION_SAMPLE_STATE_REASONS["limitExceeded"], ("SAMPLER_GENERATION_LIMIT",))
        self.assertEqual(es.EMOTION_SAMPLE_STATE_REASONS["degraded"], ("SAMPLER_XVECTOR_ONLY",))

    def test_every_state_renderable_and_distinct(self):
        rendered = []
        for state in es.EMOTION_SAMPLE_STATES:
            reasons = es.EMOTION_SAMPLE_STATE_REASONS[state] or (None,)
            for reason in reasons:
                v = es.describe_sample({"emotion_id": "happy", "state": state,
                                        "reason": reason, "cache_key": KEY_A})
                self.assertTrue(v["state_label"].strip(), "%s: 상태 문구 존재" % state)
                self.assertEqual(v["state"], state)
                self.assertEqual(v["reason"], reason)
                if reason:
                    self.assertTrue((v["reason_label"] or "").strip(), "%s/%s: 사유 문구" % (state, reason))
                else:
                    self.assertIsNone(v["reason_label"])
                self.assertTrue(v["generate_label"].strip())
                if not v["generate_enabled"]:
                    self.assertTrue((v["generate_notice"] or "").strip(), "%s: 비활성 사유 문장 필요" % state)
                else:
                    self.assertIsNone(v["generate_notice"], "%s: 활성이면 사유 없음" % state)
                rendered.append("%s|%s|%s|%s|%s" % (
                    v["state_label"], v["reason_label"] or "", v["generate_label"],
                    v["generate_notice"] or "", v["tone"]))
        self.assertEqual(len(set(rendered)), len(rendered), "상태/사유 조합의 표시가 서로 구별됨")

    def test_three_failure_kinds_distinct(self):
        def mk(state, reason):
            return es.describe_sample({"emotion_id": "happy", "state": state,
                                       "reason": reason, "cache_key": KEY_A})
        failed = mk("failed", "SAMPLER_ENGINE_ERROR")
        limit = mk("limitExceeded", "SAMPLER_GENERATION_LIMIT")
        degraded = mk("degraded", "SAMPLER_XVECTOR_ONLY")
        self.assertEqual(len({failed["state_label"], limit["state_label"], degraded["state_label"]}), 3)
        self.assertEqual(len({failed["reason_label"], limit["reason_label"], degraded["reason_label"]}), 3)
        self.assertFalse(limit["audition_enabled"], "한도 초과는 결과를 버렸으므로 재생 불가")
        self.assertTrue(degraded["audition_enabled"], "강등 샘플은 재생 가능")
        self.assertFalse(failed["audition_enabled"])
        self.assertEqual(degraded["tone"], "warn")
        self.assertEqual(limit["tone"], "error")


class StateMachineTest(unittest.TestCase):
    def _generating(self, emotion="happy"):
        return es.apply_event(es.initial_entry(emotion, KEY_A), {"type": "GENERATE_REQUESTED"})["entry"]

    def test_happy_path(self):
        e0 = es.initial_entry("happy", KEY_A)
        self.assertEqual(e0["state"], "idle")
        self.assertIsNone(e0["reason"])
        t1 = es.apply_event(e0, {"type": "GENERATE_REQUESTED"})
        self.assertTrue(t1["applied"])
        self.assertEqual(t1["entry"]["state"], "generating")
        t2 = es.apply_event(t1["entry"], {"type": "GENERATE_SUCCEEDED"})
        self.assertEqual(t2["entry"]["state"], "ready")
        self.assertIsNone(t2["entry"]["reason"])
        self.assertEqual(t2["entry"]["cache_key"], KEY_A, "키는 전이로 바뀌지 않는다")

    def test_xvector_only_degraded(self):
        t = es.apply_event(self._generating(), {"type": "GENERATE_SUCCEEDED", "degraded": True})
        self.assertEqual(t["entry"]["state"], "degraded")
        self.assertEqual(t["entry"]["reason"], "SAMPLER_XVECTOR_ONLY")

    def test_generation_limit_exceeded(self):
        t = es.apply_event(self._generating(), {"type": "GENERATE_LIMIT_EXCEEDED"})
        self.assertEqual(t["entry"]["state"], "limitExceeded")
        self.assertEqual(t["entry"]["reason"], "SAMPLER_GENERATION_LIMIT")
        self.assertFalse(es.is_auditionable(t["entry"]["state"]))

    def test_unknown_failure_reason_forced_to_unknown(self):
        t = es.apply_event(self._generating(), {"type": "GENERATE_FAILED", "reason": "SAMPLER_XVECTOR_ONLY"})
        self.assertEqual(t["entry"]["state"], "failed")
        self.assertEqual(t["entry"]["reason"], "SAMPLER_UNKNOWN")
        self.assertTrue(es.describe_sample(t["entry"])["reason_label"])

    def test_no_auto_retry(self):
        failed = es.apply_event(self._generating(),
                                {"type": "GENERATE_FAILED", "reason": "SAMPLER_ENGINE_ERROR"})["entry"]
        self.assertEqual(failed["state"], "failed")
        again = es.apply_event(failed, {"type": "GENERATE_SUCCEEDED"})
        self.assertEqual(again["rejected"], "INVALID_EVENT")
        self.assertEqual(again["entry"]["state"], "failed")
        self.assertEqual(es.apply_event(failed, {"type": "GENERATE_REQUESTED"})["entry"]["state"], "generating")
        # 모듈에 타이머/스레드(자동 재시도 통로)가 없다
        for banned in ("import time", "threading", "sleep(", "retry"):
            self.assertNotIn(banned, PY_CODE, "자동 재시도 통로 없음: %s" % banned)

    def test_rejections_are_visible(self):
        idle = es.initial_entry("happy", KEY_A)
        generating = self._generating()
        ready = es.apply_event(generating, {"type": "GENERATE_SUCCEEDED"})["entry"]

        r1 = es.apply_event(generating, {"type": "GENERATE_REQUESTED"})
        self.assertFalse(r1["applied"])
        self.assertEqual(r1["rejected"], "ALREADY_GENERATING")
        self.assertEqual(r1["entry"], generating, "거부 시 상태 불변")

        r2 = es.apply_event(ready, {"type": "GENERATE_REQUESTED"})
        self.assertEqual(r2["rejected"], "CACHED_SAMPLE_EXISTS")

        r3 = es.apply_event(idle, {"type": "DELETED"})
        self.assertEqual(r3["rejected"], "NO_SAMPLE_TO_DELETE")

        for code in (r1["rejected"], r2["rejected"], r3["rejected"]):
            self.assertIn(code, es.EMOTION_SAMPLER_REJECTION_CODES)

    def test_invariant_applied_iff_not_rejected(self):
        other_key = es.build_cache_key(make_input(voice_content_sha256=FP_B))
        events = [
            {"type": "GENERATE_REQUESTED"},
            {"type": "GENERATE_SUCCEEDED"},
            {"type": "GENERATE_SUCCEEDED", "degraded": True},
            {"type": "GENERATE_FAILED", "reason": "SAMPLER_ENGINE_ERROR"},
            {"type": "GENERATE_LIMIT_EXCEEDED"},
            {"type": "CACHE_HIT"},
            {"type": "CACHE_HIT", "degraded": True},
            {"type": "DELETED"},
            {"type": "KEY_CHANGED", "cache_key": other_key},
            {"type": "NOPE"},
        ]
        for state in es.EMOTION_SAMPLE_STATES:
            reasons = es.EMOTION_SAMPLE_STATE_REASONS[state]
            entry = {"emotion_id": "happy", "state": state,
                     "reason": reasons[0] if reasons else None, "cache_key": KEY_A}
            for ev in events:
                t = es.apply_event(entry, ev)
                self.assertEqual(t["applied"], t["rejected"] is None, "%s x %s" % (state, ev["type"]))
                self.assertIn(t["entry"]["state"], es.EMOTION_SAMPLE_STATES)
                allowed = es.EMOTION_SAMPLE_STATE_REASONS[t["entry"]["state"]]
                if t["entry"]["reason"] is not None:
                    self.assertIn(t["entry"]["reason"], allowed)

    def test_key_changed_resets_to_idle(self):
        ready = es.apply_event(self._generating(), {"type": "GENERATE_SUCCEEDED"})["entry"]
        new_key = es.build_cache_key(make_input(voice_content_sha256=FP_B))
        t = es.apply_event(ready, {"type": "KEY_CHANGED", "cache_key": new_key})
        self.assertTrue(t["applied"])
        self.assertEqual(t["entry"]["state"], "idle")
        self.assertIsNone(t["entry"]["reason"])
        self.assertEqual(t["entry"]["cache_key"], new_key)
        self.assertTrue(es.can_regenerate(t["entry"]["state"]))


class CacheReuseTest(unittest.TestCase):
    def test_hit_reuses_and_never_generates(self):
        cache = {KEY_A: {"degraded": False}}
        calls = []

        def run(emotion_id, key):
            plan = es.resolve_request(emotion_id, key, cache)
            if plan["action"] == "generate":
                calls.append(emotion_id)
            return plan

        p1 = run("happy", KEY_A)
        self.assertEqual(p1["action"], "reuse")
        self.assertEqual(p1["entry"]["state"], "ready")
        run("happy", KEY_A)
        self.assertEqual(calls, [], "hit 이면 합성을 호출하지 않는다")

        other = es.build_cache_key(make_input(emotion_id="sad"))
        p3 = run("sad", other)
        self.assertEqual(p3["action"], "generate")
        self.assertEqual(p3["entry"]["state"], "idle")
        self.assertEqual(calls, ["sad"])

    def test_degraded_hit_restores_degraded(self):
        plan = es.resolve_request("happy", KEY_A, {KEY_A: {"degraded": True}})
        self.assertEqual(plan["action"], "reuse")
        self.assertEqual(plan["entry"]["state"], "degraded")
        self.assertEqual(plan["entry"]["reason"], "SAMPLER_XVECTOR_ONLY")

    def test_cached_blocks_regenerate_with_explanation(self):
        for state in ("ready", "degraded"):
            self.assertFalse(es.can_regenerate(state))
            self.assertTrue(es.has_cached_sample(state))
            notice = es.regenerate_blocked_notice(state)
            self.assertTrue(notice and len(notice) > 10, "%s: 비활성 이유 문장" % state)
            self.assertIn("다시 만들 수 없습니다", notice)
        for state in ("idle", "failed", "limitExceeded"):
            self.assertTrue(es.can_regenerate(state))
            self.assertIsNone(es.regenerate_blocked_notice(state))
        self.assertFalse(es.can_regenerate("generating"))
        self.assertTrue(es.regenerate_blocked_notice("generating"))

    def test_phrase_version_bump_misses_cache(self):
        cache = {KEY_A: {"degraded": False}}
        bumped = es.build_cache_key_at(make_input(), es.EMOTION_SAMPLER_PHRASE_VERSION + 1,
                                       es.EMOTION_SAMPLER_KEY_VERSION)
        self.assertEqual(es.resolve_request("happy", bumped, cache)["action"], "generate")


class NoFanOutTest(unittest.TestCase):
    def test_no_bulk_entry_point_in_module(self):
        names = [n for n, _ in inspect.getmembers(es, inspect.isfunction)]
        self.assertTrue(names)
        for n in names:
            self.assertNotRegex(n, r"(?i)(all|bulk|batch|every)",
                                "일괄 생성 진입점 금지: %s" % n)
        self.assertNotIn("emotion_ids", PY_SRC, "감정 목록 파라미터 없음")
        self.assertNotIn("EMOTION_TAGS", PY_SRC, "전체 감정표 미보유")
        self.assertNotIn("ALL_EMOTIONS", PY_SRC)

    def test_generate_takes_exactly_one_tag(self):
        self.assertEqual(len(inspect.signature(es.build_cache_key).parameters), 1)
        self.assertEqual(list(inspect.signature(es.resolve_request).parameters),
                         ["emotion_id", "cache_key", "cache_index"])
        self.assertEqual(list(inspect.signature(es.initial_entry).parameters), ["emotion_id", "cache_key"])
        for bogus in (["happy", "sad"], ("happy",), {"0": "happy"}, 3, None, ""):
            with self.assertRaises(es.EmotionSamplerInputError, msg="거부: %r" % (bogus,)) as cm:
                es.assert_emotion_sample_tag(bogus)
            self.assertEqual(cm.exception.code, "SAMPLER_INVALID_EMOTION_ID")
            with self.assertRaises(es.EmotionSamplerInputError):
                es.initial_entry(bogus, KEY_A)
            with self.assertRaises(es.EmotionSamplerInputError):
                es.resolve_request(bogus, KEY_A, {})
            with self.assertRaises(es.EmotionSamplerInputError):
                es.build_cache_key(make_input(emotion_id=bogus))

    def test_ts_module_has_no_bulk_entry_point(self):
        exports = re.findall(r"^export\s+(?:const|function|class|type|interface)\s+(\w+)", TS_CODE, re.MULTILINE)
        self.assertTrue(exports, "TS export 를 찾지 못함")
        for n in exports:
            self.assertNotRegex(n, r"(All|Bulk|Batch|Every|Each)(Emotion|Sample|Tag)")
        self.assertNotIn("Promise.all", TS_CODE)
        self.assertNotIn("emotionIds", TS_CODE)


PATHY = [
    "E:/AI/models/voice.wav",
    "E:\\AI\\models\\voice.wav",
    "/home/user/ref.wav",
    "C:/Users/kawae/ref",
    "../../secret",
    "~/voice",
    "file:///tmp/a",
    "reference.wav",
]
TEXTY = ["안녕하세요 반갑습니다", "오늘 날씨가 좋네요.", "hello world", "기쁨"]


class HygieneTest(unittest.TestCase):
    def test_path_like_rejected(self):
        for p in PATHY:
            self.assertTrue(es.looks_path_like(p), "경로 판정: %s" % p)
            with self.assertRaises(es.EmotionSamplerInputError) as cm:
                es.assert_sampler_safe_value("x", p)
            self.assertEqual(cm.exception.code, "SAMPLER_PATH_LIKE_VALUE")
            for field in ("engine_id", "model_id", "voice_content_sha256"):
                with self.assertRaises(es.EmotionSamplerInputError, msg="%s 에 경로 금지: %s" % (field, p)) as cm2:
                    es.build_cache_key(make_input(**{field: p}))
                self.assertEqual(cm2.exception.code, "SAMPLER_PATH_LIKE_VALUE")

    def test_text_like_rejected(self):
        for t in TEXTY:
            self.assertTrue(es.looks_text_like(t), "문장 판정: %s" % t)
            with self.assertRaises(es.EmotionSamplerInputError) as cm:
                es.assert_sampler_safe_value("x", t)
            self.assertEqual(cm.exception.code, "SAMPLER_TEXT_LIKE_VALUE")
            with self.assertRaises(es.EmotionSamplerInputError):
                es.build_cache_key(make_input(model_id=t))
        for p in es.EMOTION_SAMPLER_PHRASES:
            with self.assertRaises(es.EmotionSamplerInputError):
                es.assert_sampler_safe_value("phrase", p)

    def test_state_dict_has_no_path_or_transcript(self):
        for state in es.EMOTION_SAMPLE_STATES:
            reasons = es.EMOTION_SAMPLE_STATE_REASONS[state]
            entry = {"emotion_id": "happy", "state": state,
                     "reason": reasons[0] if reasons else None, "cache_key": KEY_A}
            self.assertEqual(sorted(entry), ["cache_key", "emotion_id", "reason", "state"])
            es.assert_sampler_safe_value("emotion_id", entry["emotion_id"])
            es.assert_sampler_safe_value("state", entry["state"])
            es.assert_sampler_safe_value("cache_key", entry["cache_key"])
            if entry["reason"]:
                es.assert_sampler_safe_value("reason", entry["reason"])
            blob = json.dumps(entry, ensure_ascii=False)
            self.assertNotRegex(blob, r"[\\/]|\.wav|\.mp3|file:")
            for p in es.EMOTION_SAMPLER_PHRASES:
                self.assertNotIn(p, blob)

    def test_view_dict_has_no_path_or_phrase(self):
        for state in es.EMOTION_SAMPLE_STATES:
            reasons = es.EMOTION_SAMPLE_STATE_REASONS[state]
            v = es.describe_sample({"emotion_id": "happy", "state": state,
                                    "reason": reasons[0] if reasons else None, "cache_key": KEY_A})
            blob = json.dumps(v, ensure_ascii=False)
            self.assertNotRegex(blob, r"[\\/]|\.wav|\.mp3|file:")
            for p in es.EMOTION_SAMPLER_PHRASES:
                self.assertNotIn(p, blob)

    def test_payload_is_token_only(self):
        payload = es.canonical_cache_key_payload(make_input())
        self.assertNotRegex(payload, r"[\\/]")
        self.assertNotRegex(payload, r"[가-힣]")
        self.assertRegex(es.build_cache_key(make_input()), r"^[0-9a-f]{64}$")

    def test_error_message_hides_offending_value(self):
        secret = "E:/AI/secret_voice.wav"
        with self.assertRaises(es.EmotionSamplerInputError) as cm:
            es.build_cache_key(make_input(model_id=secret))
        msg = str(cm.exception)
        self.assertNotIn(secret, msg, "오류 메시지에 위반 값 미포함")
        self.assertIn("SAMPLER_PATH_LIKE_VALUE", msg)
        self.assertIn("model_id", msg)
        self.assertIn(cm.exception.code, es.EMOTION_SAMPLER_INPUT_ERROR_CODES)


    def test_cache_key_format_validation(self):
        self.assertEqual(es.assert_cache_key(KEY_A), KEY_A)
        for bad in ("", "zz", KEY_A.upper(), KEY_A + "a", "E:/x", 123, None):
            with self.assertRaises(es.EmotionSamplerInputError) as cm:
                es.assert_cache_key(bad)
            self.assertEqual(cm.exception.code, "SAMPLER_INVALID_CACHE_KEY")

    def test_sha256_known_vectors(self):
        self.assertEqual(es.sampler_sha256_hex("abc"),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(es.sampler_sha256_hex(""),
                         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")


class VoiceAuthorityTest(unittest.TestCase):
    """목소리 입력 권위 = 참조 라이브러리의 콘텐츠 SHA-256(주입). 경로/크기/mtime 은 입력이 아니다."""

    SHA_ONE = "1" * 64
    SHA_TWO = "2" * 64

    def test_moved_file_same_content_reuses_cache(self):
        # 같은 내용, 다른 경로 — 참조 라이브러리는 같은 content sha 를 내준다.
        k1 = es.build_cache_key(make_input(voice_content_sha256=self.SHA_ONE))
        k2 = es.build_cache_key(make_input(voice_content_sha256=self.SHA_ONE))
        self.assertEqual(k1, k2, "경로 이동은 키를 바꾸지 않는다")
        self.assertEqual(es.resolve_request("happy", k2, {k1: {"degraded": False}})["action"], "reuse")

    def test_content_change_invalidates_even_with_same_name_and_size(self):
        k1 = es.build_cache_key(make_input(voice_content_sha256=self.SHA_ONE))
        k2 = es.build_cache_key(make_input(voice_content_sha256=self.SHA_TWO))
        self.assertNotEqual(k1, k2, "내용 변경은 이름/크기가 같아도 키를 바꾼다")
        self.assertEqual(es.resolve_request("happy", k2, {k1: {"degraded": False}})["action"], "generate")

    def test_path_based_fingerprint_cannot_be_key_input(self):
        raw = "E:/AI/voice.wav|480000|1700000000000"
        with self.assertRaises(es.EmotionSamplerInputError) as cm:
            es.build_cache_key(make_input(voice_content_sha256=raw))
        self.assertEqual(cm.exception.code, "SAMPLER_PATH_LIKE_VALUE")
        # 대문자 hex 는 무효(소문자 강제). SHA_ONE 은 숫자뿐이라 upper() 가 무의미하므로 별도 값을 쓴다.
        for bad in ("abc123", ("ab" * 32).upper(), self.SHA_ONE + "a", ""):
            with self.assertRaises(es.EmotionSamplerInputError):
                es.build_cache_key(make_input(voice_content_sha256=bad))

    def test_module_does_not_mint_its_own_fingerprint(self):
        self.assertFalse(hasattr(es, "voice_content_sha256_from_raw"), "자체 지문 생성 헬퍼 없음")
        self.assertFalse(hasattr(es, "voice_fingerprint_from_raw"))
        for banned in ("mtimeMs", "size_bytes", "fingerprint_reference"):
            self.assertNotIn(banned, PY_CODE, "경로/크기/mtime 기반 입력 없음: %s" % banned)
        payload = json.loads(es.canonical_cache_key_payload(make_input()))
        self.assertIn("voice_content_sha256", payload)
        self.assertNotIn("voice_fingerprint", payload)


class SummaryTest(unittest.TestCase):
    """접힘 상태 요약(progressive disclosure)."""

    def _mk(self, state):
        reasons = es.EMOTION_SAMPLE_STATE_REASONS[state]
        return {"emotion_id": "happy", "state": state,
                "reason": reasons[0] if reasons else None, "cache_key": KEY_A}

    def test_each_state_in_exactly_one_bucket(self):
        all_states = [self._mk(s) for s in es.EMOTION_SAMPLE_STATES]
        s = es.summarize_samples(all_states)
        self.assertEqual(s["generated"], 1)
        self.assertEqual(s["generating"], 1)
        self.assertEqual(s["attention"], 3)
        self.assertEqual(s["generated"] + s["generating"] + s["attention"],
                         len(es.EMOTION_SAMPLE_STATES) - 1, "idle 만 미집계")
        self.assertEqual(s["text"], "만들어짐 1 · 만드는 중 1 · 확인 필요 3")

    def test_zero_buckets_omitted_and_empty_message(self):
        self.assertEqual(es.summarize_samples([])["text"], es.EMOTION_SAMPLE_SUMMARY_EMPTY)
        self.assertEqual(es.summarize_samples([self._mk("idle")])["text"], es.EMOTION_SAMPLE_SUMMARY_EMPTY)
        self.assertEqual(es.summarize_samples([self._mk("ready")])["text"], "만들어짐 1")
        self.assertEqual(es.summarize_samples([self._mk("failed")])["text"], "확인 필요 1")
        many = [self._mk("ready") for _ in range(50)]
        self.assertLessEqual(len(es.summarize_samples(many)["text"]), 40, "요약 한 줄 길이 상한")

    def test_summary_exposes_no_reason_text_or_phrase(self):
        text = es.summarize_samples([self._mk(s) for s in es.EMOTION_SAMPLE_STATES])["text"]
        for r in es.EMOTION_SAMPLE_REASON_CODES:
            self.assertNotIn(es.EMOTION_SAMPLE_REASON_LABEL[r], text)
        for p in es.EMOTION_SAMPLER_PHRASES:
            self.assertNotIn(p, text)


class SampleScriptTest(unittest.TestCase):
    """표현 언어 교체 지점 — 지금은 태그 문자열 결합."""

    def test_script_is_tag_plus_phrase(self):
        self.assertEqual(es.build_sample_script("[기쁨]"), "[기쁨] " + es.phrase_script())
        self.assertEqual(es.build_sample_script(""), es.phrase_script())
        self.assertEqual(es.build_sample_script("  [슬픔]  "), "[슬픔] " + es.phrase_script())
        self.assertIn("EXPRESSION LANGUAGE SWAP POINT", PY_SRC, "교체 지점 표시")

    def test_phrase_set_and_version_unchanged_by_this_correction(self):
        self.assertEqual(es.EMOTION_SAMPLER_PHRASE_VERSION, 1)
        self.assertEqual(list(es.EMOTION_SAMPLER_PHRASES), ["안녕하세요.", "잠시 후에 다시 말씀드리겠습니다."])
        # 표현 이벤트(구두점/웃음)는 아직 없다 — 별도 문구/이벤트 버전으로 나중에 온다.
        for banned in ("!?", "ㅅㅅ", "laugh", "웃음"):
            self.assertNotIn(banned, es.phrase_script())

    def test_script_never_enters_state_or_key(self):
        script = es.build_sample_script("[기쁨]")
        self.assertNotIn(script, es.canonical_cache_key_payload(make_input()))
        entry = es.initial_entry("happy", KEY_A)
        self.assertNotIn(script, json.dumps(entry, ensure_ascii=False))
        self.assertNotIn(script, json.dumps(es.describe_sample(entry), ensure_ascii=False))


class ParityWithTsTest(unittest.TestCase):
    """src/shared/emotionSampler.ts 소스를 파싱해 TS==Python 을 강제한다."""

    def test_versions(self):
        self.assertEqual(ts_int("EMOTION_SAMPLER_KEY_VERSION"), es.EMOTION_SAMPLER_KEY_VERSION)
        self.assertEqual(ts_int("EMOTION_SAMPLER_PHRASE_VERSION"), es.EMOTION_SAMPLER_PHRASE_VERSION)

    def test_phrase_set(self):
        self.assertEqual(ts_array("EMOTION_SAMPLER_PHRASES"), list(es.EMOTION_SAMPLER_PHRASES))
        self.assertEqual(ts_str("EMOTION_SAMPLER_PHRASE_SET_SHA256"), es.EMOTION_SAMPLER_PHRASE_SET_SHA256)

    def test_canonical_serialization_is_byte_identical(self):
        ts_payload = ts_str("EMOTION_SAMPLER_PARITY_PAYLOAD")
        ts_key = ts_str("EMOTION_SAMPLER_PARITY_KEY")
        self.assertEqual(ts_payload, es.EMOTION_SAMPLER_PARITY_PAYLOAD, "고정 벡터 payload 가 바이트 동일")
        self.assertEqual(ts_key, es.EMOTION_SAMPLER_PARITY_KEY)
        # Python 구현이 TS 가 고정한 그 payload/key 를 실제로 재현한다.
        self.assertEqual(es.canonical_cache_key_payload(es.EMOTION_SAMPLER_PARITY_INPUT), ts_payload)
        self.assertEqual(es.sampler_sha256_hex(ts_payload), ts_key)

    def test_state_and_reason_codes(self):
        self.assertEqual(ts_array("EMOTION_SAMPLE_STATES"), list(es.EMOTION_SAMPLE_STATES))
        self.assertEqual(ts_array("EMOTION_SAMPLE_REASON_CODES"), list(es.EMOTION_SAMPLE_REASON_CODES))
        self.assertEqual(ts_array("EMOTION_SAMPLER_REJECTION_CODES"), list(es.EMOTION_SAMPLER_REJECTION_CODES))
        self.assertEqual(ts_array("EMOTION_SAMPLER_INPUT_ERROR_CODES"),
                         list(es.EMOTION_SAMPLER_INPUT_ERROR_CODES))

    def test_labels(self):
        st = ts_record("EMOTION_SAMPLE_STATE_LABEL")
        self.assertEqual(len(st), len(es.EMOTION_SAMPLE_STATES))
        for s in es.EMOTION_SAMPLE_STATES:
            self.assertEqual(st[s], es.EMOTION_SAMPLE_STATE_LABEL[s], "상태 라벨 %s" % s)
        rs = ts_record("EMOTION_SAMPLE_REASON_LABEL")
        self.assertEqual(len(rs), len(es.EMOTION_SAMPLE_REASON_CODES))
        for r in es.EMOTION_SAMPLE_REASON_CODES:
            self.assertEqual(rs[r], es.EMOTION_SAMPLE_REASON_LABEL[r], "사유 라벨 %s" % r)

    def test_disclaimer_and_title(self):
        self.assertEqual(ts_str("EMOTION_SAMPLER_DISCLAIMER"), es.EMOTION_SAMPLER_DISCLAIMER)
        self.assertEqual(ts_str("EMOTION_SAMPLER_SECTION_TITLE"), es.EMOTION_SAMPLER_SECTION_TITLE)
        self.assertEqual(ts_str("EMOTION_SAMPLE_SUMMARY_EMPTY"), es.EMOTION_SAMPLE_SUMMARY_EMPTY)
        self.assertEqual(ts_array("EMOTION_SAMPLE_SUMMARY_BUCKETS"), list(es.EMOTION_SAMPLE_SUMMARY_BUCKETS))
        sm = ts_record("EMOTION_SAMPLE_SUMMARY_LABEL")
        for b in es.EMOTION_SAMPLE_SUMMARY_BUCKETS:
            self.assertEqual(sm[b], es.EMOTION_SAMPLE_SUMMARY_LABEL[b], "요약 라벨 %s" % b)
        # 샘플러가 '감정 참조 등록'이 아님을 문구가 못 박는다.
        self.assertIn("미리듣기", es.EMOTION_SAMPLER_DISCLAIMER)
        self.assertIn("등록되지 않", es.EMOTION_SAMPLER_DISCLAIMER)
        self.assertEqual(es.EMOTION_SAMPLER_SECTION_TITLE, "감정·표현 미리듣기")
        self.assertNotIn("참조", es.EMOTION_SAMPLER_SECTION_TITLE)
        self.assertNotIn("등록", es.EMOTION_SAMPLER_SECTION_TITLE)

    def test_config_field_names_match(self):
        """canonical config 필드명이 양쪽 소스에 동일하게 등장한다(직렬화 드리프트 방지)."""
        for field in ("pitch_centi", "speed_milli", "tail_fade_ms", "tail_mode", "tail_padding_ms"):
            self.assertIn(field, TS_CODE, "TS 에 %s 없음" % field)
            self.assertIn(field, PY_SRC, "Python 에 %s 없음" % field)
        for field in ("emotion_id", "engine_id", "key_version", "model_id", "phrase_version", "voice_content_sha256"):
            self.assertIn('"%s"' % field, TS_CODE + PY_SRC)


if __name__ == "__main__":
    unittest.main()
