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

/**
 * 화자 이름 허용 문자 — `ttsGrammar` 의 `SPEAKER_ID_RE` 와 같은 범위다.
 *
 * 값 import 금지 규약 때문에 사본을 두고, 두 벌이 어긋나지 않도록 테스트가 대조한다.
 * 한국어 음절·자모·영문·숫자·밑줄·붙임표만 받는다 — **공백은 받지 않는다.**
 */
export const SPEAKER_LABEL_RE = /^[0-9A-Za-z_\-\u3131-\u318E\uAC00-\uD7A3]+$/

export const SPEAKER_LABEL_PROBLEMS = [
  'EMPTY', 'HAS_WHITESPACE', 'FORBIDDEN_CHAR', 'RESERVED_DEFAULT',
] as const
export type SpeakerLabelProblem = typeof SPEAKER_LABEL_PROBLEMS[number]

/**
 * 이름을 원문에 쓰기 **전에** 화면이 알려 줄 수 있도록 판정한다.
 *
 * `기본`·`default` 는 "기본 목소리로 돌아가기" 를 뜻하는 예약어라 인물 이름으로 쓰지
 * 못한다 — 인물 이름으로 허용하면 그 인물의 말이 전부 기본 목소리가 된다.
 */
export function validateSpeakerLabel(
  label: string
): { ok: boolean; problem: SpeakerLabelProblem | null } {
  const raw = label ?? ''
  if (raw.trim() === '') return { ok: false, problem: 'EMPTY' }
  if (/\s/.test(raw.trim())) return { ok: false, problem: 'HAS_WHITESPACE' }
  const t = raw.trim()
  if (t === SPEAKER_DEFAULT_ARG || t.toLowerCase() === 'default') {
    return { ok: false, problem: 'RESERVED_DEFAULT' }
  }
  if (!SPEAKER_LABEL_RE.test(t)) return { ok: false, problem: 'FORBIDDEN_CHAR' }
  return { ok: true, problem: null }
}

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

/**
 * **일시적** 사유 — 잠시 뒤 계획이 오면 사라진다.
 *
 * 이것만 남아 있으면 구조화 화면을 닫지 않는다. 한 글자 칠 때마다 화면이 바뀌면 사용자가
 * 이어서 타이핑할 수 없기 때문이다. 나머지(파서 물러남·좌표 근사·구간 겹침·구간 밖
 * 내용·차단 경고·발화 없음)는 **구조적** 사유이며, 그때는 직접 입력 화면을 보여 준다.
 */
export const TRANSIENT_BLOCKERS = ['PLAN_MISSING', 'PLAN_STALE'] as const

/**
 * 여러 명 화면이 지금 무엇을 할 수 있는가.
 *
 *   structured — 발화를 구조화 편집할 수 있다(모든 게이트 통과)
 *   initial    — 원문이 **비어 있다.** 계획이 없어도 첫 대화를 만들 수 있다
 *   sourceOnly — 표현할 수 없는 대본이다. 원문 편집기를 그대로 보여 주고 이유만 말한다
 */
export const STRUCTURE_MODES = ['structured', 'initial', 'sourceOnly'] as const
export type StructureMode = typeof STRUCTURE_MODES[number]

export interface StructureVerdict {
  mode: StructureMode
  /** 구조화 편집을 허용해도 되는가. 거짓이면 원문 편집기를 그대로 보여 준다. */
  structurable: boolean
  /**
   * 빈 원문에서 첫 대화를 만들 수 있는가.
   *
   * 빈 대본에는 계획이 없어 `PLAN_MISSING` 이 뜬다. 그것 때문에 여러 명 탭에서 첫 대화를
   * 만들 수 없으면 기능 자체가 시작되지 않는다. 공백 외 문자가 **하나라도** 있으면 이
   * 예외를 적용하지 않는다 — 그때는 기존 내용을 건드릴 위험이 생긴다.
   */
  initialCreationAllowed: boolean
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
  // 빈 원문(공백뿐 포함)은 계획을 기다리지 않는다. 지울 내용이 없으므로 안전하다.
  if (input.text.trim() === '') {
    return {
      mode: 'initial', structurable: false, initialCreationAllowed: true,
      blockers: [], utteranceCount: 0,
    }
  }
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

