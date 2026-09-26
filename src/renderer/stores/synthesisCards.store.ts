import { create } from 'zustand'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽으므로 명시 확장자(app.store 의 관례).
import type { CardApplied, CardEngineSettings } from '../../shared/synthesisCardJob.ts'

// 카드 하나가 참조 원본·목소리·선택 구간·대사·설정·생성본·채택을 소유한다.
//
// GUI 초안(Codex)에 Claude 가 준비·생성·저장을 이었다. 경계는 그대로다 —
// 이 파일은 **상태만** 가진다. 파이썬을 부르는 일은 `lib/cardSynthesis` 가, 무엇을 보낼 수
// 있는지 판단하는 일은 `shared/synthesisCardJob` 이 한다.
export type CardSource = { path: string; name: string; duration: number }
export type CardSettings = CardEngineSettings

/**
 * 생성본 하나. **요청 당시의 모습을 통째로 안고 있다.**
 *
 * ★`applied` 는 요청값이 아니라 **엔진에 실제로 간 값**이다. 음높이처럼 범위 밖이라 깎인 값이
 *   있으면 요청값과 다르다. 이것을 안 남기면 "왜 +4 로 했는데 이 소리지" 를 설명할 수 없다.
 */
export type CardTake = {
  id: string
  path: string
  createdAt: number
  text: string
  source: CardSource
  settings: CardSettings
  applied: CardApplied
  /** 저장본을 되살렸는데 파일이 사라졌다. 재생·채택을 막고 이유를 말한다. */
  missing?: boolean
}

export type SynthesisCard = {
  id: string; label: string; source: CardSource | null; text: string
  settings: CardSettings; takes: CardTake[]; adoptedId: string | null
}
export type JoinSettings = { gap: number; level: boolean; edges: boolean; gaps: Record<string, number> }

/** 이 카드의 목소리 준비 상태. 화면에만 살고 저장하지 않는다. */
export type CardRef = {
  clip: string
  /**
   * 이 카드가 **실제로 읽는 소리 파일.** 영상이면 꺼낸 wav, 소리면 원본 그대로.
   *
   * ★2026-09-27 지적: 준비 경로는 꺼낸 wav 를 쓰는데 카드 파형에는 원본 영상 경로가 갔다.
   *   그러면 파형과 미리듣기가 영상 컨테이너를 직접 열려다 실패한다.
   */
  audio: string
  region: { start: number; duration: number } | null
  phase: 'idle' | 'preparing' | 'ready' | 'needs_region' | 'failed'
  message: string
  /** 이 준비 요청의 식별자. 늦게 온 결과를 버리는 기준이다. */
  reqId: string
}
export const emptyCardRef = (): CardRef => ({ clip: '', audio: '', region: null, phase: 'idle', message: '', reqId: '' })

/** 지금 돌고 있는 생성 한 건. **한 번에 하나** — 파이썬 통로가 하나이기 때문이다. */
export type CardJob = {
  cardId: string
  /** 이 요청의 식별자. 늦게 온 결과가 바뀐 카드에 붙지 않게 한다. */
  reqId: string
  text: string
  source: CardSource
  settings: CardSettings
  applied: CardApplied
  startedAt: number
  percent: number
  message: string
  /** 멈추는 중. */
  cancelling: boolean
}

export const newCard = (source: CardSource | null = null, settings?: CardSettings): SynthesisCard => ({
  id: crypto.randomUUID(), label: source?.name.replace(/\.[^.]+$/, '') || '새 목소리', source, text: '',
  settings: settings ? { ...settings } : { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: source?.duration || 0 },
  takes: [], adoptedId: null,
})

