// 실행(run) 생명주기 공용 원시 — 프로세스 종료 시 UI가 'processing'에 남지 않도록 '정착(settlement)'을
// 추적하고, 러너 소유권(늦은 해제로 새 실행을 지우는 clobber)을 막는다.
//
// result / error / watchdog 중 하나로 정착되면 done에서 추가 오류를 내지 않고,
// 아무 것도 없이 done이 오면(외부 kill·코드 0 무결과 등) 오류로 마감해 렌더러가 반드시
// 종료 상태로 전이하게 한다. 중복 오류 전송을 막는다.
//
// audio.ipc.ts의 러너 이벤트 핸들러가 이 가드를 그대로 사용한다(핸들러는 한 줄 위임).
//
// 구성 — 아래 넷은 모두 '같은 하나의 정착 상태기계' 위에 얹는다(병렬 상태기계 금지):
//   createTerminalGate    : '정확히 한 번만 종료 결과' 원시. 아래 둘의 공통 기반.
//   createSettlementGuard : 메인 러너용 기존 API(동작·문구 변경 없음).
//   createRunSettlement   : 메인/트랙 러너 공용 — 터미널 종류(result/error/cancelled)까지 표현.
//   createRunnerSlot      : thisRunner === current 신원 가드(늦은 done이 새 실행을 free로 만들지 못하게).

// ────────────────────────────────────────────────────────────────────────────
// 0) 공용 원시 — 정확히 한 번만 정착
// ────────────────────────────────────────────────────────────────────────────

export interface TerminalGate<T> {
  /** 종료 결과로 정착시키고 emit. 이번 호출이 '최초 정착 승자'면 true, 이미 정착됐으면 false(무시). */
  settle(outcome: T): boolean
  /** emit 없이 정착만 표시(호출부가 이미 자체 전송/취소를 처리한 경우). 최초면 true. */
  markSettled(): boolean
  readonly settled: boolean
}

/** 어떤 실행이든 종료 결과를 '정확히 한 번'만 낸다. 두 번째 시도는 조용히 무시된다. */
export function createTerminalGate<T>(emit: (outcome: T) => void): TerminalGate<T> {
  let settled = false
  return {
    settle(outcome: T): boolean {
      if (settled) return false
      settled = true   // emit 안에서의 재진입도 차단하도록 먼저 세운다
      emit(outcome)
      return true
    },
    markSettled(): boolean {
      if (settled) return false
      settled = true
      return true
    },
    get settled() {
      return settled
    }
  }
}

/** '완료 신호 없이 종료' 문구 — 기존 가드와 신규 터미널 매핑이 같은 문구를 쓴다. */
function noTerminalSignalMessage(code: number | null): string {
  return `처리가 완료 신호 없이 종료되었습니다 (종료 코드 ${code}).`
}

// ────────────────────────────────────────────────────────────────────────────
// 1) 기존 API — 메인 러너용(동작 동일, 내부만 게이트 위로 이전)
// ────────────────────────────────────────────────────────────────────────────

export interface SettlementGuard {
  /** result/error/watchdog 핸들러가 자체 처리(전송/취소) 후 호출 — 정착 표시. */
  markSettled(): void
  /** done에서 호출 — 아직 정착 안 됐으면 '완료 신호 없음' 오류로 마감. */
  finish(code: number | null): void
  readonly settled: boolean
}

