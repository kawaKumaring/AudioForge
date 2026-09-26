/**
 * 목소리 준비의 **판정 규칙** — 화면 밖 순수 함수.
 *
 * 왜 여기로 옮겼나(2026-09-19, 소유자 단일화 1단계): 이 규칙들은 `ReferenceRegionPanel`(1,011줄) 안에
 * 화면 상태와 섞여 있었다. 규칙 하나하나가 실측 결함의 흔적인데(늦게 온 분석이 준비를 되돌림 / 자동 확정이
 * '준비 중' 에서 멈춤 / 문구로 승인 판정 / 형식 불일치를 승인으로 읽음), **화면 밖에서는 시험할 수 없어
 * 앱을 띄우는 검사로만 지켜졌다.** 규칙을 밖으로 내면 같은 결함을 단위 검사로 고정할 수 있다.
 *
 * 이 파일이 하는 것: 입력(분석 결과·사용 중 구간·정책·모드)을 보고 **무엇을 보고할지** 정한다.
 * 이 파일이 하지 않는 것: IPC 호출, 상태 변경, 화면 그리기, 시간(타이머). 부수효과는 전부 호출부의 몫이다.
 *
 * 설계 문서: `doc/work-in-progress/voice-preparation-owner.md`
 */
import {
  clampDuration, judgeLength, committedMismatchText, regionNeedText, tooShortText,
  blockMessage, phaseForBlocking, policyFromAnalysis,
  type ReferencePolicySummary, type RefPhase,
// node --test 가 이 파일을 곧바로 읽으므로 확장자를 붙인다(app.store 와 같은 관례).
// @ts-ignore TS5097
} from './referencePolicy.ts'

/** 아직 확정하지 않아 합성이 막혔을 때, 무엇을 눌러야 하는지. 사유의 맨 앞에 둔다. */
export const ACTION_CONFIRM = "아래에서 '이 구간으로 확정' 을 눌러야 합성을 시작할 수 있습니다."

export interface ReferenceSpan {
  start_sec: number
  end_sec: number
  dur_sec: number
}

export interface ReferenceAnalysis {
  duration_sec: number
  // 파이썬이 늘 실어 보낸다(화면이 그대로 표시한다) — 예전 타입도 필수였다.
  sample_rate: number
  channels: number
  /** 구간을 추천한다(필수 상한이 있으면 그것, 없으면 권장 상한을 넘었을 때). */
  needs_region: boolean
  /** 필수 상한 초과 — 자르지 않으면 이 엔진이 쓸 수 없다. */
  region_required?: boolean
  too_short: boolean
  outside_recommended?: boolean
  valid_whole: boolean
  policy?: ReferencePolicySummary
  errors?: { code: string; message: string }[]
  warnings?: { code: string; message: string }[]
  recommend?: { ok: boolean; start_sec: number; dur_sec: number; whole_file?: boolean }
  peaks?: { peaks: number[]; duration_sec: number }
}

export interface ReferenceRegionMetrics {
  dur_sec?: number
  blocking?: string[]
  ready?: boolean
  requested_region?: ReferenceSpan
  /** 실제 파생 WAV·모델 입력에 쓰인 구간. **확정 region 의 재현 권위는 이쪽이다.** */
  effective_region?: ReferenceSpan
  [k: string]: unknown
}

/** 상위(store 슬롯)로 올리는 준비 상태 패치. 기본·감정·인물·일반이 같은 모양을 쓴다. */
export interface RefStatePatch {
  clip?: string
  message?: string
  region?: { start: number; duration: number } | null
  /** 이 보고를 만든 요청. 상위가 낡은 보고를 버리는 기준(패널이 자동으로 붙인다). */
  reqId?: string
  /** 준비 단계 — **문구가 아니라 이 값이 판정 근거다**(2026-09-09 관리자 검수). */
  phase?: RefPhase
}

