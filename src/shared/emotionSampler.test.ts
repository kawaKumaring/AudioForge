// 감정 샘플러 단위테스트 (Agent C 소유). 합성 데이터만 — GPU·모델·오디오·파일 생성 없음.
// 레포 규약대로 EXPLICIT '.ts' 확장자로 import 한다(node --test 가 로더 없이 type-strip 해 실행).
//
// 검증 축:
//   1) 캐시 키 결정성 + 입력 차원별 독립 변화
//   2) hit → 재사용(생성 호출 0), 재생성 차단
//   3) 실패/강등 상태 각각이 서로 다른 문구로 렌더 가능
//   4) '전 감정 일괄 생성' 진입점 부재(소스 파싱 + 런타임 시그니처)
//   5) 문구 버전 bump → 캐시 무효화, 문구 변경 시 버전 강제
//   6) 위생: 경로/전사문/프롬프트가 상태 객체·캐시 키에 들어갈 수 없음
//   7) parity: python/emotion_sampler.py 소스를 파싱해 상수·직렬화·코드 문자열 대조
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMOTION_SAMPLER_KEY_VERSION,
  EMOTION_SAMPLER_PHRASE_VERSION,
  EMOTION_SAMPLER_PHRASES,
  EMOTION_SAMPLER_PHRASE_SET_SHA256,
  EMOTION_SAMPLER_DEFAULT_CONFIG,
  EMOTION_SAMPLER_DISCLAIMER,
  EMOTION_SAMPLER_TITLE,
  EMOTION_SAMPLER_PARITY_INPUT,
  EMOTION_SAMPLER_PARITY_PAYLOAD,
  EMOTION_SAMPLER_PARITY_KEY,
  EMOTION_SAMPLE_STATES,
  EMOTION_SAMPLE_STATE_LABEL,
  EMOTION_SAMPLE_REASON_CODES,
  EMOTION_SAMPLE_REASON_LABEL,
  EMOTION_SAMPLE_STATE_REASONS,
  EMOTION_SAMPLER_INPUT_ERROR_CODES,
  EMOTION_SAMPLER_REJECTION_CODES,
  EmotionSamplerInputError,
  emotionSamplerPhraseScript,
  emotionSamplerPhraseSetDigest,
  samplerSha256Hex,
  voiceFingerprintFromRaw,
  looksPathLike,
  looksTextLike,
  assertSamplerSafeValue,
  assertEmotionSampleTag,
  assertEmotionSampleCacheKey,
  canonicalEmotionSampleKeyPayload,
  canonicalEmotionSampleKeyPayloadAt,
  buildEmotionSampleCacheKey,
  buildEmotionSampleCacheKeyAt,
  initialEmotionSampleEntry,
  applyEmotionSamplerEvent,
  resolveEmotionSampleRequest,
  describeEmotionSample,
  canRegenerateEmotionSample,
  regenerateBlockedNotice,
  isAuditionable,
  hasCachedSample,
  type EmotionSampleKeyInput,
  type EmotionSampleState,
  type EmotionSampleEntry,
  type EmotionSamplerCacheIndex,
} from './emotionSampler.ts'
import { sha256HexOfString, TTS_EMOTION_LABEL_TO_ID } from './ttsGrammar.ts'

// ── 공통 픽스처(전부 합성 값) ────────────────────────────────────────────────
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)

function input(over: Partial<EmotionSampleKeyInput> = {}): EmotionSampleKeyInput {
  return {
    voiceFingerprint: FP_A,
    engineId: 'qwen',
    modelId: 'qwen3-omni-flash',
    emotionId: 'happy',
    config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG },
    ...over,
  }
}
const KEY_A = buildEmotionSampleCacheKey(input())

const MODULE_PATH = fileURLToPath(new URL('./emotionSampler.ts', import.meta.url))
const PY_PATH = fileURLToPath(new URL('../../python/emotion_sampler.py', import.meta.url))
const PANEL_PATH = fileURLToPath(new URL('../renderer/components/EmotionSamplerPanel.tsx', import.meta.url))
const moduleSrc = readFileSync(MODULE_PATH, 'utf-8')
const pySrc = readFileSync(PY_PATH, 'utf-8')
const panelSrc = readFileSync(PANEL_PATH, 'utf-8')

// 주석을 제거한 '실제 코드'만 검사한다 — 설명 주석("'전체 생성'은 두지 않는다" 등)이
// 금지 패턴에 걸려 거짓 실패하는 것을 막는다.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
const panelCode = stripComments(panelSrc)
const moduleCode = stripComments(moduleSrc)
// JSX 화살표 함수(`=>`)가 태그 종료 `>`로 오인되지 않게 치환한 뒤 여는 태그를 뽑는다.
const panelButtonTags = [...panelCode.replace(/=>/g, '__ARROW__').matchAll(/<button[\s\S]*?>/g)].map((m) => m[0])

// ─────────────────────────────────────────────────────────────────────────────
// 1) 캐시 키 — 결정성 · 형식
// ─────────────────────────────────────────────────────────────────────────────

test('캐시 키: 같은 입력 → 항상 같은 64 hex(결정성)', () => {
  assert.match(KEY_A, /^[0-9a-f]{64}$/)
  for (let i = 0; i < 5; i++) assert.equal(buildEmotionSampleCacheKey(input()), KEY_A)
  // 객체 인스턴스가 달라도 값이 같으면 같은 키(참조 동일성에 기대지 않는다).
  assert.equal(buildEmotionSampleCacheKey(JSON.parse(JSON.stringify(input()))), KEY_A)
})

test('캐시 키: canonical payload 는 key 정렬·공백 없음·정수만', () => {
  const payload = canonicalEmotionSampleKeyPayload(input())
  assert.equal(payload, canonicalEmotionSampleKeyPayload(input()))
  assert.ok(!/\s/.test(payload), 'canonical payload 에 공백 없음')
  assert.ok(!/\d\.\d/.test(payload), 'canonical payload 에 float 없음(정수 양자화)')
  const parsed = JSON.parse(payload)
  assert.deepEqual(Object.keys(parsed), [
    'config', 'emotion_id', 'engine_id', 'key_version', 'model_id', 'phrase_version', 'voice_fingerprint',
  ])
  assert.deepEqual(Object.keys(parsed.config), [
    'pitch_centi', 'speed_milli', 'tail_fade_ms', 'tail_mode', 'tail_padding_ms',
  ])
  assert.equal(buildEmotionSampleCacheKey(input()), samplerSha256Hex(payload))
})

