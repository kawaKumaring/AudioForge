# -*- coding: utf-8 -*-
"""모의 패키지 환경 — source tree 없이 주입된 resourcesPath 에서만 fixture 를 읽는지 검증.

electron-builder 산출물이 아직 없으므로(package.json build 비어 있음, yml 없음) 실제 패키지는
검증 대상 부재다. 대신 `<temp>/python/fixtures/emotion-scripts.v2.json` 구조를 임시로 만들고
AUDIOFORGE_RESOURCES_PATH 를 주입해 같은 경로 규칙을 실행한다.
자체 생성한 temp 만 정리하며, 저장소 파일은 건드리지 않는다.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import emotion_scripts as es

REAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", es.FIXTURE_FILENAME)


class TestPackagedEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="af-emoscripts-")
        self.fixdir = os.path.join(self.tmp, "python", "fixtures")
        os.makedirs(self.fixdir)
        self._env = os.environ.get(es.RESOURCES_ENV)
        es.reset_cache()

    def tearDown(self):
        if self._env is None:
            os.environ.pop(es.RESOURCES_ENV, None)
        else:
            os.environ[es.RESOURCES_ENV] = self._env
        es.reset_cache()
        shutil.rmtree(self.tmp, ignore_errors=True)   # 자체 생성 temp 만 정리

    def _inject(self):
        os.environ[es.RESOURCES_ENV] = self.tmp
        es.reset_cache()

    def test_loads_from_injected_resources_path(self):
        shutil.copyfile(REAL, os.path.join(self.fixdir, es.FIXTURE_FILENAME))
        self._inject()
        self.assertTrue(es.fixture_path().startswith(self.tmp), "주입 경로를 쓰지 않았다")
        doc = es.load()
        self.assertEqual(len(doc["emotions"]), 50)
        # parsed-content 지문이 개발 트리와 동일해야 한다(판정 권위).
        with open(REAL, encoding="utf-8") as f:
            dev = json.load(f)
        self.assertEqual(es.compute_fingerprint(doc), es.compute_fingerprint(dev))
        self.assertEqual(doc["fixture_fingerprint"], dev["fixture_fingerprint"])

    def test_missing_file_is_explicit_not_found(self):
        self._inject()                       # 파일을 복사하지 않는다
        with self.assertRaises(es.EmotionScriptsError) as cm:
            es.load()
        self.assertIn("FIXTURE_NOT_FOUND", str(cm.exception))

    def test_fingerprint_mismatch_is_explicit(self):
        with open(REAL, encoding="utf-8") as f:
            doc = json.load(f)
        doc["fixture_fingerprint"] = "0" * 64
        with open(os.path.join(self.fixdir, es.FIXTURE_FILENAME), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        self._inject()
        with self.assertRaises(es.EmotionScriptsError) as cm:
            es.load()
        self.assertIn("FIXTURE_FINGERPRINT_MISMATCH", str(cm.exception))

    def test_v1_only_does_not_fall_back(self):
        # 구버전 파일명만 있는 환경 — 조용히 주워 쓰면 안 된다.
        shutil.copyfile(REAL, os.path.join(self.fixdir, "emotion-scripts.v1.json"))
        self._inject()
        with self.assertRaises(es.EmotionScriptsError) as cm:
            es.load()
        self.assertIn("FIXTURE_NOT_FOUND", str(cm.exception))

    def test_no_absolute_dev_path_in_error(self):
        self._inject()
        try:
            es.load()
            self.fail("실패해야 한다")
        except es.EmotionScriptsError as e:
            msg = str(e)
            self.assertNotIn(os.path.dirname(REAL), msg)
            self.assertNotIn(":\\", msg)      # 윈도우 절대 경로 흔적
            self.assertNotIn("/", msg)

    def test_dev_path_used_when_not_injected(self):
        os.environ.pop(es.RESOURCES_ENV, None)
        es.reset_cache()
        self.assertEqual(os.path.normcase(es.fixture_path()), os.path.normcase(REAL))
        self.assertEqual(len(es.load()["emotions"]), 50)


if __name__ == "__main__":
    unittest.main(verbosity=2)
