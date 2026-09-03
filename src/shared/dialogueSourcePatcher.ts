/**
 * 여러 명 화면이 원문을 고치는 **유일한 통로** — 제한된 명령 생성기(source patcher).
 *
 * 이것은 범용 직렬화기가 **아니다.** 계획 전체를 텍스트로 되돌리는 함수는 만들지 않는다 —
 * 그러면 파서가 분류하지 못한 표기가 되돌릴 때 사라진다. 대신 명령마다 **필요한 구간만**
 * 고친다. 구간 밖의 문단 나눔·쉼·알 수 없는 표기는 손대지 않는다.
 *
 * 권위는 여전히 텍스트 하나다. 구조화 화면은 원문 구간 위의 projection 이고, 이 모듈은
 * 그 projection 에서 나온 명령을 원문 패치로 바꾼다.
 *
 * ⚠️ 좌표가 낡으면 엉뚱한 자리를 덮어쓴다. 그래서 모든 명령은 `structurable()` 판정을
 * 통과한 계획에서만 나와야 한다. 판정은 SHA 일치까지 본다.
 *
 * 화자 유지 규칙
 * -------------
 * 화자는 **다음 화자 표기까지 유지된다.** 그래서 한 발화의 화자만 바꾸면 뒤 발화까지
 * 끌려간다. 이 모듈은 그때 뒤 발화 앞에 **복원 표기**를 넣어 원래 의미를 지킨다.
 */

/** 화자 지시의 정식 표기. `tts_grammar` 가 받는 형태 그대로 만든다. */
export const SPEAKER_DIRECTIVE_NAME = '화자'
export const SPEAKER_DEFAULT_ARG = '기본'

export function speakerDirective(label: string | null): string {
  const arg = (label ?? '').trim()
  return `[${SPEAKER_DIRECTIVE_NAME} ${arg || SPEAKER_DEFAULT_ARG}]`
}

/** 발화 하나의 projection. 원문 조각과 좌표를 함께 들고 있다. */
export interface UtteranceView {
  index: number
  /** UTF-16 좌표. 구간은 **자기 지시를 포함한다**(`[화자 …]`, `[기쁨]` 까지). */
  sourceStart: number
  sourceEnd: number
  speakerId: string | null
  speakerLabel: string | null
  emotionId: string | null
  /** 이 발화 앞에 화자 표기가 실제로 있는가(없으면 앞 발화에서 이어받았다). */
  hasOwnSpeakerDirective: boolean
  lineIndex: number | null
}

export const STRUCTURE_BLOCKERS = [
  'PLAN_MISSING',           // 계획이 아직 없다(타이핑 중)
  'PLAN_STALE',             // 계획 SHA 가 현재 원문과 다르다
  'PARSER_FALLBACK',        // 파서가 원문 줄로 물러났다(좌표 근사)
  'OFFSETS_APPROXIMATE',    // 발화 좌표가 정확하지 않다
  'SPANS_OVERLAP',          // 구간이 겹치거나 순서가 어긋난다
  'NON_WHITESPACE_OUTSIDE', // 구간 밖에 공백 아닌 것이 있다(쉼·지시 전용 줄 등)
  'BLOCKING_WARNING',       // 파서 자신이 확신하지 못한다
  'NO_UTTERANCES',          // 구조화할 발화가 없다
] as const
export type StructureBlocker = typeof STRUCTURE_BLOCKERS[number]

export interface StructureVerdict {
  /** 구조화 편집을 허용해도 되는가. 거짓이면 원문 편집기를 그대로 보여 준다. */
  structurable: boolean
  /** 막힌 사유(비민감 토큰). 원문·대사를 담지 않는다. */
  blockers: StructureBlocker[]
  utteranceCount: number
}

export interface StructureInput {
  /** 지금 편집기에 있는 원문. */
  text: string
  /** 현재 원문의 SHA. 호출부가 계산해 넣는다(이 모듈은 해싱하지 않는다). */
  textSha256: string
  /** 계획이 본 원문의 SHA. 계획이 없으면 null. */
  planSourceSha256: string | null
  parserAuthority: boolean
  utterances: readonly UtteranceView[]
  offsetsExact: readonly boolean[]
  /** 차단 경고가 하나라도 있는가. 판정은 호출부(기존 `PLAN_WARNING_BLOCKS`)가 한다. */
  hasBlockingWarning: boolean
}

