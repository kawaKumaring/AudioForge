// 현재 작업 자동 저장 — 합성하지 않아도 남는 "지금 만들던 것" 의 기록. 순수 로직(fs/Electron/React 없음).
//
// 왜 필요한가: `session.json` 은 실행 결과 처리 안에서만 쓰인다(합성이 끝나야 생긴다). 목소리를 지정하고
// 구간을 확정한 뒤 합성하지 않고 앱을 닫으면 남는 기록이 없다. 그래서 구간 필드를 추가하는 것만으로는
// "재시작 후 복원" 이 되지 않는다.
//
// 경계(이 저장이 하지 않는 것):
//   · 사용자가 명시적으로 저장하는 **목소리 구성**(voiceCasts)과 **전역 자산 등록부**(referenceAssets)를
//     건드리지 않는다. 저장 키가 다르고 main 이 키 하나만 원자적으로 교체한다.
//   · 다른 작업의 기록을 건드리지 않는다. 작업마다 자기 열쇠 아래에만 쓴다.
//   · 대사 원문 외의 사용자 내용(참조 전사문 등)을 담지 않는다.
//
// 작업 열쇠(workKey): 이 앱에는 작업 식별자가 따로 없고, 작업은 **불러온 원본 파일**에 묶여 있다
// (파일을 새로 열면 인물·목소리 상태가 전부 비워진다). 그래서 원본 경로를 정규화한 값을 열쇠로 쓴다.
// 전역 화자 이름으로 묶지 않는다 — 다른 작업의 같은 이름은 같은 사람이 아니다.
// 원본이 옮겨진 경우를 위해 기록에 `sourceSha256` 자리를 두었다. 값은 앱 보관(라이브러리 승격)이
// 계산해 준 것을 받아 적을 뿐, 이 저장이 스스로 큰 음원을 해시하지 않는다.

export const WORK_DRAFT_STORAGE_KEY = 'workDrafts'
export const WORK_DRAFT_SCHEMA_VERSION = 1

/** 보관할 작업 수 상한. 넘으면 가장 오래 손대지 않은 것부터 버린다(무한 증식 방지). */
export const MAX_WORK_DRAFTS = 20

export interface WorkRegion {
  start: number
  duration: number
}

/** 인물 하나의 목소리 지정. `clip` 은 담지 않는다 — 임시 파일이라 재시작 후 뜻이 없다. */
export interface WorkSpeakerDraft {
  /** 사용자가 고른 원본 파일 경로. */
  source: string
  /** 사용자가 확정한 구간. 없으면 원본을 통째로 쓴 것이다. */
  region: WorkRegion | null
  /** 화면 표시 이름. 내부 id 와 다를 수 있다. */
  label: string
  /** 감정별 목소리를 쓰는 인물인가. */
  emotionEnabled: boolean
  /** 앱 보관 클립 식별자(보관에 성공한 뒤에만 채운다). */
  referenceId?: string
}

export interface WorkDraft {
  schemaVersion: number
  /** 원본 경로 원문. 화면 안내와 재연결에 쓴다(열쇠는 정규화한 값이다). */
  sourcePath: string
  /** 원본 내용 해시. 보관 과정에서 알게 됐을 때만 채운다. */
  sourceSha256?: string
  /** 마지막으로 손댄 시각(ISO). 상한을 넘겼을 때 무엇을 버릴지 정하는 기준. */
  updatedAt: string
  ttsText: string
  speakerMode: 'single' | 'multi'
  /** 내부 화자 id → 지정. */
  speakers: Record<string, WorkSpeakerDraft>
  /** 이름 별칭(저장된 구성 안의 id → 지금 id). */
  renames: Record<string, string>
  /** 첫 인물이 기본 목소리를 이어받는 중인지. */
  inheritSpeakerId: string | null
}

export interface StoredWorkDrafts {
  schemaVersion: number
  drafts: Record<string, WorkDraft>
}

export interface WorkDraftRestoreReport {
  restored: number
  quarantined: number
  /** 기록 전체를 쓸 수 없게 만든 사유. 있으면 저장된 원본을 덮어쓰지 않는다. */
  rootError: string | null
}

