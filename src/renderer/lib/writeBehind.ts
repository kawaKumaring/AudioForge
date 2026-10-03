/**
 * 화면 밖 **지연 저장기** — 키마다 최신 값 하나만, 한 줄로, 실패는 돌려주고 다시 시도한다.
 *
 * ★왜 (2026-10-02 관리자 검수 재현): 낭독의 위치·서재 보기 저장이 화면 안의 effect 였다.
 *   화면을 떠나면 정리 함수가 **대기 중인 저장 타이머를 취소**했다. 25번째 문단을 고르고 600ms 안에 메뉴를 옮기면
 *   메모리에는 25, 디스크에는 0 이 남았다(보기 방식도 같다 — 설정 파일의 값이 null). 화면 수명과 저장 수명은 다른 것이다.
 *   생성 카드(`cardWorkSaver`)가 같은 사고를 먼저 겪고 이 원칙으로 고쳤다 — 여기서는 그 규칙을 키마다 쓸 수 있게 일반화했다.
 *
 * 규칙
 *  ① 타이머는 이 모듈이 쥔다 — 화면이 사라져도 산다. 값은 **쓰는 순간에** 불러온 함수(getter)로 읽는다(예약 때의 낡은 값을 쓰지 않는다).
 *  ② 키마다 쓰기를 **한 줄로** 세운다 — 앞 쓰기가 느려도 뒤 쓰기를 덮지 못한다. 쓰는 동안 새 예약이 오면 끝난 뒤 최신 값을 다시 쓴다.
 *  ③ 실패는 성공이 아니다 — 상태가 'failed' 로 남고(값도 남는다), 정해진 간격으로 다시 시도하며, 사람이 `retry` 로 바로 다시 할 수도 있다.
 *  ④ `hold()` 동안은 **예약된 쓰기를 미룬다**(다른 작업이 같은 기록을 바꾸는 중 — 책 묶기·지우기). 미룬 것은 풀리면 최신 값으로 쓴다.
 *  ⑤ `discard(key)` — 지우는 기록은 더 쓰지 않는다(지운 것이 되살아나지 않게). 쓰던 것이 있으면 끝나길 기다린다.
 *  ⑥ `flushSync()` — 창이 닫히는 순간 **기다려 주는(동기) 통로**로 마지막 값을 남긴다.
 */
export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed'
export interface KeyState { phase: SavePhase; code: string; at: number }

export interface WriteBehindOptions<V> {
  /** 편집이 멎은 뒤 이만큼 기다렸다 쓴다. */
  delayMs: number
  /** 쓴다. 성공이면 '', 실패면 사유. 던져도 실패로 센다. */
  write: (key: string, value: V) => Promise<string>
  /** 닫히는 순간용 동기 쓰기. 성공이면 ''. 없으면 닫을 때 쓰지 않는다. */
  writeSync?: (key: string, value: V) => string
  /** 실패했을 때 자동으로 다시 시도하는 간격(ms). 다 쓰면 멈추고 'failed' 로 남는다(사람이 retry). */
  retryDelays?: readonly number[]
  /** 검사용 — 타이머를 갈아 끼운다. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }
}

interface Slot<V> {
  get: (() => V | undefined) | null
  timer: unknown
  retryTimer: unknown
  running: Promise<void> | null
  state: KeyState
  retries: number
  gone: boolean
}

export interface WriteBehind<V> {
  /** 저장을 예약한다(값은 쓰는 순간 `get()` 이 돌려주는 것). 같은 키에 또 부르면 마지막 것만 쓴다. */
  queue: (key: string, get: () => V | undefined) => void
  /** 기다리는 저장을 **지금** 쓴다(미룬 상태여도). 끝나면 마지막 실패 사유(없으면 ''). */
  flush: (key?: string) => Promise<string>
  /** 이 값을 **지금** 쓴다(예약된 것을 대신한다). 다른 작업이 기록을 바꿀 때 — 한 줄에 서서 쓴다. */
  writeNow: (key: string, value: V) => Promise<string>
  /** 실패한 것을 바로 다시 시도한다. */
  retry: (key?: string) => Promise<string>
  /** 예약된 쓰기를 미룬다. 돌려받은 함수를 부르면 풀리고 미룬 것을 쓴다. */
  hold: () => () => void
  /** 이 기록은 더 쓰지 않는다(지우는 중). 쓰던 것이 끝나길 기다린다. */
  discard: (key: string) => Promise<void>
  /** `discard` 를 되돌린다(지우기가 실패했을 때). */
  restore: (key: string) => void
  /** 기록이 없어졌다 — 슬롯을 치운다. */
  forget: (key: string) => void
  flushSync: () => void
  state: (key: string) => KeyState
  /** 지금 실패 상태인 키들. */
  failed: () => string[]
  onState: (cb: (key: string, s: KeyState) => void) => () => void
  /** 검사용 — 아직 못 쓴 키(예약·실패). */
  pending: () => string[]
}

