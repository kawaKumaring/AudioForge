# -*- coding: utf-8 -*-
"""provision.fingerprint — canonical JSON 직렬화 + SHA-256 planFingerprint(순수).

승인 토큰 = plan fingerprint. plan/dry-run 결과를 canonical JSON으로 직렬화한 뒤 SHA-256을
발급한다. manifest/경로(상대 install path)/버전이 바뀌면 canonical JSON이 바뀌므로 fingerprint가
달라지고, 과거 승인 토큰은 자동 무효가 된다.

canonical 규칙(TS src/shared/provisionContract.ts canonicalize와 동형 — parity 테스트로 고정):
  - dict 키 사전순 정렬, 재귀 적용
  - 구분자 (",", ":") — 공백 0
  - ensure_ascii=False(UTF-8 바이트로 해시)
  - float은 fingerprint 입력에 쓰지 않는다(정수·문자열·불리언·None만; 크기는 정수 바이트)
"""

import hashlib
import json

ALGORITHM = "sha256"


def canonical_json(obj):
    """결정적 canonical JSON 문자열. 키 정렬 + 공백 제거 + 비-ASCII 보존."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def fingerprint(obj):
    """canonical JSON의 SHA-256 hexdigest."""
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def matches(obj, token):
    """token이 obj의 현재 fingerprint와 정확히 일치하는가(대소문자 구분, 정확 일치)."""
    return matches_token(token, fingerprint(obj))


def matches_token(token, expected):
    """이미 계산된 두 digest 문자열의 정확 일치(둘 다 비어있지 않은 str이어야 함)."""
    if not isinstance(token, str) or not token:
        return False
    if not isinstance(expected, str) or not expected:
        return False
    return token == expected