/**
 * 구조화 편집이 안전한 대본인가.
 *
 * 초기 버전은 **일부러 좁다.** 쉼·지시 전용 줄이 있는 정상 대본도 제외된다 — 그 대본은
 * 원문 편집기에서 그대로 쓰면 되고, 합성과 기존 파서는 어느 경우에도 그대로 동작한다.
 * 넓히려고 원문 전체를 재작성하지 않는다.
 */
export function structurable(input: StructureInput): StructureVerdict {
  const blockers: StructureBlocker[] = []
  if (input.planSourceSha256 === null) blockers.push('PLAN_MISSING')
  else if (input.planSourceSha256 !== input.textSha256) blockers.push('PLAN_STALE')
  if (!input.parserAuthority) blockers.push('PARSER_FALLBACK')
  if (input.offsetsExact.some((ok) => !ok)) blockers.push('OFFSETS_APPROXIMATE')
  if (input.hasBlockingWarning) blockers.push('BLOCKING_WARNING')
  if (input.utterances.length === 0) blockers.push('NO_UTTERANCES')

  // 구간이 오름차순이고 겹치지 않는가.
  let cursor = 0
  let ordered = true
  for (const u of input.utterances) {
    if (u.sourceStart < cursor || u.sourceEnd < u.sourceStart) { ordered = false; break }
    cursor = u.sourceEnd
  }
  if (!ordered) blockers.push('SPANS_OVERLAP')

  // 구간 밖에 공백 아닌 것이 남아 있는가.
  if (ordered && input.utterances.length > 0) {
    let at = 0
    let clean = true
    for (const u of input.utterances) {
      if (input.text.slice(at, u.sourceStart).trim() !== '') { clean = false; break }
      at = u.sourceEnd
    }
    if (clean && input.text.slice(at).trim() !== '') clean = false
    if (!clean) blockers.push('NON_WHITESPACE_OUTSIDE')
  }

  return {
    structurable: blockers.length === 0,
    blockers,
    utteranceCount: input.utterances.length,
  }
}

/** 패치 결과. `changed=false` 면 원문을 건드리지 않았다는 뜻이다. */
export interface PatchResult {
  text: string
  changed: boolean
  /** 왜 하지 않았는가(했으면 null). */
  refusedCode: string | null
}

function unchanged(text: string, code: string): PatchResult {
  return { text, changed: false, refusedCode: code }
}

/** 이 발화의 원문 조각. 화면이 그대로 보여 주고, 고급 감정 편집도 이것을 만진다. */
export function sliceOf(text: string, u: UtteranceView): string {
  return text.slice(u.sourceStart, u.sourceEnd)
}

/**
 * 이 발화 **다음**에 화자 표기 없이 이어받는 발화가 있는가.
 *
 * 있으면 그 발화는 지금 이 발화의 화자를 물려받고 있다 — 이 발화의 화자를 바꿀 때
 * 복원 표기를 넣어야 하는 대상이다.
 */
export function nextInheritingIndex(
  utterances: readonly UtteranceView[], index: number
): number | null {
  const next = utterances[index + 1]
  if (!next) return null
  return next.hasOwnSpeakerDirective ? null : index + 1
}

/**
 * 한 발화의 화자를 바꾼다. **뒤 발화의 화자 의미를 보존한다.**
 *
 * 뒤 발화가 표기 없이 이어받고 있으면 그 앞에 이전 화자의 복원 표기를 끼운다. 넣지 않으면
 * 뒤 발화까지 새 화자로 바뀐다 — 사용자가 지시하지 않은 변경이다.
 *
 * 이 발화에 화자 표기가 없으면(앞에서 물려받았으면) 조각 앞에 새 표기를 넣는다.
 */
