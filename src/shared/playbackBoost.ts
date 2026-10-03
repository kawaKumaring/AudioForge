/** 재생할 때만 적용하는 배율. 원본과 기존 음량 저장 형식은 바꾸지 않는다. */
export const PLAYBACK_BOOST_STORAGE_KEY = 'playbackBoost'
export function normalizePlaybackBoost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(3, value)) : 1
}
