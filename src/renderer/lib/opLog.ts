/**
 * 화면의 **동작 기록** — 앱 로그에 한 줄 남긴다(콘솔 창을 켜지 않아도 남는다).
 *
 * ★글 내용(책·대사)을 넣지 않는다. 글자 수·파일 이름·상태만 적는다 —
 *   사용자가 콘솔을 복사해 건네도 되는 기록이어야 한다. 본체도 경로를 한 번 더 씻는다.
 * ★기록이 실패해도 동작은 멈추지 않는다.
 */
export function opLog(tag: string, message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
  try {
    void window.api.logs.write(level, tag, message).catch(() => { /* 기록 실패가 동작을 막지 않는다 */ })
  } catch { /* 통로가 없는 검사 환경 */ }
}

/** 파일 경로에서 이름만. */
export function nameOnly(p: string | null | undefined): string {
  return String(p || '').split(/[\\/]/).pop() || '(없음)'
}
