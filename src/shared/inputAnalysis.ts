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
 *
 * `plan` 은 `script_plan` 이 만든 **공용 계획**이고 새 화면은 그것만 본다(발화·감정 구간·
 * 쉼·문장 경계·생성 묶음·사전 경고가 한 곳에 있다). 위의 세 배열은 기존 소비자를 위한
 * 별칭으로 남는다 — `plan.utterances[i]` 와 `segments[i]` 는 같은 행이고(구조 대 추정치)
 * 색인으로 이어진다.
 */

export const ANALYSIS_CHANNEL = 'analysis:analyze'
export const ANALYSIS_CANCEL_CHANNEL = 'analysis:cancel'
/** 사용자 텍스트 없이 tokenizer 만 데운다. 실패해도 이후 분석을 막지 않는다. */
export const ANALYSIS_PREWARM_CHANNEL = 'analysis:prewarm'

/** Python `input_analysis.SCHEMA_VERSION` 과 같아야 한다. 다르면 renderer 가 결과를 버린다. */
export const ANALYSIS_SCHEMA_VERSION = 6

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
  /** 이 발화의 화자(내부 stable id). null = 기본 화자. */
  speakerId: string | null
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
  /**
   * 이 묶음이 누구의 말인가. chunk 가 갈려도 화자 연결을 잃지 않는다 —
   * 생성 단계가 대본을 다시 해석하지 않고 이 값을 그대로 쓴다(배선은 v1.4 PHASE 3).
   */
  speakerId: string | null
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

// ─────────────────────────────────────────────────────────────────────────────
// 공용 Script Plan 계약 — Python `python/script_plan.py` 의 거울.
//
// 왜 여기 있나: plan 은 이 응답의 일부이고, snake_case → camelCase 매핑은 이 파일 하나가
// 맡는다. 매핑이 두 곳에 있으면 언젠가 갈라진다.
// 같은 구조를 만드는 TS 빌더와 parity 검사는 `scriptPlan.parity.test.ts` 에 있다 —
// 앱은 빌더가 필요 없다(생성 권위는 Python 이고 화면은 그 계획을 보여 줄 뿐이다).
// ─────────────────────────────────────────────────────────────────────────────

/** Python `script_plan.PLAN_SCHEMA_VERSION` 과 같아야 한다. */
export const PLAN_SCHEMA_VERSION = 2

export const WARN_UNCLOSED_TAG = 'UNCLOSED_TAG'
export const WARN_UNKNOWN_DIRECTIVE = 'UNKNOWN_DIRECTIVE'
export const WARN_EMPTY_UTTERANCE = 'EMPTY_UTTERANCE'
export const WARN_CONFLICTING_DIRECTIVES = 'CONFLICTING_DIRECTIVES'
export const WARN_DIRECTIVE_ONLY_PARAGRAPH = 'DIRECTIVE_ONLY_PARAGRAPH'
export const WARN_INVALID_SPEAKER = 'INVALID_SPEAKER'
export const WARN_SPEAKER_LABEL_VARIANT = 'SPEAKER_LABEL_VARIANT'

/**
 * 사전 경고 코드(비민감 enum). 문구는 renderer 가 붙인다.
 * 경고는 **합성을 막지 않고 원문을 고치지도 않는다.** 알려 주는 것이 전부다.
 */
export const PLAN_WARNING_CODES = [
  WARN_UNCLOSED_TAG,
  WARN_UNKNOWN_DIRECTIVE,
  WARN_EMPTY_UTTERANCE,
  WARN_CONFLICTING_DIRECTIVES,
  WARN_DIRECTIVE_ONLY_PARAGRAPH,
  WARN_INVALID_SPEAKER,
  WARN_SPEAKER_LABEL_VARIANT,
] as const
export type PlanWarningCode = typeof PLAN_WARNING_CODES[number]

/**
 * v1.2.0 문법에 지시가 없는 축. Python 응답에는 **항상 빈 배열**로 들어온다.
 * 이름을 지금 정해 두는 이유는 화면이 "앞으로 여기에 들어온다" 고 말할 근거가 필요하고,
 * 소비자가 없는 축을 스스로 지어내면 안 되기 때문이다.
 */
export const RESERVED_AXES = [
  'prosody', 'actions', 'ambience', 'music', 'spatial',
] as const
export type ReservedAxis = typeof RESERVED_AXES[number]

/** 좌표는 언제나 **사용자가 입력한 원문** 기준이다(정규화 좌표가 아니다). */
export interface PlanSpan {
  /** UI selection 정합용 UTF-16 offset. */
  sourceStart: number
  sourceEnd: number
  /** 텍스트 처리용 code point offset. */
  textStart: number
  textEnd: number
}