/**
 * 원본 경로 → 작업 열쇠.
 *
 * 이 앱은 Windows 에서 돌고 그곳의 경로는 대소문자를 구분하지 않는다. 구분자와 끝의 슬래시를
 * 맞추고 소문자로 낮춘다. 원문은 `sourcePath` 에 그대로 남으므로 화면에는 사용자가 고른 모양이 나온다.
 */
export function workKeyOf(sourcePath: string): string {
  const t = String(sourcePath ?? '').trim()
  if (!t) return ''
  return t.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function finiteRegion(v: unknown): WorkRegion | null {
  if (!v || typeof v !== 'object') return null
  const r = v as { start?: unknown; duration?: unknown }
  const start = typeof r.start === 'number' && Number.isFinite(r.start) ? r.start : null
  const duration = typeof r.duration === 'number' && Number.isFinite(r.duration) ? r.duration : null
  if (start === null || duration === null || start < 0 || duration <= 0) return null
  return { start, duration }
}

function readSpeaker(v: unknown): WorkSpeakerDraft | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const source = typeof s.source === 'string' ? s.source.trim() : ''
  if (!source) return null                       // 원본 없는 지정은 뜻이 없다
  const referenceId = typeof s.referenceId === 'string' && s.referenceId ? s.referenceId : undefined
  return {
    source,
    region: finiteRegion(s.region),
    label: typeof s.label === 'string' ? s.label : '',
    emotionEnabled: s.emotionEnabled === true,
    ...(referenceId ? { referenceId } : {}),
  }
}

function readStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k && typeof val === 'string' && val) out[k] = val
  }
  return out
}

/** 기록 하나를 읽는다. 어긋난 인물은 그 인물만 버리고 나머지는 살린다. */
export function readWorkDraft(v: unknown): WorkDraft | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Record<string, unknown>
  if (d.schemaVersion !== WORK_DRAFT_SCHEMA_VERSION) return null
  const sourcePath = typeof d.sourcePath === 'string' ? d.sourcePath.trim() : ''
  if (!sourcePath) return null
  const speakers: Record<string, WorkSpeakerDraft> = {}
  if (d.speakers && typeof d.speakers === 'object') {
    for (const [id, raw] of Object.entries(d.speakers as Record<string, unknown>)) {
      const one = readSpeaker(raw)
      if (id && one) speakers[id] = one
    }
  }
  const sourceSha256 = typeof d.sourceSha256 === 'string' && d.sourceSha256 ? d.sourceSha256 : undefined
  return {
    schemaVersion: WORK_DRAFT_SCHEMA_VERSION,
    sourcePath,
    ...(sourceSha256 ? { sourceSha256 } : {}),
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    ttsText: typeof d.ttsText === 'string' ? d.ttsText : '',
    speakerMode: d.speakerMode === 'multi' ? 'multi' : 'single',
    speakers,
    renames: readStringMap(d.renames),
    inheritSpeakerId: typeof d.inheritSpeakerId === 'string' && d.inheritSpeakerId ? d.inheritSpeakerId : null,
  }
}

/** 저장 형태로 감싼다. */
export function serializeWorkDrafts(drafts: Record<string, WorkDraft>): StoredWorkDrafts {
  return { schemaVersion: WORK_DRAFT_SCHEMA_VERSION, drafts }
}

/**
 * 저장 payload → 기록들.
 *
 * 한 건이 어긋나도 전체를 버리지 않는다. root 스키마를 모르면 그 기록 전체를 쓰지 않고
 * `rootError` 를 돌려준다 — 호출부는 그때 저장된 원본을 덮어쓰지 않아야 한다.
 */