const IDLE: KeyState = { phase: 'idle', code: '', at: 0 }

export function createWriteBehind<V>(o: WriteBehindOptions<V>): WriteBehind<V> {
  const set = o.timers?.set ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = o.timers?.clear ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const slots = new Map<string, Slot<V>>()
  const listeners = new Set<(key: string, s: KeyState) => void>()
  let holds = 0

  const slot = (key: string): Slot<V> => {
    let s = slots.get(key)
    if (!s) { s = { get: null, timer: null, retryTimer: null, running: null, state: IDLE, retries: 0, gone: false }; slots.set(key, s) }
    return s
  }
  const publish = (key: string, s: Slot<V>, state: KeyState) => {
    s.state = state
    for (const cb of listeners) cb(key, state)
  }
  const stopTimers = (s: Slot<V>) => {
    if (s.timer) { clear(s.timer); s.timer = null }
    if (s.retryTimer) { clear(s.retryTimer); s.retryTimer = null }
  }

  /** 한 줄로 쓴다 — 이미 쓰는 중이면 그 줄이 끝난 뒤 최신 값까지 이어서 쓴다. */
  function run(key: string, force: boolean): Promise<void> {
    const s = slot(key)
    if (s.running) return s.running
    s.running = (async () => {
      // ★한 박자 쉬고 시작한다 — 쓸 것이 없어 곧바로 끝나면 finally 가 아래 대입보다 먼저 돌아 '쓰는 중' 표시가 영영 남는다(검사로 잡았다).
      await Promise.resolve()
      try {
        while (s.get && !s.gone && (force || holds === 0)) {
          const get = s.get
          s.get = null
          const value = get()
          if (value === undefined) break          // 쓸 것이 없어졌다(기록이 사라졌다)
          publish(key, s, { phase: 'saving', code: '', at: Date.now() })
          let code = ''
          try { code = await o.write(key, value) } catch (e) { code = (e as Error)?.message || 'WRITE_FAILED' }
          if (s.gone) break                         // 쓰는 동안 지우기로 바뀌었다 — 결과를 올리지 않는다
          if (code) {
            if (!s.get) s.get = get                 // 더 새 예약이 없으면 이 값을 남긴다(다시 시도용)
            publish(key, s, { phase: 'failed', code, at: Date.now() })
            scheduleRetry(key, s)
            break
          }
          s.retries = 0
          publish(key, s, { phase: 'saved', code: '', at: Date.now() })
        }
      } finally { s.running = null }
    })()
    return s.running
  }

  function scheduleRetry(key: string, s: Slot<V>) {
    const delays = o.retryDelays ?? []
    if (s.retryTimer || s.retries >= delays.length) return
    const wait = delays[s.retries++]
    s.retryTimer = set(() => { s.retryTimer = null; if (s.get) void run(key, false) }, wait)
  }

  function arm(key: string, s: Slot<V>) {
    if (s.timer) clear(s.timer)
    s.timer = set(() => { s.timer = null; void run(key, false) }, o.delayMs)
  }

  const lastCode = (key: string) => (slots.get(key)?.state.phase === 'failed' ? slots.get(key)!.state.code : '')

  const api: WriteBehind<V> = {
    queue(key, get) {
      const s = slot(key)
      if (s.gone) return
      s.get = get
      if (s.retryTimer) { clear(s.retryTimer); s.retryTimer = null }
      arm(key, s)
    },
    async flush(key) {
      const keys = key === undefined ? [...slots.keys()] : [key]
      for (const k of keys) {
        const s = slots.get(k)
        if (!s) continue
        if (s.timer) { clear(s.timer); s.timer = null }
        await run(k, true)
        // 쓰는 동안 새 예약이 들어왔으면 그것까지.
        while (s.get && !s.gone && s.state.phase !== 'failed') await run(k, true)
      }
      for (const k of keys) { const c = lastCode(k); if (c) return c }
      return ''
    },
    async writeNow(key, value) {
      const s = slot(key)
      if (s.gone) return 'DISCARDED'
      while (s.running) await s.running                 // 한 줄 — 쓰던 것이 끝난 뒤에
      if (s.gone) return 'DISCARDED'
      // ★예약돼 있던 것을 **치우지 않고 맡겨 둔다** — 쓰는 사이 들어온 예약도 잃지 않는다. 이 값은 호출한 쪽이 결과를 책임진다:
      //   실패해도 남겨 다시 시도하지 않는다(화면이 '저장하지 못했습니다' 라고 말한 일이 나중에 몰래 이뤄지면 안 된다).
      const prior = s.get
      s.get = null
      if (s.timer) { clear(s.timer); s.timer = null }
      let code = ''
      const lane = (async () => {
        await Promise.resolve()
        try {
          publish(key, s, { phase: 'saving', code: '', at: Date.now() })
          try { code = await o.write(key, value) } catch (e) { code = (e as Error)?.message || 'WRITE_FAILED' }
          publish(key, s, code ? { phase: 'idle', code: '', at: Date.now() } : { phase: 'saved', code: '', at: Date.now() })
        } finally { s.running = null }
      })()
      s.running = lane
      await lane
      if (!s.get && prior) s.get = prior
      if (s.get && !s.gone) arm(key, s)
      return code
    },
    async retry(key) {
      const keys = key === undefined ? api.failed() : [key]
      for (const k of keys) {
        const s = slots.get(k)
        if (!s || !s.get) continue
        s.retries = 0
        if (s.retryTimer) { clear(s.retryTimer); s.retryTimer = null }
        await run(k, true)
      }
      for (const k of keys) { const c = lastCode(k); if (c) return c }
      return ''
    },
    hold() {
      holds++
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        if (holds === 0) for (const [k, s] of slots) if (s.get && !s.timer && !s.gone) void run(k, false)
      }
    },
    async discard(key) {
      const s = slot(key)
      s.gone = true
      s.get = null
      stopTimers(s)
      if (s.running) await s.running
    },
    restore(key) { const s = slots.get(key); if (s) s.gone = false },
    forget(key) { const s = slots.get(key); if (s) { stopTimers(s); slots.delete(key) } },
    flushSync() {
      if (!o.writeSync) return
      for (const [key, s] of slots) {
        if (s.gone || !s.get) continue
        if (s.timer) { clear(s.timer); s.timer = null }
        let value: V | undefined
        try { value = s.get() } catch { continue }
        if (value === undefined) continue
        try { if (!o.writeSync(key, value)) s.get = null } catch { /* 닫히는 중 — 더 할 수 있는 것이 없다 */ }
      }
    },
    state: (key) => slots.get(key)?.state ?? IDLE,
    failed: () => [...slots].filter(([, s]) => s.state.phase === 'failed' && !s.gone).map(([k]) => k),
    onState(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    pending: () => [...slots].filter(([, s]) => (s.get || s.timer) && !s.gone).map(([k]) => k),
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', () => api.flushSync())
  }
  return api
}