export function changeSpeaker(
  text: string, utterances: readonly UtteranceView[], index: number,
  newLabel: string | null
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  const label = (newLabel ?? '').trim()
  if (!label) return unchanged(text, 'SPEAKER_LABEL_EMPTY')
  if (u.speakerLabel === label) return unchanged(text, 'NO_CHANGE')

  const slice = sliceOf(text, u)
  let replaced: string
  if (u.hasOwnSpeakerDirective) {
    // 자기 표기만 바꾼다 — 조각의 나머지(감정 태그·대사)는 글자 그대로 남는다.
    const directive = /\[\s*(?:화자|speaker)\s+[^\]]*\]/
    if (!directive.test(slice)) return unchanged(text, 'SPEAKER_DIRECTIVE_NOT_FOUND')
    replaced = slice.replace(directive, speakerDirective(label))
  } else {
    // 물려받던 발화다 — 조각 앞에 표기를 새로 세운다.
    const lead = slice.match(/^\s*/)?.[0] ?? ''
    replaced = `${lead}${speakerDirective(label)}\n${slice.slice(lead.length)}`
  }

  // 뒤 발화가 이어받고 있으면 이전 화자를 복원한다.
  const inherit = nextInheritingIndex(utterances, index)
  let out = text.slice(0, u.sourceStart) + replaced + text.slice(u.sourceEnd)
  if (inherit !== null) {
    const next = utterances[inherit]
    const shift = replaced.length - slice.length
    const at = next.sourceStart + shift
    const restore = `${speakerDirective(u.speakerLabel)}\n`
    out = out.slice(0, at) + restore + out.slice(at)
  }
  return { text: out, changed: true, refusedCode: null }
}

/**
 * 발화의 **기본 감정**을 바꾼다. 조각 안의 중간 감정 태그는 지우지 않는다.
 *
 * 조각 맨 앞의 감정 태그 하나만 바꾸거나 새로 세운다. 두 번째 이후 태그(대사 중간에서
 * 감정이 바뀌는 표기)는 글자 그대로 남는다 — 그것을 지우는 것은 사용자가 지시하지 않은
 * 삭제다.
 */
export function changeBaseEmotion(
  text: string, utterances: readonly UtteranceView[], index: number,
  emotionTag: string | null
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  const slice = sliceOf(text, u)
  // 화자 표기 뒤, 대사 앞에 있는 **첫 감정 태그**만 본다.
  const leading = /(\[\s*(?:화자|speaker)\s+[^\]]*\]\s*)?(\[[^\]\s]+\]\s*)?/
  const m = slice.match(leading)
  const speakerPart = m?.[1] ?? ''
  const emotionPart = m?.[2] ?? ''
  const rest = slice.slice((m?.[0] ?? '').length)
  const tag = emotionTag ? `${emotionTag} ` : ''
  const next = `${speakerPart}${tag}${rest}`
  if (next === slice) return unchanged(text, 'NO_CHANGE')
  // 중간 감정 태그가 사라졌는지 확인한다 — 하나라도 줄면 하지 않는다.
  const countTags = (s: string) => (s.match(/\[[^\]]*\]/g) ?? []).length
  const before = countTags(rest)
  if (countTags(next) - countTags(`${speakerPart}${tag}`) !== before) {
    return unchanged(text, 'MID_EMOTION_WOULD_BE_LOST')
  }
  void emotionPart
  return {
    text: text.slice(0, u.sourceStart) + next + text.slice(u.sourceEnd),
    changed: true, refusedCode: null,
  }
}

/**
 * 새 발화를 이 발화 **뒤에** 넣는다.
 *
 * 화자 표기를 항상 함께 세운다 — 넣지 않으면 새 발화가 앞 화자를 물려받고, 그 뒤 발화가
 * 이 발화의 화자를 물려받는 사슬이 흔들린다.
 */
export function insertUtteranceAfter(
  text: string, utterances: readonly UtteranceView[], index: number,
  speakerLabel: string | null, line: string, emotionTag?: string | null
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  const body = line.replace(/\r?\n/g, ' ').trim()
  const tag = emotionTag ? `${emotionTag} ` : ''
  const block = `\n${speakerDirective(speakerLabel)}\n${tag}${body}`
  let out = text.slice(0, u.sourceEnd) + block + text.slice(u.sourceEnd)

  // 뒤 발화가 이어받고 있었다면 그 화자를 복원한다.
  const inherit = nextInheritingIndex(utterances, index)
  if (inherit !== null) {
    const next = utterances[inherit]
    const at = next.sourceStart + block.length
    const restore = `${speakerDirective(u.speakerLabel)}\n`
    out = out.slice(0, at) + restore + out.slice(at)
  }
  return { text: out, changed: true, refusedCode: null }
}

