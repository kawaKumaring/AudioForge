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

/**
 * 구간. `null` 은 "원본을 그대로 쓴다"는 뜻이며 구간 미확정과 다르다.
 *
 * **identity 는 frame 이다.** 초 좌표만으로 자산을 식별하면 1ms 안의 서로 다른 구간이
 * 같은 것으로 접힌다. 초 좌표는 화면 표시와 복원용으로 함께 보관한다 — 기존 region 계약이
 * 초 단위이기 때문이다.
 */
export interface CandidateRegion {
  /** 표시·복원용. identity 아님. */
  start: number
  duration: number
  /** canonical identity — 같은 assetId 는 **같은 PCM 구간**을 뜻해야 한다. */
  sampleRate: number
  startFrame: number
  endFrame: number
}

/**
 * 초 좌표 → frame 좌표. 결정적으로 반올림한다.
 *
 * 기존 계약(ReferenceRegionPanel·trim 경로)이 초를 쓰므로 초를 버리지 않고, frame 을
 * 함께 계산해 identity 로 쓴다. 같은 (초, 표본율) 입력이면 항상 같은 frame 이 나온다.
 */
export function regionFromSeconds(
  start: number, duration: number, sampleRate: number
): CandidateRegion {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('regionFromSeconds: sampleRate 가 필요하다(자산 identity 의 일부다)')
  }
  const sr = Math.round(sampleRate)
  const startFrame = Math.max(0, Math.round(start * sr))
  const endFrame = Math.max(startFrame, Math.round((start + duration) * sr))
  return { start, duration, sampleRate: sr, startFrame, endFrame }
}

/**
 * 후보 하나가 지금 어떤 처지인가.
 *   ready        — 그대로 합성에 쓸 수 있다
 *   needs_region — 원본이 10초를 넘어 구간을 확정해야 한다
 *   expired      — 원본이나 파생 클립이 사라졌다. **조용히 다른 후보로 바꾸지 않는다.**
 *   changed      — 경로는 그대로인데 **내용(SHA)이 달라졌다.** 같은 자산으로 쓰지 않는다.
 *   unverified   — SHA 를 모른다(과거·불완전 자료). 검사를 건너뛰고 ready 로 만들지 않는다.
 *   quarantined  — 저장된 기록 한 건이 어긋났다. 그 후보만 격리하고 나머지는 살린다.
 *   error        — 참조로 쓸 수 없는 파일이다(품질 부적합·디코딩 실패)
 */
export const CANDIDATE_LIFECYCLE = [
  'ready', 'needs_region', 'expired', 'changed', 'unverified', 'quarantined', 'error',
] as const
export type CandidateLifecycle = typeof CANDIDATE_LIFECYCLE[number]

