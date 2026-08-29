// 감정·표현 고정 대사 fixture 로더(TypeScript 쪽 유일 소비 지점).
//
// 권위는 `python/fixtures/emotion-scripts.v1.json` **파일 하나**다. 이 모듈은 대사 문자열을
// 하나도 갖지 않는다 — 전부 그 JSON 에서 온다. Python 로더(python/emotion_scripts.py)는
// 같은 파일을 읽는다. 생성된 mirror 파일은 존재하지 않는다.
//
// 왜 python/ 아래인가: 이 저장소에서 프로덕션 자산 해석 경로가 실제로 배선된 디렉터리는
// python/ 하나뿐이다(src/main/services/python-runner.ts getScriptPath — dev `<root>/python`,
// prod `<resourcesPath>/python`). src/ 를 프로덕션으로 복사하는 규칙은 존재하지 않으므로
// fixture 를 src/ 아래 두면 Python 이 패키징 환경에서 찾을 수 없다.
//
// 번들러는 이 JSON 을 빌드 시점에 값으로 인라인한다. 따라서 런타임 경로 탐색이 없고,
// 조용한 폴백이 끼어들 자리도 없다 — 파일이 없으면 빌드가 실패한다.
import fixture from '../../python/fixtures/emotion-scripts.v1.json' with { type: 'json' }

export const EMOTION_SCRIPTS_SCHEMA_VERSION = 1

export type EmotionScriptKind = 'preview_short' | 'validation_medium' | 'continuity_long'

export const EMOTION_SCRIPT_KINDS: readonly EmotionScriptKind[] =
  Object.freeze(['preview_short', 'validation_medium', 'continuity_long'])

export interface EmotionScriptBlock {
  text: string
  expected_spoken_text_sha256: string
  expected_parser_events: string[]
  chars: number
}

export interface EmotionScriptEntry {
  emotion_id: string
  label_ko: string
  scenario_id: string
  scenario_description: string
  capability_status_at_authoring: string
  tag_sequence: string[]
  contextual: Record<EmotionScriptKind, EmotionScriptBlock>
  controlled: EmotionScriptBlock
  expected_chunk_policy: string
  notes: string
}

export interface ExpressionScriptRow {
  row_id: string
  expression_kind: string
  token: string
  text: string
  expected_spoken_text_sha256: string
  expected_parser_events: string[]
  expected_timeline_sha256: string
  capability_status_at_authoring: string
}

interface EmotionScriptsDoc {
  schema_version: number
  language: string
  expressive_contract_version: number
  expressive_contract_fingerprint: string
  fixture_fingerprint: string
  controlled_text: string
  emotions: EmotionScriptEntry[]
  expression_fixtures: ExpressionScriptRow[]
}

const DOC = fixture as unknown as EmotionScriptsDoc

if (DOC.schema_version !== EMOTION_SCRIPTS_SCHEMA_VERSION) {
  // 조용히 넘어가면 대사가 바뀐 줄 모르고 옛 캐시를 재사용하게 된다 — 즉시 실패시킨다.
  throw new Error(
    `EMOTION_SCRIPTS_SCHEMA_MISMATCH: ${DOC.schema_version} != ${EMOTION_SCRIPTS_SCHEMA_VERSION}`
  )
}

/** 지문 계산 규칙 — Python `compute_fingerprint` 와 문자 단위로 같아야 한다(parity 테스트가 대조). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const o = value as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** 지문 계산에 들어가는 정규화 페이로드(= fixture_fingerprint 키를 뺀 나머지). */
export function fingerprintPayload(): string {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(DOC as unknown as Record<string, unknown>)) {
    if (k !== 'fixture_fingerprint') rest[k] = v
  }
  return canonicalJson(rest)
}

export function fixtureFingerprint(): string {
  return DOC.fixture_fingerprint
}

export function expressiveContractFingerprint(): string {
  return DOC.expressive_contract_fingerprint
}

export function emotionIds(): readonly string[] {
  return DOC.emotions.map((e) => e.emotion_id)
}

export function emotionEntry(emotionId: string): EmotionScriptEntry {
  const found = DOC.emotions.find((e) => e.emotion_id === emotionId)
  if (!found) throw new Error(`EMOTION_SCRIPTS_UNKNOWN_ID: ${emotionId}`)
  return found
}

/** 상황 대사(감정마다 다름). */
export function contextualText(emotionId: string, kind: EmotionScriptKind): string {
  const e = emotionEntry(emotionId)
  const b = e.contextual[kind]
  if (!b) throw new Error(`EMOTION_SCRIPTS_UNKNOWN_KIND: ${kind}`)
  return b.text
}

/** 통제 대사 — 태그만 다르고 발화문은 모든 감정에서 동일하다. */
export function controlledText(emotionId: string): string {
  return emotionEntry(emotionId).controlled.text
}

/** 태그 없는 통제 발화문 원본. */
export function controlledBaseText(): string {
  return DOC.controlled_text
}

export function expressionRows(): readonly ExpressionScriptRow[] {
  return DOC.expression_fixtures
}

export function expressionText(rowId: string): string {
  const r = DOC.expression_fixtures.find((x) => x.row_id === rowId)
  if (!r) throw new Error(`EMOTION_SCRIPTS_UNKNOWN_ROW: ${rowId}`)
  return r.text
}
