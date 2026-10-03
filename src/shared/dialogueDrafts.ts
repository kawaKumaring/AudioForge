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
import {
  basisOfSegments, emptyDraft, type DialogueDraft, type DraftBasis, type SegmentEdit,
} from './dialogueWorkspace.ts'

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
  const b = raw.basis
  if (isRec(b) && typeof b.segmentCount === 'number' && typeof b.timesHash === 'string') {
    d.basis = {
      segmentCount: b.segmentCount,
      timesHash: b.timesHash,
      speakers: Array.isArray(b.speakers) ? b.speakers.filter((x): x is string => typeof x === 'string') : [],
    }
  }
  return d
}

/**
 * 보관함을 읽는다. **옛 열쇠 형식도 잃지 않는다.**
 *
 * ★예전에는 원본 경로 하나를 열쇠로 썼다. 열쇠 규칙을 원본+실행으로 바꾸면서
 *   그 문서들이 '열쇠가 안 맞는다' 는 이유로 **통째로 사라졌다**(1건 → 0건, 재현 확인).
 *   이제 옛 열쇠면 새 열쇠로 **옮겨 담고**, 옮길 자리가 이미 차 있으면
 *   **원래 열쇠에 그대로 둔다** — 어느 경우에도 원본 기록을 덮거나 버리지 않는다.
 */
export function parseStore(raw: unknown): DraftStore {
  if (!isRec(raw) || !isRec(raw.drafts)) return emptyStore()
  const drafts: Record<string, DialogueDraft> = {}
  const later: [string, DialogueDraft][] = []
  for (const [key, v] of Object.entries(raw.drafts)) {
    const d = parseDraft(v)
    if (!d) continue                                  // 모양이 깨진 것은 되살릴 수 없다
    const want = draftKey(d.sourceKey, d.runId)
    if (key === want) { drafts[key] = d; continue }   // 지금 형식
    if (key === d.sourceKey) { later.push([want, d]); continue }  // 옛 형식 — 뒤에 옮긴다
    // 열쇠와 문서가 서로 다른 것을 가리킨다 — 섞인 기록은 되살리지 않는다.
  }
  for (const [want, d] of later) {
    // 새 자리가 비어 있을 때만 옮긴다. 차 있으면 옛 자리에 그대로 둬 잃지 않는다.
    if (!drafts[want]) drafts[want] = d
    else if (!drafts[d.sourceKey]) drafts[d.sourceKey] = d
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
  // 옛 칸에도 그때의 구간이 남아 있다 — 지문을 만들어 두면 번호로 옮겨도 되는지 확인할 수 있다.
  d.basis = basisOfSegments((legacyRaw.segments as unknown[]).map((x) => {
    const o = (x || {}) as Record<string, unknown>
    return {
      start: typeof o.start === 'number' ? o.start : 0,
      end: typeof o.end === 'number' ? o.end : 0,
      speaker: typeof o.speaker === 'string' ? o.speaker : '',
    }
  }))
  return { version: 1, drafts: { ...store.drafts, [key]: d } }
}
