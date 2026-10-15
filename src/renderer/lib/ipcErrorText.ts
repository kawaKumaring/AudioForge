/**
 * IPC 오류의 영어 앞머리를 뗀다 — 화면에는 본체가 말한 사유만.
 *
 * Electron 의 invoke 가 거부되면 메시지 앞에 "Error invoking remote method '<채널>': Error: " 가 붙는다.
 * 본체는 한국어 사유를 던지는데, 이 앞머리 때문에 화면에 영어가 섞이고 사유 코드로 시작하는지
 * 보는 검사(예: /^SPEAKER_/)가 빗나간다(2026-10-16 점검).
 */
export function stripIpcErrorPrefix(raw: unknown): string {
  return String(raw ?? '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
}
