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
  useAppStore.setState({ ttsEmotionRefState: {}, ttsReferencePrompts: {} })
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

// ── stale 전사 ↔ 새 음성 결합 방지(불변식 3·4). CUDA 진단의 오디오-전사 불일치와 직결. ──
// 재현 시나리오: 감정 참조 A에 수동 전사 설정 → 같은 emotion ID에 다른 source 등록 →
// 이전(A의) 전사가 남아 새 파일과 결합되면 안 된다.

test('재현: 감정 참조 교체 시 그 감정의 이전 전사가 새 source에 결합되면 안 됨', () => {
  const s = useAppStore.getState()
  // 1. 감정 참조 A에 수동 전사 설정
  s.registerEmotionRef('happy', 'C:/ref/A.wav')
  // 전사는 TTSEditor 로컬 미러가 sync로 store에 밀어넣는 형태 — setState로 그 경로를 모사
  useAppStore.setState({ ttsReferencePrompts: { happy: { manualText: 'A가 말한 문장', mode: 'manual' } } })
  // 2. 같은 emotion ID에 다른 source 등록
  s.registerEmotionRef('happy', 'C:/ref/B.wav')
  // 3. 이전(A의) 전사가 남아 새 파일과 결합되는지 — 남으면 안 됨(불변식)
  assert.equal(useAppStore.getState().ttsEmotionRefState.happy.source, 'C:/ref/B.wav')
  assert.equal(useAppStore.getState().ttsReferencePrompts.happy, undefined,
    'A의 전사가 B에 결합되어선 안 된다 — 감정 source 교체 시 그 감정 전사는 제거')
})

test('감정 참조 교체는 타 감정의 전사를 보존한다', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav'); s.registerEmotionRef('sad', 's.wav')
  useAppStore.setState({ ttsReferencePrompts: {
    happy: { manualText: 'h문장', mode: 'manual' },
    sad: { manualText: 's문장', mode: 'manual' },
  } })
  s.registerEmotionRef('happy', 'h2.wav')  // happy만 교체
  const p = useAppStore.getState().ttsReferencePrompts
  assert.equal(p.happy, undefined)                       // 교체된 감정 전사 제거
  assert.deepEqual(p.sad, { manualText: 's문장', mode: 'manual' })  // 타 감정 전사 보존
})

test('감정 삭제 시 그 감정의 전사도 함께 제거(타 감정 보존)', () => {
  const s = useAppStore.getState()
  s.registerEmotionRef('happy', 'h.wav'); s.registerEmotionRef('sad', 's.wav')
  useAppStore.setState({ ttsReferencePrompts: {
    happy: { manualText: 'h문장', mode: 'manual' },
    sad: { manualText: 's문장', mode: 'manual' },
  } })
  s.removeEmotionRef('happy')
  const p = useAppStore.getState().ttsReferencePrompts
  assert.equal(p.happy, undefined)
  assert.deepEqual(p.sad, { manualText: 's문장', mode: 'manual' })
})

test('기본 참조 파일 교체(setFile) 시 기본 전사(default)가 남지 않음', () => {
  const s = useAppStore.getState()
  useAppStore.setState({ ttsReferencePrompts: {
    default: { manualText: '기본 참조가 말한 문장', mode: 'manual' },
    happy: { manualText: 'h문장', mode: 'manual' },
  } })
  s.setFile({ path: 'new.wav', name: 'new.wav', duration: 5, channels: 1, sampleRate: 24000, format: 'wav' }, 'local-file://new.wav')
  // 새 기본 참조 = 새 파일 → 이전 default 전사(및 감정 전사)는 새 파일에 결합되면 안 됨
  assert.deepEqual(useAppStore.getState().ttsReferencePrompts, {})
})

test('reset 시 전사 상태 전량 초기화', () => {
  const s = useAppStore.getState()
  useAppStore.setState({ ttsReferencePrompts: { default: { manualText: 'x', mode: 'manual' } } })
  s.reset()
  assert.deepEqual(useAppStore.getState().ttsReferencePrompts, {})
})