/** 지금 쓰고 있는 목소리. `whole` 은 원본 전체를 그대로 참조로 쓰는 준비 상태(클립·구간 없음). */
export interface CommittedRef {
  clip: string
  region: { start: number; duration: number } | null
  whole?: boolean
}

/**
 * 쓰고 있는 목소리가 있는가. 재분석·재확정 실패가 이것을 내리지 않는다 — 준비된 목소리는 보존한다.
 */
export function hasCommittedRef(c: CommittedRef | null | undefined): boolean {
  return !!(c && (c.clip || c.region || c.whole))
}

/** effective_region 이 재현 권위이므로 형식이 어긋나면 승인하지 않는다(fail-closed). */
export function validSpan(r: ReferenceSpan | undefined): r is ReferenceSpan {
  return !!r && [r.start_sec, r.end_sec, r.dur_sec].every((v) => typeof v === 'number' && Number.isFinite(v))
    && r.end_sec > r.start_sec && r.dur_sec > 0
}

// ── 분석 결과 판정 ────────────────────────────────────────────────────────────

export interface AnalysisDecisionInput {
  analysis: ReferenceAnalysis
  /**
   * **결과가 도착한 지금의** 사용 중 상태(2026-09-09 관리자 검수). 요청을 시작한 시점의 값을 쓰면,
   * 그 사이 준비된 목소리를 낡은 값이 '아직 미준비' 로 판단해 되돌린다 — 실측으로 그 일이 났다.
   */
  committed: CommittedRef | null
  /** 추천 구간으로 자동 확정이 뒤따르는가. 뒤따르면 '진행 중', 아니면 사용자가 눌러야 한다. */
  autoConfirm: boolean
  /** 쉬운 말 화면인가(일반). 안전 오류 문구는 어느 쪽에서도 바꾸지 않는다. */
  plain: boolean
}

export interface AnalysisDecision {
  /** 이 분석이 정한 길이 정책. 호출부가 store 에 올려 카드·자산 판정이 같은 값을 보게 한다. */
  policy: ReferencePolicySummary
  /** 슬라이더에 **심을** 값(사용자가 움직인 것이 아니다 — '구간 변경' 으로 보면 안 된다). */
  seed: { start: number; dur: number } | null
  /**
   * 화면에 보일 '실제 구간'. 사용 중 구간을 되살릴 때만 채워진다.
   * ★end_sec 이 없다 — 예전 구현이 그랬고, 이 값은 표시에만 쓰인다(재현 권위는 트림 응답이다).
   */
  effective: { start_sec: number; dur_sec: number } | null
  /** 사용 중 클립을 그대로 이어 쓸 때 그 경로. 없으면 null(빈 문자열로 내리지 않는다). */
  confirmedClip: string | null
  /** 올릴 보고들. 순서대로 그대로 올린다(빈 배열이면 아무것도 보고하지 않는다). */
  patches: RefStatePatch[]
}

function say(plain: boolean, expert: string, plainText: string): string {
  return plain ? plainText : expert
}

/**
 * 분석 결과 하나를 보고 무엇을 보고할지 정한다.
 *
 * 순서와 조건은 예전 구현 그대로다 — 이 함수의 목적은 규칙을 바꾸는 것이 아니라 **시험 가능한 자리로
 * 옮기는 것**이다. 조건 하나하나가 실측 결함의 흔적이라 바꾸면 그 결함이 돌아온다.
 */
