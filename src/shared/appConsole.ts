/**
 * 콘솔 창 — **동작 기록을 사용자가 보고 복사하는 창**.
 *
 * ★지시 (2026-09-30): "작동 동작 관련 콘솔 창을 복사해서 붙여 넣으면 문제를 찾는 게 수월할 것 같다.
 *   설정 내부에 콘솔 팝업 활성화 기능. 콘솔 팝업을 활성화하지 않더라도 동작 관련 내용은
 *   콘솔에 기록이 되어 있어야 한다."
 *
 * ★창을 켜든 끄든 **기록은 늘 남는다** — 앱 로그 파일(logs/)이 권위다. 창은 그 최근 줄을 보여 줄 뿐이다.
 * ★기록에는 **글 내용·폴더 경로가 들어가지 않는다.** 복사해 건네도 되는 것만 적는다.
 */

/** 설정 파일의 열쇠 — 콘솔 창을 띄워 둘지. */
export const CONSOLE_POPUP_STORAGE_KEY = 'consolePopup'

/** 창이 들고 있는 최근 줄 수. 넘으면 오래된 것부터 버린다(파일에는 그대로 남는다). */
export const CONSOLE_RECENT_MAX = 1500

/** 화면이 보내는 한 줄의 길이 상한 — 긴 글이 통째로 들어가지 않게. */
export const CONSOLE_MESSAGE_MAX = 500

export function parseConsolePopup(raw: unknown): boolean {
  return raw === true
}

/** 화면이 붙이는 꼬리표 — `ui:` 로 시작해 본체 기록과 구분된다. 영문·숫자·빼기만. */
export function uiTag(tag: unknown): string {
  const t = String(tag ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24)
  return `ui:${t || 'screen'}`
}

/** 화면이 보내는 수준 — 모르는 값은 INFO. */
export function uiLevel(level: unknown): 'INFO' | 'WARN' | 'ERROR' {
  return level === 'WARN' || level === 'ERROR' ? level : 'INFO'
}
