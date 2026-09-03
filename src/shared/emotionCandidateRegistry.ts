/**
 * 인물별·감정별 목소리 후보 등록 구조 — 등록 상태의 단일 권위(화면 쪽).
 *
 * 왜 필요한가: v1.4 의 후보 비교 화면은 비교할 후보가 있어야 뜻이 있다. 그런데 지금까지
 * 앱에는 "인물 A 의 기쁨 목소리"를 등록할 통로가 없었다 — `ttsSpeakerEmotionRefs` 는
 * 설정 필드로만 존재하고 아무도 값을 넣지 않았다. 이 모듈이 그 구멍을 메운다.
 *
 * 권위의 경계
 *   · **등록 상태**(어떤 파일이 어느 인물의 어느 감정 후보인가)는 여기가 권위다.
 *   · **참조 해석**(실제로 어느 파일이 합성에 들어가는가)은 여전히 Python
 *     `speaker_refs` 가 권위다. 이 모듈은 고른 **하나**를 기존 `(화자, 감정)` 계약
 *     (`ttsSpeakerEmotionRefs`)에 넣어 줄 뿐이고, 후보 목록을 생성기로 보내지 않는다.
 *
 * 새 parser·planner·IPC·trimmer 를 만들지 않는다. 구간 확정은 기존 ReferenceRegionPanel
 * 과 기존 trim 경로를 그대로 쓴다.
 *
 * ⚠️ `sourcePath` 와 표시 이름은 **local/private 상태**(설정·세션)에만 둔다. 일반 run
 * bundle 과 내보낼 수 있는 manifest 로는 `candidateId` / `referenceId` / SHA / 구간 수치 /
 * 선택 사유만 나간다.
 */
import type {
  CandidateQualityState, CandidateSourceKind, SelectionReason,
} from './speakerReference'

/**
 * 후보 대신 고를 수 있는 두 토큰.
 *
 * `speakerReference.ts` 에 같은 값이 있는데 여기서 다시 선언하는 이유는 도구 제약이다 —
 * 저장소 formatter 가 production import 에서 `.ts` 확장자를 떼고, `node --test` 의
 * 타입 제거 실행은 확장자가 있어야 해결한다. 그래서 공용 모듈이 다른 공용 모듈을 **값으로**
 * import 할 수 없다(타입 전용 import 는 지워지므로 괜찮다).
 *
 * 두 벌이 어긋나는 것을 막는 장치는 테스트다 —
 * `emotionCandidateRegistry.test.ts` 가 두 모듈의 값이 같은지 단언한다.
 */
export const USER_CHOICE_SPEAKER_DEFAULT = 'speaker_default'
export const USER_CHOICE_NO_EMOTION_REF = 'no_emotion_ref'

export const CANDIDATE_REGISTRY_SCHEMA_VERSION = 1

/** 구간(초). `null` 은 "원본을 그대로 쓴다"는 뜻이며 구간 미확정과 다르다. */
export interface CandidateRegion {
  start: number
  duration: number
}

/**
 * 후보 하나가 지금 어떤 처지인가.
 *   ready        — 그대로 합성에 쓸 수 있다
 *   needs_region — 원본이 10초를 넘어 구간을 확정해야 한다
 *   expired      — 원본이나 파생 클립이 사라졌다. **조용히 다른 후보로 바꾸지 않는다.**
 *   error        — 참조로 쓸 수 없는 파일이다(품질 부적합·디코딩 실패)
 */
export const CANDIDATE_LIFECYCLE = ['ready', 'needs_region', 'expired', 'error'] as const
export type CandidateLifecycle = typeof CANDIDATE_LIFECYCLE[number]

