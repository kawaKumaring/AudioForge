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
  EMOTION_SAMPLER_SECTION_TITLE,
  EMOTION_SAMPLE_SUMMARY_BUCKETS,
  EMOTION_SAMPLE_SUMMARY_LABEL,
  EMOTION_SAMPLE_SUMMARY_EMPTY,
  summarizeEmotionSamples,
  buildEmotionSampleScript,
  EMOTION_SAMPLER_PARITY_INPUT,
  EMOTION_SAMPLER_EXPRESSION_HOST,
  EMOTION_SAMPLE_ROWS,
  EMOTION_SAMPLE_FAMILIES,
  EMOTION_SAMPLE_DECLARED_CAPABILITY,
  EMOTION_SAMPLER_CAPABILITY_STATES,
  emotionSampleRow,
  assertEmotionSampleRowId,
  emotionSampleExpressionFromTimeline,
  capabilityForRow,
  capabilityForVowelExtend,
  isCapabilityUsable,
  stateForCapability,
  type EmotionSampleExpression,
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
// 표현 프로소디 언어 계약 — 이 테스트가 '실제 파서'를 돌려 카탈로그를 검증한다(계약이 권위).
import {
  parseExpressiveTimeline,
  LOCAL_PROSODY_KINDS,
  LAUGH_STYLES,
  EXPRESSIVE_EMOTION_LABEL_TO_ID,
  EXPRESSIVE_NODE_KINDS,
  DOT_RUN_CHARS,
  BANG_RUN_CHARS,
  QUESTION_RUN_CHARS,
  TILDE_RUN_CHARS,
} from './expressiveTimeline.ts'

// ── 공통 픽스처(전부 합성 값) ────────────────────────────────────────────────
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)

const EXPR_HAPPY: EmotionSampleExpression = {
  family: 'emotion', rowId: 'emotion_happy', kind: 'emotionTransition', strength: 100,
}

function input(over: Partial<EmotionSampleKeyInput> = {}): EmotionSampleKeyInput {
  return {
    voiceContentSha256: FP_A,
    engineId: 'qwen',
    modelId: 'qwen3-omni-flash',
    expression: { ...EXPR_HAPPY },
    config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG },
    ...over,
  }
}

/** 계약 파서로 한 행의 표현 축을 실제로 구해 온다(세기의 권위는 계약). */
function exprOf(rowId: string): EmotionSampleExpression {
  const r = parseExpressiveTimeline(buildEmotionSampleScript(rowId), { mode: 'expressive_v3' })
  assert.ok(r.ok, `${rowId}: 계약 파싱 성공 기대`)
  return emotionSampleExpressionFromTimeline(rowId, (r as { timeline: never }).timeline)
}
const KEY_A = buildEmotionSampleCacheKey(input())

const MODULE_PATH = fileURLToPath(new URL('./emotionSampler.ts', import.meta.url))
const PY_PATH = fileURLToPath(new URL('../../python/emotion_sampler.py', import.meta.url))
const PANEL_PATH = fileURLToPath(new URL('../renderer/components/EmotionSamplerPanel.tsx', import.meta.url))
// ⚠️ core.autocrlf=true 인 레포다 — 새 체크아웃에서는 CRLF 로 내려온다.
// 소스를 '파싱'하는 테스트라 개행을 먼저 LF 로 정규화해야 정규식이 체크아웃 방식에 흔들리지 않는다.
function readSource(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
}
const moduleSrc = readSource(MODULE_PATH)
const pySrc = readSource(PY_PATH)
const panelSrc = readSource(PANEL_PATH)

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
    'config', 'engine_id', 'expression', 'key_version', 'model_id', 'phrase_version', 'voice_content_sha256',
  ])
  assert.deepEqual(Object.keys(parsed.expression), ['family', 'kind', 'row_id', 'strength'])
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
  assert.notEqual(buildEmotionSampleCacheKey(input({ voiceContentSha256: FP_B })), KEY_A)
})

test('캐시 키: 엔진 식별자만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ engineId: 'gptsovits' })), KEY_A)
})

test('캐시 키: 모델 식별자만 바뀌어도 키가 달라진다', () => {
  assert.notEqual(buildEmotionSampleCacheKey(input({ modelId: 'qwen3-omni-instruct' })), KEY_A)
})

test('캐시 키: 표현 이벤트(kind)만 바뀌어도 키가 달라진다', () => {
  const other = { ...EXPR_HAPPY, kind: 'emphasis' }
  assert.notEqual(buildEmotionSampleCacheKey(input({ expression: other })), KEY_A)
})

