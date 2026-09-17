/**
 * 진단 묶음 내보내기 — main ↔ renderer 가 함께 보는 응답 모양.
 * 경로는 오가지 않는다. 묶음 폴더 **이름**과 로그 개수만 돌아온다.
 */
export const EXPORT_DIAGNOSTICS_CHANNEL = 'app:export-diagnostics'

export type ExportDiagnosticsResult =
  | { ok: true; name: string; logCount: number }
  | { ok: false; reason: 'cancelled' | 'failed'; message?: string }