export interface PlanParagraph extends PlanSpan {
  index: number
  lineIndex: number | null
  chars: number
  blankLinesBefore: number
}

/**
 * 대본에 등장한 인물. 발화마다 한 줄씩이 아니라 인물 단위다.
 *
 * `speakerId` 는 내부 stable id(정규화), `label` 은 **처음 쓴 표기**다. 화면에는 사용자가
 * 쓴 이름이 보여야 하고 계획·생성·기록은 흔들리지 않는 id 를 써야 한다.
 * 기본 화자(화자 표기 없음 / `[화자 기본]`)는 인물로 등록된 것이 아니라 여기 나오지 않는다.
 */
export interface PlanSpeaker {
  index: number
  speakerId: string
  label: string
  utteranceCount: number
  firstUtteranceIndex: number
  sourceStart: number
}

/** 한 덩어리의 말. 구간은 **자기 지시를 포함한다**(`[기쁨]` 까지). */
export interface PlanUtterance extends PlanSpan {
  index: number
  sourceParagraphIndex: number | null
  lineIndex: number | null
  /** null = 화자 지정 없음(기본 화자). 내부 stable id. */
  speakerId: string | null
  /** 사용자가 쓴 그대로의 표시 이름. id 와 역할이 다르다. */
  speakerLabel: string | null
  emotionId: string | null
  boundaryKind: string | null
  chars: number
  sourceOffsetsExact: boolean
}

export interface PlanEmotionSpan extends PlanSpan {
  index: number
  emotionId: string
  /** 세기는 v1.2.0 문법에 없다. 항상 null. */
  intensity: number | null
  utteranceStart: number
  utteranceEnd: number
}

export interface PlanPause extends PlanSpan {
  index: number
  utteranceIndex: number
  pauseMs: number
  boundaryType: string | null
}

export interface PlanWarning {
  code: PlanWarningCode
  lineIndex: number | null
  sourceStart: number | null
  sourceEnd: number | null
  textStart: number | null
  textEnd: number | null
  /** 비민감 사유(예: 'adjacent_duplicate'). */
  reason: string | null
  /** 해석하지 못한 표기 이름. 대사 원문이 아니다. */
  tag?: string
}

/** 파서 한 번으로 만들어지는 층. TS/Python 이 같은 값을 내야 하는 부분이다. */
export interface ScriptPlanStructure {
  planSchemaVersion: number
  parserVersion: number
  /** 사용자가 입력한 원문 그대로의 SHA. */
  sourceSha256: string
  /** 파서가 실제로 본 문자열(줄 끝 정규화본)의 SHA. */
  normalizedSha256: string
  /** false = 구조화 오류로 원문 줄로 물러났다(좌표는 근사). */
  parserAuthority: boolean
  sourceParagraphs: PlanParagraph[]
  speakers: PlanSpeaker[]
  utterances: PlanUtterance[]
  emotions: PlanEmotionSpan[]
  pauses: PlanPause[]
  warnings: PlanWarning[]
  structureSha256: string
}