test('캐시 키: 고정 parity 벡터(payload/key) 재현', () => {
  assert.equal(canonicalEmotionSampleKeyPayload(EMOTION_SAMPLER_PARITY_INPUT), EMOTION_SAMPLER_PARITY_PAYLOAD)
  assert.equal(buildEmotionSampleCacheKey(EMOTION_SAMPLER_PARITY_INPUT), EMOTION_SAMPLER_PARITY_KEY)
})

// ── 계약 3: 각 입력 차원이 '독립적으로' 키를 바꾼다 ──
test('캐시 키: 목소리 지문만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ voiceFingerprint: FP_B })), KEY_A)
})

test('캐시 키: 엔진 식별자만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ engineId: 'gptsovits' })), KEY_A)
})

test('캐시 키: 모델 식별자만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ modelId: 'qwen3-omni-instruct' })), KEY_A)
})

test('캐시 키: 감정 태그만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ emotionId: 'sad' })), KEY_A)
  // 모든 감정이 서로 다른 키를 갖는다(충돌 없음).
  const ids = [...new Set(Object.values(TTS_EMOTION_LABEL_TO_ID))]
  const keys = new Set(ids.map((id) => buildEmotionSampleCacheKey(input({ emotionId: id }))))
  assert.equal(keys.size, ids.length, '감정별 키 충돌 없음')
})

test('캐시 키: 합성 설정의 각 필드가 독립적으로 키를 바꾼다', () => {
  const base = EMOTION_SAMPLER_DEFAULT_CONFIG
  const variants = [
    { ...base, speed: 1.05 },
    { ...base, pitch: -0.5 },
    { ...base, tailMode: 'off' as const },
    { ...base, tailPaddingMs: 121 },
    { ...base, tailFadeMs: 9 },
  ]
  const seen = new Set<string>([KEY_A])
  for (const config of variants) {
    const k = buildEmotionSampleCacheKey(input({ config }))
    assert.notEqual(k, KEY_A, `config 변경이 키를 바꿔야 함: ${JSON.stringify(config)}`)
    assert.ok(!seen.has(k), 'config 변형끼리도 키가 서로 다름')
    seen.add(k)
  }
})

test('캐시 키: 문구 세트 버전 bump → 키 무효화(계약 5)', () => {
  const bumped = buildEmotionSampleCacheKeyAt(input(), EMOTION_SAMPLER_PHRASE_VERSION + 1, EMOTION_SAMPLER_KEY_VERSION)
  assert.notEqual(bumped, KEY_A)
  // 같은 버전이면 현재 키와 동일(회귀 방지)
  assert.equal(
    buildEmotionSampleCacheKeyAt(input(), EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION),
    KEY_A
  )
})

test('캐시 키: 키 형식 버전 bump → 키 무효화', () => {
  assert.notEqual(
    buildEmotionSampleCacheKeyAt(input(), EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION + 1),
    KEY_A
  )
})

test('캐시 키: 설정 값 범위 위반은 조용한 clamp 가 아니라 예외', () => {
  const bad = [
    { speed: 0.4 }, { speed: 2.1 }, { pitch: -2.5 }, { pitch: 2.5 },
    { tailPaddingMs: 301 }, { tailPaddingMs: -1 }, { tailFadeMs: 21 },
    { tailPaddingMs: 120.5 }, { tailFadeMs: 8.5 },
  ]
  for (const patch of bad) {
    assert.throws(
      () => buildEmotionSampleCacheKey(input({ config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG, ...patch } })),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_INVALID_CONFIG',
      `범위 밖 설정 거부: ${JSON.stringify(patch)}`
    )
  }
  assert.throws(
    () => buildEmotionSampleCacheKey(input({ config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG, tailMode: 'weird' as never } })),
    (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_INVALID_CONFIG'
  )
})

