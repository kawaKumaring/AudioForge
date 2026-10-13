/** 자동 저장이 대체한 옛 기록. 시각만 바뀐 저장은 중복 보관하지 않는다. */
export const LEGACY_HISTORY_KEY = 'legacyWorkHistory'
export type LegacyHistoryEntry = { kind: 'lab' | 'draft'; sourceKey: string; data: unknown }
export function legacyContent(value: unknown): string {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['updatedAt','savedAt'].includes(k)).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,clean(x)]))
    return v
  }
  return JSON.stringify(clean(value))
}
