// 텍스트 교정 — **판정 규칙의 단일 소유자**.
//
// 인식 결과를 들으면서 고쳐 최종 문서·자막으로 저장한다. 어려운 판정은 둘뿐이다.
//   · 무엇이 **최초 인식 결과**이고 무엇이 **사용자가 고친 것**인가
//   · 고친 뒤에도 **여전히 사실인 것**은 무엇인가(시간·번역)
//
// ★최초 인식 결과는 지우지 않는다. 교정은 그 위에 얹히는 별도의 층이다.
// ★글자를 고쳤다고 단어별 시간이 새 글자에 맞는다고 말하지 않는다.

/** 인식이 낸 문장 하나 — 이 값은 **바뀌지 않는다**. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** 사용자가 고친 내용. 문장 번호(순서) → 고친 글자. 고치지 않은 줄은 여기 없다. */
export type TranscriptEdits = Record<number, string>

export interface TranscriptDoc {
  /** 어떤 원본의 전사인가 — 다른 파일의 교정이 섞이지 않게 한다. */
  sourcePath: string
  /** 출력 파일 접두어(저장 이름을 여기서 만든다). */
  base: string
  language: string
  /** 최초 인식 결과. **보존 대상**이다. */
  segments: TranscriptSegment[]
  edits: TranscriptEdits
  updatedAt: number
}

export const TRANSCRIPT_EDIT_STORAGE_KEY = 'transcriptEdits'

/** 지금 보여 줄 글자 — 고친 것이 있으면 그것, 없으면 최초 인식 결과. */
export function effectiveText(doc: TranscriptDoc, index: number): string {
  const edited = doc.edits[index]
  if (typeof edited === 'string') return edited
  return doc.segments[index]?.text ?? ''
}

/** 이 문장을 사용자가 고쳤는가(공백까지 같으면 고친 것이 아니다). */
export function isEdited(doc: TranscriptDoc, index: number): boolean {
  const edited = doc.edits[index]
  if (typeof edited !== 'string') return false
  return edited.trim() !== (doc.segments[index]?.text ?? '').trim()
}

export function editedCount(doc: TranscriptDoc): number {
  return doc.segments.reduce((n, _s, i) => n + (isEdited(doc, i) ? 1 : 0), 0)
}

/**
 * 저장할 줄들. **시간은 최초 인식 결과의 것을 그대로 쓴다.**
 *
 * ★첫 구현은 문장의 시작·끝 시간을 유지한다. 글자를 고쳤다고 시간을 다시 계산하지 않는다 —
 *   다시 계산하려면 정렬을 새로 해야 하고, 그것은 이번 범위가 아니다. 그래서 시간은
 *   "인식이 말한 그 구간" 이라는 뜻 그대로 남는다.
 */
export function exportLines(doc: TranscriptDoc): TranscriptSegment[] {
  return doc.segments.map((s, i) => ({ start: s.start, end: s.end, text: effectiveText(doc, i).trim() }))
}

/** 교정본 TXT — 문장을 줄바꿈으로 잇는다. 빈 줄은 빼되 조용히 지우지 않는다(아래 참고). */
export function buildCorrectedTxt(doc: TranscriptDoc): string {
  return exportLines(doc).map((l) => l.text).filter((t) => t.length > 0).join('\n')
}

function srtTime(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},`
    + String(ms % 1000).padStart(3, '0')
}

/** 교정본 SRT — 번호·시간은 최초 인식 결과 그대로, 글자만 교정본. */
export function buildCorrectedSrt(doc: TranscriptDoc): string {
  const lines = exportLines(doc).filter((l) => l.text.length > 0)
  return lines.map((l, i) =>
    `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join('\n')
}

/**
 * 저장 전에 알려야 할 것들 — **조용히 넘어가지 않는다.**
 *
 * ★번역문은 원문 교정에 **자동으로 맞춰지지 않는다.** 고친 문장이 있는데 번역 파일이
 *   있다면, 그 번역은 고치기 전 글자의 번역이다. 그 사실을 말한다.
 */
export interface SaveNotes {
  editedCount: number
  emptiedCount: number
  translationStale: boolean
}

export function saveNotes(doc: TranscriptDoc, hasTranslation: boolean): SaveNotes {
  const emptied = doc.segments.reduce(
    (n, s, i) => n + (s.text.trim().length > 0 && effectiveText(doc, i).trim().length === 0 ? 1 : 0), 0)
  const edited = editedCount(doc)
  return { editedCount: edited, emptiedCount: emptied, translationStale: hasTranslation && edited > 0 }
}

export function saveNoteText(n: SaveNotes): string[] {
  const out: string[] = []
  if (n.emptiedCount > 0) out.push(`내용을 비운 문장 ${n.emptiedCount}개는 저장본에서 빠집니다.`)
  if (n.translationStale) {
    out.push('기존 번역문은 고치기 전 글자의 번역입니다 — 교정 내용이 자동으로 반영되지 않습니다.')
  }
  return out
}

/** 저장본에서 문서를 되살린다. 모양이 어긋나면 지어내지 않고 null. */
export function parseTranscriptDoc(raw: unknown): TranscriptDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.segments) || typeof o.sourcePath !== 'string') return null
  const segments: TranscriptSegment[] = []
  for (const s of o.segments) {
    const seg = s as Record<string, unknown>
    if (typeof seg?.start !== 'number' || typeof seg?.end !== 'number'
        || typeof seg?.text !== 'string') return null
    segments.push({ start: seg.start, end: seg.end, text: seg.text })
  }
  const edits: TranscriptEdits = {}
  const rawEdits = (o.edits && typeof o.edits === 'object') ? o.edits as Record<string, unknown> : {}
  for (const [k, v] of Object.entries(rawEdits)) {
    const i = Number(k)
    // 없는 문장을 가리키는 교정은 버린다 — 엉뚱한 줄에 붙으면 안 된다.
    if (Number.isInteger(i) && i >= 0 && i < segments.length && typeof v === 'string') edits[i] = v
  }
  return {
    sourcePath: o.sourcePath,
    base: typeof o.base === 'string' ? o.base : '',
    language: typeof o.language === 'string' ? o.language : 'unknown',
    segments, edits,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
}
