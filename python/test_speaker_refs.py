# -*- coding: utf-8 -*-
"""화자별 참조 선택 표 — 우선순위와 fail-closed.

GPU·모델·오디오를 부르지 않는다. 파일 존재 판정만 주입한다(디스크도 쓰지 않는다).
"""
import json
import unittest

import speaker_refs as sr

LF = chr(10)

A = "C:/refs/minsu.wav"
B = "C:/refs/younghee.wav"
C = "C:/refs/minsu_happy.wav"
D = "C:/refs/global.wav"
E = "C:/refs/emotion_happy.wav"
MISSING = "C:/refs/gone.wav"

PRESENT = {A, B, C, D, E}


def table(**kw):
    kw.setdefault("default_ref", D)
    kw.setdefault("exists", lambda p: p in PRESENT)
    return sr.ReferenceTable(**kw)


class LegacyScriptTest(unittest.TestCase):
    """화자 표기가 없는 대본은 v1.3.0 과 같은 경로를 탄다."""

    def test_emotion_reference_then_global_default(self):
        t = table(emotion_refs={"happy": E})
        self.assertEqual(t.resolve(None, "happy")["path"], E)
        self.assertEqual(t.resolve(None, "happy")["source"], sr.SOURCE_EMOTION)
        self.assertEqual(t.resolve(None, "sad")["path"], D)
        self.assertEqual(t.resolve(None, "sad")["source"], sr.SOURCE_DEFAULT)
        self.assertEqual(t.resolve(None, None)["path"], D)

    def test_missing_emotion_file_falls_back_to_default_not_error(self):
        """등록은 됐지만 파일이 사라진 감정 참조 — 기존 동작(기본 참조)을 유지한다."""
        t = table(emotion_refs={"happy": MISSING})
        row = t.resolve(None, "happy")
        self.assertEqual(row["path"], D)
        self.assertEqual(row["source"], sr.SOURCE_DEFAULT)

    def test_no_default_reference_is_a_clear_error(self):
        t = table(default_ref="")
        with self.assertRaises(sr.SpeakerReferenceError) as cm:
            t.resolve(None, "happy")
        self.assertEqual(cm.exception.code, sr.DEFAULT_REFERENCE_MISSING)

    def test_speaker_reference_never_leaks_into_legacy_script(self):
        """화자 참조를 등록해 뒀어도 화자 표기가 없는 발화에는 쓰이지 않는다."""
        t = table(speaker_refs={"민수": A})
        self.assertEqual(t.resolve(None, "default")["path"], D)


class PriorityTest(unittest.TestCase):
    """1) (화자,감정) → 2) 화자 기본 → 3) (화자 없을 때만) 감정 → 4) 전역 기본."""

    def test_speaker_emotion_wins(self):
        t = table(speaker_refs={"민수": A},
                  speaker_emotion_refs={sr.emotion_key("민수", "happy"): C},
                  emotion_refs={"happy": E})
        row = t.resolve("민수", "happy")
        self.assertEqual(row["path"], C)
        self.assertEqual(row["source"], sr.SOURCE_SPEAKER_EMOTION)

    def test_speaker_default_next(self):
        t = table(speaker_refs={"민수": A}, emotion_refs={"happy": E})
        row = t.resolve("민수", "happy")
        self.assertEqual(row["path"], A, "감정 참조로 내려가지 않는다")
        self.assertEqual(row["source"], sr.SOURCE_SPEAKER)

    def test_emotion_reference_is_not_used_for_a_named_speaker(self):
        """지정한 인물의 말을 감정 참조(다른 사람일 수 있다)로 만들지 않는다."""
        t = table(speaker_refs={"민수": A}, emotion_refs={"happy": E},
                  registered_speakers={"민수", "영희"})
        with self.assertRaises(sr.SpeakerReferenceError) as cm:
            t.resolve("영희", "happy")
        self.assertEqual(cm.exception.code, sr.SPEAKER_REFERENCE_NOT_READY)

    def test_pair_reference_of_another_emotion_does_not_apply(self):
        t = table(speaker_refs={"민수": A},
                  speaker_emotion_refs={sr.emotion_key("민수", "happy"): C})
        self.assertEqual(t.resolve("민수", "sad")["path"], A)

    def test_pair_reference_of_another_speaker_does_not_apply(self):
        t = table(speaker_refs={"민수": A, "영희": B},
                  speaker_emotion_refs={sr.emotion_key("영희", "happy"): C})
        self.assertEqual(t.resolve("민수", "happy")["path"], A)


