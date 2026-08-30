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
import type { AnalysisResult, Range, SplitReason } from './inputAnalysis'

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
  const parts = [
    audio ? `예상 음성 ${audio}` : null,
    `예상 작업 ${wall}`,
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
  const wallParts = segs.map((s) => s.estimatedWallSeconds)
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
