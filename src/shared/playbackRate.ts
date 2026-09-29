// **만들어진 소리의 재생 빠르기** — 값의 뜻과 보관 열쇠를 한곳에서 정한다.
//
// ★지시 (2026-09-30): "만들어진 소리에서 배속을 빠르게 하거나 느리게 하는 기능이 필요하다.
//   일부러 만들 때 배속을 빠르게 한 게 아닌, 만들어진 것의 속도를 조절하는 기능이다."
//   → 다시 만들지 않는다. 재생할 때만 빠르기를 바꾸고, **음 높이는 그대로** 둔다(목소리가 가늘어지지 않게).
//
// ★걸리는 곳은 **만들어진 소리**뿐이다 — 낭독·들어 보기·생성 카드의 생성본과 최종 음성·더빙 결과.
//   참조 구간 미리듣기나 분리한 트랙 같은 **원본 소리**에는 걸지 않는다(구간을 고를 때 빨라지면 헷갈린다).
//   실제로 요소에 거는 일은 renderer/lib/playbackVolume 이 한다(모든 소리 요소의 단일 소유자).

/** 설정 파일에서 이 값을 담는 열쇠. main 의 허용 목록과 renderer 가 같은 이름을 쓴다. */
export const PLAYBACK_RATE_STORAGE_KEY = 'playbackRate'

/** 고를 수 있는 빠르기. 오디오북 앱들의 흔한 단계. */
export const PLAYBACK_RATES: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** 보관된 값이 없을 때 — 만든 그대로. */
export const PLAYBACK_RATE_DEFAULT = 1

/**
 * 무엇이 들어와도 고를 수 있는 단계 중 하나로 만든다.
 * ★설정 파일은 사람이 고칠 수 있다 — 이상한 값(NaN · 0 · 16)이 요소에 들어가면 브라우저가 예외를 던지거나
 *   소리가 사라진다. 알 수 없는 값은 기본으로, 범위 안의 값은 가장 가까운 단계로.
 */
export function normalizePlaybackRate(v: unknown): number {
  if (v === null || v === undefined) return PLAYBACK_RATE_DEFAULT
  if (typeof v === 'string' && v.trim() === '') return PLAYBACK_RATE_DEFAULT
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return PLAYBACK_RATE_DEFAULT
  let best = PLAYBACK_RATES[0]
  for (const r of PLAYBACK_RATES) if (Math.abs(r - n) < Math.abs(best - n)) best = r
  return best
}

/** 화면에 보여 줄 글 — "1.25×". */
export function playbackRateLabel(v: unknown): string {
  const r = normalizePlaybackRate(v)
  return `${Number.isInteger(r) ? r.toFixed(1) : String(r)}×`
}
