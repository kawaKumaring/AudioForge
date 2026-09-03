/**
 * 분석 결과를 **사용자 언어**로 바꾸는 순수 함수들. UI 문구의 단일 출처다.
 *
 * 기본 화면에서는 token·tier 같은 내부 단위를 쓰지 않는다.
 *   chunk    → 생성 묶음
 *   segment  → 대사 구간
 *   문단     → 사용자가 Enter 로 나눈 것 (그것만)
 *
 * 숫자를 지어내지 않는다 — 자료가 없으면 문구로 그렇게 말한다.
 */
import type {
  AnalysisResult, PlanWarning, PlanWarningCode, Range, ReservedAxis, SplitReason,
} from './inputAnalysis'
import type {
  EmotionMatchState, EmotionMatchView, ReferenceDecision, ReferenceSource,
  SpeakerReferenceFailure,
} from './speakerReference'

/** 사람이 읽는 길이. 1분 미만은 초로만 말한다. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m}분` : `${m}분 ${rest}초`
}

/** 범위. 반올림 뒤 같아지면 한 값으로 말한다(2분~2분 은 정보가 아니다). */
export function formatRange(range: Range | null | undefined): string | null {
  if (!range) return null
  const lo = formatDuration(range.min)
  const hi = formatDuration(range.max)
  return lo === hi ? lo : `${lo}~${hi}`
}

/** 시간 숫자를 보여도 되는가 — 근사 tokenizer 나 자료 부족이면 보여주지 않는다. */
export function canShowWallTime(r: AnalysisResult | null): boolean {
  if (!r) return false
  if (r.tokenizer !== 'production') return false
  return r.estimatedWallSeconds !== null && r.confidence !== 'insufficient_data'
}

export const INSUFFICIENT_TEXT = '예측 자료 부족'

/** 기본 화면 한 줄. 예: `예상 음성 2분 10초~2분 35초 · 예상 작업 6~8분 · 3개 묶음` */
export function summaryLine(r: AnalysisResult | null): string {
  if (!r) return ''
  const audio = formatRange(r.estimatedAudioSeconds)
  const wall = canShowWallTime(r) ? formatRange(r.estimatedWallSeconds) : INSUFFICIENT_TEXT
  // 작업 시간에는 대사 길이와 무관한 모델 준비 비용이 한 번 들어간다. 그 사실을 여기서
  // 말하지 않으면 짧은 대사에서 '2초짜리 음성인데 왜 1분인가' 로 읽힌다.
  const wallText = canShowWallTime(r) ? `${wall}(모델 준비 포함)` : wall
  const parts = [
    audio ? `예상 음성 ${audio}` : null,
    `예상 작업 ${wallText}`,
    `${r.plannedCalls}개 묶음`,
  ].filter(Boolean)
  return parts.join(' · ')
}

/** 문단 한 줄에 붙는 설명. 문단 수와 구간 수를 섞지 않는다. */
export function paragraphSummary(
  r: AnalysisResult, paragraphIndex: number
): { audio: string | null; wall: string | null; calls: number; autoSplit: boolean } {
  const segs = r.segments.filter((s) => s.sourceParagraphIndex === paragraphIndex)
  const calls = segs.reduce((n, s) => n + s.plannedCalls, 0)
  if (!segs.length) return { audio: null, wall: null, calls: 0, autoSplit: false }
  const audio = {
    min: segs.reduce((n, s) => n + s.estimatedAudioSeconds.min, 0),
    max: segs.reduce((n, s) => n + s.estimatedAudioSeconds.max, 0),
  }
  // 문단 줄은 **한계 비용**을 더한다. 전체 작업 시간을 문단마다 쓰면 합이 요약보다 커진다.
  const wallParts = segs.map((s) => s.estimatedWallSecondsMarginal)
  const wall = canShowWallTime(r) && wallParts.every(Boolean)
    ? formatRange({
      min: wallParts.reduce((n, w) => n + (w?.min ?? 0), 0),
      max: wallParts.reduce((n, w) => n + (w?.max ?? 0), 0),
    })
    : null
  return {
    audio: formatRange(audio), wall, calls,
    autoSplit: segs.some((s) => s.autoSplit),
  }
}