type State = {
  view: 'cards' | 'legacy'; cards: SynthesisCard[]; seeded: boolean;
  joins: JoinSettings;
  /**
   * 방금 지운 카드. **되돌리기가 있으므로 준비 상태도 함께 안고 간다.**
   *
   * ★2026-09-27 검수 재현: 되돌리면 카드와 대사는 돌아오는데 `refs` 가 없어
   *   생성 단추가 잠긴 채였다. 지우는 쪽만 refs 를 치우고 되돌리는 쪽은 몰랐다.
   */
  removed: { card: SynthesisCard; index: number; ref: CardRef | null } | null;
  /** 카드별 목소리 준비 상태. */
  refs: Record<string, CardRef>
  /** 돌고 있는 생성. */
  job: CardJob | null
  /** 이번 실행에서 '이전 작업을 불러올까' 를 이미 물었는가. */
  asked: boolean
  /** 사용자가 이 화면에서 무언가 손댔는가 — 손댄 뒤에는 복원을 묻지 않는다. */
  dirty: boolean
  setView: (view: State['view']) => void;
  seed: (source: CardSource) => void;
  add: (sources: CardSource[]) => void;
  update: (id: string, patch: Partial<Omit<SynthesisCard, 'id'>>) => void;
  clone: (id: string) => void;
  move: (id: string, index: number) => void;
  remove: (id: string) => void; undo: () => void;
  setJoins: (value: JoinSettings) => void;
  setRef: (id: string, patch: Partial<CardRef>) => void
  clearRef: (id: string) => void
  setJob: (job: CardJob | null) => void
  patchJob: (patch: Partial<CardJob>) => void
  /** 생성본을 **더한다.** 이전 생성본은 지우지 않는다. */
  addTake: (id: string, take: CardTake) => void
  markAsked: () => void
  /** 저장본에서 통째로 되살린다. 사용자가 '불러오기' 를 고른 뒤에만 불린다. */
  replaceAll: (cards: SynthesisCard[], joins: JoinSettings) => void
}

export const useSynthesisCards = create<State>((set) => ({
  view: 'cards', cards: [], seeded: false, removed: null,
  refs: {}, job: null, asked: false, dirty: false,
  joins: { gap: .35, level: true, edges: true, gaps: {} },
  setView: view => set({ view }),
  seed: source => set(s => s.seeded || s.cards.length ? {} : { cards: [newCard(source)], seeded: true }),
  add: sources => set(s => ({ seeded: true, dirty: true, cards: [...s.cards, ...sources.map(source => newCard(source))] })),
  update: (id, patch) => set(s => ({ dirty: true, cards: s.cards.map(c => c.id === id ? { ...c, ...patch } : c) })),
  clone: id => set(s => {
    const at = s.cards.findIndex(c => c.id === id); if (at < 0) return {}
    const source = s.cards[at], copy = { ...newCard(source.source ? { ...source.source } : null, source.settings), label: source.label }
    const cards = [...s.cards]; cards.splice(at + 1, 0, copy); return { cards, dirty: true }
  }),
  move: (id, index) => set(s => {
    const at = s.cards.findIndex(c => c.id === id); if (at < 0) return {}
    const cards = [...s.cards], [card] = cards.splice(at, 1); cards.splice(Math.max(0, Math.min(index, cards.length)), 0, card); return { cards, dirty: true }
  }),
  remove: id => set(s => {
    const index = s.cards.findIndex(c => c.id === id); if (index < 0) return {}
    // ★준비 상태는 화면에서 내리되 **버리지 않고 removed 에 얹는다** — 되돌리기가 있기 때문이다.
    //   디스크 파일도 여기서 지우지 않는다. 실제 정리는 되돌릴 수 없게 된 시점에만 한다.
    const refs = { ...s.refs }; const ref = refs[id] || null; delete refs[id]
    return {
      cards: s.cards.filter(c => c.id !== id),
      removed: { card: s.cards[index], index, ref }, refs, dirty: true,
    }
  }),
  undo: () => set(s => {
    if (!s.removed) return {}
    const cards = [...s.cards]
    cards.splice(Math.min(s.removed.index, cards.length), 0, s.removed.card)
    // 준비 상태를 **함께** 되돌린다. 파생 클립은 지우지 않았으므로 그대로 쓸 수 있다.
    const refs = { ...s.refs }
    if (s.removed.ref) refs[s.removed.card.id] = s.removed.ref
    return { cards, refs, removed: null }
  }),
  setJoins: joins => set({ joins, dirty: true }),
  setRef: (id, patch) => set(s => ({ refs: { ...s.refs, [id]: { ...(s.refs[id] || emptyCardRef()), ...patch } } })),
  clearRef: id => set(s => { const refs = { ...s.refs }; delete refs[id]; return { refs } }),
  setJob: job => set({ job }),
  patchJob: patch => set(s => (s.job ? { job: { ...s.job, ...patch } } : {})),
  addTake: (id, take) => set(s => ({
    dirty: true,
    cards: s.cards.map(c => c.id === id ? { ...c, takes: [...c.takes, take] } : c),
  })),
  markAsked: () => set({ asked: true }),
  replaceAll: (cards, joins) => set({ cards, joins, seeded: true, asked: true, dirty: false, refs: {}, removed: null }),
}))

if (typeof window !== 'undefined' && window.api?._e2e) Object.assign(window, { __synthesisCards: useSynthesisCards })
