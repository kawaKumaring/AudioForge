# -*- coding: utf-8 -*-
"""R3 layout parity + provision 사유 코드 계약 parity — synthetic (실모델·GPU·fs 부작용 최소).

PROVISIONER-PLAN §1: 고정 managed 레이아웃과 R3 워커 읽기 경로가 정확히 일치함을 고정한다.
정렬 방향 = 계획의 고정 레이아웃(separator_models/<engine>, qwen3/…). 워커는 provision.layout를
단일 소스로 참조하도록 정렬됐다(music_worker/tts_worker/separate). 이 테스트가 그 정렬을 못박는다.

또한 provision.reason_codes.ALL이 공유 계약(runtimeContract.ts REASON_CODES)의 부분집합임을
파싱으로 고정한다(자유 문자열 금지 — 경계로 나가는 코드는 계약 union에 존재해야 함).

실행: python python/test_provision_layout_parity.py
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import runtime_paths as rp
from provision import layout, reason_codes as rc


def _managed_roots(base="C:/af"):
    return {
        "schemaVersion": 2,
        "runtimeRoot": {"path": base + "/rt", "ownership": "audioforge-managed"},
        "modelRoot": {"path": base + "/md", "ownership": "audioforge-managed"},
        "cacheRoot": {"path": base + "/ch", "ownership": "audioforge-managed"},
    }


class SeparatorLayoutParity(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)
        rp.configure(_managed_roots())

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_separator_engine_dirs_match_fixed_layout(self):
        # 고정 레이아웃: modelRoot/separator_models/{roformer,melband}
        self.assertEqual(layout.separator_engine_dir("roformer"),
                         os.path.normpath("C:/af/md/separator_models/roformer"))
        self.assertEqual(layout.separator_engine_dir("melband"),
                         os.path.normpath("C:/af/md/separator_models/melband"))

    def test_music_worker_reads_from_fixed_layout(self):
        import music_worker
        # borrowed로 두면 makedirs 없이 경로만 해석(부작용 0).
        rp.reset()
        rp.set_path_resolver(None)
        roots = _managed_roots()
        roots["modelRoot"]["ownership"] = "external-borrowed"
        rp.configure(roots)
        self.assertEqual(music_worker._separator_model_dir("roformer"),
                         layout.separator_engine_dir("roformer"))
        self.assertEqual(music_worker._separator_model_dir("melband"),
                         layout.separator_engine_dir("melband"))
        # 모델 파일명 → engine 매핑도 레이아웃과 일치.
        self.assertEqual(music_worker._ENGINE_SUBDIR[music_worker._ROFORMER_MODEL], "roformer")
        self.assertEqual(music_worker._ENGINE_SUBDIR[music_worker._MELBAND_ENSEMBLE_MODEL], "melband")


class QwenLayoutParity(unittest.TestCase):
    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)
        rp.configure(_managed_roots())

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_qwen_home_under_qwen3(self):
        import tts_worker
        self.assertEqual(layout.QWEN_MODELS, "qwen3")
        self.assertEqual(tts_worker._qwen_hf_home(), layout.qwen_model_home())
        self.assertEqual(tts_worker._qwen_hf_home(), os.path.normpath("C:/af/md/qwen3"))
        # 스냅샷도 qwen3 밑.
        self.assertTrue(tts_worker._qwen_snapshot().startswith(os.path.normpath("C:/af/md/qwen3")))


class BorrowedLegacyLayoutParity(unittest.TestCase):
    """borrowed modelRoot(기존 사용자 externals)는 provisioner 이전 레거시 배치를 읽는다.
    managed 레이아웃과 다른 유일한 지점이며, 분기는 ownership으로만 결정한다(fs 탐색 추측 없음)."""

    def setUp(self):
        rp.reset()
        rp.set_path_resolver(None)
        roots = _managed_roots()
        roots["modelRoot"]["ownership"] = "external-borrowed"
        rp.configure(roots)

    def tearDown(self):
        rp.reset()
        rp.set_path_resolver(None)

    def test_qwen_home_uses_legacy_dir_name(self):
        import tts_worker
        self.assertEqual(layout.QWEN_MODELS_BORROWED, "qwen3_tts_hf")
        self.assertEqual(layout.qwen_model_home(), os.path.normpath("C:/af/md/qwen3_tts_hf"))
        self.assertEqual(tts_worker._qwen_hf_home(), layout.qwen_model_home())
        # 스냅샷 경로 = 레거시 externals/qwen3_tts_hf/hub/models--… 와 동형.
        self.assertEqual(
            tts_worker._qwen_snapshot(),
            os.path.normpath("C:/af/md/qwen3_tts_hf/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base"
                             "/snapshots/" + tts_worker._QWEN_REVISION))

    def test_separator_dirs_are_flat_legacy(self):
        # 레거시는 engine 서브디렉터리가 없다 — 두 엔진 모두 separator_models 평면.
        flat = os.path.normpath("C:/af/md/separator_models")
        self.assertEqual(layout.separator_engine_dir("roformer"), flat)
        self.assertEqual(layout.separator_engine_dir("melband"), flat)
        # engine 검증은 borrowed에서도 유지(알 수 없는 엔진은 거부).
        with self.assertRaises(ValueError):
            layout.separator_engine_dir("nope")

    def test_borrowed_model_root_is_read_only(self):
        # 별칭이 빌린 트리에 쓰기를 허용하지 않는다(makedirs 게이트의 근거).
        self.assertFalse(rp.can_write("modelRoot"))


class ManifestLayoutParity(unittest.TestCase):
    def test_default_manifest_install_paths_match_layout(self):
        from provision import default_manifest, manifest as mf
        idx = mf.component_index(mf.validate_manifest(default_manifest.build()))
        self.assertEqual(idx["models.qwen3"]["installPath"], layout.QWEN_MODELS)
        self.assertEqual(idx["models.separator"]["installPath"], layout.SEPARATOR_MODELS)
        self.assertEqual(idx["qwen-venv"]["installPath"], layout.RUNTIME_QWEN_VENV)
        # separator requiredFiles가 engine 서브디렉터리 prefix를 쓰는지(정렬 근거).
        paths = [f["path"] for f in idx["models.separator"]["requiredFiles"]]
        self.assertTrue(any(p.startswith("roformer/") for p in paths))
        self.assertTrue(any(p.startswith("melband/") for p in paths))


class GptSovitsDivergenceDocumented(unittest.TestCase):
    """알려진 불일치(정직 고정): GPT-SoVITS 엔진은 모델을 repo 트리 안에서 읽는다
    (runtimeRoot/GPT-SoVITS/…). 계획의 modelRoot/gptsovits 슬롯은 provisioner 배치용 예약일 뿐
    엔진 읽기 경로가 아니다 — 강제 정렬 시 엔진이 깨지므로 정렬하지 않는다."""

    def setUp(self):
        rp.reset(); rp.set_path_resolver(None); rp.configure(_managed_roots())

    def tearDown(self):
        rp.reset(); rp.set_path_resolver(None)

    def test_gptsovits_code_is_under_runtime_root(self):
        self.assertEqual(layout.gptsovits_repo_dir(), os.path.normpath("C:/af/rt/GPT-SoVITS"))
        # modelRoot/gptsovits 슬롯은 별개(예약)로 존재하되 엔진 읽기 경로가 아님.
        self.assertEqual(layout.gptsovits_model_dir(), os.path.normpath("C:/af/md/gptsovits"))


class ReasonCodeContractParity(unittest.TestCase):
    """provision.reason_codes.ALL ⊆ runtimeContract.ts REASON_CODES."""

    def _contract_codes(self):
        path = os.path.join(REPO, "src", "shared", "runtimeContract.ts")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        m = re.search(r"REASON_CODES\s*=\s*\[(.*?)\]\s*as const", src, re.DOTALL)
        self.assertIsNotNone(m, "REASON_CODES 배열을 찾지 못함")
        return set(re.findall(r"'([A-Z_]+)'", m.group(1)))

    def test_all_provision_codes_in_contract(self):
        contract = self._contract_codes()
        for code in rc.ALL:
            self.assertIn(code, contract, f"{code}가 계약 REASON_CODES에 없음(자유 문자열 금지)")

    def test_provision_added_codes_present(self):
        contract = self._contract_codes()
        for code in rc.PROVISION_ADDED:
            self.assertIn(code, contract, f"provisioner 신규 코드 {code} 계약 미등록")


if __name__ == "__main__":
    unittest.main(verbosity=2)
