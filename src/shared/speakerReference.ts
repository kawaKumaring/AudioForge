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
] as const
export type EmotionMatchState = typeof EMOTION_MATCH_STATES[number]

export const EMOTION_SELECTION_METHODS = [
  'explicit', 'profile_match', 'speaker_default',
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
