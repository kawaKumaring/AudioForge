// 한 줄로 세워 차례로 실행하는 차선(lane).
//
// 왜 필요한가: 같은 파이썬 통로를 동시에 두 번 두드리지 않으려고 예전에는 **두 번째 호출을 거절**했다
// (createPreviewGuard.begin() 이 throw). 그런데 거절은 사용자 작업을 실패로 끝낸다 — 기본 목소리 준비와
// 인물 목소리 자동 준비가 겹치는 순간 뒤에 온 쪽이 "목소리 구간을 준비하지 못했습니다"로 끝나고,
// 사용자가 손으로 다시 해야 했다(실측 결함).
//
// 동시에 두드리지 않는다는 목적은 **줄 세우기**로도 똑같이 달성된다. 그래서 이 차선은 거절하지 않고
// 앞 작업이 끝난 뒤 이어서 실행한다. 앞 작업의 성패는 뒤 작업의 실행 여부를 바꾸지 않는다.
//
// running: 이 차선에 대기·실행 중인 작업이 하나라도 있는가. '트림 중에는 합성을 시작할 수 없다' 같은
// 상위 판정이 이 값을 읽는다 — 줄이 비기 전에는 계속 true 여야 그 계약이 유지된다.

export interface SerialLane {
  readonly running: boolean
  /** 대기·실행 중인 작업 수(진단·테스트용). */
  readonly pending: number
  run<T>(fn: () => Promise<T>): Promise<T>
}

export function createSerialLane(): SerialLane {
  let pending = 0
  let tail: Promise<unknown> = Promise.resolve()
  return {
    get running() { return pending > 0 },
    get pending() { return pending },
    run<T>(fn: () => Promise<T>): Promise<T> {
      pending += 1
      // 앞 작업이 실패했더라도 뒤 작업은 실행한다(성공·실패 양쪽에 같은 fn 을 잇는다).
      const next = tail.then(fn, fn) as Promise<T>
      // 차선 자체는 절대 rejected 로 남지 않는다 — 한 번의 실패가 이후 전부를 막지 않게.
      tail = next.then(() => undefined, () => undefined)
      return next.then(
        (v) => { pending -= 1; return v },
        (e) => { pending -= 1; throw e },
      )
    },
  }
}