/** 빈 여러 명 대본 최초 생성. 원문이 비어 있을 때만 만든다. */
export function createInitialDialogue(
  text: string, rows: readonly { speakerLabel: string; line: string }[]
): PatchResult {
  if (text.trim() !== '') return unchanged(text, 'TEXT_NOT_EMPTY')
  const usable = rows.filter((r) => r.speakerLabel.trim() && r.line.trim())
  if (usable.length === 0) return unchanged(text, 'NOTHING_TO_WRITE')
  const body = usable
    .map((r) => `${speakerDirective(r.speakerLabel)}\n${r.line.replace(/\r?\n/g, ' ').trim()}`)
    .join('\n')
  return { text: body, changed: true, refusedCode: null }
}

/**
 * 발화를 지운다. 뒤 발화가 이 발화의 화자를 이어받고 있으면 복원 표기를 남긴다.
 */
export function deleteUtterance(
  text: string, utterances: readonly UtteranceView[], index: number
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  const inherit = nextInheritingIndex(utterances, index)
  const restore = inherit !== null ? `${speakerDirective(u.speakerLabel)}\n` : ''
  return {
    text: text.slice(0, u.sourceStart) + restore + text.slice(u.sourceEnd),
    changed: true, refusedCode: null,
  }
}

/**
 * 두 발화가 **완전히 독립적인가** — 순서 변경을 허용해도 되는가.
 *
 * 발화 사이에는 빈 줄·문단 경계·쉼·화자 유지 상태·감정 초기화·지시 전용 줄이 붙을 수
 * 있다. 조각만 맞바꾸면 그 정보가 다른 발화에 붙는다. 그래서 다음이 모두 참일 때만
 * 허용한다.
 *
 *   · 두 발화가 이웃이다
 *   · 둘 다 자기 화자 표기를 갖는다(물려받지 않는다)
 *   · 두 조각 사이가 줄바꿈·공백뿐이다
 *   · 뒤에 이어받는 발화가 없다
 *
 * 아니면 잠근다. 지원 범위를 넓히려고 원문 전체를 재작성하지 않는다.
 */
export function canMove(
  text: string, utterances: readonly UtteranceView[], from: number, to: number
): { allowed: boolean; code: string | null } {
  if (Math.abs(from - to) !== 1) return { allowed: false, code: 'NOT_ADJACENT' }
  const a = utterances[Math.min(from, to)]
  const b = utterances[Math.max(from, to)]
  if (!a || !b) return { allowed: false, code: 'UTTERANCE_NOT_FOUND' }
  if (!a.hasOwnSpeakerDirective || !b.hasOwnSpeakerDirective) {
    return { allowed: false, code: 'SPEAKER_INHERITED' }
  }
  if (text.slice(a.sourceEnd, b.sourceStart).trim() !== '') {
    return { allowed: false, code: 'CONTENT_BETWEEN' }
  }
  if (nextInheritingIndex(utterances, Math.max(from, to)) !== null) {
    return { allowed: false, code: 'FOLLOWER_INHERITS' }
  }
  return { allowed: true, code: null }
}

/** 이웃한 두 발화의 자리를 바꾼다. `canMove` 가 허용할 때만 한다. */
export function moveUtterance(
  text: string, utterances: readonly UtteranceView[], from: number, to: number
): PatchResult {
  const verdict = canMove(text, utterances, from, to)
  if (!verdict.allowed) return unchanged(text, verdict.code ?? 'MOVE_NOT_ALLOWED')
  const a = utterances[Math.min(from, to)]
  const b = utterances[Math.max(from, to)]
  const between = text.slice(a.sourceEnd, b.sourceStart)
  const out = text.slice(0, a.sourceStart)
    + sliceOf(text, b) + between + sliceOf(text, a)
    + text.slice(b.sourceEnd)
  return { text: out, changed: true, refusedCode: null }
}
