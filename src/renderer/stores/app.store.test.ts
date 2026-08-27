// 감정 참조 store 상태 전이 회귀 — Node 내장 러너(node --test).
// store는 감정 등록/삭제/reset에서 window.api.audio.releaseReferenceClip을 호출하므로(부작용)
// 호출을 기록하는 가짜 window를 심어 clipKey 인자까지 검증한다.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const released: (string | undefined)[] = []
;(globalThis as unknown as { window: unknown }).window = {
  api: { audio: { releaseReferenceClip: (clipKey?: string) => { released.push(clipKey) } } },
}

const { useAppStore, emotionEffectivePath, reconstructEmotionRefState, reconstructReferencePrompts } = await import('./app.store.ts')

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

// ── 세션 복원 재구성(지시 5) — source 소실 감정만 재지정 필요, 나머지 보존 ──
test('reconstructEmotionRefState: source 존재+원본 직접 사용 → 준비됨', () => {
  const out = reconstructEmotionRefState(
    { happy: 'C:/ref/happy.wav' },
    { happy: { start: 1, duration: 5 } },
    { happy: 'C:/ref/happy.wav' },  // effective===source (≤10초 유효 원본 직접 사용)
    { happy: true }
  )
  assert.deepEqual(out.happy, { source: 'C:/ref/happy.wav', clip: '', region: { start: 1, duration: 5 }, ready: true, message: '' })
})

test('reconstructEmotionRefState: source 존재+파생 클립 사용했었음 → 구간 재확정 필요', () => {
  const out = reconstructEmotionRefState(
    { happy: 'C:/ref/long.wav' },
    { happy: { start: 2, duration: 6 } },
    { happy: 'C:/tmp/derived.wav' },  // effective≠source (파생 클립, 현재 소실)
    { happy: true }
  )
  assert.equal(out.happy.ready, false)
  assert.equal(out.happy.message, '구간 재확정 필요')
  assert.equal(out.happy.source, 'C:/ref/long.wav')
  assert.deepEqual(out.happy.region, { start: 2, duration: 6 })
})

test('reconstructEmotionRefState: source 소실 → 원본 다시 지정 필요(나머지 보존)', () => {
  const out = reconstructEmotionRefState(
    { happy: 'C:/gone/happy.wav', sad: 'C:/ref/sad.wav' },
    {},
    { happy: 'C:/gone/happy.wav', sad: 'C:/ref/sad.wav' },
    { happy: false, sad: true }
  )
  assert.equal(out.happy.ready, false)
  assert.equal(out.happy.message, '원본 다시 지정 필요')
  assert.equal(out.sad.ready, true)   // 살아있는 감정은 보존
})

test('reconstructReferencePrompts: 살아있는 source의 전사만 복원(snake→camel)', () => {
  const out = reconstructReferencePrompts(
    {
      default: { manual_text: '기본 문장', prompt_lang: 'ko', mode: 'manual' },
      happy: { manual_text: '소실될 문장', mode: 'manual' },
      sad: { mode: 'ref_free', prompt_lang: 'ja' },
    },
    { default: true, happy: false, sad: true }
  )
  assert.deepEqual(out.default, { manualText: '기본 문장', promptLang: 'ko', mode: 'manual' })
  assert.equal(out.happy, undefined)  // source 소실 → 전사 폐기(stale 방지)
  assert.deepEqual(out.sad, { promptLang: 'ja', mode: 'ref_free' })
})

