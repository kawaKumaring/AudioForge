# -*- coding: utf-8 -*-
"""설치된 음성 모델 판 찾기·고르기 계약.

사용자 요구는 "여러 판을 받아 두고 골라 시험해 보고 싶다. 없으면 있는 것만 뜨게" 였다.
그래서 이 계약은 두 가지를 고정한다.

  1. **없는 것을 만들어 내지 않는다.** 필수 파일이 없는 폴더, venv, HF 캐시 루트는 목록에 없다.
  2. **조용히 다른 모델로 내려가지 않는다.** 알 수 없는 id·목소리 복제 미지원 판은 오류다.
     고른 것과 다른 모델로 만들어지면 결과만 보고는 무엇으로 만든지 알 수 없기 때문이다.

모델 가중치를 로드하지 않는다(파일 존재·config.json 만 본다) — GPU·다운로드 없이 돈다.
실행: python python/test_qwen_model_variants.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tts_worker as w  # noqa: E402


def _fake_model_dir(root, size, mtype):
    """필수 파일을 갖춘 가짜 스냅샷 폴더. 내용은 보지 않으므로 크기만 0 이 아니면 된다."""
    os.makedirs(os.path.join(root, "speech_tokenizer"), exist_ok=True)
    for rel in w._QWEN_REQUIRED:
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("x")
    with open(os.path.join(root, "config.json"), "w", encoding="utf-8") as fh:
        json.dump({"model_type": "qwen3_tts", "tts_model_size": size, "tts_model_type": mtype}, fh)
    return root


class QwenVariantDiscoveryTest(unittest.TestCase):
    def setUp(self):
        w.set_qwen_model("")          # 앞 시험의 선택이 남지 않게

    def tearDown(self):
        w.set_qwen_model("")

    def test_필수파일이_없으면_목록에_없다(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(w._qwen_variant_info(td))          # 빈 폴더
            _fake_model_dir(td, "1b7", "base")
            self.assertEqual(w._qwen_variant_info(td),
                             {"model_size": "1b7", "model_type": "base"})
            os.remove(os.path.join(td, "model.safetensors"))     # 하나만 빼도 탈락
            self.assertIsNone(w._qwen_variant_info(td))

    def test_config를_못_읽으면_모른다고_둔다(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            _fake_model_dir(td, "1b7", "base")
            with open(os.path.join(td, "config.json"), "w", encoding="utf-8") as fh:
                fh.write("{ 깨진 json")
            info = w._qwen_variant_info(td)
            self.assertIsNotNone(info)                            # 파일은 다 있다
            self.assertIsNone(info["model_size"])                 # 값은 지어내지 않는다
            self.assertIsNone(info["model_type"])

    def test_venv와_캐시루트는_후보에서_빠진다(self):
        names = [name for kind, name, _rev, _p in w._qwen_variant_roots() if kind == "ext"]
        for excluded in w._QWEN_VARIANT_EXCLUDE:
            self.assertNotIn(excluded, names)

    def test_목록은_기본판을_하나만_표시한다(self):
        variants = w.qwen_model_variants()
        self.assertEqual(len([v for v in variants if v["is_default"]]), 1,
                         "기본 판 표시가 정확히 하나여야 어느 것이 기본인지 알 수 있다")
        for v in variants:
            self.assertTrue(v["id"] and v["label"])
            self.assertIsInstance(v["voice_clone"], bool)
            if not v["voice_clone"]:
                self.assertTrue(v["unusable_reason"], "쓸 수 없으면 사유가 있어야 한다")

    def test_id는_중복되지_않는다(self):
        ids = [v["id"] for v in w.qwen_model_variants()]
        self.assertEqual(len(ids), len(set(ids)))


class QwenVariantSelectionTest(unittest.TestCase):
    def setUp(self):
        w.set_qwen_model("")

    def tearDown(self):
        w.set_qwen_model("")

    def test_빈값은_기본판이다(self):
        w.set_qwen_model("")
        self.assertEqual(os.path.abspath(w._qwen_active_snapshot()), os.path.abspath(w._QWEN_SNAPSHOT))
        self.assertEqual(w._qwen_active_name(), w._QWEN_REPO)

    def test_알수없는_id는_오류다(self):
        with self.assertRaises(RuntimeError):
            w.set_qwen_model("없는-판")
        # 거부됐으면 활성 모델은 그대로 기본이어야 한다(절반만 바뀐 상태 금지).
        self.assertEqual(os.path.abspath(w._qwen_active_snapshot()), os.path.abspath(w._QWEN_SNAPSHOT))

    def test_고른_판이_활성_모델과_이름에_반영된다(self):
        pick = next((v for v in w.qwen_model_variants()
                     if v["voice_clone"] and not v["is_default"]), None)
        if pick is None:
            self.skipTest("이 기계에 기본 외의 목소리 복제 판이 없다")
        w.set_qwen_model(pick["id"])
        self.assertNotEqual(os.path.abspath(w._qwen_active_snapshot()),
                            os.path.abspath(w._QWEN_SNAPSHOT))
        self.assertEqual(w._qwen_active_name(), pick["id"], "어느 판으로 만들었는지 기록에 남아야 한다")

    def test_목소리_복제_미지원_판은_거부한다(self):
        # 이 통로는 참조 음성으로 목소리를 흉내 내므로 복제를 못 하는 판을 받으면 안 된다.
        self.assertEqual(w._QWEN_CLONE_TYPES, ("base",))
        for mtype in ("custom_voice", "voice_design"):
            self.assertNotIn(mtype, w._QWEN_CLONE_TYPES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