/** 등록된 후보 한 줄. 설정·세션에 그대로 직렬화된다. */
export interface EmotionCandidateRecord {
  /** 불투명 id. 내용 SHA 와 구간에서 나온다 — 표시 이름이 들어가지 않는다. */
  candidateId: string
  /** 파서가 만든 내부 stable id. 표시 이름이 아니다. */
  speakerId: string
  /** **사용자가 직접 지정한** 감정. 앱이 자동 분류하지 않는다. */
  emotionId: string
  /** 사용자가 고른 원본 파일. local/private 전용 — manifest 로 나가지 않는다. */
  sourcePath: string
  sourceSha256: string
  sourceDurationSec: number
  /** 확장자에서 온 형식 토큰(`wav`, `mp3` …). 내용 검사 결과가 아니다. */
  sourceFormat: string
  /** 확정한 구간. 원본을 그대로 쓰면 `null`. */
  region: CandidateRegion | null
  /** 파생 클립의 내용 기반 id. 아직 만들지 않았으면 `null`. */
  effectiveClipId: string | null
  /** 시간축 감정 프로필 id(`ep3_…`). 못 쟀으면 `null` — 지어내지 않는다. */
  profileId: string | null
  qualityState: CandidateQualityState
  qualityCodes: readonly string[]
  /** 호출부가 선언한 출처. 앱이 추측하지 않는다. */
  sourceKind: CandidateSourceKind
  /** 자동 추천 대상인가. 음악 분리 음원과 품질 부적합은 false 다. */
  autoRecommendable: boolean
  lifecycle: CandidateLifecycle
  /** 준비되지 않은 이유(비민감 토큰). ready 면 `null`. */
  lifecycleCode: string | null
}

/** (화자, 감정) 하나의 상태. 후보 목록과 선택은 서로 다른 축이다. */
export interface EmotionSlotState {
  candidates: readonly EmotionCandidateRecord[]
  /** 사용자가 고른 후보 id 또는 기본/사용 안 함 토큰. 없으면 `null`. */
  userSelected: string | null
  /** 앱이 제안한 후보 id. 없으면 `null`(후보가 하나뿐이면 만들지 않는다). */
  recommended: string | null
}

/** 등록 전체. 평평한 목록 하나로 두어 직렬화·비교가 단순하다. */
export interface CandidateRegistry {
  schemaVersion: number
  records: readonly EmotionCandidateRecord[]
}

export const EMPTY_REGISTRY: CandidateRegistry = {
  schemaVersion: CANDIDATE_REGISTRY_SCHEMA_VERSION,
  records: [],
}

/** (화자, 감정) 키. Python `speaker_refs.emotion_key` 와 같은 문자열이다. */
export function slotKey(speakerId: string, emotionId: string): string {
  return `${speakerId}${String.fromCharCode(31)}${emotionId || 'default'}`
}

/** 구간을 정수 토큰으로. 부동소수 표기 차이로 id 가 흔들리지 않게 한다. */
function regionToken(region: CandidateRegion | null): string {
  if (!region) return 'w'
  const s = Math.round(region.start * 1000)
  const d = Math.round(region.duration * 1000)
  return `r${s}-${d}`
}

/**
 * 후보 id. **내용 SHA + 구간**에서만 나온다.
 *
 * 화자·감정을 넣지 않는 이유가 두 개다. (1) 표시 이름이 id 로 새지 않는다.
 * (2) 같은 파일의 같은 구간은 어느 인물에게 등록해도 같은 파생 클립을 쓰므로, 클립을
 * 공유하고 있다는 사실이 id 에서 그대로 드러난다 — 후보 하나를 지울 때 남이 쓰는 클립을
 * 지우지 않으려면 이 사실이 필요하다.
 *
 * 조회는 언제나 (화자, 감정)으로 좁혀서 한다. 기록에도 화자·감정이 함께 나가므로
 * 같은 id 가 다른 슬롯에 있어도 뜻이 헷갈리지 않는다.
 */
export function makeCandidateId(sourceSha256: string, region: CandidateRegion | null): string {
  const head = (sourceSha256 || '').slice(0, 12) || 'unknown00000'
  return `cand_${head}_${regionToken(region)}`
}

/** 음악에서 분리한 목소리와 품질 부적합은 자동 추천 대상이 아니다. */
export function autoRecommendable(
  sourceKind: CandidateSourceKind, qualityState: CandidateQualityState
): boolean {
  if (sourceKind === 'separated_stem') return false
  return qualityState !== 'invalid'
}

