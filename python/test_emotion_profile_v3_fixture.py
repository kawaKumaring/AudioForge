# -*- coding: utf-8 -*-
"""v3 프로필 fixture 가 굳어 있는지 — 추적 자산 하나에서 그대로 재현되는가.

`python/fixtures/emotion-profile.v3.json` 은 저장소가 가진 승인 fixture
`test/fixtures/audio/ko-speech-7s.wav` 에서 나온 값이다. 구현이 바뀌면 여기서 먼저 걸린다.

v2 fixture 는 건드리지 않는다 — 둘은 서로 다른 종류의 기록이고, 자동 승격하지 않는다.
GPU·모델 없음. 오디오 한 개를 읽는 것이 전부다.
"""
import hashlib
import io
import json
import os
import unittest

import emotion_acoustic as ea

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "python", "fixtures", "emotion-profile.v3.json")
V2_FIXTURE = os.path.join(REPO_ROOT, "python", "fixtures", "emotion-scripts.v2.json")
SRC_REL = ("test", "fixtures", "audio", "ko-speech-7s.wav")
SRC = os.path.join(REPO_ROOT, *SRC_REL)


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


class FixtureTest(unittest.TestCase):
    def setUp(self):
        with io.open(FIXTURE, encoding="utf-8") as f:
            self.doc = json.load(f)
        self.profile = self.doc["profile"]

    def test_source_asset_is_unchanged(self):
        """fixture 가 가리키는 자산이 그대로여야 값 비교에 뜻이 있다."""
        self.assertTrue(os.path.isfile(SRC))
        self.assertEqual(_sha(SRC), self.profile["provenance"]["source_sha256"])

    def test_profile_is_reproduced_from_the_asset(self):
        import soundfile as sf
        data, sr = sf.read(SRC, dtype="float64", always_2d=True)
        got = ea.analyze_profile_v3(data[:, 0], sr, source_id="ko-speech-7s",
                                    source_sha256=_sha(SRC))
        self.assertEqual(got["profile_id"], self.profile["profile_id"],
                         "구현이 바뀌어 프로필이 달라졌다(의도한 변경이면 fixture 를 다시 굽는다)")
        self.assertEqual(json.dumps(got, sort_keys=True, ensure_ascii=False),
                         json.dumps(self.profile, sort_keys=True, ensure_ascii=False))

    def test_schema_and_axes_are_declared(self):
        self.assertEqual(self.doc["_meta"]["schema"], ea.EMOTION_PROFILE_V3_SCHEMA)
        self.assertEqual(self.profile["profile_version"], ea.EMOTION_PROFILE_V3_VERSION)
        self.assertEqual(set(self.profile["axes"]), set(ea.PROFILE_V3_AXES))
        for axis, state in self.profile["axes"].items():
            self.assertIn(state, ea.AXIS_MEASUREMENT_STATES, axis)

    def test_meta_says_v2_is_a_different_kind_of_record(self):
        """v2 를 v3 로 자동 승격하지 않는다는 사실이 파일에 적혀 있어야 한다."""
        meta = self.doc["_meta"]
        self.assertIn("시나리오 메타데이터", meta["what_v2_is"])
        self.assertIn("자동 승격", meta["what_v2_is"])
        self.assertIn("acoustic performance profile", meta["what_this_is"])

    def test_v2_fixture_is_untouched(self):
        with io.open(V2_FIXTURE, encoding="utf-8") as f:
            v2 = json.load(f)
        # v2 는 시나리오 메타데이터다 — 음향 프로필 필드가 생기면 안 된다.
        self.assertIn("emotions", v2)
        self.assertNotIn("profile", v2)
        for row in v2["emotions"][:5]:
            self.assertNotIn("semitone_anchors", row)
            self.assertNotIn("relative_f0", row)

    def test_fixture_carries_no_paths_or_script(self):
        blob = json.dumps(self.doc, ensure_ascii=False)
        for leak in (":/", ".wav", "E:", "AudioForge"):
            self.assertNotIn(leak, blob, "경로·자산 이름이 새면 안 된다: %s" % leak)

    def test_profile_stays_small(self):
        """원본 프레임을 담지 않는다 — 7.5 초 클립의 프로필이 몇 킬로바이트 안이어야 한다."""
        size = len(json.dumps(self.profile, ensure_ascii=False).encode("utf-8"))
        self.assertLess(size, 8000, "프로필이 커졌다 — 축약 좌표가 아니라 프레임을 담았을 수 있다")

    def test_not_applied_anywhere_yet(self):
        """분석 단계다. 참조 선택이나 모델 전달로 적어 두지 않는다."""
        self.assertIn("analyzed", self.doc["_meta"]["not_applied"])
        # 어휘 목록(_meta.application_states)은 "무엇이 있는가" 이고 주장이 아니다.
        # 주장을 볼 곳은 프로필 본문이다.
        blob = json.dumps(self.profile, ensure_ascii=False)
        for state in ("model_applied", "post_applied", "reference_matched"):
            self.assertNotIn(state, blob,
                             "적용하지 않은 단계를 프로필에 적어 두면 안 된다: %s" % state)
        self.assertEqual(list(self.doc["_meta"]["application_states"]),
                         list(ea.EMOTION_APPLICATION_STATES), "어휘 목록은 그대로 실어 둔다")


if __name__ == "__main__":
    unittest.main()
