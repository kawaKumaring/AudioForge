# -*- coding: utf-8 -*-
"""vendor_internal_crop_record 발행 계약 회귀.

ASR alignment record 와 **별개 권위**이며, 정확히 하나만 유효할 때 발행한다.
값을 보정하지 않고 불일치는 전부 fail-closed 다.
"""
import hashlib
import os
import tempfile
import unittest

import numpy as np
import soundfile as sf

import tts_worker as tw

HOP = 1920
SR = 24000


def _wav(path, n):
    """검증 가능한 비-무음 파형(클리핑·NaN 없음)."""
    t = np.arange(n, dtype=np.float32) / SR
    a = (0.2 * np.sin(2 * np.pi * 180.0 * t)).astype(np.float32)
    sf.write(path, a, SR, subtype="FLOAT")
    _PCM_SHA[0] = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return a


_PCM_SHA = [""]


def _record(ref_f, gen_f, arr):
    """관측 가능한 필드만. decoded_total/cut 좌표는 vendor 가 반환하지 않아 기록하지 않는다."""
    return {"schema_version": tw.VENDOR_CROP_SCHEMA,
            "crop_contract_version": 2,
            "model_revision": "test-rev",
            "sample_rate": SR,
            "prefix_text_enabled": False,
            "x_vector_only_mode": False,
            "reference_audio_sha256": "a" * 64,
            "reference_text_sha256": "b" * 64,
            "target_script_sha256": "c" * 64,
            "ref_code_frames": ref_f,
            "generated_code_frames": gen_f,
            "total_code_frames": ref_f + gen_f,
            "returned_samples": int(arr.shape[0]),
            "returned_pcm_sha256": _PCM_SHA[0],
            "crop_authority": "vendor_native_ref_code",
            "crop_coordinates_observed": False,
            "termination_reason": "completed_before_limit",
            "external_alignment_calls": 0}


class VendorCropRecordTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, "c.wav")
        self.arr = _wav(self.p, 100 * HOP)
        self.rec = _record(80, 100, self.arr)

    # 1) 유효 record 는 통과
    def test_valid_record_passes(self):
        self.assertIsNone(tw.validate_vendor_crop_record(self.rec, self.p))

    # 2) 필수 필드 누락 실패
    def test_missing_field_fails(self):
        for k in ("ref_code_frames", "returned_pcm_sha256", "model_revision"):
            r = dict(self.rec); r[k] = None
            self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                             "missing_field:" + k)

    # 3) PCM SHA 불일치 실패
    def test_pcm_sha_mismatch_fails(self):
        r = dict(self.rec); r["returned_pcm_sha256"] = "0" * 64
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p), "pcm_sha_mismatch")

    # 4) sample 길이 불일치 실패
    def test_length_mismatch_fails(self):
        r = dict(self.rec); r["returned_samples"] = int(self.arr.shape[0]) - HOP
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                         "returned_samples_length_mismatch")

    # 좌표를 관측했다고 주장하면 거부한다
    def test_claiming_observed_coordinates_rejected(self):
        r = dict(self.rec); r["crop_coordinates_observed"] = True
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                         "crop_coordinates_observed_must_be_false")

    def test_crop_authority_mismatch(self):
        r = dict(self.rec); r["crop_authority"] = "external_asr_trim"
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p), "crop_authority_mismatch")

    # 5) prefix_text 활성이면 native 계약 거부
    def test_prefix_enabled_rejected(self):
        r = dict(self.rec); r["prefix_text_enabled"] = True
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                         "prefix_text_enabled_must_be_false")

    # 6) 외부 alignment 호출이 있으면 거부
    def test_external_alignment_rejected(self):
        r = dict(self.rec); r["external_alignment_calls"] = 1
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                         "external_alignment_calls_not_zero")

    # 8) generation limit / cooperative stop 은 발행 금지
    def test_non_natural_termination_rejected(self):
        for t in ("generation_limit", "cooperative_stop"):
            r = dict(self.rec); r["termination_reason"] = t
            self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                             "termination_not_completed_before_limit")

    def test_x_vector_only_rejected(self):
        r = dict(self.rec); r["x_vector_only_mode"] = True
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p),
                         "x_vector_only_mode_must_be_false")

    def test_frame_invariants(self):
        r = dict(self.rec); r["total_code_frames"] = r["ref_code_frames"] + 1
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p), "frame_invariant_failed")
        r = dict(self.rec); r["ref_code_frames"] = 0
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p), "frame_invariant_failed")

    def test_schema_mismatch(self):
        r = dict(self.rec); r["schema_version"] = "af-vendor-internal-crop/999"
        self.assertEqual(tw.validate_vendor_crop_record(r, self.p), "schema_mismatch")

    # 고정 hop 으로 frame x sample 을 비교하지 않는다 — record 에 좌표 필드 자체가 없다
    def test_no_coordinate_fields_required(self):
        for k in ("decoded_total_samples", "vendor_internal_cut_samples", "codec_hop_samples"):
            self.assertNotIn(k, tw._VENDOR_CROP_REQUIRED)

    def test_empty_and_nan_and_clipping(self):
        p2 = os.path.join(self.d, "empty.wav")
        sf.write(p2, np.zeros(0, dtype=np.float32), SR, subtype="FLOAT")
        r = dict(self.rec); r["returned_samples"] = 0
        self.assertIn(tw.validate_vendor_crop_record(r, p2),
                      ("returned_samples_not_positive", "empty_waveform",
                       "returned_samples_length_mismatch"))
        p3 = os.path.join(self.d, "clip.wav")
        a3 = np.ones(100 * HOP, dtype=np.float32)
        sf.write(p3, a3, SR, subtype="FLOAT")
        r3 = _record(80, 100, a3)
        self.assertEqual(tw.validate_vendor_crop_record(r3, p3), "clipping")