/** 참조로 쓸 수 있는 길이(초). 기존 참조 정책과 같은 경계이며 여기서 새로 정하지 않는다. */
export const CANDIDATE_MIN_SEC = 3.0
export const CANDIDATE_MAX_SEC = 10.0

/**
 * 지금 이 후보의 처지. 파일 존재 여부는 **주입받는다** — 이 모듈은 디스크를 보지 않는다.
 *
 * 원본이 사라지면 `expired` 다. 다른 후보로 바꿔 주지 않는다 — 사용자가 고른 목소리가
 * 조용히 다른 목소리로 바뀌는 것이 가장 나쁜 실패다.
 */
export function evaluateLifecycle(
  record: Pick<EmotionCandidateRecord,
  'sourceDurationSec' | 'region' | 'effectiveClipId' | 'qualityState'>,
  present: { sourcePresent: boolean; clipPresent: boolean }
): { lifecycle: CandidateLifecycle; lifecycleCode: string | null } {
  if (!present.sourcePresent) {
    return { lifecycle: 'expired', lifecycleCode: 'SOURCE_FILE_MISSING' }
  }
  if (record.qualityState === 'invalid') {
    return { lifecycle: 'error', lifecycleCode: 'REFERENCE_QUALITY_INVALID' }
  }
  if (record.region) {
    // 구간을 확정했으면 파생 클립이 있어야 쓸 수 있다. 없으면 원본+구간으로 다시 만든다.
    return present.clipPresent
      ? { lifecycle: 'ready', lifecycleCode: null }
      : { lifecycle: 'needs_region', lifecycleCode: 'DERIVED_CLIP_MISSING' }
  }
  if (record.sourceDurationSec > CANDIDATE_MAX_SEC) {
    return { lifecycle: 'needs_region', lifecycleCode: 'SOURCE_TOO_LONG' }
  }
  if (record.sourceDurationSec > 0 && record.sourceDurationSec < CANDIDATE_MIN_SEC) {
    return { lifecycle: 'error', lifecycleCode: 'SOURCE_TOO_SHORT' }
  }
  if (record.sourceDurationSec <= 0) {
    return { lifecycle: 'needs_region', lifecycleCode: 'SOURCE_NOT_ANALYZED' }
  }
  // 3~10초 원본은 그 자체를 effective 로 쓸 수 있다(파생 클립을 강제로 만들지 않는다).
  return { lifecycle: 'ready', lifecycleCode: null }
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/**
 * 이 (화자, 감정)의 후보만. **다른 인물의 후보는 여기 없다.**
 *
 * 걸러내는 것이 아니라 애초에 담기지 않는 구조가 교차 오염을 막는다.
 */
export function candidatesFor(
  registry: CandidateRegistry, speakerId: string, emotionId: string
): EmotionCandidateRecord[] {
  return registry.records.filter(
    (r) => r.speakerId === speakerId && r.emotionId === (emotionId || 'default'))
}

/** 이 파생 클립을 쓰는 후보 수. 0 이 되기 전에는 클립을 지우지 않는다. */
export function clipRefCount(registry: CandidateRegistry, clipId: string | null): number {
  if (!clipId) return 0
  return registry.records.filter((r) => r.effectiveClipId === clipId).length
}

// ── 변경 ────────────────────────────────────────────────────────────────────

/**
 * 후보 등록. 사용자가 화자와 감정을 **직접 지정**해 부른다 — 앱이 감정을 분류하지 않는다.
 *
 * 같은 (화자, 감정)에 같은 id 가 이미 있으면 덮어쓴다(같은 파일의 같은 구간은 같은 후보다).
 * 다른 슬롯의 기록은 건드리지 않는다. 원본 파일을 복사·수정·이동하지 않는다.
 */
export function registerCandidate(
  registry: CandidateRegistry, record: EmotionCandidateRecord
): CandidateRegistry {
  const same = (r: EmotionCandidateRecord) =>
    r.speakerId === record.speakerId && r.emotionId === record.emotionId
    && r.candidateId === record.candidateId
  const kept = registry.records.filter((r) => !same(r))
  return { ...registry, records: [...kept, record] }
}

/**
 * 후보 해제. **원본 파일을 지우는 일이 아니다.**
 *
 * 반환의 `releasableClipIds` 는 이제 아무 후보도 쓰지 않는 파생 클립이다. 다른 후보가
 * 아직 쓰고 있는 클립은 여기 들어가지 않는다 — 남의 클립을 조기에 지우면 그 후보가
 * `expired` 로 떨어진다.
 */
export function removeCandidate(
  registry: CandidateRegistry, speakerId: string, emotionId: string, candidateId: string
): { registry: CandidateRegistry; releasableClipIds: string[] } {
  const eid = emotionId || 'default'
  const target = registry.records.find(
    (r) => r.speakerId === speakerId && r.emotionId === eid && r.candidateId === candidateId)
  if (!target) return { registry, releasableClipIds: [] }
  const next: CandidateRegistry = {
    ...registry,
    records: registry.records.filter((r) => r !== target),
  }
  const clip = target.effectiveClipId
  const releasable = clip && clipRefCount(next, clip) === 0 ? [clip] : []
  return { registry: next, releasableClipIds: releasable }
}

/**
 * 사용자 선택을 지운다. 후보를 지우는 것과 다르다 — 선택만 없어지고 후보는 남는다.
 * 지워진 후보를 가리키던 선택은 이 함수로 함께 정리한다(가리킬 대상이 없으므로).
 */
export function pruneSelections(
  registry: CandidateRegistry, selections: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(selections)) {
    if (value === USER_CHOICE_SPEAKER_DEFAULT || value === USER_CHOICE_NO_EMOTION_REF) {
      out[key] = value
      continue
    }
    // 후보 id 를 가리키는 선택은 그 후보가 **그 슬롯에** 살아 있을 때만 유지한다.
    const alive = registry.records.some((r) => slotKey(r.speakerId, r.emotionId) === key
      && r.candidateId === value)
    if (alive) out[key] = value
  }
  return out
}

