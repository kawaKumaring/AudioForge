/**
 * 참조 길이 정책 — 화면이 읽는 **유일한** 길이 조건.
 *
 * 값의 권위는 Python `reference_audio.ReferencePolicy` 다(엔진별 필수/권장). 워커가 ref-analyze 응답에
 * `policy` 로 실어 보내고, 화면은 그 요약에서 숫자·문구·슬라이더 범위를 만든다. 이 파일에 길이 숫자를 새로
 * 적지 않는다 — 유일한 예외는 구 워커 응답(policy 없음)을 예전과 같게 보이게 하는 LEGACY 폴백이다.
 *
 * 두 층을 섞지 않는다.
 *   · 필수(required): 어기면 엔진이 거부한다 → 차단.
 *   · 권장(recommended): 이 앱이 결과를 검증한 범위 → 밖이면 경고만. "길수록 좋다" 가 아니다.
 */

export interface LengthBounds {
  min_sec: number | null
  max_sec: number | null
}

export interface ReferencePolicySummary {
  engine: string
  required: LengthBounds
  recommended: LengthBounds
  basis: string
  recommended_basis: string
}

/** 구 워커 응답(policy 없음)일 때만 — v1.3 의 표시(GPT-SoVITS 필수 3~10초)를 그대로 유지한다. */
export const LEGACY_POLICY_FALLBACK: ReferencePolicySummary = {
  engine: 'gptsovits',
  required: { min_sec: 3, max_sec: 10 },
  recommended: { min_sec: null, max_sec: null },
  basis: 'GPT-SoVITS 벤더 추론 코드가 3~10초 밖 참조를 거부한다.',
  recommended_basis: '',
}

/** 슬라이더가 0 이 될 수는 없으므로 정책에 필수 하한이 없을 때의 UI 최소값 = step 한 칸. 정책이 아니다. */
export const SLIDER_STEP_SEC = 0.1

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bounds(v: unknown): LengthBounds {
  const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {}
  return { min_sec: num(o.min_sec), max_sec: num(o.max_sec) }
}

/** ref-analyze/ref-trim 응답(또는 그 안의 policy) → 요약. 형식이 없으면 LEGACY 폴백. */
export function policyFromAnalysis(a: unknown): ReferencePolicySummary {
  const src = (a && typeof a === 'object') ? (a as Record<string, unknown>) : null
  const p = src && src.policy && typeof src.policy === 'object'
    ? src.policy as Record<string, unknown>
    : (src && typeof src.engine === 'string' && src.required ? src : null)
  if (!p || typeof p.engine !== 'string') return LEGACY_POLICY_FALLBACK
  return {
    engine: p.engine,
    required: bounds(p.required),
    recommended: bounds(p.recommended),
    basis: typeof p.basis === 'string' ? p.basis : '',
    recommended_basis: typeof p.recommended_basis === 'string' ? p.recommended_basis : '',
  }
}

const fmtSec = (s: number) => (Number.isInteger(s) ? String(s) : s.toFixed(1))

/** '3~10초' | '3초 이상' | '10초 이하' | '' */
export function fmtRange(b: LengthBounds): string {
  if (b.min_sec !== null && b.max_sec !== null) return `${fmtSec(b.min_sec)}~${fmtSec(b.max_sec)}초`
  if (b.min_sec !== null) return `${fmtSec(b.min_sec)}초 이상`
  if (b.max_sec !== null) return `${fmtSec(b.max_sec)}초 이하`
  return ''
}

export function hasRequired(p: ReferencePolicySummary): boolean {
  return p.required.min_sec !== null || p.required.max_sec !== null
}

export function hasRecommended(p: ReferencePolicySummary): boolean {
  return p.recommended.min_sec !== null || p.recommended.max_sec !== null
}

/** 구간 슬라이더 범위. 필수 한계가 없는 방향은 step 한 칸 / 원본 전체 길이. */
export function regionSliderBounds(p: ReferencePolicySummary, durTotalSec: number): { min: number; max: number } {
  const min = p.required.min_sec ?? SLIDER_STEP_SEC
  const total = Number.isFinite(durTotalSec) && durTotalSec > 0 ? durTotalSec : min
  const max = p.required.max_sec ?? Math.max(min, Math.round(total * 10) / 10)
  return { min, max: Math.max(min, max) }
}

export function clampDuration(p: ReferencePolicySummary, durTotalSec: number, sec: number): number {
  const b = regionSliderBounds(p, durTotalSec)
  return Math.min(b.max, Math.max(b.min, sec))
}

/** 이 길이를 넘는 원본에는 구간을 추천한다(필수 상한 → 그것, 없으면 권장 상한). */
export function regionThresholdSec(p: ReferencePolicySummary): number | null {
  return p.required.max_sec ?? p.recommended.max_sec
}

export type LengthJudgement = 'blocked_short' | 'blocked_long' | 'outside_recommended' | 'ok'

export function judgeLength(p: ReferencePolicySummary, sec: number): LengthJudgement {
  if (p.required.min_sec !== null && sec < p.required.min_sec) return 'blocked_short'
  if (p.required.max_sec !== null && sec > p.required.max_sec) return 'blocked_long'
  if (p.recommended.min_sec !== null && sec < p.recommended.min_sec) return 'outside_recommended'
  if (p.recommended.max_sec !== null && sec > p.recommended.max_sec) return 'outside_recommended'
  return 'ok'
}

