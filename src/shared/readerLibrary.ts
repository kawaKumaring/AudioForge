/**
 * 낭독 서재 — **작품 묶음 · 폴더 가져오기 · 중복/변경 판정**의 규칙 한 곳 (2026-10-03).
 *
 * ★묶음은 따로 만들지 않는다 — 기존 `group`(작품 이름) 하나가 묶음이다. 순서는 `order`, 마지막으로 읽은 때는 `readAt`.
 * ★원본 파일은 읽기만 한다. 옮기거나 고치거나 지우지 않는다. 원본에서 사라져도 서재의 책은 지우지 않는다.
 * ★같은 책 판정(가져올 때):
 *   ① 내용 지문(sha256)이 같은 책이 서재에 있으면 **중복** — 이름이 달라도 같은 책이다.
 *   ② 지문이 없는 예전 책은 예전 규칙(이름 + 본문 전체가 같다).
 *   ③ 같은 원본 자리인데 내용이 바뀌었으면 **변경** — 조용히 덮지 않고 교체/별도 등록을 묻는다.
 *   ★파일 이름만 같다는 이유로 같은 책이라고 보지 않는다.
 * ★교체할 때 읽던 자리: 예전 자리의 문단 글이 새 본문에 **똑같이 있을 때만** 그 문단(예전 자리에서 가장 가까운 것)으로 옮긴다.
 *   없으면 처음(0)으로 하고, 예전 기록(지문·자리·문단 수)은 `history` 에 남긴다 — 같은 번호라고 같은 자리로 단정하지 않는다.
 */

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
/** 자연 정렬 — 1화 → 2화 → 10화. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b)

export interface BookSource {
  /** 원본 파일 자리(가져온 때). */
  path: string
  /** 폴더로 가져왔으면 그 작품 폴더 — '새 파일 확인' 이 다시 훑는 자리. */
  root?: string
  size: number
  mtimeMs: number
  /** 내용 지문(원본 바이트의 sha256). */
  sha256: string
}
export interface BookHistory { at: number; sha256?: string; position: number; paragraphs: number }
export interface LibBook {
  id: string; name: string; paragraphs: string[]; position: number
  addedAt?: number; group?: string
  /** 보관함에 숨긴 책. 원문·읽던 자리·묶음은 유지한다. */
  archived?: boolean
  /** 앱이 보관한 작은 표지 사본. 없으면 기본 책 표지. */
  cover?: string
  completed?: boolean
  /** 묶음 안의 차례(작을수록 앞). 없으면 이름 자연 정렬. */
  order?: number
  /** 마지막으로 열거나 자리를 고른 때 — 묶음 이어 읽기에 쓴다. */
  readAt?: number
  source?: BookSource
  /** 교체 전 기록(최근 것부터 최대 5). */
  history?: BookHistory[]
}

/** 원본 자리 비교 — 윈도우 경로는 대소문자·구분자를 가리지 않는다. */
export const samePath = (a?: string, b?: string): boolean =>
  !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

export type Classified = { kind: 'new' } | { kind: 'duplicate'; id: string } | { kind: 'changed'; id: string }
/** 들어오는 책을 판정한다(위 규칙). */
export function classifyIncoming(inc: { path?: string; sha256: string; name: string; paragraphs: string[] }, books: readonly LibBook[]): Classified {
  const dup = books.find((b) => b.source?.sha256 === inc.sha256)
  if (dup) return { kind: 'duplicate', id: dup.id }
  const legacy = books.find((b) => !b.source && b.name === inc.name && b.paragraphs.length === inc.paragraphs.length && b.paragraphs.every((p, i) => p === inc.paragraphs[i]))
  if (legacy) return { kind: 'duplicate', id: legacy.id }
  const moved = inc.path ? books.find((b) => samePath(b.source?.path, inc.path)) : undefined
  if (moved) return { kind: 'changed', id: moved.id }
  return { kind: 'new' }
}

/** 교체 뒤 읽던 자리 — 예전 문단 글이 새 본문에 그대로 있을 때만 유지(가장 가까운 것). */
export function mapPosition(oldParas: readonly string[], oldPos: number, newParas: readonly string[]): { position: number; kept: boolean } {
  const text = oldParas[oldPos]
  if (text === undefined || oldPos <= 0) return { position: 0, kept: oldPos <= 0 }
  let best = -1
  for (let i = 0; i < newParas.length; i++) if (newParas[i] === text && (best < 0 || Math.abs(i - oldPos) < Math.abs(best - oldPos))) best = i
  return best >= 0 ? { position: best, kept: true } : { position: 0, kept: false }
}

