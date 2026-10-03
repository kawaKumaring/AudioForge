/**
 * 대화 분리 작업실 — **무엇이 무엇에 속하는가**의 단일 권위.
 *
 * 이 화면에는 서로 다른 세 가지가 있고, 예전에는 그 셋이 따로 떠다녔다.
 *   · 지금 열어 둔 **원본**
 *   · 그 원본을 분석한 **한 번의 실행 결과**
 *   · 그 결과를 사람이 고친 **교정 문서**
 * 셋을 묶지 않았더니 파일을 바꿔도 앞 파일의 구간이 화면에 남았고(2026-09-27 재현),
 * 그 구간으로 새 파일 경로의 교정 문서가 저장됐다. 여기서 셋을 한 덩어리로 묶는다.
 *
 * ★**표시 이름과 화자 식별자와 파일 이름은 서로 다른 것이다.**
 *   · 식별자(`SpeakerId`) — 엔진이 준 것(`화자 A`). 묶는 기준이고 바뀌지 않는다.
 *   · 표시 이름 — 사용자가 쓴 것. 겹쳐도 되고 어떤 글자든 들어갈 수 있다.
 *   · 파일 이름 — 표시 이름에서 **파생**한다. 직접 쓰지 않는다(아래 `trackFileNames`).
 */

/** 엔진이 준 화자 식별자. 사용자가 보는 이름과 **다른 것**이다. */
export type SpeakerId = string

export interface DialogueSegment {
  start: number
  end: number
  speaker: SpeakerId
}

/**
 * 분석 **한 번**의 결과. 어느 원본의 어느 실행인지 스스로 안다.
 *
 * `runId` 가 이 덩어리의 핵심이다 — 늦게 도착한 앞 실행의 결과가 지금 작업을
 * 덮어쓰지 못하게 하는 유일한 근거다.
 */
export interface DialogueAnalysis {
  sourceKey: string
  runId: string
  segments: DialogueSegment[]
  speakers: SpeakerId[]
  overlaps: { start: number; end: number }[]
  outputDir: string
  durationSec: number
  /** 시간축을 믿을 수 있는지 판단할 재료. 화면이 추측하지 않도록 실행 설정을 그대로 든다. */
  trimSilence: boolean
  transcribe: boolean
}

/** 구간 하나에 대한 사용자의 수정. 고치지 않은 구간은 여기 없다. */
export interface SegmentEdit {
  start?: number
  end?: number
  speaker?: SpeakerId
}

/**
 * 교정 문서 — **분석 결과를 고치지 않고 그 위에 덮는다.**
 *
 * 최초 분석 결과는 `DialogueAnalysis` 가 그대로 들고 있고, 여기에는 **차이만** 담는다.
 * 그래서 언제든 '처음 분석한 값' 으로 돌아갈 수 있다.
 */
export interface DialogueDraft {
  sourceKey: string
  runId: string
  /** 화자별 표시 이름. 없으면 식별자를 그대로 보여 준다. */
  names: Record<SpeakerId, string>
  /** 합친 관계 — `{흡수된 쪽: 대표}`. 체인은 항상 대표로 평탄화한다. */
  merges: Record<SpeakerId, SpeakerId>
  edits: Record<number, SegmentEdit>
  updatedAt: number
  /** 옛 한 칸 기록에서 옮겨 온 것인가 — 안내 문구에만 쓴다. */
  fromLegacy?: { segmentCount: number }
  /**
   * **이 교정이 어느 분석 위에서 만들어졌는가**(지문).
   *
   * ★수정은 발언 **번호**로 적힌다. 번호는 분석이 달라지면 다른 발언을 가리킨다.
   *   그래서 다른 실행에 옮기기 전에 그때의 발언 시각·인물 구성이 같은지 본다.
   *   지문이 없는 옛 문서는 **옮기지 않고 보관·확인 대상**으로 남긴다.
   */
  basis?: DraftBasis
}