// ── 해석 ────────────────────────────────────────────────────────────────────

export interface SlotResolution {
  /** 실제로 쓰일 후보. 없으면 `null`(감정 후보를 쓰지 않는다는 뜻). */
  candidateId: string | null
  recommended: string | null
  userSelected: string | null
  reason: SelectionReason | null
  /** 후보가 둘 미만 — 화면이 "가장 적합"이라 말하면 안 된다. */
  insufficientCandidates: boolean
  /** 고른 후보가 준비되지 않았다. 조용히 다른 것으로 바꾸지 않고 여기서 막는다. */
  blockedCode: string | null
}

/**
 * 이 슬롯이 실제로 어떤 후보를 쓰는가.
 *
 * 규칙 순서: 사용자 선택 → 자동 제안 → 없음. **수동 선택이 제안보다 우선한다.**
 * 고른 후보가 `ready` 가 아니면 다른 후보로 넘어가지 않고 막는다(fail-closed).
 */
export function resolveSlot(
  registry: CandidateRegistry, speakerId: string, emotionId: string,
  selections: Readonly<Record<string, string>>,
  recommendations: Readonly<Record<string, string>> = {}
): SlotResolution {
  const key = slotKey(speakerId, emotionId)
  const list = candidatesFor(registry, speakerId, emotionId)
  const recommended = recommendations[key] || null
  const chosen = selections[key] || null
  const base: SlotResolution = {
    candidateId: null, recommended, userSelected: chosen, reason: null,
    insufficientCandidates: list.length < 2, blockedCode: null,
  }

  if (chosen === USER_CHOICE_NO_EMOTION_REF) {
    return { ...base, reason: 'USER_DECLINED_EMOTION_REFERENCE' }
  }
  if (chosen === USER_CHOICE_SPEAKER_DEFAULT) {
    return { ...base, reason: 'USER_CHOSE_SPEAKER_DEFAULT' }
  }
  if (chosen) {
    const hit = list.find((r) => r.candidateId === chosen)
    if (!hit) {
      // 고른 후보가 이 슬롯에 없다 — 다른 인물의 것으로도, 제안으로도 대체하지 않는다.
      return { ...base, reason: 'USER_SELECTION_NOT_A_CANDIDATE',
        blockedCode: 'USER_SELECTION_NOT_A_CANDIDATE' }
    }
    if (hit.lifecycle !== 'ready') {
      return { ...base, reason: 'USER_CHANGED_CANDIDATE', blockedCode: hit.lifecycleCode }
    }
    return {
      ...base, candidateId: hit.candidateId,
      reason: chosen === recommended
        ? 'USER_KEPT_RECOMMENDATION' : 'USER_CHANGED_CANDIDATE',
    }
  }
  if (recommended && !base.insufficientCandidates) {
    const hit = list.find((r) => r.candidateId === recommended)
    if (hit && hit.lifecycle === 'ready' && hit.autoRecommendable) {
      return { ...base, candidateId: hit.candidateId,
        reason: 'AUTO_PROVISIONAL_RECOMMENDATION' }
    }
  }
  return base
}

