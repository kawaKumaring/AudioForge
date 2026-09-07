# -*- coding: utf-8 -*-
"""화자 참조 판정 fixture 가 굳어 있는지 — 화면 거울과 같은 case 를 반대 방향으로 본다.

`src/shared/speakerReference.parity.json` 은 이 모듈로 구운 값이다. 구현이 바뀌면 여기서
먼저 걸리고, TS 거울이 갈라지면 `speakerReference.test.ts` 에서 걸린다. 둘 중 하나만 고치면
어느 한쪽이 깨진다 — 그게 목적이다.
"""
import json
import os
import unittest

import speaker_refs as sr

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO_ROOT, "src", "shared", "speakerReference.parity.json")


class ParityFixtureTest(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE, encoding="utf-8") as f:
            self.doc = json.load(f)
        self.cases = self.doc["cases"]

    def test_authority_is_named(self):
        self.assertEqual(self.doc["_meta"]["authority"], "python/speaker_refs.py")

    def test_fixture_is_not_trivially_small(self):
        self.assertGreaterEqual(len(self.cases), 40)

    def test_every_case_is_reproduced(self):
        """fixture 의 readiness 로 표를 다시 세워 같은 답이 나오는지.

        경로는 fixture 에 없다(화면이 알 필요가 없어서다). 그래서 readiness 의 true 를
        '존재하는 가짜 경로' 로 되돌려 표를 만든다 — 판정 규칙만 검사한다.
        """
        bad = []
        for c in self.cases:
            r = c["readiness"]
            spk = {k: "/x/%s.wav" % k for k, v in r["speakerReady"].items() if v}
            pair = {k: "/x/pair.wav" for k, v in r["speakerEmotionReady"].items() if v}
            emo = {k: "/x/%s.wav" % k for k, v in r["emotionReady"].items() if v}
            default_ref = "/x/default.wav" if r["defaultReady"] else ""
            table = sr.ReferenceTable(
                default_ref=default_ref, emotion_refs=emo, speaker_refs=spk,
                speaker_emotion_refs=pair,
                registered_speakers=set(r["registeredSpeakers"]),
                exists=lambda p: True, sha256_of=lambda p: "0" * 64)
            try:
                got = {"ok": True, "source": table.resolve(c["speakerId"], c["emotionId"])["source"]}
            except sr.SpeakerReferenceError as e:
                got = {"ok": False, "code": e.code}
            if got != c["expected"]:
                bad.append("%s speaker=%s emotion=%s got=%s want=%s"
                           % (c["setup"], c["speakerId"], c["emotionId"], got, c["expected"]))
        self.assertEqual(bad, [], chr(10).join(bad))

    def test_fixture_covers_all_rules_and_failures(self):
        sources = set()
        codes = set()
        for c in self.cases:
            if c["expected"]["ok"]:
                sources.add(c["expected"]["source"])
            else:
                codes.add(c["expected"]["code"])
        self.assertEqual(sources, set(sr.REFERENCE_SOURCES))
        self.assertEqual(codes, {sr.SPEAKER_NOT_REGISTERED,
                                 sr.SPEAKER_REFERENCE_NOT_READY,
                                 sr.DEFAULT_REFERENCE_MISSING})

    def test_fixture_has_no_paths(self):
        blob = json.dumps(self.doc, ensure_ascii=False)
        for leak in (".wav", ":/", "\\\\"):
            self.assertNotIn(leak, blob, "판정 fixture 에 경로가 들어가면 안 된다")


if __name__ == "__main__":
    unittest.main()