/** 실제로 **선택된** 경계만 말한다. 쓰이지 않은 문장부호를 분할 예정처럼 적지 않는다. */
export const SPLIT_REASON_LABEL: Record<SplitReason, string> = {
  user_paragraph: '사용자 문단 경계',
  sentence_end: '완결 문장 경계',
  clause: '보조 분할',
  forced_character: '최후 분할',
  end_of_input: '대사 끝',
}

/** `최후 분할` 만 경고다 — 문장부호가 없어 어쩔 수 없이 자른 자리다. */
export function isForcedSplit(reason: SplitReason): boolean {
  return reason === 'forced_character'
}

/**
 * 분할 목록 행. 마지막 묶음의 `대사 끝` 은 경계가 아니므로 목록에서 뺀다 —
 * 실제로 일어난 분할만 보여 준다.
 */
export function splitRows(r: AnalysisResult | null): {
  afterChunkIndex: number; reason: SplitReason; label: string; forced: boolean
}[] {
  if (!r) return []
  return r.chunks
    .filter((c, i) => i < r.chunks.length - 1)
    .map((c) => ({
      afterChunkIndex: c.globalIndex,
      reason: c.splitReason,
      label: SPLIT_REASON_LABEL[c.splitReason] ?? c.splitReason,
      forced: isForcedSplit(c.splitReason),
    }))
}

/** 상세 보기에만 나가는 문구. 기본 화면에서는 쓰지 않는다. */
export function confidenceLabel(r: AnalysisResult | null): string {
  if (!r) return ''
  if (r.tokenizer !== 'production') return '토큰 계산기를 준비하지 못해 시간은 표시하지 않습니다'
  switch (r.confidence) {
    case 'measured': return '실측 범위 안'
    case 'extrapolated': return '실측 범위 밖 — 외삽'
    default: return INSUFFICIENT_TEXT
  }
}

/** 상세 보기 한 줄 — 요약의 `(모델 준비 포함)` 이 무엇인지 수치로 밝힌다. */
export function preparationNote(r: AnalysisResult | null): string | null {
  if (!r || !canShowWallTime(r)) return null
  const prep = formatRange(r.preparationSeconds)
  if (!prep) return null
  return `예상 작업 시간에는 대사 길이와 무관한 모델 준비 시간 ${prep} 가 한 번 들어 있습니다.`
}

/** 문단 줄의 시간이 무엇인지 — 합이 요약과 다른 이유. */
export const PARAGRAPH_WALL_NOTE = '문단별 작업 시간은 그 문단이 더 얹는 시간입니다(준비 시간 제외).'

// ── 공용 계획을 읽는 문구 ─────────────────────────────────────────────────────
// 화면은 계획을 **다시 해석하지 않는다.** 여기 있는 것은 계획의 행을 사람 말로 바꾸는
// 순수 함수뿐이고, 문단을 다시 세거나 대본을 다시 나누는 코드는 하나도 없다.

/** 세 축의 관계 한 줄. 같은 이름으로 부르지 않는다. */
export function axisRelationLine(r: AnalysisResult | null): string {
  if (!r) return ''
  const p = r.plan.sourceParagraphs.length
  const u = r.plan.utterances.length
  const c = r.plan.chunks.length
  return `문단 ${p} · 발화 ${u} · 생성 묶음 ${c}`
}

export const AXIS_NOTE =
  '문단은 Enter 로 나눈 것, 발화는 지시가 나눈 말, 생성 묶음은 실제 모델 호출입니다.'