test('캐시 키: 세기(strength)만 바뀌어도 키가 달라진다', () => {
  const weaker = { ...EXPR_HAPPY, strength: 60 }
  assert.notEqual(buildEmotionSampleCacheKey(input({ expression: weaker })), KEY_A)
  // 같은 kind 라도 세기가 다르면 다른 샘플이다(웃음 피식/밝은 웃음이 그 예).
  const a = buildEmotionSampleCacheKey(input({ expression: { ...EXPR_HAPPY, strength: 30 } }))
  const b = buildEmotionSampleCacheKey(input({ expression: { ...EXPR_HAPPY, strength: 75 } }))
  assert.notEqual(a, b)
})

test('캐시 키: 행(rowId)만 바뀌어도 키가 달라진다 — 카탈로그 전체가 서로 다른 키', () => {
  const keys = new Set(EMOTION_SAMPLE_ROWS.map((r) => buildEmotionSampleCacheKey(input({
    expression: exprOf(r.rowId),
  }))))
  assert.equal(keys.size, EMOTION_SAMPLE_ROWS.length, '행별 키 충돌 없음')
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
      const entry: EmotionSampleEntry = { rowId: 'emotion_happy', state, reason, cacheKey: KEY_A }
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
    describeEmotionSample({ rowId: 'emotion_happy', state, reason, cacheKey: KEY_A })
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
  const e0 = initialEmotionSampleEntry('emotion_happy', KEY_A)
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
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('emotion_sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_SUCCEEDED', degraded: true })
  assert.equal(t.entry.state, 'degraded')
  assert.equal(t.entry.reason, 'SAMPLER_XVECTOR_ONLY')
})

test('상태 기계: 생성 한도 초과는 limitExceeded + 전용 사유(재생 불가)', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('emotion_sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_LIMIT_EXCEEDED' })
  assert.equal(t.entry.state, 'limitExceeded')
  assert.equal(t.entry.reason, 'SAMPLER_GENERATION_LIMIT')
  assert.equal(isAuditionable(t.entry.state), false)
})

test('상태 기계: 실패 사유가 failed 집합 밖이면 UNKNOWN 으로 강제(조용한 무표시 금지)', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('emotion_sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const t = applyEmotionSamplerEvent(gen, { type: 'GENERATE_FAILED', reason: 'SAMPLER_XVECTOR_ONLY' })
  assert.equal(t.entry.state, 'failed')
  assert.equal(t.entry.reason, 'SAMPLER_UNKNOWN')
  assert.ok((describeEmotionSample(t.entry).reasonLabel ?? '').length > 0)
})