test('캐시 키: 양자화는 half-away-from-zero(부호 대칭)', () => {
  // -0 이 0 으로 정규화되어 -0.001 과 0 이 같은 키가 되는지(그리고 payload 에 "-0" 이 없는지) 확인.
  const zero = canonicalEmotionSampleKeyPayload(input({ config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG, pitch: 0 } }))
  assert.ok(zero.includes('"pitch_centi":0'))
  assert.ok(!zero.includes('-0,') && !zero.includes(':-0'), 'payload 에 -0 없음')
  const neg = canonicalEmotionSampleKeyPayload(input({ config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG, pitch: -1.5 } }))
  assert.ok(neg.includes('"pitch_centi":-150'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 표준 문구 세트 — 짧고 중립적, 버전 강제
// ─────────────────────────────────────────────────────────────────────────────

test('문구 세트: 짧고 고정. 지문이 상수와 일치(문구를 바꿨다면 PHRASE_VERSION 을 올리고 상수를 갱신할 것)', () => {
  assert.ok(EMOTION_SAMPLER_PHRASES.length >= 1 && EMOTION_SAMPLER_PHRASES.length <= 4, '문구 세트는 짧게 유지')
  for (const p of EMOTION_SAMPLER_PHRASES) {
    assert.ok(p.length > 0 && p.length <= 40, '각 문구는 짧게')
  }
  assert.ok(emotionSamplerPhraseScript().length <= 80, '표준 대본 전체가 짧아야 한다(미리듣기용)')
  assert.equal(emotionSamplerPhraseSetDigest(), EMOTION_SAMPLER_PHRASE_SET_SHA256)
})

test('문구 세트: 감정 라벨/태그 문자열을 포함하지 않는다(중립성)', () => {
  const script = emotionSamplerPhraseScript()
  for (const label of Object.keys(TTS_EMOTION_LABEL_TO_ID)) {
    if (label.length < 2) continue
    assert.ok(!script.includes(`[${label}]`), `표준 문구에 감정 태그가 없어야 함: ${label}`)
  }
})

test('문구 세트: 문구 텍스트는 캐시 키 입력에 들어가지 않는다(버전만)', () => {
  const payload = canonicalEmotionSampleKeyPayload(input())
  for (const p of EMOTION_SAMPLER_PHRASES) assert.ok(!payload.includes(p), '문구 원문이 키 입력에 없음')
  assert.ok(payload.includes('"phrase_version":'), '버전은 키 입력에 있음')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 상태 / 사유 코드 — 각각 구별되고 렌더 가능
// ─────────────────────────────────────────────────────────────────────────────

test('상태/사유: 코드 집합과 라벨이 1:1, 라벨은 서로 다르고 비어있지 않다', () => {
  assert.equal(new Set(EMOTION_SAMPLE_STATES).size, EMOTION_SAMPLE_STATES.length)
  assert.equal(new Set(EMOTION_SAMPLE_REASON_CODES).size, EMOTION_SAMPLE_REASON_CODES.length)
  const stateLabels = EMOTION_SAMPLE_STATES.map((s) => EMOTION_SAMPLE_STATE_LABEL[s])
  assert.equal(new Set(stateLabels).size, stateLabels.length, '상태 라벨이 서로 구별됨')
  for (const l of stateLabels) assert.ok(l.trim().length > 0)
  const reasonLabels = EMOTION_SAMPLE_REASON_CODES.map((r) => EMOTION_SAMPLE_REASON_LABEL[r])
  assert.equal(new Set(reasonLabels).size, reasonLabels.length, '사유 라벨이 서로 구별됨')
  for (const l of reasonLabels) assert.ok(l.trim().length > 0)
})

test('상태/사유: 사유 코드는 정확히 한 상태에만 속한다', () => {
  const seen = new Map<string, string>()
  for (const s of EMOTION_SAMPLE_STATES) {
    for (const r of EMOTION_SAMPLE_STATE_REASONS[s]) {
      assert.ok(!seen.has(r), `사유 ${r} 가 ${seen.get(r)} 와 ${s} 에 중복 배정됨`)
      seen.set(r, s)
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...EMOTION_SAMPLE_REASON_CODES].sort())
  // 계약 4가 요구하는 세 갈래가 각각 '이름 있는' 상태로 존재한다.
  assert.ok(EMOTION_SAMPLE_STATES.includes('failed'), '생성 실패')
  assert.ok(EMOTION_SAMPLE_STATES.includes('limitExceeded'), '생성 한도 초과')
  assert.ok(EMOTION_SAMPLE_STATES.includes('degraded'), 'x-vector-only 강등')
  assert.deepEqual([...EMOTION_SAMPLE_STATE_REASONS.limitExceeded], ['SAMPLER_GENERATION_LIMIT'])
  assert.deepEqual([...EMOTION_SAMPLE_STATE_REASONS.degraded], ['SAMPLER_XVECTOR_ONLY'])
})

test('모든 상태가 서로 다른 표시로 렌더 가능(조용한 무표시 없음)', () => {
  const rendered: string[] = []
  for (const state of EMOTION_SAMPLE_STATES) {
    const reasons = EMOTION_SAMPLE_STATE_REASONS[state]
    const cases: (typeof reasons[number] | null)[] = reasons.length > 0 ? [...reasons] : [null]
    for (const reason of cases) {
      const entry: EmotionSampleEntry = { emotionId: 'happy', state, reason, cacheKey: KEY_A }
      const v = describeEmotionSample(entry)
      assert.ok(v.stateLabel.trim().length > 0, `${state}: 상태 문구 존재`)
      assert.equal(v.state, state)
      assert.equal(v.reason, reason)
      if (reason) assert.ok((v.reasonLabel ?? '').trim().length > 0, `${state}/${reason}: 사유 문구 존재`)
      else assert.equal(v.reasonLabel, null)
      assert.ok(v.generateLabel.trim().length > 0)
      // 비활성이면 반드시 설명 문장이 있다(회색 처리만으로 끝내지 않는다).
      if (!v.generateEnabled) assert.ok((v.generateNotice ?? '').trim().length > 0, `${state}: 비활성 사유 문장 필요`)
      else assert.equal(v.generateNotice, null, `${state}: 활성이면 사유 없음`)
      rendered.push(`${v.stateLabel}|${v.reasonLabel ?? ''}|${v.generateLabel}|${v.generateNotice ?? ''}|${v.tone}`)
    }
  }
  assert.equal(new Set(rendered).size, rendered.length, '모든 상태/사유 조합의 표시가 서로 구별됨')
})

test('실패 3종(실패/한도초과/강등)은 서로 다른 상태·문구·톤을 갖는다', () => {
  const mk = (state: EmotionSampleState, reason: EmotionSampleEntry['reason']) =>
    describeEmotionSample({ emotionId: 'happy', state, reason, cacheKey: KEY_A })
  const failed = mk('failed', 'SAMPLER_ENGINE_ERROR')
  const limit = mk('limitExceeded', 'SAMPLER_GENERATION_LIMIT')
  const degraded = mk('degraded', 'SAMPLER_XVECTOR_ONLY')
  const labels = [failed.stateLabel, limit.stateLabel, degraded.stateLabel]
  assert.equal(new Set(labels).size, 3)
  assert.equal(new Set([failed.reasonLabel, limit.reasonLabel, degraded.reasonLabel]).size, 3)
  // 한도 초과는 결과를 버렸으므로 재생 불가, 강등은 재생 가능(품질 경고).
  assert.equal(limit.auditionEnabled, false)
  assert.equal(degraded.auditionEnabled, true)
  assert.equal(failed.auditionEnabled, false)
  assert.equal(degraded.tone, 'warn')
  assert.equal(limit.tone, 'error')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) 상태 기계 — 자동 재시도 없음, 거부는 코드로 드러남
// ─────────────────────────────────────────────────────────────────────────────

test('상태 기계: 정상 흐름 idle → generating → ready', () => {
  const e0 = initialEmotionSampleEntry('happy', KEY_A)
  assert.equal(e0.state, 'idle')
  assert.equal(e0.reason, null)
  const t1 = applyEmotionSamplerEvent(e0, { type: 'GENERATE_REQUESTED' })
  assert.ok(t1.applied)
  assert.equal(t1.entry.state, 'generating')
  const t2 = applyEmotionSamplerEvent(t1.entry, { type: 'GENERATE_SUCCEEDED' })
  assert.equal(t2.entry.state, 'ready')
  assert.equal(t2.entry.reason, null)
  assert.equal(t2.entry.cacheKey, KEY_A, '키는 전이로 바뀌지 않는다')
})

test('상태 기계: x-vector-only 성공은 degraded + 전용 사유', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_SUCCEEDED', degraded: true })
  assert.equal(t.entry.state, 'degraded')
  assert.equal(t.entry.reason, 'SAMPLER_XVECTOR_ONLY')
})

test('상태 기계: 생성 한도 초과는 limitExceeded + 전용 사유(재생 불가)', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_LIMIT_EXCEEDED' })
  assert.equal(t.entry.state, 'limitExceeded')
  assert.equal(t.entry.reason, 'SAMPLER_GENERATION_LIMIT')
  assert.equal(isAuditionable(t.entry.state), false)
})

test('상태 기계: 실패 사유가 failed 집합 밖이면 UNKNOWN 으로 강제(조용한 무표시 금지)', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_FAILED', reason: 'SAMPLER_XVECTOR_ONLY' })
  assert.equal(t.entry.state, 'failed')
  assert.equal(t.entry.reason, 'SAMPLER_UNKNOWN')
  assert.ok((describeEmotionSample(t.entry).reasonLabel ?? '').length > 0)
})

test('상태 기계: 실패 후 자동 재시도 없음 — 사용자가 다시 눌러야 generating 이 된다', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const failed = applyEmotionSamplerEvent(gen, { type: 'GENERATE_FAILED', reason: 'SAMPLER_ENGINE_ERROR' }).entry
  assert.equal(failed.state, 'failed')
  // 아무 이벤트도 없으면 계속 failed
  assert.equal(applyEmotionSamplerEvent(failed, { type: 'GENERATE_SUCCEEDED' }).rejected, 'INVALID_EVENT')
  assert.equal(applyEmotionSamplerEvent(failed, { type: 'GENERATE_SUCCEEDED' }).entry.state, 'failed')
  // 명시 재요청만 다시 시작시킨다
  assert.equal(applyEmotionSamplerEvent(failed, { type: 'GENERATE_REQUESTED' }).entry.state, 'generating')
  // 모듈에 타이머(자동 재시도 통로)가 없다
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(moduleCode), '자동 재시도 타이머 없음')
})

