// 진단 미리듣기 플레이어 단위테스트 — 가짜 미디어 요소·가짜 타이머만 쓴다.
// 실제 오디오·파일·GPU 없음. 이 테스트가 지키는 것:
//   1) 앞 500ms 동안 소리가 나지 않고, 그 뒤에야 원본이 재생된다
//   2) 원본이 끝나면 500ms 를 더 기다린 뒤에 끝난다
//   3) 원본은 읽히기만 한다(변환·재작성 없음)
//   4) 반복 재생·정지·샘플 교체·언마운트에서 요소와 타이머가 중복되거나 남지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createEmotionSamplePreviewPlayer,
  type PreviewAudioElement,
  type EmotionSamplePreviewDeps,
  type PreviewTimerHandle,
} from './emotionSamplePreviewPlayer.ts'
import { EMOTION_PREVIEW_SILENCE_MS } from '../../shared/emotionSamplePreview.ts'
import { previewErrorText, type PreviewFailureKind } from '../../shared/previewSession.ts'

const SRC = 'media-src-token'   // 실제 경로가 아니다 — 플레이어는 문자열을 그대로 넘길 뿐이다.

interface FakeAudio extends PreviewAudioElement {
  readonly playCalls: number
  readonly pauseCalls: number
  readonly srcWrites: readonly string[]
  listenerCount(): number
  emit(type: 'ended' | 'error'): void
}

function makeFakeAudio(opts: { playRejects?: boolean } = {}): FakeAudio {
  const listeners = new Map<string, Set<() => void>>()
  const srcWrites: string[] = []
  let srcValue = ''
  let plays = 0
  let pauses = 0

  return {
    get src() { return srcValue },
    set src(v: string) { srcValue = v; srcWrites.push(v) },
    currentTime: -1,
    get playCalls() { return plays },
    get pauseCalls() { return pauses },
    get srcWrites() { return srcWrites },
    play() {
      plays += 1
      return opts.playRejects ? Promise.reject(new Error('blocked')) : Promise.resolve()
    },
    pause() { pauses += 1 },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    listenerCount() {
      let n = 0
      for (const set of listeners.values()) n += set.size
      return n
    },
    emit(type) { for (const l of [...(listeners.get(type) ?? [])]) l() },
  }
}

interface Harness {
  deps: EmotionSamplePreviewDeps
  audios: FakeAudio[]
  stages: string[]
  errors: PreviewFailureKind[]
  pending(): number
  cleared(): number
  lastDelay(): number
  /** 가장 오래된 대기 콜백을 꺼내 실행한다. */
  fireNext(): void
  /** 대기 중인 콜백을 실행하지 않고 참조만 얻는다(정지 후 stale 발화 검증용). */
  peekNext(): () => void
}

function makeHarness(audioOpts: { playRejects?: boolean } = {}): Harness {
  const audios: FakeAudio[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const stages: string[] = []
  const errors: PreviewFailureKind[] = []
  let nextId = 0
  let clearedCount = 0
  let lastMs = -1

  const first = (): { id: number; fn: () => void } => {
    const id = [...timers.keys()][0]
    if (id === undefined) throw new Error('대기 중인 타이머가 없다')
    return { id, fn: timers.get(id)!.fn }
  }

  const deps: EmotionSamplePreviewDeps = {
    silenceMs: EMOTION_PREVIEW_SILENCE_MS,
    createAudio: () => {
      const a = makeFakeAudio(audioOpts)
      audios.push(a)
      return a
    },
    setTimer: (fn, ms) => {
      nextId += 1
      lastMs = ms
      timers.set(nextId, { fn, ms })
      return nextId
    },
    clearTimer: (h: PreviewTimerHandle) => { if (timers.delete(h as number)) clearedCount += 1 },
    onStage: (s) => { stages.push(s) },
    onError: (kind) => { errors.push(kind) },
  }

  return {
    deps,
    audios,
    stages,
    errors,
    pending: () => timers.size,
    cleared: () => clearedCount,
    lastDelay: () => lastMs,
    fireNext: () => {
      const { id, fn } = first()
      timers.delete(id)
      fn()
    },
    peekNext: () => first().fn,
  }
}

// ── 1) 앞 500ms ─────────────────────────────────────────────────────────────

test('앞 정적: 500ms 동안 재생이 시작되지 않는다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  assert.equal(p.stage, 'leadIn')
  assert.equal(h.audios[0].playCalls, 0, '앞 정적 동안에는 소리가 나지 않는다')
  assert.equal(h.audios[0].srcWrites.length, 0, '아직 소스도 걸지 않는다')
  assert.equal(h.lastDelay(), 500)
  assert.equal(h.lastDelay(), EMOTION_PREVIEW_SILENCE_MS)

  h.fireNext()
  assert.equal(p.stage, 'sample')
  assert.equal(h.audios[0].playCalls, 1, '500ms 뒤에 정확히 한 번 재생된다')
})

// ── 2) 뒤 500ms ─────────────────────────────────────────────────────────────

test('뒤 정적: 원본이 끝난 뒤 500ms 를 더 기다린다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  h.fireNext()                       // 앞 정적 종료 → 재생 시작
  assert.equal(p.stage, 'sample')

  h.audios[0].emit('ended')
  assert.equal(p.stage, 'tailOut', '원본이 끝나도 즉시 done 이 아니다')
  assert.equal(h.lastDelay(), 500)

  h.fireNext()
  assert.equal(p.stage, 'done')
  assert.equal(h.pending(), 0, '끝나면 타이머가 남지 않는다')
  assert.deepEqual(h.stages, ['leadIn', 'sample', 'tailOut', 'done'])
})

// ── 3) 원본 불변 ────────────────────────────────────────────────────────────

