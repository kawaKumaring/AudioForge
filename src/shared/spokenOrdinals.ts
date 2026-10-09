/**
 * **숫자 서수 읽기 보정** — 한 곳의 규칙(2026-10-09). 파이썬 짝은 `python/spoken_ordinals.py`,
 * 두 쪽이 같은 답을 내는지는 `spokenOrdinals.cases.json` 한 벌로 둘 다 검사한다.
 *
 * ★왜: 서수 비교 실험(대사 1개·참조 1개·seed 42, doc/synthesis-ordinal-experiment-2026-10-04.md)에서
 *   Qwen 이 "7번째" 를 "칠 일 번째" 로 읽고 "일곱 번째" 는 바르게 읽었다. 근거는 그것뿐이라 **1~99 의 '숫자+번째'만** 바꾼다.
 *   수량(개·명)·100 이상·소수·날짜·시각·금액·식별자는 그대로 둔다. 구현 범위일 뿐 음질 검증 완료 범위가 아니다.
 *
 * ★원문은 바꾸지 않는다 — 소리로 보낼 글만 만든다. 바꾼 자리는 원문 좌표(start/end)로 돌려준다.
 *
 * 토큰 경계(원문 기준 — 기호 정리 **전에** 본다. 정리 뒤에는 "2~7번째" 가 "2에서 7번째" 가 되어 경계가 사라진다)
 *   - 숫자 토큰 = ASCII 숫자 [0-9] 의 최대 연속. 앞자리 0(07)·100 이상·전각 숫자는 바꾸지 않는다.
 *   - 토큰 바로 앞 글자가 글자·숫자(제7·A7·१७) 또는 아래 부호면 바꾸지 않는다:
 *       . , : ' ’ - ‐ ‑ ‒ – — ― − ~ ～ 〜 + ± / # _ % $ ₩ € £ ¥ @ & * ^ =
 *   - 띄어쓰기를 건너 바로 앞이 범위·부호 기호(- ‐ ‑ ‒ – — ― − ~ ～ 〜 + ±)여도 바꾸지 않는다("2 - 7번째", "2 ~ 7번째").
 *   - 토큰 뒤는 띄어쓰기 0~1칸(U+0020) + "번째" 만. 그 밖("7번", "7 번 째", "7번째의" 앞부분 이외)은 그대로.
 *   - 바꾼 결과는 늘 "<고유어 관형형> 번째" (가운데 띄어쓰기 하나).
 *
 * 읽기(고유어 관형형 + 번째)
 *   - 1 → 첫 번째(한 번째 아님). 2~9 → 두·세·네·다섯·여섯·일곱·여덟·아홉.
 *   - 10 → 열. 11~19 → 열한·열두·열세·열네·열다섯 … 열아홉(1 은 복합에서 '한').
 *   - 20 → **스무**(홀로일 때만). 21~29 → **스물**한·스물두 … (복합에서는 스물).
 *   - 30 서른 · 40 마흔 · 50 쉰 · 60 예순 · 70 일흔 · 80 여든 · 90 아흔, 뒤에 한·두·세·네·다섯 … 아홉.
 */

export const ORDINAL_RULE = 'ordinal-ko-v1'

export interface OrdinalChange {
  /** 원문 안 시작·끝(끝 미포함) — 숫자부터 "번째" 끝까지. */
  start: number; end: number
  original: string
  spoken: string
}

const UNIT_ALONE = ['', '첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉']
const UNIT_IN = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉']
const TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔']

/** 1~99 → 서수 관형형. 범위 밖은 null. */
export function ordinalWord(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null
  const t = Math.floor(n / 10), u = n % 10
  if (t === 0) return UNIT_ALONE[u]
  if (n === 20) return '스무'
  return TENS[t] + UNIT_IN[u]
}

const BLOCK_BEFORE = new Set(".,:'’-‐‑‒–—―−~～〜+±/#_%$₩€£¥@&*^=".split(''))
const RANGE_SIGN = new Set('-‐‑‒–—―−~～〜+±'.split(''))
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const TOKEN = /[0-9]+/g