/** 문단 하나에 속한 발화들. 계획에 있는 그대로 골라 낸다. */
export function utteranceRows(r: AnalysisResult | null, paragraphIndex: number): {
  index: number
  /** 내부 stable id(null = 기본 화자). */
  speakerId: string | null
  /** 화면에 보여 줄 이름(사용자가 쓴 그대로). */
  speakerLabel: string | null
  emotionId: string | null
  chars: number
  calls: number
  autoSplit: boolean
  sourceStart: number
  sourceEnd: number
  approximate: boolean
}[] {
  if (!r) return []
  return r.plan.utterances
    .filter((u) => u.sourceParagraphIndex === paragraphIndex)
    .map((u) => {
      const mine = r.plan.chunks.filter((c) => c.segmentIndex === u.index)
      return {
        index: u.index,
        speakerId: u.speakerId,
        speakerLabel: u.speakerLabel,
        emotionId: u.emotionId,
        chars: u.chars,
        calls: mine.length,
        autoSplit: mine.length > 1,
        sourceStart: u.sourceStart,
        sourceEnd: u.sourceEnd,
        approximate: !u.sourceOffsetsExact,
      }
    })
}

/** 감정 구간. 발화마다 한 줄씩 늘어놓지 않고 이어지는 구간으로 말한다. */
export function emotionSpanRows(r: AnalysisResult | null): {
  index: number
  emotionId: string
  utteranceLabel: string
  sourceStart: number
  sourceEnd: number
}[] {
  if (!r) return []
  return r.plan.emotions.map((e) => ({
    index: e.index,
    emotionId: e.emotionId,
    utteranceLabel: e.utteranceStart === e.utteranceEnd
      ? `발화 ${e.utteranceStart + 1}`
      : `발화 ${e.utteranceStart + 1}~${e.utteranceEnd + 1}`,
    sourceStart: e.sourceStart,
    sourceEnd: e.sourceEnd,
  }))
}

/** 사전 경고를 사용자 언어로. 내부 코드는 화면에 쓰지 않는다. */
export const PLAN_WARNING_LABEL: Record<PlanWarningCode, string> = {
  UNCLOSED_TAG: '닫히지 않은 표기',
  UNKNOWN_DIRECTIVE: '알 수 없는 표기',
  EMPTY_UTTERANCE: '말이 없는 지시',
  CONFLICTING_DIRECTIVES: '겹치는 지시',
  DIRECTIVE_ONLY_PARAGRAPH: '말이 없는 문단',
  INVALID_SPEAKER: '잘못된 화자 표기',
  SPEAKER_LABEL_VARIANT: '같은 화자를 다르게 적음',
}

/**
 * 이 진단이 **합성을 막는가.**
 *
 * 미리보기가 새로 막는 것은 하나도 없다. 이 표는 `v1.2.0` 부터 있던 파서 계약을 그대로
 * 옮긴 것이다 — 파서 오류(`UNKNOWN_TTS_TAG`·`INVALID_PAUSE_TAG`·`EMPTY_EMOTION_SEGMENT`)를
 * 진단으로 바꾼 세 코드는 예전과 똑같이 합성 시작에서 막히고, 파서가 정상 통과한 두 코드
 * (닫히지 않은 대괄호는 리터럴로 지나가고, 쉼만 있는 문단은 유효한 지시다)는 막지 않는다.
 *
 * 화면에서 둘을 같은 `경고` 로 보이면 사용자가 무엇을 고쳐야 합성이 되는지 알 수 없다.
 * 그래서 **표시만** 갈라 놓는다. 이 값으로 버튼을 잠그거나 요청을 거르지 않는다.
 * (`scriptPlan.parity.test.ts` 가 파서 오류에서 나온 코드가 전부 여기 true 인지 대조한다.)
 */
export const PLAN_WARNING_BLOCKS: Record<PlanWarningCode, boolean> = {
  UNCLOSED_TAG: false,
  UNKNOWN_DIRECTIVE: true,
  EMPTY_UTTERANCE: true,
  CONFLICTING_DIRECTIVES: true,
  DIRECTIVE_ONLY_PARAGRAPH: false,
  // 파서가 거부한다(INVALID_SPEAKER_TAG) → 예전과 같은 차단이다.
  INVALID_SPEAKER: true,
  // 파서는 같은 화자로 묶어 정상 생성한다 — 알려만 준다.
  SPEAKER_LABEL_VARIANT: false,
}