/** 분석 한 벌의 지문. 번호로 옮겨도 되는지 판단하는 유일한 근거다. */
export interface DraftBasis {
  segmentCount: number
  /** 발언 시각 지문. */
  timesHash: string
  /** 그때의 화자 식별자들(정렬). 이름·합치기를 옮겨도 되는지 본다. */
  speakers: string[]
}

/** 짧고 안정적인 지문(FNV-1a). 값을 되돌릴 수 없고 경로를 담지 않는다. */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export function basisOfSegments(segments: DialogueSegment[]): DraftBasis {
  const times = segments.map((x) => `${x.start.toFixed(2)}-${x.end.toFixed(2)}`).join('|')
  return {
    segmentCount: segments.length,
    timesHash: hashOf(times),
    speakers: [...new Set(segments.map((x) => x.speaker))].sort(),
  }
}

export const analysisBasis = (a: DialogueAnalysis): DraftBasis => basisOfSegments(a.segments)

export function sameSpeakers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export function emptyDraft(sourceKey: string, runId: string): DialogueDraft {
  return { sourceKey, runId, names: {}, merges: {}, edits: {}, updatedAt: 0 }
}

// ── 소속 판정 ────────────────────────────────────────────────────────────────

/**
 * 이 결과를 지금 화면에 들일 수 있는가. 들일 수 없으면 **사유**를 돌려준다.
 *
 * 빈 문자열이면 들여도 된다. 조용히 버리지 않고 화면이 말할 수 있게 사유를 남긴다.
 */
export function analysisFault(
  got: { sourceKey?: string; runId?: string } | null | undefined,
  sourceKey: string, runId: string,
): string {
  if (!got) return '분석 결과가 비어 있습니다.'
  if (!sourceKey) return '열어 둔 원본이 없습니다.'
  if (got.sourceKey !== sourceKey) return '다른 원본의 결과입니다.'
  // runId 가 없는 결과(옛 경로)는 원본만 맞으면 받는다 — 새 경로는 항상 붙여 보낸다.
  if (runId && got.runId && got.runId !== runId) return '지난 실행의 결과입니다.'
  return ''
}

/**
 * 이 교정을 지금 분석에 **가져와도 되는가.** 되면 빈 문자열, 아니면 사유.
 *
 * ★실행 식별자를 현재 값으로 바꿔치기해서 이 판정을 건너뛰면 안 된다 —
 *   그러면 발언 시각과 화자가 달라진 분석에도 번호만 보고 덮어쓴다(2026-09-27 재현).
 */
export function adoptFault(draft: DialogueDraft | null | undefined,
  analysis: DialogueAnalysis): string {
  if (!draft) return '가져올 교정이 없습니다.'
  if (draft.sourceKey !== analysis.sourceKey) return '다른 원본의 교정입니다.'
  // ★지문이 있으면 **그것이 먼저다.** 실행 식별자를 현재 값으로 바꿔 끼워도
  //   여기서 걸린다 — 부르는 쪽의 실수로 판정이 헐거워지지 않게 한다.
  if (draft.basis) {
    const now = analysisBasis(analysis)
    const b = draft.basis
    if (b.segmentCount !== now.segmentCount) {
      return `그때와 발언 수가 다릅니다(${b.segmentCount} → ${now.segmentCount}).`
    }
    if (b.timesHash !== now.timesHash) return '그때와 발언 시각이 다릅니다.'
    // ★식별자가 같다고 같은 사람이라고 보지 않는다 — 인물 구성이 같을 때만 옮긴다.
    if (!sameSpeakers(b.speakers, now.speakers)) return '그때와 인물 구성이 다릅니다.'
    return ''
  }
  // 지문이 없는 옛 문서 — 같은 실행이라는 근거가 있을 때만 이어 쓴다.
  if (draft.runId && draft.runId === analysis.runId) return ''
  // 그 밖에는 번호로 옮기지 않는다. 보관해 두고 사용자가 확인하게 한다.
  return '그때의 분석 정보가 없어 발언 번호로 옮길 수 없습니다.'
}

