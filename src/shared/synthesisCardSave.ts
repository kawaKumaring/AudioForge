/**
 * 생성 카드 작업을 **저장하고, 물어보고 나서 되살린다.**
 *
 * ★관리자 지시(2026-09-26)가 정한 네 가지
 *   1. 앱을 다시 켤 때 **묵시적으로 되살리지 않는다.**
 *   2. 저장된 작업 자체는 **지우지 않는다.**
 *   3. 새 원본을 불러온 뒤 합성에 처음 들어갈 때 **한 번 묻는다.**
 *   4. 되살리기를 거절해도 **저장본은 그대로 둔다.**
 *
 * ★기존 작업을 덮지 않는다
 *   저장 열쇠가 `labWorkspace`(문장별 제작)와 **다르다.** 이관 계획이 없으므로
 *   두 자리는 서로를 모른다. 이 파일은 `labWorkspace` 를 읽지도 쓰지도 않는다.
 *
 * 이 파일은 모양과 판단만 소유한다 — 디스크도 파일도 건드리지 않는다.
 */

/** 카드 작업이 사는 설정 열쇠. **`labWorkspace` 와 겹치지 않는다.** */
export const CARD_STORAGE_KEY = 'synthesisCards'

export interface SavedTake {
  id: string
  path: string
  createdAt: number
  /** 생성 당시의 대사·원본·설정. 현재 카드를 덮어 보여 주지 않기 위한 것이다. */
  text: string
  sourcePath: string
  sourceName: string
  settings: Record<string, unknown>
  applied: Record<string, unknown>
}

export interface SavedCard {
  id: string
  label: string
  sourcePath: string
  sourceName: string
  sourceDuration: number
  text: string
  settings: Record<string, unknown>
  takes: SavedTake[]
  adoptedId: string | null
}

export interface SavedWork {
  cards: SavedCard[]
  joins: Record<string, unknown>
  savedAt: number
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 저장본을 읽는다. **깨져 있으면 null 이다 — 반쯤 읽어 되살리지 않는다.**
 *
 * 반쯤 읽으면 사용자는 "왜 일부만 돌아왔지" 를 설명할 수 없다.
 * 모양이 아니면 없는 것으로 보고, **저장본은 그대로 둔다**(지우는 것은 이 함수의 일이 아니다).
 */
export function parseSavedWork(raw: unknown): SavedWork | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.cards)) return null
  const cards: SavedCard[] = []
  for (const item of o.cards) {
    if (!item || typeof item !== 'object') return null
    const c = item as Record<string, unknown>
    const id = str(c.id)
    if (!id) return null
    const takes: SavedTake[] = []
    for (const t of Array.isArray(c.takes) ? c.takes : []) {
      if (!t || typeof t !== 'object') continue
      const tt = t as Record<string, unknown>
      if (!str(tt.id) || !str(tt.path)) continue     // 파일 없는 생성본은 되살릴 것이 없다
      takes.push({
        id: str(tt.id), path: str(tt.path), createdAt: num(tt.createdAt),
        text: str(tt.text), sourcePath: str(tt.sourcePath), sourceName: str(tt.sourceName),
        settings: (tt.settings as Record<string, unknown>) || {},
        applied: (tt.applied as Record<string, unknown>) || {},
      })
    }
    const adopted = str(c.adoptedId)
    cards.push({
      id, label: str(c.label), sourcePath: str(c.sourcePath), sourceName: str(c.sourceName),
      sourceDuration: num(c.sourceDuration), text: str(c.text),
      settings: (c.settings as Record<string, unknown>) || {},
      takes,
      // 채택한 생성본이 사라졌으면 채택도 없던 것으로 — 없는 것을 가리키면 최종 연결이 헛돈다.
      adoptedId: takes.some((t) => t.id === adopted) ? adopted : null,
    })
  }
  return {
    cards,
    joins: (o.joins as Record<string, unknown>) || {},
    savedAt: num(o.savedAt),
  }
}

/** 되살릴 만한 것이 들어 있는가. 빈 껍데기로 묻지 않는다. */
export function savedWorkHasContent(w: SavedWork | null): boolean {
  if (!w || !w.cards.length) return false
  return w.cards.some((c) => c.text.trim() || c.takes.length || c.sourcePath)
}

export interface RestoreAsk {
  /** 물어볼 것인가. */
  ask: boolean
  /** 물어볼 때 보여 줄 한 줄. */
  summary: string
}

/**
 * 이전 작업을 되살릴지 **물어볼 때인가.**
 *
 * ★스스로 되살리는 길은 여기에 없다. 이 함수가 돌려주는 것은 '묻는다/안 묻는다' 뿐이다.
 *   한 번 물었으면 다시 묻지 않는다 — 거절한 사람에게 같은 질문을 되풀이하지 않는다.
 *   지금 화면에 손댄 카드가 있으면 묻지 않는다 — 하던 일을 질문으로 끊지 않는다.
 */
export function restoreAsk(a: {
  saved: SavedWork | null
  /** 이번 실행에서 이미 물었는가. */
  asked: boolean
  /** 지금 화면에 사용자가 손댄 카드가 있는가. */
  dirty: boolean
}): RestoreAsk {
  if (a.asked || a.dirty || !savedWorkHasContent(a.saved)) return { ask: false, summary: '' }
  const w = a.saved as SavedWork
  const takes = w.cards.reduce((n, c) => n + c.takes.length, 0)
  const when = w.savedAt ? new Date(w.savedAt).toLocaleString('ko-KR', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : ''
  return {
    ask: true,
    summary: `${when ? when + ' · ' : ''}카드 ${w.cards.length}장 · 생성본 ${takes}개`,
  }
}

/**
 * 되살리기를 거절했을 때.
 *
 * ★저장본을 지우지 않는다. 지우는 코드가 아예 없다는 것이 이 함수의 요점이다 —
 *   "다음에 열겠다" 는 선택을 되돌릴 수 없게 만들지 않는다.
 */
export function declineRestore(): { asked: true; deleted: false } {
  return { asked: true, deleted: false }
}
