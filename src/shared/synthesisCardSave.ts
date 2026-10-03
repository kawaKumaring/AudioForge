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
  /** 그때 원본의 길이. 0 은 '길이를 모른다' 는 뜻이다(없는 값을 0 으로 단정하지 않는다). */
  sourceDuration: number
  settings: Record<string, unknown>
  applied: Record<string, unknown>
  /**
   * **무엇으로 만든 소리인가**(참조 파일인지 기본 목소리인지, 어느 모델인지).
   *
   * ★2026-09-27 재현: 이 칸이 없어 저장 왕복에서 통째로 사라졌다
   *   (`beforeTakeVoice: true → restoredTakeVoice: false`).
   *   생성본이 무엇으로 만들어졌는지 모르면 '수정 전' 판정도 할 수 없다.
   * 기록이 없던 옛 생성본은 **없는 채로 둔다** — 지금 카드의 목소리로 채우지 않는다.
   */
  voice?: Record<string, unknown>
  /**
   * **당시 설정·적용값 기록이 아예 없다**(옛 작업에서 가져온 생성본).
   *
   * ★없는 것과 기본값은 다르다. 이 표시가 없으면 화면이 지금 설정과 비교해
   *   '지금 것' 이라고 말해 버린다 — 만들 때 무슨 값을 썼는지 아무도 모르는데도.
   */
  settingsUnknown?: boolean
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
  /**
   * 설치된 기본 목소리로 읽는 카드의 목소리 지정. 참조 카드에는 없다.
   *
   * ★2026-09-27 재현: 이 칸이 없어 기본 목소리 카드가 왕복 뒤 **목소리 없는 카드**가 됐다
   *   (`beforeVoice: builtin → restoredVoice: none`). 파일도 모델도 없는 카드는 생성이 막힌다.
   */
  builtin?: Record<string, unknown>
}

export interface SavedWork {
  cards: SavedCard[]
  joins: Record<string, unknown>
  savedAt: number
  /**
   * 옛 작업에서 **복사해 온** 것이면 그 출처. 같은 작업을 또 가져오려 할 때
   * '이미 가져왔다' 고 알리는 근거다(막지는 않는다 — 고르는 것은 사용자다).
   */
  importedFrom?: { kind: 'lab' | 'draft'; key: string; at: number }
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** 객체이고 비어 있지 않을 때만 돌려준다. 빈 것은 '기록 없음' 과 같게 다룬다. */
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length
    ? (v as Record<string, unknown>) : null

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
        sourceDuration: num(tt.sourceDuration),
        settings: (tt.settings as Record<string, unknown>) || {},
        applied: (tt.applied as Record<string, unknown>) || {},
        // ★기록이 없으면 **넣지 않는다.** 빈 객체를 넣으면 '기록 없음' 과 '없는 목소리' 가 섞인다.
        ...(obj(tt.voice) ? { voice: obj(tt.voice)! } : {}),
        ...(tt.settingsUnknown === true ? { settingsUnknown: true } : {}),
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
      ...(obj(c.builtin) ? { builtin: obj(c.builtin)! } : {}),
    })
  }
  return {
    cards,
    joins: (o.joins as Record<string, unknown>) || {},
    savedAt: num(o.savedAt),
    ...(importedFrom(o.importedFrom) ? { importedFrom: importedFrom(o.importedFrom)! } : {}),
  }
}

