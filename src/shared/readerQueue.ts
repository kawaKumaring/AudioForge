/**
 * 낭독 큐 — **듣는 동안 뒤를 미리 만든다.**
 *
 * ★왜 필요한가 (2026-09-29 실측)
 *   기본 목소리는 20초 분량을 2.5초에 만든다(8배 여유). 그래도 **첫 소리까지 1.8초**를
 *   기다리고, 덩이 사이마다 그 시간이 다시 든다. 한 덩이를 트는 동안 다음 것을
 *   만들어 두면 그 기다림이 **첫 번째 한 번**으로 끝난다.
 *
 * ★이 파일은 **판단만** 한다 — 실제 합성·재생은 부르는 쪽이 한다.
 *   그래야 검사가 시계도 GPU도 없이 전 경우를 볼 수 있다.
 *
 * 규칙
 *   · 한 번에 **하나만** 만든다. 본체가 파이썬을 하나만 돌리기 때문이다(실측).
 *   · 지금 트는 것 다음으로 **앞선 것부터** 만든다. 뒤엣것을 먼저 만들면 소용없다.
 *   · 자리를 옮기면 **그 앞의 대기는 버린다.** 안 들을 것을 만드느라 들을 것이 늦는다.
 *   · 목소리·설정이 바뀌면 만들어 둔 것은 **무효**다(인수인계 8항).
 */

/** 한 덩이의 상태. */
export type ChunkState =
  | 'idle'      // 아직 손대지 않았다
  | 'making'    // 지금 만드는 중
  | 'ready'     // 만들어 두었다
  | 'failed'    // 만들지 못했다

export interface QueueItem {
  state: ChunkState
  /** 만들어 둔 소리 파일. `ready` 일 때만 있다. */
  path?: string
  /** 만들지 못한 사유. `failed` 일 때만 있다. */
  why?: string
}

export interface QueueState {
  /** 지금 듣고 있는(또는 들을) 덩이 번호. */
  at: number
  /** 덩이 수. */
  count: number
  /** 덩이별 상태. */
  items: QueueItem[]
  /**
   * 지금 쓰는 목소리·설정의 **지문.** 이것이 바뀌면 만들어 둔 것을 버린다.
   * 무엇으로 만들었는지 모르는 소리를 들려주지 않는다.
   */
  voiceKey: string
  /** 앞서 몇 개나 만들어 둘 것인가. */
  ahead: number
}

export const DEFAULT_AHEAD = 2

export function emptyQueue(count: number, voiceKey: string, ahead = DEFAULT_AHEAD): QueueState {
  return {
    at: 0, count, voiceKey, ahead,
    items: Array.from({ length: Math.max(0, count) }, () => ({ state: 'idle' as ChunkState })),
  }
}

/**
 * 다음에 **무엇을 만들어야 하는가.** 만들 것이 없으면 -1.
 *
 * ★지금 자리부터 앞으로 `ahead` 개까지만 본다. 그 너머를 미리 만들면
 *   사용자가 자리를 옮겼을 때 버리는 것이 커진다.
 * ★이미 하나를 만들고 있으면 -1 — 본체가 한 번에 하나만 돌린다.
 */
export function nextToMake(q: QueueState): number {
  if (q.items.some((it) => it.state === 'making')) return -1
  const last = Math.min(q.count - 1, q.at + q.ahead)
  for (let i = q.at; i <= last; i++) {
    if (q.items[i] && q.items[i].state === 'idle') return i
  }
  return -1
}

/** 지금 자리를 **바로 틀 수 있는가.** */
export function canPlayNow(q: QueueState): boolean {
  return q.items[q.at]?.state === 'ready'
}

/**
 * 지금 화면에 무엇이라고 적을 것인가.
 *
 * ★'만드는 중' 과 '기다리는 중' 을 구분한다. 사용자는 **왜** 소리가 안 나는지
 *   알아야 한다 — 멈춘 것인지, 곧 나오는 것인지.
 */
export function waitReason(q: QueueState): string {
  const it = q.items[q.at]
  if (!it) return ''
  if (it.state === 'ready') return ''
  if (it.state === 'making') return '목소리를 만드는 중입니다'
  if (it.state === 'failed') return it.why || '이 부분을 만들지 못했습니다'
  return '차례를 기다리는 중입니다'
}

