// 감정 음향 판정 계약(TS 거울). "이 감정은 실제로 감정처럼 들리는가, 아니면 태그만 붙었는가?"
//
// Python 권위: python/emotion_acoustic.py (같은 role · 같은 사유 코드 · 같은 파생 규칙).
// 단위테스트가 Python 소스를 파싱해 어휘를 대조한다(레포의 parity-by-parsing 선례를 따름).
//
// 배경(doc/work-in-progress/tts-emotion-acoustic-strategy.md):
//   Qwen3-TTS Base 의 voice clone 경로에는 감정·스타일 지시 인자가 없다. 감정은 오직 참조 클립
//   교체로만 실현된다. **같은 참조를 쓰면 모델 입력이 완전히 동일**하므로 감정 차이가 나올 통로가 없다.
//   따라서 '기본 목소리 하나로 여러 감정을 지원한다' 는 표시는 이 계약에서 만들어질 수 없다.
//
// 순수성 계약: fs / Electron / React / IPC 의존 없음. src/shared 의 다른 계약 모듈에서 값을
//   import 하지 않는다(레포 규약 — node --test 가 로더 없이 type-strip 해 바로 실행할 수 있어야 한다).
// 비민감 계약: 경로 · 참조 전사문 · 합성 프롬프트를 이 모듈의 어떤 값에도 넣지 않는다.

// ─────────────────────────────────────────────────────────────────────────────
// 1) 참조 배치(role) — 판정이 아니라 '어떤 파일이 들어가는가' 라는 사실
// ─────────────────────────────────────────────────────────────────────────────

export const EMOTION_REFERENCE_ROLES = ['distinct', 'shared_default', 'absent'] as const
export type EmotionReferenceRole = typeof EMOTION_REFERENCE_ROLES[number]

/**
 * 이 감정이 쓰는 참조가 기본 참조와 같은가/다른가/없는가.
 * key 는 '같음/다름'만 판정할 수 있으면 되는 불투명 식별자다(콘텐츠 SHA-256 이 정석).
 * 값을 저장하지도 표시하지도 않는다 — 비교만 하고 토큰 하나를 돌려준다.
 */
