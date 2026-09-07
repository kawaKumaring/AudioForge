/**
 * 화자별 참조 선택 — 화면이 "이 말은 어느 목소리로 만들어질까" 를 미리 말하기 위한 거울.
 *
 * 권위는 Python `python/speaker_refs.py` 다. 실제 참조 파일을 고르고 fail-closed 로 막는
 * 것은 그쪽이며, 여기서는 **어느 규칙이 쓰일지와 막힐지 여부**만 같은 순서로 판정한다.
 * 화면이 "준비됨" 이라고 했는데 생성이 막히거나, 화면은 막힌다는데 생성이 되는 상황이
 * 가장 나쁘다 — 그래서 두 구현을 `speakerReference.parity.json` 으로 묶는다.
 *
 * 경로를 다루지 않는다. 이 모듈이 아는 것은 **준비 여부**뿐이고, 그래서 내부 경로가 화면
 * 코드로 흘러갈 통로가 없다.
 *
 * 우선순위(확정)
 *   1. `(화자, 감정)` 전용 참조
 *   2. 그 화자의 기본 참조
 *   3. **화자 표기가 없는 발화에서만** 기존 감정별 참조
 *   4. 전역 기본 참조
 *
 * 3번이 화자 있는 발화에 적용되지 않는 것이 핵심이다. 지정한 인물의 말을 감정 참조(다른
 * 사람의 목소리일 수 있다)로 만들면 사용자가 고르지 않은 인물이 말하게 된다.
 */

/** 어느 규칙이 쓰였는가. Python `speaker_refs.REFERENCE_SOURCES` 와 같은 값이다. */
export const REFERENCE_SOURCES = [
  'speaker_emotion', 'speaker', 'emotion', 'default',
] as const
export type ReferenceSource = typeof REFERENCE_SOURCES[number]

/** 생성 전에 막히는 사유. Python 의 fail-closed 코드와 같다. */
export const SPEAKER_REFERENCE_FAILURES = [
  'SPEAKER_NOT_REGISTERED', 'SPEAKER_REFERENCE_NOT_READY', 'DEFAULT_REFERENCE_MISSING',
] as const
export type SpeakerReferenceFailure = typeof SPEAKER_REFERENCE_FAILURES[number]

/** `(화자, 감정)` 전용 참조의 키. Python `speaker_refs.emotion_key` 와 같은 문자열. */
export function speakerEmotionKey(speakerId: string, emotionId: string | null): string {
  return `${speakerId}${String.fromCharCode(31)}${emotionId ?? 'default'}`
}

/**
 * 화면이 아는 준비 상태. **경로가 아니라 준비 여부만** 담는다.
 *
 * `registered` 와 `speakerReady` 를 나누는 이유는 "등록했는데 파일이 사라졌다" 를
 * "등록하지 않았다" 와 다르게 말해야 하기 때문이다.
 */
export interface ReferenceReadiness {
  defaultReady: boolean
  registeredSpeakers: readonly string[]
  speakerReady: Readonly<Record<string, boolean>>
  speakerEmotionReady: Readonly<Record<string, boolean>>
  emotionReady: Readonly<Record<string, boolean>>
}

export type ReferenceDecision =
  | { ok: true; source: ReferenceSource }
  | { ok: false; code: SpeakerReferenceFailure }

/** 이 발화가 어느 규칙으로 참조를 얻는가 — 또는 왜 막히는가. */
export function resolveReferenceDecision(
  speakerId: string | null, emotionId: string | null, r: ReferenceReadiness
): ReferenceDecision {
  const eid = emotionId ?? 'default'
  if (speakerId == null) {
    // 화자 표기가 없는 기존 대본 — v1.3.0 과 같은 경로다.
    if (r.emotionReady[eid]) return { ok: true, source: 'emotion' }
    if (!r.defaultReady) return { ok: false, code: 'DEFAULT_REFERENCE_MISSING' }
    return { ok: true, source: 'default' }
  }
  if (!r.registeredSpeakers.includes(speakerId)) {
    return { ok: false, code: 'SPEAKER_NOT_REGISTERED' }
  }
  if (r.speakerEmotionReady[speakerEmotionKey(speakerId, eid)]) {
    return { ok: true, source: 'speaker_emotion' }
  }
  if (r.speakerReady[speakerId]) return { ok: true, source: 'speaker' }
  // 감정 참조나 전역 기본으로 내려가지 않는다 — 다른 사람 목소리가 된다.
  return { ok: false, code: 'SPEAKER_REFERENCE_NOT_READY' }
}

