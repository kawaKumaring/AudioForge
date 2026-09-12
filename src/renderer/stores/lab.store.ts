// 테스트개발 작업실의 상태.
//
// 기존 합성 화면의 상태 구조를 따라 만들지 않는다. 이 작업실이 다루는 것은 **대본 한 벌**과
// 그 줄들에 붙은 **테이크들**뿐이다. 그래서 상태도 그 모양 그대로다.
//
// 규칙(무엇이 지금 대사·지금 목소리의 결과인가)은 전부 `shared/labWorkspace` 가 판정한다 —
// 화면·저장·검사가 각자 다시 쓰면 갈라지기 때문이다.
import { create } from 'zustand'

// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(app.store 의 같은 관례).
import { LAB_STORAGE_KEY, emptyDoc, newId, newLine, parseDoc, shouldAutoAdopt, voiceKeyOf } from '../../shared/labWorkspace.ts'
import type { LabDoc, LabLine, LabTake } from '../../shared/labWorkspace'

/** 지금 돌고 있는 생성 한 건. 요청 당시의 대사·목소리를 붙들어 둔다. */
export interface LabJob {
  lineId: string
  /** 요청 당시의 대사 — 도중에 고쳐도 이 값이 결과에 붙는다. */
  text: string
  voiceKey: string
  startedAt: number
  /** 줄줄이 만들 때 남은 줄들. 하나가 끝나면 다음으로 간다. */
  queue: string[]
}

interface LabState {
  doc: LabDoc
  /** 편집 중인 줄. 조작은 이 줄 가까이에 붙는다. */
  selectedLineId: string | null
  job: LabJob | null
  progress: { percent: number; message: string } | null
  error: string | null
  notice: string | null
  loaded: boolean

  setDoc: (d: LabDoc) => void
  setVoice: (path: string, label: string) => void
  selectLine: (id: string | null) => void
  setLineText: (id: string, text: string) => void
  addLineAfter: (id: string | null) => string
  removeLine: (id: string) => void
  addTake: (lineId: string, take: LabTake) => void
  adopt: (lineId: string, takeId: string) => void
  setJob: (j: LabJob | null) => void
  setProgress: (p: { percent: number; message: string } | null) => void
  setError: (m: string | null) => void
  setNotice: (m: string | null) => void
  markLoaded: () => void
}

export const useLabStore = create<LabState>((set) => ({
  doc: emptyDoc(),
  selectedLineId: null,
  job: null,
  progress: null,
  error: null,
  notice: null,
  loaded: false,

  setDoc: (d) => set({ doc: d }),

  // 목소리를 바꿔도 **기존 테이크를 지우지 않는다.** 꼬리표('이전 목소리')가 붙을 뿐이다.
  setVoice: (path, label) => set((s) => ({
    doc: { ...s.doc, voicePath: path, voiceLabel: label, updatedAt: Date.now() },
  })),

  selectLine: (id) => set({ selectedLineId: id }),

  // 대사를 고쳐도 **기존 테이크를 지우지 않는다.** 꼬리표('수정 전 대사')가 붙을 뿐이다.
  setLineText: (id, text) => set((s) => ({
    doc: {
      ...s.doc,
      lines: s.doc.lines.map((l) => (l.id === id ? { ...l, text } : l)),
      updatedAt: Date.now(),
    },
  })),

  addLineAfter: (id) => {
    const line = newLine('')
    set((s) => {
      const i = id ? s.doc.lines.findIndex((l) => l.id === id) : s.doc.lines.length - 1
      const lines = [...s.doc.lines]
      lines.splice(i < 0 ? lines.length : i + 1, 0, line)
      return { doc: { ...s.doc, lines, updatedAt: Date.now() }, selectedLineId: line.id }
    })
    return line.id
  },

  removeLine: (id) => set((s) => {
    const lines = s.doc.lines.filter((l) => l.id !== id)
    return {
      doc: { ...s.doc, lines: lines.length ? lines : [newLine('')], updatedAt: Date.now() },
      selectedLineId: null,
    }
  }),

  // 새 테이크는 **덧붙인다**. 이전 파일을 덮지 않는다.
  addTake: (lineId, take) => set((s) => ({
    doc: {
      ...s.doc,
      lines: s.doc.lines.map((l) => {
        if (l.id !== lineId) return l
        const takes = [...l.takes, take]
        const next = { ...l, takes }
        // 첫 성공만 자동 채택한다. 이미 고른 것이 있으면 밀어내지 않는다.
        // 늦게 온 결과가 지금 대사·목소리와 다르면 자동 채택하지 않는다(꼬리표만 붙는다).
        if (shouldAutoAdopt(l, take, voiceKeyOf(s.doc.voicePath))) next.adoptedTakeId = take.id
        return next
      }),
      updatedAt: Date.now(),
    },
  })),

  adopt: (lineId, takeId) => set((s) => ({
    doc: {
      ...s.doc,
      lines: s.doc.lines.map((l) => (l.id === lineId ? { ...l, adoptedTakeId: takeId } : l)),
      updatedAt: Date.now(),
    },
  })),

  setJob: (j) => set({ job: j }),
  setProgress: (p) => set({ progress: p }),
  setError: (m) => set({ error: m }),
  setNotice: (m) => set({ notice: m }),
  markLoaded: () => set({ loaded: true }),
}))

export { LAB_STORAGE_KEY, newId, parseDoc }
export type { LabDoc, LabLine, LabTake }