/**
 * 덩이 앞에서 판정에 필요한 **경계 정보만** 원문에서 정확히 잘라 낸다(2026-10-09 재검수).
 * 판정이 앞을 보는 것은 ① 바로 앞 글자 ② 띄어쓰기·탭을 건넌 가장 가까운 글자 — 둘뿐이다.
 * 그래서 띄어쓰기 줄을 끝까지 거슬러 가 ②부터 덩이 시작 바로 앞까지를 돌려준다(띄어쓰기 길이와 무관하게 정확, 책 전체를 훑지 않는다).
 * ★예전처럼 앞 N글자로 자르지 않는다 — 띄어쓰기가 N 보다 길면 ②를 못 보고 문서 처음으로 오인해 범위 기호 뒤 숫자를 바꿨다.
 * 돌려준 글에 ②가 없다면(띄어쓰기뿐이거나 빈 글) 그 앞은 **실제로 문서 처음**이다.
 */
export function ordinalContextBefore(doc: string, start: number): string {
  let k = Math.max(0, Math.min(start, doc.length))
  const end = k
  while (k > 0 && (doc[k - 1] === ' ' || doc[k - 1] === '\t')) k--
  return doc.slice(Math.max(0, k - 1), end)
}

/**
 * 원문에서 바꿀 서수 자리를 찾는다(원문 좌표). 원문은 건드리지 않는다.
 * before = 이 글 바로 앞의 경계 정보 — **ordinalContextBefore(문서, 덩이 시작)** 로 만든다(자르지 않고 그대로 쓴다).
 *   덩이가 "1." 뒤에서 갈려도 "7번째" 의 앞이 '.' 임을 안다. 끝 쪽은 문맥이 필요 없다(토큰 + "번째" 가 덩이 안에 다 있어야 바꾼다).
 */
export function findOrdinals(text: string, before = ''): OrdinalChange[] {
  if (before) {
    const ctx = before
    return findOrdinals(ctx + text).filter((c) => c.start >= ctx.length)
      .map((c) => ({ ...c, start: c.start - ctx.length, end: c.end - ctx.length }))
  }
  const out: OrdinalChange[] = []
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text))) {
    const digits = m[0], start = m.index
    if (digits.length > 2 || digits[0] === '0') continue
    const before = start > 0 ? text[start - 1] : ''
    if (before && (LETTER_OR_DIGIT.test(before) || BLOCK_BEFORE.has(before))) continue
    let k = start - 1
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--
    if (k >= 0 && k < start - 1 && RANGE_SIGN.has(text[k])) continue
    let j = start + digits.length
    if (text[j] === ' ') j++
    if (text.slice(j, j + 2) !== '번째') continue
    const word = ordinalWord(Number(digits))
    if (!word) continue
    out.push({ start, end: j + 2, original: text.slice(start, j + 2), spoken: `${word} 번째` })
  }
  return out
}

/**
 * [from, to) 원문 구간을 소리로 보낼 글로 — 그 구간 **안에 통째로 든** 바꿀 자리만 바꾼다.
 * 경계는 덩이 전체에서 미리 찾은 것(changes)을 쓴다 — 구절로 잘라 낸 뒤에 찾으면 "1.7번째" 의 7 이 구절 맨 앞이 되어 경계를 잃는다.
 */
export function applyOrdinals(text: string, from: number, to: number, changes: readonly OrdinalChange[]): { text: string; applied: number } {
  let s = '', at = from, applied = 0
  for (const c of changes) {
    if (c.start < from || c.end > to) continue
    s += text.slice(at, c.start) + c.spoken
    at = c.end
    applied++
  }
  return { text: s + text.slice(at, to), applied }
}

/** 글 하나 전체를 한 번에(카드·검사용). */
export function spokenOrdinals(text: string, before = ''): { text: string; changes: OrdinalChange[] } {
  const changes = findOrdinals(text, before)
  return { text: applyOrdinals(text, 0, text.length, changes).text, changes }
}
