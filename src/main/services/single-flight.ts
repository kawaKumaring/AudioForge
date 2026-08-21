// 읽기 전용 작업의 동시 요청 합치기(single-flight). StrictMode 중복 effect·동시 IPC 호출에도
// 실제 작업(subprocess)은 1회만 실행하고 모든 호출자가 같은 결과를 받는다.
// 완료/오류 후 in-flight를 해제해 다음 요청은 새로 실행(재시도 가능)한다.

export interface SingleFlight<T> {
  run(fn: () => Promise<T>): Promise<T>
  readonly running: boolean
}

export function createSingleFlight<T = unknown>(): SingleFlight<T> {
  let inflight: Promise<T> | null = null
  return {
    run(fn: () => Promise<T>): Promise<T> {
      if (inflight) return inflight
      const p = (async () => fn())()
      inflight = p
      // 정착 후 해제(성공/오류 모두). fire-and-forget 정리 체인은 unhandled rejection이 되지 않게 삼킨다.
      void p.finally(() => { if (inflight === p) inflight = null }).catch(() => {})
      return p
    },
    get running() { return inflight !== null },
  }
}

export interface KeyedSingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>
  has(key: string): boolean
}

export function createKeyedSingleFlight<T = unknown>(): KeyedSingleFlight<T> {
  const map = new Map<string, Promise<T>>()
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = map.get(key)
      if (existing) return existing
      const p = (async () => fn())()
      map.set(key, p)
      void p.finally(() => { if (map.get(key) === p) map.delete(key) }).catch(() => {})
      return p
    },
    has(key: string) { return map.has(key) },
  }
}
