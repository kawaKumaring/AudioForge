/**
 * 받아쓴 것을 **자막**으로 손질한다 — `python/subtitle_cues.py` 의 짝.
 *
 * ★왜 여기에도 있어야 하나(2026-09-24 감사)
 *   자막을 만드는 자리가 **넷**인데 셋은 파이썬이고 하나는 여기다.
 *   교정본 자막(`<base>_corrected.srt`)은 화면에서 만들어 본체가 바로 쓰므로
 *   파이썬을 거치지 않는다. 그래서 **그 하나만 손질을 건너뛰고 있었다.**
 *
 *   같은 폴더에 손질된 `<base>.srt` 와 손질 안 된 `<base>_corrected.srt` 가
 *   나란히 생겼다 — 고친 쪽이 한 줄이 길고, 스쳐 지나가고, 자막끼리 붙어 깜빡였다.
 *   사용자는 **고친 것이 더 나쁘다**는 것을 알 수 없다.
 *
 * ★두 곳에 두는 위험을 아는 채로 둔다
 *   저장이 파이썬을 거치지 않으므로 옮기는 수밖에 없다. 대신
 *   `subtitleCues.parity.test.ts` 가 **실제로 파이썬을 돌려 같은 답이 나오는지 대조**한다.
 *   예제를 양쪽에 따로 적는 방식은 이미 실패한 적이 있다 —
 *   역슬래시 예제가 양쪽 다 없어서 파일 이름 규칙이 갈라진 채 지나갔다(2026-09-24).
 *
 * 이 파일은 **계산만** 한다.
 */

// 한국어 자막의 통상값. 파이썬 쪽과 같아야 한다.
export const MAX_CPS = 14.0
export const MAX_LINE_CHARS = 20
export const MAX_LINES = 2
export const MIN_DURATION_SEC = 1.0
export const MAX_DURATION_SEC = 7.0
export const MIN_GAP_SEC = 0.08

// 라틴 문자 글의 상한(방송 통상값).
export const LATIN_MAX_CPS = 21.0
export const LATIN_MAX_LINE_CHARS = 42

// 글자당 정보가 빽빽한 문자 — 한글·가나·한자.
const DENSE_RANGES: Array<[number, number]> = [
  [0xac00, 0xd7a3], [0x1100, 0x11ff], [0x3040, 0x30ff],
  [0x4e00, 0x9fff], [0x3400, 0x4dbf],
]
export const DENSE_RATIO = 0.15

// 여기 뒤에서 끊으면 자연스럽다(조사·어미·문장부호).
const BREAK_AFTER = new Set([
  '。', '．', '.', '!', '?', '！', '？', ',', '，', '、',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '와', '과',
  '고', '며', '서', '만', '요', '다', '죠', '까',
])

export interface CueInput { start: number; end: number; text: string }
export interface Cue {
  start: number; end: number; text: string
  lines: string[]; cps: number | null; warnings: string[]
}

/** 파이썬 `str.isdigit()` · `str.strip()` 과 같은 뜻으로 쓴다. */
const isBlank = (c: string): boolean => /\s/.test(c)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

export function isDenseScript(text: string): boolean {
  const letters = [...(text || '')].filter((c) => !isBlank(c) && !isDigit(c))
  if (letters.length === 0) return false
  const dense = letters.filter((c) => {
    const n = c.codePointAt(0) as number
    return DENSE_RANGES.some(([lo, hi]) => n >= lo && n <= hi)
  }).length
  return dense >= letters.length * DENSE_RATIO
}

export function pickLimits(text: string): { maxCps: number; maxChars: number } {
  return isDenseScript(text)
    ? { maxCps: MAX_CPS, maxChars: MAX_LINE_CHARS }
    : { maxCps: LATIN_MAX_CPS, maxChars: LATIN_MAX_LINE_CHARS }
}

function findCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1)
  for (let i = window.length - 1; i > Math.floor(maxChars / 2); i--) {
    if (BREAK_AFTER.has(window[i - 1])) return i
  }
  const sp = window.lastIndexOf(' ')
  if (sp > Math.floor(maxChars / 2)) return sp
  return maxChars
}