test('restoreSession: TTS 스냅샷을 mode·pitch·source+region·전사·metadata로 복원', () => {
  useAppStore.setState({ ttsEmotionRefState: {}, ttsReferencePrompts: {} })
  const session = {
    mode: 'tts' as const,
    source: 'C:/in/voice.wav',
    metadata: { reference_region: { start: 0, duration: 4 }, requested_engine: 'qwen3' },
    refLiveness: { default: true, happy: true, sad: false },
    options: {
      ttsText: '안녕하세요',
      ttsPitch: 1.5,
      ttsSpeed: 1.2,
      ttsEngine: 'qwen3',
      ttsReferenceOverride: '',  // 기본은 원본 직접 사용 → 준비됨
      ttsEmotionRefSources: { happy: 'C:/ref/happy.wav', sad: 'C:/gone/sad.wav' },
      ttsEmotionRefRegions: { happy: { start: 1, duration: 5 } },
      ttsEmotionRefs: { happy: 'C:/ref/happy.wav' },
      ttsReferencePrompts: { default: { manual_text: '기본', mode: 'manual' }, happy: { manual_text: 'h', mode: 'manual' } },
    },
    tracks: [{ name: 'tts', label: 'tts', path: 'C:/out/tts.wav' }],
  }
  useAppStore.getState().restoreSession('C:/out', session)
  const st = useAppStore.getState()
  assert.equal(st.mode, 'tts')
  assert.equal(st.ttsText, '안녕하세요')
  assert.equal(st.ttsPitch, 1.5)
  assert.equal(st.ttsEngine, 'qwen3')
  assert.equal(st.ttsReferenceClip, '')                 // 파생 override는 항상 비움
  assert.equal(st.ttsRefReady, true)                    // 기본 원본 직접 사용 + 살아있음
  assert.deepEqual(st.ttsReferenceRegion, { start: 0, duration: 4 })
  assert.equal(st.ttsEmotionRefState.happy.ready, true)
  assert.equal(st.ttsEmotionRefState.sad.message, '원본 다시 지정 필요')
  assert.deepEqual(st.ttsReferencePrompts.default, { manualText: '기본', mode: 'manual' })
  assert.equal(st.ttsReferencePrompts.sad, undefined)   // sad source 소실 → 전사 없음
  assert.equal(st.resultMetadata?.requested_engine, 'qwen3')
  assert.equal(st.status, 'done')
})

// ── I3: 세션 마이그레이션(legacy=off 보존 / new=저장값) ──
test('restore: legacy 세션(tail 필드 없음) → tail off·현행으로 강등(자동 마이그레이션 없음)', () => {
  // fresh 상태는 auto지만, 구 세션을 복원하면 off로 강등되어 재현이 조용히 바뀌지 않아야 한다.
  useAppStore.setState({ ttsTailMode: 'auto', ttsEmotionBoundaryMode: 'immediate' })
  const legacy = {
    mode: 'tts' as const,
    source: 'C:/in.wav',
    options: { ttsText: '구 세션', ttsPitch: 0.0 },  // tail/emotion 필드 없음
    tracks: [],
  }
  useAppStore.getState().restoreSession('C:/out', legacy)
  const st = useAppStore.getState()
  assert.equal(st.ttsTailMode, 'off')                 // legacy → off(현행 보존)
  assert.equal(st.ttsTailPaddingMs, 120)
  assert.equal(st.ttsTailFadeMs, 8)
  assert.equal(st.ttsEmotionBoundaryMode, 'pause')    // legacy → 기본 pause
  assert.equal(st.ttsEmotionBoundaryPauseMs, 200)
})

test('restore: new 세션(tail 필드 있음) → 저장값 그대로', () => {
  const s = {
    mode: 'tts' as const,
    source: 'C:/in.wav',
    options: {
      ttsText: '새 세션', ttsPitch: 0.0,
      ttsTailMode: 'auto' as const, ttsTailPaddingMs: 90, ttsTailFadeMs: 12,
      ttsEmotionBoundaryMode: 'immediate' as const, ttsEmotionBoundaryPauseMs: 350,
    },
    tracks: [],
  }
  useAppStore.getState().restoreSession('C:/out', s)
  const st = useAppStore.getState()
  assert.equal(st.ttsTailMode, 'auto')
  assert.equal(st.ttsTailPaddingMs, 90)
  assert.equal(st.ttsTailFadeMs, 12)
  assert.equal(st.ttsEmotionBoundaryMode, 'immediate')
  assert.equal(st.ttsEmotionBoundaryPauseMs, 350)
})