export function deserializeWorkDrafts(raw: unknown): {
  drafts: Record<string, WorkDraft>
  report: WorkDraftRestoreReport
} {
  const empty = { drafts: {} as Record<string, WorkDraft> }
  if (raw == null) return { ...empty, report: { restored: 0, quarantined: 0, rootError: null } }
  if (typeof raw !== 'object') return { ...empty, report: { restored: 0, quarantined: 0, rootError: 'NOT_OBJECT' } }
  const root = raw as Record<string, unknown>
  if (root.schemaVersion !== WORK_DRAFT_SCHEMA_VERSION) {
    return { ...empty, report: { restored: 0, quarantined: 0, rootError: 'SCHEMA_VERSION' } }
  }
  if (!root.drafts || typeof root.drafts !== 'object') {
    return { ...empty, report: { restored: 0, quarantined: 0, rootError: 'DRAFTS_MISSING' } }
  }
  const drafts: Record<string, WorkDraft> = {}
  let quarantined = 0
  for (const [key, value] of Object.entries(root.drafts as Record<string, unknown>)) {
    const one = readWorkDraft(value)
    if (!key || !one) { quarantined += 1; continue }
    drafts[key] = one
  }
  return { drafts, report: { restored: Object.keys(drafts).length, quarantined, rootError: null } }
}

/** 담을 것이 없는 기록인가. 빈 기록으로 쓸모 있는 기록을 덮지 않기 위한 판정이다. */
export function workDraftIsEmpty(draft: WorkDraft): boolean {
  return Object.keys(draft.speakers).length === 0 && draft.ttsText.trim() === ''
}

/**
 * 기록 하나를 넣는다. 상한을 넘으면 **가장 오래 손대지 않은 것부터** 버린다.
 * 지금 넣는 기록은 언제나 남는다(방금 작업하던 것을 버리지 않는다).
 */