test('상태 기계: 거부 전이는 조용히 삼키지 않고 rejected 코드로 드러난다', () => {
  const idle = initialEmotionSampleEntry('happy', KEY_A)
  const generating = applyEmotionSamplerEvent(idle, { type: 'GENERATE_REQUESTED' }).entry
  const ready = applyEmotionSamplerEvent(generating, { type: 'GENERATE_SUCCEEDED' }).entry

  const r1 = applyEmotionSamplerEvent(generating, { type: 'GENERATE_REQUESTED' })
  assert.equal(r1.applied, false)
  assert.equal(r1.rejected, 'ALREADY_GENERATING')
  assert.deepEqual(r1.entry, generating, '거부 시 상태 불변')

  const r2 = applyEmotionSamplerEvent(ready, { type: 'GENERATE_REQUESTED' })
  assert.equal(r2.rejected, 'CACHED_SAMPLE_EXISTS')

  const r3 = applyEmotionSamplerEvent(idle, { type: 'DELETED' })
  assert.equal(r3.rejected, 'NO_SAMPLE_TO_DELETE')

  for (const code of [r1.rejected, r2.rejected, r3.rejected]) {
    assert.ok(EMOTION_SAMPLER_REJECTION_CODES.includes(code as never))
  }
})

test('상태 기계: 불변식 applied === (rejected === null) 이 모든 상태×이벤트에서 성립', () => {
  const events = [
    { type: 'GENERATE_REQUESTED' as const },
    { type: 'GENERATE_SUCCEEDED' as const },
    { type: 'GENERATE_SUCCEEDED' as const, degraded: true },
    { type: 'GENERATE_FAILED' as const, reason: 'SAMPLER_ENGINE_ERROR' as const },
    { type: 'GENERATE_LIMIT_EXCEEDED' as const },
    { type: 'CACHE_HIT' as const },
    { type: 'CACHE_HIT' as const, degraded: true },
    { type: 'DELETED' as const },
    { type: 'KEY_CHANGED' as const, cacheKey: buildEmotionSampleCacheKey(input({ voiceFingerprint: FP_B })) },
  ]
  for (const state of EMOTION_SAMPLE_STATES) {
    const reason = EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null
    const entry: EmotionSampleEntry = { emotionId: 'happy', state, reason, cacheKey: KEY_A }
    for (const ev of events) {
      const t = applyEmotionSamplerEvent(entry, ev)
      assert.equal(t.applied, t.rejected === null, `${state} × ${ev.type}`)
      assert.ok(EMOTION_SAMPLE_STATES.includes(t.entry.state), '항상 유효 상태')
      const allowed = EMOTION_SAMPLE_STATE_REASONS[t.entry.state]
      if (t.entry.reason === null) assert.equal(allowed.length === 0 || t.applied === false, true)
      else assert.ok(allowed.includes(t.entry.reason), `${t.entry.state} 의 사유는 허용 집합 안`)
    }
  }
})