/**
 * **자동 복원**해도 되는가. 다른 실행의 교정은 저절로 적용하지 않는다.
 * (사용자가 고르는 '가져오기' 는 `adoptFault` 만 본다.)
 */
export function autoRestoreFault(draft: DialogueDraft | null | undefined,
  analysis: DialogueAnalysis): string {
  if (!draft) return '가져올 교정이 없습니다.'
  if (draft.sourceKey !== analysis.sourceKey) return '다른 원본의 교정입니다.'
  if (draft.runId && draft.runId !== analysis.runId) return '다른 실행의 교정입니다.'
  return adoptFault(draft, analysis)
}

// ── 합치기 ───────────────────────────────────────────────────────────────────

/** 합친 관계를 따라가 **대표**를 찾는다. 고리가 생겨도 멈춘다. */
export function resolveMerge(merges: Record<SpeakerId, SpeakerId>, id: SpeakerId): SpeakerId {
  let cur = id
  const seen = new Set<SpeakerId>([cur])
  for (let i = 0; i < 64; i++) {
    const next = merges[cur]
    if (!next || next === cur || seen.has(next)) break
    seen.add(next)
    cur = next
  }
  return cur
}

/**
 * 여러 화자를 하나로 합친다 — **한 걸음**이다.
 *
 * 구간을 하나씩 고치지 않는다. 그래서 되돌리기도 한 번이면 된다.
 * 대표를 흡수 대상에 넣어도 자기 자신으로는 합치지 않는다(고리 방지).
 */
export function mergeSpeakers(draft: DialogueDraft, from: SpeakerId[], into: SpeakerId): DialogueDraft {
  const target = resolveMerge(draft.merges, into)
  const merges = { ...draft.merges }
  for (const id of from) {
    if (!id || id === target) continue
    merges[id] = target
    // 이미 이 화자를 대표로 삼던 쪽들도 새 대표로 옮긴다(체인을 남기지 않는다).
    for (const [k, v] of Object.entries(merges)) if (v === id) merges[k] = target
  }
  return { ...draft, merges }
}

/** 합치기를 통째로 되돌린다(그 화자들만). */
export function unmergeSpeakers(draft: DialogueDraft, ids: SpeakerId[]): DialogueDraft {
  const merges = { ...draft.merges }
  for (const id of ids) delete merges[id]
  return { ...draft, merges }
}

// ── 지금 값 ──────────────────────────────────────────────────────────────────

/** 이 구간이 지금 누구의 것인가 — 수정 → 합치기 순으로 본다. */
export function effectiveSpeaker(analysis: DialogueAnalysis, draft: DialogueDraft, i: number): SpeakerId {
  const base = analysis.segments[i]
  if (!base) return ''
  const picked = draft.edits[i]?.speaker ?? base.speaker
  return resolveMerge(draft.merges, picked)
}

export function effectiveSegment(analysis: DialogueAnalysis, draft: DialogueDraft, i: number): DialogueSegment {
  const base = analysis.segments[i]
  const e = draft.edits[i] || {}
  return {
    start: e.start ?? base.start,
    end: e.end ?? base.end,
    speaker: effectiveSpeaker(analysis, draft, i),
  }
}

export function isSegmentEdited(analysis: DialogueAnalysis, draft: DialogueDraft, i: number): boolean {
  const base = analysis.segments[i]
  if (!base) return false
  const cur = effectiveSegment(analysis, draft, i)
  return cur.start !== base.start || cur.end !== base.end || cur.speaker !== base.speaker
}

export function editedSegmentCount(analysis: DialogueAnalysis, draft: DialogueDraft): number {
  return analysis.segments.reduce((n, _s, i) => n + (isSegmentEdited(analysis, draft, i) ? 1 : 0), 0)
}

/** 사용자가 보는 이름. 정하지 않았으면 식별자 그대로. */
export function displayNameOf(draft: DialogueDraft, id: SpeakerId): string {
  const name = draft.names[id]
  return name && name.trim() ? name.trim() : id
}