/** 후보의 실제 합성 경로. `ready` 가 아니면 빈 문자열(생성이 막힌다). */
export function effectivePathOf(
  record: EmotionCandidateRecord, clipPathOf: (clipId: string) => string | undefined
): string {
  if (record.lifecycle !== 'ready') return ''
  if (record.region) return clipPathOf(record.effectiveClipId ?? '') ?? ''
  return record.sourcePath
}

/**
 * 생성기에 넘길 `(화자, 감정) → 경로` 표.
 *
 * 슬롯마다 **고른 하나만** 담는다. 후보 목록을 생성 worker 로 보내지 않는다 — 생성기는
 * 기존의 정확한 `(화자, 감정)` 참조 계약을 그대로 쓴다.
 */
export function toSpeakerEmotionRefs(
  registry: CandidateRegistry,
  selections: Readonly<Record<string, string>>,
  recommendations: Readonly<Record<string, string>>,
  clipPathOf: (clipId: string) => string | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  const slots = new Set(registry.records.map((r) => slotKey(r.speakerId, r.emotionId)))
  for (const key of slots) {
    const [speakerId, emotionId] = key.split(String.fromCharCode(31))
    const res = resolveSlot(registry, speakerId, emotionId, selections, recommendations)
    if (!res.candidateId) continue
    const hit = candidatesFor(registry, speakerId, emotionId)
      .find((r) => r.candidateId === res.candidateId)
    if (!hit) continue
    const path = effectivePathOf(hit, clipPathOf)
    if (path) out[key] = path
  }
  return out
}

/**
 * run bundle 로 나갈 선택 기록. **경로도 표시 이름도 담지 않는다.**
 *
 * 요청·제안·사용자 선택·실제 결과를 서로 다른 필드로 남긴다 — 한 칸에 뭉개면 나중에
 * "이건 앱이 고른 것인가 사람이 고른 것인가"를 되짚을 수 없다.
 */
export function selectionRecordFor(
  registry: CandidateRegistry, speakerId: string, emotionId: string,
  selections: Readonly<Record<string, string>>,
  recommendations: Readonly<Record<string, string>>
): {
  requestedEmotion: string
  recommendedCandidate: string | null
  userSelectedCandidate: string | null
  resolvedCandidate: string | null
  selectionReason: SelectionReason | null
  insufficientCandidates: boolean
  candidateCount: number
  blockedCode: string | null
} {
  const res = resolveSlot(registry, speakerId, emotionId, selections, recommendations)
  return {
    requestedEmotion: emotionId || 'default',
    recommendedCandidate: res.recommended,
    userSelectedCandidate: res.userSelected,
    resolvedCandidate: res.candidateId,
    selectionReason: res.reason,
    insufficientCandidates: res.insufficientCandidates,
    candidateCount: candidatesFor(registry, speakerId, emotionId).length,
    blockedCode: res.blockedCode,
  }
}
