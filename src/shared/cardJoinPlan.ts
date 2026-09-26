/**
 * 최종 음성 **연결 계획** — 무엇을 어떤 순서로 얼마나 띄워 붙일 것인가.
 *
 * ★미리 듣는 것과 파일로 저장하는 것이 **같은 계획**을 쓴다.
 *   계획을 두 군데서 만들면 언젠가 갈라지고, 그러면 들은 것과 저장된 것이 달라진다.
 *   그것이 가장 나쁜 실패다 — 사용자는 무엇을 믿어야 할지 알 수 없다.
 *
 * ★조용히 건너뛰지 않는다.
 *   채택이 없거나 파일이 사라진 카드가 있으면 **계획을 만들지 않고 이유를 돌려준다.**
 *   빠뜨린 채 이어 붙이면 사용자는 없어진 줄을 알아채지 못한다.
 *
 * ★말끝을 자르거나 발음을 겹치지 않는다.
 *   이 파일은 '어디에 얼마만큼의 빈 자리를 둘까' 만 정한다. 소리를 깎는 규칙은 없다.
 *
 * 이 파일은 판단만 한다 — 파일을 읽지도, 소리를 만들지도 않는다.
 */

export interface JoinCardInput {
  id: string
  label: string
  /** 사용자가 채택한 생성본. 없으면 null. */
  adopted: { id: string; path: string; missing?: boolean } | null
}

export interface JoinOptions {
  /** 기본 간격(초). */
  gap: number
  /** 인접 카드 쌍별 간격. 열쇠는 `앞id:뒤id`. */
  gaps: Record<string, number>
  /** 카드 사이 음량 차이를 줄인다. */
  level: boolean
  /** 접합부를 아주 짧게 다듬는다(말끝을 자르지 않는다). */
  edges: boolean
}

export interface JoinStep {
  cardId: string
  label: string
  path: string
  /** 이 조각 **앞에** 둘 빈 자리(초). 첫 조각은 0. */
  gapBefore: number
}

export interface JoinPlan {
  steps: JoinStep[]
  level: boolean
  edges: boolean
}

/** 이 카드가 최종 연결에 낄 수 없는 이유. 없으면 빈 문자열. */
export function cardJoinFault(c: JoinCardInput): string {
  if (!c.adopted) return '채택한 생성본이 없습니다'
  if (c.adopted.missing) return '채택한 생성본 파일이 사라졌습니다'
  if (!c.adopted.path) return '채택한 생성본에 파일이 없습니다'
  return ''
}

export interface JoinBlock {
  cardId: string
  label: string
  why: string
}

/** 간격 하나. 범위 밖은 자르되 **소리를 깎는 것이 아니라 빈 자리 길이**다. */
export const GAP_MIN = 0
export const GAP_MAX = 5
export function clampGap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
  return Math.min(GAP_MAX, Math.max(GAP_MIN, Math.round(n * 1000) / 1000))
}

/**
 * 연결 계획을 만든다. **하나라도 막히면 계획 대신 막힌 목록을 돌려준다.**
 */
export function buildJoinPlan(cards: JoinCardInput[], opts: JoinOptions):
  { plan: JoinPlan; blocks: [] } | { plan: null; blocks: JoinBlock[] } {
  if (!cards.length) {
    return { plan: null, blocks: [{ cardId: '', label: '', why: '카드가 없습니다' }] }
  }
  const blocks: JoinBlock[] = []
  for (const c of cards) {
    const why = cardJoinFault(c)
    if (why) blocks.push({ cardId: c.id, label: c.label, why })
  }
  if (blocks.length) return { plan: null, blocks }

  const base = clampGap(opts.gap)
  const steps: JoinStep[] = cards.map((c, i) => {
    if (i === 0) return { cardId: c.id, label: c.label, path: c.adopted!.path, gapBefore: 0 }
    const key = `${cards[i - 1].id}:${c.id}`
    const own = opts.gaps?.[key]
    return {
      cardId: c.id, label: c.label, path: c.adopted!.path,
      gapBefore: own === undefined ? base : clampGap(own),
    }
  })
  return { plan: { steps, level: !!opts.level, edges: !!opts.edges }, blocks: [] }
}

/**
 * 계획의 **지문** — 이것이 달라지면 이전 미리듣기를 다시 쓰지 않는다.
 *
 * ★순서·채택·간격·처리 옵션이 모두 들어간다. 하나라도 바뀌면 다른 지문이 된다.
 *   지문이 같은데 결과가 다르면 안 되고, 다른데 같은 결과를 보여 줘도 안 된다.
 */
export function joinPlanKey(plan: JoinPlan): string {
  return JSON.stringify([
    plan.steps.map((s) => [s.cardId, s.path, s.gapBefore]),
    plan.level, plan.edges,
  ])
}

/** 막힌 것들을 사람이 읽을 한 줄로. 화면은 이것을 그대로 보여 준다. */
export function joinBlockText(blocks: JoinBlock[]): string {
  if (!blocks.length) return ''
  const first = blocks[0]
  const rest = blocks.length - 1
  const who = first.label ? `'${first.label}'` : '카드'
  return rest > 0
    ? `${who} ${first.why} (외 ${rest}개)`
    : `${who} ${first.why}`
}
