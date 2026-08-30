/**
 * 입력 분석 IPC 계약 — Python `input_analysis.py` 의 스키마를 그대로 옮긴 것.
 *
 * 세 축을 섞지 않는다.
 *   sourceParagraphs  사용자가 Enter 로 만든 문단. 화면에서 "문단" 은 이것 하나뿐이다.
 *   segments          parser 가 만든 **대사 구간**. 감정 태그·명시적 쉼도 구간을 만든다.
 *   chunks            실제 model call 계획(= 생성 묶음).
 *
 * 모든 offset 은 **사용자가 입력한 원문 좌표**다(정규화 좌표가 아니다). 응답에는 대사 원문이
 * 들어가지 않는다 — renderer 는 offset 으로 자기 textarea 값에서 잘라 쓴다.
 */

export const ANALYSIS_CHANNEL = 'analysis:analyze'
export const ANALYSIS_CANCEL_CHANNEL = 'analysis:cancel'
/** 사용자 텍스트 없이 tokenizer 만 데운다. 실패해도 이후 분석을 막지 않는다. */
export const ANALYSIS_PREWARM_CHANNEL = 'analysis:prewarm'

/** Python `input_analysis.SCHEMA_VERSION` 과 같아야 한다. 다르면 renderer 가 결과를 버린다. */
export const ANALYSIS_SCHEMA_VERSION = 4

export type AnalysisConfidence = 'measured' | 'extrapolated' | 'insufficient_data'

export type SplitReason =
  | 'user_paragraph' | 'sentence_end' | 'clause' | 'forced_character' | 'end_of_input'

export interface Range { min: number; max: number }

export interface SourceParagraph {
  index: number
  lineIndex: number | null
  sourceStart: number
  sourceEnd: number
  chars: number
  blankLinesBefore: number
}

export interface AnalysisSegment {
  index: number
  sourceParagraphIndex: number | null
  lineIndex: number | null
  sourceStart: number
  sourceEnd: number
  chars: number
  sentenceCount: number
  emotionId: string | null
  boundaryKind: string | null
  productionTokens: number
  plannedCalls: number
  autoSplit: boolean
  estimatedAudioSeconds: Range
  /**
   * 이 문단 **하나 때문에 더 걸리는** 시간. 전체 작업 시간이 아니다.
   *
   * 모델 준비 비용은 대사 길이와 무관하게 작업당 한 번만 든다. 문단마다 그것을 다시
   * 세면 문단 줄의 합이 요약의 전체 시간보다 커져 화면의 숫자가 서로 어긋난다.
   * 준비 비용은 요약 한 줄이 한 번 포함한다.
   */
  estimatedWallSecondsMarginal: Range | null
}

export interface AnalysisChunk {
  globalIndex: number
  sourceParagraphIndex: number | null
  segmentIndex: number
  localChunkIndex: number
  sourceStart: number
  sourceEnd: number
  sourceOffsetsExact: boolean
  chars: number
  productionTokens: number
  combinedPromptTokens: number
  generationTier: number | null
  fitsBudget: boolean
  boundaryKind: string | null
  splitReason: SplitReason
  estimatedAudioSeconds: Range
}

export interface AnalysisResult {
  schemaVersion: number
  requestId: string
  /** 사용자가 입력한 원문 그대로의 SHA. stale 판정은 이 값으로 한다. */
  sourceSha256: string
  /** 파서가 실제로 본 문자열(줄 끝 정규화본)의 SHA. */
  normalizedSha256: string
  tokenizer: 'production' | 'approximate'
  characterCount: number
  sourceParagraphCount: number
  segmentCount: number
  productionTokens: number
  plannedCalls: number
  splitCapProductionTokens: number
  estimatedAudioSeconds: Range
  estimatedWallSeconds: Range | null
  /** 위 작업 시간에 들어 있는 고정 모델 준비 비용. */
  preparationSeconds: Range | null
  confidence: AnalysisConfidence
  confidenceReason: string
  mode: string
  warnings: string[]
  sourceParagraphs: SourceParagraph[]
  segments: AnalysisSegment[]
  chunks: AnalysisChunk[]
}

export type AnalysisFailureCode =
  | 'WORKER_UNAVAILABLE' | 'WORKER_TIMEOUT' | 'SCHEMA_MISMATCH' | 'SUPERSEDED'
  | 'SOURCE_SHA_MISMATCH' | 'ANALYSIS_FAILED' | 'CANCELLED'

export interface AnalysisFailure {
  ok: false
  requestId: string
  code: AnalysisFailureCode
  /** 비민감 사유만. 대사 원문·경로를 담지 않는다. */
  reason?: string
}

export interface AnalysisSuccess {
  ok: true
  requestId: string
  result: AnalysisResult
}

export type AnalysisResponse = AnalysisSuccess | AnalysisFailure

export interface AnalysisRequest {
  requestId: string
  text: string
  /** 실제 production 에 영향을 주는 설정만 보낸다. */
  mode?: string
  referenceConditioningMode?: string
}

