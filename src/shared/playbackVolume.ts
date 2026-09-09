// 미리듣기·결과 재생의 **음량** 계약 — 값의 해석과 보관 열쇠를 한곳에서 정한다.
//
// 왜 필요한가(2026-09-10 사용자 보고): 이 앱에는 재생 음량을 다루는 코드가 아예 없었다.
// 네 곳(참조 구간 미리듣기 · 결과 트랙 · 목소리 미리듣기 · 감정 표본)이 모두 요소 기본값
// 1.0(최대)으로 나갔고, 사용자가 낮출 수단도 기억할 자리도 없었다.
//
// 이 파일이 정하는 것은 **값의 뜻**뿐이다. 실제 적용(요소에 걸기)은 renderer/lib 이,
// 보관은 설정 파일이 맡는다. 규칙을 세 곳에 나눠 쓰지 않기 위해 여기 하나로 둔다.

/** 설정 파일에서 이 값을 담는 열쇠. main 의 허용 목록과 renderer 가 같은 이름을 쓴다. */
export const PLAYBACK_VOLUME_STORAGE_KEY = 'playbackVolume'

/** 보관된 값이 없을 때. 예전 동작과 같다(최대) — 조용히 낮춰 놓지 않는다. */
export const PLAYBACK_VOLUME_DEFAULT = 1

/**
 * 무엇이 들어와도 0~1 사이의 유한한 수로 만든다.
 *
 * 왜 이렇게 방어적인가: 이 값은 설정 파일(사람이 고칠 수 있다)과 슬라이더(문자열)에서 온다.
 * NaN 이 요소의 volume 에 들어가면 브라우저가 예외를 던져 **재생 자체가 죽는다** —
 * 음량 하나 때문에 소리를 못 듣는 일이 되면 안 된다. 알 수 없는 값은 기본값으로 되돌린다.
 */
export function normalizePlaybackVolume(v: unknown): number {
  // 빈 값은 "0" 이 아니라 "모른다" 다 — Number('') 는 0 이므로 그대로 두면 소리가 조용히 꺼진다.
  // 보관 파일에 빈 값이 남아 있을 때 사용자는 앱이 고장 난 줄 안다(실측 확인, 2026-09-10).
  // null 도 같다 — Number(null) 은 0 이다. undefined 만 NaN 이 되어 걸러지므로 둘을 함께 막는다.
  if (v === null || v === undefined) return PLAYBACK_VOLUME_DEFAULT
  if (typeof v === 'string' && v.trim() === '') return PLAYBACK_VOLUME_DEFAULT
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return PLAYBACK_VOLUME_DEFAULT
  if (n <= 0) return 0
  if (n >= 1) return 1
  return n
}

/** 화면에 보여 줄 백분율(정수). 0~100. */
export function playbackVolumePercent(v: unknown): number {
  return Math.round(normalizePlaybackVolume(v) * 100)
}