  const ok = blockers.length === 0
  return {
    mode: ok ? 'structured' : 'sourceOnly',
    structurable: ok,
    // 원문에 글자가 있으면 초기 생성 예외는 없다.
    initialCreationAllowed: false,
    blockers,
    utteranceCount: input.utterances.length,
  }
}

/**
 * 좌표에 의존하는 명령 — 계획이 낡았으면 이것만 잠근다.
 *
 * 일반 문자 입력까지 막으면 사용자가 이어서 타이핑할 수 없다. 그래서 화면은 입력을
 * 계속 받고(임시 draft), 순서 이동·화자 변경·삭제처럼 **좌표를 읽어야 하는** 명령만
 * 잠근다.
 */
export const COORDINATE_DEPENDENT_ACTIONS = [
  'moveUtterance', 'changeSpeaker', 'deleteUtterance', 'insertUtteranceAfter',
  // 구조화 draft 를 원문에 반영하는 것도 좌표를 읽는다 — 같은 게이트를 받는다.
  'commitDraft',
] as const
export type CoordinateDependentAction = typeof COORDINATE_DEPENDENT_ACTIONS[number]

/** 이 명령을 지금 눌러도 되는가. 계획이 현재 원문과 맞을 때만 참이다. */
export function actionAllowed(
  verdict: StructureVerdict, action: CoordinateDependentAction
): boolean {
  void action
  return verdict.structurable
}

/**
 * **기존 `대본 직접 입력` textarea 는 어떤 상태에서도 막지 않는다.**
 *
 * 이 함수가 상수 `true` 인 것은 실수가 아니라 계약이다. 원문 편집은 이 앱의 마지막
 * 안전판이다 — 계획이 없거나 낡았거나, 파서가 물러났거나, 쉼·복합 지시로 구조화가
 * 불가능한 대본이어도 사용자는 원문을 고칠 수 있어야 한다. 호출부가 이 값을 읽어
 * `disabled` 를 걸 일이 없도록 이름과 반환을 분명히 둔다.
 *
 * 이전 판에는 `textInputAllowed` 가 있었고 `NON_WHITESPACE_OUTSIDE` 에서 false 였다.
 * 이름만 보면 원문 입력을 막는 값으로 읽혀, 배선하는 사람이 textarea 를 잠글 구조였다.
 */
export function directTextEditingAllowed(): true {
  return true
}

/**
 * **구조화 편집기(여러 명 화면)** 를 열어 입력을 받아도 되는가.
 *
 * 계획이 없거나 낡은 것만으로는 닫지 않는다 — 한 글자 칠 때마다 화면이 바뀌면 이어서
 * 타이핑할 수 없다. 닫는 것은 표현 자체가 불가능한 대본(`sourceOnly`)일 때뿐이고,
 * 그때는 기존 직접 입력 화면을 활성 상태로 보여 준다.
 */
export function structuredEditingAllowed(verdict: StructureVerdict): boolean {
  // 구조적 사유가 하나라도 있으면 이 대본은 구조화로 표현할 수 없다.
  return !verdict.blockers.some((b) => !TRANSIENT_BLOCKERS.includes(
    b as typeof TRANSIENT_BLOCKERS[number]))
}

/**
 * 구조화 화면의 변경을 **원문에 반영**해도 되는가 — 좌표 의존 명령의 단일 게이트.
 *
 * 화자 변경·발화 삽입·삭제·순서 이동·draft commit 이 모두 이 판정을 받는다.
 * 계획이 현재 원문과 맞을 때만 참이다.
 */
export function structuredPatchAllowed(verdict: StructureVerdict): boolean {
  return verdict.structurable
}

/**
 * draft 를 원문에 반영해도 되는가 — **덮어쓰기 사고를 막는 마지막 관문.**
 *
 * 입력을 시작할 때 원문 SHA 를 붙잡아 두고(captured), 반영 직전에 지금 SHA 와 견준다.
 * 다르면 그 사이 원문이 밖에서 바뀐 것이므로 **덮어쓰지 않고** 최신 원문으로 다시
 * 맞춘다. 늦게 도착한 계획 응답이 사용자의 최신 글자를 되돌릴 통로가 없어야 한다.
 */
export type CommitDecision = 'commit' | 'resync' | 'noop'