/** 한 큐의 글을 줄로 나눈다. 낱말 가운데를 자르지 않고, **글자를 잃지 않는다.** */
export function wrapText(
  text: string, maxChars = MAX_LINE_CHARS, maxLines = MAX_LINES,
): string[] {
  const t = (text || '').split(/\s+/).filter(Boolean).join(' ')
  if (!t) return []
  if (t.length <= maxChars) return [t]

  const lines: string[] = []
  let rest = t
  while (rest && lines.length < maxLines) {
    if (rest.length <= maxChars) { lines.push(rest); rest = ''; break }
    const cut = findCut(rest, maxChars)
    lines.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  // 줄 수를 넘겼다 — 읽기는 불편해도 **내용이 사라지는 것보다 낫다.**
  if (rest) lines[lines.length - 1] = `${lines[lines.length - 1]} ${rest}`.trim()
  return lines
}

export function readingSpeed(text: string, durationSec: number): number | null {
  const n = (text || '').split(/\s+/).filter(Boolean).join(' ').length
  if (durationSec <= 0) return null
  return n / durationSec
}

export function buildCues(
  rows: CueInput[],
  opts: {
    maxCps?: number; maxChars?: number; maxLines?: number
    minSec?: number; maxSec?: number; minGap?: number
  } = {},
): Cue[] {
  const maxCps = opts.maxCps ?? MAX_CPS
  const maxChars = opts.maxChars ?? MAX_LINE_CHARS
  const maxLines = opts.maxLines ?? MAX_LINES
  const minSec = opts.minSec ?? MIN_DURATION_SEC
  const maxSec = opts.maxSec ?? MAX_DURATION_SEC
  const minGap = opts.minGap ?? MIN_GAP_SEC

  const out: Cue[] = []
  for (const r of rows || []) {
    const text = (r?.text || '').split(/\s+/).filter(Boolean).join(' ')
    if (!text) continue
    const start = Number(r.start)
    const end = Number(r.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`${out.length + 1}번째 줄의 시각을 읽지 못했습니다`)
    }
    out.push({
      start, end: Math.max(end, start), text,
      lines: wrapText(text, maxChars, maxLines), cps: null, warnings: [],
    })
  }

  for (let i = 0; i < out.length; i++) {
    const cue = out[i]
    const nxt = i + 1 < out.length ? out[i + 1].start : null
    const dur = cue.end - cue.start

    if (dur < minSec) {
      const room = nxt === null ? null : nxt - minGap - cue.start
      const want = cue.start + minSec
      cue.end = room === null ? want : Math.min(want, Math.max(cue.start, room))
      if (cue.end - cue.start < minSec - 1e-6) {
        cue.warnings.push(`다음 자막이 바짝 붙어 ${(cue.end - cue.start).toFixed(1)}초밖에 못 띄웁니다`)
      }
    } else if (dur > maxSec) {
      cue.end = cue.start + maxSec
    }

    if (nxt !== null && cue.end > nxt - minGap) {
      cue.end = Math.max(cue.start, nxt - minGap)
    }

    const cps = readingSpeed(cue.text, cue.end - cue.start)
    cue.cps = cps
    if (cps !== null && cps > maxCps) {
      cue.warnings.push(
        `초당 ${cps.toFixed(1)}자로 빠릅니다(상한 ${maxCps.toFixed(0)}) — 글을 줄이면 읽기 좋아집니다`)
    }
    if (cue.lines.length > maxLines) {
      cue.warnings.push(`${cue.lines.length}줄이라 화면을 많이 가립니다`)
    }
  }
  return out
}

/** 자막 파일 글. 시각 표기 함수는 **받아서 쓴다** — 같은 계산을 두 곳에 두지 않는다. */
export function toSrt(cues: Cue[], stamp: (t: number) => string): string {
  const out: string[] = []
  cues.forEach((cue, i) => {
    out.push(String(i + 1))
    out.push(`${stamp(cue.start)} --> ${stamp(cue.end)}`)
    out.push(...cue.lines)
    out.push('')
  })
  return out.join('\n')
}