/** 헤더 한 줄. GPT-SoVITS: '필수 3~10초' / Qwen3: '권장 3~10초(검증 범위) · 길이 필수 조건 없음' */
export function lengthConditionText(p: ReferencePolicySummary): string {
  const parts: string[] = []
  if (hasRequired(p)) parts.push(`필수 ${fmtRange(p.required)}`)
  if (hasRecommended(p)) parts.push(`권장 ${fmtRange(p.recommended)}(검증 범위)`)
  if (!hasRequired(p)) parts.push('길이 필수 조건 없음')
  return parts.join(' · ')
}

/** 구간 선택 안내. required=true 면 자르지 않으면 엔진이 거부하는 경우. */
export function regionNeedText(p: ReferencePolicySummary, durTotalSec: number, required: boolean): string {
  const total = `${durTotalSec.toFixed(1)}초`
  if (required) {
    return `${total} 원본은 이 엔진에서 그대로 쓸 수 없습니다. 아래에서 ${fmtRange(p.required)} 구간을 골라 확정하세요.`
  }
  const rec = hasRecommended(p) ? fmtRange(p.recommended) : ''
  return `${total} 원본 — 권장 길이(${rec})를 넘습니다. 추천 구간이 미리 선택돼 있고, 원본 전체 범위에서 조정할 수 있습니다. `
    + '더 긴 구간도 쓸 수 있지만 그 길이의 결과는 검증되지 않았습니다.'
}

export function tooShortText(p: ReferencePolicySummary, sec: number): string {
  const min = p.required.min_sec
  const req = min !== null ? `${fmtSec(min)}초 이상` : '더 긴'
  return `참조가 ${sec.toFixed(2)}초로 이 엔진의 필수 하한(${req}) 미달입니다 — ${fmtRange(p.required) || req} 음성을 올려주세요.`
}

export function outsideRecommendedText(p: ReferencePolicySummary, sec: number): string {
  return `선택 길이 ${sec.toFixed(1)}초 — 검증된 범위(${fmtRange(p.recommended)}) 밖입니다. 쓸 수는 있지만 결과 품질은 확인되지 않았습니다.`
}

/** 엔진 전환 뒤 사용 중 구간이 새 엔진의 필수 조건 밖일 때. 목소리를 바꾸거나 지우지 않고 사유와 수정만 안내한다. */
export function committedMismatchText(p: ReferencePolicySummary, sec: number): string {
  return `사용 중인 구간(${sec.toFixed(1)}초)이 이 엔진의 필수 조건(${fmtRange(p.required)}) 밖입니다 — 구간을 조정해 다시 확정하세요.`
}

/** 파이썬 차단 코드 → 사용자 문구. 길이 코드는 정책 숫자로, 나머지는 고정 문구. */
export function blockMessage(code: string, p: ReferencePolicySummary): string {
  switch (code) {
    case 'REGION_TOO_SHORT': return `구간이 너무 짧습니다(${p.required.min_sec !== null ? fmtSec(p.required.min_sec) + '초 이상' : '필수 하한'}).`
    case 'REGION_TOO_LONG': return `구간이 너무 깁니다(${p.required.max_sec !== null ? fmtSec(p.required.max_sec) + '초 이하' : '필수 상한'}).`
    case 'REGION_SNAP_RANGE_UNSATISFIABLE': return `${fmtRange(p.required) || '허용 범위'} 안에 들어가는 안전한 구간을 만들 수 없습니다.`
    case 'REGION_HEAD_TRUNCATED': return '구간 시작이 말 도중입니다. 말이 시작되는 지점부터 잡으세요.'
    case 'REGION_TAIL_TRUNCATED': return '구간 끝이 말 도중입니다. 말이 끝나는 지점까지 포함하세요.'
    case 'REGION_SEVERE_CLIPPING': return '소리가 심하게 찌그러졌습니다(클리핑).'
    case 'REGION_NEAR_SILENT': return '거의 무음입니다.'
    case 'REGION_NO_SAFE_BOUNDARY': return '요청하신 구간 주변에 말이 끊기는 지점이 없습니다. 다른 구간을 골라 주세요.'
    case 'REGION_SNAP_RECONFIRM_REQUIRED': return '구간을 크게 옮겨야 합니다. 제안된 구간을 확인해 주세요.'
    case 'REGION_TRANSCRIBE_FAILED': return '참조 음성을 인식하지 못했습니다.'
    case 'REGION_TEXT_MISMATCH': return '참조 음성과 입력한 대사가 맞지 않습니다.'
    default: return code
  }
}

/** 카드에 보이는 실제 사용 구간. '26.5초부터 6.6초' / '원본 전체'. */
export function regionText(region: { start: number; duration: number } | null | undefined): string {
  if (!region || !(region.duration > 0)) return '원본 전체'
  return `${region.start.toFixed(1)}초부터 ${region.duration.toFixed(1)}초`
}

/** 자산 목록(감정 후보) 수명 판정에 쓰는 경계. 필수 하한/상한이 없으면 0 / 권장 상한(없으면 무한). */
export function lifecycleBoundsFromPolicy(p: ReferencePolicySummary | null | undefined): { minSec: number; maxSec: number } {
  const pol = p ?? LEGACY_POLICY_FALLBACK
  return {
    minSec: pol.required.min_sec ?? 0,
    maxSec: pol.required.max_sec ?? pol.recommended.max_sec ?? Number.POSITIVE_INFINITY,
  }
}