class PublicationAuthorityTest(unittest.TestCase):
    """두 권위 중 정확히 하나만 유효해야 한다."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, "c.wav")
        self.arr = _wav(self.p, 100 * HOP)

    def _entry(self, **kw):
        e = {"out_path": self.p, "original_segment_index": 0, "chunk_index": 0,
             "emotion_id": "default"}
        e.update(kw)
        return e

    # 7) 두 기록 동시 존재 → 거부
    def test_dual_record_rejected(self):
        e = self._entry(vendor_crop_record=_record(80, 100, self.arr),
                        reference_alignment={"align_anchor_kind": "TARGET_HEAD"},
                        reference_cut_sample=1000)
        with self.assertRaises(RuntimeError) as cm:
            tw._summarize_reference_alignment([e])
        self.assertEqual(cm.exception.error_payload["boundary_reason"], "DUAL_CROP_RECORD")

    # 1) vendor 단독 → 통과
    def test_vendor_only_passes(self):
        e = self._entry(vendor_crop_record=_record(80, 100, self.arr))
        summary, cut = tw._summarize_reference_alignment([e])
        self.assertIsNone(summary)
        self.assertIsNone(cut)

    # 2) 아무 기록도 없으면 기존 사유로 실패(controlled-prefix 경로 불변)
    def test_no_record_fails_as_before(self):
        with self.assertRaises(RuntimeError) as cm:
            tw._summarize_reference_alignment([self._entry()])
        self.assertEqual(cm.exception.error_payload["boundary_reason"],
                         "MISSING_ALIGNMENT_RECORD")

    # 유효하지 않은 vendor record → 전용 코드로 실패
    def test_invalid_vendor_record_fails(self):
        bad = _record(80, 100, self.arr); bad["returned_pcm_sha256"] = "0" * 64
        with self.assertRaises(RuntimeError) as cm:
            tw._summarize_reference_alignment([self._entry(vendor_crop_record=bad)])
        self.assertEqual(cm.exception.error_payload["code"],
                         tw.MISSING_OR_INVALID_VENDOR_CROP_RECORD)

    # 13) public 요약에 원문·전사·절대경로가 없다
    def test_no_sensitive_in_summary(self):
        e = self._entry(vendor_crop_record=_record(80, 100, self.arr))
        summary, _ = tw._summarize_reference_alignment([e])
        self.assertIsNone(summary)


if __name__ == "__main__":
    unittest.main()
