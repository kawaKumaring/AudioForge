"""공용 마감 I1 — parser parity 글루(통합 담당 소유). 파서를 '소비'만 한다(파서 수정 없음).

renderer가 파싱해 보낸 full sha256과, Python이 같은 raw ttsText를 재파싱한 full sha256을 대조한다.
합성 권위는 Python. separate.py가 모델 로딩 전에 호출해 불일치/파싱오류를 차단한다.

⚠️ 파서 선택은 '명시 플래그'만이 결정한다
   (계약 필드 = expressive_timeline.EXPRESSIVE_MODE_FIELD = 'ttsExpressiveMode'):
     legacy_v2   → tts_grammar.parse_tts_script            (TTS_PARSER_VERSION=2, 오늘과 완전 동일)
     expressive_v3 → expressive_timeline.parse_expressive_timeline(mode='expressive_v3')
   본문 내용은 절대 모드를 고르지 않는다. v3는 '명시적이고 유효한' 값일 때만 켜진다.

   부재(키 없음/None)만이 조용한 legacy_v2다(레거시 세션 = 오늘과 완전 동일).
   ''·오타·타입 오류처럼 '값은 있는데 계약 밖'인 경우는 조용히 v2로 강등하지 않고
   EXPRESSIVE_MODE_INVALID 로 크게 실패한다 — 계약 expressive_timeline §10 과
   test_expressive_timeline.test_h3_invalid_values_are_loud 가 요구하는 바다.
   (폴백 mode 값 자체는 여전히 legacy_v2 — 누가 validity 를 무시해도 v3 로 승격되지는 않는다.)

⚠️ v3 모드도 검증 '우회'가 아니다. v3에서는 expressive timeline의 full_sha256이 parity 권위이며,
   불일치는 v2와 구분되는 EXPRESSIVE_PARITY_MISMATCH로 똑같이 크게 실패한다.

오류에는 code·비민감 위치/식별자만(대사 전문·경로 없음). 대사 전문을 로그로 남기지 않는다.
"""
import expressive_timeline as _ex
import tts_grammar as _tg

# 모드 문자열 — 계약 집합(_ex.EXPRESSIVE_MODES) 안에 있음을 test_expressive_v3_wiring 이 고정한다.
EXPRESSIVE_MODE_LEGACY_V2 = "legacy_v2"
EXPRESSIVE_MODE_V3 = "expressive_v3"

# v2 parity 불일치 코드(기존·불변) / v3 전용 코드. 두 불일치는 호출자가 반드시 구분할 수 있어야 한다.
PARSER_PARITY_MISMATCH = "PARSER_PARITY_MISMATCH"
EXPRESSIVE_PARITY_MISMATCH = "EXPRESSIVE_PARITY_MISMATCH"

# '값은 있는데 계약 밖' 플래그. 계약 enum(_ex.EXPRESSIVE_ERROR_CODES)에 이미 있는 코드를 재사용만 한다.
EXPRESSIVE_MODE_INVALID = "EXPRESSIVE_MODE_INVALID"

# v3 검증은 통과했지만 합성 경로가 v3 타임라인을 소비할 수 없을 때의 '경계' 코드.
# tts_worker.synthesize는 v2 plan(segments/boundary_type)만 소비하므로(자체 방어 재파싱 포함)
# 번역 레이어 없이 v3를 밀어넣으면 뒤에서 죽는다 → separate.py가 여기서 명확히 차단한다.
# ⚠️ expressive_timeline.EXPRESSIVE_ERROR_CODES(계약 v3 enum)에는 넣지 않는다 — 이 코드는 '배선 경계'
#    소관이며 계약 enum을 늘리면 EXPRESSIVE_CONTRACT_VERSION의 의미가 흔들린다.
EXPRESSIVE_V3_SYNTHESIS_UNSUPPORTED = "EXPRESSIVE_V3_SYNTHESIS_UNSUPPORTED"


def resolve_parity_mode(flag_value):
    """ttsExpressiveMode 원시값 → 계약 해석 dict {mode, source, valid, error_code, raw_type}.

    해석 권위는 계약의 expressive_timeline.resolve_expressive_mode 하나뿐이다
    (평행 플래그·평행 기본값 금지). 여기서는 위임만 하고 규칙을 다시 쓰지 않는다.
    호출자는 mode 만 보지 말고 valid 도 반드시 봐야 한다 — 부재와 오타를 구분하는 유일한 신호다.
    """
    return dict(_ex.resolve_expressive_mode(flag_value))