export function commitDecision(
  capturedSha: string | null, currentSha: string, draft: string, committed: string
): CommitDecision {
  if (draft === committed) return 'noop'
  if (capturedSha === null) return 'resync'
  return capturedSha === currentSha ? 'commit' : 'resync'
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
  // null = **기본 인물**(화자 표기 없음). `[화자 기본]` 으로 되돌린다 — 파서가 speaker 를 비운다(실측).
  // 빈 문자열은 기본 인물이 아니라 잘못된 이름이다.
  const toDefault = newLabel === null
  const label = toDefault ? '' : newLabel.trim()
  if (!toDefault) {
    const check = validateSpeakerLabel(label)
    if (!check.ok) return unchanged(text, `SPEAKER_LABEL_${check.problem}`)
  }
  if ((u.speakerLabel ?? null) === (toDefault ? null : label)) return unchanged(text, 'NO_CHANGE')

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

/** 이름 → 내부 id(계획·파서와 같은 정규화: NFC + 소문자). 이 모듈은 파서를 부르지 않는다. */
export function speakerIdOfLabel(label: string): string {
  return label.trim().normalize('NFC').toLowerCase()
}

/**
 * 한 인물의 **이름**을 바꾼다 — 그 인물의 모든 자기 표기(`[화자 이름]`)를 새 이름으로 바꾼다.
 *
 * 카드의 '이름 바꾸기' 전용이다. 발화를 다른 인물로 옮기는 changeSpeaker 와 다르다: 화자 의미는 그대로고 이름만 바뀐다.
 * 이어받는 발화(표기 없음)는 손대지 않는다 — 앞 발화의 새 이름을 그대로 이어받는다.
 * 거부: SPEAKER_LABEL_*(잘못된 이름) / SPEAKER_NOT_FOUND(그 인물의 발화 없음) / NO_CHANGE /
 *      SPEAKER_LABEL_DUPLICATE(다른 기존 인물과 같은 이름 — 자동 병합하지 않는다).
 */
export function renameSpeaker(
  text: string, utterances: readonly UtteranceView[], speakerId: string, newLabel: string
): PatchResult {
  const label = newLabel.trim()
  const check = validateSpeakerLabel(label)
  if (!check.ok) return unchanged(text, `SPEAKER_LABEL_${check.problem}`)
  const targets = utterances.filter((u) => u.speakerId === speakerId)
  if (targets.length === 0) return unchanged(text, 'SPEAKER_NOT_FOUND')
  const newId = speakerIdOfLabel(label)
  if (newId !== speakerId && utterances.some((u) => u.speakerId === newId)) return unchanged(text, 'SPEAKER_LABEL_DUPLICATE')
  if (targets.every((u) => (u.speakerLabel ?? '') === label)) return unchanged(text, 'NO_CHANGE')
  const directive = /\[\s*(?:화자|speaker)\s+[^\]]*\]/
  // 뒤에서 앞으로 바꿔 앞쪽 좌표가 흔들리지 않게 한다. 조각의 나머지(감정 태그·대사)는 글자 그대로.
  let out = text
  for (const u of [...targets].filter((u) => u.hasOwnSpeakerDirective).sort((a, b) => b.sourceStart - a.sourceStart)) {
    const slice = out.slice(u.sourceStart, u.sourceEnd)
    if (!directive.test(slice)) return unchanged(text, 'SPEAKER_DIRECTIVE_NOT_FOUND')
    out = out.slice(0, u.sourceStart) + slice.replace(directive, speakerDirective(label)) + out.slice(u.sourceEnd)
  }
  if (out === text) return unchanged(text, 'NO_CHANGE')
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
  const check = validateSpeakerLabel(speakerLabel ?? '')
  if (!check.ok) return unchanged(text, `SPEAKER_LABEL_${check.problem}`)
  const body = line.replace(/\r?\n/g, ' ').trim()
  if (!body) return unchanged(text, 'LINE_EMPTY')
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
  // 공백 외 문자가 하나라도 있으면 초기 생성 예외를 적용하지 않는다.
  if (text.trim() !== '') return unchanged(text, 'TEXT_NOT_EMPTY')
  const usable = rows.filter((r) => r.speakerLabel.trim() && r.line.trim())
  if (usable.length === 0) return unchanged(text, 'NOTHING_TO_WRITE')
  for (const r of usable) {
    const check = validateSpeakerLabel(r.speakerLabel)
    if (!check.ok) return unchanged(text, `SPEAKER_LABEL_${check.problem}`)
  }
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

/**
 * 발화 **본문**만 바꾼다 — 화자 표기와 맨 앞 기본 감정 태그는 그대로 둔다.
 *
 * 본문은 화자 표기·기본 감정 태그 뒤의 나머지다. 대사 중간 감정 태그는 본문 안에 있으므로,
 * 기본 화면에서 본문을 고칠 때 그 태그가 사라지면 안 된다. 그래서 태그 수가 줄어들면
 * 기본값에서는 거부한다(`MID_EMOTION_WOULD_BE_LOST`). `대사 중간에 감정 바꾸기` 편집기만
 * `allowEmotionTagChange` 로 그 보호를 푼다 — 사용자가 태그를 보면서 직접 고치는 자리다.
 *
 * `capturedSha`/`currentSha` 를 주면 둘이 다를 때 거부한다(`STALE_SOURCE`). 좌표가 낡은
 * 채로 구간을 덮어쓰는 사고를 명령 자체에서도 막는다.
 */
export function utteranceParts(
  slice: string
): { speakerPart: string; emotionPart: string; body: string } {
  const m = slice.match(/^(\s*\[\s*(?:화자|speaker)\s+[^\]]*\]\s*)?(\[[^\]\s]+\]\s*)?/)
  const speakerPart = m?.[1] ?? ''
  const emotionPart = m?.[2] ?? ''
  return { speakerPart, emotionPart, body: slice.slice(speakerPart.length + emotionPart.length) }
}