/** 두 층의 이름. 화면 문구는 여기 하나에서만 나온다. */
export const PLAN_KIND_LABEL = { blocking: '오류', advisory: '경고' } as const

/**
 * 무엇이 일어나는지 한 마디. 고치라고 명령하지 않는다 — 사실만 말한다.
 * 차단되는 것은 `합성이 차단됩니다` 로 끝낸다. 대사 편집기 아래 붉은 줄과 같은 표현이다.
 */
export const PLAN_WARNING_HINT: Record<PlanWarningCode, string> = {
  UNCLOSED_TAG: '대괄호가 닫히지 않아 그대로 대사에 남습니다',
  UNKNOWN_DIRECTIVE: '이 표기를 해석할 수 없습니다. 합성이 차단됩니다',
  EMPTY_UTTERANCE: '지시 뒤에 말이 없습니다. 합성이 차단됩니다',
  CONFLICTING_DIRECTIVES: '연달아 놓인 지시가 서로 부딪칩니다. 합성이 차단됩니다',
  DIRECTIVE_ONLY_PARAGRAPH: '이 문단에는 말이 없어 소리가 나지 않습니다',
  INVALID_SPEAKER: '화자 이름이 없거나 쓸 수 없는 문자입니다. 합성이 차단됩니다',
  SPEAKER_LABEL_VARIANT: '같은 화자로 묶였습니다(표기만 다릅니다)',
}

/**
 * 목록 아래 한 줄. 차단이 섞여 있는지에 따라 말이 달라진다 —
 * "경고가 있어도 합성은 된다" 를 오류가 있는 화면에 그대로 두면 거짓이 된다.
 */
export function planWarningNote(r: AnalysisResult | null): string | null {
  const rows = planWarningRows(r)
  if (!rows.length) return null
  const blocking = rows.some((w) => w.blocking)
  const advisory = rows.some((w) => !w.blocking)
  if (blocking && advisory) {
    return '오류는 고쳐야 합성이 시작됩니다. 경고는 합성을 막지 않습니다. 원문을 자동으로 고치지 않습니다.'
  }
  if (blocking) return '오류를 고쳐야 합성이 시작됩니다. 원문을 자동으로 고치지 않습니다.'
  return '경고는 합성을 막지 않습니다. 원문을 자동으로 고치지 않습니다.'
}

/** 경고 위치를 사람이 찾을 수 있는 말로. 줄을 알면 줄로, 모르면 글자 수로 말한다. */
export function warningWhere(w: PlanWarning): string {
  if (w.lineIndex !== null) return `${w.lineIndex + 1}번째 줄`
  if (w.sourceStart !== null) return `${w.sourceStart + 1}번째 글자`
  return '위치 불명'
}

export function planWarningRows(r: AnalysisResult | null): {
  key: string
  code: PlanWarningCode
  /** true = 예전부터 합성 시작을 막던 파서 오류. 미리보기가 새로 막는 것은 없다. */
  blocking: boolean
  /** `오류` 또는 `경고`. 화면이 이 둘을 같은 말로 부르지 않게 한다. */
  kindLabel: string
  label: string
  hint: string
  where: string
  sourceStart: number | null
  sourceEnd: number | null
  tag?: string
}[] {
  if (!r) return []
  return r.plan.warnings.map((w, i) => {
    const blocking = PLAN_WARNING_BLOCKS[w.code] === true
    return {
      key: `${w.code}:${w.sourceStart ?? -1}:${i}`,
      code: w.code,
      blocking,
      kindLabel: blocking ? PLAN_KIND_LABEL.blocking : PLAN_KIND_LABEL.advisory,
      label: PLAN_WARNING_LABEL[w.code] ?? w.code,
      hint: PLAN_WARNING_HINT[w.code] ?? '',
      where: warningWhere(w),
      sourceStart: w.sourceStart,
      sourceEnd: w.sourceEnd,
      ...(w.tag ? { tag: w.tag } : {}),
    }
  })
}