export interface SpeakerRow {
  id: SpeakerId
  name: string
  /** 이 사람에게 속한 구간 수. */
  count: number
  totalSec: number
  /** 대표로 들려줄 구간 — **가장 긴 구간**이다(품질을 본 것이 아니다). */
  longest: { index: number; start: number; end: number } | null
  /** 이 화자로 흡수된 식별자들. 합치기를 되돌릴 때 쓴다. */
  absorbed: SpeakerId[]
}

/**
 * 인물 카드에 필요한 값. **처음 나온 순서**로 준다.
 *
 * ★`longest` 를 '품질 추천' 이라고 부르지 않는다. 우리가 한 일은 가장 긴 구간을 고른 것뿐이다.
 */
export function speakerRows(analysis: DialogueAnalysis, draft: DialogueDraft): SpeakerRow[] {
  const order: SpeakerId[] = []
  const acc = new Map<SpeakerId, { count: number; total: number; longest: SpeakerRow['longest'] }>()
  analysis.segments.forEach((_s, i) => {
    const id = effectiveSpeaker(analysis, draft, i)
    if (!id) return
    const cur = effectiveSegment(analysis, draft, i)
    const len = Math.max(0, cur.end - cur.start)
    if (!acc.has(id)) { acc.set(id, { count: 0, total: 0, longest: null }); order.push(id) }
    const a = acc.get(id)!
    a.count += 1
    a.total += len
    const bestLen = a.longest ? a.longest.end - a.longest.start : -1
    if (len > bestLen) a.longest = { index: i, start: cur.start, end: cur.end }
  })
  const absorbedBy = new Map<SpeakerId, SpeakerId[]>()
  for (const [from] of Object.entries(draft.merges)) {
    const to = resolveMerge(draft.merges, from)
    if (to === from) continue
    absorbedBy.set(to, [...(absorbedBy.get(to) || []), from])
  }
  return order.map((id) => ({
    id,
    name: displayNameOf(draft, id),
    count: acc.get(id)!.count,
    totalSec: acc.get(id)!.total,
    longest: acc.get(id)!.longest,
    absorbed: (absorbedBy.get(id) || []).sort(),
  }))
}

// ── 파일 이름 ────────────────────────────────────────────────────────────────

/**
 * 파일 이름에 쓸 수 없는 글자 — 경로 구분자와 금지 문자.
 * ★빈칸과 붙임표는 **지우지 않는다**(`첫 곡`·`Jean-Luc` 가 붙어 버리면 다른 이름이 된다).
 */
const FORBIDDEN_NAME_CHARS = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']

/** 금지 문자와 제어문자를 뺀다. 정규식에 제어문자를 적지 않는다(소스가 오염된다). */
function stripUnsafe(raw: string): string {
  let out = ''
  for (const ch of raw || '') {
    const c = ch.codePointAt(0) ?? 0
    if (c < 32 || c === 127) continue
    if (FORBIDDEN_NAME_CHARS.includes(ch)) continue
    out += ch
  }
  return out
}

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])
export const TRACK_NAME_MAX = 40

/** 식별자에서 만든 마지막 보루 이름 — 사람 이름이 하나도 쓸 수 없을 때. */
function fallbackName(id: SpeakerId, pos: number): string {
  const letters = (id.match(/[A-Za-z0-9]+/g) || []).join('').toLowerCase()
  return letters ? `speaker_${letters}` : `speaker_${pos + 1}`
}

/** 한 조각을 파일에 쓸 수 있는 모양으로. 쓸 수 없으면 빈 문자열. */
function slug(raw: string): string {
  let s = stripUnsafe(raw).trim()
  // 앞뒤 점은 숨김 파일·상위 경로(`.`/`..`)로 읽힌다. 통째로 떼어 낸다.
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  if (s.length > TRACK_NAME_MAX) s = s.slice(0, TRACK_NAME_MAX).trim()
  if (!s) return ''
  if (RESERVED.has(s.toLowerCase().split('.')[0])) return ''
  return s
}