export function replaceUtteranceBody(
  text: string, utterances: readonly UtteranceView[], index: number, newBody: string,
  opts: { allowEmotionTagChange?: boolean; capturedSha?: string | null;
    currentSha?: string | null } = {}
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  if (opts.capturedSha != null && opts.currentSha != null
    && opts.capturedSha !== opts.currentSha) {
    return unchanged(text, 'STALE_SOURCE')
  }
  const body = newBody.replace(/\r?\n/g, ' ').trim()
  if (!body) return unchanged(text, 'LINE_EMPTY')
  const slice = sliceOf(text, u)
  const { speakerPart, emotionPart, body: oldBody } = utteranceParts(slice)
  if (oldBody.trim() === body) return unchanged(text, 'NO_CHANGE')
  const countTags = (s: string) => (s.match(/\[[^\]]*\]/g) ?? []).length
  if (!opts.allowEmotionTagChange && countTags(body) < countTags(oldBody)) {
    return unchanged(text, 'MID_EMOTION_WOULD_BE_LOST')
  }
  const replaced = `${speakerPart}${emotionPart}${body}`
  return {
    text: text.slice(0, u.sourceStart) + replaced + text.slice(u.sourceEnd),
    changed: true, refusedCode: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 계획 좌표 → 행 뷰
//
// 실측(python/script_plan.build_structure, fixtures/dialogue-planner-spans.json):
//   · 발화 구간은 `[화자 …]` 줄을 **포함하지 않는다**. 그 줄은 앞 발화 끝과 다음 발화 시작
//     사이의 빈틈에 놓인다.
//   · 한 줄 안의 감정 전환·쉼은 발화를 **여러 개로 나눈다**(같은 line_index).
// 화면의 "대화 한 줄" 은 같은 줄의 발화들을 하나로 묶고, 바로 앞 빈틈이 공백 + 화자 표기
// 하나뿐이면 그 표기를 구간에 흡수한다. 그래서 위의 UtteranceView 계약("구간은 자기 지시를
// 포함한다") 이 성립한다. 빈틈에 그 밖의 것이 있으면 흡수하지 않고 그대로 두어
// NON_WHITESPACE_OUTSIDE 가 정직하게 걸린다.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanUtteranceLike {
  index: number
  speakerId: string | null
  speakerLabel: string | null
  emotionId: string | null
  sourceStart: number
  sourceEnd: number
  lineIndex: number | null
}

/** 공백 + (화자 표기 하나) + 공백. 그 이상은 흡수하지 않는다. */
const GAP_WITH_ONE_SPEAKER_RE = /^\s*(\[\s*(?:화자|speaker)\s+[^\]]*\])?\s*$/

