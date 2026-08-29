"""chunk WAV 경로 규칙 — bridge(생성)와 tts_worker(검증)가 '동일' 규칙을 쓰도록 공용 순수 헬퍼.

중복 구현으로 규칙이 갈라지면 검증이 무의미해지므로 단일 소스로 둔다. os만 의존(순수).
"""
import os


def chunk_out_path(seg_out_path, chunk_index):
    """원본 segment out_path와 같은 디렉터리(job_dir) 안, 결정적 파일명. chunk index 포함.
    예: .../segment_qwen_001.wav → .../segment_qwen_001_c000.wav. 임의/외부 경로 생성 금지."""
    d = os.path.dirname(seg_out_path)
    base = os.path.basename(seg_out_path)
    stem = base[:-4] if base.lower().endswith(".wav") else base
    return os.path.join(d, f"{stem}_c{int(chunk_index):03d}.wav")


def same_real_path(a, b):
    """realpath+normcase 기준 동일 경로 여부(junction/symlink 우회·대소문자·상위경로 이탈 방지)."""
    return (os.path.normcase(os.path.realpath(a))
            == os.path.normcase(os.path.realpath(b)))