/**
 * 앞으로 지시가 들어올 자리. 지금은 문법에 없어 **언제나 비어 있다.**
 *
 * 화면에 이름만 두는 이유는, 사용자가 "이건 아직 안 되는 것" 을 알 수 있어야 하고
 * 계획에 그 축이 실제로 선언돼 있기 때문이다. 없는 값을 채워 보여 주지 않는다.
 */
export const RESERVED_AXIS_LABELS: { axis: ReservedAxis; label: string }[] = [
  { axis: 'prosody', label: '표현 세기' },
  { axis: 'actions', label: '행동' },
  { axis: 'ambience', label: '환경음' },
  { axis: 'music', label: '음악' },
  { axis: 'spatial', label: '거리·공간' },
]

export const RESERVED_AXIS_NOTE = '아직 대본 문법에 없습니다. 다음 단계에서 들어옵니다.'

/** 계획이 근사인가 — 구조화 오류로 원문 줄로 물러난 상태. */
export function planIsApproximate(r: AnalysisResult | null): boolean {
  return !!r && !r.plan.parserAuthority
}

export const PLAN_APPROXIMATE_NOTE =
  '표기를 해석하지 못해 줄 단위로 계산했습니다. 위치와 예상값이 근사입니다.'

/**
 * 화면에 보여 줄 화자 목록.
 *
 * 표시 이름은 사용자가 쓴 그대로이고, 개수는 계획의 발화 행에서 이미 세어져 온다 —
 * 화면이 다시 세지 않는다.
 *
 * 참조 준비 상태는 여기서 만들지 않는다. v1.4 PHASE 2 에는 화자별 참조 지정이 아직 없고,
 * 모든 화자가 기본 참조를 쓴다. 없는 상태를 지어내지 않기 위해 그 사실만 문구로 말한다.
 */
export function speakerRows(r: AnalysisResult | null): {
  index: number
  speakerId: string
  label: string
  utteranceCount: number
  sourceStart: number
}[] {
  if (!r) return []
  return r.plan.speakers.map((s) => ({
    index: s.index,
    speakerId: s.speakerId,
    label: s.label,
    utteranceCount: s.utteranceCount,
    sourceStart: s.sourceStart,
  }))
}

/** 기본 화자로 말하는 발화 수. 화자를 지정하지 않은 말이 얼마나 있는지. */
export function defaultSpeakerUtteranceCount(r: AnalysisResult | null): number {
  if (!r) return 0
  return r.plan.utterances.filter((u) => u.speakerId === null).length
}

export const SPEAKER_REFERENCE_NOTE =
  '모든 화자가 지금은 기본 참조를 씁니다. 화자별 참조 지정은 다음 단계에서 들어옵니다.'

export const DEFAULT_SPEAKER_LABEL = '지정 없음(기본 참조)'

/** 어느 목소리가 쓰이는가 — 규칙 이름을 사용자 말로. */
export const REFERENCE_SOURCE_LABEL: Record<ReferenceSource, string> = {
  speaker_emotion: '이 인물의 감정별 목소리',
  speaker: '이 인물의 목소리',
  emotion: '감정별 목소리',
  default: '기본 목소리',
}

/** 막힌 이유를 사용자 말로. 내부 코드를 화면에 쓰지 않는다. */
export const SPEAKER_BLOCK_LABEL: Record<SpeakerReferenceFailure, string> = {
  SPEAKER_NOT_REGISTERED: '목소리를 지정하지 않았습니다',
  SPEAKER_REFERENCE_NOT_READY: '목소리 준비가 끝나지 않았습니다',
  DEFAULT_REFERENCE_MISSING: '기본 목소리가 없습니다',
}

