// 프로세스 종료 시 UI가 'processing'에 남지 않도록 '정착(settlement)'을 추적한다.
//
// result / error / watchdog 중 하나로 정착되면 done에서 추가 오류를 내지 않고,
// 아무 것도 없이 done이 오면(외부 kill·코드 0 무결과 등) 오류로 마감해 렌더러가 반드시
// 종료 상태로 전이하게 한다. 중복 오류 전송을 막는다.
//
// audio.ipc.ts의 러너 이벤트 핸들러가 이 가드를 그대로 사용한다(핸들러는 한 줄 위임).

export interface SettlementGuard {
  /** result/error/watchdog 핸들러가 자체 처리(전송/취소) 후 호출 — 정착 표시. */
  markSettled(): void
  /** done에서 호출 — 아직 정착 안 됐으면 '완료 신호 없음' 오류로 마감. */
  finish(code: number | null): void
  readonly settled: boolean
}

export function createSettlementGuard(sendError: (message: string) => void): SettlementGuard {
  let settled = false
  return {
    markSettled() {
      settled = true
    },
    finish(code: number | null) {
      if (!settled) {
        settled = true
        sendError(`처리가 완료 신호 없이 종료되었습니다 (종료 코드 ${code}).`)
      }
    },
    get settled() {
      return settled
    }
  }
}
