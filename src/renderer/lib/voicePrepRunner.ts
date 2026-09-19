/**
 * 목소리 준비를 **실제로 돌리는 곳** — 화면 밖.
 *
 * 왜(2026-09-19, 소유자 단일화 2단계): 지금까지 준비를 시작하는 유일한 방법은 구간 편집기 부품을 화면에
 * 띄우는 것이었다. 그래서 도구가 필요 없는 자리는 같은 부품을 **숨겨서** 띄웠고(드라이버 셋), 준비의 수명이
 * 화면 부품의 수명에 묶였다 — 탭을 옮기면 끊기고, 부품이 둘 뜨면 판정도 둘이 되고, 자기 진행 보고 때문에
 * 자기가 언마운트되는 일까지 있었다(2026-09-08 실측). 이제 준비는 **함수를 부르면** 돈다.
 *
 * 판정은 하지 않는다 — 그것은 `shared/voicePreparation` 의 몫이다(1단계). 이 파일은 그 판정을 따라
 * 파이썬을 부르고 결과를 보고할 뿐이다.
 *
 * 규칙
 *   · **한 번에 하나만** 돈다. 파이썬 통로가 하나이기 때문이다(줄을 세운다).
 *   · 같은 (자리·파일·요청)은 **한 번만** 돈다. 이 기억이 React 밖에 있으므로 화면이 다시 마운트돼도
 *     다시 돌지 않는다 — 예전에는 부품 안의 ref 였고, 그래서 재마운트마다 되풀이됐다.
 *   · 늦게 온 결과는 버린다(자리마다 세대 번호). 취소는 세대를 올린다.
 *   · 실패해도 **다시 시도하지 않는다.** 사유를 보고하고 끝낸다 — 실패→재시도→실패의 순환을 만들지 않는다.
 */
import {
  decideAfterAnalysis, decideAfterTrim, decideAutoConfirm,
  type CommittedRef, type ReferenceAnalysis, type RefStatePatch,
// node --test 가 이 파일을 곧바로 읽으므로 확장자를 붙인다(app.store 와 같은 관례).
// @ts-ignore TS5097
} from '../../shared/voicePreparation.ts'
// @ts-ignore TS5097
import type { ReferencePolicySummary } from '../../shared/referencePolicy.ts'

export interface VoicePrepJob {
  /** 파생 클립이 사는 자리. 'default' | 'lab' | 'spk:<id>' — 자리 하나당 폴더 하나다. */
  clipKey: string
  /** 원본 음성 경로. */
  path: string
  /** 이 요청의 식별자. 늦은 결과를 store 가 버리는 기준이기도 하다. */
  reqId: string
  engine: string
  refTargetSec: number
  /** 쉬운 말 화면인가(일반). */
  plain: boolean
  /**
   * 지금 쓰고 있는 목소리 — **함수로 받는다.** 분석은 비동기라 결과가 도착한 시점에 다시 읽어야 한다.
   * 시작 시점 값을 붙들면 그 사이 준비된 목소리를 '아직 미준비' 로 판단해 되돌린다(2026-09-09 실측).
   */
  committedNow: () => CommittedRef | null
  /** 준비 상태 보고. store 리듀서로 그대로 간다(요청 식별자는 여기서 붙인다). */
  report: (patch: RefStatePatch) => void
  /** 이 분석이 정한 길이 정책 — 카드·자산 판정이 같은 값을 보게 store 에 올린다. */
  onPolicy?: (p: ReferencePolicySummary) => void
}

export type VoicePrepOutcome =
  | 'ready'          // 준비됐다
  | 'needs_region'   // 사용자가 구간을 골라야 한다
  | 'failed'         // 이 파일로는 안 된다
  | 'kept'           // 확정에 실패했지만 쓰던 목소리를 그대로 쓴다
  | 'cancelled'      // 취소됐거나 낡은 요청이 됐다
  | 'skipped'        // 이미 같은 요청을 돌렸다

interface Slot {
  gen: number
  /** 이미 시작한 (자리·파일·요청) 열쇠들. 화면 재마운트로 초기화되지 않는다. */
  started: Set<string>
}

const slots = new Map<string, Slot>()
/** 파이썬 통로가 하나이므로 줄을 세운다. */
let lane: Promise<unknown> = Promise.resolve()

function slotOf(clipKey: string): Slot {
  let s = slots.get(clipKey)
  if (!s) { s = { gen: 0, started: new Set() }; slots.set(clipKey, s) }
  return s
}

/**
 * '이미 돌린 요청' 을 가르는 열쇠.
 *
 * ★엔진과 목표 길이가 들어간다. 그 둘이 바뀌면 추천 구간이 달라지므로 **다시 물어야 한다**
 *   (예전 패널의 재분석 조건과 같다). 빠뜨리면 엔진을 바꿔도 옛 판정을 그대로 쓰게 된다.
 * 구분자로 잇지 않는다 — 인물 이름도 경로도 어떤 글자든 담을 수 있다. JSON 은 애매함이 없다.
 */
function jobKey(job: Pick<VoicePrepJob, 'clipKey' | 'path' | 'reqId' | 'engine' | 'refTargetSec'>): string {
  return JSON.stringify([job.clipKey, job.path, job.reqId, job.engine, job.refTargetSec])
}

/** 이 자리의 진행 중 작업을 무효화한다(늦게 오는 결과는 버려진다). 같은 요청을 다시 돌릴 수 있게 된다. */
export function cancelVoicePrep(clipKey: string): void {
  const s = slots.get(clipKey)
  if (!s) return
  s.gen += 1
  s.started.clear()
}