/** 막히는 발화가 하나라도 있으면 생성이 시작되지 않는다 — 그 사실을 미리 모은다. */
export function blockedDecisions(
  utterances: readonly { speakerId: string | null; emotionId: string | null }[],
  r: ReferenceReadiness
): { speakerId: string | null; emotionId: string | null; code: SpeakerReferenceFailure }[] {
  const out: { speakerId: string | null; emotionId: string | null; code: SpeakerReferenceFailure }[] = []
  const seen = new Set<string>()
  for (const u of utterances) {
    const key = `${u.speakerId ?? ''}${String.fromCharCode(31)}${u.emotionId ?? 'default'}`
    if (seen.has(key)) continue
    seen.add(key)
    const d = resolveReferenceDecision(u.speakerId, u.emotionId, r)
    if (!d.ok) out.push({ speakerId: u.speakerId, emotionId: u.emotionId, code: d.code })
  }
  return out
}

/** 같은 파일을 여러 화자에게 지정했는가 — 막지 않고 알려 주기 위한 값이다. */
export function sharedReferenceGroups(
  speakerFingerprints: Readonly<Record<string, string>>
): Record<string, string[]> {
  const byFingerprint: Record<string, string[]> = {}
  for (const [speakerId, fp] of Object.entries(speakerFingerprints)) {
    if (!fp) continue
    if (!byFingerprint[fp]) byFingerprint[fp] = []
    byFingerprint[fp].push(speakerId)
  }
  const out: Record<string, string[]> = {}
  for (const [fp, ids] of Object.entries(byFingerprint)) {
    if (ids.length > 1) out[fp] = [...ids].sort()
  }
  return out
}

/**
 * 감정 참조 선택의 결과 — 화면이 읽는 형태.
 *
 * 권위는 Python `speaker_refs.resolve_with_emotion` 이다. 여기서는 그 기록을 화면이
 * 다룰 수 있는 모양으로 받을 뿐이고, 점수를 다시 계산하지 않는다.
 *
 * 담기지 않는 것: 파일 경로, 화자 표시 이름, 대사. 담기는 것은 상태와 숫자뿐이다.
 */
export const EMOTION_MATCH_STATES = [
  'reference_matched', 'insufficient_candidates', 'no_reliable_candidate',
  'no_target_profile', 'unsupported',
  // 사용자가 직접 고른 경우. 잠정 추천보다 강한 근거다 — 사람이 듣고 골랐기 때문이다.
  'user_selected', 'user_speaker_default',
] as const
export type EmotionMatchState = typeof EMOTION_MATCH_STATES[number]

export const EMOTION_SELECTION_METHODS = [
  'explicit', 'profile_match', 'speaker_default', 'user',
] as const
export type EmotionSelectionMethod = typeof EMOTION_SELECTION_METHODS[number]

export interface EmotionMatchView {
  state: EmotionMatchState
  selectionMethod: EmotionSelectionMethod
  /** 종합 점수. 재지 못했으면 null 이다(0 이 아니다 — 0 은 "많이 다르다"는 뜻이다). */
  score: number | null
  minScore: number
  runnerUpScore: number | null
  candidatesConsidered: number
  /** 축 이름 → 유사도. 화면 기본에는 내보내지 않는다(상세 정보에만). */
  axisScores?: Readonly<Record<string, number>>
}

/** 감정 참조를 실제로 고른 상태인가. 이 두 가지 말고는 고른 것이 아니다. */
export function emotionReferenceChosen(e: EmotionMatchView | null | undefined): boolean {
  if (!e) return false
  return e.state === 'reference_matched'
}

/**
 * 감정 참조 후보 목록 — 사용자가 **보고 바꿀 수 있게** 하기 위한 형태.
 *
 * 왜 필요한가: 자동 추천의 기준값이 잠정치다. 사용자가 결과를 확인하거나 바꿀 수 없으면
 * 잠정치가 정답처럼 행세한다. 그래서 추천은 제안일 뿐이고 최종 권위는 사람이다.
 *
 * 이 값은 Python `speaker_refs.candidate_view` 가 만든다. 화면은 점수를 다시 계산하지
 * 않는다 — 계산이 두 벌 있으면 화면과 생성이 서로 다른 답을 낼 수 있다.
 *
 * ⚠️ `fileLabel` 은 **화면 전용**이다. 기록으로 나가는 것은 `selection` 쪽 불투명 id 뿐이다.
 */