test('상태 기계: 실패 후 자동 재시도 없음 — 사용자가 다시 눌러야 generating 이 된다', () => {
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('emotion_sad', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
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
  const idle = initialEmotionSampleEntry('emotion_happy', KEY_A)
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
    { type: 'KEY_CHANGED' as const, cacheKey: buildEmotionSampleCacheKey(input({ voiceContentSha256: FP_B })) },
  ]
  for (const state of EMOTION_SAMPLE_STATES) {
    const reason = EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null
    const entry: EmotionSampleEntry = { rowId: 'emotion_happy', state, reason, cacheKey: KEY_A }
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
  const gen = applyEmotionSamplerEvent(initialEmotionSampleEntry('emotion_happy', KEY_A), { type: 'GENERATE_REQUESTED' }).entry
  const ready = applyEmotionSamplerEvent(gen, { type: 'GENERATE_SUCCEEDED' }).entry
  const newKey = buildEmotionSampleCacheKey(input({ voiceContentSha256: FP_B }))
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
  const p1 = run('emotion_happy', KEY_A)
  assert.equal(p1.action, 'reuse')
  assert.equal(p1.entry.state, 'ready')
  const p2 = run('emotion_happy', KEY_A)
  assert.equal(p2.action, 'reuse')
  assert.equal(generateCalls, 0, 'hit 이면 합성을 호출하지 않는다')

  // miss 일 때만 생성
  const otherKey = buildEmotionSampleCacheKey(input({ expression: exprOf('emotion_sad') }))
  const p3 = run('emotion_sad', otherKey)
  assert.equal(p3.action, 'generate')
  assert.equal(p3.entry.state, 'idle')
  assert.equal(generateCalls, 1)
})

test('캐시 hit: 강등 샘플도 재사용되며 degraded 로 복원된다', () => {
  const cache: EmotionSamplerCacheIndex = { [KEY_A]: { degraded: true } }
  const plan = resolveEmotionSampleRequest('emotion_happy', KEY_A, cache)
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
  assert.equal(resolveEmotionSampleRequest('emotion_happy', bumpedKey, cache).action, 'generate')
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
  // resolve/initial 의 마지막 인자는 capability(선택) — 필수 인자는 여전히 '행 하나 + 키'다.
  // (rowId, cacheKey, cacheIndex, capability?) — 4번째는 선택적 capability 주입 슬롯이다.
  assert.equal(resolveEmotionSampleRequest.length, 4)
  assert.equal(initialEmotionSampleEntry.length, 3)  // (rowId, cacheKey, capability?)

  for (const bogus of [['emotion_happy', 'emotion_sad'], { 0: 'x' }, 3, null, undefined, '']) {
    assert.throws(
      () => assertEmotionSampleRowId(bogus as never),
      (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_INVALID_ROW_ID',
      `행 id 가 아닌 입력 거부: ${JSON.stringify(bogus)}`
    )
    assert.throws(() => initialEmotionSampleEntry(bogus as never, KEY_A))
    assert.throws(() => resolveEmotionSampleRequest(bogus as never, KEY_A, {}))
    assert.throws(() => buildEmotionSampleCacheKey(input({ expression: { ...EXPR_HAPPY, rowId: bogus as never } })))
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
  assert.match(panelCode, /onGenerate:\s*\(rowId:\s*string\)\s*=>\s*void/)
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
    for (const field of ['engineId', 'modelId', 'voiceContentSha256'] as const) {
      assert.throws(
        () => buildEmotionSampleCacheKey(input({ [field]: p } as Partial<EmotionSampleKeyInput>)),
        (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_PATH_LIKE_VALUE',
        `${field} 에 경로 금지: ${p}`
      )
    }
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
    rowId: 'emotion_happy',
    state,
    reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null,
    cacheKey: KEY_A,
  }))
  for (const entry of cases) {
    assert.deepEqual(Object.keys(entry).sort(), ['cacheKey', 'reason', 'rowId', 'state'])
    assertSamplerSafeValue('rowId', entry.rowId)
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
      rowId: 'emotion_happy', state, reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null, cacheKey: KEY_A,
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

// ── 목소리 입력 권위 = 참조 라이브러리의 콘텐츠 SHA-256 ──
// 합성 픽스처: 참조 라이브러리가 내주는 레코드. 경로/크기는 '있지만 키 입력이 아니다'를 보이기 위해 둔다.
interface RefRecord { sourcePath: string; sizeBytes: number; contentSha256: string }
const SHA_ONE = '1'.repeat(64)
const SHA_TWO = '2'.repeat(64)

test('목소리 권위: 같은 파일이 다른 경로로 옮겨져도 같은 키(캐시 재사용)', () => {
  const before: RefRecord = { sourcePath: 'E:/voices/my.wav', sizeBytes: 480000, contentSha256: SHA_ONE }
  const after: RefRecord = { sourcePath: 'D:/backup/2026/renamed.wav', sizeBytes: 480000, contentSha256: SHA_ONE }
  const k1 = buildEmotionSampleCacheKey(input({ voiceContentSha256: before.contentSha256 }))
  const k2 = buildEmotionSampleCacheKey(input({ voiceContentSha256: after.contentSha256 }))
  assert.equal(k1, k2, '경로 이동은 키를 바꾸지 않는다')
  // 그래서 이동 후에도 기존 캐시가 그대로 hit 된다(재합성 없음).
  const cache: EmotionSamplerCacheIndex = { [k1]: { degraded: false } }
  assert.equal(resolveEmotionSampleRequest('emotion_happy', k2, cache).action, 'reuse')
})

test('목소리 권위: 이름·크기가 같아도 내용이 바뀌면 키가 달라진다(캐시 무효화)', () => {
  const edited: RefRecord = { sourcePath: 'E:/voices/my.wav', sizeBytes: 480000, contentSha256: SHA_TWO }
  const k1 = buildEmotionSampleCacheKey(input({ voiceContentSha256: SHA_ONE }))
  const k2 = buildEmotionSampleCacheKey(input({ voiceContentSha256: edited.contentSha256 }))
  assert.notEqual(k1, k2, '내용 변경은 이름/크기가 같아도 키를 바꾼다')
  const cache: EmotionSamplerCacheIndex = { [k1]: { degraded: false } }
  assert.equal(resolveEmotionSampleRequest('emotion_happy', k2, cache).action, 'generate')
})

test('목소리 권위: 경로 기반 지문(path|size|mtimeMs)은 키 입력이 될 수 없다', () => {
  // main 의 audio:fingerprint-reference 반환 형태. 그대로 넣으면 경로 위생 가드가 막는다.
  const raw = 'E:/AI/voice.wav|480000|1700000000000'
  assert.throws(
    () => buildEmotionSampleCacheKey(input({ voiceContentSha256: raw })),
    (e: unknown) => e instanceof EmotionSamplerInputError && e.code === 'SAMPLER_PATH_LIKE_VALUE'
  )
  // 64 hex 가 아닌 불투명 문자열도 거부(임의 지문 형식이 슬쩍 들어오는 것 방지).
  // 대문자 hex 는 무효(정규화 없이 그대로 비교하므로 소문자 강제). SHA_ONE 은 숫자뿐이라 별도 값을 쓴다.
  for (const bad of ['abc123', 'ab'.repeat(32).toUpperCase(), SHA_ONE + 'a', '']) {
    assert.throws(
      () => buildEmotionSampleCacheKey(input({ voiceContentSha256: bad })),
      (e: unknown) => e instanceof EmotionSamplerInputError,
      `콘텐츠 sha256 형식 강제: ${bad.slice(0, 12)}`
    )
  }
})

test('목소리 권위: 모듈이 스스로 목소리 지문을 만들지 않는다(주입 전용)', () => {
  // 자체 해싱 헬퍼가 export 되어 있으면 '두 번째 권위'가 생긴다 — 존재 자체를 금지한다.
  assert.ok(!/voiceContentSha256FromRaw|voiceFingerprintFromRaw/.test(moduleCode), '자체 지문 생성 헬퍼 없음')
  assert.ok(!/mtimeMs|sizeBytes|fingerprintReference/.test(moduleCode), '경로/크기/mtime 기반 입력 없음')
  // 캐시 키 입력 필드는 정확히 이 다섯 개뿐이다.
  const payload = JSON.parse(canonicalEmotionSampleKeyPayload(input()))
  assert.ok('voice_content_sha256' in payload)
  assert.ok(!('voice_fingerprint' in payload), '경로 기반 지문 필드가 남아 있지 않음')
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
  assert.equal(pyStr('EMOTION_SAMPLER_SECTION_TITLE'), EMOTION_SAMPLER_SECTION_TITLE)
  assert.equal(pyStr('EMOTION_SAMPLE_SUMMARY_EMPTY'), EMOTION_SAMPLE_SUMMARY_EMPTY)
  const sm = pyDict('EMOTION_SAMPLE_SUMMARY_LABEL')
  for (const b of EMOTION_SAMPLE_SUMMARY_BUCKETS) assert.equal(sm[b], EMOTION_SAMPLE_SUMMARY_LABEL[b], `요약 라벨 ${b}`)
  assert.deepEqual(pyTuple('EMOTION_SAMPLE_SUMMARY_BUCKETS'), [...EMOTION_SAMPLE_SUMMARY_BUCKETS])
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
  assert.ok(panelCode.includes('EMOTION_SAMPLER_SECTION_TITLE'), '패널 제목은 섹션 제목 상수')
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
  assert.equal(EMOTION_SAMPLER_SECTION_TITLE, '감정·표현 미리듣기')
  // 감정 참조 등록과 어휘가 겹치지 않는다.
  assert.ok(!EMOTION_SAMPLER_SECTION_TITLE.includes('참조'))
  assert.ok(!EMOTION_SAMPLER_SECTION_TITLE.includes('등록'))
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

// ─────────────────────────────────────────────────────────────────────────────
// 11) 점진적 공개 — 접힘 기본 + 접힘 요약
// ─────────────────────────────────────────────────────────────────────────────

test('접힘 요약: 상태 6개가 정확히 한 버킷에만 집계된다(중복 없음)', () => {
  const mk = (state: EmotionSampleState): EmotionSampleEntry => ({
    rowId: 'emotion_happy', state, reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null, cacheKey: KEY_A,
  })
  // 상태별로 하나씩 → generated 1(ready) / generating 1 /
  // attention 5(degraded+limitExceeded+failed+unsupported+unverified), idle 미집계
  const all = EMOTION_SAMPLE_STATES.map(mk)
  const s = summarizeEmotionSamples(all)
  assert.equal(s.generated, 1)
  assert.equal(s.generating, 1)
  assert.equal(s.attention, 5)
  assert.equal(s.generated + s.generating + s.attention, EMOTION_SAMPLE_STATES.length - 1, 'idle 만 미집계')
  assert.equal(s.text, '만들어짐 1 · 만드는 중 1 · 확인 필요 5')
})

test('접힘 요약: 0인 버킷은 문구에서 빠지고, 전부 0이면 빈 안내', () => {
  const mk = (state: EmotionSampleState): EmotionSampleEntry =>
    ({ rowId: 'emotion_happy', state, reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null, cacheKey: KEY_A })
  assert.equal(summarizeEmotionSamples([]).text, EMOTION_SAMPLE_SUMMARY_EMPTY)
  assert.equal(summarizeEmotionSamples([mk('idle'), mk('idle')]).text, EMOTION_SAMPLE_SUMMARY_EMPTY)
  assert.equal(summarizeEmotionSamples([mk('ready')]).text, '만들어짐 1')
  assert.equal(summarizeEmotionSamples([mk('failed')]).text, '확인 필요 1')
  assert.equal(summarizeEmotionSamples([mk('ready'), mk('generating')]).text, '만들어짐 1 · 만드는 중 1')
  // 요약은 항목 수와 무관하게 짧게 유지된다(접힘 상태가 길어지지 않는다).
  const many = Array.from({ length: 50 }, () => mk('ready'))
  assert.ok(summarizeEmotionSamples(many).text.length <= 40, '요약 한 줄 길이 상한')
})

test('접힘 요약: 문구가 상태 라벨/사유 문장을 그대로 노출하지 않는다(요약만)', () => {
  const mk = (state: EmotionSampleState): EmotionSampleEntry =>
    ({ rowId: 'emotion_happy', state, reason: EMOTION_SAMPLE_STATE_REASONS[state][0] ?? null, cacheKey: KEY_A })
  const text = summarizeEmotionSamples(EMOTION_SAMPLE_STATES.map(mk)).text
  for (const r of EMOTION_SAMPLE_REASON_CODES) {
    assert.ok(!text.includes(EMOTION_SAMPLE_REASON_LABEL[r]), `접힘 요약에 사유 문장 없음: ${r}`)
  }
  for (const p of EMOTION_SAMPLER_PHRASES) assert.ok(!text.includes(p))
})

test('패널: 기본 접힘 + 펼쳐야 목록/안내가 렌더된다', () => {
  // useState 기본값이 false 여야 한다(열린 채로 시작 금지).
  assert.match(panelCode, /useState\(false\)/, '접힘 기본')
  assert.ok(!/useState\(true\)/.test(panelCode), '열림 기본 금지')
  // 토글 버튼이 aria-expanded / aria-controls 로 본문과 연결된다.
  assert.ok(panelCode.includes('aria-expanded={open}'), 'aria-expanded 연결')
  assert.ok(panelCode.includes('aria-controls={BODY_ID}'), 'aria-controls 연결')
  // 본문(안내 문장 + 목록)은 open 가드 안에 있다.
  // import 블록에도 상수 이름이 나오므로 JSX(return 이후)만 잘라서 본다.
  const jsx = panelCode.slice(panelCode.indexOf('return ('))
  const bodyStart = jsx.indexOf('{open && (')
  assert.ok(bodyStart > 0, 'open 가드 존재')
  const beforeBody = jsx.slice(0, bodyStart)
  assert.ok(!beforeBody.includes('EMOTION_SAMPLER_DISCLAIMER'), '접힘 상태에 안내 문장 없음')
  assert.ok(!beforeBody.includes('views.map'), '접힘 상태에 목록 없음')
  assert.ok(!beforeBody.includes('onGenerate('), '접힘 상태에 생성 버튼 없음')
  // 접힘 헤더에는 요약만 있다.
  assert.ok(beforeBody.includes('summary.text'), '접힘 헤더에 요약 렌더')
  assert.ok(panelCode.includes('summarizeEmotionSamples'), 'shared 요약 파생 사용')
})

// ─────────────────────────────────────────────────────────────────────────────
// 12) 표현 언어 교체 지점 — 지금은 태그 문자열 결합, 나중에 AST/event builder
// ─────────────────────────────────────────────────────────────────────────────

test('대본 조립: 행 id 하나로 계약 토큰을 조립한다(문자열 접합 아님)', () => {
  // 감정 baseline 은 v1 과 바이트 동일해야 한다(비교 기준선 보존).
  assert.equal(buildEmotionSampleScript('emotion_happy'), `[기쁨] ${emotionSamplerPhraseScript()}`)
  assert.equal(buildEmotionSampleScript('emotion_transition_happy_sad'),
    `[기쁨] ${EMOTION_SAMPLER_PHRASES[0]} [슬픔] ${EMOTION_SAMPLER_PHRASES[1]}`)
  assert.equal(buildEmotionSampleScript('punct_emphasis'), `${EMOTION_SAMPLER_EXPRESSION_HOST}!`)
  assert.equal(buildEmotionSampleScript('laugh_chuckle'), `${EMOTION_SAMPLER_EXPRESSION_HOST} [ㅋ]`)
  // 카탈로그에 없는 행은 거부(임의 문자열을 대본으로 만들 수 없다).
  for (const bogus of ['', 'nope', ['emotion_happy'], 3, null]) {
    assert.throws(() => buildEmotionSampleScript(bogus as never))
  }
  assert.ok(moduleSrc.includes('EXPRESSION LANGUAGE SWAP POINT') === false,
    '교체가 끝났으므로 예고 배너는 더 이상 없다')
})


test('대본 조립: 결과 프롬프트는 상태/키/화면 어디에도 쓰이지 않는다', () => {
  const script = buildEmotionSampleScript('emotion_happy')
  const payload = canonicalEmotionSampleKeyPayload(input())
  assert.ok(!payload.includes(script))
  const entry = initialEmotionSampleEntry('emotion_happy', KEY_A)
  assert.ok(!JSON.stringify(entry).includes(script))
  assert.ok(!JSON.stringify(describeEmotionSample(entry)).includes(script))
  assert.ok(!panelCode.includes('buildEmotionSampleScript'), '패널은 대본을 만들지도 렌더하지도 않는다')
})

// ─────────────────────────────────────────────────────────────────────────────
// 13) 표현 언어 계약 소비 — 카탈로그가 계약과 어긋나지 않는가(실제 파서로 검증)
// ─────────────────────────────────────────────────────────────────────────────

test('계약 소비: 모든 행의 대본이 계약 파서에서 오류 없이 파싱된다', () => {
  for (const row of EMOTION_SAMPLE_ROWS) {
    const r = parseExpressiveTimeline(buildEmotionSampleScript(row.rowId), { mode: 'expressive_v3' })
    assert.ok(r.ok, `${row.rowId}: 파싱 성공`)
    const errs = r.timeline.diagnostics.filter((d) => d.severity === 'error')
    assert.equal(errs.length, 0, `${row.rowId}: error 진단 없음`)
  }
})

test('계약 소비: 각 행의 expectKind 가 계약이 실제로 내는 이벤트 종류와 일치', () => {
  for (const row of EMOTION_SAMPLE_ROWS) {
    const ex = exprOf(row.rowId)
    assert.equal(ex.kind, row.expectKind, `${row.rowId}: 계약 이벤트 종류`)
    assert.equal(ex.rowId, row.rowId)
    assert.equal(ex.family, row.family)
    assert.ok(Number.isInteger(ex.strength) && ex.strength >= 0 && ex.strength <= 100,
      `${row.rowId}: 세기는 0..100 정수`)
  }
})

test('계약 소비: expectKind 는 계약 enum 집합 안에만 있다(병렬 어휘 금지)', () => {
  const prosody = new Set<string>(LOCAL_PROSODY_KINDS as readonly string[])
  const laughs = new Set<string>(LAUGH_STYLES as readonly string[])
  const nodeKinds = new Set<string>(EXPRESSIVE_NODE_KINDS as readonly string[])
  for (const row of EMOTION_SAMPLE_ROWS) {
    if (row.family === 'punctuation') assert.ok(prosody.has(row.expectKind), `${row.rowId} in LOCAL_PROSODY_KINDS`)
    else if (row.family === 'laugh') assert.ok(laughs.has(row.expectKind), `${row.rowId} in LAUGH_STYLES`)
    else assert.ok(nodeKinds.has(row.expectKind), `${row.rowId} in EXPRESSIVE_NODE_KINDS`)
  }
  // 웃음 5 style 을 모두 덮는다(계약에 없는 style 을 만들지도 않았다).
  const covered = new Set(EMOTION_SAMPLE_ROWS.filter((r) => r.family === 'laugh').map((r) => r.expectKind))
  assert.deepEqual([...covered].sort(), [...LAUGH_STYLES].sort())
  // 구두점 5종이 계약의 국소 운율 종류와 정확히 대응한다.
  const punct = new Set(EMOTION_SAMPLE_ROWS.filter((r) => r.family === 'punctuation').map((r) => r.expectKind))
  assert.deepEqual([...punct].sort(), [...LOCAL_PROSODY_KINDS].filter((k) => k !== 'firm_end').sort())
})

test('계약 소비: 감정 라벨은 계약 감정표에 있는 것만 쓴다', () => {
  for (const row of EMOTION_SAMPLE_ROWS) {
    for (const p of row.parts) {
      if (p.part !== 'emotionTag') continue
      assert.ok(Object.prototype.hasOwnProperty.call(EXPRESSIVE_EMOTION_LABEL_TO_ID, p.label),
        `${row.rowId}: '${p.label}' 이 계약 감정표에 있어야 한다`)
    }
  }
  // 요청받은 '분노'/'차분' 은 계약 감정표에 없어서 화남/진지로 잡았다 \u2014 표에 없는 이름을 만들지 않았다.
  assert.ok(!('분노' in EXPRESSIVE_EMOTION_LABEL_TO_ID))
  assert.ok(!('차분' in EXPRESSIVE_EMOTION_LABEL_TO_ID))
})

test('계약 소비: 운율 토큰 문자는 계약의 run 문자 집합에서 온다', () => {
  const all = DOT_RUN_CHARS + BANG_RUN_CHARS + QUESTION_RUN_CHARS + TILDE_RUN_CHARS
  for (const row of EMOTION_SAMPLE_ROWS) {
    for (const p of row.parts) {
      if (p.part !== 'prosodyToken') continue
      for (const ch of p.token) assert.ok(all.includes(ch), `${row.rowId}: '${ch}' 는 계약 run 문자`)
    }
  }
})

test('계약 소비: 감정 baseline 행의 출력 문구가 v1 과 동일(비교 기준선 보존)', () => {
  const baseline = '안녕하세요. 잠시 후에 다시 말씀드리겠습니다.'
  assert.equal(emotionSamplerPhraseScript(), baseline)
  for (const id of ['emotion_happy', 'emotion_sad', 'emotion_angry', 'emotion_serious']) {
    assert.ok(buildEmotionSampleScript(id).endsWith(baseline), `${id}: baseline 문구 보존`)
  }
})

test('행 카탈로그: 요청된 16행이 모두 있고 id 가 유일하며 안전 토큰이다', () => {
  assert.equal(EMOTION_SAMPLE_ROWS.length, 16)
  const ids = EMOTION_SAMPLE_ROWS.map((r) => r.rowId)
  assert.equal(new Set(ids).size, ids.length, 'rowId 유일')
  for (const id of ids) {
    assert.equal(assertEmotionSampleRowId(id), id)
    assertSamplerSafeValue('rowId', id)
  }
  const byFam = (f: string) => EMOTION_SAMPLE_ROWS.filter((r) => r.family === f).length
  assert.equal(byFam('emotion'), 4)
  assert.equal(byFam('emotionTransition'), 1)
  assert.equal(byFam('punctuation'), 5)
  assert.equal(byFam('laugh'), 6)
  for (const r of EMOTION_SAMPLE_ROWS) {
    assert.ok((EMOTION_SAMPLE_FAMILIES as readonly string[]).includes(r.family))
    assert.ok(r.label.trim().length > 0)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 14) 엔진 capability — 못 하는 것을 '됨'으로 그리지 않는다
// ─────────────────────────────────────────────────────────────────────────────

test('capability: 웃음 6행은 전부 unsupported / LAUGH_NO_STRATEGY', () => {
  for (const r of EMOTION_SAMPLE_ROWS.filter((x) => x.family === 'laugh')) {
    const cap = capabilityForRow(r.rowId)
    assert.equal(cap.state, 'unsupported', `${r.rowId}`)
    assert.equal(cap.reason, 'LAUGH_NO_STRATEGY')
    assert.equal(isCapabilityUsable(cap.state), false)
    assert.equal(stateForCapability(cap), 'unsupported')
  }
})

test("capability: '~' 늘임은 어떤 분류에서도 supported 가 되지 않는다", () => {
  // 계약이 분류하고(open_vowel/sustainable_final/non_sustainable_final/undeterminable) 판정은 엔진 규칙.
  assert.deepEqual(capabilityForVowelExtend('non_sustainable_final'),
    { state: 'unsupported', reason: 'VOWEL_EXTEND_NOT_REALIZABLE' })
  for (const c of ['open_vowel', 'sustainable_final', 'undeterminable']) {
    const cap = capabilityForVowelExtend(c)
    assert.equal(cap.state, 'unknown', `${c}: 프로브 없음 → unknown`)
    assert.equal(cap.reason, 'CAPABILITY_UNVERIFIED')
  }
  for (const c of ['open_vowel', 'sustainable_final', 'non_sustainable_final', 'undeterminable']) {
    assert.equal(isCapabilityUsable(capabilityForVowelExtend(c).state), false, `${c}: usable 아님`)
  }
  // 카탈로그의 '~' 행도 기본이 미검증이다.
  assert.equal(capabilityForRow('punct_vowel_extend').state, 'unknown')
})

test('capability: supported 만 usable 이다(unknown 은 성공이 아니다)', () => {
  for (const st of EMOTION_SAMPLER_CAPABILITY_STATES) {
    assert.equal(isCapabilityUsable(st), st === 'supported', st)
  }
  assert.equal(stateForCapability({ state: 'unknown', reason: 'CAPABILITY_UNVERIFIED' }), 'unverified')
  assert.equal(stateForCapability({ state: 'degraded', reason: null }), 'unverified')
})

test('capability: 못 하는 행은 미생성으로 시작하지 않고 이름 있는 상태로 시작한다', () => {
  const laugh = initialEmotionSampleEntry('laugh_chuckle', KEY_A)
  assert.equal(laugh.state, 'unsupported')
  assert.equal(laugh.reason, 'LAUGH_NO_STRATEGY')
  const tilde = initialEmotionSampleEntry('punct_vowel_extend', KEY_A)
  assert.equal(tilde.state, 'unverified')
  assert.equal(tilde.reason, 'CAPABILITY_UNVERIFIED')
  const emo = initialEmotionSampleEntry('emotion_happy', KEY_A)
  assert.equal(emo.state, 'idle')
  assert.equal(emo.reason, null)
})

test('capability: 못 하는 행은 눌러도 생성이 시작되지 않는다(가짜 진행 금지)', () => {
  for (const id of ['laugh_chuckle', 'punct_vowel_extend']) {
    const e = initialEmotionSampleEntry(id, KEY_A)
    const t = applyEmotionSamplerEvent(e, { type: 'GENERATE_REQUESTED' })
    assert.equal(t.applied, false, `${id}: 시작 안 함`)
    assert.equal(t.rejected, 'CAPABILITY_NOT_USABLE')
    assert.deepEqual(t.entry, e, '상태 불변')
    // 설정이 바뀌어도(=키 변경) 능력은 그대로다.
    const k2 = buildEmotionSampleCacheKey(input({ voiceContentSha256: FP_B }))
    const after = applyEmotionSamplerEvent(e, { type: 'KEY_CHANGED', cacheKey: k2 })
    assert.equal(after.entry.state, e.state, `${id}: 키가 바뀌어도 못 하는 건 그대로`)
    assert.equal(after.entry.cacheKey, k2)
  }
})

test('capability: 못 하는 행은 캐시가 없어도 generate 계획이 나오지 않는다', () => {
  const plan = resolveEmotionSampleRequest('laugh_chuckle', KEY_A, {})
  assert.equal(plan.action, 'blocked')
  assert.equal(plan.entry.state, 'unsupported')
  const plan2 = resolveEmotionSampleRequest('punct_vowel_extend', KEY_A, {})
  assert.equal(plan2.action, 'blocked')
  // 지원되는 행은 그대로 generate
  assert.equal(resolveEmotionSampleRequest('emotion_happy', KEY_A, {}).action, 'generate')
})

test('capability: override 주입이 선언 기본값을 이긴다(엔진 프로브 배선 지점)', () => {
  const override = { laugh_chuckle: { state: 'supported' as const, reason: null } }
  assert.equal(capabilityForRow('laugh_chuckle', override).state, 'supported')
  const e = initialEmotionSampleEntry('laugh_chuckle', KEY_A, capabilityForRow('laugh_chuckle', override))
  assert.equal(e.state, 'idle')
  assert.equal(applyEmotionSamplerEvent(e, { type: 'GENERATE_REQUESTED' }).entry.state, 'generating')
})

test('capability: 두 새 상태가 화면에서 서로 다르게, 그리고 사유와 함께 보인다', () => {
  const un = describeEmotionSample(initialEmotionSampleEntry('laugh_chuckle', KEY_A))
  const uv = describeEmotionSample(initialEmotionSampleEntry('punct_vowel_extend', KEY_A))
  assert.equal(un.stateLabel, '지원 안 됨')
  assert.equal(uv.stateLabel, '미검증')
  assert.notEqual(un.stateLabel, uv.stateLabel)
  for (const v of [un, uv]) {
    assert.equal(v.generateEnabled, false, '생성 불가')
    assert.equal(v.auditionEnabled, false, '들을 것이 없다')
    assert.equal(v.deleteEnabled, false)
    assert.ok((v.reasonLabel ?? '').trim().length > 0, '사유 문장 존재')
    assert.ok((v.generateNotice ?? '').trim().length > 0, '비활성 이유 문장 존재')
  }
  // '만들 수 있다'는 인상을 주는 라벨이 아니다.
  assert.equal(un.generateLabel, '만들 수 없음')
  assert.equal(uv.generateLabel, '확인 전')
  assert.notEqual(un.generateLabel, '샘플 만들기')
  assert.notEqual(uv.generateLabel, '샘플 만들기')
})

test('접힘 요약: 16행 전체를 담아도 한 줄 길이 상한을 지킨다', () => {
  const all = EMOTION_SAMPLE_ROWS.map((r) => initialEmotionSampleEntry(r.rowId, KEY_A))
  const sum = summarizeEmotionSamples(all)
  // 16행 중 지원되는 9행은 idle(미집계), 웃음 6 + '~' 1 = 7 행이 '확인 필요'.
  assert.equal(sum.generated, 0)
  assert.equal(sum.generating, 0)
  assert.equal(sum.attention, 7)
  assert.equal(sum.text, '확인 필요 7')
  assert.ok(sum.text.length <= 40, `접힘 한 줄 길이 상한: ${sum.text}`)
})
