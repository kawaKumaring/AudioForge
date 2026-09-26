import { create } from 'zustand'

// Renderer-only interaction draft. No engine requests, disk persistence, or legacy migration.
// Claude will attach preparation/generation/persistence through this documented card contract.
export type CardSource = { path: string; name: string; duration: number }
export type CardSettings = { speed: number; pitch: number; emotion: string; reference: 'auto' | 'manual'; start: number; end: number }
export type CardTake = { id: string; path: string; createdAt: number; text: string; source: CardSource; settings: CardSettings }
export type SynthesisCard = { id: string; label: string; source: CardSource | null; text: string; settings: CardSettings; takes: CardTake[]; adoptedId: string | null }
export type JoinSettings = { gap: number; level: boolean; edges: boolean; gaps: Record<string, number> }
export const newCard = (source: CardSource | null = null, settings?: CardSettings): SynthesisCard => ({
  id: crypto.randomUUID(), label: source?.name.replace(/\.[^.]+$/, '') || '새 목소리', source, text: '',
  settings: settings ? { ...settings } : { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: source?.duration || 0 },
  takes: [], adoptedId: null,
})
type State = {
  view: 'cards' | 'legacy'; cards: SynthesisCard[]; seeded: boolean;
  joins: JoinSettings; removed: { card: SynthesisCard; index: number } | null;
  setView: (view: State['view']) => void;
  seed: (source: CardSource) => void;
  add: (sources: CardSource[]) => void;
  update: (id: string, patch: Partial<Omit<SynthesisCard, 'id'>>) => void;
  clone: (id: string) => void;
  move: (id: string, index: number) => void;
  remove: (id: string) => void; undo: () => void;
  setJoins: (value: JoinSettings) => void;
}
export const useSynthesisCards = create<State>((set) => ({
  view: 'cards', cards: [], seeded: false, removed: null,
  joins: { gap: .35, level: true, edges: true, gaps: {} },
  setView: view => set({ view }),
  seed: source => set(s => s.seeded || s.cards.length ? {} : { cards: [newCard(source)], seeded: true }),
  add: sources => set(s => ({ seeded: true, cards: [...s.cards, ...sources.map(source => newCard(source))] })),
  update: (id, patch) => set(s => ({ cards: s.cards.map(c => c.id === id ? { ...c, ...patch } : c) })),
  clone: id => set(s => {
    const at = s.cards.findIndex(c => c.id === id); if (at < 0) return {}
    const source = s.cards[at], copy = { ...newCard(source.source ? { ...source.source } : null, source.settings), label: source.label }
    const cards = [...s.cards]; cards.splice(at + 1, 0, copy); return { cards }
  }),
  move: (id, index) => set(s => {
    const at = s.cards.findIndex(c => c.id === id); if (at < 0) return {}
    const cards = [...s.cards], [card] = cards.splice(at, 1); cards.splice(Math.max(0, Math.min(index, cards.length)), 0, card); return { cards }
  }),
  remove: id => set(s => {
    const index = s.cards.findIndex(c => c.id === id); if (index < 0) return {}
    return { cards: s.cards.filter(c => c.id !== id), removed: { card: s.cards[index], index } }
  }),
  undo: () => set(s => {
    if (!s.removed) return {}
    const cards = [...s.cards]; cards.splice(Math.min(s.removed.index, cards.length), 0, s.removed.card); return { cards, removed: null }
  }),
  setJoins: joins => set({ joins }),
}))

if (typeof window !== 'undefined' && window.api?._e2e) Object.assign(window, { __synthesisCards: useSynthesisCards })
