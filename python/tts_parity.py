"""공용 마감 I1 — parser parity 글루(통합 담당 소유). A의 tts_grammar 파서를 '소비'만 한다(수정 없음).

renderer가 parser_version=2로 파싱해 보낸 full sha256과, Python이 같은 raw ttsText를 재파싱한 full sha256을
대조한다. 합성 권위는 Python. separate.py가 모델 로딩 전에 호출해 불일치/파싱오류를 차단한다.
"""
import tts_grammar as _tg


def verify_parity(raw, expected_full_sha256):
    """반환: [] 통과 / [error dict, ...] 실패(모델 로딩 전 차단용).

    - Python 파싱 실패 → 그 구조화 오류(UNKNOWN_TTS_TAG/INVALID_PAUSE_TAG/EMPTY_EMOTION_SEGMENT ...) 그대로.
    - 파싱 성공인데 renderer full sha256과 불일치 → [{"code":"PARSER_PARITY_MISMATCH"}].
    - expected가 비어 있으면(구버전/미전달) parity를 강제하지 않고 파싱 유효성만 확인(파싱 실패는 여전히 오류).
    오류에는 code·비민감 위치/식별자만(대사 전문·경로 없음). 대사 전문을 로그로 남기지 않는다.
    """
    res = _tg.parse_tts_script(raw or "")
    if not res.get("ok"):
        return list(res.get("errors", []))
    if expected_full_sha256:
        if res["plan"]["full_sha256"] != expected_full_sha256:
            return [{"code": "PARSER_PARITY_MISMATCH"}]
    return []
