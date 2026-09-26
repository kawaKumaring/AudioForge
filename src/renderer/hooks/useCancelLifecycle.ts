/**
 * 취소 handshake 배선 — **작업을 소유한 화면은 이것을 써야 한다.**
 *
 * ★왜 부품이 됐나(2026-09-24 2차 감사)
 *   취소 계약(C2-P0.1)의 순수 판정은 `shared/cancelContract.ts` 로 잘 뽑혀 있었다.
 *   그런데 **'세 이벤트를 모두 들어야 한다' 는 구독 의무**는 어디에도 부품화되지 않고
 *   `ProcessButton` 안의 배선과 주석으로만 있었다.
 *
 *   그 뒤 일반 탭이 **두 번째 작업 소유자**로 같은 통로에 들어오면서 렌더러 쪽을
 *   처음부터 다시 썼고, **성공 경로(cancelled)만** 배선했다.
 *   그래서 일반 탭에서 취소가 실패하면 화면이 아무 말도 하지 않고 '만드는 중' 에 멈춘다.
 *   더 나쁜 것은 그때 `status` 가 `processing` 에 얼어붙어 **탭 단추도 모드 단추도
 *   비활성**되는 것이다 — 앱을 다시 켜는 것 말고 빠져나올 길이 없다.
 *
 *   같은 파일에서 '시작 요청의 거절은 버리지 않는다' 는 이미 고쳤는데,
 *   **그 교훈이 시작에만 적용되고 취소에는 빠졌다.**
 *
 * ★이 훅이 갖는 것과 갖지 않는 것
 *   갖는다 — 세 이벤트의 구독·해제, 취소 요청의 반환값 해석, 실패 갈래 판정.
 *   갖지 않는다 — **무엇을 할지.** 처리는 부르는 쪽 콜백이다.
 *   이유: 고급 탭의 `finishCancelled` 는 결과 목록까지 비운다. 그것을 일반 탭에
 *   그대로 걸면 **취소해도 이미 만든 것은 그대로** 라는 규칙이 깨진다.
 *   화면마다 할 일이 다르므로 훅이 처리를 가지면 안 된다.
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  cancelAlreadyOverText, cancelFailureKind, cancelNoopReason, canRequestCancel,
  interpretCancelResponse,
  type CancelFailureKind, type CancelNoopReason, type CancelUiStatus,
} from '../../shared/cancelContract'

export interface CancelLifecycleHandlers {
  /**
   * main 이 취소를 받아 정리를 시작했다. 'cancelling' 전환의 **유일한** 권위.
   * 짐에는 요청 식별자가 실려 온다(2026-09-27) — 남의 실행이 끝났다고 내 작업을 내리지 않게.
   */
  onCancelling?: (payload?: unknown) => void
  /** 취소가 끝났다. 짐은 위와 같다. */
  onCancelled?: (payload?: unknown) => void
  /**
   * 취소가 실패했다. 갈래마다 **회복 방법이 반대**다 —
   * `cancelRetryable(kind)` 가 false 면 '다시 취소' 를 권하면 안 된다.
   */
  onFailed?: (kind: CancelFailureKind, payload: unknown) => void
}

export interface CancelLifecycle {
  /**
   * 취소를 **요청**한다. 낙관적 전환은 하지 않는다 — 전환의 권위는 이벤트다.
   * 돌려주는 것: 수락됐으면 null, 아니면 미수락 사유.
   * ★특히 `NO_ACTIVE_JOB` 은 '이미 끝났다' 는 뜻이라 화면이 빠져나올 신호다.
   */
  requestCancel: () => Promise<CancelNoopReason | 'UNKNOWN_RESPONSE' | null>
}

type CancelApi = {
  cancel: () => Promise<unknown>
  onCancelling: (cb: (payload?: unknown) => void) => () => void
  onCancelled: (cb: (payload?: unknown) => void) => () => void
  onCancelFailed: (cb: (data: unknown) => void) => () => void
}

/**
 * @param statusOf 지금 상태를 읽는다. 요청 가능 여부 판정에만 쓴다(구독에는 안 쓴다).
 */
export function useCancelLifecycle(
  statusOf: () => CancelUiStatus,
  handlers: CancelLifecycleHandlers,
): CancelLifecycle {
  // 핸들러는 매 렌더 바뀔 수 있다 — 구독은 한 번만 걸고 최신 것을 본다.
  const ref = useRef(handlers)
  ref.current = handlers
  const inFlight = useRef(false)

  // ★상시 구독이다. 실행별 구독과 분리한다 — 취소 실패 뒤의 '다시 취소' 도 받아야 한다.
  //   그리고 **여기에 '작업이 있나' 가드를 걸지 않는다.** 실패 처리에서 작업을 비우면
  //   뒤따르는 재취소의 이벤트가 그 가드에 걸려 조용히 버려진다.
  useEffect(() => {
    const api = (window as unknown as { api: { audio: CancelApi } }).api.audio
    const offCancelling = api.onCancelling((d?: unknown) => ref.current.onCancelling?.(d))
    const offCancelled = api.onCancelled((d?: unknown) => ref.current.onCancelled?.(d))
    const offFailed = api.onCancelFailed((d: unknown) => ref.current.onFailed?.(cancelFailureKind(d), d))
    return () => { offCancelling(); offCancelled(); offFailed() }
  }, [])

  const requestCancel = useCallback(async () => {
    if (!canRequestCancel(statusOf())) return null
    if (inFlight.current) return null          // 연타는 요청 1회로 접는다(멱등)
    inFlight.current = true
    try {
      const resp = await (window as unknown as { api: { audio: CancelApi } }).api.audio.cancel()
      if (interpretCancelResponse(resp) === 'accepted') return null
      return cancelNoopReason(resp)
    } catch {
      // invoke 실패도 미수락과 같이 본다 — 상태를 바꾸지 않으므로 갇히지 않는다.
      return 'UNKNOWN_RESPONSE' as const
    } finally {
      inFlight.current = false                 // 반드시 해제 — 단추가 영구 무반응이 되지 않게
    }
  }, [statusOf])

  return { requestCancel }
}

/** 요청이 미수락일 때 화면에 보일 말. 없으면 null(조용히 지나가도 되는 경우). */
export { cancelAlreadyOverText }
