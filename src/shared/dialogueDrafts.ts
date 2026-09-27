/**
 * 대화 교정 문서의 **보관** — 파일별로 따로 둔다.
 *
 * ★예전에는 `dialogueEdits` **한 칸**에 하나만 담았다. 그래서 다른 파일을 교정하면
 *   앞 파일의 교정이 말없이 덮였다(2026-09-27 조사). 이제 원본별로 나눠 담는다.
 * ★옛 한 칸의 기록은 **버리지 않는다** — 같은 모양으로 옮겨 담는다(`migrateLegacy`).
 *   옮긴 뒤에도 옛 칸은 지우지 않는다(되돌아갈 자리를 남긴다).
 */
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(이 저장소의 관례).
import { emptyDraft, type DialogueDraft, type SegmentEdit } from './dialogueWorkspace.ts'

export const DIALOGUE_DRAFTS_STORAGE_KEY = 'dialogueDrafts'
/** 옛 한 칸. 읽기만 한다. */
export const LEGACY_DIALOGUE_KEY = 'dialogueEdits'

/** 몇 개까지 들고 있을까 — 넘으면 오래 손대지 않은 것부터 버린다. */
export const DRAFT_LIMIT = 20

export interface DraftStore {
  version: 1
  drafts: Record<string, DialogueDraft>
}

export const emptyStore = (): DraftStore => ({ version: 1, drafts: {} })

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function parseEdits(raw: unknown): Record<number, SegmentEdit> {
  const out: Record<number, SegmentEdit> = {}
  if (!isRec(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    const i = Number(k)
    if (!Number.isInteger(i) || i < 0) continue
    if (!isRec(v)) continue
    const e: SegmentEdit = {}
    if (typeof v.start === 'number') e.start = v.start
    if (typeof v.end === 'number') e.end = v.end
    if (typeof v.speaker === 'string') e.speaker = v.speaker
    if (Object.keys(e).length) out[i] = e
  }
  return out
}

function parseStrMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isRec(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
  return out
}

/** 저장본 한 장. 모양이 어긋나면 **지어내지 않고** null. */
export function parseDraft(raw: unknown): DialogueDraft | null {
  if (!isRec(raw) || typeof raw.sourceKey !== 'string' || !raw.sourceKey) return null
  const d = emptyDraft(raw.sourceKey, typeof raw.runId === 'string' ? raw.runId : '')
  d.names = parseStrMap(raw.names)
  d.merges = parseStrMap(raw.merges)
  d.edits = parseEdits(raw.edits)
  d.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  if (isRec(raw.fromLegacy) && typeof raw.fromLegacy.segmentCount === 'number') {
    d.fromLegacy = { segmentCount: raw.fromLegacy.segmentCount }
  }
  return d
}

export function parseStore(raw: unknown): DraftStore {
  if (!isRec(raw) || !isRec(raw.drafts)) return emptyStore()
  const drafts: Record<string, DialogueDraft> = {}
  for (const [key, v] of Object.entries(raw.drafts)) {
    const d = parseDraft(v)
    // 열쇠와 문서가 서로 다른 원본을 가리키면 버린다 — 섞인 기록을 되살리지 않는다.
    if (d && d.sourceKey === key) drafts[key] = d
  }
  return { version: 1, drafts }
}

/** 손대지 않은 교정인가 — 비어 있으면 굳이 저장하지 않는다. */
export function isBlankDraft(d: DialogueDraft): boolean {
  return !Object.keys(d.names).length && !Object.keys(d.merges).length && !Object.keys(d.edits).length
}

/**
 * 한 장을 넣는다. 넘치면 **가장 오래 손대지 않은 것**부터 버린다.
 *
 * 빈 문서는 넣지 않고, 이미 있으면 지운다 — 교정을 전부 되돌린 자리에 껍데기를 남기지 않는다.
 */
export function putDraft(store: DraftStore, draft: DialogueDraft, limit = DRAFT_LIMIT): DraftStore {
  const drafts = { ...store.drafts }
  if (isBlankDraft(draft)) {
    delete drafts[draft.sourceKey]
    return { version: 1, drafts }
  }
  drafts[draft.sourceKey] = draft
  const keys = Object.keys(drafts)
  if (keys.length > limit) {
    keys.sort((a, b) => (drafts[a].updatedAt || 0) - (drafts[b].updatedAt || 0))
    for (const k of keys.slice(0, keys.length - limit)) delete drafts[k]
  }
  return { version: 1, drafts }
}

export function draftFor(store: DraftStore, sourceKey: string): DialogueDraft | null {
  return (sourceKey && store.drafts[sourceKey]) || null
}

/**
 * 옛 한 칸(`dialogueEdits`)을 옮겨 담는다 — **덮어쓰지 않는다.**
 *
 * 이미 그 원본의 새 문서가 있으면 그대로 둔다(새 것이 권위다).
 * 옛 기록에는 실행 식별자가 없으므로 **구간 수**를 함께 적어 두고, 그 수가 맞을 때만
 * 이어 쓴다(`draftMatches`). 다시 분석해서 구간 수가 달라지면 되살리지 않는다.
 */
export function migrateLegacy(store: DraftStore, legacyRaw: unknown): DraftStore {
  if (!isRec(legacyRaw) || typeof legacyRaw.sourcePath !== 'string' || !legacyRaw.sourcePath) return store
  const key = legacyRaw.sourcePath
  if (store.drafts[key]) return store
  const edits = parseEdits(legacyRaw.edits)
  if (!Object.keys(edits).length) return store
  const segs = Array.isArray(legacyRaw.segments) ? legacyRaw.segments.length : 0
  if (!segs) return store
  const d = emptyDraft(key, '')
  d.edits = edits
  d.updatedAt = typeof legacyRaw.updatedAt === 'number' ? legacyRaw.updatedAt : 0
  d.fromLegacy = { segmentCount: segs }
  return { version: 1, drafts: { ...store.drafts, [key]: d } }
}