/** snake_case(Python) → camelCase(TS). 모르는 키는 버리고 없는 값은 만들지 않는다. */
export function toScriptPlanStructure(raw: unknown): ScriptPlanStructure | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
  if (num(r.plan_schema_version, -1) !== PLAN_SCHEMA_VERSION) return null
  const codes = new Set<string>(PLAN_WARNING_CODES)
  return {
    planSchemaVersion: num(r.plan_schema_version),
    parserVersion: num(r.parser_version),
    sourceSha256: String(r.source_sha256 ?? ''),
    normalizedSha256: String(r.normalized_sha256 ?? ''),
    parserAuthority: Boolean(r.parser_authority),
    speakers: arr(r.speakers).map((k) => ({
      index: num(k.index),
      speakerId: String(k.speaker_id ?? ''),
      label: String(k.label ?? ''),
      utteranceCount: num(k.utterance_count),
      firstUtteranceIndex: num(k.first_utterance_index),
      sourceStart: num(k.source_start),
    })),
    sourceParagraphs: arr(r.source_paragraphs).map((p) => ({
      index: num(p.index),
      lineIndex: numOrNull(p.line_index),
      sourceStart: num(p.source_start),
      sourceEnd: num(p.source_end),
      textStart: num(p.text_start),
      textEnd: num(p.text_end),
      chars: num(p.chars),
      blankLinesBefore: num(p.blank_lines_before),
    })),
    utterances: arr(r.utterances).map((u) => ({
      index: num(u.index),
      sourceParagraphIndex: numOrNull(u.source_paragraph_index),
      lineIndex: numOrNull(u.line_index),
      speakerId: strOrNull(u.speaker_id),
      speakerLabel: strOrNull(u.speaker_label),
      emotionId: strOrNull(u.emotion_id),
      boundaryKind: strOrNull(u.boundary_kind),
      sourceStart: num(u.source_start),
      sourceEnd: num(u.source_end),
      textStart: num(u.text_start),
      textEnd: num(u.text_end),
      chars: num(u.chars),
      sourceOffsetsExact: Boolean(u.source_offsets_exact),
    })),
    emotions: arr(r.emotions).map((e) => ({
      index: num(e.index),
      emotionId: String(e.emotion_id ?? ''),
      intensity: numOrNull(e.intensity),
      utteranceStart: num(e.utterance_start),
      utteranceEnd: num(e.utterance_end),
      sourceStart: num(e.source_start),
      sourceEnd: num(e.source_end),
      textStart: num(e.text_start),
      textEnd: num(e.text_end),
    })),
    pauses: arr(r.pauses).map((p) => ({
      index: num(p.index),
      utteranceIndex: num(p.utterance_index),
      pauseMs: num(p.pause_ms),
      boundaryType: strOrNull(p.boundary_type),
      sourceStart: num(p.source_start),
      sourceEnd: num(p.source_end),
      textStart: num(p.text_start),
      textEnd: num(p.text_end),
    })),
    // 모르는 코드는 버린다 — 화면이 문구를 붙일 수 없는 경고를 표시하지 않는다.
    warnings: arr(r.warnings)
      .filter((w) => typeof w.code === 'string' && codes.has(w.code as string))
      .map((w) => {
        const out: PlanWarning = {
          code: w.code as PlanWarningCode,
          lineIndex: numOrNull(w.line_index),
          sourceStart: numOrNull(w.source_start),
          sourceEnd: numOrNull(w.source_end),
          textStart: numOrNull(w.text_start),
          textEnd: numOrNull(w.text_end),
          reason: strOrNull(w.reason),
        }
        const tag = strOrNull(w.tag)
        if (tag != null) out.tag = tag
        return out
      }),
    structureSha256: String(r.structure_sha256 ?? ''),
  }
}

/**
 * 발화 안의 문장 경계. 문장 나누기는 Python `text_segmenter` 권위라 TS 에서 다시 나누지
 * 않는다 — 그래서 좌표 규칙도 chunk 행과 같다(정확하지 않을 수 있으면 행마다 밝힌다).
 */
export interface PlanSentence {
  index: number
  utteranceIndex: number
  sourceStart: number
  sourceEnd: number
  sourceOffsetsExact: boolean
  chars: number
}

/** 공용 계획 — 구조 층(TS/Python parity) + Python 권위 층(문장 경계·생성 묶음). */
export interface ScriptPlan extends ScriptPlanStructure {
  sentences: PlanSentence[]
  chunks: AnalysisChunk[]
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
  /** 새 화면이 보는 단일 계획. schema v5 부터 항상 있다. */
  plan: ScriptPlan
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
  const toChunk = (c: Record<string, unknown>): AnalysisChunk => ({
    globalIndex: num(c.global_index),
    sourceParagraphIndex: idxOrNull(c.source_paragraph_index),
    speakerId: strOrNull(c.speaker_id),
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
  })
  // plan 이 없거나 버전이 다르면 결과를 쓰지 않는다 — 화면이 반쪽 계획을 보여 주면 안 된다.
  const rawPlan = (raw.plan ?? null) as Record<string, unknown> | null
  const structure = toScriptPlanStructure(rawPlan)
  if (structure === null || rawPlan === null) return null
  const planChunks = Array.isArray(rawPlan.chunks) ? rawPlan.chunks : []
  const planSentences = Array.isArray(rawPlan.sentences) ? rawPlan.sentences : []
  const plan: ScriptPlan = {
    ...structure,
    sentences: (planSentences as Record<string, unknown>[]).map((t) => ({
      index: num(t.index),
      utteranceIndex: num(t.utterance_index),
      sourceStart: num(t.source_start),
      sourceEnd: num(t.source_end),
      sourceOffsetsExact: Boolean(t.source_offsets_exact),
      chars: num(t.chars),
    })),
    chunks: (planChunks as Record<string, unknown>[]).map(toChunk),
  }
  return {
    plan,
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
      speakerId: strOrNull(s.speaker_id),
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
    chunks: chunks.map((c: Record<string, unknown>) => toChunk(c)),
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
