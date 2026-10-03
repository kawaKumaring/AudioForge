/**
 * 낭독 관측 기록 — **재기만 한다.** 합성·큐·재생 동작은 이것을 읽지 않는다(2026-10-03 관리자 승인 '최소 관측').
 *
 * ★시계: `performance.now()`(ms, 단조 증가 — 시스템 시각을 바꿔도 거꾸로 가지 않는다). 기준점은 이 창이 열린 때다.
 *   본체의 단계 시간(줄 대기·생성)은 본체 단조 시계로 잰 **길이**로만 받고, 이 창의 시각으로 옮긴다(아래 genStartAt).
 * ★싣지 않는 것: 책 본문 · 파일 경로 · 참조 전사. 글은 글자 수만, 목소리는 종류·엔진만.
 * ★제한된 개수만 — 최근 MAX 개(넘으면 오래된 것부터 버린다). 파일에 쓰지 않는다.
 * ★'재생 시작' 은 소리 요소의 **playing 사건**이다 — 생성 완료나 play() 호출로 대신하지 않는다
 *   (playing = 재생이 실제로 흐르기 시작했다는 브라우저 신호. 스피커까지의 장치 지연은 포함하지 않는다).
 *
 * 사건(ev)
 *   play-request   시작 단추(덩이 chunk 부터)
 *   gen-request    덩이 요청을 보냄(req · gen · chunk · chars)
 *   gen-start      본체에서 실제 생성이 시작된 순간(= 응답 시각 − 생성 길이, derived)
 *   gen-done       응답 받음 — ok · cached · shared · modelOpened · waitMs(본체 줄 대기) · makeMs(본체 생성) · accepted(받아들였나)
 *   play-start     소리 요소 playing — chunk · via(preloaded|normal) · sinceRequestMs(시작/이동 누름부터) · gapMs(앞 덩이 끝부터)
 *   buffer-low-start / buffer-low-end   재생 중 지금 덩이가 준비 안 됨 → 다시 소리가 날 때까지(lowMs)
 *   seek-request   문단 이동(→ 덩이 chunk). 다음 play-start 의 sinceRequestMs 가 '이동 후 첫 소리'
 *   stop · voice-change(gen) · resplit(gen)
 */
export interface TraceEvent { t: number; ev: string; [k: string]: string | number | boolean | null | undefined }

export const TRACE_MAX = 500
const buf: TraceEvent[] = []

export function trace(ev: string, data: Omit<TraceEvent, 't' | 'ev'> = {}, at?: number): void {
  const t = Math.round((at ?? performance.now()) * 10) / 10
  buf.push({ t, ev, ...data })
  if (buf.length > TRACE_MAX) buf.splice(0, buf.length - TRACE_MAX)
}

/** 실행 방식 — 검사 모드 수치를 보통 실행 수치로 읽지 않게 기록마다 함께 준다. */
function runMode(): string {
  const m = (globalThis as { api?: { _runMode?: unknown } }).api?._runMode
  return typeof m === 'string' && m ? m : 'unknown'
}

export function traceDump(): { clock: string; mode: string; max: number; events: TraceEvent[] } {
  return { clock: 'performance.now() ms · 단조 · 이 창 기준', mode: runMode(), max: TRACE_MAX, events: buf.slice() }
}
export function traceClear(): number { const n = buf.length; buf.length = 0; return n }

// 개발툴 MCP·검사가 읽는다(내용 없는 기록만이라 늘 연다).
if (typeof window !== 'undefined') Object.assign(window, { __readerTrace: { dump: traceDump, clear: traceClear } })
