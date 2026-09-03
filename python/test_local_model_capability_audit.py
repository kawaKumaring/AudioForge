# -*- coding: utf-8 -*-
"""설치된 로컬 모델 감사 — 표가 디스크의 사실과 어긋나지 않는지.

이 감사의 위험은 하나다: **큰 모델이니 되겠지** 하고 supported 를 적는 것. 그래서
검증도 거기를 먼저 막는다.

  · 표 어디에도 supported 가 없다(프로브 없이 supported 가 나올 경로가 없다)
  · 표에 적은 크기·종류가 실제 config.json 과 같다
  · adapter 가 실제로 어느 스냅샷을 가리키는지와 표의 연결 판정이 같다
  · 모델 카드가 Base 의 지시 제어를 선언하지 않았다는 사실이 파일에 그대로 있다
  · 추론 API 에 F0·길이 인자가 없다는 사실이 vendor 소스에 그대로 있다
  · 지금 감정을 모델에 직접 넘기는 통로는 없다

GPU·모델 로딩·다운로드 없음. 텍스트 파일만 읽는다.
"""
import io
import json
import os
import unittest

import expressive_capability as cap

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(REPO, "externals")

SNAP_0B6 = os.path.join(EXT, "qwen3_tts_hf", "hub",
                        "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base", "snapshots")
DIR_1B7 = os.path.join(EXT, "qwen3_tts_1_7b_base")
VENDOR = os.path.join(EXT, "qwen3_tts_venv", "Lib", "site-packages", "qwen_tts",
                      "inference", "qwen3_tts_model.py")


def _read(path):
    return io.open(path, encoding="utf-8", errors="replace").read()


def _config(path):
    return json.load(io.open(path, encoding="utf-8"))


def _snapshot_0b6():
    if not os.path.isdir(SNAP_0B6):
        return None
    for name in sorted(os.listdir(SNAP_0B6)):
        p = os.path.join(SNAP_0B6, name)
        if os.path.isfile(os.path.join(p, "config.json")):
            return p
    return None


class TableShapeTest(unittest.TestCase):
    """표 자체의 규율 — 파일이 없어도 성립해야 한다."""

    def setUp(self):
        self.rows = {r["model"]: r for r in cap.local_model_audit()}

    def test_no_cell_claims_supported(self):
        for name, row in self.rows.items():
            for feature, cell in row["features"].items():
                self.assertNotEqual(cell["state"], "supported",
                                    "프로브 없이 supported 를 적었다: %s/%s"
                                    % (name, feature))

    def test_every_asked_axis_has_a_reason(self):
        for name, row in self.rows.items():
            self.assertEqual(set(row["features"]), set(cap.AUDIT_FEATURES), name)
            for feature, cell in row["features"].items():
                self.assertIn(cell["state"], cap.CAPABILITY_STATES)
                self.assertIn(cell["evidence"], cap.AUDIT_EVIDENCE,
                              "근거 없는 판정: %s/%s" % (name, feature))

    def test_open_questions_are_marked_for_a_probe(self):
        """unknown 이 남아 있으면 '추가 검증 필요'가 켜져 있어야 한다."""
        for name, row in self.rows.items():
            has_unknown = any(c["state"] == cap.UNVERIFIED_STATE
                              for c in row["features"].values())
            self.assertEqual(row["needs_gpu_probe"], has_unknown, name)

    def test_uninstalled_variants_are_marked_for_download(self):
        for name, row in self.rows.items():
            self.assertEqual(row["needs_download"], not row["installed"], name)
            if not row["installed"]:
                self.assertFalse(row["adapter_connectable"],
                                 "설치도 안 된 모델을 연결 가능이라 적었다: %s" % name)

    def test_no_native_emotion_path_today(self):
        self.assertFalse(cap.native_emotion_path_available())
        summary = cap.audit_summary()
        self.assertFalse(summary["native_emotion_path"])
        self.assertEqual(summary["installed"], 2)
        self.assertEqual(summary["connectable"], 1)

    def test_summary_carries_only_short_tokens(self):
        blob = json.dumps(cap.audit_summary(), ensure_ascii=False)
        for leak in (":/", ".safetensors", "externals", "Qwen/"):
            self.assertNotIn(leak, blob, "요약에 경로가 샜다: %s" % leak)

    def test_clone_and_emotion_never_meet_in_one_model(self):
        """복제는 Base, 지시는 CustomVoice/VoiceDesign — 겹치는 모델이 없다."""
        for name, row in self.rows.items():
            self.assertEqual(
                row["features"]["speaker_clone_with_emotion_control"]["state"],
                "unsupported",
                "복제와 감정 제어를 동시에 한다고 적힌 모델이 있다: %s" % name)