/**
 * 화자별 **파일 이름**을 정한다 — 표시 이름을 그대로 쓰지 않는다.
 *
 * 지키는 것
 *   · 금지 문자·경로 문자·제어문자를 뺀다(`..`, `/`, `\`, `:` …).
 *   · 윈도우 장치 이름(CON·NUL·COM1 …)을 피한다.
 *   · **동명이인**은 뒤에 번호를 붙여 서로 다른 파일이 되게 한다.
 *   · 이름을 아예 쓸 수 없으면 식별자에서 만든다(`speaker_a`).
 *   · 같은 입력이면 항상 같은 결과다(식별자 순으로 번호를 매긴다).
 *
 * 돌려주는 것은 `{식별자: 파일에 쓸 이름}` 이다. 값은 서로 겹치지 않는다.
 */
export function trackFileNames(rows: { id: SpeakerId; name: string }[]): Record<SpeakerId, string> {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id))
  const used = new Set<string>()
  const out: Record<SpeakerId, string> = {}
  ordered.forEach((r, pos) => {
    let base = slug(r.name) || slug(fallbackName(r.id, pos)) || `speaker_${pos + 1}`
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) {
      // 번호를 붙여도 길이 상한을 넘지 않게 앞을 줄인다.
      const tail = `_${n}`
      base = base.slice(0, Math.max(1, TRACK_NAME_MAX - tail.length))
      name = base + tail
      n += 1
    }
    used.add(name.toLowerCase())
    out[r.id] = name
  })
  return out
}

// ── 내보내기 ─────────────────────────────────────────────────────────────────

export type SegmentProblem = 'END_BEFORE_START' | 'OUT_OF_RANGE'

export function segmentProblem(seg: DialogueSegment, durationSec: number): SegmentProblem | null {
  if (!(seg.start < seg.end)) return 'END_BEFORE_START'
  if (seg.end <= 0 || seg.start >= durationSec) return 'OUT_OF_RANGE'
  return null
}

export function problemText(p: SegmentProblem): string {
  switch (p) {
    case 'END_BEFORE_START': return '끝이 시작보다 앞입니다.'
    case 'OUT_OF_RANGE': return '원본 길이를 벗어났습니다.'
  }
}

export interface ExportPlan {
  /** 엔진에 보낼 구간. `speaker` 는 **파일에 쓸 이름**이다(표시 이름이 아니다). */
  segments: DialogueSegment[]
  /** 파일 이름 → 식별자. 결과 트랙을 다시 사람 이름으로 읽기 위한 표. */
  nameToId: Record<string, SpeakerId>
  blocked: { index: number; problem: SegmentProblem }[]
}

/**
 * 교정본을 내보낼 계획.
 *
 * ★겹친 발언을 지우거나 한 사람에게 몰지 않는다 — 겹친 채로 그대로 보낸다.
 *   엔진은 구간을 화자별로 **배정**할 뿐이고, 겹친 자리는 양쪽 트랙에 함께 들어간다.
 */
export function exportPlan(analysis: DialogueAnalysis, draft: DialogueDraft): ExportPlan {
  const rows = speakerRows(analysis, draft)
  const names = trackFileNames(rows.map((r) => ({ id: r.id, name: r.name })))
  const nameToId: Record<string, SpeakerId> = {}
  for (const [id, n] of Object.entries(names)) nameToId[n] = id

  const segments: DialogueSegment[] = []
  const blocked: ExportPlan['blocked'] = []
  analysis.segments.forEach((_s, i) => {
    const cur = effectiveSegment(analysis, draft, i)
    const p = segmentProblem(cur, analysis.durationSec)
    if (p) { blocked.push({ index: i, problem: p }); return }
    const fileName = names[cur.speaker]
    if (!fileName) return           // 화자를 알 수 없는 구간은 조용히 옮기지 않는다
    segments.push({ start: cur.start, end: cur.end, speaker: fileName })
  })
  segments.sort((a, b) => a.start - b.start || a.end - b.end)
  return { segments, nameToId, blocked }
}
