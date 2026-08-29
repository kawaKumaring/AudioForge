// 참조 음성 '미리듣기' 세션 모델 — 순수 모듈(React·Electron·DOM·타이머 없음).
//
// 왜 필요한가: 미리듣기는 (a) 경로→URL 해석(비동기 IPC), (b) 미디어 로드(비동기 이벤트),
// (c) play() 프로미스, (d) 구간 종료 타이머 네 개의 비동기 결과가 각자 다른 시점에 돌아온다.
// 사용자가 구간을 빠르게 바꾸거나 감정 후보를 옮겨 다니면 '이전 요청'의 결과가 '현재 재생'에
// 끼어들어 재생을 멈추거나(무음) src를 덮어써 요소를 이상 상태로 남긴다.
//
// 그래서 모든 요청에 단조 증가하는 세대(generation) id를 붙이고, 늦게 도착한 결과가 현재 세대의
// 것인지 여기서 판정한다. 실제 pause/seek/play/타이머는 컴포넌트가 소유하고, '적용할지 버릴지'는
// 이 모듈이 결정한다.

export type PreviewPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'stopped' | 'error'

export interface PreviewSession {
  /** 요청마다 1씩 증가. 이 값이 다른 결과는 전부 이전 요청의 것 → 폐기 대상. */
  readonly gen: number
  readonly phase: PreviewPhase
  /** 사용자에게 보여줄 오류 문구(사용자 언어, 경로 미포함). 오류가 아니면 null. */
  readonly errorMessage: string | null
}

export const IDLE_SESSION: PreviewSession = Object.freeze({ gen: 0, phase: 'idle', errorMessage: null })

/**
 * 새 미리듣기 요청. 세대를 올리고 loading으로 들어간다.
 * 전이표를 거치지 않는 유일한 진입점 — 호출자가 직전 재생을 pause()하고 src를 비운 뒤 부르기 때문이다.
 */
export function beginRequest(s: PreviewSession): PreviewSession {
  return { gen: s.gen + 1, phase: 'loading', errorMessage: null }
}

/**
 * 진행 중인 세대를 무효화한다(정지·소스 교체·언마운트). 세대를 올리므로 아직 돌아오지 않은
 * url 해석·로드 완료·play 결과·구간 종료 타이머는 전부 stale이 되어 폐기된다.
 */
export function invalidate(s: PreviewSession, phase: 'idle' | 'stopped' = 'idle'): PreviewSession {
  return { gen: s.gen + 1, phase, errorMessage: null }
}

/** 이 결과가 현재 세대의 것이 아닌가(= 폐기해야 하는가). */
export function isStale(s: PreviewSession, gen: number): boolean {
  return gen !== s.gen
}

/** 합법 전이표. beginRequest·invalidate(세대 교체)만 이 표를 거치지 않는다. */
export const LEGAL_NEXT: Readonly<Record<PreviewPhase, readonly PreviewPhase[]>> = Object.freeze({
  idle: Object.freeze(['loading']),
  loading: Object.freeze(['loading', 'ready', 'stopped', 'error']),
  ready: Object.freeze(['playing', 'stopped', 'error']),
  playing: Object.freeze(['stopped', 'error']),
  stopped: Object.freeze(['loading']),
  error: Object.freeze(['loading']),
}) as Readonly<Record<PreviewPhase, readonly PreviewPhase[]>>

export function isLegalTransition(from: PreviewPhase, to: PreviewPhase): boolean {
  return (LEGAL_NEXT[from] || []).includes(to)
}

/** 비동기 결과 종류. url/타이머/ended 모두 '어느 세대의 것인가'를 먼저 따진다. */
export type PreviewEvent =
  | { kind: 'url' }                      // getFileUrl 해석 완료(아직 로드 전)
  | { kind: 'ready' }                    // loadedmetadata/canplay 도달
  | { kind: 'play' }                     // play() 프로미스 이행
  | { kind: 'ended' }                    // 미디어 ended
  | { kind: 'region-end' }               // 구간 종료 타이머 발화
  | { kind: 'stop' }                     // 사용자가 정지
  | { kind: 'error'; message: string }   // 로드/재생 실패(사용자 언어 문구)

const EVENT_PHASE: Readonly<Record<PreviewEvent['kind'], PreviewPhase>> = Object.freeze({
  url: 'loading',
  ready: 'ready',
  play: 'playing',
  ended: 'stopped',
  'region-end': 'stopped',
  stop: 'stopped',
  error: 'error',
})

export type PreviewVerdict =
  | { apply: true; next: PreviewSession }
  | { apply: false; reason: 'stale' | 'illegal' }

/**
 * 비동기 결과를 적용할지 판정한다.
 *  - 세대가 다르면 'stale' → 버린다(이전 재생의 타이머가 새 재생을 멈추는 사고를 막는 핵심).
 *  - 세대는 맞지만 전이가 불법이면 'illegal' → 버린다(로드 전 playing 진입 등).
 */
export function applyEvent(s: PreviewSession, gen: number, event: PreviewEvent): PreviewVerdict {
  if (isStale(s, gen)) return { apply: false, reason: 'stale' }
  const to = EVENT_PHASE[event.kind]
  if (!isLegalTransition(s.phase, to)) return { apply: false, reason: 'illegal' }
  return {
    apply: true,
    next: { gen: s.gen, phase: to, errorMessage: event.kind === 'error' ? event.message : null },
  }
}

export type ResultDecision = 'apply' | 'discard'

/** 상태 전이 없이 '이 비동기 결과를 계속 처리해도 되는가'만 묻는 짧은 판정(url 해석·타이머 진입점용). */
export function decideAsyncResult(s: PreviewSession, gen: number): ResultDecision {
  return isStale(s, gen) ? 'discard' : 'apply'
}

// ── 사용자에게 보여줄 오류 문구 ───────────────────────────────────────────────
// 원시 오류 메시지·파일 경로를 그대로 노출하지 않는다(경로 유출 금지). 자동 재시도도 하지 않는다 —
// 문구는 사용자가 직접 다시 시도하도록만 안내한다.
export type PreviewFailureKind = 'source' | 'load' | 'play'

export const PREVIEW_ERROR_TEXT: Readonly<Record<PreviewFailureKind, string>> = Object.freeze({
  source: '미리듣기할 음성이 없습니다. 참조 파일을 다시 선택해 주세요.',
  load: '미리듣기 음성을 불러오지 못했습니다. 파일이 옮겨졌거나 지워졌는지 확인해 주세요.',
  play: '미리듣기를 재생하지 못했습니다. 잠시 뒤 다시 눌러 주세요.',
})

export function previewErrorText(kind: PreviewFailureKind): string {
  return PREVIEW_ERROR_TEXT[kind] || PREVIEW_ERROR_TEXT.play
}