/** 묶음 안의 차례 — order, 없으면 이름 자연 정렬. */
export function sortGroup<T extends Pick<LibBook, 'name' | 'order' | 'addedAt'>>(books: readonly T[]): T[] {
  return [...books].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || naturalCompare(a.name, b.name) || (a.addedAt ?? 0) - (b.addedAt ?? 0))
}

/** 묶음 이어 읽기 — 마지막으로 읽던 책, 기록이 없으면 첫 책. */
export function groupResume<T extends Pick<LibBook, 'name' | 'order' | 'addedAt' | 'readAt' | 'completed'>>(books: readonly T[]): T | undefined {
  const read = books.filter((b) => (b.readAt ?? 0) > 0)
  if (read.length) {
    const last = read.reduce((a, b) => ((b.readAt ?? 0) > (a.readAt ?? 0) ? b : a))
    if (!last.completed) return last
    const ordered = sortGroup(books), at = ordered.indexOf(last)
    return ordered.slice(at + 1).find(b => !b.completed) || ordered.find(b => !b.completed) || last
  }
  return sortGroup(books)[0]
}

/** 차례를 바꾼다 — 한 칸 앞/뒤. 묶음 전체의 order 를 0.. 으로 다시 매긴 목록을 돌려준다. */
export function moveInGroup<T extends Pick<LibBook, 'id' | 'name' | 'order' | 'addedAt'>>(books: readonly T[], id: string, delta: -1 | 1): Array<{ id: string; order: number }> | null {
  const list = sortGroup(books)
  const i = list.findIndex((b) => b.id === id), j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return null
  ;[list[i], list[j]] = [list[j], list[i]]
  return list.map((b, k) => ({ id: b.id, order: k }))
}

/** 교체 이력에 넣는다(최근 것부터 5개). */
export function pushHistory(book: LibBook, at: number): BookHistory[] {
  return [{ at, sha256: book.source?.sha256, position: book.position, paragraphs: book.paragraphs.length }, ...(book.history || [])].slice(0, 5)
}

// ── 폴더 탐색 결과(본체가 만든다) ─────────────────────────────────────────────
export interface ScanFile { path: string; name: string; size: number; mtimeMs: number }
export interface ScanWork { root: string; name: string; files: ScanFile[]; coverPath?: string }
export interface ScanResult {
  works: ScanWork[]
  /** 폴더가 아니라 파일로 끌어 놓은 글 — 묶지 않는다. */
  loose: ScanFile[]
  /** 지원하지 않는 형식(건너뜀). */
  unsupported: number
  /** 크기 상한을 넘은 글. */
  tooLarge: number
  /** 따라가지 않은 연결(정션·심볼릭 링크). */
  links: number
  /** 읽을 수 없거나 없는 자리. */
  missing: string[]
  /** 너무 많아 일부만 훑었다. */
  truncated: boolean
}

/** 묶음 이름 — 이미 있는 이름이 **다른 원본 폴더**의 것이면 부모 폴더 이름을 붙여 구분한다. */
export function suggestGroupName(work: Pick<ScanWork, 'root' | 'name'>, books: readonly LibBook[]): string {
  const same = books.filter((b) => b.group === work.name)
  if (!same.length || same.some((b) => samePath(b.source?.root, work.root))) return work.name
  const parts = work.root.replace(/\\/g, '/').split('/').filter(Boolean)
  const parent = parts.length >= 2 ? parts[parts.length - 2] : ''
  return parent ? `${work.name} (${parent})` : `${work.name} (2)`
}

/** 끌어 놓은 것을 어떻게 받을지. 받지 못하면 **사유**를 돌려준다 — 조용히 버리지 않는다(2026-10-03). */
export type DropPlan = { kind: 'refuse'; reason: string } | { kind: 'paths'; paths: string[] } | { kind: 'files' }

export function planDrop(items: ReadonlyArray<{ path: string; dir: boolean }>, busy: boolean): DropPlan {
  if (busy) return { kind: 'refuse', reason: '지금 하는 작업(가져오기·정리)이 끝난 뒤 다시 끌어 놓아 주세요.' }
  if (!items.length) return { kind: 'refuse', reason: '끌어 놓은 것에서 파일이나 폴더를 찾지 못했습니다. TXT 파일이나 폴더를 놓아 주세요.' }
  // 폴더가 섞이면 본체가 위치로 훑는다 — 위치를 하나라도 못 읽으면 일부만 몰래 가져오지 않고 알린다.
  if (items.some((i) => i.dir)) {
    const missing = items.filter((i) => !i.path).length
    if (missing) return { kind: 'refuse', reason: `끌어 놓은 ${missing}개 항목의 위치를 읽지 못했습니다. '폴더 가져오기' 단추로 골라 주세요.` }
    return { kind: 'paths', paths: items.map((i) => i.path) }
  }
  return { kind: 'files' }
}