export function referenceDecisionText(d: ReferenceDecision): string {
  return d.ok ? REFERENCE_SOURCE_LABEL[d.source] : SPEAKER_BLOCK_LABEL[d.code]
}

/**
 * 감정 참조 선택을 사용자 말로.
 *
 * 여기서 절대 하지 않는 말: "감정 음률 적용 완료". 이 단계에서 일어난 일은 **참조를
 * 골랐다**까지이고, 모델에 감정 곡선을 넘긴 것이 아니다. 고른 것을 적용했다고 적으면
 * 사용자는 들리지 않는 변화를 기다리게 된다.
 */
export const EMOTION_MATCH_LABEL: Record<EmotionMatchState, string> = {
  reference_matched: '감정에 맞는 참조 선택',
  insufficient_candidates: '감정 참조 자료 부족',
  no_reliable_candidate: '감정 참조 자료 부족',
  no_target_profile: '감정 참조 자료 부족',
  unsupported: '',
}

/** 왜 자료가 부족한가 — 상세 정보에만 쓴다. */
export const EMOTION_MATCH_DETAIL: Record<EmotionMatchState, string> = {
  reference_matched: '요청한 감정과 가장 가까운 이 인물의 참조를 골랐습니다.',
  insufficient_candidates: '이 인물의 참조가 하나뿐이라 고를 여지가 없습니다.',
  no_reliable_candidate: '이 인물의 참조 중 요청한 감정에 가까운 것이 없습니다.',
  no_target_profile: '요청한 감정의 기준이 될 참조가 없습니다.',
  unsupported: '이 발화에는 감정 참조 선택이 쓰이지 않습니다.',
}

/** 지금 모델의 한계. 상세 정보에만 쓴다(기본 화면을 경고로 채우지 않는다). */
export const MODEL_EMOTION_CONTROL_NOTE =
  '현재 모델은 감정 곡선 직접 제어를 지원하지 않음'

/** 기본 화면에 나갈 한 줄. 빈 문자열이면 아무것도 그리지 않는다. */
export function emotionMatchText(e: EmotionMatchView | null | undefined): string {
  if (!e) return ''
  return EMOTION_MATCH_LABEL[e.state]
}

/**
 * 상세 정보에 나갈 줄들. 점수·유사도 같은 내부 숫자는 **여기에만** 온다.
 *
 * 모델이 감정 곡선을 직접 받지 못한다는 사실은 상태와 무관하게 늘 적는다 — 참조를 잘
 * 골랐다는 말만 보면 음률까지 옮겨진 것으로 읽히기 때문이다.
 */
export function emotionMatchDetailLines(e: EmotionMatchView | null | undefined): string[] {
  if (!e) return []
  const out = [EMOTION_MATCH_DETAIL[e.state]]
  if (e.candidatesConsidered > 0) out.push(`후보 ${e.candidatesConsidered}개를 비교했습니다.`)
  if (e.score != null) out.push(`일치도 ${e.score.toFixed(2)} (기준 ${e.minScore.toFixed(2)})`)
  if (e.runnerUpScore != null) out.push(`다음 후보 ${e.runnerUpScore.toFixed(2)}`)
  for (const [axis, value] of Object.entries(e.axisScores ?? {})) {
    out.push(`${EMOTION_AXIS_LABEL[axis] ?? axis} ${value.toFixed(2)}`)
  }
  out.push(MODEL_EMOTION_CONTROL_NOTE)
  return out.filter((line) => line.length > 0)
}

/** 축 이름을 사용자 말로. 내부 축 이름을 화면에 그대로 쓰지 않는다. */
export const EMOTION_AXIS_LABEL: Record<string, string> = {
  relative_f0: '억양 높낮이',
  relative_energy: '세기 강약',
  rhythm: '말 빠르기',
  pause_tail: '쉼과 말끝',
  trajectory: '전체 흐름',
}