test('상태 기계: 목소리/설정 변경(KEY_CHANGED) → 새 키 + 미생성 복귀', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('happy', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const ready = applyEmotionSamplerEvent(gen, { type: 'GENERATE_SUCCEEDED' }).entry
  const newKey = buildEmotionSampleCacheKey(input({ voiceFingerprint: FP_B }))
  const t = applyEmotionSamplerEvent(ready, { type: 'KEY_CHANGED', cacheKey: newKey })
  assert.ok(t.applied)
  assert.equal(t.entry.state, 'idle')
  assert.equal(t.entry.reason, null)
  assert.equal(t.entry.cacheKey, newKey)
  assert.equal(canRegenerateEmotionSample(t.entry.state), true, '설정을 바꾸면 다시 만들 수 있다')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5) 캐시 hit → 재사용, 재생성 없음
// ─────────────────────────────────────────────────────────────────────────────

test('캐시 hit: 같은 키면 재사용하고 생성 호출이 0회', () => {
  const cache: EmotionSamplerCacheIndex = { [KEY_A]: { degraded: false } }
  let generateCalls = 0
  const run = (emotionId: string, key: string) => {
    const plan = resolveEmotionSampleRequest(emotionId, key, cache)
    if (plan.action === 'generate') generateCalls += 1
    return plan
  }
  const p1 = run('happy', KEY_A)
  assert.equal(p1.action, 'reuse')
  assert.equal(p1.entry.state, 'ready')
  const p2 = run('happy', KEY_A)
  assert.equal(p2.action, 'reuse')
  assert.equal(generateCalls, 0, 'hit 이면 합성을 호출하지 않는다')

  // miss 일 때만 생성
  const otherKey = buildEmotionSampleCacheKey(input({ emotionId: 'sad' }))
  const p3 = run('sad', otherKey)
  assert.equal(p3.action, 'generate')
  assert.equal(p3.entry.state, 'idle')
  assert.equal(generateCalls, 1)
})

test('캐시 hit: 강등 샘플도 재사용되며 degraded 로 복원된다', () => {
  const cache: EmotionSamplerCacheIndex = { [KEY_A]: { degraded: true } }
  const plan = resolveEmotionSampleRequest('happy', KEY_A, cache)
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.entry.state, 'degraded')
  assert.equal(plan.entry.reason, 'SAMPLER_XVECTOR_ONLY')
})

test('캐시 hit: 유효 캐시가 있으면 재생성 버튼이 비활성 + 이유 문장 제공', () => {
  for (const state of ['ready', 'degraded'] as const) {
    assert.equal(canRegenerateEmotionSample(state), false)
    assert.equal(hasCachedSample(state), true)
    const notice = regenerateBlockedNotice(state)
    assert.ok(notice && notice.length > 10, `${state}: 비활성 이유가 문장으로 제공됨`)
    assert.ok(/다시 만들 수 없습니다/.test(notice), '왜 못 만드는지 명시')
    assert.ok(/바꾸면|설정/.test(notice), '어떻게 하면 만들 수 있는지 안내')
  }
  for (const state of ['idle', 'failed', 'limitExceeded'] as const) {
    assert.equal(canRegenerateEmotionSample(state), true)
    assert.equal(regenerateBlockedNotice(state), null)
  }
  assert.equal(canRegenerateEmotionSample('generating'), false)
  assert.ok((regenerateBlockedNotice('generating') ?? '').length > 0)
})

test('캐시: 문구 버전이 올라가면 기존 캐시가 hit 되지 않는다(무효화)', () => {
  const cache: EmotionSamplerCacheIndex = { [KEY_A]: { degraded: false } }
  const bumpedKey = buildEmotionSampleCacheKeyAt(input(), EMOTION_SAMPLER_PHRASE_VERSION + 1, EMOTION_SAMPLER_KEY_VERSION)
  assert.equal(resolveEmotionSampleRequest('happy', bumpedKey, cache).action, 'generate')
})

// ─────────────────────────────────────────────────────────────────────────────
// 6) 계약 1 — '전 감정 일괄 생성' 진입점이 존재하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

test('일괄 생성 금지: 모듈에 bulk/all 진입점이 없다(소스 파싱)', () => {
  const exportNames = [...moduleSrc.matchAll(/^export\s+(?:const|function|class|type|interface)\s+(\w+)/gm)]
    .map((m) => m[1])
  assert.ok(exportNames.length > 0, 'export 를 찾지 못함(파싱 실패)')
  for (const n of exportNames) {
    assert.ok(
      !/(All|Bulk|Batch|Every|Each)(Emotion|Sample|Tag)|generateAll|sampleAll|Bulk|Batch/.test(n),
      `일괄 생성 진입점 금지: ${n}`
    )
  }
  // 감정 목록을 받는 시그니처가 없다.
  assert.ok(!/emotionIds\s*:/.test(moduleSrc), 'emotionIds 배열 파라미터 없음')
  assert.ok(!/emotionId\s*:\s*(readonly\s+)?string\[\]/.test(moduleSrc), 'emotionId 배열 파라미터 없음')
  assert.ok(!/Promise\.all/.test(moduleCode), '팬아웃 통로(Promise.all) 없음')
  // 모듈은 전체 감정표를 알지도 않는다(전 감정 순회 자체가 불가능).
  assert.ok(!/ALL_EMOTIONS|EMOTION_GROUPS|TTS_EMOTION_LABEL_TO_ID/.test(moduleCode), '전체 감정 목록 미보유')
})

test('일괄 생성 금지: 생성 관련 함수는 감정 태그를 정확히 하나만 받는다(런타임)', () => {
  // 시그니처: 첫 인자 = 감정 하나. 배열/객체를 주면 즉시 실패한다.
  assert.equal(buildEmotionSampleCacheKey.length, 1)
  assert.equal(resolveEmotionSampleRequest.length, 3)
  assert.equal(initialEmotionSampleEntry.length, 2)

  for (const bogus of [['happy', 'sad'], { 0: 'happy' }, 3, null, undefined, '']) {
    assert.throws(
      () => assertEmotionSampleTag(bogus as never),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_INVALID_EMOTION_ID',
      `감정 태그가 아닌 입력 거부: ${JSON.stringify(bogus)}`
    )
    assert.throws(() => initialEmotionSampleEntry(bogus as never, KEY_A))
    assert.throws(() => resolveEmotionSampleRequest(bogus as never, KEY_A, {}))
    assert.throws(() => buildEmotionSampleCacheKey(input({ emotionId: bogus as never })))
  }
})