def parity_mode(flag_value):
    """ttsExpressiveMode 원시값 → 실제로 쓸 모드 문자열('안전한 폴백' 값).

    ⚠️ 이 함수는 validity 를 버린다. 오타·타입 오류도 EXPRESSIVE_MODE_LEGACY_V2 를 돌려주므로
       '차단 여부' 판단에 단독으로 쓰면 안 된다(그때는 resolve_parity_mode 나 verify_parity 를 쓴다).
       verify_parity 를 통과한 뒤 '어느 파서로 갔는가'를 읽는 용도다.
    """
    return _ex.resolve_expressive_mode(flag_value)["mode"]


def uses_expressive_v3(flag_value):
    """'명시적이고 유효한' v3 값일 때만 True. 부재·불량값은 언제나 False."""
    r = _ex.resolve_expressive_mode(flag_value)
    return bool(r["valid"]) and r["source"] == "explicit" and r["mode"] == EXPRESSIVE_MODE_V3


def _verify_legacy_v2(raw, expected_full_sha256):
    """오늘과 바이트 동일한 v2 경로(변경 금지).

    - Python 파싱 실패 → 그 구조화 오류(UNKNOWN_TTS_TAG/INVALID_PAUSE_TAG/EMPTY_EMOTION_SEGMENT ...) 그대로.
    - 파싱 성공인데 renderer full sha256과 불일치 → [{"code":"PARSER_PARITY_MISMATCH"}].
    - expected가 비어 있으면(구버전/미전달) parity를 강제하지 않고 파싱 유효성만 확인.
    """
    res = _tg.parse_tts_script(raw or "")
    if not res.get("ok"):
        return list(res.get("errors", []))
    if expected_full_sha256:
        if res["plan"]["full_sha256"] != expected_full_sha256:
            return [{"code": PARSER_PARITY_MISMATCH}]
    return []


def _verify_expressive_v3(raw, expected_full_sha256):
    """v3 경로 — parity 권위는 expressive timeline의 full_sha256.

    - v3 파싱 실패 → 그 구조화 진단(UNKNOWN_EXPRESSIVE_TAG/INVALID_EXPRESSIVE_PAUSE/... ) 그대로.
    - 파싱 성공인데 renderer full sha256과 불일치 → EXPRESSIVE_PARITY_MISMATCH(v2와 구분되는 코드).
    - expected가 비어 있으면 v2와 같은 규칙 — parity 미강제, 유효성만 확인(우회 아님).
    """
    res = _ex.parse_expressive_timeline(raw or "", EXPRESSIVE_MODE_V3)
    if not res.get("ok"):
        return list(res.get("errors", []))
    if expected_full_sha256:
        if res["timeline"]["full_sha256"] != expected_full_sha256:
            return [{"code": EXPRESSIVE_PARITY_MISMATCH, "mode": EXPRESSIVE_MODE_V3}]
    return []


def verify_parity(raw, expected_full_sha256, expressive_mode=None):
    """반환: [] 통과 / [error dict, ...] 실패(모델 로딩 전 차단용).

    expressive_mode = config의 ttsExpressiveMode 원시값(부재면 None). 인자를 주지 않으면 legacy_v2 —
    즉 기존 2-인자 호출자는 오늘과 완전히 동일하게 동작한다.

    순서가 중요하다: 모드 유효성을 '파싱보다 먼저' 본다. 오타난 플래그를 들고 v2로 파싱해
    통과시켜 버리면, 사용자는 v3를 요청했는데 v2 결과를 받고도 아무 신호를 못 받는다.
    """
    res = _ex.resolve_expressive_mode(expressive_mode)
    if not res["valid"]:
        # 값 자체는 담지 않는다(비민감 payload 규칙) — 계약 code 와 타입만.
        return [{"code": EXPRESSIVE_MODE_INVALID, "raw_type": res["raw_type"]}]
    if res["mode"] == EXPRESSIVE_MODE_V3:
        return _verify_expressive_v3(raw, expected_full_sha256)
    return _verify_legacy_v2(raw, expected_full_sha256)
