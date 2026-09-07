// 같은 일을 두 번 하지 않게 하는 최소 캐시.
//
// 왜: 참조 살펴보기(ref-analyze)와 구간 자르기(ref-trim)에는 결과 저장이 없었다. 메인의 중복 방지는
// **동시 호출만 합치는 방식**(single-flight)이라 끝나면 지운다. 그래서 같은 파일의 패널이 다시
// 마운트되기만 해도 처음부터 다시 분석했고, 같은 구간을 다시 확정하면 whisper 전사까지 다시 돌았다
// (자르기 한 번이 2~3초). 결과를 바꾸지 않고 반복만 없앤다.
//
// 무효화는 **파일의 실제 상태**로 한다 — 경로가 같아도 내용이 바뀌면 다른 것으로 본다.
// 시간 기반 만료를 두지 않는다(오래됐다는 것이 틀렸다는 뜻은 아니다).

/** 파일의 신원 — 크기와 수정 시각. 못 읽으면 null(그때는 캐시하지 않는다). */
export function fileStamp(
  path: string,
  stat: (p: string) => { size: number; mtimeMs: number },
): string | null {
  try {
    const s = stat(path)
    if (!Number.isFinite(s.size) || !Number.isFinite(s.mtimeMs)) return null
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * 요청을 하나로 식별하는 열쇠. 인자가 하나라도 다르면 다른 결과이므로 다른 열쇠다.
 *
 * 구분자는 공백이 아니다 — 파일 경로에 공백이 흔해서 공백으로 이으면 서로 다른 인자 조합이
 * 같은 열쇠가 될 수 있다(['a b','c'] 와 ['a','b c']). 제어문자도 쓰지 않는다 — 소스에 리터럴
 * 제어문자가 들어가면 grep 이 파일을 이진으로 보고 건너뛴다(이 파일에서 실제로 한 번 그랬다).
 */
export const KEY_SEP = '|#|'
export function requestKey(parts: readonly (string | number | null | undefined)[]): string {
  return parts.map((p) => (p === null || p === undefined ? '' : String(p))).join(KEY_SEP)
}

export interface ResultCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  /** 이 접두로 시작하는 항목을 버린다(예: 그 인물의 클립을 놓았을 때). */
  dropPrefix(prefix: string): void
  clear(): void
  readonly size: number
}

/**
 * 가장 오래 안 쓴 것부터 버리는 작은 캐시. 최대 개수만 지킨다 —
 * 참조 파일은 몇 개뿐이라 이 정도면 충분하고, 무한히 커지지 않는 것이 목적이다.
 */
export function createResultCache<T>(max = 24): ResultCache<T> {
  const map = new Map<string, T>()
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const v = map.get(key)!
      map.delete(key); map.set(key, v)     // 최근 사용으로 옮긴다
      return v
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > max) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    dropPrefix(prefix) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k)
    },
    clear() { map.clear() },
    get size() { return map.size },
  }
}

/**
 * 이 응답을 캐시해도 되는가 — **성공한 결과만** 저장한다.
 * 실패·차단 응답을 저장하면 원인이 사라진 뒤에도 계속 같은 실패를 되돌려 준다.
 */
export function cacheableResult(res: unknown): boolean {
  if (!res || typeof res !== 'object') return false
  const r = res as Record<string, unknown>
  if (r.status === 'failed') return false
  if (typeof r.code === 'string') return false        // 구조화 차단 코드
  if (typeof r.error_message === 'string' && r.error_message) return false
  return true
}
