/**
 * 설정 저장의 **응답을 버리지 않는** 단일 통로.
 *
 * ★왜 있는가(2026-09-24 감사)
 *   `window.api.settings.set` 은 실패를 예외로 던지지 않고 `{ok:false, code}` 를
 *   **돌려준다**. 그래서 `void ...set(...)` 로 부르면 실패가 통째로 사라진다.
 *
 *   설정 파일이 한 번 깨지면(`SETTINGS_CORRUPT`) 그때부터 모든 쓰기가 거부되는데,
 *   작업실 회차·채택·대사 수정·전사 교정이 **하나도 저장되지 않고 화면은 아무 말도 안 한다.**
 *   앱을 닫는 순간 전부 잃는다.
 *
 *   같은 사고를 2026-09-09 에 한 번 겪고 `useWorkDraft` 에서 고쳤는데
 *   **세 곳이 그대로 남아 있었다.** 그래서 고치는 김에 통로를 하나로 모은다 —
 *   부르는 자리가 여럿이면 다음에 또 한 곳이 남는다.
 *
 *   `src/shared/noVoidSettingsSet.test.ts` 가 `void ...settings.set(` 표기를 금지해
 *   같은 것이 다시 들어오지 못하게 막는다.
 */

/** 저장 결과. 성공이면 null, 실패면 사유 코드. */
export type SaveFailure = string | null

type SettingsSetter = (key: string, value: unknown) => Promise<unknown>

/**
 * 저장하고 **실패 사유를 돌려준다.**
 *
 * 성공이면 null. 실패면 코드 문구(화면이 그대로 보여 줘도 되는 짧은 것).
 * 던지지 않는다 — 저장 실패가 화면을 통째로 무너뜨리면 안 된다.
 * 다만 **조용히 넘기지도 않는다**: 부르는 쪽이 반드시 결과를 받는다.
 */
export async function saveSetting(
  set: SettingsSetter,
  key: string,
  value: unknown,
): Promise<SaveFailure> {
  try {
    const r = (await set(key, value)) as { ok?: boolean; code?: string } | undefined
    if (r && r.ok === false) return r.code || 'SAVE_FAILED'
    return null
  } catch (e) {
    return (e as Error)?.message || 'SAVE_FAILED'
  }
}

/** 사용자에게 보일 한 줄. 코드가 무엇이든 **무엇을 잃는지**를 먼저 말한다. */
export function saveFailureText(code: SaveFailure): string {
  if (!code) return ''
  const why = code === 'SETTINGS_CORRUPT'
    ? '설정 파일이 손상돼 있습니다'
    : code === 'SETTINGS_WRITE_FAILED'
      ? '설정 파일에 쓰지 못했습니다'
      : `저장에 실패했습니다(${code})`
  return `${why} — 지금 고친 내용이 저장되지 않았습니다. 앱을 닫으면 사라집니다.`
}
