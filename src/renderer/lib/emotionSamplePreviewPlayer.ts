// 감정 샘플 진단 미리듣기 플레이어 — 앞 정적 500ms · 원본 · 뒤 정적 500ms 를 **재생 타임라인**으로 낸다.
//
// 무음을 파일에 붙이지 않는다. 앞 정적은 '재생을 500ms 늦게 시작'하는 것이고, 뒤 정적은 원본이
// ended 된 뒤 500ms 를 '그냥 기다리는' 것이다. 그래서:
//   · 원본 WAV 는 읽히기만 한다 — 디코딩·변환·재작성·파생 파일 생성이 없다.
//   · 캐시 키·내용 SHA-256 은 영향을 받지 않는다.
//   · 합성 요청·모델 입력에는 이 모듈의 어떤 값도 흘러가지 않는다.
//
// 비동기 함정(늦게 도착한 타이머·ended 가 다음 재생을 망가뜨림)은 세대(gen) 로 막는다.
// 요소와 타이머는 각각 **하나만** 존재한다:
//   · Audio 요소는 처음 재생할 때 한 번 만들어 계속 재사용한다(dispose 까지).
//   · 타이머는 새로 걸기 전에 반드시 이전 것을 지운다.
//
// DOM 을 직접 참조하지 않고 최소 인터페이스로 주입받는다 — 테스트가 가짜 요소·가짜 타이머로
// 중복 생성과 정리 누락을 실제로 검사할 수 있어야 하기 때문이다.
//
// ⚠️ 값을 다른 모듈에서 import 하지 않는다(타입만 가져온다). 이 레포의 shared 계약 모듈은 서로
//    의존하지 않고, 테스트는 node --test 가 로더 없이 실행한다. 런타임 import 를 만들면 확장자
//    관례(프로덕션=무확장자 / 테스트=.ts)와 충돌한다. 그래서 정적(500ms)과 오류 문구 변환은
//    **주입**받는다 — 값의 출처는 shared/emotionSamplePreview 하나로 유지된다.
import type { EmotionPreviewStage } from '../../shared/emotionSamplePreview'
import type { PreviewFailureKind } from '../../shared/previewSession'

/** 플레이어가 요구하는 미디어 요소의 최소 표면. HTMLAudioElement 가 그대로 만족한다. */
export interface PreviewAudioElement {
  src: string
  currentTime: number
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'ended' | 'error', listener: () => void): void
  removeEventListener(type: 'ended' | 'error', listener: () => void): void
}

export type PreviewTimerHandle = unknown

export interface EmotionSamplePreviewDeps {
  /**
   * 앞뒤 진단 정적 길이(ms). shared/emotionSamplePreview 의 EMOTION_PREVIEW_SILENCE_MS 를
   * 그대로 넘긴다 — 이 모듈이 자체 상수를 갖지 않는 이유는 값의 출처를 하나로 두기 위해서다.
   */
  silenceMs: number
  /** 미디어 요소 생성. 플레이어 수명 동안 **한 번만** 불린다. */
  createAudio: () => PreviewAudioElement
  setTimer: (fn: () => void, ms: number) => PreviewTimerHandle
  clearTimer: (handle: PreviewTimerHandle) => void
  /** 단계가 바뀔 때마다 알림(표시용). 순수하지 않은 일은 하지 않는다. */
  onStage?: (stage: EmotionPreviewStage, rowId: string | null) => void
  /**
   * 실패 종류만 알린다. 사용자 문구는 호출자가 shared 의 previewErrorText 로 만든다 —
   * 경로·원시 오류 메시지는 이 모듈을 통과하지 않는다.
   */
  onError?: (kind: PreviewFailureKind) => void
}