/** 등록된 후보 한 줄. 설정·세션에 그대로 직렬화된다. */
export interface EmotionCandidateRecord {
  /**
   * 이 슬롯(화자+감정)에 등록된 **후보**의 identity. 선택·삭제·복원이 이것을 가리킨다.
   * `assetId` + 화자 id + 감정 id 에서 나오며, 표시 이름과 원본 경로는 입력이 아니다.
   */
  candidateId: string
  /**
   * **물리 자산**(오디오 내용 + 구간)의 identity. 여러 화자·감정 후보가 공유할 수 있고,
   * 파생 클립의 수명과 refcount 를 소유한다.
   */
  assetId: string
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

/**
 * 중립 감정의 id. **화자의 기본 목소리와 다른 개념이다.**
 *
 *   · speaker default voice  — 그 인물의 기준 목소리. `ttsSpeakerRefState[speakerId]` 가
 *     소유하며 이 등록부에 들어오지 않는다. 감정 후보를 다 지워도 사라지지 않는다.
 *   · neutral emotion candidate — 감정 비교의 **원점**으로 등록한 후보. 이 등록부의
 *     `emotionId === NEUTRAL_EMOTION_ID` 행이며, 해제하면 이 후보만 사라진다.
 *
 * 파일럿의 중립 녹음은 후자다. 둘을 같은 것으로 취급하면 중립 후보를 지우는 순간 그
 * 인물의 목소리가 사라진다.
 */
export const NEUTRAL_EMOTION_ID = 'default'

/** 이 등록부가 화자 기본 목소리를 담고 있지 않은가 — 구조적으로 항상 참이어야 한다. */
export function holdsOnlyEmotionCandidates(registry: CandidateRegistry): boolean {
  return registry.records.every((r) => !!r.speakerId && !!r.emotionId)
}

/** (화자, 감정) 키. Python `speaker_refs.emotion_key` 와 같은 문자열이다. */
export function slotKey(speakerId: string, emotionId: string): string {
  return `${speakerId}${String.fromCharCode(31)}${emotionId || 'default'}`
}

/** 구간을 frame 토큰으로. 1ms 안의 다른 구간이 같은 토큰이 되지 않는다. */
function regionToken(region: CandidateRegion | null): string {
  if (!region) return 'whole'
  return `f${region.startFrame}-${region.endFrame}@${region.sampleRate}`
}

/**
 * **물리 자산** id — 오디오 내용과 구간의 identity.
 *
 * 같은 파일의 같은 PCM 구간은 어느 화자·감정에 등록해도 같은 `assetId` 다. 파생 클립을
 * 공유한다는 사실이 여기서 드러나야, 후보 하나를 지울 때 남이 쓰는 클립을 지우지 않는다.
 *
 * 표시 이름·원본 경로는 입력이 아니다. 내용 SHA 와 frame 좌표뿐이다.
 */
export function makeAssetId(sourceSha256: string, region: CandidateRegion | null): string {
  const head = (sourceSha256 || '').slice(0, 16) || 'unknown000000000'
  return `asset_${head}_${regionToken(region)}`
}

/** 문자열 → hex 해시. 값 import 금지 규약 때문에 **주입받는다**(사본을 만들지 않는다). */
export type HashHex = (input: string) => string

/**
 * **후보 등록** id — 특정 (화자, 감정) 슬롯에 등록된 후보의 identity.
 *
 * 같은 자산을 다른 화자나 다른 감정에 등록하면 서로 다른 id 가 나온다. 같은 슬롯에 같은
 * 자산을 다시 등록하면 같은 id 가 나와 중복이 생기지 않는다.
 *
 * 입력은 `assetId` + **내부 stable** 화자 id + 감정 id 뿐이다 — 사용자가 쓴 표시 이름과
 * 원본 경로는 들어가지 않는다. 해시 함수는 주입받는다: 저장소 규약상 공용 모듈끼리 값
 * import 를 할 수 없고, sha256 사본을 하나 더 만드는 것보다 주입이 낫다.
 */
export function makeCandidateId(
  assetId: string, speakerId: string, emotionId: string, hashHex: HashHex
): string {
  const US = String.fromCharCode(31)
  const digest = hashHex([assetId, speakerId, emotionId || 'default'].join(US))
  return `cand_${digest.slice(0, 16)}`
}

/**
 * 자동 추천 대상인가. 음악 분리 음원·품질 부적합·**무결성 미확인**은 제외다.
 *
 * `lifecycle` 을 함께 받는 이유: SHA 를 모르는 자산(`unverified`)은 사용자가 다시 확인하기
 * 전까지 추천도 생성도 하지 않는다.
 */
export function autoRecommendable(
  sourceKind: CandidateSourceKind, qualityState: CandidateQualityState,
  lifecycle: CandidateLifecycle = 'ready'
): boolean {
  if (sourceKind === 'separated_stem') return false
  if (lifecycle === 'unverified' || lifecycle === 'quarantined') return false
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
  'sourceDurationSec' | 'region' | 'effectiveClipId' | 'qualityState' | 'sourceSha256'>,
  present: {
    sourcePresent: boolean
    clipPresent: boolean
    /** 지금 디스크에 있는 원본의 SHA. 모르면 생략한다(모름을 같음으로 보지 않는다). */
    currentSourceSha256?: string | null
  }
): { lifecycle: CandidateLifecycle; lifecycleCode: string | null } {
  if (!present.sourcePresent) {
    return { lifecycle: 'expired', lifecycleCode: 'SOURCE_FILE_MISSING' }
  }
  // 새 등록에는 SHA 가 필수다. 과거·불완전 자료에 없으면 **검사를 건너뛰고 ready 로
  // 만들지 않는다** — 무결성을 확인할 수 없는 자산을 자동으로 쓰면 조용히 다른 소리가 난다.
  if (!record.sourceSha256) {
    return { lifecycle: 'unverified', lifecycleCode: 'SOURCE_SHA_ABSENT' }
  }
  // 경로가 살아 있어도 내용이 바뀌었으면 같은 자산이 아니다. 다시 쓰지 않는다 —
  // 사용자가 등록했던 목소리가 조용히 다른 소리로 바뀌는 것이 가장 나쁜 실패다.
  if (present.currentSourceSha256 && present.currentSourceSha256 !== record.sourceSha256) {
    return { lifecycle: 'changed', lifecycleCode: 'SOURCE_SHA_MISMATCH' }
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

/**
 * 이 **자산**을 참조하는 후보 수. 파생 클립의 수명은 자산이 소유한다.
 *
 * 후보 id 로 세면 안 된다 — 같은 자산이 여러 화자·감정에 등록돼 있으면 후보 id 는 서로
 * 다르지만 파생 클립은 하나이기 때문이다.
 */
export function assetRefCount(registry: CandidateRegistry, assetId: string | null): number {
  if (!assetId) return 0
  return registry.records.filter((r) => r.assetId === assetId).length
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
 * 지우는 것은 이 슬롯의 등록 하나뿐이다. 다른 화자·감정의 후보는 그대로 남는다.
 *
 * 반환의 `releasableClipIds` 는 **앱이 만든 임시 파생 클립** 중 이제 아무 후보도, 아무
 * 선택도 그 자산을 가리키지 않는 것이다. 하나라도 남아 있으면 비어 있다 — 남이 쓰는
 * 클립을 조기에 지우면 그 후보가 `expired` 로 떨어진다.
 *
 * 구간 없이 원본을 그대로 쓰는 후보는 `effectiveClipId` 가 없다. 즉 이 함수가 놓아 주는
 * 대상에 **사용자 원본은 구조적으로 들어갈 수 없다.**
 */
export function removeCandidate(
  registry: CandidateRegistry, speakerId: string, emotionId: string, candidateId: string,
  selections: Readonly<Record<string, string>> = {}
): {
  registry: CandidateRegistry
  /** 삭제와 **같은 전이**에서 정리된 선택. dangling 선택이 남지 않는다. */
  selections: Record<string, string>
  releasableClipIds: string[]
} {
  const eid = emotionId || 'default'
  const target = registry.records.find(
    (r) => r.speakerId === speakerId && r.emotionId === eid && r.candidateId === candidateId)
  if (!target) {
    return { registry, selections: { ...selections }, releasableClipIds: [] }
  }
  const next: CandidateRegistry = {
    ...registry,
    records: registry.records.filter((r) => r !== target),
  }
  // 삭제와 선택 해제는 하나의 상태 전이다. 지운 후보를 가리키는 선택을 **명시적으로**
  // 없앤다 — 다른 후보로 자동 교체하지 않고, 가리킬 대상이 없는 선택도 남기지 않는다.
  const nextSelections = pruneSelections(next, selections)
  const clip = target.effectiveClipId
  if (!clip) return { registry: next, selections: nextSelections, releasableClipIds: [] }
  // 자산을 참조하는 후보가 남아 있으면 놓아 주지 않는다.
  if (assetRefCount(next, target.assetId) > 0) {
    return { registry: next, selections: nextSelections, releasableClipIds: [] }
  }
  return { registry: next, selections: nextSelections, releasableClipIds: [clip] }
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

// ── 전역 자산 저장과 scope 바인딩 (R1 교정) ────────────────────────────────
//
//   두 책임을 갈라 둔다.
//
//   · **전역 `referenceAssets`** — 물리 자산과 파생 클립의 수명만 소유한다. 앱 전체
//     공용(`settings.json`)이어도 무해하다: 자산은 "이 파일의 이 구간"이라는 사실이고
//     어느 대본의 누구인지와 무관하기 때문이다.
//   · **scope 별 `speakerEmotionBindings`** — "이 대본의 민수의 기쁨은 이 후보다"라는
//     연결이다. 대본 이름에서 나온 `speakerId` 를 전역 키로 쓰면, 서로 다른 프로젝트의
//     같은 이름이 같은 목소리를 공유한다. **그래서 전역에 저장하지 않는다.**
//
//   지금 이 저장소에는 재사용할 durable project/session id 가 없다(감사 결과). 그래서
//   바인딩은 `scopeId` 를 **필수 인자**로 받는 메모리 구조로만 두고, 영속 통로를 만들지
//   않는다. scope 계약이 정해진 뒤에 이어 붙인다.
//
//   이름이 같다는 이유로 다른 scope 의 목소리를 자동 재사용하지 않는다. 프로젝트를 넘는
//   재사용은 앞으로 **명시적인 voice profile 연결**로만 한다.

/** `settings.json` 안의 전역 자산 키. 바인딩은 여기 들어가지 않는다. */
export const GLOBAL_ASSET_STORAGE_KEY = 'referenceAssets'

/** 저장 파일에 함께 적는 스키마 버전. 모르는 버전은 조용히 해석하지 않는다. */
export const ASSET_STORAGE_SCHEMA_VERSION = 1

/** 전역에 저장되는 자산 한 건 — 화자·감정이 **없다.** */
export type ReferenceAsset = Pick<EmotionCandidateRecord,
  'assetId' | 'sourcePath' | 'sourceSha256' | 'sourceDurationSec' | 'sourceFormat'
  | 'region' | 'effectiveClipId' | 'profileId' | 'qualityState' | 'qualityCodes'
  | 'sourceKind' | 'lifecycle' | 'lifecycleCode'>

/** scope 안의 연결 한 건 — 파일에 대한 사실이 **없다.** */
export interface SpeakerEmotionBinding {
  scopeId: string
  speakerId: string
  emotionId: string
  candidateId: string
  assetId: string
}

/** 후보 한 줄에서 전역 자산 부분만. */
export function assetOf(record: EmotionCandidateRecord): ReferenceAsset {
  const {
    assetId, sourcePath, sourceSha256, sourceDurationSec, sourceFormat, region,
    effectiveClipId, profileId, qualityState, qualityCodes, sourceKind, lifecycle,
    lifecycleCode,
  } = record
  return {
    assetId, sourcePath, sourceSha256, sourceDurationSec, sourceFormat, region,
    effectiveClipId, profileId, qualityState, qualityCodes, sourceKind, lifecycle,
    lifecycleCode,
  }
}

/** 후보 한 줄에서 scope 연결 부분만. `scopeId` 는 호출부가 준다(기본값 없음). */
export function bindingOf(
  record: EmotionCandidateRecord, scopeId: string
): SpeakerEmotionBinding {
  if (!scopeId) throw new Error('bindingOf: scopeId 가 필요하다(전역 저장 금지)')
  return {
    scopeId,
    speakerId: record.speakerId,
    emotionId: record.emotionId,
    candidateId: record.candidateId,
    assetId: record.assetId,
  }
}

/** scope 안의 (화자, 감정) 키. `slotKey` 와 달리 scope 를 포함한다. */
export function scopedSlotKey(scopeId: string, speakerId: string, emotionId: string): string {
  if (!scopeId) throw new Error('scopedSlotKey: scopeId 가 필요하다')
  const US = String.fromCharCode(31)
  return `${scopeId}${US}${speakerId}${US}${emotionId || 'default'}`
}

export interface StoredAssetStore {
  schemaVersion: number
  assets: readonly ReferenceAsset[]
}

/** 전역에 저장할 형태. 화자·감정·선택이 들어갈 자리가 없다. */
export function serializeAssetStore(assets: readonly ReferenceAsset[]): StoredAssetStore {
  return { schemaVersion: ASSET_STORAGE_SCHEMA_VERSION, assets }
}

/** 전역 저장 payload 에 scope 정보가 섞이지 않았는지. 구조적으로 항상 참이어야 한다. */
export function payloadHasNoScopeData(payload: unknown): boolean {
  const blob = JSON.stringify(payload ?? null)
  for (const forbidden of ['speakerId', 'emotionId', 'candidateId', 'scopeId',
    'selections', 'recommended']) {
    if (blob.includes(forbidden)) return false
  }
  return true
}

/** 복원 결과 집계. **경로와 표시 이름은 담지 않는다.** */
export interface RestoreReport {
  restored: number
  quarantined: number
  expired: number
  changed: number
  unverified: number
  /** 등록부 전체를 쓸 수 없게 만든 사유. 있으면 저장된 원본을 덮어쓰지 않는다. */
  rootError: string | null
}

const REQUIRED_ASSET_FIELDS = ['assetId', 'sourcePath'] as const

/**
 * 전역 자산 복원. **한 건이 어긋나도 전체를 버리지 않는다.**
 *
 *   · root 스키마/버전을 모르면 그 등록부만 사용 중지하고 `rootError` 를 돌려준다.
 *     호출부는 이때 **자동으로 빈 등록부를 저장하지 않는다**(원본이 사라진다).
 *   · 자산 한 건이 어긋나면 그 건만 `quarantined` 로 남기고 나머지는 복원한다.
 *   · 없거나 SHA 가 달라진 자산은 그 자산만 `expired` / `changed` 다.
 */
export function deserializeAssetStore(
  raw: unknown,
  probe: (asset: ReferenceAsset) => {
    sourcePresent: boolean; clipPresent: boolean; currentSourceSha256?: string | null
  } = () => ({ sourcePresent: true, clipPresent: true })
): { assets: ReferenceAsset[]; report: RestoreReport } {
  const empty: RestoreReport = {
    restored: 0, quarantined: 0, expired: 0, changed: 0, unverified: 0, rootError: null,
  }
  if (raw == null) return { assets: [], report: { ...empty, rootError: 'ABSENT' } }
  if (typeof raw !== 'object') {
    return { assets: [], report: { ...empty, rootError: 'MALFORMED_ROOT' } }
  }
  const o = raw as Partial<StoredAssetStore>
  if (o.schemaVersion !== ASSET_STORAGE_SCHEMA_VERSION) {
    return { assets: [], report: { ...empty, rootError: 'SCHEMA_VERSION_UNSUPPORTED' } }
  }
  if (!Array.isArray(o.assets)) {
    return { assets: [], report: { ...empty, rootError: 'MALFORMED_ROOT' } }
  }

  const out: ReferenceAsset[] = []
  const report = { ...empty }
  for (const item of o.assets) {
    const bad = !item || typeof item !== 'object'
      || REQUIRED_ASSET_FIELDS.some(
        (k) => typeof (item as Record<string, unknown>)[k] !== 'string'
          || !(item as Record<string, string>)[k])
    if (bad) {
      report.quarantined++
      // 격리한 건도 목록에서 지우지 않는다 — 무엇이 어긋났는지 사용자가 볼 수 있어야 한다.
      const id = (item as { assetId?: unknown })?.assetId
      out.push({
        assetId: typeof id === 'string' && id ? id : `asset_quarantined_${report.quarantined}`,
        sourcePath: '', sourceSha256: '', sourceDurationSec: 0, sourceFormat: '',
        region: null, effectiveClipId: null, profileId: null,
        qualityState: 'unknown', qualityCodes: [], sourceKind: 'unknown',
        lifecycle: 'quarantined', lifecycleCode: 'STORED_RECORD_MALFORMED',
      })
      continue
    }
    const asset = item as ReferenceAsset
    const got = evaluateLifecycle(asset, probe(asset))
    const next: ReferenceAsset = { ...asset, ...got }
    if (got.lifecycle === 'expired') report.expired++
    else if (got.lifecycle === 'changed') report.changed++
    else if (got.lifecycle === 'unverified') report.unverified++
    else report.restored++
    out.push(next)
  }
  return { assets: out, report }
}

// ⚠️ 이전 판에는 `CANDIDATE_STORAGE_KEY`(= 화자·감정 선택까지 담는 전역 등록부) 절이
//    있었다. 대본 이름에서 나온 speakerId 를 전역 키로 저장하면 서로 다른 프로젝트의
//    같은 이름이 같은 목소리를 공유한다 — 그래서 **그 통로를 제거했다.**
//    바인딩은 durable scope 계약이 정해진 뒤에 붙인다(위 절 참조).
