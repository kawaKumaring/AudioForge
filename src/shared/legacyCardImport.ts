/**
 * 옛 작업 → 생성 카드 **가져오기(복사)의 단일 소유자.**
 *
 * ★이 파일이 지키는 것 (2026-09-27 관리자 지시)
 *   1. **복사만 한다.** 옛 기록(`labWorkspace`·`workDrafts`)을 읽기만 한다 — 쓰지도 지우지도 않는다.
 *   2. **기록이 없으면 비운다.** 지금 작업의 설정으로 옛 생성본의 '당시 값' 을 채우지 않는다.
 *   3. **뜻이 같은 것만 옮긴다.** 대사 *안*의 쉼(`silenceGap`)을 카드 *사이* 간격(`joins.gap`)으로
 *      옮기지 않는다 — 숫자는 같아도 소리가 달라진다.
 *   4. **배역을 지어내지 않는다.** 줄과 인물의 대응 기록이 없으면 원문을 한 장에 보존하고
 *      목소리는 사용자가 고르게 둔다.
 *   5. **없는 파일을 대체하지 않는다.** 사라진 생성본은 없음으로 표시할 뿐이다(표시는 화면이 한다).
 *
 * 디스크도 화면도 건드리지 않는다. 모양과 판정만 가진다.
 */
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽으므로 명시 확장자(저장소 관례).
import type { SavedCard, SavedFile, SavedTake, SavedWork } from './synthesisCardSave.ts'
// @ts-ignore TS5097
import { savedWorkHasContent } from './synthesisCardSave.ts'

/** 옛 기록이 사는 두 자리. 이 파일은 여기서 **읽기만** 한다. */
export const LEGACY_LAB_KEY = 'labWorkspace'
export const LEGACY_DRAFT_KEY = 'workDrafts'

export type LegacyKind = 'lab' | 'draft'

/** 옮기지 못하는 항목 하나. **짧게** — 긴 설명 문단을 두지 않는다. */
export interface LegacySkip {
  /** 무엇이 */
  what: string
  /** 왜 못 옮기는가 */
  why: string
}

/** 고를 수 있는 옛 작업 한 줄. */
export interface LegacyWork {
  kind: LegacyKind
  /** 같은 작업인지 가리는 열쇠. 다시 가져오기를 알아보는 기준이다. */
  key: string
  title: string
  cardCount: number
  takeCount: number
  /** 마지막으로 손댄 시각(밀리초). 0 이면 모른다. */
  updatedAt: number
  skips: LegacySkip[]
}

export interface ImportPlan {
  work: LegacyWork
  /** 그대로 저장될 문서. **미리 다 만들어 두고** 한 번에 반영한다. */
  doc: SavedWork
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown, d = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** 경로에서 사람이 읽을 이름만. 경로 구분자는 둘 다 본다. */
export function baseName(path: string): string {
  const p = str(path)
  let cut = -1
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i)
    if (c === 47 || c === 92) cut = i          // '/' 와 '\'
  }
  return cut >= 0 ? p.slice(cut + 1) : p
}

// ── 1. 테스트개발 작업실(labWorkspace) ────────────────────────────────────
//
// 문서 하나에 목소리 하나와 줄 여럿이 있다. 줄 하나가 카드 한 장이 된다.

/** 카드 설정 중 **뜻이 같은 것만** 옮긴다. 나머지는 제품 기본값으로 시작한다. */
function labCardSettings(settings: Record<string, unknown> | null): Record<string, unknown> {
  return {
    // 속도·음높이는 카드에도 같은 뜻으로 있다.
    speed: num(settings?.speed, 1),
    pitch: num(settings?.pitch, 0),
    // ★`silenceGap` 은 여기에 오지 않는다. 카드 사이 간격이 아니다.
    emotion: '자연스럽게',
    // 참조 구간은 옛 문서에 **저장되지 않는다**(화면에만 살았다). 지어내지 않는다.
    reference: 'auto',
    start: 0,
    end: 0,
  }
}

function labSkips(lines: unknown[], takeCount: number): LegacySkip[] {
  const out: LegacySkip[] = [
    { what: '엔진·참조 조건 방식·목표 길이·말끝 다듬기', why: '카드에 같은 설정이 없습니다' },
    { what: '대사 안의 쉼 간격', why: '카드 사이 간격과 뜻이 달라 옮기지 않습니다' },
    { what: '참조 구간', why: '옛 기록에 없습니다. 자동으로 둡니다' },
  ]
  if (takeCount > 0) {
    out.unshift({ what: '생성본별 설정', why: '옛 기록에 없습니다. 기록 없음으로 둡니다' })
  }
  void lines
  return out
}

/**
 * 옛 문서를 **저장 문서 한 장**으로 바꾼다. 모양이 아니면 null — 반쯤 만들지 않는다.
 *
 * `at` 은 '가져온 시각'. 순수 함수로 두려고 밖에서 받는다.
 */