/** 이 자리에서 이미 돌린 기억을 지운다 — '다시 준비' 가 같은 파일로 처음부터 돌 수 있게. */
export function forgetVoicePrep(clipKey: string): void {
  slots.get(clipKey)?.started.clear()
}

/** 검사·진단용 — 이 자리가 이미 돌린 요청인가. */
export function voicePrepStarted(job: Pick<VoicePrepJob, 'clipKey' | 'path' | 'reqId' | 'engine' | 'refTargetSec'>): boolean {
  return !!slots.get(job.clipKey)?.started.has(jobKey(job))
}

/**
 * 준비를 돌린다. 같은 (자리·파일·요청)이 이미 돌았으면 아무것도 하지 않는다.
 *
 * 끝나는 시점은 **성공·실패·해당 없음 모두**에서 정확히 한 번이다. 부르는 쪽은 그것만 알면 된다
 * (예전에는 부품의 `onAutoConfirmSettled` 신호가 그 역할을 했다).
 */
export function runVoicePrep(job: VoicePrepJob): Promise<VoicePrepOutcome> {
  if (!job.path || !job.clipKey) return Promise.resolve('skipped')
  const slot = slotOf(job.clipKey)
  const key = jobKey(job)
  if (slot.started.has(key)) return Promise.resolve('skipped')
  slot.started.add(key)
  const gen = slot.gen
  const stale = () => slotOf(job.clipKey).gen !== gen

  const run = async (): Promise<VoicePrepOutcome> => {
    if (stale()) return 'cancelled'
    const report = (p: RefStatePatch) => { if (!stale()) job.report({ ...p, reqId: job.reqId }) }

    // 쓰고 있는 목소리가 없을 때만 '준비 중' 을 올린다 — 있으면 그것을 내리지 않는다.
    if (!job.committedNow()) {
      report({ phase: 'preparing', clip: '', region: null,
        message: job.plain ? '목소리를 살펴보는 중입니다…' : '참조 음성을 분석 중입니다...' })
    }

    let analysis: ReferenceAnalysis
    try {
      const a = await window.api.audio.analyzeReference(job.path, job.clipKey,
        { ttsEngine: job.engine, regionTargetSec: job.refTargetSec }) as ReferenceAnalysis & { error_message?: string; reason?: string }
      if (stale()) return 'cancelled'
      if (!a || typeof a.duration_sec !== 'number') {
        throw new Error(a?.error_message || a?.reason || '참조 분석 결과가 올바르지 않습니다')
      }
      analysis = a
    } catch (e) {
      if (stale()) return 'cancelled'
      const msg = (e as Error)?.message || '참조 분석 실패'
      report({ phase: 'failed', clip: '', region: null,
        message: job.plain ? '이 파일에서 목소리를 확인하지 못했습니다.' : `참조 분석 실패: ${msg}` })
      return 'failed'
    }

    const decision = decideAfterAnalysis({
      analysis,
      committed: job.committedNow(),      // ★결과가 도착한 지금의 값
      autoConfirm: true,                  // 이 실행부는 도구를 그리지 않는다 — 추천 구간을 대신 확정한다
      plain: job.plain,
    })
    job.onPolicy?.(decision.policy)
    for (const p of decision.patches) report(p)

    const auto = decideAutoConfirm({
      autoConfirm: true,
      hasCommitted: !!job.committedNow(),
      analyzeError: false,
      analysis,
      policy: decision.policy,
    })
    if (auto.kind === 'wait' || auto.kind === 'settle') {
      // 더 할 일이 없다. 마지막으로 올린 보고가 이 자리의 결론이다.
      return decision.patches.some((p) => p.phase === 'failed') ? 'failed'
        : decision.patches.some((p) => p.phase === 'needs_region') ? 'needs_region' : 'ready'
    }
    if (auto.kind === 'needs-region') {
      if (!job.committedNow()) report(auto.patch)
      return 'needs_region'
    }

    try {
      const raw = await window.api.audio.trimReference(job.path, auto.start, auto.dur, job.clipKey,
        { ttsEngine: job.engine }) as Record<string, unknown>
      if (stale()) return 'cancelled'
      const t = decideAfterTrim(raw, {
        hasCommitted: !!job.committedNow(), policy: decision.policy, plain: job.plain,
      })
      if (t.kind === 'ready') { report({ phase: 'ready', clip: t.clip, message: '', region: t.region }); return 'ready' }
      if (t.kind === 'kept') return 'kept'      // 쓰던 목소리를 그대로 둔다(보고하지 않는다)
      report(t.patch)
      return t.patch.phase === 'needs_region' ? 'needs_region' : 'failed'
    } catch (e) {
      if (stale()) return 'cancelled'
      if (job.committedNow()) return 'kept'     // 쓰던 목소리가 있으면 그것을 지킨다
      report({ phase: 'failed', clip: '', region: null,
        message: job.plain ? '목소리 구간을 준비하지 못했습니다. 다시 시도해 주세요.'
          : `파생 참조 생성 실패: ${(e as Error)?.message || ''}` })
      return 'failed'
    }
  }

  // 줄 세우기 — 앞 작업이 끝난 뒤에 시작한다. 앞 작업의 실패가 뒤를 막지 않는다.
  const queued = lane.then(run, run)
  lane = queued.catch(() => {})
  return queued
}
