/**
 * 진단 묶음 내보내기 — main ↔ renderer 가 함께 보는 응답 모양.
 * 경로는 오가지 않는다. 묶음 폴더 **이름**과 로그 개수만 돌아온다.
 *
 * ★그 약속이 산문으로만 있었다(2026-09-24 2차 감사)
 *   예전 모양은 `message?: string` 이었고, 실패 경로가 거기에 fs 오류 **원문**을 실었다.
 *   `EACCES … mkdir '<사용자 홈 전체 경로>/AudioForge_진단_…'` 이 그대로 화면에 뜨고
 *   로그에 적히고 **다음 진단 묶음에 복사됐다.** 타입이 허락하니 아무도 막지 않았다.
 *
 *   그래서 자유 문구를 없애고 **짧은 코드**만 오가게 한다. 코드는 대문자·밑줄만
 *   허용하므로 경로가 들어갈 수 없다 — 규칙을 컴파일러와 검사가 함께 지킨다.
 */
export const EXPORT_DIAGNOSTICS_CHANNEL = 'app:export-diagnostics'

/** 실패 코드 모양 — 대문자·숫자·밑줄 2~32자. 경로가 들어갈 수 없는 모양이다. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,31}$/

export type ExportDiagnosticsResult =
  | { ok: true; name: string; logCount: number }
  | { ok: false; reason: 'cancelled' | 'failed'; code?: string }

/**
 * 오류에서 **코드만** 뽑는다. 모양에 안 맞으면 버리고 `UNKNOWN`.
 * 이 함수를 거치지 않은 값이 응답에 실리지 않게 하는 것이 핵심이다.
 */
export function diagnosticsFailureCode(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' && CODE_SHAPE.test(c) ? c : 'UNKNOWN'
}

/** 코드를 사용자 문구로. 모르는 코드도 숨기지 않는다 — 코드 자체는 경로가 아니다. */
export function exportDiagnosticsText(code?: string): string {
  switch (code) {
    case 'BUNDLE_EXISTS':
      return '같은 이름의 진단 묶음이 이미 있습니다. 잠시 뒤 다시 시도하세요.'
    case 'EACCES':
    case 'EPERM':
      return '고른 폴더에 쓸 수 없습니다. 다른 폴더를 골라 주세요.'
    case 'ENOSPC':
      return '디스크 공간이 모자랍니다.'
    case 'ENOENT':
      return '고른 폴더를 찾을 수 없습니다.'
    default:
      return `진단 묶음을 만들지 못했습니다(${code || 'UNKNOWN'}).`
  }
}