test('일괄 생성 금지: 패널에도 전체 생성 버튼/팬아웃이 없다(소스 파싱)', () => {
  assert.ok(!/Promise\.all/.test(panelCode), '패널에 Promise.all 없음')
  assert.ok(!/forEach\s*\([^)]*onGenerate/.test(panelCode), '패널에 onGenerate 팬아웃 없음')
  assert.ok(!/(전체|모두|일괄|한꺼번에)\s*(생성|만들기)/.test(panelCode), '전체 생성 버튼 문구 없음')
  // onGenerate 호출은 전부 '감정 하나' 형태다.
  const calls = [...panelCode.matchAll(/onGenerate\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(calls.length > 0, 'onGenerate 호출을 찾지 못함(파싱 실패)')
  for (const c of calls) {
    assert.ok(!c.includes(','), `onGenerate 인자는 하나: ${c}`)
    assert.match(c, /^[\w.]+$/, `onGenerate 인자는 단일 식별자: ${c}`)
  }
  // props 계약도 단일 태그
  assert.match(panelCode, /onGenerate:\s*\(emotionId:\s*string\)\s*=>\s*void/)
})

// ─────────────────────────────────────────────────────────────────────────────
// 7) 위생 — 경로·전사문·프롬프트가 상태/키에 들어갈 수 없다(계약 6)
// ─────────────────────────────────────────────────────────────────────────────

const PATHY = [
  'E:/AI/models/voice.wav',
  'E:\\AI\\models\\voice.wav',
  '/home/user/ref.wav',
  'C:/Users/kawae/ref',
  '../../secret',
  '~/voice',
  'file:///tmp/a',
  'reference.wav',
]
const TEXTY = [
  '안녕하세요 반갑습니다',
  '오늘 날씨가 좋네요.',
  'hello world',
  '기쁨',
]

test('위생: 경로처럼 보이는 값은 캐시 키 입력에서 거부된다', () => {
  for (const p of PATHY) {
    assert.equal(looksPathLike(p), true, `경로 판정: ${p}`)
    assert.throws(
      () => assertSamplerSafeValue('x', p),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_PATH_LIKE_VALUE'
    )
    for (const field of ['engineId', 'modelId'] as const) {
      assert.throws(
        () => buildEmotionSampleCacheKey(input({ [field]: p } as Partial<EmotionSampleKeyInput>)),
        (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_PATH_LIKE_VALUE',
        `${field} 에 경로 금지: ${p}`
      )
    }
    assert.throws(
      () => buildEmotionSampleCacheKey(input({ voiceFingerprint: p })),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_PATH_LIKE_VALUE'
    )
  }
})

test('위생: 문장/전사문처럼 보이는 값은 캐시 키 입력에서 거부된다', () => {
  for (const t of TEXTY) {
    assert.equal(looksTextLike(t), true, `문장 판정: ${t}`)
    assert.throws(
      () => assertSamplerSafeValue('x', t),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_TEXT_LIKE_VALUE'
    )
    assert.throws(
      () => buildEmotionSampleCacheKey(input({ modelId: t })),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_TEXT_LIKE_VALUE'
    )
  }
  // 표준 문구 자체도 키 입력이 될 수 없다.
  for (const p of EMOTION_SAMPLER_PHRASES) {
    assert.throws(() => assertSamplerSafeValue('phrase', p))
  }
})

test('위생: 상태 객체는 문자열 필드 전부가 안전 값이며 경로/문장을 담지 않는다', () => {
  const cases: EmotionSampleEntry[] = EMOTION_SAMPLE_STATES.map((state) => ({
    emotionId: 'happy',
    state,
    reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null,
    cacheKey: KEY_A,
  }))
  for (const entry of cases) {
    assert.deepEqual(Object.keys(entry).sort(), ['cacheKey', 'emotionId', 'reason', 'state'])
    assertSamplerSafeValue('emotionId', entry.emotionId)
    assertSamplerSafeValue('state', entry.state)
    assertSamplerSafeValue('cacheKey', entry.cacheKey)
    if (entry.reason) assertSamplerSafeValue('reason', entry.reason)
    const json = JSON.stringify(entry)
    assert.ok(!/[\\/]|[A-Za-z]:\\|\.wav|\.mp3/.test(json), `상태 객체에 경로 흔적 없음: ${json}`)
    for (const p of EMOTION_SAMPLER_PHRASES) assert.ok(!json.includes(p), '상태 객체에 문구 원문 없음')
  }
})

test('위생: 파생 표시 객체에도 경로·문구 원문이 없다', () => {
  for (const state of EMOTION_SAMPLE_STATES) {
    const v = describeEmotionSample({
      emotionId: 'happy', state, reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null, cacheKey: KEY_A,
    })
    const json = JSON.stringify(v)
    assert.ok(!/[\\/]|\.wav|\.mp3|file:/.test(json), `표시 객체에 경로 없음: ${state}`)
    for (const p of EMOTION_SAMPLER_PHRASES) assert.ok(!json.includes(p), '표시 객체에 문구 원문 없음')
  }
})

test('위생: 캐시 키 문자열/직렬화는 순수 hex·토큰만 담는다', () => {
  const payload = canonicalEmotionSampleKeyPayload(input())
  assert.ok(!/[\\/]/.test(payload.replace(/\\"/g, '')), 'payload 에 경로 구분자 없음')
  assert.ok(!/[가-힣]/.test(payload), 'payload 에 한글 없음')
  assert.match(buildEmotionSampleCacheKey(input()), /^[0-9a-f]{64}$/)
})

test('위생: 오류 메시지는 코드+필드명만 담고 위반 값을 노출하지 않는다', () => {
  const secret = 'E:/AI/secret_voice.wav'
  try {
    buildEmotionSampleCacheKey(input({ modelId: secret }))
    assert.fail('예외 기대')
  } catch (e) {
    assert.ok(e instanceof EmotionSamplerInputError)
    assert.ok(!e.message.includes(secret), '오류 메시지에 위반 값 미포함')
    assert.ok(e.message.includes('SAMPLER_PATH_LIKE_VALUE'))
    assert.ok(e.message.includes('modelId'))
    assert.ok(EMOTION_SAMPLER_INPUT_ERROR_CODES.includes(e.code))
  }
})

test('위생: voiceFingerprintFromRaw 가 경로 포함 원시 지문을 불투명 hex 로 바꾼다', () => {
  const raw = 'E:/AI/voice.wav|123456|1700000000000'
  const fp = voiceFingerprintFromRaw(raw)
  assert.match(fp, /^[0-9a-f]{64}$/)
  assert.ok(!fp.includes('E:'))
  assert.equal(voiceFingerprintFromRaw(raw), fp, '결정적')
  assert.notEqual(voiceFingerprintFromRaw(raw + 'x'), fp)
  // 원시 지문을 그대로 넣으면 거부된다(통합 담당 실수 방지).
  assert.throws(() => buildEmotionSampleCacheKey(input({ voiceFingerprint: raw })))
  // 변환한 값은 정상 동작
  assert.match(buildEmotionSampleCacheKey(input({ voiceFingerprint: fp })), /^[0-9a-f]{64}$/)
  assert.throws(() => voiceFingerprintFromRaw(''))
})

test('위생: 캐시 키 형식 검증(64 hex 만)', () => {
  assert.equal(assertEmotionSampleCacheKey(KEY_A), KEY_A)
  for (const bad of ['', 'zz', KEY_A.toUpperCase(), KEY_A + 'a', 'E:/x', 123 as never, null as never]) {
    assert.throws(
      () => assertEmotionSampleCacheKey(bad),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_INVALID_CACHE_KEY'
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 8) 드리프트 가드 — sha256 / 감정 id 어휘
// ─────────────────────────────────────────────────────────────────────────────

test('드리프트: samplerSha256Hex 가 표준 벡터와 ttsGrammar 구현에 일치', () => {
  assert.equal(samplerSha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(samplerSha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  for (const s of ['', 'abc', '안녕하세요', KEY_A, canonicalEmotionSampleKeyPayload(input()), 'x'.repeat(1000)]) {
    assert.equal(samplerSha256Hex(s), sha256HexOfString(s), 'ttsGrammar 사본과 동일해야 함')
  }
})

test('드리프트: 공용 감정표의 모든 id 가 샘플러 태그 검증을 통과', () => {
  const ids = [...new Set(Object.values(TTS_EMOTION_LABEL_TO_ID))]
  assert.ok(ids.length >= 40, '감정표를 읽지 못함')
  for (const id of ids) assert.equal(assertEmotionSampleTag(id), id, `감정 id 검증 통과: ${id}`)
  // 한글 label 은 태그로 쓸 수 없다(id 만 흐른다).
  for (const label of Object.keys(TTS_EMOTION_LABEL_TO_ID)) {
    if (/^[a-z]+$/.test(label)) continue
    assert.throws(() => assertEmotionSampleTag(label), `한글 label 거부: ${label}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 9) PARITY — python/emotion_sampler.py 소스를 파싱해 대조(레포의 parity-by-parsing 선례)
// ─────────────────────────────────────────────────────────────────────────────

function pyInt(name: string): number {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*(-?\\d+)\\s*$`, 'm'))
  assert.ok(m, `python 상수 ${name} 을 찾지 못함`)
  return Number(m![1])
}
function pyStr(name: string): string {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'))
  assert.ok(m, `python 문자열 상수 ${name} 을 찾지 못함`)
  return m![1] !== undefined ? m![1] : m![2]
}
function pyTuple(name: string): string[] {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)^\\)`, 'm'))
  assert.ok(m, `python 튜플 ${name} 을 찾지 못함`)
  return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1])
}
function pyDict(name: string): Record<string, string> {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*\\{([\\s\\S]*?)^\\}`, 'm'))
  assert.ok(m, `python 딕셔너리 ${name} 을 찾지 못함`)
  const out: Record<string, string> = {}
  for (const kv of m![1].matchAll(/"([^"]*)"\s*:\s*"([^"]*)"/g)) out[kv[1]] = kv[2]
  return out
}

test('parity: 버전 상수가 TS==Python', () => {
  assert.equal(pyInt('EMOTION_SAMPLER_KEY_VERSION'), EMOTION_SAMPLER_KEY_VERSION)
  assert.equal(pyInt('EMOTION_SAMPLER_PHRASE_VERSION'), EMOTION_SAMPLER_PHRASE_VERSION)
})

test('parity: 표준 문구 세트와 지문이 TS==Python', () => {
  assert.deepEqual(pyTuple('EMOTION_SAMPLER_PHRASES'), [...EMOTION_SAMPLER_PHRASES])
  assert.equal(pyStr('EMOTION_SAMPLER_PHRASE_SET_SHA256'), EMOTION_SAMPLER_PHRASE_SET_SHA256)
})

test('parity: canonical 직렬화가 바이트 동일(고정 벡터)', () => {
  assert.equal(pyStr('EMOTION_SAMPLER_PARITY_PAYLOAD'), EMOTION_SAMPLER_PARITY_PAYLOAD)
  assert.equal(pyStr('EMOTION_SAMPLER_PARITY_KEY'), EMOTION_SAMPLER_PARITY_KEY)
  // TS 구현이 그 payload/key 를 실제로 재현한다(Python 쪽은 test_emotion_sampler.py 가 동일 검증).
  assert.equal(canonicalEmotionSampleKeyPayload(EMOTION_SAMPLER_PARITY_INPUT), EMOTION_SAMPLER_PARITY_PAYLOAD)
  assert.equal(samplerSha256Hex(EMOTION_SAMPLER_PARITY_PAYLOAD), EMOTION_SAMPLER_PARITY_KEY)
})

test('parity: 상태/사유/거부/오류 코드 문자열이 TS==Python', () => {
  assert.deepEqual(pyTuple('EMOTION_SAMPLE_STATES'), [...EMOTION_SAMPLE_STATES])
  assert.deepEqual(pyTuple('EMOTION_SAMPLE_REASON_CODES'), [...EMOTION_SAMPLE_REASON_CODES])
  assert.deepEqual(pyTuple('EMOTION_SAMPLER_REJECTION_CODES'), [...EMOTION_SAMPLER_REJECTION_CODES])
  assert.deepEqual(pyTuple('EMOTION_SAMPLER_INPUT_ERROR_CODES'), [...EMOTION_SAMPLER_INPUT_ERROR_CODES])
})

test('parity: 상태/사유 라벨 문자열이 TS==Python', () => {
  const st = pyDict('EMOTION_SAMPLE_STATE_LABEL')
  for (const s of EMOTION_SAMPLE_STATES) assert.equal(st[s], EMOTION_SAMPLE_STATE_LABEL[s], `상태 라벨 ${s}`)
  assert.equal(Object.keys(st).length, EMOTION_SAMPLE_STATES.length)
  const rs = pyDict('EMOTION_SAMPLE_REASON_LABEL')
  for (const r of EMOTION_SAMPLE_REASON_CODES) assert.equal(rs[r], EMOTION_SAMPLE_REASON_LABEL[r], `사유 라벨 ${r}`)
  assert.equal(Object.keys(rs).length, EMOTION_SAMPLE_REASON_CODES.length)
})

test('parity: 안내 문구/제목이 TS==Python', () => {
  assert.equal(pyStr('EMOTION_SAMPLER_DISCLAIMER'), EMOTION_SAMPLER_DISCLAIMER)
  assert.equal(pyStr('EMOTION_SAMPLER_TITLE'), EMOTION_SAMPLER_TITLE)
})

test('parity: Python 쪽에도 일괄 생성 진입점이 없다', () => {
  const defs = [...pySrc.matchAll(/^def\s+(\w+)\s*\(([^)]*)\)/gm)].map((m) => ({ name: m[1], args: m[2] }))
  assert.ok(defs.length > 0, 'python def 를 찾지 못함')
  for (const d of defs) {
    assert.ok(!/all|bulk|batch|every/i.test(d.name), `일괄 진입점 금지: ${d.name}`)
    assert.ok(!/emotion_ids/.test(d.args), `감정 목록 파라미터 금지: ${d.name}`)
  }
  assert.ok(!/EMOTION_TAGS|ALL_EMOTIONS/.test(pySrc), 'python 모듈도 전체 감정표를 갖지 않음')
})

// ─────────────────────────────────────────────────────────────────────────────
// 10) 패널 계약 — 감정 참조 등록과의 구분, 표시 로직 단일 소스
// ─────────────────────────────────────────────────────────────────────────────

test('패널: props-only(스토어/IPC import 없음)', () => {
  assert.ok(!/from '@\/stores|app\.store|useAppStore/.test(panelCode), '스토어 import 없음')
  assert.ok(!/window\.api|ipcRenderer|electron/.test(panelCode), '자체 IPC 없음')
  assert.ok(!/from 'node:|require\(/.test(panelCode), 'node/fs 의존 없음')
})

test('패널: 상태 표시를 shared 파생(describeEmotionSample)에 위임', () => {
  assert.ok(panelCode.includes('describeEmotionSample'), '표시 로직 단일 소스 사용')
  assert.ok(panelCode.includes('EMOTION_SAMPLER_DISCLAIMER'), '샘플러 안내 문구 렌더')
  assert.ok(panelCode.includes('EMOTION_SAMPLER_TITLE'), '패널 제목은 감정 샘플러')
  // 상태 라벨/사유 라벨을 패널이 다시 하드코딩하지 않는다.
  for (const s of EMOTION_SAMPLE_STATES) {
    assert.ok(!panelCode.includes(`'${EMOTION_SAMPLE_STATE_LABEL[s]}'`), `상태 라벨 하드코딩 금지: ${s}`)
  }
  for (const r of EMOTION_SAMPLE_REASON_CODES) {
    assert.ok(!panelCode.includes(EMOTION_SAMPLE_REASON_LABEL[r]), `사유 라벨 하드코딩 금지: ${r}`)
  }
})

test('패널: 감정 참조 등록과 혼동되는 문구/경로가 없다', () => {
  assert.ok(!/전용 목소리 등록|등록 필요|기본 목소리 사용/.test(panelCode), '감정 참조 등록 상태 문구 없음')
  assert.ok(!/onRegister|registerEmotionRef/.test(panelCode), '참조 등록 콜백/경로 없음')
  assert.match(EMOTION_SAMPLER_DISCLAIMER, /미리듣기/, '미리듣기 전용임을 명시')
  assert.match(EMOTION_SAMPLER_DISCLAIMER, /등록되지 않/, '참조로 등록되지 않음을 명시')
  assert.equal(EMOTION_SAMPLER_TITLE, '감정 샘플러')
})

test('패널: 표준 문구 원문을 렌더하지 않는다(버전만 표시)', () => {
  for (const p of EMOTION_SAMPLER_PHRASES) {
    assert.ok(!panelCode.includes(p), `패널에 문구 원문 없음: ${p}`)
  }
  assert.ok(/표준 문구 v\{/.test(panelCode), '문구 버전만 표시')
})

test('패널: 접근성 — 실제 button + aria-label, 고정 폭 없음(800x600·150% 대응)', () => {
  assert.ok(panelButtonTags.length >= 3, 'button 요소를 찾지 못함')
  for (const b of panelButtonTags) {
    assert.ok(b.includes('type="button"'), 'type="button" 명시')
    assert.ok(b.includes('aria-label='), 'aria-label 제공')
  }
  assert.ok(!/<div[^>]*onClick/.test(panelCode), 'div onClick(키보드 미도달) 금지')
  assert.ok(!/width:\s*\d{3,}/.test(panelCode), '고정 픽셀 폭 금지')
  assert.ok(panelCode.includes('flexWrap'), '좁은 폭에서 줄바꿈')
  assert.ok(panelCode.includes('overflowY'), '목록은 세로 스크롤로 가둠')
  assert.ok(panelCode.includes("overflowX: 'hidden'"), '가로 넘침 금지')
  assert.ok(panelCode.includes('aria-live'), '상태 변화 낭독용 live region')
  // label 요소는 htmlFor 로 연결(키보드/낭독기 도달).
  assert.ok(!/<label(?![^>]*htmlFor)/.test(panelCode), 'label 은 htmlFor 로 연결')
})