/** 후보가 자동 추천에서 빠진 이유. Python `CANDIDATE_EXCLUSIONS` 와 같은 값이다. */
export const CANDIDATE_EXCLUSIONS = [
  'SEPARATED_STEM_NOT_RECOMMENDED', 'PROFILE_UNAVAILABLE', 'REFERENCE_QUALITY_INVALID',
] as const
export type CandidateExclusion = typeof CANDIDATE_EXCLUSIONS[number]

/** 참조 품질 상태. 기존 `reference_audio` 판정을 옮긴 값이며 새 판정이 아니다. */
export const CANDIDATE_QUALITY_STATES = ['ok', 'warning', 'invalid', 'unknown'] as const
export type CandidateQualityState = typeof CANDIDATE_QUALITY_STATES[number]

/** 클립의 출처. 호출부가 선언하고 앱이 추측하지 않는다. */
export const CANDIDATE_SOURCE_KINDS = ['clean_speech', 'separated_stem', 'unknown'] as const
export type CandidateSourceKind = typeof CANDIDATE_SOURCE_KINDS[number]

/** 후보 대신 고를 수 있는 두 가지. Python `USER_CHOICES` 와 같은 토큰이다. */
export const USER_CHOICE_SPEAKER_DEFAULT = 'speaker_default'
export const USER_CHOICE_NO_EMOTION_REF = 'no_emotion_ref'
export const USER_CHOICES = [USER_CHOICE_SPEAKER_DEFAULT, USER_CHOICE_NO_EMOTION_REF] as const
export type UserChoiceToken = typeof USER_CHOICES[number]

/** 왜 이 참조가 되었는가. Python `SELECTION_REASONS` 와 같은 값이다. */
export const SELECTION_REASONS = [
  'USER_KEPT_RECOMMENDATION', 'USER_CHANGED_CANDIDATE', 'USER_CHOSE_SPEAKER_DEFAULT',
  'USER_DECLINED_EMOTION_REFERENCE', 'USER_SELECTION_NOT_A_CANDIDATE',
  'AUTO_PROVISIONAL_RECOMMENDATION', 'EXPLICIT_EMOTION_ASSIGNMENT',
] as const
export type SelectionReason = typeof SELECTION_REASONS[number]

export interface EmotionCandidate {
  referenceId: string
  /** 사용자가 자기가 고른 파일을 알아볼 수 있게 — 파일 이름만, 폴더는 없다. */
  fileLabel: string
  /** 길이(초). 아직 분석하지 않았으면 null — 값을 지어내지 않는다. */
  durationSec: number | null
  sourceKind: CandidateSourceKind
  qualityState: CandidateQualityState
  qualityCodes: readonly string[]
  /** 프로필을 재서 비교할 수 있었는가. */
  analyzable: boolean
  /** 지금 자동으로 추천되는 후보인가. 후보가 하나뿐이면 어디에도 붙지 않는다. */
  recommended: boolean
  /** 지금 실제로 쓰이는 후보인가. */
  selected: boolean
  excludedReason: CandidateExclusion | null
  /** 내부 숫자. **상세 정보에만** 그린다. */
  detail: {
    score: number | null
    axisScores: Readonly<Record<string, number>>
  } | null
}

export interface EmotionCandidateView {
  speakerRef: string
  emotionId: string
  candidateCount: number
  /** 후보가 둘 미만 — 화면이 "가장 적합"이라 말하면 안 된다. */
  insufficientCandidates: boolean
  provisionalThreshold: number
  /** 이 문턱은 실측 교정 전이다. 화면이 정답 기준처럼 보이게 하면 안 된다. */
  thresholdProvisional: boolean
  candidates: readonly EmotionCandidate[]
  selection: EmotionSelectionStates | null
  /** 생성이 막히는 사유(있으면 후보를 고를 단계가 아니다). */
  blocked: SpeakerReferenceFailure | null
}

/** 구분해 기록하는 여섯 상태. 추천·사용자 선택·실제 결과를 한 칸에 뭉개지 않는다. */
export interface EmotionSelectionStates {
  recommendedReference: string | null
  userSelectedReference: string | UserChoiceToken | null
  resolvedReference: string | null
  selectionReason: SelectionReason | null
  provisionalThreshold: number
  insufficientCandidates: boolean
  state: EmotionMatchState
}

