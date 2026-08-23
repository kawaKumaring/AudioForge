"""model_manifest — 모델 파일 존재 + sha256 검증(순수 계산).

책임 분리(통합 담당 확정 지시): checksum '계산'은 여기(Python, production), '해석'은
C(capabilityEvaluator). 이 모듈은 계약 ModelCapability/ValidationEvidenceItem에 정합하는
{present, expectedChecksum, actualChecksum, reasonCode} 형태의 evidence를 생산할 뿐,
지원/미지원 판정(상태 3축)은 하지 않는다.

evidence 키(C가 소비): qwen3 / separator_bs / separator_melband / gptsovits.

성능: 실제 모델은 수 GB이므로 actualChecksum은 expectedChecksum이 주어졌을 때만 계산한다
(manifest 없으면 present-only). present 판정은 존재 + size>0.
"""

import hashlib
import os

# 사유 코드(계약 ReasonCode union 정합). 상태 해석은 C가 하므로 여기선 원인 코드만 부여.
MODEL_MISSING = "MODEL_MISSING"
MODEL_CHECKSUM_MISMATCH = "MODEL_CHECKSUM_MISMATCH"

# C가 소비하는 evidence 키(고정). 워커/해석기가 동일 문자열을 써야 한다.
MODEL_KEYS = ("qwen3", "separator_bs", "separator_melband", "gptsovits")


def sha256_file(path, _chunk=1 << 20):
    """단일 파일 sha256 hexdigest(스트리밍)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(_chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def aggregate_digest(files):
    """여러 파일의 결합 sha256. (basename 소문자, 파일 digest)를 basename 정렬로 결합해
    순서 안정. 파일 하나만이면 그 파일의 digest를 감싼 상위 digest가 된다."""
    parts = []
    for p in sorted(files, key=lambda x: os.path.basename(x).lower()):
        parts.append(os.path.basename(p).lower() + ":" + sha256_file(p))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def verify_model(files, expected_digest=None):
    """files: 필수 파일 절대경로 리스트. expected_digest: manifest의 결합 digest 또는 None.
    반환: {present, expectedChecksum, actualChecksum, reasonCode}.
    - present = files 비어있지 않고 모든 파일 존재 & size>0
    - expected_digest 있을 때만 actualChecksum 계산(불일치 → MODEL_CHECKSUM_MISMATCH)
    - present False → MODEL_MISSING
    """
    present = bool(files) and all(
        os.path.exists(p) and os.path.getsize(p) > 0 for p in files
    )
    actual = None
    reason = None
    if not present:
        reason = MODEL_MISSING
    elif expected_digest is not None:
        actual = aggregate_digest(files)
        if actual != expected_digest:
            reason = MODEL_CHECKSUM_MISMATCH
    return {
        "present": present,
        "expectedChecksum": expected_digest,
        "actualChecksum": actual,
        "reasonCode": reason,
    }


def build_evidence(spec):
    """spec: {key: {"files": [abs...], "expected": digest|None}} — key는 MODEL_KEYS 부분집합.
    반환: {key: verify_model(...)}. C(capabilityEvaluator)가 그대로 해석한다."""
    out = {}
    for key, entry in spec.items():
        files = entry.get("files") or []
        expected = entry.get("expected")
        out[key] = verify_model(files, expected)
    return out