export function putWorkDraft(
  drafts: Record<string, WorkDraft>, key: string, draft: WorkDraft, max = MAX_WORK_DRAFTS
): Record<string, WorkDraft> {
  if (!key) return drafts
  const next: Record<string, WorkDraft> = { ...drafts, [key]: draft }
  const keys = Object.keys(next)
  if (keys.length <= max) return next
  const ordered = keys
    .filter((k) => k !== key)
    .sort((a, b) => (next[a].updatedAt || '').localeCompare(next[b].updatedAt || ''))
  for (const k of ordered.slice(0, keys.length - max)) delete next[k]
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 상태 ↔ 기록
//
// store 의 슬롯(`{source, clip, region, ready, message}`)과 기록은 일부러 모양이 다르다.
// `clip` 과 `ready` 는 이번 실행에서만 뜻이 있는 값이라 기록에 넣지 않는다 — 넣으면 재시작 후
// "준비됨" 이라고 적힌 채 실제로는 쓸 수 없는 상태가 만들어진다.
// ─────────────────────────────────────────────────────────────────────────────

/** 기록에 담을 만큼만 뽑은 화면 상태. store 타입을 shared 로 끌어오지 않기 위한 좁은 입력이다. */
export interface WorkDraftInput {
  sourcePath: string
  ttsText: string
  speakerMode: 'single' | 'multi'
  speakers: Record<string, { source: string; region: WorkRegion | null; referenceId?: string }>
  labels: Record<string, string>
  emotionEnabled: Record<string, boolean>
  renames: Record<string, string>
  inheritSpeakerId: string | null
  sourceSha256?: string | null
  now?: string
}

/** 화면 상태 → 기록. 원본이 없는 인물은 담지 않는다. */
export function buildWorkDraft(input: WorkDraftInput): WorkDraft {
  const speakers: Record<string, WorkSpeakerDraft> = {}
  for (const [id, slot] of Object.entries(input.speakers || {})) {
    const source = String(slot?.source ?? '').trim()
    if (!id || !source) continue
    speakers[id] = {
      source,
      region: finiteRegion(slot.region),
      label: input.labels?.[id] ?? '',
      emotionEnabled: input.emotionEnabled?.[id] === true,
      ...(slot.referenceId ? { referenceId: slot.referenceId } : {}),
    }
  }
  const sha = input.sourceSha256 || undefined
  return {
    schemaVersion: WORK_DRAFT_SCHEMA_VERSION,
    sourcePath: String(input.sourcePath ?? '').trim(),
    ...(sha ? { sourceSha256: sha } : {}),
    updatedAt: input.now || new Date().toISOString(),
    ttsText: input.ttsText ?? '',
    speakerMode: input.speakerMode === 'multi' ? 'multi' : 'single',
    speakers,
    renames: readStringMap(input.renames),
    inheritSpeakerId: input.inheritSpeakerId || null,
  }
}

/** 복원 직후 인물이 놓이는 상태. */
export type WorkSlotPhase =
  | 'preparing'    // 앱이 지금 되살리는 중 — 화면은 '목소리 준비 중'
  | 'reconnect'    // 원본이 없고 보관 클립도 없다 — 그 인물만 재연결 안내

/** 복원 계획 한 줄. 효과(파일 확인·클립 만들기)는 호출부가 한다. */
export interface WorkSlotPlan {
  speakerId: string
  source: string
  region: WorkRegion | null
  label: string
  emotionEnabled: boolean
  referenceId?: string
  phase: WorkSlotPhase
  /** preparing 일 때 무엇으로 되살리는가. */
  via: 'storedClip' | 'sourceRegion' | null
}

/**
 * 기록 + 실제 확인 결과 → 복원 계획.
 *
 * 판정 규칙(§1):
 *   · 보관 클립이 성하면 그것을 재사용한다(무결성 확인은 호출부가 이미 한 결과를 넘긴다).
 *   · 보관 클립이 없고 원본과 저장된 구간이 있으면 **그 구간 그대로** 다시 만든다.
 *     구간 추천을 다시 돌리지 않고 다른 구간을 고르지 않는다.
 *   · 둘 다 안 되면 그 인물만 재연결 안내다. 다른 인물의 목소리로 대체하지 않는다.
 * 어느 경우에도 여기서 `ready` 를 참으로 만들지 않는다 — 실제 준비가 끝난 뒤 호출부가 올린다.
 */
export function planWorkRestore(
  draft: WorkDraft,
  facts: { storedClipUsable: (referenceId: string) => boolean; sourcePresent: (path: string) => boolean }
): WorkSlotPlan[] {
  const plans: WorkSlotPlan[] = []
  for (const [speakerId, s] of Object.entries(draft.speakers)) {
    const stored = s.referenceId && facts.storedClipUsable(s.referenceId) ? s.referenceId : null
    if (stored) {
      plans.push({ speakerId, source: s.source, region: s.region, label: s.label,
        emotionEnabled: s.emotionEnabled, referenceId: stored, phase: 'preparing', via: 'storedClip' })
      continue
    }
    if (facts.sourcePresent(s.source)) {
      plans.push({ speakerId, source: s.source, region: s.region, label: s.label,
        emotionEnabled: s.emotionEnabled, phase: 'preparing', via: 'sourceRegion' })
      continue
    }
    plans.push({ speakerId, source: s.source, region: s.region, label: s.label,
      emotionEnabled: s.emotionEnabled, phase: 'reconnect', via: null })
  }
  return plans.sort((a, b) => a.speakerId.localeCompare(b.speakerId))
}

/** 복원 중 인물 슬롯에 넣을 값. `ready` 는 언제나 거짓이다. */
export function slotForPlan(plan: WorkSlotPlan): {
  source: string; clip: string; region: WorkRegion | null; ready: boolean; message: string
} {
  return {
    source: plan.source,
    clip: '',
    region: plan.region,
    ready: false,
    message: plan.phase === 'preparing' ? '목소리 준비 중' : '원본 다시 연결 필요',
  }
}

/**
 * 이 원본에 해당하는 기록 찾기.
 *
 * 경로가 맞으면 그것이다. 경로가 어긋나면(원본을 옮겼을 때) 내용 해시가 같은 기록을 찾는다 —
 * 해시는 앱 보관 과정에서 알게 된 것만 들어 있으므로, 없으면 조용히 못 찾은 것으로 둔다.
 */
export function findWorkDraft(
  drafts: Record<string, WorkDraft>, sourcePath: string, sourceSha256?: string | null
): { key: string; draft: WorkDraft } | null {
  const key = workKeyOf(sourcePath)
  if (key && drafts[key]) return { key, draft: drafts[key] }
  if (sourceSha256) {
    for (const [k, d] of Object.entries(drafts)) {
      if (d.sourceSha256 && d.sourceSha256 === sourceSha256) return { key: k, draft: d }
    }
  }
  return null
}
