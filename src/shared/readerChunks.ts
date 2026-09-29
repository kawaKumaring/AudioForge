/**
 * 낭독을 위해 글을 **덩이로 나눈다** — 표시용 문단과 다른 일이다.
 *
 * ★왜 따로 나누나 (2026-09-29 실측)
 *   만드는 시간이 `1.8초(고정) + 소리 길이 × 0.032` 다. **한 번 부를 때마다 1.8초를
 *   버린다.** 그래서 소설처럼 줄이 짧은 글을 줄 단위로 만들면 배수가 1 아래로 떨어져
 *   **오히려 끊긴다**(10자 한 문장 = 0.82배, 읽는 속도보다 느리다).
 *
 *   반대로 너무 크게 잡으면 첫 소리까지 오래 기다리고, 멈추거나 자리를 옮길 때
 *   버리는 것이 커진다. 그래서 **15~30초 분량**으로 모은다.
 *
 * ★원문 자리를 잃지 않는다. 덩이마다 원문의 시작·끝 글자 자리를 들고 다닌다 —
 *   지금 읽는 자리를 본문에 표시하고, 사용자가 문단을 누르면 그 덩이로 건너뛰려면
 *   이 대응이 있어야 한다(인수인계 3항).
 *
 * ★문장 한가운데를 자르지 않는다. 문장 부호와 줄바꿈에서만 나눈다 —
 *   중간에서 자르면 이어 붙일 때 말이 끊겨 들린다.
 */

/** 한국어 기준 1초에 읽는 글자 수 — 실측 평균(298자 → 32.4초). */
export const CHARS_PER_SECOND = 9.2

/** 덩이 하나의 목표 분량(초). 이 값 근처에서 자른다. */
export const TARGET_SECONDS = 20
/** 이보다 짧으면 다음 문장을 더 붙인다 — 잘게 쪼개면 고정비만 늘어난다. */
export const MIN_SECONDS = 12
/** 이보다 길면 더 붙이지 않는다 — 첫 소리가 늦고, 멈출 때 버리는 것이 커진다. */
export const MAX_SECONDS = 35

/**
 * 책으로 받는 파일의 크기 상한(바이트).
 * ★화면과 본체가 **같은 값**을 본다 — 본체는 이보다 큰 파일을 읽지도 않는다.
 */
export const TEXT_FILE_LIMIT = 10 * 1024 * 1024

const toChars = (sec: number) => Math.round(sec * CHARS_PER_SECOND)

export interface Chunk {
  /** 읽을 글. 앞뒤 공백은 없다. */
  text: string
  /** 원문에서 이 덩이가 시작하는 글자 자리(0부터). */
  start: number
  /** 원문에서 이 덩이가 끝나는 글자 자리(이 자리는 포함하지 않는다). */
  end: number
  /** 몇 초쯤 걸릴지 — 앞서 만들어 둘 양을 정할 때 쓴다. 어림값이다. */
  seconds: number
}

/**
 * 문장 끝을 찾는다. **원문 자리를 그대로** 돌려준다.
 *
 * 문장 부호 뒤에 닫는 따옴표·괄호가 따라오면 그것까지 한 문장이다 —
 * `말했다."` 를 `말했다.` 와 `"` 로 가르면 따옴표 하나만 읽는 덩이가 생긴다.
 */
function sentenceEnds(text: string): number[] {
  const out: number[] = []
  const CLOSERS = '"”’\'」』)）】›»'
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') { out.push(i + 1); continue }
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
    let j = i + 1
    while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?' || text[j] === '…')) j++
    while (j < text.length && CLOSERS.includes(text[j])) j++
    out.push(j)
    i = j - 1
  }
  if (!out.length || out[out.length - 1] < text.length) out.push(text.length)
  return out
}

/**
 * 글을 덩이로 나눈다.
 *
 * ★한 문장이 최대치를 넘으면 **그 문장은 그대로 둔다.** 문장 한가운데를 자르면
 *   이어 붙일 때 말이 끊겨 들린다. 늦어지는 것이 끊기는 것보다 낫다.
 */
export function splitForReading(raw: string, opts: {
  target?: number; min?: number; max?: number
} = {}): Chunk[] {
  const text = String(raw ?? '')
  if (!text.trim()) return []
  const target = toChars(opts.target ?? TARGET_SECONDS)
  const min = toChars(opts.min ?? MIN_SECONDS)
  const max = toChars(opts.max ?? MAX_SECONDS)

  const out: Chunk[] = []
  let from = 0                 // 지금 덩이가 시작한 원문 자리
  let cut = 0                  // 앞 문장까지의 끝

  const push = (to: number) => {
    const slice = text.slice(from, to)
    const lead = slice.length - slice.trimStart().length
    const tail = slice.length - slice.trimEnd().length
    const body = slice.trim()
    if (body) {
      out.push({
        text: body,
        start: from + lead,
        end: to - tail,
        seconds: +(body.length / CHARS_PER_SECOND).toFixed(1),
      })
    }
    from = to
  }

  for (const end of sentenceEnds(text)) {
    const len = end - from
    if (len < min) { cut = end; continue }          // 아직 짧다 — 더 붙인다
    if (len <= max) { push(end); cut = end; continue }
    // 너무 길어졌다 — 앞 문장까지 끊고, 이 문장은 다음 덩이로 넘긴다.
    if (cut > from && cut - from >= min) { push(cut) }
    // 문장 하나가 통째로 최대치를 넘으면 그대로 둔다(가운데를 자르지 않는다).
    push(end)
    cut = end
  }
  if (from < text.length) push(text.length)
  return out
}

/** 이 자리(원문 글자 위치)를 품은 덩이의 번호. 없으면 -1. */
export function chunkAt(chunks: readonly Chunk[], charIndex: number): number {
  for (let i = 0; i < chunks.length; i++) {
    if (charIndex < chunks[i].end) return i
  }
  return chunks.length ? chunks.length - 1 : -1
}

/** 덩이 번호 → 원문 글자 자리. 화면이 지금 읽는 자리를 표시할 때 쓴다. */
export function charAt(chunks: readonly Chunk[], index: number): number {
  const c = chunks[index]
  return c ? c.start : 0
}

/** 전부 읽는 데 걸리는 어림 시간(초). */
export function totalSeconds(chunks: readonly Chunk[]): number {
  return +chunks.reduce((s, c) => s + c.seconds, 0).toFixed(1)
}
