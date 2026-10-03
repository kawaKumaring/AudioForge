/**
 * 텍스트 교정의 **보관** — 파일마다 따로 둔다.
 *
 * ★예전에는 `transcriptEdits` **한 칸**에 하나만 담았다. 다른 파일을 교정하면 앞 파일의
 *   교정이 말없이 덮였다(대화 쪽에서 같은 결함을 재현해 고쳤다 — 여기도 같은 모양이었다).
 * ★**자동으로 지우지 않는다.** 개수 제한은 목록을 보여 줄 때만 쓴다.
 * ★옛 한 칸의 기록은 버리지 않고 옮겨 담는다. 옮긴 뒤에도 옛 칸은 지우지 않는다.
 *
 * 열쇠는 `원본 경로 + 결과 이름(base)` 이다 — 같은 원본을 다시 돌리면 결과 이름이 달라지고,
 * 문장 수가 달라질 수 있으므로 **번호로 매긴 교정을 옮기지 않는다**.
 */
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(이 저장소의 관례).
import { parseTranscriptDoc, type TranscriptDoc } from './transcriptEdit.ts'

export const TRANSCRIPT_DRAFTS_STORAGE_KEY = 'transcriptDrafts'
/** 옛 한 칸. 읽기만 한다. */
export const LEGACY_TRANSCRIPT_KEY = 'transcriptEdits'
/** 목록에 보여 줄 수. 보관 개수 제한이 아니다. */
export const TRANSCRIPT_LIST_LIMIT = 20

export interface TranscriptDraftStore {
  version: 1
  drafts: Record<string, TranscriptDoc>
}

export const emptyTranscriptStore = (): TranscriptDraftStore => ({ version: 1, drafts: {} })

/** 보관 열쇠 — 원본과 결과 이름이 함께여야 같은 것이다. */
export function transcriptKey(sourcePath: string, base: string): string {
  return base ? `${sourcePath}${String.fromCharCode(31)}${base}` : sourcePath
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 보관함을 읽는다. **옛 열쇠 형식(원본 경로만)도 잃지 않는다.**
 *
 * 옮길 자리가 이미 차 있으면 원래 자리에 그대로 둔다 — 덮지도 버리지도 않는다.
 */
export function parseTranscriptStore(raw: unknown): TranscriptDraftStore {
  if (!isRec(raw) || !isRec(raw.drafts)) return emptyTranscriptStore()
  const drafts: Record<string, TranscriptDoc> = {}
  const later: [string, TranscriptDoc][] = []
  for (const [key, v] of Object.entries(raw.drafts)) {
    const d = parseTranscriptDoc(v)
    if (!d) continue
    const want = transcriptKey(d.sourcePath, d.base)
    if (key === want) { drafts[key] = d; continue }
    if (key === d.sourcePath) { later.push([want, d]); continue }
    // 열쇠와 문서가 서로 다른 원본을 가리킨다 — 섞인 기록은 되살리지 않는다.
  }
  for (const [want, d] of later) {
    if (!drafts[want]) drafts[want] = d
    else if (!drafts[d.sourcePath]) drafts[d.sourcePath] = d
  }
  return { version: 1, drafts }
}

export const isBlankTranscriptDoc = (d: TranscriptDoc): boolean => !Object.keys(d.edits).length

/** 한 장을 넣는다. **개수 때문에 남의 교정을 지우지 않는다.** */
export function putTranscriptDoc(store: TranscriptDraftStore, doc: TranscriptDoc): TranscriptDraftStore {
  const key = transcriptKey(doc.sourcePath, doc.base)
  const drafts = { ...store.drafts }
  if (isBlankTranscriptDoc(doc)) delete drafts[key]
  else drafts[key] = doc
  return { version: 1, drafts }
}

/**
 * 이 원본·이 결과의 교정. 없으면 옛 열쇠(원본만)도 본다.
 *
 * ★문장 수가 다르면 돌려주지 않는다 — 번호로 매긴 교정이 엉뚱한 문장에 붙는다.
 */
export function transcriptDocFor(store: TranscriptDraftStore, sourcePath: string,
  base: string, segmentCount: number): TranscriptDoc | null {
  const got = store.drafts[transcriptKey(sourcePath, base)] || store.drafts[sourcePath] || null
  if (!got) return null
  if (got.sourcePath !== sourcePath) return null
  if (got.segments.length !== segmentCount) return null
  return got
}

/** 이 원본에 남아 있는 교정 전부 — 최근 순. */
export function transcriptDocsOfSource(store: TranscriptDraftStore, sourcePath: string): TranscriptDoc[] {
  return Object.values(store.drafts)
    .filter((d) => d.sourcePath === sourcePath)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/** 목록에 보여 줄 최근 것들. 저장본을 줄이지 않는다. */
export function recentTranscriptDocs(store: TranscriptDraftStore,
  limit = TRANSCRIPT_LIST_LIMIT): TranscriptDoc[] {
  return Object.values(store.drafts)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
}

/** 옛 한 칸을 옮겨 담는다 — 이미 새 문서가 있으면 그대로 둔다. */
export function migrateLegacyTranscript(store: TranscriptDraftStore,
  legacyRaw: unknown): TranscriptDraftStore {
  const d = parseTranscriptDoc(legacyRaw)
  if (!d || !Object.keys(d.edits).length) return store
  const key = transcriptKey(d.sourcePath, d.base)
  if (store.drafts[key]) return store
  return { version: 1, drafts: { ...store.drafts, [key]: d } }
}