class FailClosedTest(unittest.TestCase):
    def test_unregistered_speaker_is_blocked(self):
        t = table(speaker_refs={"민수": A})
        with self.assertRaises(sr.SpeakerReferenceError) as cm:
            t.resolve("영희", "default")
        self.assertEqual(cm.exception.code, sr.SPEAKER_NOT_REGISTERED)

    def test_registered_but_file_gone_is_blocked_not_substituted(self):
        t = table(speaker_refs={"민수": MISSING})
        with self.assertRaises(sr.SpeakerReferenceError) as cm:
            t.resolve("민수", "default")
        self.assertEqual(cm.exception.code, sr.SPEAKER_REFERENCE_NOT_READY)

    def test_one_speaker_failure_does_not_borrow_another(self):
        t = table(speaker_refs={"민수": A, "영희": MISSING})
        self.assertEqual(t.resolve("민수", "default")["path"], A)
        with self.assertRaises(sr.SpeakerReferenceError):
            t.resolve("영희", "default")

    def test_preflight_stops_before_generation(self):
        t = table(speaker_refs={"민수": A})
        self.assertTrue(t.preflight([("민수", "default"), ("민수", "happy")]))
        with self.assertRaises(sr.SpeakerReferenceError) as cm:
            t.preflight([("민수", "default"), ("영희", "default")])
        self.assertEqual(cm.exception.code, sr.SPEAKER_NOT_REGISTERED)

    def test_error_payload_carries_no_name_or_path(self):
        t = table(speaker_refs={})
        try:
            t.resolve("민수", "happy")
            self.fail("차단돼야 한다")
        except sr.SpeakerReferenceError as e:
            blob = json.dumps(e.error_payload, ensure_ascii=False)
            self.assertNotIn("민수", blob, "표시 이름이 오류 payload 로 새면 안 된다")
            self.assertNotIn("refs", blob, "경로가 새면 안 된다")
            self.assertTrue(e.error_payload["speaker_ref"].startswith("spk_"))


class OpaqueIdTest(unittest.TestCase):
    def test_speaker_ref_is_opaque_and_stable(self):
        one = sr.opaque_speaker_ref("민수")
        self.assertTrue(one.startswith("spk_"))
        self.assertEqual(one, sr.opaque_speaker_ref("민수"))
        self.assertNotEqual(one, sr.opaque_speaker_ref("영희"))
        self.assertNotIn("민수", one)
        self.assertIsNone(sr.opaque_speaker_ref(None))

    def test_reference_id_comes_from_content_so_duplicates_are_visible(self):
        # 내용이 같으면(같은 파일) 같은 id — 중복 사용이 기록에서도 드러난다.
        t = table(speaker_refs={"민수": A, "영희": A},
                  sha256_of=lambda p: "f" * 64 if p == A else "e" * 64)
        a = t.resolve("민수", "default")
        b = t.resolve("영희", "default")
        self.assertEqual(a["reference_id"], b["reference_id"])
        self.assertTrue(a["reference_id"].startswith("ref_"))
        self.assertNotIn("refs", a["reference_id"])
        self.assertEqual(a["reference_sha256"], "f" * 64)

    def test_unreadable_content_degrades_to_path_hash_not_a_lie(self):
        t = table(speaker_refs={"민수": A}, sha256_of=lambda p: (_ for _ in ()).throw(OSError()))
        row = t.resolve("민수", "default")
        self.assertTrue(row["reference_id"].startswith("refp_"), "두 경우를 접두어로 구분한다")
        self.assertIsNone(row["reference_sha256"], "모르는 값을 0 으로 위조하지 않는다")
        self.assertNotIn("minsu", row["reference_id"])

    def test_duplicate_paths_are_reported_not_blocked(self):
        t = table(speaker_refs={"민수": A, "영희": A, "철수": B})
        self.assertEqual(t.duplicate_paths(), {A: ["민수", "영희"]})
        # 막지 않는다 — 둘 다 정상적으로 해석된다.
        self.assertEqual(t.resolve("민수", "default")["path"], A)
        self.assertEqual(t.resolve("영희", "default")["path"], A)


if __name__ == "__main__":
    unittest.main()
