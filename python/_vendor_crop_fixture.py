# -*- coding: utf-8 -*-
"""테스트용 vendor native ICL 발행 근거 생성기.

production 기본 경로는 vendor native ICL 이므로, bridge 를 스텁하는 픽스처는
controlled-prefix 가 아닌 한 **유효한 vendor_crop_record** 를 함께 돌려줘야 한다.
좌표(decoded_total/cut)는 vendor 가 반환하지 않으므로 여기서도 만들지 않는다.
"""
import hashlib

import tts_worker


def vendor_crop_record(wav_path, x_vector_only=False, sample_rate=24000,
                       ref_code_frames=80, generated_code_frames=100):
    """발행 대상 WAV 에 묶인 유효 record. returned_samples 는 실제 파일에서 읽는다."""
    import soundfile as sf
    info = sf.info(wav_path)
    return {
        "schema_version": tts_worker.VENDOR_CROP_SCHEMA,
        "crop_contract_version": 2,
        "model_revision": "fixture",
        "sample_rate": int(info.samplerate or sample_rate),
        "prefix_text_enabled": False,
        "x_vector_only_mode": bool(x_vector_only),
        "reference_audio_sha256": "a" * 64,
        "reference_text_sha256": "b" * 64,
        "target_script_sha256": "c" * 64,
        "ref_code_frames": ref_code_frames,
        "generated_code_frames": generated_code_frames,
        "total_code_frames": ref_code_frames + generated_code_frames,
        "returned_samples": int(info.frames),
        "returned_pcm_sha256": hashlib.sha256(open(wav_path, "rb").read()).hexdigest(),
        "crop_authority": "vendor_native_ref_code",
        "crop_coordinates_observed": False,
        "termination_reason": "completed_before_limit",
        "external_alignment_calls": 0,
    }


def attach(entry, segment):
    """controlled-prefix 가 아닌 ICL entry 에만 native 발행 근거를 붙인다."""
    if segment.get("prefix_text") or segment.get("x_vector_only"):
        return entry
    entry["vendor_crop_record"] = vendor_crop_record(entry["out_path"])
    return entry