/** 사용자가 이 후보를 고를 수 있는가. 추천에서 빠진 후보도 고를 수는 있다. */
export function candidateSelectable(c: EmotionCandidate): boolean {
  // 품질이 부적합한 것만 막는다 — 나머지는 사용자가 듣고 판단할 몫이다.
  return c.qualityState !== 'invalid'
}

/** 이 후보에 "추천" 배지를 붙여도 되는가. 후보가 하나뿐이면 붙이지 않는다. */
export function showRecommendedBadge(
  c: EmotionCandidate, view: Pick<EmotionCandidateView, 'insufficientCandidates'>
): boolean {
  return c.recommended && !view.insufficientCandidates
}

// ─────────────────────────────────────────────────────────────────────────────
// 준비 판정의 단일 파생
//
// 화면(인물 카드·요약)·합성 전 preflight·config 전송은 **같은 store 슬롯**에서 같은 함수로
// 준비 표를 만든다. 두 곳이 각자 표를 만들면 "카드는 준비됨인데 config 에는 없다" 가 생긴다 —
// 여러 명 모드의 SPEAKER_NOT_REGISTERED 가 바로 그 어긋남이 Python 에서 터진 모습이었다.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadySlot { ready: boolean }

export function readinessFromSlots(input: {
  defaultReady: boolean
  speakerSlots: Readonly<Record<string, ReadySlot>>
  emotionSlots: Readonly<Record<string, ReadySlot>>
  /** 생성으로 실제 나가는 (화자, 감정) 참조만(게이트 통과분). */
  speakerEmotionRefs: Readonly<Record<string, string>>
}): ReferenceReadiness {
  return {
    defaultReady: !!input.defaultReady,
    registeredSpeakers: Object.keys(input.speakerSlots),
    speakerReady: Object.fromEntries(Object.entries(input.speakerSlots).map(([id, s]) => [id, !!s.ready])),
    speakerEmotionReady: Object.fromEntries(
      Object.entries(input.speakerEmotionRefs).filter(([, p]) => !!p).map(([k]) => [k, true])),
    emotionReady: Object.fromEntries(Object.entries(input.emotionSlots).map(([id, s]) => [id, !!s.ready])),
  }
}

export interface SpeakerPreflightBlock {
  speakerId: string
  code: SpeakerReferenceFailure
  /** 그 인물이 처음 말하는 발화의 번호(0부터). 화면이 "N번 대사" 로 위치를 말한다. */
  firstSegmentIndex: number
}

/**
 * 여러 명 합성 전 검사 — 대본의 **명시 화자**마다 참조가 준비됐는가.
 * 하나라도 막히면 합성을 시작하지 않는다(모델 로딩 전). 다른 인물·전역 기본으로 대체하지 않는다.
 * 한 명 모드에서는 부르지 않는다(single 은 화자 표기를 무시한다).
 */
export function multiSpeakerPreflight(
  segments: readonly { speakerId: string | null; emotionId: string | null }[],
  r: ReferenceReadiness
): SpeakerPreflightBlock[] {
  const out: SpeakerPreflightBlock[] = []
  const seen = new Set<string>()
  segments.forEach((seg, i) => {
    if (seg.speakerId == null || seen.has(seg.speakerId)) return
    const d = resolveReferenceDecision(seg.speakerId, seg.emotionId, r)
    if (d.ok) return
    seen.add(seg.speakerId)
    out.push({ speakerId: seg.speakerId, code: d.code, firstSegmentIndex: i })
  })
  return out
}

/** 사용자 문구. 내부 코드를 내지 않고 인물 카드 위치를 말한다. */
export const SPEAKER_PREFLIGHT_MESSAGE = {
  SPEAKER_NOT_REGISTERED: '이 인물의 목소리가 준비되지 않았습니다. 인물 카드에서 목소리를 지정해 주세요.',
  SPEAKER_REFERENCE_NOT_READY: '이 인물의 목소리 준비가 끝나지 않았습니다. 인물 카드에서 목소리 구간을 확인해 주세요.',
  DEFAULT_REFERENCE_MISSING: '기본 목소리가 준비되지 않았습니다. 먼저 목소리로 쓸 소리 파일을 준비해 주세요.',
} as const

export function speakerPreflightMessage(
  blocks: readonly SpeakerPreflightBlock[], labelOf: (speakerId: string) => string
): string {
  if (blocks.length === 0) return ''
  const where = blocks.map((b) => `${b.firstSegmentIndex + 1}번 대사: ${labelOf(b.speakerId)}`).join(', ')
  return `${SPEAKER_PREFLIGHT_MESSAGE[blocks[0].code]} (${where})`
}