/** 출처 표시. 모양이 아니면 **없는 것으로** 본다 — 반쯤 읽어 쓰지 않는다. */
function importedFrom(raw: unknown): { kind: 'lab' | 'draft'; key: string; at: number } | null {
  const o = obj(raw)
  if (!o) return null
  const kind = o.kind === 'lab' ? 'lab' : o.kind === 'draft' ? 'draft' : null
  const key = str(o.key)
  if (!kind || !key) return null
  return { kind, key, at: num(o.at) }
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

// ── 저장 문서 한 장 ────────────────────────────────────────────────────
//
// ★왜 두 칸인가 (2026-09-27 검수 재현)
//   '되살리기' 를 거절하고 새 작업을 편집하자 **이전 문서가 새 문서로 덮였다.**
//   생성한 소리 파일이 디스크에 남는 것과 **작업 문서가 남는 것은 다른 일이다** —
//   문서가 사라지면 순서·대사·설정·채택이 통째로 사라진다.
//   그래서 거절한 문서는 버리지 않고 `kept` 로 옮긴다. 재시작 뒤에도 거기서 꺼낼 수 있다.

/**
 * 되살리기 목록에 **한 번에 보여 줄** 개수.
 *
 * ★이것은 **보여 주는 수**이지 **보관하는 수가 아니다**(2026-09-27 2차 검수 지적).
 *   예전에는 이 값으로 저장 문서를 잘라 버렸다 — 다섯 개가 넘으면 사용자가 지운 적도 없는
 *   작업이 조용히 사라졌다. 목록을 줄이는 것과 문서를 버리는 것은 다른 일이다.
 *   지금은 **아무것도 버리지 않는다.**
 */
export const KEPT_SHOW = 5

export interface SavedFile {
  /** 지금 이어서 쓰는 작업. */
  current: SavedWork | null
  /** 되살리기를 거절해 치워 둔 이전 작업들. **새 것이 앞.** */
  kept: SavedWork[]
}

export const emptySavedFile = (): SavedFile => ({ current: null, kept: [] })

/**
 * 저장된 값을 문서 한 장으로 읽는다.
 * 예전 모양(작업 하나가 통째로 들어 있던 것)도 그대로 읽어 `current` 로 본다.
 */
export function parseSavedFile(raw: unknown): SavedFile {
  if (!raw || typeof raw !== 'object') return emptySavedFile()
  const o = raw as Record<string, unknown>
  if (Array.isArray(o.cards)) {            // 예전 모양
    return { current: parseSavedWork(o), kept: [] }
  }
  const kept: SavedWork[] = []
  for (const k of Array.isArray(o.kept) ? o.kept : []) {
    const w = parseSavedWork(k)
    if (savedWorkHasContent(w)) kept.push(w as SavedWork)
  }
  // ★자르지 않는다 — 읽는 김에 버리면 되살릴 길이 영영 사라진다.
  return { current: parseSavedWork(o.current), kept }
}

/**
 * 지금 문서를 **버리지 않고 옆으로 치운다.** 되살리기를 거절했을 때 부른다.
 *
 * ★지우는 코드가 없다는 것이 요점이다. 거절은 '지금 안 열겠다' 이지 '없애라' 가 아니다.
 */
export function keepAside(file: SavedFile): SavedFile {
  if (!savedWorkHasContent(file.current)) return { current: null, kept: file.kept }
  // ★개수를 자르지 않는다. 사용자가 지우겠다고 한 적이 없는 작업을 버리지 않는다.
  return { current: null, kept: [file.current as SavedWork, ...file.kept] }
}

export interface RestoreChoice {
  /** 어느 칸의 것인가. */
  slot: 'current' | 'kept'
  index: number
  summary: string
  work: SavedWork
}

/** 되살릴 수 있는 것들. 지금 것이 앞, 치워 둔 것이 뒤. */
export function savedChoices(file: SavedFile): RestoreChoice[] {
  const out: RestoreChoice[] = []
  const line = (w: SavedWork) => {
    const takes = w.cards.reduce((n, c) => n + c.takes.length, 0)
    const when = w.savedAt ? new Date(w.savedAt).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : ''
    return `${when ? when + ' · ' : ''}카드 ${w.cards.length}장 · 생성본 ${takes}개`
  }
  if (savedWorkHasContent(file.current)) {
    out.push({ slot: 'current', index: 0, summary: line(file.current as SavedWork), work: file.current as SavedWork })
  }
  file.kept.forEach((w, i) => out.push({ slot: 'kept', index: i, summary: line(w), work: w }))
  return out
}
/**
 * 보관함에서 하나를 꺼내 **지금 것**으로 삼는다.
 *
 * ★지금 하던 작업을 **버리지 않는다** — 보관함 앞으로 옮긴 뒤에 꺼낸다.
 *   예전에는 그냥 덮어써서, 보관본을 열면 하던 작업이 통째로 사라졌다(2차 검수 재현).
 */
/**
 * 작업 하나를 **문서에서 뺀다.** 되돌릴 수 없다 — 화면이 먼저 묻고 부른다.
 *
 * ★빼는 것은 **기록뿐**이다. 만든 소리 파일은 건드리지 않는다.
 *   'current' 를 빼면 그 자리는 빈다 — 보관함에서 끌어오지 않는다.
 *   사용자가 고르지 않은 것을 대신 열어 주지 않는다.
 */
export function removeWork(file: SavedFile, slot: 'current' | 'kept', index: number): SavedFile {
  if (slot === 'current') return { current: null, kept: file.kept }
  if (index < 0 || index >= file.kept.length) return file
  return { current: file.current, kept: file.kept.filter((_, i) => i !== index) }
}

/** 지우기 전에 보여 줄 한 줄. **무엇이 남는지**까지 말한다. */
export function removeWorkWarning(w: SavedWork | null | undefined): string {
  const takes = (w?.cards || []).reduce((n, c) => n + c.takes.length, 0)
  return `이 작업 기록을 지웁니다. 만들어 둔 소리 파일 ${takes}개는 그대로 남습니다.`
}

export function adoptFromKept(file: SavedFile, index: number): SavedFile {
  const picked = file.kept[index]
  if (!picked) return file
  const rest = file.kept.filter((_, i) => i !== index)
  const kept = savedWorkHasContent(file.current) ? [file.current as SavedWork, ...rest] : rest
  return { current: picked, kept }
}