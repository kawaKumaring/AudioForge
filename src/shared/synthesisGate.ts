/**
 * 합성을 시작하기 전에 **무엇이 조용해야 하는가** — 한 곳에 모은 목록.
 *
 * ★왜 모았나(2026-09-24 2차 감사)
 *   이 판정이 `audio.ipc.ts` 안에 if 대여섯 개로 흩어져 있었다. 그래서 파이썬을
 *   새로 돌리는 길이 하나 늘었을 때(감정 미리듣기) **아무도 이 목록을 갱신하지 않았다.**
 *
 *   미리듣기는 제 실행기를 새로 만들어 돌아서 `runner.isRunning` 에 걸리지 않는다.
 *   미리듣기 쪽은 본 작업을 보고 거절하는데 **반대 방향이 없어서**, 미리듣기가 도는
 *   동안 합성을 누르면 파이썬 둘이 같은 GPU 를 동시에 물었다.
 *   **한쪽만 보는 가드는 가드가 아니다.**
 *
 *   목록이 한 곳에 있으면 다음에 실행기가 늘 때 고칠 자리가 하나다. 그리고
 *   `synthesisGate.test.ts` 가 **새 실행기를 목록에 넣었는지** 붙잡는다.
 *
 * 이 파일은 **판정만** 한다 — 정리·대기 같은 곁일은 부르는 쪽이 한다.
 */

/** 지금 무엇이 돌고 있는가. 값은 전부 '도는 중이면 true'. */
export interface RunningState {
  /** 본 합성 실행기 */
  mainRunner: boolean
  /** 참조 전사 미리보기(Whisper) */
  transcriptPreview: boolean
  /** 참조 구간 트림(파생 클립 생성) */
  referenceTrim: boolean
  /** 감정 미리듣기 — **제 실행기를 따로 만든다.** 그래서 mainRunner 로는 안 보인다. */
  samplerPreview: boolean
}

/** 막는 것마다 사용자에게 보일 한 줄. 무엇 때문인지 **작업 이름을 말한다.** */
const REASONS: Array<[keyof RunningState, (what: string) => string]> = [
  ['mainRunner', () => '이미 처리 중인 작업이 있습니다'],
  ['transcriptPreview', (w) => `참조 전사 미리보기 중에는 ${w}을 시작할 수 없습니다.`],
  ['referenceTrim', (w) => `참조 구간 트림 중에는 ${w}을 시작할 수 없습니다.`],
  ['samplerPreview', (w) => `미리듣기를 만드는 중에는 ${w}을 시작할 수 없습니다.`],
]

/** 이 목록이 비면 가드가 통째로 사라진 것이다 — 검사가 그것도 붙잡는다. */
export const GUARDED: ReadonlyArray<keyof RunningState> = REASONS.map(([k]) => k)

/**
 * 막을 사유 한 줄. 막을 것이 없으면 null.
 *
 * `what` 은 시작하려는 일의 이름(`'합성'`, `'트랙 작업'`).
 */
export function blockReason(state: Partial<RunningState>, what = '합성'): string | null {
  for (const [key, text] of REASONS) {
    if (state[key]) return text(what)
  }
  return null
}
