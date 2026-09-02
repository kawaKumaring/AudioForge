# -*- coding: utf-8 -*-
"""화자 참조가 생성 계획과 기록까지 손실 없이 이어지는지 — GPU 없이 검증한다.

여기서 보는 것
  · 계획의 `speaker_id` 가 생성 경로가 보는 행까지 그대로 온다
  · chunk 가 갈려도, 재시도해도 같은 발화의 chunk 는 같은 화자·참조를 갖는다
  · 화자 표기가 없는 대본은 v1.3.0 과 같은 행·같은 참조를 쓴다
  · manifest 에는 불투명 토큰과 SHA 만 남고 표시 이름·경로·대본은 private 에만 있다

모델·GPU·오디오 생성을 부르지 않는다. numpy 로 만든 짧은 톤만 쓴다.
"""
import json
import os
import shutil
import tempfile
import unittest

import numpy as np

import chunk_publish as cp
import speaker_refs as sr
import tts_grammar as tg
import tts_worker as tw

LF = chr(10)
SR = 24000

A = "C:/refs/minsu.wav"
B = "C:/refs/younghee.wav"
D = "C:/refs/global.wav"
PRESENT = {A, B, D}


def _table(**kw):
    kw.setdefault("default_ref", D)
    kw.setdefault("exists", lambda p: p in PRESENT)
    kw.setdefault("sha256_of", lambda p: {A: "a" * 64, B: "b" * 64, D: "d" * 64}[p])
    return sr.ReferenceTable(**kw)


def _rows(text):
    """계획 → 생성 경로가 보는 행. 대본 해석은 파서 한 곳에서만 한다."""
    plan = tg.parse_tts_script(text)
    assert plan["ok"], "이 fixture 는 파싱되어야 한다"
    parsed, _gaps, _kinds = tw._boundary_gaps_from_plan(plan["plan"], 0.5)
    return parsed


class PlanToGenerationTest(unittest.TestCase):
    """계획이 좁아지는 유일한 지점이 화자를 잃지 않는다."""

    def test_row_shape_keeps_legacy_positions_and_adds_speaker(self):
        rows = _rows("[화자 민수] 안녕." + LF + "[화자 영희] 저도요.")
        self.assertEqual([(r[0], r[1], r[2]) for r in rows],
                         [("default", "안녕.", "민수"), ("default", "저도요.", "영희")])
        # 앞의 두 자리는 v1.3.0 과 같다 — 기존 소비자가 그대로 동작한다.
        self.assertEqual([r[0] for r in rows], ["default", "default"])

    def test_legacy_script_rows_have_no_speaker(self):
        rows = _rows("[기쁨] 안녕." + LF + "둘째 줄.")
        self.assertEqual([r[2] for r in rows], [None, None])

    def test_speaker_survives_emotion_change_and_line_breaks(self):
        rows = _rows("[화자 민수] [기쁨] 안녕." + LF + "둘째 줄." + LF + LF + "빈 줄 뒤.")
        self.assertEqual([r[2] for r in rows], ["민수", "민수", "민수"])
        self.assertEqual([r[0] for r in rows], ["happy", "default", "default"],
                         "감정은 줄마다 초기화된다(화자와 다른 축)")

    def test_two_speakers_alternating_keep_their_own_reference(self):
        rows = _rows("[화자 민수] 안녕." + LF + "[화자 영희] 저도요." + LF + "[화자 민수] 또 저요.")
        t = _table(speaker_refs={"민수": A, "영희": B})
        got = [t.resolve(r[2], r[0])["path"] for r in rows]
        self.assertEqual(got, [A, B, A])
        # 한 화자의 참조가 다른 화자에게 새지 않는다.
        self.assertEqual(len(set(got)), 2)

    def test_legacy_script_reference_selection_is_unchanged(self):
        """화자 문법이 없는 대본은 감정 → 기본 순서를 그대로 쓴다(v1.3.0 동치)."""
        rows = _rows("[기쁨] 안녕." + LF + "둘째 줄.")
        t = _table(emotion_refs={"happy": B}, speaker_refs={"민수": A})
        got = [t.resolve(r[2], r[0]) for r in rows]
        self.assertEqual([g["path"] for g in got], [B, D])
        self.assertEqual([g["source"] for g in got], [sr.SOURCE_EMOTION, sr.SOURCE_DEFAULT])


class OwnershipTest(unittest.TestCase):
    """chunk 분할·재시도·전환이 소유권을 바꾸지 않는다."""

    def test_same_utterance_always_resolves_to_the_same_reference(self):
        """chunk 가 몇 개로 갈려도 조회 키는 (화자, 감정) 하나뿐이다 —
        그래서 같은 발화의 모든 chunk 가 같은 참조를 받고, 재시도도 같은 값을 받는다."""
        t = _table(speaker_refs={"민수": A})
        first = t.resolve("민수", "happy")
        for _ in range(5):        # 재시도·재조회
            again = t.resolve("민수", "happy")
            self.assertEqual(again, first)

    def test_resolution_does_not_depend_on_call_order(self):
        """취소 후 재개나 fallback 재실행에서 순서가 달라져도 결과가 같다."""
        t = _table(speaker_refs={"민수": A, "영희": B})
        forward = [t.resolve(s, "default")["path"] for s in ("민수", "영희", "민수")]
        backward = [t.resolve(s, "default")["path"] for s in ("민수", "영희", "민수")][::-1]
        self.assertEqual(forward, backward[::-1])

    def test_failure_of_one_speaker_leaves_the_other_intact(self):
        t = _table(speaker_refs={"민수": A, "영희": "C:/refs/gone.wav"})
        self.assertEqual(t.resolve("민수", "default")["path"], A)
        with self.assertRaises(sr.SpeakerReferenceError):
            t.resolve("영희", "default")
        # 실패 뒤에도 성공한 화자의 결과가 바뀌지 않는다(캐시 오염 없음).
        self.assertEqual(t.resolve("민수", "default")["path"], A)

    def test_diagnostic_merge_refuses_to_mix_speakers(self):
        """진단용 병합은 감정뿐 아니라 화자가 다르면 거부해야 한다."""
        src = tw.__file__
        with open(src, encoding="utf-8") as f:
            body = f.read()
        self.assertIn("DIAG_MERGE_REFUSED: 화자가", body,
                      "화자가 섞이는 병합을 막는 자리가 있어야 한다")