export interface EmotionSamplePreviewPlayer {
  /** 진단 재생 시작. 이미 재생 중이면 그것을 먼저 정리한다(요소·타이머 중복 없음). */
  play(rowId: string, src: string): void
  /** 정지 — 타이머를 지우고 소리를 멈춘다. 늦게 도착할 이전 결과는 전부 무효가 된다. */
  stop(): void
  /** 언마운트용. 정지에 더해 리스너를 떼고 소스를 비운다. */
  dispose(): void
  readonly stage: EmotionPreviewStage
  readonly rowId: string | null
  /** 테스트·진단용 세대 번호. 값이 바뀌었다면 이전 비동기 결과는 폐기 대상이다. */
  readonly generation: number
}

export function createEmotionSamplePreviewPlayer(
  deps: EmotionSamplePreviewDeps
): EmotionSamplePreviewPlayer {
  if (!Number.isFinite(deps.silenceMs) || deps.silenceMs < 0) {
    throw new RangeError('silenceMs must be a finite number >= 0')
  }
  const silenceMs = deps.silenceMs
  let audio: PreviewAudioElement | null = null
  let timer: PreviewTimerHandle | null = null
  let gen = 0
  let stage: EmotionPreviewStage = 'idle'
  let rowId: string | null = null
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
  }

  const setStage = (next: EmotionPreviewStage): void => {
    stage = next
    deps.onStage?.(next, rowId)
  }

  const fail = (kind: PreviewFailureKind): void => {
    gen += 1                     // 남아 있는 타이머·ended 를 전부 stale 로 만든다
    clearTimer()
    setStage('idle')
    deps.onError?.(kind)
  }

  // ended/error 는 요소 하나에 **한 번만** 붙인다. 세대 검사로 옛 재생의 신호를 걸러낸다.
  const onEnded = (): void => {
    if (disposed || stage !== 'sample') return
    const mine = gen
    setStage('tailOut')
    clearTimer()
    timer = deps.setTimer(() => {
      if (disposed || mine !== gen) return   // 정지·다음 재생이 이미 시작됐다 → 버린다
      timer = null
      setStage('done')
    }, silenceMs)
  }

  const onError = (): void => {
    if (disposed || stage === 'idle') return
    fail('load')
  }

  const ensureAudio = (): PreviewAudioElement => {
    if (!audio) {
      audio = deps.createAudio()
      audio.addEventListener('ended', onEnded)
      audio.addEventListener('error', onError)
    }
    return audio
  }

  return {
    play(nextRowId: string, src: string): void {
      if (disposed) return
      if (!src) {
        rowId = nextRowId
        fail('source')
        return
      }
      // 진행 중이던 것을 먼저 무효화한다 — 이전 타이머가 새 재생을 끊지 못하게.
      gen += 1
      const mine = gen
      clearTimer()
      const el = ensureAudio()
      el.pause()
      rowId = nextRowId

      // 앞 정적: 소리를 내지 않고 500ms 를 기다린다(파일에 무음을 붙이지 않는다).
      setStage('leadIn')
      timer = deps.setTimer(() => {
        if (disposed || mine !== gen) return
        timer = null
        el.src = src
        el.currentTime = 0
        setStage('sample')
        void el.play().catch(() => {
          if (disposed || mine !== gen) return
          fail('play')
        })
      }, silenceMs)
    },

    stop(): void {
      if (disposed) return
      gen += 1
      clearTimer()
      audio?.pause()
      setStage('idle')
    },

    dispose(): void {
      if (disposed) return
      gen += 1
      clearTimer()
      if (audio) {
        audio.pause()
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        audio.src = ''
        audio = null
      }
      stage = 'idle'
      rowId = null
      disposed = true
    },

    get stage() { return stage },
    get rowId() { return rowId },
    get generation() { return gen },
  }
}

/**
 * 브라우저 기본 의존성. 테스트는 이 함수를 쓰지 않고 가짜를 주입한다.
 * silenceMs 는 호출부가 shared 의 EMOTION_PREVIEW_SILENCE_MS 를 넘긴다(값 출처 단일화).
 */
export function browserPreviewDeps(
  silenceMs: number,
  hooks: Pick<EmotionSamplePreviewDeps, 'onStage' | 'onError'> = {}
): EmotionSamplePreviewDeps {
  return {
    silenceMs,
    createAudio: () => new Audio(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    ...hooks,
  }
}
