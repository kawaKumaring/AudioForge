/**
 * 되돌리기 — **무엇을 한 걸음으로 볼 것인가.**
 *
 * 장면(snapshot)이 무엇인지는 모른다. 부르는 쪽이 정한다.
 * 여기서 정하는 것은 걸음의 크기 하나다.
 *   · `kind` 가 같고 이어서 일어나면 **한 걸음으로 묶는다**(이름을 이어 치는 동안 등).
 *   · `seal()` 이 묶기를 끊는다 — 손을 뗐을 때 부른다.
 *   · 묶지 않을 동작(합치기·일괄 변경·전체 삭제)은 `kind` 를 매번 다르게 주거나 바로 끊는다.
 *
 * 화면 안에만 산다. 디스크에 쓰지 않는다.
 */

export interface History<S> {
  past: { snap: S; kind: string }[]
  future: { snap: S; kind: string }[]
  /** 마지막으로 쌓은 걸음의 종류. 묶을지 판단하는 데 쓴다. */
  lastKind: string
}

export const emptyHistory = <S>(): History<S> => ({ past: [], future: [], lastKind: '' })

/** 한 번에 들고 있을 걸음 수. 넘으면 오래된 것부터 버린다(메모리 보호). */
export const HISTORY_LIMIT = 60

/** 이어 묶을 수 있는 종류인가 — 접두사로 정한다. */
export function coalescable(kind: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => kind.startsWith(p))
}

/**
 * 바꾸기 **직전**의 장면을 쌓는다.
 *
 * @param clone 장면을 복사하는 함수. 뒤에 원본이 바뀌어도 이력이 따라 바뀌지 않게 한다.
 */
export function pushHistory<S>(
  history: History<S>, before: S, kind: string,
  clone: (s: S) => S, coalescePrefixes: readonly string[] = [],
): History<S> {
  if (kind && coalescable(kind, coalescePrefixes) && history.lastKind === kind && history.past.length) {
    return { ...history, future: [] }      // 이어서 만지는 중 — 새 걸음을 만들지 않는다
  }
  const past = [...history.past, { snap: clone(before), kind }]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],                            // 새로 바꾸면 '다시 적용' 은 사라진다
    lastKind: kind,
  }
}

/** 이어 묶기를 끊는다. */
export function sealHistory<S>(history: History<S>): History<S> {
  return history.lastKind ? { ...history, lastKind: '' } : history
}

export const canUndo = (h: History<unknown>): boolean => h.past.length > 0
export const canRedo = (h: History<unknown>): boolean => h.future.length > 0

export function undo<S>(history: History<S>, current: S, clone: (s: S) => S):
  { history: History<S>; snap: S } | null {
  if (!history.past.length) return null
  const past = [...history.past]
  const last = past.pop()!
  return {
    history: { past, future: [{ snap: clone(current), kind: last.kind }, ...history.future], lastKind: '' },
    snap: last.snap,
  }
}

export function redo<S>(history: History<S>, current: S, clone: (s: S) => S):
  { history: History<S>; snap: S } | null {
  if (!history.future.length) return null
  const [next, ...rest] = history.future
  return {
    history: { past: [...history.past, { snap: clone(current), kind: next.kind }], future: rest, lastKind: '' },
    snap: next.snap,
  }
}