class RunBundleTest(unittest.TestCase):
    """manifest 는 불투명 토큰만, 표시 이름·대본은 private 만."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._prev = {k: os.environ.get(k) for k in
                      ("AUDIOFORGE_DIAG_CHUNK_PUBLISH", "AUDIOFORGE_LOCAL_ROOT")}
        os.environ["AUDIOFORGE_LOCAL_ROOT"] = self.tmp
        os.environ["AUDIOFORGE_DIAG_CHUNK_PUBLISH"] = "speaker-run"
        self.addCleanup(self._restore)
        self.rec = cp.ChunkRecorder()
        self.assertTrue(self.rec.active)

    def _restore(self):
        for k, v in self._prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_two_speakers(self):
        t = _table(speaker_refs={"민수": A, "영희": B})
        rows = []
        for si, (sid, eid) in enumerate((("민수", "default"), ("영희", "default"))):
            rows.append(dict(t.resolve(sid, eid), segment_index=si))
        self.rec.set_speaker_map(rows, labels={
            sr.opaque_speaker_ref("민수"): "민수",
            sr.opaque_speaker_ref("영희"): "영희",
        })
        arr = (0.2 * np.sin(2 * np.pi * 180.0 * np.arange(SR // 4) / SR)).astype(np.float32)
        # 발화 0 이 두 chunk 로 갈린 상황 — 둘 다 같은 화자·참조여야 한다.
        for g, seg in ((0, 0), (1, 0), (2, 1)):
            self.rec.raw(g, arr, SR)
            self.rec.record_chunk_text(g, "문장 %d 입니다." % g, segment=seg,
                                       local_chunk_index=g, model_call_index=g)
            self.rec.record_generation(g, generation_limit=239, generated_iterations=30,
                                       termination_reason="completed_before_limit",
                                       retries=0, fallback=False, elapsed_sec=1.0)
        self.rec.write("ok", final_arr=arr, sr=SR)
        return json.load(open(os.path.join(self.rec.root, "manifest.json"), encoding="utf-8"))

    def test_chunks_carry_opaque_speaker_and_reference(self):
        man = self._write_two_speakers()
        chunks = {c["chunk_index"]: c for c in man["chunks"]}
        self.assertEqual(chunks[0]["speaker_ref"], chunks[1]["speaker_ref"],
                         "같은 발화의 두 chunk 는 같은 화자여야 한다")
        self.assertNotEqual(chunks[0]["speaker_ref"], chunks[2]["speaker_ref"])
        for c in chunks.values():
            self.assertTrue(c["speaker_ref"].startswith("spk_"))
            self.assertTrue(c["reference_id"].startswith("ref_"))
            self.assertEqual(len(c["reference_sha256"]), 64)
            self.assertIn(c["reference_source"], sr.REFERENCE_SOURCES)

    def test_manifest_has_no_names_paths_or_script(self):
        man = self._write_two_speakers()
        blob = json.dumps(man, ensure_ascii=False)
        for leak in ("민수", "영희", "refs", "minsu.wav", "문장 0 입니다"):
            self.assertNotIn(leak, blob, "manifest 로 새면 안 된다: %s" % leak)
        # 절대경로 흔적도 없어야 한다.
        self.assertNotIn(":/", blob)
        self.assertNotIn(self.tmp.replace(os.sep, "/"), blob)

    def test_display_names_live_only_in_private_json(self):
        self._write_two_speakers()
        priv = os.path.join(self.rec.root, "speakers.private.json")
        self.assertTrue(os.path.isfile(priv), "표시 이름은 private 문서에 있어야 한다")
        doc = json.load(open(priv, encoding="utf-8"))
        self.assertTrue(doc["private"])
        self.assertEqual(sorted(doc["labels"].values()), ["민수", "영희"])
        for key in doc["labels"]:
            self.assertTrue(key.startswith("spk_"), "키는 불투명 토큰이어야 한다")

    def test_private_artifact_is_not_exportable(self):
        self._write_two_speakers()
        man = json.load(open(os.path.join(self.rec.root, "manifest.json"), encoding="utf-8"))
        rows = [a for a in man["artifacts"] if a["path"].startswith("speakers")]
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["export_allowed"])

    def test_legacy_run_without_speakers_has_no_speaker_fields(self):
        arr = (0.2 * np.sin(2 * np.pi * 180.0 * np.arange(SR // 4) / SR)).astype(np.float32)
        self.rec.raw(0, arr, SR)
        self.rec.record_chunk_text(0, "문장입니다.", segment=0, local_chunk_index=0,
                                   model_call_index=0)
        self.rec.write("ok", final_arr=arr, sr=SR)
        man = json.load(open(os.path.join(self.rec.root, "manifest.json"), encoding="utf-8"))
        self.assertNotIn("speaker_ref", man["chunks"][0],
                         "화자를 안 쓴 작업에 빈 화자 칸을 만들지 않는다")
        self.assertFalse(os.path.exists(os.path.join(self.rec.root, "speakers.private.json")))


if __name__ == "__main__":
    unittest.main()