test('원본 불변: 소스는 넘긴 값 그대로 한 번만 걸리고 잘리지 않는다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('emotion_happy', SRC)
  h.fireNext()

  assert.deepEqual([...h.audios[0].srcWrites], [SRC], '넘긴 소스를 그대로, 한 번만 세팅한다')
  assert.equal(h.audios[0].currentTime, 0, '처음부터 재생한다 — 구간을 잘라내지 않는다')
})

test('원본 불변: 플레이어에 오디오를 만지는 API 자체가 없다', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./emotionSamplePreviewPlayer.ts', import.meta.url)),
    'utf-8'
  )
  for (const banned of [
    'writeFile', 'readFile', 'AudioContext', 'AudioBuffer', 'decodeAudioData', 'MediaRecorder',
  ]) {
    assert.ok(!src.includes(banned), `${banned} 를 쓰지 않는다`)
  }
})

// ── 4) 중복·정리 ────────────────────────────────────────────────────────────

test('반복 재생: 요소는 하나, 타이머도 하나만 살아 있다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  for (let i = 0; i < 5; i++) {
    p.play('laugh_bright', SRC)
    assert.equal(h.pending(), 1, `${i}회차: 타이머는 항상 하나`)
    assert.equal(h.audios.length, 1, `${i}회차: Audio 요소는 하나만 만든다`)
    assert.equal(h.audios[0].listenerCount(), 2, `${i}회차: 리스너가 쌓이지 않는다`)
  }
  assert.ok(h.cleared() >= 4, '다음 재생 전에 이전 타이머를 지운다')

  h.fireNext()
  assert.equal(h.audios[0].playCalls, 1, '겹쳐 눌러도 재생은 마지막 것 하나만')
})

test('정지: 타이머를 지우고 소리를 멈추며, 늦게 온 콜백은 아무 일도 못 한다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  const staleCallback = h.peekNext()        // 정지 직전에 이미 대기 중이던 콜백
  const pauseBefore = h.audios[0].pauseCalls

  p.stop()
  assert.equal(p.stage, 'idle')
  assert.equal(h.pending(), 0, '정지하면 타이머가 남지 않는다')
  assert.ok(h.audios[0].pauseCalls > pauseBefore, '소리를 멈춘다')

  staleCallback()                            // 뒤늦게 발화
  assert.equal(p.stage, 'idle', 'stale 콜백이 재생을 되살리지 못한다')
  assert.equal(h.audios[0].playCalls, 0)
  assert.equal(h.audios[0].srcWrites.length, 0)
})

test('샘플 교체: 재생 중 다른 행을 누르면 이전 것이 끼어들지 못한다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  h.fireNext()
  assert.equal(p.stage, 'sample')

  p.play('emotion_sad', 'other-src')
  assert.equal(p.rowId, 'emotion_sad')
  assert.equal(p.stage, 'leadIn')
  assert.equal(h.pending(), 1)

  // 이전 재생의 ended 가 뒤늦게 도착해도 새 재생의 단계를 바꾸지 못한다.
  h.audios[0].emit('ended')
  assert.equal(p.stage, 'leadIn', '옛 ended 는 버려진다')

  h.fireNext()
  assert.equal(p.stage, 'sample')
  assert.deepEqual([...h.audios[0].srcWrites], [SRC, 'other-src'])
  assert.equal(h.audios.length, 1)
})

test('언마운트: dispose 는 타이머·리스너·소스를 정리하고 이후 호출을 무시한다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  h.fireNext()
  const a = h.audios[0]
  assert.equal(a.listenerCount(), 2)

  p.dispose()
  assert.equal(h.pending(), 0, '남은 타이머 없음')
  assert.equal(a.listenerCount(), 0, '리스너 전부 해제')
  assert.equal(a.src, '', '소스를 비운다')
  assert.equal(p.stage, 'idle')

  const playsBefore = a.playCalls
  p.play('laugh_open', SRC)
  p.stop()
  assert.equal(h.pending(), 0, 'dispose 뒤에는 아무 것도 예약하지 않는다')
  assert.equal(a.playCalls, playsBefore)
})

// ── 5) 실패 경로 ────────────────────────────────────────────────────────────

test('오류: 재생 실패는 경로 없는 문구로만 알리고 상태를 되돌린다', async () => {
  const h = makeHarness({ playRejects: true })
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', SRC)
  h.fireNext()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(p.stage, 'idle')
  assert.equal(h.errors.length, 1)
  assert.ok(h.errors[0].length > 0)
  assert.ok(!h.errors[0].includes(SRC), '오류 문구에 소스 토큰이 새지 않는다')
  assert.ok(!/[/\\]/.test(h.errors[0]), '오류 문구에 경로 구분자가 없다')
  assert.equal(h.pending(), 0)
})

test('빈 소스: 재생을 시작하지 않고 문구로 알린다', () => {
  const h = makeHarness()
  const p = createEmotionSamplePreviewPlayer(h.deps)

  p.play('laugh_open', '')
  assert.equal(p.stage, 'idle')
  assert.equal(h.pending(), 0)
  assert.deepEqual(h.errors, ['source'])
  assert.equal(h.audios.length, 0, '소스가 없으면 요소를 만들지도 않는다')
})

test('주입 계약: 진단 정적 길이는 shared 상수를 그대로 쓰고, 이상한 값은 거부한다', () => {
  const h = makeHarness()
  assert.equal(h.deps.silenceMs, EMOTION_PREVIEW_SILENCE_MS, '값 출처는 shared 하나')
  assert.equal(h.deps.silenceMs, 500)
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createEmotionSamplePreviewPlayer({ ...h.deps, silenceMs: bad }),
      RangeError,
      String(bad)
    )
  }
})
