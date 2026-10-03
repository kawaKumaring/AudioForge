/**
 * 분할 편집 되돌리기 — **무엇을 한 걸음으로 볼 것인가.**
 *
 * ★걸음의 크기가 이 파일의 전부다(2026-09-27 지시 4).
 *   · 경계를 끄는 것은 **드래그 한 번이 한 걸음**이다. 끄는 동안 수십 번 바뀌지만
 *     되돌리기는 한 번이어야 한다.
 *   · 이름을 치는 것은 **글자마다 쌓지 않는다.** 같은 대상에 이어서 치면 한 걸음으로 묶는다.
 *   · **전체 삭제도 되돌릴 수 있어야 한다.** 가장 크게 잃는 동작이므로 가장 확실해야 한다.
 *
 * 화면 안에만 산다 — 디스크에 쓰지 않는다. 메뉴를 옮겨도 이력까지 되살리지는 않는다.
 */

/** 이력에 담는 한 장면. 화면의 마커 목록과 첫 트랙 이름. */
export interface SplitSnapshot<M = unknown> {
  markers: M[]
  firstLabel: string
}

/**
 * 이 변경을 **앞 걸음과 묶을 것인가.**
 *   · `drag:<id>`  — 같은 경계를 끄는 동안 하나로 묶는다
 *   · `label:<id>` — 같은 대상의 이름을 이어 치는 동안 하나로 묶는다
 *   · 그 밖(추가·삭제·전체 삭제·목록 적용)은 묶지 않는다 — 늘 새 걸음이다
 */
export type SplitEditKind = string

export interface SplitHistory<M = unknown> {
  past: { snap: SplitSnapshot<M>; kind: SplitEditKind }[]
  future: { snap: SplitSnapshot<M>; kind: SplitEditKind }[]
  /** 마지막으로 쌓은 걸음의 종류. 묶을지 판단하는 데 쓴다. */
  lastKind: SplitEditKind
}

export const emptyHistory = <M>(): SplitHistory<M> => ({ past: [], future: [], lastKind: '' })

/** 한 번에 들고 있을 걸음 수. 넘으면 오래된 것부터 버린다(메모리 보호). */
export const HISTORY_LIMIT = 60

/** 묶을 수 있는 종류인가 — 드래그와 이름 입력만이다. */
export function coalescable(kind: SplitEditKind): boolean {
  return kind.startsWith('drag:') || kind.startsWith('label:')
}

/**
 * 바꾸기 **직전**의 장면을 쌓는다.
 *
 * @param before 바꾸기 전 장면
 * @param kind   이 변경의 종류
 */
export function pushHistory<M>(
  history: SplitHistory<M>, before: SplitSnapshot<M>, kind: SplitEditKind,
): SplitHistory<M> {
  // ★같은 대상을 이어서 만지는 중이면 **새 걸음을 만들지 않는다.**
  //   맨 처음 장면은 이미 쌓여 있으므로 되돌리면 그 자리로 한 번에 돌아간다.
  if (kind && coalescable(kind) && history.lastKind === kind && history.past.length) {
    return { ...history, future: [] }
  }
  const past = [...history.past, { snap: clone(before), kind }]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],                       // 새로 바꾸면 '다시 적용' 은 사라진다
    lastKind: kind,
  }
}

/** 이어 묶기를 끊는다 — 드래그를 놓거나 다른 곳을 만졌을 때 부른다. */
export function sealHistory<M>(history: SplitHistory<M>): SplitHistory<M> {
  return history.lastKind ? { ...history, lastKind: '' } : history
}

export const canUndo = (h: SplitHistory<unknown>): boolean => h.past.length > 0
export const canRedo = (h: SplitHistory<unknown>): boolean => h.future.length > 0

/** 한 걸음 되돌린다. 돌려줄 장면이 없으면 null. */
export function undo<M>(history: SplitHistory<M>, current: SplitSnapshot<M>):
  { history: SplitHistory<M>; snap: SplitSnapshot<M> } | null {
  if (!history.past.length) return null
  const past = [...history.past]
  const last = past.pop()!
  return {
    history: { past, future: [{ snap: clone(current), kind: last.kind }, ...history.future], lastKind: '' },
    snap: last.snap,
  }
}

/** 한 걸음 다시 적용한다. 없으면 null. */
export function redo<M>(history: SplitHistory<M>, current: SplitSnapshot<M>):
  { history: SplitHistory<M>; snap: SplitSnapshot<M> } | null {
  if (!history.future.length) return null
  const [next, ...rest] = history.future
  return {
    history: { past: [...history.past, { snap: clone(current), kind: next.kind }], future: rest, lastKind: '' },
    snap: next.snap,
  }
}

/** 장면을 얕게 복사한다 — 뒤에 배열이 바뀌어도 이력이 따라 바뀌지 않게. */
function clone<M>(s: SplitSnapshot<M>): SplitSnapshot<M> {
  return { markers: s.markers.map((m) => (m && typeof m === 'object' ? { ...m } : m)), firstLabel: s.firstLabel }
}
