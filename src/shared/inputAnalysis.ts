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

/** Python `input_analysis.SCHEMA_VERSION` 과 같아야 한다. 다르면 renderer 가 결과를 버린다. */
export const ANALYSIS_SCHEMA_VERSION = 3

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
  estimatedWallSeconds: Range | null
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
      estimatedWallSeconds: rangeOrNull(s.estimated_wall_seconds),
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

/** 이 응답을 renderer 상태에 반영해도 되는가 — 늦게 온 결과를 지우는 단일 판정. */
export function isCurrentResponse(
  res: AnalysisResponse, expectedRequestId: string, expectedSourceSha: string
): res is AnalysisSuccess {
  if (!res.ok) return false
  if (res.requestId !== expectedRequestId) return false
  return res.result.sourceSha256 === expectedSourceSha
}