export function decideAfterAnalysis(input: AnalysisDecisionInput): AnalysisDecision {
  const { analysis: a, committed, autoConfirm, plain } = input
  const pol = policyFromAnalysis(a)
  const committedThen = hasCommittedRef(committed)
  const out: AnalysisDecision = { policy: pol, seed: null, effective: null, confirmedClip: null, patches: [] }

  if (a.too_short) {
    out.patches.push({ phase: 'failed', clip: '', message: tooShortText(pol, a.duration_sec), region: null })
    return out
  }

  if (a.needs_region) {
    const r = a.recommend
    if (committedThen && committed?.region) {
      // 슬라이더는 사용 중인 구간에서 시작한다. 전체 원본 범위 안에서 자유롭게 넓힐 수 있다.
      const cd = clampDuration(pol, a.duration_sec, committed.region.duration)
      out.seed = { start: committed.region.start, dur: cd }
      out.effective = { start_sec: committed.region.start, dur_sec: committed.region.duration }
      if (committed.clip) out.confirmedClip = committed.clip
      // 엔진 전환 재판정: 사용 중 구간이 새 엔진의 **필수** 조건 밖이면 준비를 내리고 사유만 알린다.
      // 클립·구간은 그대로 둔다(다른 목소리로 바꾸거나 다시 자르지 않는다). 권장 밖은 경고만(준비 유지).
      const j = judgeLength(pol, committed.region.duration)
      if (j === 'blocked_short' || j === 'blocked_long') {
        out.patches.push({
          phase: 'needs_region', clip: committed.clip, region: committed.region,
          message: committedMismatchText(pol, committed.region.duration),
        })
      }
    } else if (r && r.ok) {
      out.seed = { start: r.start_sec, dur: clampDuration(pol, a.duration_sec, r.dur_sec) }
    }
    if (committedThen && committed?.whole && a.region_required) {
      // 원본 전체를 쓰던 상태인데 새 엔진 정책이 구간을 필수로 요구한다 — 사유만 안내(교체·삭제 없음).
      out.patches.push({
        phase: 'needs_region', clip: '', region: null,
        message: regionNeedText(pol, a.duration_sec, true),
      })
    }
    if (!committedThen) {
      // ★이 문구는 시작 단추의 **막힌 사유**로 그대로 나간다. 길이 안내만 적어 두면 "왜 못 만드는지" 가
      //   아니라 "참고 사항" 처럼 읽힌다(실측 보고). 사용자가 눌러야 하면 그 사실을 함께 말한다.
      const mustConfirm = !autoConfirm
      const need = regionNeedText(pol, a.duration_sec, !!a.region_required)
      out.patches.push({
        phase: autoConfirm ? 'preparing' : 'needs_region', clip: '',
        message: say(plain,
          mustConfirm ? ACTION_CONFIRM + ' ' + need : need,
          mustConfirm ? ACTION_CONFIRM : '목소리에서 쓸 부분을 고르는 중입니다…'),
        region: null,
      })
    }
    return out
  }

  if (a.valid_whole) {
    // 필수 조건 통과 + 구간 추천 불필요 → 원본을 그대로 참조로 사용(파생 클립 불필요).
    // 사용 중 구간이 있으면(이전 엔진에서 잘랐던 것) 그대로 둔다 — 필수 조건 밖이면 사유만 알린다.
    if (committedThen && committed?.region) {
      const j = judgeLength(pol, committed.region.duration)
      if (j === 'blocked_short' || j === 'blocked_long') {
        out.patches.push({
          phase: 'needs_region', clip: committed.clip, region: committed.region,
          message: committedMismatchText(pol, committed.region.duration),
        })
      }
    } else {
      out.patches.push({ phase: 'ready', clip: '', message: '', region: null })
    }
    return out
  }

  const why = (a.errors || []).map((e) => e.message).join(' / ') || '참조 음성 품질 오류'
  out.patches.push({ phase: 'failed', clip: '', message: why, region: null })
  return out
}

// ── 트림(구간 확정) 응답 판정 ──────────────────────────────────────────────────