export function markMaking(q: QueueState, i: number): QueueState {
  return patch(q, i, { state: 'making' })
}

export function markReady(q: QueueState, i: number, path: string): QueueState {
  return patch(q, i, { state: 'ready', path })
}

export function markFailed(q: QueueState, i: number, why: string): QueueState {
  return patch(q, i, { state: 'failed', why })
}

function patch(q: QueueState, i: number, next: QueueItem): QueueState {
  if (i < 0 || i >= q.items.length) return q
  const items = q.items.slice()
  items[i] = next
  return { ...q, items }
}

/**
 * 자리를 옮긴다.
 *
 * ★**지나온 것은 버린다.** 되돌아가면 다시 만들면 된다 — 파일을 붙들고 있으면
 *   긴 책에서 자리만 차지한다. 다만 '만드는 중' 인 것은 건드리지 않는다:
 *   본체가 이미 돌고 있고, 여기서 상태만 바꾸면 그 결과가 갈 곳을 잃는다.
 */
export function seek(q: QueueState, to: number): QueueState {
  const at = Math.max(0, Math.min(to, Math.max(0, q.count - 1)))
  const items = q.items.map((it, i) => {
    if (i >= at) return it
    if (it.state === 'making') return it
    return it.state === 'idle' ? it : { state: 'idle' as ChunkState }
  })
  return { ...q, at, items }
}

/** 다음 덩이로. 끝이면 그대로 둔다. */
export function advance(q: QueueState): QueueState {
  return q.at >= q.count - 1 ? q : seek(q, q.at + 1)
}

/** 마지막까지 들었는가. */
export function atEnd(q: QueueState): boolean {
  return q.count === 0 || q.at >= q.count - 1
}

/**
 * 목소리·설정이 바뀌었다 — **만들어 둔 것을 전부 버린다.**
 *
 * ★자리는 지킨다. 듣던 데를 잃으면 사용자가 다시 찾아야 한다.
 * ★'만드는 중' 이던 것도 버린다. 그것은 **옛 목소리**로 만들고 있었다 —
 *   결과가 와도 쓰면 안 된다. 부르는 쪽이 요청 세대를 함께 봐야 한다.
 */
export function changeVoice(q: QueueState, voiceKey: string): QueueState {
  if (voiceKey === q.voiceKey) return q
  return {
    ...q, voiceKey,
    items: q.items.map(() => ({ state: 'idle' as ChunkState })),
  }
}

/**
 * 만들어진 결과를 받아들여도 되는가.
 *
 * ★늦게 온 결과가 **새 목소리의 자리를 덮지 않게** 한다. 목소리를 바꾼 뒤
 *   옛 요청이 돌아오면 버린다(인수인계 8항).
 */
export function acceptResult(q: QueueState, i: number, voiceKey: string): boolean {
  if (voiceKey !== q.voiceKey) return false
  return q.items[i]?.state === 'making'
}

/**
 * 실패한 것들을 **다시 시도할 수 있게** 되돌린다.
 *
 * ★없으면 갇힌다 (2026-09-29)
 *   다른 작업이 돌고 있어 거절당하면 그 덩이는 '실패' 로 굳는다. 그 작업이 끝나도
 *   스스로 풀리지 않아, 사용자는 자리를 옮겼다 돌아와야 한다.
 *   다시 누르는 것은 "이제 될 것 같다" 는 뜻이다 — 그때 풀어 준다.
 * ★'만드는 중' 은 건드리지 않는다. 돌고 있는 것의 결과가 갈 곳을 잃는다.
 */
export function retryFailed(q: QueueState): QueueState {
  if (!q.items.some((it) => it.state === 'failed')) return q
  return {
    ...q,
    items: q.items.map((it) => (it.state === 'failed' ? { state: 'idle' as ChunkState } : it)),
  }
}

/** 만들어 둔 파일들 — 화면이 정리하거나 지울 때 쓴다. */
export function readyPaths(q: QueueState): string[] {
  return q.items.filter((it) => it.state === 'ready' && it.path).map((it) => it.path as string)
}
