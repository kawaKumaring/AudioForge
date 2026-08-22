// 감정 참조 store 상태 전이 회귀 — Node 내장 러너(node --test).
// store는 감정 등록/삭제/reset에서 window.api.audio.releaseReferenceClip을 호출하므로(부작용)
// 호출을 기록하는 가짜 window를 심어 clipKey 인자까지 검증한다.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const released: (string | undefined)[] = []
;(globalThis as unknown as { window: unknown }).window = {
  api: { audio: { releaseReferenceClip: (clipKey?: string) => { released.push(clipKey) } } },
}

const { useAppStore, emotionEffectivePath } = await import('./app.store.ts')

beforeEach(() => {
  released.length = 0
  useAppStore.setState({ ttsEmotionRefState: {} })
})

test('emotionEffectivePath: 미준비/미등록은 빈 문자열', () => {
  assert.equal(emotionEffectivePath(undefined), '')
  assert.equal(emotionEffectivePath({ source: 's.wav', clip: '', region: null, ready: false, message: '' }), '')
})

test('emotionEffectivePath: 파생 클립 우선, 없으면 유효 원본', () => {
  assert.equal(emotionEffectivePath({ source: 's.wav', clip: 'c.wav', region: { start: 1, duration: 5 }, ready: true, message: '' }), 'c.wav')
  assert.equal(emotionEffectivePath({ source: 's.wav', clip: '', region: null, ready: true, message: '' }), 's.wav')
})

test('registerEmotionRef: source 설정 + 파생 상태 초기화 + 그 clipKey 정리 호출', () => {
  useAppStore.getState().registerEmotionRef('happy', 'C:/ref/happy_long.wav')
  const slot = useAppStore.getState().ttsEmotionRefState.happy
  assert.deepEqual(slot, { source: 'C:/ref/happy_long.wav', clip: '', region: null, ready: false, message: '' })
  assert.deepEqual(released, ['happy'])  // 그 감정 clipKey만 정리
})

test('setEmotionRefState: 확정 시 clip/region/ready 패치 (source 불변)', () => {
  useAppStore.getState().registerEmotionRef('sad', 'C:/ref/sad.wav')
  useAppStore.getState().setEmotionRefState('sad', { clip: 'C:/tmp/clip.wav', region: { start: 2, duration: 7 }, ready: true, message: '' })
  const slot = useAppStore.getState().ttsEmotionRefState.sad
  assert.equal(slot.source, 'C:/ref/sad.wav')  // 원본 불변
  assert.equal(slot.clip, 'C:/tmp/clip.wav')
  assert.deepEqual(slot.region, { start: 2, duration: 7 })
  assert.equal(slot.ready, true)
  assert.equal(emotionEffectivePath(slot), 'C:/tmp/clip.wav')
})

test('setEmotionRefState: 미등록 감정에는 패치하지 않음(방어)', () => {
  useAppStore.getState().setEmotionRefState('angry', { ready: true })
  assert.equal(useAppStore.getState().ttsEmotionRefState.angry, undefined)
})

test('한 감정 재확정이 타 감정 slot을 건드리지 않음', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav'); s.registerEmotionRef('sad', 's.wav')
  s.setEmotionRefState('happy', { clip: 'hc.wav', ready: true, region: { start: 0, duration: 4 } })
  const st = useAppStore.getState().ttsEmotionRefState
  assert.equal(st.happy.clip, 'hc.wav')
  assert.equal(st.sad.clip, '')          // 슬픔은 불변
  assert.equal(st.sad.ready, false)
})

test('removeEmotionRef: slot 제거 + 그 clipKey만 정리', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav'); s.registerEmotionRef('sad', 's.wav')
  released.length = 0
  s.removeEmotionRef('happy')
  const st = useAppStore.getState().ttsEmotionRefState
  assert.equal(st.happy, undefined)
  assert.ok(st.sad)                       // 슬픔 유지
  assert.deepEqual(released, ['happy'])
})

test('reset: 감정 상태 전량 초기화 + 전체 클립 정리(clipKey 없이)', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav')
  released.length = 0
  s.reset()
  assert.deepEqual(useAppStore.getState().ttsEmotionRefState, {})
  assert.deepEqual(released, [undefined])  // 전체 정리
})

test('setFile: 감정 상태 전량 초기화 + 전체 클립 정리', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav')
  released.length = 0
  s.setFile({ path: 'x.wav', name: 'x.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' }, 'local-file://x.wav')
  assert.deepEqual(useAppStore.getState().ttsEmotionRefState, {})
  assert.deepEqual(released, [undefined])
})
