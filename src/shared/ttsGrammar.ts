// TTS 감정/쉼 문법 공용 계약 타입 (S1 scaffold). 공용 마감 표현 사이클 D 계약 기반.
// ⚠️ 이 파일은 '타입·계약 상수'만 정의한다. 실제 parser 구현·태그 삽입·overlay·runtime config 배선·합성 경로 변경은
//    포함하지 않는다(그건 Agent A/B 구현 단계). parser_version=2(legacy 단일 태그=암묵적 v1과 구분).

export const TTS_PARSER_VERSION = 2 as const

// 구조화 오류 코드(문자열 prefix 추론 금지 — renderer/Python 공용 집합). 대사 전문·오디오 바이트는 payload에 넣지 않는다.
export const TTS_GRAMMAR_ERROR_CODES = [
  'UNKNOWN_TTS_TAG',        // control-tag 형식이나 알려진 감정/쉼이 아님 → 합성 차단(조용한 default 금지)
  'INVALID_PAUSE_TAG',      // [쉼 N] 범위(0.05~5.0s)·형식 위반·인접 중복 → 합성 차단(조용한 clamp 금지)
  'EMPTY_EMOTION_SEGMENT',  // spoken text 없는 감정 구간(연속 태그 등) → 합성 차단
  'PARSER_PARITY_MISMATCH', // renderer full sha256 ≠ Python 재파싱 → 모델 로딩 전 차단
  'INVALID_TTS_CONFIG',     // config 값 범위 밖(Python 권위 검증, 조용한 clamp 금지)
] as const
export type TtsGrammarErrorCode = typeof TTS_GRAMMAR_ERROR_CODES[number]

// 오류 payload(비민감): 코드 + 위치/식별자만. 대사 전문 금지.
export interface TtsGrammarError {
  code: TtsGrammarErrorCode
  /** control-tag id 또는 raw 이름(감정/쉼 식별용). 대사 전문 아님. */
  tag?: string
  /** 잘못된 pause 인자 원문(형식 오류 표시용). */
  arg?: string
  /** 세부 사유(예: 'adjacent_duplicate'). */
  reason?: string
  /** UI selection 정합용 UTF-16 code-unit offset. */
  uiOffsetUtf16?: number
}

// D-7 dual offset(혼용 금지): UI용 UTF-16 code-unit, 텍스트/Python용 Unicode code-point.
export interface DualOffset {
  uiStartUtf16: number
  uiEndUtf16: number
  textStartCodepoint: number
  textEndCodepoint: number
}

// 경계 타입(추가 계약 3 우선순위: explicitPause > lineSilenceGap > emotionBoundaryPause > internal). 합산하지 않고 하나만.
export type TransitionBoundaryType =
  | 'explicitPause'        // [쉼 N] — 자동 gap을 대체(합산 아님)
  | 'lineSilenceGap'       // 원 줄바꿈 경계의 silence_gap
  | 'emotionBoundaryPause' // 감정 변경 경계(immediate|pause 모드의 pause)
  | 'internal'             // 자동분할 내부 경계(gap 0)

export interface PauseBoundary {
  /** 정수 milliseconds(D-7: float 금지). */
  pauseMs: number
  boundaryType: TransitionBoundaryType
  offset: DualOffset
}

// 파싱된 감정 구간(태그 ~ 다음 태그/줄 끝). spoken_text는 control token 제거 후 실제 발화 텍스트.
export interface ParsedEmotionSegment {
  originalLineIndex: number
  /** null = 선두 감정 태그 없음(기본 참조가 담당; used에 포함되지 않음). */
  emotionId: string | null
  spokenText: string
  offset: DualOffset
  /** 이 구간에 종속된 명시적 쉼(경계). */
  pauses: PauseBoundary[]
}

// full internal hash(무결성 비교용) vs metadata 표시용 sha8을 타입으로 구분(혼용 방지).
export type ParsedPlanFullSha256 = string & { readonly __brand: 'ParsedPlanFullSha256' } // 64 hex, 내부 parity 비교 전용
export type ParsedPlanSha8 = string & { readonly __brand: 'ParsedPlanSha8' }             // 8 hex, metadata/GUI 표시 전용

// 파싱 결과 요약(대사 전문 미포함 — metadata/parity용). hash 입력은 D-7 정의를 따른다.
export interface ParsedPlanSummary {
  parserVersion: typeof TTS_PARSER_VERSION
  segmentCount: number
  chunkCount: number
  explicitPauseCount: number
  totalPauseMs: number
  usedEmotionIds: string[]
  /** metadata/GUI 표시용(8 hex). */
  planSha8: ParsedPlanSha8
}

// 전체 파싱 결과(renderer preview + Python 합성 권위 양측 공통 shape). renderer는 preview, 합성 권위는 Python.
export interface ParsedPlan {
  parserVersion: typeof TTS_PARSER_VERSION
  segments: ParsedEmotionSegment[]
  summary: ParsedPlanSummary
  /** 내부 parity 비교 전용 full sha256(config로만 전달, metadata엔 sha8만). */
  fullSha256: ParsedPlanFullSha256
}