export function groupUtteranceRows(text: string, utterances: PlanUtteranceLike[]): UtteranceView[] {
  const sorted = [...utterances].sort((a, b) => a.sourceStart - b.sourceStart)
  const rows: UtteranceView[] = []
  for (const u of sorted) {
    const cur = rows[rows.length - 1]
    if (cur && cur.lineIndex !== null && u.lineIndex === cur.lineIndex && u.sourceStart >= cur.sourceEnd) {
      // 같은 줄의 다음 조각(감정 전환·쉼으로 나뉜 것) — 한 행으로 잇는다.
      cur.sourceEnd = u.sourceEnd
      continue
    }
    const prevEnd = cur ? cur.sourceEnd : 0
    const gap = text.slice(prevEnd, u.sourceStart)
    const m = GAP_WITH_ONE_SPEAKER_RE.exec(gap)
    let start = u.sourceStart
    let own = false
    if (m && m[1]) {
      start = prevEnd + gap.indexOf('[')
      own = true
    }
    rows.push({
      index: rows.length,
      sourceStart: start,
      sourceEnd: u.sourceEnd,
      speakerId: u.speakerId,
      speakerLabel: u.speakerLabel,
      emotionId: u.emotionId,
      hasOwnSpeakerDirective: own,
      lineIndex: u.lineIndex,
    })
  }
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// 한 명 화면의 화자 구조 보호
//
// 한 명과 여러 명은 같은 원문을 본다. 한 명 화면의 일반 편집이 `[화자 …]` 표기를 지우면
// 여러 명 화면의 인물·배정이 조용히 사라진다. 그래서 명시 화자가 하나라도 있는 대본에서는
// 한 명 화면의 편집을 **화자 표기 순서가 그대로인 변경**만 받아들인다. 구조를 실제로 없애는
// 것은 별도 동작(`stripSpeakerDirectives`)이고, 사용자 확인 뒤에만 부른다.
// ─────────────────────────────────────────────────────────────────────────────

const SPEAKER_DIRECTIVE_GLOBAL_RE = /\[\s*(?:화자|speaker)\s+[^\]]*\]/g
const SPEAKER_DIRECTIVE_LINE_RE = /^\s*\[\s*(?:화자|speaker)\s+[^\]]*\]\s*$/

/** 원문에 나오는 화자 표기를 순서대로(안쪽 공백 정리). 표기가 없으면 빈 배열. */
export function speakerDirectiveSequence(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SPEAKER_DIRECTIVE_GLOBAL_RE)) {
    out.push(m[0].replace(/\s+/g, ' ').replace(/\[ /, '[').replace(/ \]/, ']'))
  }
  return out
}

/** 편집 전후로 화자 표기의 개수·순서·이름이 같은가. 같으면 한 명 화면의 편집으로 받아들인다. */
export function speakerStructurePreserved(prev: string, next: string): boolean {
  const a = speakerDirectiveSequence(prev)
  const b = speakerDirectiveSequence(next)
  return a.length === b.length && a.every((d, i) => d === b[i])
}

/**
 * 화자 표기를 모두 지운다 — **한 명 대본으로 전환**. 표기만 있는 줄은 줄째 지우고, 대사와 같은
 * 줄의 표기는 표기(와 뒤따르는 공백 하나)만 지운다. 감정·쉼·그 밖의 표기와 대사는 글자 그대로.
 * 표기가 없으면 변화 없음(NO_CHANGE).
 */
export function stripSpeakerDirectives(text: string): PatchResult & { removed: number } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let removed = 0
  const kept: string[] = []
  for (const line of lines) {
    if (SPEAKER_DIRECTIVE_LINE_RE.test(line)) { removed += 1; continue }
    const replaced = line.replace(/\[\s*(?:화자|speaker)\s+[^\]]*\] ?/g, () => { removed += 1; return '' })
    kept.push(replaced)
  }
  if (removed === 0) return { ...unchanged(text, 'NO_CHANGE'), removed: 0 }
  return { text: kept.join(eol), changed: true, refusedCode: null, removed }
}