export function createSettlementGuard(sendError: (message: string) => void): SettlementGuard {
  const gate = createTerminalGate<string | null>((message) => {
    if (message !== null) sendError(message)
  })
  return {
    markSettled() {
      gate.markSettled()
    },
    finish(code: number | null) {
      gate.settle(noTerminalSignalMessage(code))
    },
    get settled() {
      return gate.settled
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 2) 실행 종료 사유 어휘 — 러너 → 소유자 (구조화 코드만. 자유 문자열이 경계를 넘지 않는다)
// ────────────────────────────────────────────────────────────────────────────

/** 자식 프로세스가 '어떻게' 끝났는가. python-runner가 done의 2번째 인자로 싣는다. */
export type RunEndReasonCode =
  | 'exit-ok'            // 코드 0 정상 종료
  | 'exit-nonzero'       // 코드 != 0 종료
  | 'signal'             // 코드 null — 우리가 요청하지 않은 신호 종료(외부 kill 등)
  | 'killed'             // 우리의 cancel() 요청으로 종료(취소/watchdog)
  | 'spawn-error-sync'   // spawn() 호출 자체가 throw
  | 'spawn-error-async'  // child 'error' 이벤트(실행파일 없음 등)

/** 비민감 종료 사실만 담는다 — 경로·명령줄·전사·오디오 금지. */
export interface RunEnd {
  reasonCode: RunEndReasonCode
  code: number | null
  signal: string | null
  /** 우리가 cancel()로 끝냈는가 — 소유자가 cancelled vs error를 가르는 근거. */
  killedByUs: boolean
}

/** 소유자가 렌더러로 내보내는 최종 상태의 사유(구조화). */
export type TerminalReasonCode =
  | 'result'                // 정상 결과 수신
  | 'error-reported'        // 러너/Python이 오류를 명시적으로 보고
  | 'cancelled-by-request'  // 우리의 취소 요청으로 종료
  | 'no-terminal-signal'    // 코드 0인데 result가 없었음
  | 'exit-nonzero'          // 비정상 종료 코드
  | 'signal-terminated'     // 신호로 죽음(우리 요청 아님)
  | 'spawn-failed'          // 프로세스를 띄우지 못함
  | 'timeout'               // watchdog 초과

export interface RunTerminal {
  kind: 'result' | 'error' | 'cancelled'
  reasonCode: TerminalReasonCode
  /** kind==='error'일 때 렌더러 표시 문구(비민감 — 경로·전사·명령줄 금지). */
  message?: string
  /** kind==='result'일 때 러너가 준 결과 payload 그대로. */
  data?: unknown
}

/**
 * 프로세스 종료 사실 → 소유자가 보낼 터미널. 순수 함수(부수효과 없음).
 * killed만 cancelled로, 나머지는 모두 error로 마감한다 — 무신호 idle(고착) 경로를 남기지 않는다.
 */
export function terminalForEnd(end: RunEnd): RunTerminal {
  switch (end.reasonCode) {
    case 'killed':
      return { kind: 'cancelled', reasonCode: 'cancelled-by-request' }
    case 'signal':
      return {
        kind: 'error',
        reasonCode: 'signal-terminated',
        message: '처리가 외부에서 강제 종료되었습니다.'
      }
    case 'exit-nonzero':
      return {
        kind: 'error',
        reasonCode: 'exit-nonzero',
        message: `처리가 오류로 종료되었습니다 (종료 코드 ${end.code}).`
      }
    case 'spawn-error-sync':
    case 'spawn-error-async':
      return {
        kind: 'error',
        reasonCode: 'spawn-failed',
        message: 'Python 프로세스를 실행하지 못했습니다.'
      }
    case 'exit-ok':
    default:
      return {
        kind: 'error',
        reasonCode: 'no-terminal-signal',
        message: noTerminalSignalMessage(end.code)
      }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3) 메인/트랙 러너 공용 정착 — 터미널 종류까지 표현
// ────────────────────────────────────────────────────────────────────────────

export interface RunSettlement {
  /** result 수신 — 최초 정착이면 true(전송됨). */
  settleResult(data: unknown): boolean
  /** 오류 수신 — 최초 정착이면 true. reasonCode 기본값은 error-reported(watchdog은 timeout). */
  settleError(message: string, reasonCode?: TerminalReasonCode): boolean
  /** 취소 요청으로 마감 — 최초 정착이면 true. */
  settleCancelled(reasonCode?: TerminalReasonCode): boolean
  /** done에서 호출 — 아직 정착 안 됐으면 종료 사실로부터 터미널을 만들어 마감. 마감했으면 true. */
  finishFromEnd(end: RunEnd): boolean
  /** end 정보가 없는 레거시 done(code만) 경로용. */
  finish(code: number | null): boolean
  readonly settled: boolean
}

/**
 * 하나의 실행이 반드시 정확히 하나의 터미널(result | error | cancelled)을 내도록 보장한다.
 * emit은 소유자가 준다(트랙: audio:track-result / audio:track-error).
 */
export function createRunSettlement(emit: (terminal: RunTerminal) => void): RunSettlement {
  const gate = createTerminalGate<RunTerminal>(emit)
  return {
    settleResult(data: unknown) {
      return gate.settle({ kind: 'result', reasonCode: 'result', data })
    },
    settleError(message: string, reasonCode: TerminalReasonCode = 'error-reported') {
      return gate.settle({ kind: 'error', reasonCode, message })
    },
    settleCancelled(reasonCode: TerminalReasonCode = 'cancelled-by-request') {
      return gate.settle({ kind: 'cancelled', reasonCode })
    },
    finishFromEnd(end: RunEnd) {
      return gate.settle(terminalForEnd(end))
    },
    finish(code: number | null) {
      return gate.settle(
        terminalForEnd({
          reasonCode: code === 0 ? 'exit-ok' : code === null ? 'signal' : 'exit-nonzero',
          code,
          signal: null,
          killedByUs: false
        })
      )
    },
    get settled() {
      return gate.settled
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4) 러너 소유권 — 신원 가드(clobber 방지)
// ────────────────────────────────────────────────────────────────────────────

export interface RunnerSlot<T> {
  /** 현재 소유 중인 러너(없으면 null). */
  readonly current: T | null
  /** 새 실행을 현재 러너로 등록하고 그대로 돌려준다. */
  set(runner: T): T
  /** runner가 여전히 현재 러너인가. */
  isCurrent(runner: T | null): boolean
  /**
   * runner가 '아직 현재 러너일 때만' 해제한다 — 취소된 실행 A의 늦은 done이
   * 새로 시작된 실행 B를 free로 만들어(중복 실행 가드·앱 종료 kill 목록에서 탈출) 버리는 것을 막는다.
   * 실제로 해제했으면 true, 이미 남의 실행이면 false(호출부는 아무 것도 정리하면 안 된다).
   */
  release(runner: T): boolean
  /** 신원 무관 강제 해제(reset 등). */
  clear(): void
}

export function createRunnerSlot<T>(): RunnerSlot<T> {
  let current: T | null = null
  return {
    get current() {
      return current
    },
    set(runner: T): T {
      current = runner
      return runner
    },
    isCurrent(runner: T | null): boolean {
      return runner !== null && current === runner
    },
    release(runner: T): boolean {
      if (current !== runner) return false
      current = null
      return true
    },
    clear() {
      current = null
    }
  }
}