class DiskEvidenceTest(unittest.TestCase):
    """표가 디스크의 사실과 같은가. 자산이 없으면 건너뛴다(값을 지어내지 않는다)."""

    def setUp(self):
        self.rows = {r["model"]: r for r in cap.local_model_audit()}

    @unittest.skipUnless(os.path.isdir(DIR_1B7), "1.7B 스냅샷 없음")
    def test_1b7_config_matches_the_table(self):
        cfg = _config(os.path.join(DIR_1B7, "config.json"))
        row = self.rows["qwen3_tts_1b7_base"]
        self.assertEqual(cfg["tts_model_size"], row["model_size"])
        self.assertEqual(cfg["tts_model_type"], row["model_type"])
        self.assertTrue(row["installed"])

    @unittest.skipUnless(_snapshot_0b6(), "0.6B 스냅샷 없음")
    def test_0b6_config_matches_the_table(self):
        cfg = _config(os.path.join(_snapshot_0b6(), "config.json"))
        row = self.rows["qwen3_tts_0b6_base"]
        self.assertEqual(cfg["tts_model_size"], row["model_size"])
        self.assertEqual(cfg["tts_model_type"], row["model_type"])

    @unittest.skipUnless(os.path.isdir(DIR_1B7), "1.7B 스냅샷 없음")
    def test_1b7_is_not_connectable_for_wiring_not_for_missing_files(self):
        """파일이 모자란 것이 아니다 — adapter 가 다른 경로에 고정돼 있을 뿐이다."""
        import tts_worker as tw
        for name in tw._QWEN_REQUIRED:
            self.assertTrue(os.path.isfile(os.path.join(DIR_1B7, name)),
                            "필수 파일이 없다: %s" % name)
        row = self.rows["qwen3_tts_1b7_base"]
        self.assertFalse(row["adapter_connectable"])
        self.assertEqual(row["adapter_note"], cap.EV_ADAPTER_PATH_PINNED)
        # adapter 가 실제로 가리키는 곳은 0.6B 스냅샷이다.
        self.assertIn("0.6B", tw._QWEN_SNAPSHOT)
        self.assertNotIn("1_7b", tw._QWEN_SNAPSHOT)

    @unittest.skipUnless(os.path.isfile(os.path.join(DIR_1B7, "README.md")),
                         "모델 카드 없음")
    def test_model_card_does_not_declare_instruction_control_for_base(self):
        card = _read(os.path.join(DIR_1B7, "README.md"))
        base_rows = [ln for ln in card.split(chr(10))
                     if ln.startswith("| Qwen3-TTS-12Hz-") and "-Base " in ln]
        self.assertTrue(base_rows, "모델 카드에서 Base 행을 찾지 못했다")
        for line in base_rows:
            # 표의 마지막 칸(Instruction Control)이 비어 있어야 한다.
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            self.assertEqual(cells[-1], "",
                             "Base 가 지시 제어를 선언하고 있다: %s" % line[:60])
        # 반대쪽 사실도 같은 표에서 확인한다 — 지시 제어는 다른 변종에만 있다.
        # (그래서 "복제 + 감정"이 한 모델에서 성립하지 않는다.)
        declared = []
        for line in card.split(chr(10)):
            if not line.startswith("| Qwen3-TTS-12Hz-1.7B-"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells[-1] == "✅":
                declared.append(cells[0])
        self.assertTrue(any("CustomVoice" in n for n in declared), declared)
        self.assertTrue(any("VoiceDesign" in n for n in declared), declared)
        self.assertFalse(any(n.endswith("-Base") for n in declared),
                         "Base 가 지시 제어를 선언한 것으로 읽혔다: %s" % declared)

    @unittest.skipUnless(os.path.isfile(VENDOR), "vendor 추론 소스 없음")
    def test_inference_api_has_no_f0_or_duration_parameter(self):
        """F0·길이 인자가 없다는 것이 unsupported 의 근거다 — 실제로 없는지 본다."""
        src = _read(VENDOR)
        for absent in ("f0_contour", "pitch_contour", "duration_ids",
                       "target_duration", "prosody"):
            self.assertNotIn(absent, src, "인자가 생겼다면 표를 다시 써야 한다: %s" % absent)
        # 반대로 참조 조건화는 실제로 있다(그래서 그 축만 unknown 이다).
        self.assertIn("def generate_voice_clone", src)
        self.assertIn("ref_audio", src)

    @unittest.skipUnless(os.path.isfile(VENDOR), "vendor 추론 소스 없음")
    def test_instruct_entry_points_refuse_our_model_type(self):
        """지시를 받는 함수들은 base 모델을 거부한다 — 우리 스냅샷이 둘 다 base 다."""
        src = _read(VENDOR)
        self.assertIn('self.model.tts_model_type != "custom_voice"', src)
        self.assertIn('self.model.tts_model_type != "voice_design"', src)
        # 0b6 에 대한 vendor 자기선언도 그대로 있어야 한다.
        self.assertIn('tts_model_size in "0b6"', src)


class RunBundleCapabilityTest(unittest.TestCase):
    """작업 기록이 '그때 모델이 감정을 받을 수 있었는가'를 남기는가.

    참조 선택 근거만 남기면 나중에 결과를 다시 볼 때 "이 작업은 모델이 감정을 받은
    것인가, 참조만 고른 것인가"를 구분할 수 없다.
    """

    def setUp(self):
        import shutil
        import tempfile

        import chunk_publish as cp
        self.cp = cp
        self.tmp = tempfile.mkdtemp()
        self._prev = {k: os.environ.get(k) for k in
                      ("AUDIOFORGE_DIAG_CHUNK_PUBLISH", "AUDIOFORGE_LOCAL_ROOT")}
        os.environ["AUDIOFORGE_LOCAL_ROOT"] = self.tmp
        os.environ["AUDIOFORGE_DIAG_CHUNK_PUBLISH"] = "capability-run"

        def restore():
            for k, v in self._prev.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(self.tmp, ignore_errors=True)
        self.addCleanup(restore)
        self.rec = cp.ChunkRecorder()
        self.assertTrue(self.rec.active)

    def _manifest(self):
        import numpy as np
        arr = (0.2 * np.sin(np.arange(6000) / 20.0)).astype(np.float32)
        self.rec.set_run_header(emotion_capability=cap.audit_summary())
        self.rec.raw(0, arr, 24000)
        self.rec.record_chunk_text(0, "문장입니다.", segment=0, local_chunk_index=0,
                                   model_call_index=0)
        self.rec.write("ok", final_arr=arr, sr=24000)
        return json.load(io.open(os.path.join(self.rec.root, "manifest.json"),
                                 encoding="utf-8"))

    def _capability(self, man):
        """헤더가 어디에 실리든 감사 요약을 찾아낸다(키 위치를 이 테스트가 정하지 않는다)."""
        found = []

        def walk(node):
            if isinstance(node, dict):
                if "emotion_capability" in node:
                    found.append(node["emotion_capability"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(man)
        self.assertEqual(len(found), 1, "감사 요약이 기록에 정확히 한 번 있어야 한다")
        return found[0]

    def test_capability_is_recorded_with_the_run(self):
        rec = self._capability(self._manifest())
        self.assertEqual(rec["audit_version"], cap.LOCAL_MODEL_AUDIT_VERSION)
        self.assertEqual(rec["installed"], 2)
        self.assertEqual(rec["connectable"], 1)

    def test_recorded_capability_says_no_native_path(self):
        """기록이 "그때 모델이 감정을 받았다"로 읽히면 안 된다."""
        rec = self._capability(self._manifest())
        self.assertIs(rec["native_emotion_path"], False)
        self.assertIn("emotion_instruction_text", rec["open_probes"])

    def test_the_worker_records_it_at_all(self):
        """배선이 사라지면 이 파일만 보고는 알 수 없다 — 소스로 고정한다."""
        src = _read(os.path.join(REPO, "python", "tts_worker.py"))
        self.assertIn("emotion_capability=", src)
        self.assertIn("audit_summary()", src)


if __name__ == "__main__":
    unittest.main()