/** snake_case(Python) → camelCase(TS). 모르는 키는 버리고 없는 값은 만들지 않는다. */
export function toAnalysisResult(
  requestId: string, raw: Record<string, unknown>
): AnalysisResult | null {
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const range = (v: unknown): Range =>
    ({ min: num((v as Range | undefined)?.min), max: num((v as Range | undefined)?.max) })
  const rangeOrNull = (v: unknown): Range | null =>
    (v && typeof v === 'object' ? range(v) : null)
  const idxOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null)
  if (num(raw.schema_version, -1) !== ANALYSIS_SCHEMA_VERSION) return null
  const paras = Array.isArray(raw.source_paragraphs) ? raw.source_paragraphs : []
  const segs = Array.isArray(raw.segments) ? raw.segments : []
  const chunks = Array.isArray(raw.chunks) ? raw.chunks : []
  return {
    schemaVersion: num(raw.schema_version),
    requestId,
    sourceSha256: String(raw.source_sha256 ?? ''),
    normalizedSha256: String(raw.normalized_sha256 ?? ''),
    tokenizer: raw.tokenizer === 'production' ? 'production' : 'approximate',
    characterCount: num(raw.character_count),
    sourceParagraphCount: num(raw.source_paragraph_count),
    segmentCount: num(raw.segment_count),
    productionTokens: num(raw.production_tokens),
    plannedCalls: num(raw.planned_calls),
    splitCapProductionTokens: num(raw.split_cap_production_tokens),
    estimatedAudioSeconds: range(raw.estimated_audio_seconds),
    estimatedWallSeconds: rangeOrNull(raw.estimated_wall_seconds),
    preparationSeconds: rangeOrNull(raw.preparation_seconds),
    confidence: (raw.confidence as AnalysisConfidence) ?? 'insufficient_data',
    confidenceReason: String(raw.confidence_reason ?? ''),
    mode: String(raw.mode ?? ''),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
    sourceParagraphs: paras.map((p: Record<string, unknown>) => ({
      index: num(p.index),
      lineIndex: idxOrNull(p.line_index),
      sourceStart: num(p.source_start),
      sourceEnd: num(p.source_end),
      chars: num(p.chars),
      blankLinesBefore: num(p.blank_lines_before),
    })),
    segments: segs.map((s: Record<string, unknown>) => ({
      index: num(s.index),
      sourceParagraphIndex: idxOrNull(s.source_paragraph_index),
      lineIndex: idxOrNull(s.line_index),
      sourceStart: num(s.source_start),
      sourceEnd: num(s.source_end),
      chars: num(s.chars),
      sentenceCount: num(s.sentence_count),
      emotionId: strOrNull(s.emotion_id),
      boundaryKind: strOrNull(s.boundary_kind),
      productionTokens: num(s.production_tokens),
      plannedCalls: num(s.planned_calls),
      autoSplit: Boolean(s.auto_split),
      estimatedAudioSeconds: range(s.estimated_audio_seconds),
      estimatedWallSecondsMarginal: rangeOrNull(s.estimated_wall_seconds_marginal),
    })),
    chunks: chunks.map((c: Record<string, unknown>) => ({
      globalIndex: num(c.global_index),
      sourceParagraphIndex: idxOrNull(c.source_paragraph_index),
      segmentIndex: num(c.segment_index),
      localChunkIndex: num(c.local_chunk_index),
      sourceStart: num(c.source_start),
      sourceEnd: num(c.source_end),
      sourceOffsetsExact: Boolean(c.source_offsets_exact),
      chars: num(c.chars),
      productionTokens: num(c.production_tokens),
      combinedPromptTokens: num(c.combined_prompt_tokens),
      generationTier: idxOrNull(c.generation_tier),
      fitsBudget: Boolean(c.fits_budget),
      boundaryKind: strOrNull(c.boundary_kind),
      splitReason: (c.split_reason as SplitReason) ?? 'end_of_input',
      estimatedAudioSeconds: range(c.estimated_audio_seconds),
    })),
  }
}

/**
 * 응답 신원 검증 — **SHA 검증을 건너뛰지 않는다.**
 *
 * 원문 SHA 의 권위는 main 에 있다. main 은 자기가 보낸 본문으로 SHA 를 다시 계산해 worker
 * 응답과 대조하고, 어긋나면 SOURCE_SHA_MISMATCH 로 바꿔 돌려준다. 따라서 성공 응답이 왔다는
 * 것 자체가 "이 요청이 실어 보낸 본문과 같은 입력의 결과" 라는 뜻이다. renderer 는 그 사슬을
 * requestId 로 잇고, 자기 쪽에서 SHA 를 구할 수 있으면 한 번 더 대조한다 — 동기 SHA 구현을
 * 새로 중복 작성하지 않고 이미 있는 권위를 쓴다.
 *
 * expectedSourceSha 가 null 이면 renderer 가 SHA 를 계산할 수 없는 환경이라는 뜻이고,
 * 그때도 검증이 사라지는 것이 아니라 main 의 대조에 의존한다.
 */
export function verifyResponseIdentity(
  res: AnalysisResponse, expectedRequestId: string, expectedSourceSha: string | null
): res is AnalysisSuccess {
  if (!res.ok) return false
  if (res.requestId !== expectedRequestId) return false
  if (!res.result.sourceSha256) return false        // 신원 없는 결과는 쓰지 않는다
  if (expectedSourceSha === null) return true       // main 이 이미 대조했다
  return res.result.sourceSha256 === expectedSourceSha
}

/** 이 응답을 renderer 상태에 반영해도 되는가 — 늦게 온 결과를 지우는 단일 판정. */
export function isCurrentResponse(
  res: AnalysisResponse, expectedRequestId: string, expectedSourceSha: string
): res is AnalysisSuccess {
  if (!res.ok) return false
  if (res.requestId !== expectedRequestId) return false
  return res.result.sourceSha256 === expectedSourceSha
}