export function planFromLab(raw: unknown, at: number): ImportPlan | null {
  const doc = rec(raw)
  if (!doc) return null
  const lines = Array.isArray(doc.lines) ? doc.lines : null
  if (!lines || !lines.length) return null

  const settings = rec(doc.settings)
  const voicePath = str(doc.voicePath)
  const voiceLabel = str(doc.voiceLabel) || baseName(voicePath)
  const cardSettings = labCardSettings(settings)

  const cards: SavedCard[] = []
  let takeCount = 0
  for (const item of lines) {
    const ln = rec(item)
    if (!ln) continue
    const lineId = str(ln.id)
    if (!lineId) continue
    const takes: SavedTake[] = []
    for (const t of Array.isArray(ln.takes) ? ln.takes : []) {
      const tk = rec(t)
      if (!tk) continue
      const id = str(tk.id), path = str(tk.path)
      if (!id || !path) continue            // 파일 자리가 없으면 옮길 것이 없다
      const voiceKey = str(tk.voiceKey)
      takes.push({
        id: `lab_${id}`, path, createdAt: num(tk.createdAt),
        text: str(tk.text),
        // 그때 쓴 목소리 파일은 **기록되어 있다**(voiceKey). 없으면 비운다.
        sourcePath: voiceKey, sourceName: voiceKey ? baseName(voiceKey) : '',
        sourceDuration: 0,                  // 길이는 기록이 없다. 파일을 열어 재지 않는다.
        // ★당시 설정·적용값 기록이 **없다.** 지금 설정으로 채우지 않는다.
        settings: {}, applied: {},
        settingsUnknown: true,
        ...(voiceKey
          ? { voice: { kind: 'reference', label: baseName(voiceKey), sourcePath: voiceKey } }
          : {}),
      })
    }
    takeCount += takes.length
    const adopted = str(ln.adoptedTakeId)
    const adoptedId = adopted && takes.some((t) => t.id === `lab_${adopted}`) ? `lab_${adopted}` : null
    cards.push({
      id: `lab_${lineId}`,
      label: voiceLabel || '옛 작업',
      sourcePath: voicePath, sourceName: voiceLabel,
      sourceDuration: 0,
      text: str(ln.text),
      settings: { ...cardSettings },
      takes,
      adoptedId,
    })
  }
  if (!cards.length) return null

  const updatedAt = num(doc.updatedAt)
  return {
    work: {
      kind: 'lab', key: 'lab',
      title: voiceLabel ? `문장별 제작 · ${voiceLabel}` : '문장별 제작',
      cardCount: cards.length, takeCount, updatedAt,
      skips: labSkips(lines, takeCount),
    },
    doc: {
      cards,
      // ★간격을 옮기지 않는다 — 비워 두면 화면이 제품 기본값을 쓴다.
      joins: {},
      savedAt: at,
      importedFrom: { kind: 'lab', key: 'lab', at },
    },
  }
}

// ── 2. 합성 전 자동 저장(workDrafts) ──────────────────────────────────────
//
// 원본·인물·구간은 있고 **생성본은 없다.** 대사는 한 덩어리라 줄↔인물 대응이 없다.

interface DraftSpeaker {
  id: string
  source: string
  label: string
  region: { start: number; duration: number } | null
}

function draftSpeakers(draft: Record<string, unknown>): DraftSpeaker[] {
  const map = rec(draft.speakers)
  if (!map) return []
  const out: DraftSpeaker[] = []
  // 열쇠 차례로 — 같은 기록이면 언제 가져와도 같은 결과가 나와야 한다.
  for (const id of Object.keys(map).sort()) {
    const sp = rec(map[id])
    if (!sp) continue
    const source = str(sp.source)
    if (!source) continue
    const r = rec(sp.region)
    const region = r && typeof r.start === 'number' && typeof r.duration === 'number'
      ? { start: num(r.start), duration: num(r.duration) } : null
    out.push({ id, source, label: str(sp.label) || baseName(source), region })
  }
  return out
}

function draftSkips(speakers: DraftSpeaker[], draft: Record<string, unknown>): LegacySkip[] {
  const out: LegacySkip[] = [
    { what: '생성본·채택', why: '합성 전 기록이라 없습니다' },
  ]
  if (speakers.length > 1) {
    out.push({
      what: `인물 ${speakers.length}명의 목소리 지정`,
      why: '어느 줄이 누구의 것인지 기록이 없습니다. 목소리는 직접 고르세요',
    })
  }
  const renames = rec(draft.renames)
  if (renames && Object.keys(renames).length) {
    out.push({ what: '이름 별칭', why: '카드에 같은 설정이 없습니다' })
  }
  return out
}

