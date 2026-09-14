// 대화 구간 수정 — **판정 규칙의 단일 소유자**.
//
// 자동 화자 배정이 틀렸을 때 **재분석 없이** 고친다. 고치는 것은 두 가지뿐이다.
//   · 이 구간이 누구의 것인가(배정)
//   · 이 구간이 어디서 어디까지인가(경계)
//
// ★최초 분석 결과와 사용자가 고친 것을 **구분해 보존**한다.
// ★배정·경계를 고쳤다고 화자 분석 모델을 다시 돌리지 않는다.
// ★원본 구간을 화자별 트랙에 **배정**하는 것과, 겹친 목소리를 실제로 **갈라내는** 것은 다르다.
//   이 화면은 앞의 것만 한다.

export interface DialogueSegment {
  start: number
  end: number
  speaker: string
}

/** 구간 하나에 대한 사용자의 수정. 고치지 않은 구간은 여기 없다. */
export interface DialogueEdit {
  start?: number
  end?: number
  speaker?: string
}

export interface DialogueDoc {
  /** 어떤 원본의 분석인가 — 다른 파일의 수정이 섞이지 않게 한다. */
  sourcePath: string
  /** 최초 분석 결과. **보존 대상**이다. */
  segments: DialogueSegment[]
  speakers: string[]
  edits: Record<number, DialogueEdit>
  updatedAt: number
}

export const DIALOGUE_EDIT_STORAGE_KEY = 'dialogueEdits'

/** 지금 값 — 고친 것이 있으면 그것, 없으면 최초 분석 결과. */
export function effectiveSegment(doc: DialogueDoc, i: number): DialogueSegment {
  const base = doc.segments[i]
  const e = doc.edits[i] || {}
  return {
    start: e.start ?? base.start,
    end: e.end ?? base.end,
    speaker: e.speaker ?? base.speaker,
  }
}

export function isSegmentEdited(doc: DialogueDoc, i: number): boolean {
  const base = doc.segments[i]
  const cur = effectiveSegment(doc, i)
  return cur.start !== base.start || cur.end !== base.end || cur.speaker !== base.speaker
}

export function editedSegmentCount(doc: DialogueDoc): number {
  return doc.segments.reduce((n, _s, i) => n + (isSegmentEdited(doc, i) ? 1 : 0), 0)
}

export type DialogueProblem = 'END_BEFORE_START' | 'OUT_OF_RANGE'

/**
 * 시간 범위 오류 — **고치는 순간 알린다.** 내보낼 때까지 숨겨 두지 않는다.
 * 겹침은 오류로 보지 않는다(두 사람이 동시에 말할 수 있다). 다만 겹쳤다고 해서
 * 겹친 목소리를 갈라낸 것은 아니다 — 그 말은 화면이 하지 않는다.
 */
export function segmentProblem(seg: DialogueSegment, durationSec: number): DialogueProblem | null {
  if (!(seg.start < seg.end)) return 'END_BEFORE_START'
  if (seg.end <= 0 || seg.start >= durationSec) return 'OUT_OF_RANGE'
  return null
}

export function problemText(p: DialogueProblem): string {
  switch (p) {
    case 'END_BEFORE_START': return '끝이 시작보다 앞입니다.'
    case 'OUT_OF_RANGE': return '원본 길이를 벗어났습니다.'
  }
}

/** 내보낼 구간들 — 지금 값으로, 시작 순서대로. 문제가 있는 구간은 빼고 알린다. */
export function exportSegments(doc: DialogueDoc, durationSec: number): {
  segments: DialogueSegment[]
  blocked: { index: number; problem: DialogueProblem }[]
} {
  const segments: DialogueSegment[] = []
  const blocked: { index: number; problem: DialogueProblem }[] = []
  doc.segments.forEach((_s, i) => {
    const cur = effectiveSegment(doc, i)
    const p = segmentProblem(cur, durationSec)
    if (p) blocked.push({ index: i, problem: p })
    else segments.push(cur)
  })
  segments.sort((a, b) => a.start - b.start || a.end - b.end)
  return { segments, blocked }
}

/** 저장본 복원. 모양이 어긋나면 지어내지 않고 null. */
export function parseDialogueDoc(raw: unknown): DialogueDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.sourcePath !== 'string' || !Array.isArray(o.segments)) return null
  const segments: DialogueSegment[] = []
  for (const s of o.segments) {
    const seg = s as Record<string, unknown>
    if (typeof seg?.start !== 'number' || typeof seg?.end !== 'number'
        || typeof seg?.speaker !== 'string') return null
    segments.push({ start: seg.start, end: seg.end, speaker: seg.speaker })
  }
  const edits: Record<number, DialogueEdit> = {}
  const rawEdits = (o.edits && typeof o.edits === 'object') ? o.edits as Record<string, unknown> : {}
  for (const [k, v] of Object.entries(rawEdits)) {
    const i = Number(k)
    if (!Number.isInteger(i) || i < 0 || i >= segments.length) continue   // 없는 구간을 가리키면 버린다
    const e = v as Record<string, unknown>
    if (!e || typeof e !== 'object') continue
    const out: DialogueEdit = {}
    if (typeof e.start === 'number') out.start = e.start
    if (typeof e.end === 'number') out.end = e.end
    if (typeof e.speaker === 'string') out.speaker = e.speaker
    if (Object.keys(out).length) edits[i] = out
  }
  return {
    sourcePath: o.sourcePath, segments,
    speakers: Array.isArray(o.speakers) ? o.speakers.filter((x): x is string => typeof x === 'string') : [],
    edits, updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
}