export type TrimDecision =
  /** 승인 — 이 클립과 구간을 쓴다. */
  | { kind: 'ready'; clip: string; region: { start: number; duration: number }; effective: ReferenceSpan; metrics: ReferenceRegionMetrics }
  /** 실패했지만 **이전에 확정한 구간을 그대로 쓴다** — 준비를 내리지 않고 사유만 화면에 남긴다. */
  | { kind: 'kept'; message: string; metrics: ReferenceRegionMetrics | null }
  /** 실패 — 준비를 내린다. */
  | { kind: 'failed'; patch: RefStatePatch; metrics: ReferenceRegionMetrics | null }

export interface TrimDecisionContext {
  /** 지금 쓰고 있는 목소리가 있는가(있으면 실패해도 그것을 지키다). */
  hasCommitted: boolean
  policy: ReferencePolicySummary
  plain: boolean
}

/**
 * `trimReference` 응답 하나를 판정한다.
 *
 * ★승인 권위는 파이썬(analyze_region) 하나다. 화면은 그 계약을 **해석하지 않는다.**
 *   예전에는 경고 '문구' 에 특정 낱말이 있는지로 승인을 판단해서, 새로 생긴 '말 도중 절단' 경고가
 *   그 낱말을 안 가져 조용히 승인됐다 — 그 클립이 그대로 ICL 프롬프트가 되어 참조 대사가 섞였다.
 *   blocking 누락·타입 오류·ready 와의 모순은 전부 **승인 거부**로 떨어뜨린다(fail-closed).
 */
export function decideAfterTrim(raw: unknown, ctx: TrimDecisionContext): TrimDecision {
  const o = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {})
  // 실패 응답을 먼저 판정한다. 예전에는 성공 형태로 단언하고 metrics 를 읽어서, 파이썬이 구조화 차단
  // (REFERENCE_REGION_BLOCKED + blocking)을 보내도 metrics 가 없으니 실제 사유 대신 '형식 불일치' 만 떴다.
  const failed = o.status === 'failed' || typeof o.code === 'string'
  if (failed) {
    const codes = Array.isArray(o.blocking)
      ? (o.blocking as unknown[]).filter((c): c is string => typeof c === 'string')
      : []
    const msg = o.code === 'REFERENCE_REGION_BLOCKED' && codes.length > 0
      ? codes.map((c) => blockMessage(c, ctx.policy)).join(' · ')
      : (typeof o.error_message === 'string' && o.error_message ? o.error_message : '구간을 확정하지 못했습니다.')
    if (ctx.hasCommitted) {
      return { kind: 'kept', message: msg + ' — 이전에 확정한 구간을 그대로 사용합니다.', metrics: null }
    }
    return { kind: 'failed', patch: { phase: 'failed', clip: '', message: msg, region: null }, metrics: null }
  }

  const m = (o.metrics && typeof o.metrics === 'object' ? o.metrics as ReferenceRegionMetrics : undefined)
  const clip = typeof o.clip_path === 'string' ? o.clip_path : ''
  const blocking = Array.isArray(m?.blocking) ? m.blocking.filter((c) => typeof c === 'string') : null
  const eff = m?.effective_region
  const contractOk = blocking !== null && typeof m?.ready === 'boolean'
    && m.ready === (blocking.length === 0) && validSpan(eff)
  const ok = contractOk && m?.ready === true

  if (ok) {
    const span = eff as ReferenceSpan
    return {
      kind: 'ready', clip, effective: span, metrics: m as ReferenceRegionMetrics,
      // 요청 구간이 아니라 **실제로 잘려 나간 구간**을 저장한다. 자동 스냅으로 옮겨졌을 때
      // 요청값을 저장하면 재현이 어긋난다.
      region: { start: span.start_sec, duration: span.dur_sec },
    }
  }
  const msg = !contractOk
    ? say(ctx.plain, '구간 검사 결과를 읽지 못했습니다(형식 불일치). 다시 시도하세요.',
        '목소리 구간을 확인하지 못했습니다. 다시 시도해 주세요.')
    : (blocking as string[]).map((c) => blockMessage(c, ctx.policy)).join(' · ')
  return {
    kind: 'failed', metrics: m ?? null,
    patch: {
      // 차단이 '구간을 다시 고르면 되는 일' 인지 '이 파일로는 안 되는 일' 인지는 코드로 정한다.
      phase: contractOk ? phaseForBlocking(blocking as string[]) : 'failed',
      clip: '', message: msg || '구간 품질이 부적합합니다', region: null,
    },
  }
}