/**
 * 자동 저장 하나를 저장 문서로 바꾼다.
 *
 * ★인물이 둘 이상이면 **배역을 붙이지 않는다.** 원문을 한 장에 그대로 두고
 *   목소리는 비워 둔다 — 화면이 '목소리를 고르세요' 로 남긴다.
 */
export function planFromDraft(raw: unknown, key: string, at: number): ImportPlan | null {
  const draft = rec(raw)
  if (!draft) return null
  const sourcePath = str(draft.sourcePath)
  const text = str(draft.ttsText)
  const speakers = draftSpeakers(draft)
  if (!text.trim() && !speakers.length) return null

  const only = speakers.length === 1 ? speakers[0] : null
  const region = only?.region || null
  const settings: Record<string, unknown> = {
    speed: 1, pitch: 0, emotion: '자연스럽게',
    // 구간이 **기록되어 있을 때만** 직접 고른 구간으로 본다.
    reference: region ? 'manual' : 'auto',
    start: region ? region.start : 0,
    end: region ? region.start + region.duration : 0,
  }
  const label = only ? only.label : (baseName(sourcePath) || '옛 작업')
  const card: SavedCard = {
    id: `draft_${key}`,
    label,
    sourcePath: only ? only.source : '',
    sourceName: only ? baseName(only.source) : '',
    sourceDuration: 0,
    text,
    settings,
    takes: [],                      // 이 기록에는 생성본이 없다
    adoptedId: null,
  }
  return {
    work: {
      kind: 'draft', key: `draft:${key}`,
      title: `자동 저장 · ${baseName(sourcePath) || key}`,
      cardCount: 1, takeCount: 0,
      updatedAt: Date.parse(str(draft.updatedAt)) || 0,
      skips: draftSkips(speakers, draft),
    },
    doc: {
      cards: [card], joins: {}, savedAt: at,
      importedFrom: { kind: 'draft', key: `draft:${key}`, at },
    },
  }
}

// ── 3. 고를 수 있는 옛 작업 모으기 ────────────────────────────────────────

/**
 * 설정 전체에서 가져올 수 있는 옛 작업을 모은다. **읽기만 한다.**
 * 순서는 최근 것이 앞 — 같은 시각이면 문장별 제작이 앞이다(대응이 명확한 쪽).
 */
export function legacyWorks(all: Record<string, unknown> | null | undefined, at: number): ImportPlan[] {
  const out: ImportPlan[] = []
  const lab = planFromLab(all?.[LEGACY_LAB_KEY], at)
  if (lab) out.push(lab)
  const store = rec(all?.[LEGACY_DRAFT_KEY])
  const drafts = rec(store?.drafts)
  if (drafts) {
    for (const key of Object.keys(drafts).sort()) {
      const p = planFromDraft(drafts[key], key, at)
      if (p) out.push(p)
    }
  }
  return out.sort((a, b) => {
    if (b.work.updatedAt !== a.work.updatedAt) return b.work.updatedAt - a.work.updatedAt
    return a.work.kind === 'lab' ? -1 : 1
  })
}

// ── 4. 이미 가져온 작업인가 ───────────────────────────────────────────────

export interface AlreadyImported {
  slot: 'current' | 'kept'
  index: number
  at: number
}

/**
 * 같은 옛 작업을 전에 가져왔는가. 있으면 **어디에 있는지**를 돌려준다.
 *
 * ★막지 않는다. 알리고 고르게 하는 것이 이 함수의 몫이다 —
 *   열 것인지, 따로 한 벌 더 복사할 것인지는 사용자가 정한다.
 */
export function alreadyImported(file: SavedFile, key: string): AlreadyImported | null {
  const of = (w: SavedWork | null): number => {
    const from = w?.importedFrom
    return from && from.key === key ? (from.at || 1) : 0
  }
  const cur = of(file.current)
  if (cur) return { slot: 'current', index: 0, at: cur }
  for (let i = 0; i < file.kept.length; i += 1) {
    const got = of(file.kept[i])
    if (got) return { slot: 'kept', index: i, at: got }
  }
  return null
}

/**
 * 가져온 문서를 **지금 것**으로 삼는다. 하던 작업은 보관함 앞으로 옮긴다.
 *
 * ★지우는 코드가 없다. 가져오기는 덮어쓰기가 아니다 — 하던 작업도, 옛 기록도 남는다.
 */
export function applyImport(file: SavedFile, doc: SavedWork): SavedFile {
  const kept = savedWorkHasContent(file.current)
    ? [file.current as SavedWork, ...file.kept]
    : file.kept
  return { current: doc, kept }
}

/** 확인 화면 한 줄. 긴 설명을 쓰지 않는다. */
export function importSummary(w: LegacyWork): string {
  const when = w.updatedAt
    ? new Date(w.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  return `${when ? when + ' · ' : ''}카드 ${w.cardCount}장 · 생성본 ${w.takeCount}개`
}