test('setTtsExpression: 부분 갱신(다른 필드 불변)', () => {
  useAppStore.setState({ ttsTailMode: 'auto', ttsTailPaddingMs: 120, ttsEmotionBoundaryMode: 'pause' })
  useAppStore.getState().setTtsExpression({ ttsTailMode: 'off', ttsEmotionBoundaryMode: 'immediate' })
  const st = useAppStore.getState()
  assert.equal(st.ttsTailMode, 'off')
  assert.equal(st.ttsEmotionBoundaryMode, 'immediate')
  assert.equal(st.ttsTailPaddingMs, 120)  // 미지정 필드 불변
})

// ── B2a: 표현형 모드 carrier(store/session) ──
// ⚠️ 이 기능에는 UI 스위치가 없다. 값이 바뀌는 경로는 '세션 복원' 하나뿐이다.

test('B2a: fresh 세션 기본 = legacy_v2', () => {
  useAppStore.getState().reset()
  assert.equal(useAppStore.getState().ttsExpressiveMode, 'legacy_v2')
})

test('B2a: legacy 세션(필드 없음) → legacy_v2, 오류 없음', () => {
  useAppStore.getState().restoreSession('C:/out', {
    mode: 'tts' as const, source: 'C:/in.wav',
    options: { ttsText: '구 세션' },   // ttsExpressiveMode 없음
    tracks: [],
  })
  const st = useAppStore.getState()
  assert.equal(st.ttsExpressiveMode, 'legacy_v2')
  assert.equal(st.error, null)          // 부재는 정상이다 — 조용히 복원해도 된다
  assert.equal(st.errorInfo, null)
})

test('B2a: 저장된 명시값은 그대로 복원된다', () => {
  for (const mode of ['legacy_v2', 'expressive_v3'] as const) {
    useAppStore.getState().restoreSession('C:/out', {
      mode: 'tts' as const, source: 'C:/in.wav',
      options: { ttsText: 'x', ttsExpressiveMode: mode },
      tracks: [],
    })
    const st = useAppStore.getState()
    assert.equal(st.ttsExpressiveMode, mode)
    assert.equal(st.error, null)
  }
})

test('B2a: 계약 밖 값 → 조용한 강등 금지, EXPRESSIVE_MODE_INVALID로 드러난다', () => {
  for (const bad of ['expressive_V3', 'v3', '', 3, true, {}]) {
    useAppStore.getState().restoreSession('C:/out', {
      mode: 'tts' as const, source: 'C:/in.wav',
      options: { ttsText: 'x', ttsExpressiveMode: bad as never },
      tracks: [],
    })
    const st = useAppStore.getState()
    // 안전한 폴백 값은 legacy_v2 — 절대 v3로 승격되지 않는다.
    assert.equal(st.ttsExpressiveMode, 'legacy_v2')
    // 그러나 조용하지 않다: 오류가 실제로 드러나야 한다.
    assert.notEqual(st.error, null, `${typeof bad} 값이 조용히 통과했다`)
    assert.equal(st.errorInfo?.code, 'EXPRESSIVE_MODE_INVALID')
    // 원시값은 담지 않는다(타입 이름만).
    assert.equal(JSON.stringify(st.errorInfo).includes('expressive_V3'), false)
  }
})

test('B2a: 본문 내용이 모드를 바꾸지 않는다(복원 경로)', () => {
  useAppStore.getState().restoreSession('C:/out', {
    mode: 'tts' as const, source: 'C:/in.wav',
    options: { ttsText: '다 끝났다!? 정말...... 그렇구나~ [ㅋㅋ] 마지막.' },  // v3 토큰 가득
    tracks: [],
  })
  assert.equal(useAppStore.getState().ttsExpressiveMode, 'legacy_v2')
})

test('B2a: store에 v3를 켜는 setter가 없다(죽은 스위치 방지)', () => {
  // setTtsExpression 은 tail/emotion 경계만 다룬다. 표현형 모드를 이 경로로 바꿀 수 없어야 한다.
  useAppStore.setState({ ttsExpressiveMode: 'legacy_v2' })
  useAppStore.getState().setTtsExpression({ ttsExpressiveMode: 'expressive_v3' } as never)
  assert.equal(useAppStore.getState().ttsExpressiveMode, 'legacy_v2')
  const api = useAppStore.getState() as unknown as Record<string, unknown>
  assert.equal(typeof api.setTtsExpressiveMode, 'undefined')
})