// ── 자동 구간 확정 ────────────────────────────────────────────────────────────

export interface AutoConfirmInput {
  autoConfirm: boolean
  /** 지금 쓰고 있는 목소리가 있는가 — 있으면 준비는 이미 끝난 것이다. */
  hasCommitted: boolean
  /** 분석이 실패했는가 — 사유는 이미 올라갔다. */
  analyzeError: boolean
  /** 분석 결과(아직 없으면 null — **종료가 아니다**). */
  analysis: ReferenceAnalysis | null
  policy: ReferencePolicySummary
}

export type AutoConfirmDecision =
  /** 아직 분석 중이다. 알리지 않는다 — 여기서 끝났다고 하면 드라이버가 다음 사람으로 넘어가 버린다. */
  | { kind: 'wait' }
  /** 할 일이 없다. **끝났다고 알린다**(성공·실패·해당 없음을 구분하지 않는다). */
  | { kind: 'settle' }
  /** 추천이 없어 임의로 고르지 않는다. 사용자가 눌러야 한다고 알리고 끝난 것으로 친다. */
  | { kind: 'needs-region'; patch: RefStatePatch }
  /** 추천 구간으로 한 번 확정한다. 끝나면(성공·실패 무관) 알린다. */
  | { kind: 'confirm'; start: number; dur: number }

/**
 * 분석 한 건에 대해 자동 확정을 할지 정한다.
 *
 * ★**'준비 중' 으로 남겨 두지 않는다.** 남겨 두면 끝나지 않는 상태가 되고, 사용자는 목소리가
 *   준비되는 줄 알고 기다린다(2026-09-16 사용자 보고: "불러왔으면 셋팅이 다 되어 있어야 하는데 꼬였다").
 * ★실패해도 **다시 시도하지 않는다** — 확정 실패 → 재시도 → 실패의 순환을 만들지 않는다.
 */
export function decideAutoConfirm(input: AutoConfirmInput): AutoConfirmDecision {
  const { hasCommitted, analyzeError, analysis, policy } = input
  if (hasCommitted) return { kind: 'settle' }        // 이미 쓰고 있는 구간이 있다 → 준비는 끝난 것
  if (analyzeError) return { kind: 'settle' }        // 분석 실패 — 사유는 이미 상위로 올렸다
  if (!analysis) return { kind: 'wait' }             // 아직 분석 중이다. **종료가 아니다.**
  if (!analysis.needs_region) return { kind: 'settle' }   // 원본을 그대로 쓸 수 있다/못 쓴다 — 분석이 판정했다
  const r = analysis.recommend
  if (!r || !r.ok) {
    return { kind: 'needs-region', patch: { phase: 'needs_region', clip: '', region: null, message: ACTION_CONFIRM } }
  }
  return { kind: 'confirm', start: r.start_sec, dur: clampDuration(policy, analysis.duration_sec, r.dur_sec) }
}

/**
 * 자동 확정을 **분석 한 건당 한 번**으로 묶는 열쇠.
 *
 * 예전 열쇠는 (목소리, 파일) 뿐이라 파일당 딱 한 번만 확정했다. 같은 패널에서 분석이 다시 돌면
 * (엔진·목표 길이 변경 등) 확정본이 없는데도 건너뛰어 상태가 '준비 중' 에 머물고 **아무도 끝내지 않았다.**
 */
export function autoConfirmKey(clipKey: string, path: string, analysisSeq: number): string {
  return `${clipKey}\u0000${path}\u0000${analysisSeq}`
}
