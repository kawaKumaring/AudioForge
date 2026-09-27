/**
 * 대화 교정 문서의 **보관** — 파일별로 따로 둔다.
 *
 * ★예전에는 `dialogueEdits` **한 칸**에 하나만 담았다. 그래서 다른 파일을 교정하면
 *   앞 파일의 교정이 말없이 덮였다(2026-09-27 조사). 이제 **원본별·실행별**로 나눠 담는다.
 * ★**자동으로 지우지 않는다.** 같은 원본을 다시 분석해도 앞 실행의 교정은 그대로 남는다
 *   (다시 손댈 수 있게). 다만 **다른 실행에 저절로 적용하지는 않는다** — 구간 배열이
 *   달라졌을 수 있으므로 번호로 매긴 수정을 옮기면 엉뚱한 곳이 바뀐다.
 *   개수 제한은 **목록으로 보여 줄 때만** 쓴다(`recentDrafts`).
 * ★옛 한 칸의 기록은 **버리지 않는다** — 같은 모양으로 옮겨 담는다(`migrateLegacy`).
 *   옮긴 뒤에도 옛 칸은 지우지 않는다(되돌아갈 자리를 남긴다).
 */
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(이 저장소의 관례).
import { emptyDraft, type DialogueDraft, type SegmentEdit } from './dialogueWorkspace.ts'

export const DIALOGUE_DRAFTS_STORAGE_KEY = 'dialogueDrafts'
/** 옛 한 칸. 읽기만 한다. */
export const LEGACY_DIALOGUE_KEY = 'dialogueEdits'

/** **목록에 몇 개까지 보여 줄까.** 보관 개수 제한이 아니다 — 저장본은 지우지 않는다. */
export const DRAFT_LIST_LIMIT = 20

/** 보관 열쇠 — 같은 원본이라도 **실행이 다르면 다른 칸**이다. */
export function draftKey(sourceKey: string, runId: string): string {
  return runId ? `${sourceKey}${String.fromCharCode(31)}${runId}` : sourceKey
}

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
    // 열쇠와 문서가 서로 다른 것을 가리키면 버린다 — 섞인 기록을 되살리지 않는다.
    if (d && draftKey(d.sourceKey, d.runId) === key) drafts[key] = d
  }
  return { version: 1, drafts }
}

/** 손대지 않은 교정인가 — 비어 있으면 굳이 저장하지 않는다. */
export function isBlankDraft(d: DialogueDraft): boolean {
  return !Object.keys(d.names).length && !Object.keys(d.merges).length && !Object.keys(d.edits).length
}

/**
 * 한 장을 넣는다. **개수 때문에 남의 교정을 지우지 않는다.**
 *
 * 빈 문서는 그 칸만 지운다 — 사용자가 전부 되돌린 자리에 껍데기를 남기지 않는다.
 * (이것은 그 사용자가 한 일이므로 '자동 삭제' 가 아니다.)
 */
export function putDraft(store: DraftStore, draft: DialogueDraft): DraftStore {
  const key = draftKey(draft.sourceKey, draft.runId)
  const drafts = { ...store.drafts }
  if (isBlankDraft(draft)) delete drafts[key]
  else drafts[key] = draft
  return { version: 1, drafts }
}

/**
 * 이 원본·이 실행의 교정. 없으면 **실행 식별자가 없는 옛 기록**을 본다.
 *
 * ★다른 실행의 교정을 대신 돌려주지 않는다. 구간 배열이 달라졌을 수 있다.
 */
export function draftFor(store: DraftStore, sourceKey: string, runId = ''): DialogueDraft | null {
  if (!sourceKey) return null
  return store.drafts[draftKey(sourceKey, runId)] || store.drafts[sourceKey] || null
}

/** 이 원본에 남아 있는 교정 전부 — 최근에 손댄 순서. 화면이 '이전 교정' 을 보여 줄 때 쓴다. */
export function draftsOfSource(store: DraftStore, sourceKey: string): DialogueDraft[] {
  return Object.values(store.drafts)
    .filter((d) => d.sourceKey === sourceKey)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** **목록에 보여 줄** 최근 것들. 저장본을 줄이지 않는다. */
export function recentDrafts(store: DraftStore, limit = DRAFT_LIST_LIMIT): DialogueDraft[] {
  return Object.values(store.drafts)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
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
