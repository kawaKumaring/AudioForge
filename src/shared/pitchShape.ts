/**
 * 음높이 곡선을 손잡이로 빚는다 — **화면 쪽 구현.**
 *
 * ★왜 같은 것이 둘 있나
 *   손잡이를 움직일 때마다 파이썬을 부르면 느려서, 보는 동안 화면이 끊긴다.
 *   그래서 화면에도 같은 계산을 둔다.
 *
 * ★★그래서 **반드시** 두 구현이 같은 답을 내야 한다.
 *   갈라지면 사람이 보고 맞춘 모양과 실제로 소리에 먹는 모양이 달라진다 —
 *   맞췄다고 생각하고 전곡을 뽑았는데 딴 소리가 나오는 것이 최악이다.
 *   `test/fixtures/pitch-shape-vectors.json` 의 본보기 40개로 양쪽을 묶어 둔다.
 *   파이썬(`python/pitch_shape.py`)이 원본이고 이 파일이 따라간다.
 *
 * 손잡이는 셋뿐이다 — **편다 · 폭 · 옮김**. 점을 하나하나 찍는 편집이 아니다.
 * 적어야 사람이 감으로 맞출 수 있다(2026-09-26 사용자 설계: "그래프 맞추기 미니게임").
 */

/** 소리가 없던 자리는 `null` 이다. 0 이 아니라 null 인 이유: 0Hz 는 '아주 낮은 음'이 아니다. */
export type Curve = Array<number | null>

export interface Knobs {
  /** 들쑥날쑥한 자리를 편다. 0 = 그대로, 1 = 가장 부드럽게. */
  smooth: number
  /** 곡선의 폭. 1 = 그대로, 크면 벌어진다. */
  spread: number
  /** 통째로 올리거나 내린다(반음). */
  shift: number
}

export const NEUTRAL: Knobs = { smooth: 0, spread: 1, shift: 0 }

export const REF_HZ = 55
export const MAX_SMOOTH = 1
export const MAX_SPREAD = 3

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

/** Hz → 반음. 음악은 비율로 들리므로 로그가 맞다. 소리 없는 자리는 null. */
export function toSemitones(hz: Array<number | null | undefined>): Curve {
  return hz.map((v) => {
    const f = Number(v)
    return Number.isFinite(f) && f > 0 ? 12 * Math.log2(f / REF_HZ) : null
  })
}

/** 반음 → Hz. null 은 0 — '소리 없음'을 지어내지 않는다. */
export function toHz(semi: Curve): number[] {
  return semi.map((s) => (s === null ? 0 : REF_HZ * Math.pow(2, s / 12)))
}

/**
 * 이어진 구간들. 소리 없는 자리에서 끊는다.
 * ★끊지 않으면 **쉬는 자리를 가로질러** 곡선이 이어져, 원본에 없던 소리를 만든다.
 */
function runs(values: Curve): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let start: number | null = null
  values.forEach((v, i) => {
    if (v === null) {
      if (start !== null) { spans.push([start, i]); start = null }
    } else if (start === null) start = i
  })
  if (start !== null) spans.push([start, values.length])
  return spans
}

/**
 * 들쑥날쑥한 자리를 편다.
 * ★중앙값을 쓴다. 평균은 튄 점 하나에 끌려가 **주변까지 함께 망가뜨린다** —
 *   찢어지는 음을 다루는 일이라 그러면 안 된다.
 */
export function smooth(values: Curve, amount: number): Curve {
  const a = clamp(Number(amount) || 0, 0, MAX_SMOOTH)
  if (a <= 0) return [...values]
  const width = 1 + 2 * Math.round(a * 10)
  const out = [...values]
  for (const [lo, hi] of runs(values)) {
    const seg = values.slice(lo, hi) as number[]
    for (let i = 0; i < seg.length; i++) {
      const j0 = Math.max(0, i - (width >> 1))
      const j1 = Math.min(seg.length, i + (width >> 1) + 1)
      const win = seg.slice(j0, j1).slice().sort((x, y) => x - y)
      out[lo + i] = win[win.length >> 1]
    }
  }
  return out
}

/** 폭을 넓히거나 좁힌다. 가운데(중앙값)를 축으로 — 축이 흔들리면 조가 바뀐다. */
export function spread(values: Curve, factor: number): Curve {
  const f = clamp(Number(factor), 0, MAX_SPREAD)
  const live = values.filter((v): v is number => v !== null)
  if (!live.length || f === 1) return [...values]
  const sorted = live.slice().sort((a, b) => a - b)
  const center = sorted[sorted.length >> 1]
  return values.map((v) => (v === null ? null : center + (v - center) * f))
}

/** 통째로 올리거나 내린다(반음). */
export function shift(values: Curve, semitones: number): Curve {
  const s = Number(semitones) || 0
  if (s === 0) return [...values]
  return values.map((v) => (v === null ? null : v + s))
}

/**
 * 손잡이를 순서대로 먹인다: **편다 → 폭 → 옮김.**
 * ★순서가 중요하다. 튄 점을 먼저 펴지 않고 폭을 벌리면 튄 점까지 같이 커진다.
 */
export function applyKnobs(values: Curve, knobs?: Partial<Knobs>): Curve {
  const k: Knobs = { ...NEUTRAL, ...(knobs ?? {}) }
  return shift(spread(smooth(values, k.smooth), k.spread), k.shift)
}

/**
 * 두 곡선이 얼마나 겹치는가. 1 이면 똑같다.
 * 둘 다 소리가 있는 자리만 견준다 — 한쪽만 소리가 있는 자리는 빚어서 될 일이 아니다.
 */
export function similarity(target: Curve, current: Curve): number {
  let sum = 0
  let n = 0
  const len = Math.min(target.length, current.length)
  for (let i = 0; i < len; i++) {
    const a = target[i]
    const b = current[i]
    if (a !== null && b !== null) { sum += Math.abs(a - b); n += 1 }
  }
  return n ? 1 / (1 + sum / n) : 0
}