// ─────────────────────────────────────────────────────────────────────────────
// 카드 본문(content) — 여러 명 화면의 발화 카드는 대화칸 하나만 쓴다.
//
// content = 원문 조각에서 화자 표기(`[화자 …]`)만 뺀 나머지. 첫 감정 태그·중간 감정 태그·쉼 표기가
// 글자 그대로 들어 있다. 사용자는 이 칸에서 태그를 넣고 지우고 고친다(일반 편집). 반영은 화자 표기만
// 지키고 나머지를 통째로 바꾼다 — 두 번째 textarea 도, 태그 보호 규칙도 없다.
// ─────────────────────────────────────────────────────────────────────────────

/** 조각 → (화자 표기, 나머지). 나머지의 앞 공백은 표기 쪽에 둔다(줄바꿈 보존). */
export function utteranceContentParts(slice: string): { speakerPart: string; content: string } {
  const m = slice.match(/^(\s*\[\s*(?:화자|speaker)\s+[^\]]*\]\s*)?/)
  const speakerPart = m?.[1] ?? ''
  return { speakerPart, content: slice.slice(speakerPart.length) }
}

/**
 * 카드 본문 반영. 화자 표기는 그대로, 그 뒤를 newContent 로 바꾼다.
 * 거부: UTTERANCE_NOT_FOUND / STALE_SOURCE(붙잡은 SHA ≠ 현재) / LINE_EMPTY / NO_CHANGE.
 */
export function replaceUtteranceContent(
  text: string, utterances: readonly UtteranceView[], index: number, newContent: string,
  opts: { capturedSha?: string | null; currentSha?: string | null } = {}
): PatchResult {
  const u = utterances[index]
  if (!u) return unchanged(text, 'UTTERANCE_NOT_FOUND')
  if (opts.capturedSha != null && opts.currentSha != null && opts.capturedSha !== opts.currentSha) {
    return unchanged(text, 'STALE_SOURCE')
  }
  if (newContent.trim() === '') return unchanged(text, 'LINE_EMPTY')
  const slice = sliceOf(text, u)
  const parts = utteranceContentParts(slice)
  // 조각 끝의 줄바꿈은 구간 밖 구분자와 같은 역할이라 그대로 둔다.
  const tail = parts.content.match(/\s*$/)?.[0] ?? ''
  const nextSlice = parts.speakerPart + newContent.replace(/\s+$/, '') + tail
  if (nextSlice === slice) return unchanged(text, 'NO_CHANGE')
  return { text: text.slice(0, u.sourceStart) + nextSlice + text.slice(u.sourceEnd), changed: true, refusedCode: null }
}

/**
 * caret 위치에 태그(`[기쁨]`)를 넣는다 — 여러 명 카드의 `+ 감정`.
 *   · caret 이 기존 `[…]` 표기 안(또는 경계)이면 표기를 깨지 않고 **그 표기 뒤**에 넣는다
 *   · 바로 앞 글자가 공백이 아니면 공백 하나를 앞에 둔다(`안녕하세요. [기쁨]오랜만이에요.`)
 *   · 맨 앞이면 시작 감정, 중간이면 그 위치부터 감정 변경 — 문법은 기존 그대로
 * 반환: 새 본문, 새 caret(태그 뒤), 실제 삽입 위치와 삽입 문자열(네이티브 undo 를 위해 execCommand 로
 * 넣을 때 그대로 쓴다).
 */
export function insertTagAtCaret(
  content: string, caret: number | null, tag: string
): { text: string; caret: number; insertAt: number; inserted: string } {
  let at = caret == null ? 0 : Math.max(0, Math.min(content.length, caret))
  // 기존 표기 안인가: 뒤로 가장 가까운 '[' 가 있고 그 뒤 ']' 가 at 이후에 있으며 둘 사이에 ']' 가 없다.
  const open = content.lastIndexOf('[', at - 1)
  if (open >= 0) {
    const close = content.indexOf(']', open)
    if (close >= 0 && close >= at && !content.slice(open + 1, at).includes(']')) at = close + 1
  }
  const prev = at > 0 ? content[at - 1] : ''
  const inserted = (prev && !/\s/.test(prev) ? ' ' : '') + tag
  const text = content.slice(0, at) + inserted + content.slice(at)
  return { text, caret: at + inserted.length, insertAt: at, inserted }
}