export function classifyReferenceRole(
  emotionKey: string | null | undefined,
  defaultKey: string | null | undefined
): EmotionReferenceRole {
  if (!emotionKey) return 'absent'
  // 기본 참조가 없으면 비교 대상이 없다 — '다르다'고 말할 수 없다.
  if (!defaultKey) return 'absent'
  return emotionKey === defaultKey ? 'shared_default' : 'distinct'
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 판정 상태 / 사유 코드 — 엔진 capability 어휘를 그대로 쓴다(병렬 어휘 금지)
// ─────────────────────────────────────────────────────────────────────────────

export const EMOTION_ACOUSTIC_STATES = ['supported', 'degraded', 'unsupported', 'unknown'] as const
export type EmotionAcousticState = typeof EMOTION_ACOUSTIC_STATES[number]

export const EMOTION_ACOUSTIC_REASONS = [
  'EMOTION_REF_ABSENT',           // 전용 참조가 없다 → 기본 목소리로 합성
  'EMOTION_REF_SHARED_DEFAULT',   // 기본 참조와 같은 클립 → 태그만 다르고 입력은 동일
  'EMOTION_REF_PROFILE_MISSING',  // 전용 참조는 있으나 아직 재지 않았다
  'EMOTION_REF_NOT_SEPARATED',    // 재 봤더니 기본 참조와 구별되는 차이가 없다
  'EMOTION_RESULT_NOT_MEASURED',  // 참조는 갈렸으나 생성 결과를 아직 재지 않았다
  'EMOTION_RESULT_NOT_FOLLOWED',  // 생성 결과가 참조 쪽으로 움직이지 않았다
  'EMOTION_RESULT_FOLLOWED',      // 확인됨 — supported 로 가는 유일한 사유
] as const
export type EmotionAcousticReason = typeof EMOTION_ACOUSTIC_REASONS[number]

/** supported 로 도달할 수 있는 유일한 사유. 다른 조합으로 새는 길은 없다(파생 함수가 강제). */
export const EMOTION_ACOUSTIC_SUPPORTED_REASON: EmotionAcousticReason = 'EMOTION_RESULT_FOLLOWED'

// 화면에 그대로 쓰는 문구 — 기술 용어 없이 평이한 한국어. '지원됨' 은 마지막 하나에만 붙는다.
export const EMOTION_ACOUSTIC_REASON_LABEL: Readonly<Record<EmotionAcousticReason, string>> = Object.freeze({
  EMOTION_REF_ABSENT:
    '이 감정 전용 목소리가 없어 기본 목소리로 만듭니다. 감정 차이는 거의 들리지 않습니다.',
  EMOTION_REF_SHARED_DEFAULT:
    '기본 목소리와 같은 파일을 쓰고 있어 감정 차이가 생기지 않습니다.',
  EMOTION_REF_PROFILE_MISSING:
    '전용 목소리가 등록되어 있지만 아직 확인하지 않았습니다.',
  EMOTION_REF_NOT_SEPARATED:
    '등록한 목소리가 기본 목소리와 충분히 다르지 않습니다. 감정이 더 뚜렷한 대목으로 바꿔 보세요.',
  EMOTION_RESULT_NOT_MEASURED:
    '목소리는 서로 다르지만, 만들어진 결과가 실제로 달라졌는지는 아직 확인하지 않았습니다.',
  EMOTION_RESULT_NOT_FOLLOWED:
    '만들어진 결과가 등록한 감정 쪽으로 움직이지 않았습니다.',
  EMOTION_RESULT_FOLLOWED:
    '등록한 감정대로 만들어지는 것을 확인했습니다.',
})

export const EMOTION_ACOUSTIC_STATE_LABEL: Readonly<Record<EmotionAcousticState, string>> = Object.freeze({
  supported: '감정 반영됨',
  degraded: '감정 거의 없음',
  unsupported: '만들 수 없음',
  unknown: '확인 전',
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 판정 — 상태는 언제나 증거(attempted/accepted/honored)에서 파생된다
//
//    ⚠️ Python 의 emotion_acoustic_evidence() 와 **같은 파생**이다. 규칙표를 따로 두지 않는다 —
//       진실 소스가 둘이면 반드시 갈라진다.
// ─────────────────────────────────────────────────────────────────────────────

export interface EmotionAcousticInput {
  role: EmotionReferenceRole
  /** 참조를 실제로 재서 기본 참조와 구별됨을 확인했는가. **재지 않았으면 undefined**(false 아님). */
  separated?: boolean
  /** 생성 결과가 참조 쪽으로 움직였는가. **재지 않았으면 undefined**(false 아님). */
  followed?: boolean
}

export interface EmotionAcousticEvidence {
  /** 프로브를 끝까지 돌렸는가. 참조만 재고 결과를 안 쟀으면 false 다. */
  attempted: boolean
  /** 입력이 실제로 달라졌는가(전용 참조가 들어갔는가). */
  accepted: boolean
  /** 결과가 관측 가능하게 그 방향으로 움직였는가. **측정 없이는 절대 true 가 되지 않는다.** */
  honored: boolean
}

export interface EmotionAcousticVerdict extends EmotionAcousticEvidence {
  emotionId: string
  role: EmotionReferenceRole
  state: EmotionAcousticState
  reason: EmotionAcousticReason
  /** '됨'으로 취급해도 되는가. supported 하나뿐이다. */
  usable: boolean
}

/**
 * 증거 산출.
 * · absent / shared_default → 태그는 받았으나 모델 입력이 기본 참조 그대로다 → accepted 이되 honored 아님.
 *   "받아들여진 것"과 "반영된 것"은 다르다 — 그 구분이 이 두 필드의 존재 이유다.
 * · 전용 참조가 있는데 재지 않았으면 attempted=false → unknown(성공 아님).
 */
export function emotionAcousticEvidence(input: EmotionAcousticInput): EmotionAcousticEvidence {
  const { role, separated, followed } = input
  if (role === 'absent' || role === 'shared_default') {
    return { attempted: true, accepted: true, honored: false }
  }
  if (separated === undefined) return { attempted: false, accepted: false, honored: false }
  if (separated !== true) return { attempted: true, accepted: true, honored: false }
  if (followed === undefined) return { attempted: false, accepted: true, honored: false }
  return { attempted: true, accepted: true, honored: followed === true }
}

/** 증거 → 상태. expressive_capability.evidence_state 와 같은 표다. */
export function emotionAcousticState(ev: EmotionAcousticEvidence): EmotionAcousticState {
  if (!ev.attempted) return 'unknown'
  if (!ev.accepted) return 'unsupported'
  if (!ev.honored) return 'degraded'
  return 'supported'
}

function reasonFor(input: EmotionAcousticInput): EmotionAcousticReason {
  const { role, separated, followed } = input
  if (role === 'absent') return 'EMOTION_REF_ABSENT'
  if (role === 'shared_default') return 'EMOTION_REF_SHARED_DEFAULT'
  if (separated === undefined) return 'EMOTION_REF_PROFILE_MISSING'
  if (separated !== true) return 'EMOTION_REF_NOT_SEPARATED'
  if (followed === undefined) return 'EMOTION_RESULT_NOT_MEASURED'
  return followed === true ? 'EMOTION_RESULT_FOLLOWED' : 'EMOTION_RESULT_NOT_FOLLOWED'
}

export class EmotionAcousticHonestyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmotionAcousticHonestyError'
  }
}

/**
 * 감정 하나의 최종 음향 판정. supported 로 가는 길은 EMOTION_RESULT_FOLLOWED 하나뿐이고,
 * 그 길은 실제 생성 결과를 측정해야만 열린다. 다른 조합으로 supported 가 새면 예외로 막는다.
 */
export function resolveEmotionAcoustic(
  emotionId: string,
  input: EmotionAcousticInput
): EmotionAcousticVerdict {
  const ev = emotionAcousticEvidence(input)
  const state = emotionAcousticState(ev)
  const reason = reasonFor(input)
  if (state === 'supported' && reason !== EMOTION_ACOUSTIC_SUPPORTED_REASON) {
    throw new EmotionAcousticHonestyError(`false success: ${state}/${reason}`)
  }
  if (reason === EMOTION_ACOUSTIC_SUPPORTED_REASON && state !== 'supported') {
    throw new EmotionAcousticHonestyError(`reason/state mismatch: ${state}/${reason}`)
  }
  return { emotionId, role: input.role, state, reason, ...ev, usable: state === 'supported' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 표시용 파생 — 상태별로 반드시 서로 다른 문구가 나온다
// ─────────────────────────────────────────────────────────────────────────────

export type EmotionAcousticTone = 'ok' | 'warn' | 'muted'

const TONE_BY_STATE: Readonly<Record<EmotionAcousticState, EmotionAcousticTone>> = Object.freeze({
  supported: 'ok',
  degraded: 'warn',
  unsupported: 'warn',
  unknown: 'muted',
})

export interface EmotionAcousticView {
  emotionId: string
  state: EmotionAcousticState
  stateLabel: string
  reason: EmotionAcousticReason
  /** 화면에 그대로 렌더하는 한 줄. 회색으로만 죽이지 않고 반드시 이 문장을 함께 보여준다. */
  notice: string
  tone: EmotionAcousticTone
}

export function describeEmotionAcoustic(verdict: EmotionAcousticVerdict): EmotionAcousticView {
  return {
    emotionId: verdict.emotionId,
    state: verdict.state,
    stateLabel: EMOTION_ACOUSTIC_STATE_LABEL[verdict.state],
    reason: verdict.reason,
    notice: EMOTION_ACOUSTIC_REASON_LABEL[verdict.reason],
    tone: TONE_BY_STATE[verdict.state],
  }
}

/** 감정 묶음 요약 — '몇 개가 실제로 감정으로 들리는가'. */
export interface EmotionAcousticSummary {
  total: number
  supported: number
  degraded: number
  unknown: number
  /** 하나도 확인되지 않았을 때 화면에 쓰는 한 줄. 확인된 것이 있으면 null. */
  notice: string | null
}

export function summarizeEmotionAcoustic(
  verdicts: readonly EmotionAcousticVerdict[]
): EmotionAcousticSummary {
  let supported = 0
  let degraded = 0
  let unknown = 0
  for (const v of verdicts) {
    if (v.state === 'supported') supported += 1
    else if (v.state === 'unknown') unknown += 1
    else degraded += 1
  }
  return {
    total: verdicts.length,
    supported,
    degraded,
    unknown,
    notice: supported === 0 && verdicts.length > 0 ? EMOTION_ACOUSTIC_NONE_CONFIRMED_NOTICE : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 화면 고정 문구 — 평이한 한국어. '지원' 이라는 말을 함부로 쓰지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 감정 참조 관리 화면 상단. 등록된 감정 목소리가 하나도 없을 때. */
export const EMOTION_ACOUSTIC_DEFAULT_VOICE_NOTICE =
  '지금은 모든 감정을 기본 목소리 하나로 만듭니다. 태그는 붙지만 감정 차이는 거의 들리지 않습니다. ' +
  '감정마다 그 감정이 담긴 목소리를 등록해야 실제로 달라집니다.'

/** 감정·표현 미리듣기 패널. 이 기능은 구조상 기본 목소리 하나만 쓴다. */
export const EMOTION_ACOUSTIC_SAMPLER_NOTICE =
  '이 미리듣기는 기본 목소리 하나로만 만듭니다. 그래서 감정끼리 차이가 거의 없을 수 있습니다 — ' +
  '지금 엔진은 목소리를 바꾸는 것 말고는 감정을 넣을 방법이 없습니다.'

/** 감정 묶음 요약에서 확인된 감정이 하나도 없을 때. */
export const EMOTION_ACOUSTIC_NONE_CONFIRMED_NOTICE =
  '아직 감정이 실제로 반영되는 것을 확인한 감정이 없습니다.'
