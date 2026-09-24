// 더빙이 화면과 main 사이에서 주고받는 것들.
//
// 여기에는 **판단이 없다** — 자리 계산은 python/dub_timing.py 가, 순서와 이어 하기는
// python/dub_pipeline.py 가 소유한다. 이 파일은 그 결과를 사람이 읽을 글자로 바꾸기만 한다.
// 같은 규칙이 두 곳에 있으면 언젠가 갈라진다.

/** 앞단 네 단계. python/dub_pipeline.py 의 STAGES 와 이름이 같아야 한다. */
export type DubStage = 'audio' | 'separate' | 'transcribe' | 'translate'

export const DUB_STAGES: readonly DubStage[] = ['audio', 'separate', 'transcribe', 'translate']

export const DUB_STAGE_LABELS: Record<DubStage, string> = {
  audio: '소리 꺼내기',
  separate: '보컬 갈라내기',
  transcribe: '알아듣기',
  translate: '번역',
}

/** 한 줄이 자리에 어떻게 들어갔는가. python/dub_timing.py 의 status 와 같다. */
export type DubFitStatus = 'fit' | 'stretched' | 'over'

/** 아직 소리를 만들지 않은 줄까지 포함한 화면용 상태. */
export type DubLineState = DubFitStatus | 'pending'

export interface DubLine {
  index: number
  /** 원본에서 이 대사가 있던 자리(초). */
  start: number
  end: number
  /** 알아들은 원문. */
  source: string
  /** 한국어. 사용자가 고칠 수 있다. */
  korean: string
}

/** 줄마다 만든 소리와 그 결과. 내보내기를 한 뒤에 채워진다. */
export interface DubLineResult {
  index: number
  status: DubFitStatus
  ratio: number
  overflowSec: number
  placeStart: number
  borrowedBeforeSec: number
  borrowedAfterSec: number
  pushedSec: number
  reason: string
  loudnessMatched: boolean
  loudnessNote: string
}

export interface DubFrontResult {
  outDir: string
  language: string
  lines: DubLine[]
  /** 번역이 비어 있는 줄. 조용히 넘기지 않는다. */
  emptyIndexes: number[]
  /** 이번에 실제로 돈 단계. 비어 있으면 **할 일이 없었다**는 뜻이다. */
  ran?: DubStage[]
  /** 지난 결과를 그대로 쓴 단계. */
  skipped?: DubStage[]
}

/**
 * 앞단을 돌린 뒤 사람에게 할 말.
 *
 * ★왜 있는가(2026-09-20 사용자 신고): 네 단계가 이미 끝나 있으면 '이어서 하기' 는 아무것도
 *   하지 않고 즉시 끝난다. 그게 맞는 동작인데 화면이 아무 말도 안 해서 **멈춘 것처럼 보였다.**
 *   할 일이 없었다는 것도 결과다 - 말해 준다.
 */
export function dubFrontSummary(ran: DubStage[], skipped: DubStage[]): string {
  if (ran.length === 0 && skipped.length > 0) {
    return '네 단계가 이미 끝나 있어 다시 할 것이 없었습니다. 다음은 목소리를 고르고 줄 소리를 만드는 일입니다.'
  }
  if (ran.length === 0) return '아직 아무 단계도 끝나지 않았습니다.'
  const did = ran.map((s) => DUB_STAGE_LABELS[s]).join(' · ')
  if (skipped.length === 0) return `끝났습니다 — ${did}`
  const kept = skipped.map((s) => DUB_STAGE_LABELS[s]).join(' · ')
  return `끝났습니다 — ${did} (지난 결과를 쓴 단계: ${kept})`
}

export interface DubRenderSummary {
  total: number
  fit: number
  stretched: number
  over: number
  overIndexes: number[]
  missingIndexes: number[]
  worstOverflowSec: number
  maxRatioUsed: number
  trimmed: number
}

export interface DubRenderResult {
  video: string
  srt: string
  summary: DubRenderSummary
  lines: DubLineResult[]
}

/** 사람이 읽는 상태 글자. 기획서의 셋(맞음 / 늘여서 맞춤 / 안 맞음)을 그대로 쓴다. */
export function dubStatusLabel(state: DubLineState, opts?: { ratio?: number; overflowSec?: number }): string {
  switch (state) {
    case 'fit':
      return '맞음'
    case 'stretched':
      return opts?.ratio ? `늘여서 맞춤 (${opts.ratio.toFixed(2)}배)` : '늘여서 맞춤'
    case 'over':
      return opts?.overflowSec ? `안 맞음 (${opts.overflowSec.toFixed(1)}초 넘침)` : '안 맞음'
    default:
      return '아직 안 만듦'
  }
}

/** 상태마다 쓸 색. 화면 세 곳에서 같은 색을 써야 해서 한 곳에 둔다. */
export function dubStatusColor(state: DubLineState): string {
  switch (state) {
    case 'fit':
      return 'var(--emerald)'
    case 'stretched':
      return 'var(--amber)'
    case 'over':
      return 'var(--rose)'
    default:
      return 'var(--text-muted)'
  }
}

import { formatMinSec } from './timeFormat.ts'
/** 시각을 화면에 쓰는 글자로. 0:03.2 처럼. */
// ★계산은 shared/timeFormat 한 곳이 소유한다(2026-09-24 2차 감사).
//   여기 있던 공식은 분을 먼저 확정해 **자리올림이 분으로 전파되지 않았다** —
//   59.96초가 0:60.0 으로 보였다. 같은 계산을 네 곳에 두지 않는다.
export function dubTimeLabel(sec: number): string {
  return formatMinSec(sec)
}

/**
 * 줄마다 무엇을 해야 하는지 한 줄로. 목록 위에 띄운다.
 *
 * 순서가 중요하다 — 사용자가 **먼저 할 일**을 먼저 말한다.
 * 번역이 비어 있으면 소리를 만들 수 없고, 소리가 없으면 자리를 맞출 수 없다.
 */
export function dubNextAction(opts: {
  lines: number
  empty: number
  missing: number
  over: number
}): string {
  if (opts.lines === 0) return '아직 줄이 없습니다. 영상을 넣고 시작하세요.'
  if (opts.empty > 0) return `번역이 비어 있는 줄이 ${opts.empty}개입니다 — 먼저 채우세요.`
  if (opts.missing > 0) return `소리를 만들지 않은 줄이 ${opts.missing}개입니다.`
  if (opts.over > 0) return `자리에 안 맞는 줄이 ${opts.over}개입니다 — 번역문을 줄이고 그 줄만 다시 만드세요.`
  return '모두 자리에 들어갔습니다. 영상을 만들 수 있습니다.'
}
