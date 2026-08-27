// ENGINE ↔ SAMPLER PARITY 권위 테스트 (TS, node --test). 합성·GPU·네트워크 없음.
//
// 왜 있는가
// ─────────
// 표현형 운율 ENGINE(python/expressive_capability.py + python/expressive_planner.py)은
// **TS 대응 모듈이 없다**. 감정 샘플러만 두 언어에 있다. 그래서 이 테스트는 두 방향을 모두 본다:
//   · TS 쪽 production 상수/함수를 실제로 호출·대조한다.
//   · Python 쪽 권위 튜플을 **python 소스를 파싱**해 대조한다(엔진 어휘의 TS 쪽 유일한 핀).
// 둘 다 같은 공유 픽스처(test/fixtures/sampler-engine-parity.json)를 기대값으로 쓴다.
// Python 짝: python/test_sampler_engine_parity.py — 같은 픽스처, 같은 리터럴.
//
// coupling: 픽스처의 canonical sha256 이 이 파일과 Python 테스트에 각각 리터럴로 박혀 있다.
// 픽스처를 고쳐 실패를 무마하면 두 언어의 해시 핀이 동시에 깨진다.
//
// ⚠️ production 어휘를 바꿔서 parity 를 통과시키지 않는다. 진짜 불일치는 픽스처의
//    known_divergences 에 사유와 함께 기록되고, 이 테스트는 그 불일치가 '여전한지' 확인한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  EMOTION_SAMPLER_CAPABILITY_STATES, EMOTION_SAMPLE_STATES, EMOTION_SAMPLE_REASON_CODES,
  EMOTION_SAMPLE_STATE_REASONS, EMOTION_SAMPLE_ROWS,
  EMOTION_SAMPLER_KEY_VERSION, EMOTION_SAMPLER_PHRASE_VERSION,
  stateForCapability, capabilityForVowelExtend, isCapabilityUsable, capabilityForRow,
  type EmotionSamplerCapabilityState, type EmotionSampleState,
} from './emotionSampler.ts'
import {
  parseExpressiveTimeline, EXPRESSIVE_CONTRACT_VERSION, LOCAL_PROSODY_KINDS,
  LAUGH_STYLES, LAUGH_POSITIONS, VOWEL_EXTEND_CLASSES, DOT_RUN_MAX_COUNT,
  SUSTAINABLE_FINAL_IS_ACOUSTICALLY_VERIFIED, LANGUAGE_LAYER_ASSERTS_ACOUSTIC_QUALITY,
} from './expressiveTimeline.ts'

// ── 경로 ─────────────────────────────────────────────────────────────────────
const repoUrl = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const FX_PATH = repoUrl('test/fixtures/sampler-engine-parity.json')
const TL_FX_PATH = repoUrl('test/fixtures/expressive-timeline-v3.json')
const PY_CAPABILITY = repoUrl('python/expressive_capability.py')
const PY_PLANNER = repoUrl('python/expressive_planner.py')
const PY_SAMPLER = repoUrl('python/emotion_sampler.py')
const PY_TIMELINE = repoUrl('python/expressive_timeline.py')
const SRC_DIR = repoUrl('src')

/** 픽스처의 canonical sha256. 같은 리터럴이 python/test_sampler_engine_parity.py 에도 있다. */
const FIXTURE_CANONICAL_SHA256 = 'c41615291b6f34413745d7dd69dfb09a3433875d909a2eb3d1e98155acccbbc8'

const FX = JSON.parse(readFileSync(FX_PATH, 'utf-8'))
const TL_FX = JSON.parse(readFileSync(TL_FX_PATH, 'utf-8'))

/** ⚠️ core.autocrlf=true 인 레포다. python 소스를 '파싱' 하므로 개행을 LF 로 정규화한다. */
function readPy(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
}

/** 독스트링과 # 주석을 걷어낸 '실제 코드'. 주석 안의 따옴표가 튜플 추출을 오염시키지 않게. */
function stripPy(src: string): string {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/#.*$/gm, '')
}

const CAP_SRC = stripPy(readPy(PY_CAPABILITY))
const PLANNER_SRC = stripPy(readPy(PY_PLANNER))
const PY_SAMPLER_SRC = stripPy(readPy(PY_SAMPLER))
const PY_TIMELINE_SRC = stripPy(readPy(PY_TIMELINE))

function pyStrings(block: string): string[] {
  return [...block.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2])
}

/** `NAME = ("a", "b", ...)` (여러 줄 가능) → ['a','b',...] */
function pyTuple(src: string, name: string): string[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(src)
  assert.ok(m, `python 소스에서 ${name} 튜플을 찾지 못함`)
  return pyStrings(m![1])
}

/** `NAME = "value"` → 'value' */
function pyString(src: string, name: string): string {
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(src)
  assert.ok(m, `python 소스에서 ${name} 문자열을 찾지 못함`)
  return m![1]
}

/** `NAME = 3` → 3 */
function pyInt(src: string, name: string): number {
  const m = new RegExp(`^${name}\\s*=\\s*(-?\\d+)`, 'm').exec(src)
  assert.ok(m, `python 소스에서 ${name} 정수 상수를 찾지 못함`)
  return Number(m![1])
}

/** `NAME = {"a": 0, "b": 1}` → { a: 0, b: 1 } */
function pyIntDict(src: string, name: string): Record<string, number> {
  const m = new RegExp(`^${name}\\s*=\\s*\\{([^}]*)\\}`, 'm').exec(src)
  assert.ok(m, `python 소스에서 ${name} 딕셔너리를 찾지 못함`)
  const out: Record<string, number> = {}
  for (const [, k, v] of m![1].matchAll(/"(\w+)"\s*:\s*(-?\d+)/g)) out[k] = Number(v)
  return out
}

/** `NAME = { "k": ("a", "b"), ... }` → { k: ['a','b'], ... } */
function pyTupleDict(src: string, name: string): Record<string, string[]> {
  const start = src.indexOf(`${name} = {`)
  assert.ok(start >= 0, `python 소스에서 ${name} 딕셔너리를 찾지 못함`)
  const end = src.indexOf('\n}', start)
  assert.ok(end > start, `${name} 딕셔너리의 끝을 찾지 못함`)
  const body = src.slice(start, end)
  const out: Record<string, string[]> = {}
  for (const [, k, arr] of body.matchAll(/"(\w+)"\s*:\s*\(([^)]*)\)/g)) out[k] = pyStrings(arr)
  return out
}

/** 공백을 하나로 접어 여러 줄 코드 조각을 안정적으로 대조한다. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ')
}

// ── 이 파일이 들고 있는 기대 리터럴(픽스처·production·python 소스 모두와 대조된다) ──
const EXPECT_ENGINE_CAPABILITY_STATES = ['supported', 'degraded', 'unsupported', 'unknown']
const EXPECT_ENGINE_UNVERIFIED_STATE = 'unknown'
const EXPECT_ENGINE_STATE_RANK = { unsupported: 0, degraded: 1, supported: 2 }
const EXPECT_PUNCTUATION_REALIZATIONS = ['model_native', 'post_process', 'unsupported']
const EXPECT_ENGINE_CAP_VOWEL_CLASSES = ['open_vowel', 'sustainable_final', 'non_sustainable_final']
const EXPECT_ENGINE_CAP_VOWEL_ADAPTERS = ['final_consonant_unclassified', 'no_target']
const EXPECT_ENGINE_UNSUPPORTED_CODES = [
  'PROSODY_NO_REALIZATION', 'VOWEL_EXTEND_NO_TARGET', 'VOWEL_EXTEND_NOT_REALIZABLE',
  'LAUGH_NO_STRATEGY', 'UNIT_EXCEEDS_GENERATION_LIMIT',
]
const EXPECT_ENGINE_DEGRADATION_CODES = [
  'REFERENCE_X_VECTOR_ONLY', 'EMOTION_HARD_JOIN', 'EMOTION_OVERLAP_EXPERIMENTAL',
  'MID_UNIT_EMOTION_TRANSITION_DEFERRED', 'NON_DETERMINISTIC_SEED',
  'PUNCTUATION_POST_PROCESS_ONLY', 'LAUGH_CACHED_SAMPLE',
  'LAUGH_VOICE_TRANSFORM_EXPERIMENTAL', 'VOWEL_EXTEND_NON_SUSTAINABLE_FINAL',
  'CAPABILITY_UNVERIFIED',
]
const EXPECT_ENGINE_STRATEGY_REASONS = [
  'CONTINUOUS_WEIGHTS_SUPPORTED', 'INLINE_INSTRUCTION_SUPPORTED',
  'NO_INLINE_SUPPORT_FALLBACK_OVERLAP', 'NO_CONTEXT_SUPPORT_LAST_RESORT',
  'CAPABILITY_UNVERIFIED_FALLBACK',
]
const EXPECT_SAMPLER_CAPABILITY_MIRROR = ['supported', 'degraded', 'unsupported', 'unknown']
const EXPECT_SAMPLER_OUTCOME_STATES = [
  'idle', 'generating', 'ready', 'degraded', 'limitExceeded', 'failed',
  'unsupported', 'unverified',
]
const EXPECT_SAMPLER_REASON_CODES = [
  'SAMPLER_XVECTOR_ONLY', 'SAMPLER_GENERATION_LIMIT', 'SAMPLER_ENGINE_ERROR',
  'SAMPLER_REFERENCE_MISSING', 'SAMPLER_CANCELLED', 'SAMPLER_UNKNOWN',
  'LAUGH_NO_STRATEGY', 'VOWEL_EXTEND_NOT_REALIZABLE', 'CAPABILITY_UNVERIFIED',
]
const EXPECT_SHARED_REASON_CODES = [
  'LAUGH_NO_STRATEGY', 'VOWEL_EXTEND_NOT_REALIZABLE', 'CAPABILITY_UNVERIFIED',
]
const EXPECT_STATE_AXIS_MAPPING: Record<string, string> = {
  supported: 'idle', degraded: 'unverified', unsupported: 'unsupported', unknown: 'unverified',
}
const EXPECT_LOCAL_PROSODY_KINDS = [
  'firm_end', 'fade_end', 'emphasis', 'question_rise', 'shock_rise', 'vowel_extend',
]
const EXPECT_LAUGH_STYLES = ['chuckle', 'breathy', 'bashful', 'open', 'high_giggle']
const EXPECT_LAUGH_POSITIONS = ['leading', 'inline', 'trailing', 'standalone']
const EXPECT_LANGUAGE_VOWEL_CLASSES = [
  'open_vowel', 'sustainable_final', 'non_sustainable_final', 'undeterminable',
]
const EXPECT_ENGINE_ONLY_SYMBOLS = [
  'CAPABILITY_UNVERIFIED_FALLBACK', 'PUNCTUATION_REALIZATIONS',
  'PROSODY_NO_REALIZATION', 'VOWEL_EXTEND_NO_TARGET', 'UNIT_EXCEEDS_GENERATION_LIMIT',
]

// ─────────────────────────────────────────────────────────────────────────────
// coupling — 픽스처를 조용히 고쳐 실패를 무마할 수 없게
// ─────────────────────────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

test('coupling: 공유 픽스처의 canonical sha256 고정 벡터(= Python 동형)', () => {
  const got = createHash('sha256').update(canonical(FX), 'utf8').digest('hex')
  assert.equal(got, FIXTURE_CANONICAL_SHA256,
    '픽스처가 바뀌었다. 의도한 변경이면 TS·Python 두 테스트의 해시 핀을 함께 갱신할 것')
})

test('coupling: 버전 상수가 픽스처와 일치(계약 버전은 3 유지)', () => {
  const m = FX._meta
  assert.equal(m.expressive_contract_version, EXPRESSIVE_CONTRACT_VERSION)
  assert.equal(m.expressive_contract_version, 3)
  assert.equal(m.sampler_key_version, EMOTION_SAMPLER_KEY_VERSION)
  assert.equal(m.sampler_phrase_version, EMOTION_SAMPLER_PHRASE_VERSION)
  assert.equal(m.capability_contract_version, pyInt(CAP_SRC, 'CAPABILITY_CONTRACT_VERSION'))
  assert.equal(m.plan_version, pyInt(PLANNER_SRC, 'PLAN_VERSION'))
  // 언어 계약 버전은 두 언어 모두 3 이어야 한다(이 작업이 올리지 않는다).
  assert.equal(pyInt(PY_TIMELINE_SRC, 'EXPRESSIVE_CONTRACT_VERSION'), 3)
})

test('coupling: ENGINE 에는 TS 대응 모듈이 없다(픽스처 선언이 사실인지)', () => {
  assert.equal(FX._meta.engine_has_typescript_counterpart, false)
  for (const name of ['expressiveCapability.ts', 'expressivePlanner.ts']) {
    assert.equal(existsSync(repoUrl(`src/shared/${name}`)), false,
      `${name} 가 생겼다면 픽스처 선언을 갱신해야 한다`)
  }
  // 혼동 금지 대상: 존재하지만 4상태 어휘가 없다.
  const notCp = repoUrl(FX._meta.not_the_counterpart)
  assert.equal(existsSync(notCp), true)
  const body = readFileSync(notCp, 'utf-8')
  for (const t of ["'supported'", "'degraded'", "'unsupported'", "'unknown'"]) {
    assert.equal(body.includes(t), false,
      'ttsExpressionCapabilities.ts 에 capability 4상태 어휘가 생겼다 — 계약 재검토 필요')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 항목 1 — capability 상태: 이름 충돌이 아니라 '축이 다름'. MAPPING 을 고정한다.
// ─────────────────────────────────────────────────────────────────────────────

test('항목1: 엔진 capability 4상태 + 순위 (python 소스 파싱)', () => {
  assert.deepEqual(pyTuple(CAP_SRC, 'CAPABILITY_STATES'), EXPECT_ENGINE_CAPABILITY_STATES)
  assert.deepEqual(FX.engine.capability_states, EXPECT_ENGINE_CAPABILITY_STATES)
  assert.equal(pyString(CAP_SRC, 'UNVERIFIED_STATE'), EXPECT_ENGINE_UNVERIFIED_STATE)
  assert.equal(FX.engine.unverified_state, EXPECT_ENGINE_UNVERIFIED_STATE)
  assert.deepEqual(pyIntDict(CAP_SRC, 'CAPABILITY_STATE_RANK'), EXPECT_ENGINE_STATE_RANK)
  assert.deepEqual(FX.engine.capability_state_rank, EXPECT_ENGINE_STATE_RANK)
  // 'unknown' 은 순위가 없다 — 미검증을 강등과 크기 비교하지 않는다.
  assert.equal('unknown' in EXPECT_ENGINE_STATE_RANK, false)
  assert.deepEqual(pyTuple(CAP_SRC, 'CAPABILITY_RESOLUTION_REASONS'),
    FX.engine.capability_resolution_reasons)
})

test('항목1: 샘플러의 capability 미러가 엔진과 바이트 동일', () => {
  assert.deepEqual([...EMOTION_SAMPLER_CAPABILITY_STATES], EXPECT_SAMPLER_CAPABILITY_MIRROR)
  assert.deepEqual([...EMOTION_SAMPLER_CAPABILITY_STATES], EXPECT_ENGINE_CAPABILITY_STATES)
  assert.deepEqual(pyTuple(PY_SAMPLER_SRC, 'EMOTION_SAMPLER_CAPABILITY_STATES'),
    EXPECT_SAMPLER_CAPABILITY_MIRROR)
  assert.deepEqual(FX.sampler.capability_states_mirror, EXPECT_SAMPLER_CAPABILITY_MIRROR)
  assert.equal(FX.sampler.capability_states_mirror_symbol, 'EMOTION_SAMPLER_CAPABILITY_STATES')
})

test('항목1: 샘플러 결과 상태는 다른 축이다(집합 동일성을 요구하지 않는다)', () => {
  assert.deepEqual([...EMOTION_SAMPLE_STATES], EXPECT_SAMPLER_OUTCOME_STATES)
  assert.deepEqual(pyTuple(PY_SAMPLER_SRC, 'EMOTION_SAMPLE_STATES'), EXPECT_SAMPLER_OUTCOME_STATES)
  assert.deepEqual(FX.sampler.outcome_states, EXPECT_SAMPLER_OUTCOME_STATES)
  // 두 축의 집합은 다르다. 같아지길 요구하지 않고, 다르다는 사실을 고정한다.
  assert.notDeepEqual(
    [...EMOTION_SAMPLE_STATES].slice().sort(),
    EXPECT_ENGINE_CAPABILITY_STATES.slice().sort())
  // 샘플러에는 'supported' 라는 결과 상태가 없고, 엔진에는 'unverified' 상태가 없다.
  assert.equal((EMOTION_SAMPLE_STATES as readonly string[]).includes('supported'), false)
  assert.equal(EXPECT_ENGINE_CAPABILITY_STATES.includes('unverified'), false)
  assert.equal(FX.state_axis_mapping.sampler_has_no_outcome_state_named_supported, true)
  assert.equal(FX.state_axis_mapping.engine_unknown_is_named_unverified_in_sampler, true)
})

test('항목1: engine capability → sampler outcome MAPPING (주석이 아니라 단언으로)', () => {
  assert.deepEqual(FX.state_axis_mapping.capability_state_to_outcome_state, EXPECT_STATE_AXIS_MAPPING)
  for (const st of EMOTION_SAMPLER_CAPABILITY_STATES) {
    assert.equal(stateForCapability({ state: st, reason: null }),
      EXPECT_STATE_AXIS_MAPPING[st] as EmotionSampleState, `capability ${st} 의 매핑`)
  }
  // 'unverified' 가 곧 엔진 'unknown' 이다.
  assert.equal(stateForCapability({ state: 'unknown', reason: 'CAPABILITY_UNVERIFIED' }), 'unverified')
  // usable 은 'supported' 하나뿐.
  for (const st of EMOTION_SAMPLER_CAPABILITY_STATES) {
    assert.equal(isCapabilityUsable(st), st === 'supported', `isCapabilityUsable(${st})`)
  }
  assert.deepEqual(FX.state_axis_mapping.usable_capability_states, ['supported'])
  assert.equal(FX.state_axis_mapping.supported_maps_to_outcome, 'idle')
  // python 쪽 매핑 함수도 같은 세 분기다(엔진 어휘를 소비하는 지점이 하나임을 고정).
  const body = squash(PY_SAMPLER_SRC.slice(PY_SAMPLER_SRC.indexOf('def state_for_capability')))
  assert.match(body, /if cap\["state"\] == "supported": return "idle" if cap\["state"\] == "unsupported": return "unsupported" return "unverified"/)
})

test('항목1: capability 로 도달할 수 없는 결과 상태(D4 의 실체)', () => {
  const reachable = new Set(Object.values(EXPECT_STATE_AXIS_MAPPING))
  const unreachable = [...EMOTION_SAMPLE_STATES].filter((s) => !reachable.has(s))
  assert.deepEqual(unreachable, FX.state_axis_mapping.outcome_states_unreachable_from_capability)
  // 샘플러 'degraded' 는 capability 강등으로는 절대 도달하지 않는다(x-vector-only 전용).
  assert.equal(unreachable.includes('degraded'), true)
  assert.deepEqual([...EMOTION_SAMPLE_STATE_REASONS.degraded], ['SAMPLER_XVECTOR_ONLY'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 항목 2·3 — 공유 사유 코드는 바이트 동일
// ─────────────────────────────────────────────────────────────────────────────

test('항목2: 공유 사유 코드 3개가 양쪽에서 바이트 동일', () => {
  assert.deepEqual(FX.shared_reason_codes.map((r: any) => r.code), EXPECT_SHARED_REASON_CODES)
  assert.deepEqual([...EMOTION_SAMPLE_REASON_CODES], EXPECT_SAMPLER_REASON_CODES)
  assert.deepEqual(pyTuple(PY_SAMPLER_SRC, 'EMOTION_SAMPLE_REASON_CODES'), EXPECT_SAMPLER_REASON_CODES)
  const engUnsupported = pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES')
  const engDegradation = pyTuple(PLANNER_SRC, 'DEGRADATION_CODES')
  for (const row of FX.shared_reason_codes) {
    const home = row.engine_home === 'UNSUPPORTED_CODES' ? engUnsupported : engDegradation
    assert.equal(home.includes(row.code), true, `${row.code} 의 엔진 소속 튜플`)
    assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes(row.code), true, row.code)
    const reasons = EMOTION_SAMPLE_STATE_REASONS[row.sampler_outcome_state as EmotionSampleState]
    assert.equal((reasons as readonly string[]).includes(row.code), true,
      `${row.code} 는 샘플러 상태 ${row.sampler_outcome_state} 의 사유여야 한다`)
  }
})

test('항목2: 웃음은 미검증 프로필에서 양쪽 다 unsupported/LAUGH_NO_STRATEGY', () => {
  const v = FX.laugh_verdict
  // 엔진: 전략 A~D 전부 불가 → NO_STRATEGY_AVAILABLE → LAUGH_NO_STRATEGY (python 소스로 확인)
  assert.equal(pyTuple(PLANNER_SRC, 'LAUGH_STRATEGY_REASONS').includes(v.engine_strategy_reason), true)
  assert.equal(pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES').includes(v.engine_unsupported_code), true)
  assert.match(squash(PLANNER_SRC.slice(PLANNER_SRC.indexOf('def select_laugh_strategy'))),
    /return \{"strategy": None, "reason": "NO_STRATEGY_AVAILABLE"/)
  // 샘플러: 웃음 행 전부가 선언 capability 로 unsupported/LAUGH_NO_STRATEGY
  const laughRows = EMOTION_SAMPLE_ROWS.filter((r) => r.family === 'laugh')
  assert.ok(laughRows.length > 0)
  for (const r of laughRows) {
    const c = capabilityForRow(r.rowId)
    assert.equal(c.state, v.sampler_capability_state, r.rowId)
    assert.equal(c.reason, v.sampler_capability_reason, r.rowId)
    assert.equal(stateForCapability(c), v.sampler_outcome_state, r.rowId)
  }
  assert.equal(v.agrees, true)
})

test('항목3: VOWEL_EXTEND_NOT_REALIZABLE 는 Python 엔진에도 같은 이름으로 있다', () => {
  assert.equal(pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES').includes('VOWEL_EXTEND_NOT_REALIZABLE'), true)
  assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes('VOWEL_EXTEND_NOT_REALIZABLE'), true)
  // 엔진에는 같은 상황의 '강등' 코드가 따로 또 있고, 그것은 샘플러에 없다.
  assert.equal(pyTuple(PLANNER_SRC, 'DEGRADATION_CODES').includes('VOWEL_EXTEND_NON_SUSTAINABLE_FINAL'), true)
  assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes('VOWEL_EXTEND_NON_SUSTAINABLE_FINAL'), false)
})

test('항목2/7: 엔진 전용 어휘가 TS production 어디에도 없다(병렬 어휘 금지)', () => {
  assert.deepEqual(FX.engine_only_vocabulary.map((r: any) => r.symbol), EXPECT_ENGINE_ONLY_SYMBOLS)
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf-8' })
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))
  assert.ok(files.length > 5, 'src 트리를 실제로 훑었는지')
  for (const rel of files) {
    const body = readFileSync(`${SRC_DIR}/${rel}`, 'utf-8')
    for (const sym of EXPECT_ENGINE_ONLY_SYMBOLS) {
      assert.equal(body.includes(sym), false, `엔진 전용 ${sym} 가 ${rel} 에 나타났다`)
    }
  }
  for (const row of FX.engine_only_vocabulary) {
    assert.equal(row.sampler_counterpart, null, row.symbol)
    assert.ok(String(row.why).trim().length > 0, `${row.symbol} 의 사유가 비어 있다`)
  }
})

test('항목2: CAPABILITY_UNVERIFIED_FALLBACK 은 엔진 전용이고 공유 코드로 투영된다(D8)', () => {
  assert.deepEqual(pyTuple(PLANNER_SRC, 'STRATEGY_REASON_CODES'), EXPECT_ENGINE_STRATEGY_REASONS)
  assert.deepEqual(FX.engine.strategy_reason_codes, EXPECT_ENGINE_STRATEGY_REASONS)
  assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes('CAPABILITY_UNVERIFIED_FALLBACK'), false)
  assert.match(squash(PLANNER_SRC),
    /selection\["reason"\] == "CAPABILITY_UNVERIFIED_FALLBACK".{0,200}"code": "CAPABILITY_UNVERIFIED"/,
    'FALLBACK → CAPABILITY_UNVERIFIED 투영이 사라졌다')
})

// ─────────────────────────────────────────────────────────────────────────────
// 항목 4·5·6 — 언어 계약 어휘 + 실제 파싱 결과
// ─────────────────────────────────────────────────────────────────────────────

test('항목4: 웃음 style / position id 가 집합·순서까지 동일', () => {
  const lc = FX.language_contract
  assert.deepEqual([...LAUGH_STYLES], EXPECT_LAUGH_STYLES)
  assert.deepEqual([...LAUGH_POSITIONS], EXPECT_LAUGH_POSITIONS)
  assert.deepEqual(lc.laugh_styles, EXPECT_LAUGH_STYLES)
  assert.deepEqual(lc.laugh_positions, EXPECT_LAUGH_POSITIONS)
  assert.deepEqual(pyTuple(PY_TIMELINE_SRC, 'LAUGH_STYLES'), EXPECT_LAUGH_STYLES)
  assert.deepEqual(pyTuple(PY_TIMELINE_SRC, 'LAUGH_POSITIONS'), EXPECT_LAUGH_POSITIONS)
  assert.equal(new Set(LAUGH_STYLES).size, LAUGH_STYLES.length)
  assert.equal(new Set(LAUGH_POSITIONS).size, LAUGH_POSITIONS.length)
})

test('항목5: 구두점 종류 id 가 두 언어에서 동일', () => {
  assert.deepEqual([...LOCAL_PROSODY_KINDS], EXPECT_LOCAL_PROSODY_KINDS)
  assert.deepEqual(FX.language_contract.local_prosody_kinds, EXPECT_LOCAL_PROSODY_KINDS)
  assert.deepEqual(pyTuple(PY_TIMELINE_SRC, 'LOCAL_PROSODY_KINDS'), EXPECT_LOCAL_PROSODY_KINDS)
})

test('항목5: 구두점 벡터가 고정된 종류로 파싱된다(실제 파서)', () => {
  const seen = new Set<string>()
  for (const v of FX.punctuation_kind_vectors) {
    const r = parseExpressiveTimeline(v.input, { mode: 'expressive_v3' })
    assert.equal(r.ok, true, v.id)
    if (!r.ok) return
    const lp = r.timeline.localProsody
    assert.equal(lp.length, v.event_count, `${v.id} 이벤트 수`)
    assert.equal(lp[0].kind, v.kind, `${v.id} kind`)
    seen.add(v.kind)
  }
  assert.deepEqual([...seen].sort(), EXPECT_LOCAL_PROSODY_KINDS.slice().sort(),
    '구두점 종류 전부를 벡터가 덮어야 한다')
})

test("항목5: '?!' 는 '!?' 의 별칭 — shock_rise 하나이고 절대 둘이 아니다", () => {
  for (const pair of FX.punctuation_alias_pairs) {
    const a = parseExpressiveTimeline(pair.canonical_input, { mode: 'expressive_v3' })
    const b = parseExpressiveTimeline(pair.alias_input, { mode: 'expressive_v3' })
    assert.equal(a.ok, true, pair.id)
    assert.equal(b.ok, true, pair.id)
    if (!a.ok || !b.ok) return
    for (const [t, label] of [[a.timeline, 'canonical'], [b.timeline, 'alias']] as const) {
      assert.equal(t.localProsody.length, pair.event_count, `${pair.id}/${label} 이벤트 수`)
      assert.equal(t.localProsody[0].kind, pair.kind, `${pair.id}/${label} kind`)
    }
    if (pair.raw_token_differs) {
      assert.notEqual(a.timeline.localProsody[0].rawToken, b.timeline.localProsody[0].rawToken,
        '원문 토큰은 구분되어야 한다(round-trip)')
    }
    // emphasis / question_rise 로 쪼개지지 않았다.
    assert.equal(a.timeline.localProsody.some((e) => e.kind === 'emphasis'), false)
    assert.equal(b.timeline.localProsody.some((e) => e.kind === 'question_rise'), false)
  }
})

test('항목5: 홑점 1개는 firm_end, 2개 이상은 fade_end (점 런은 토큰 하나)', () => {
  const rule = FX.dot_run_rule
  assert.equal(rule.firm_end_max_count, 1)
  assert.equal(rule.fade_end_min_count, 2)
  for (let n = 1; n <= DOT_RUN_MAX_COUNT; n++) {
    const r = parseExpressiveTimeline(`끝${'.'.repeat(n)}`, { mode: 'expressive_v3' })
    assert.equal(r.ok, true, `dot x${n}`)
    if (!r.ok) return
    assert.equal(r.timeline.localProsody.length, 1, `점 런은 항상 토큰 하나 (n=${n})`)
    assert.equal(r.timeline.localProsody[0].kind,
      n <= rule.firm_end_max_count ? 'firm_end' : 'fade_end', `dot x${n}`)
  }
})

test('항목6: 언어 계약의 4분류가 두 언어에서 동일 + 언어층은 음향 품질을 단언하지 않는다', () => {
  const lc = FX.language_contract
  assert.deepEqual([...VOWEL_EXTEND_CLASSES], EXPECT_LANGUAGE_VOWEL_CLASSES)
  assert.deepEqual(lc.vowel_extend_classes, EXPECT_LANGUAGE_VOWEL_CLASSES)
  assert.deepEqual(pyTuple(PY_TIMELINE_SRC, 'VOWEL_EXTEND_CLASSES'), EXPECT_LANGUAGE_VOWEL_CLASSES)
  assert.equal(lc.language_layer_asserts_acoustic_quality, false)
  assert.equal(lc.sustainable_final_is_acoustically_verified, false)
  assert.equal(LANGUAGE_LAYER_ASSERTS_ACOUSTIC_QUALITY, lc.language_layer_asserts_acoustic_quality)
  assert.equal(SUSTAINABLE_FINAL_IS_ACOUSTICALLY_VERIFIED, lc.sustainable_final_is_acoustically_verified)
})

test('항목6: 4분류 벡터가 실제 파서로 그대로 나온다', () => {
  const seen = new Set<string>()
  for (const v of FX.vowel_extend_class_vectors) {
    const r = parseExpressiveTimeline(v.input, { mode: 'expressive_v3' })
    assert.equal(r.ok, true, v.id)
    if (!r.ok) return
    const lp = r.timeline.localProsody
    assert.equal(lp.length, 1, v.id)
    assert.equal(lp[0].kind, 'vowel_extend', v.id)
    assert.equal(lp[0].vowelExtend?.classification, v.classification, v.id)
    seen.add(v.classification)
  }
  assert.deepEqual([...seen].sort(), EXPECT_LANGUAGE_VOWEL_CLASSES.slice().sort(),
    '4분류 전부를 벡터가 덮어야 한다')
})

test('항목4~6: 언어 어휘가 기존 언어 픽스처와 같은 값(권위 이중화 금지)', () => {
  const m = TL_FX._meta
  const lc = FX.language_contract
  assert.deepEqual(lc.local_prosody_kinds, m.local_prosody_kinds)
  assert.deepEqual(lc.laugh_styles, m.laugh_styles)
  assert.deepEqual(lc.laugh_positions, m.laugh_positions)
  assert.deepEqual(lc.vowel_extend_classes, m.vowel_extend_classes)
  assert.equal(lc.language_layer_asserts_acoustic_quality,
    m.invariants.language_layer_asserts_acoustic_quality)
  assert.equal(lc.sustainable_final_is_acoustically_verified,
    m.invariants.sustainable_final_is_acoustically_verified)
  assert.equal(FX._meta.expressive_contract_version, m.contract_version)
})

// ─────────────────────────────────────────────────────────────────────────────
// 항목 7 — PUNCTUATION_REALIZATIONS
// ─────────────────────────────────────────────────────────────────────────────

test('항목7: PUNCTUATION_REALIZATIONS 는 엔진 전용이며 capability 상태 축이 아니다', () => {
  assert.deepEqual(pyTuple(PLANNER_SRC, 'PUNCTUATION_REALIZATIONS'), EXPECT_PUNCTUATION_REALIZATIONS)
  assert.deepEqual(FX.engine.punctuation_realizations, EXPECT_PUNCTUATION_REALIZATIONS)
  // 겹치는 토큰은 'unsupported' 하나뿐 — 글자만 같고 다른 축이다.
  const overlap = EXPECT_PUNCTUATION_REALIZATIONS.filter((x) => EXPECT_ENGINE_CAPABILITY_STATES.includes(x))
  assert.deepEqual(overlap, ['unsupported'])
  assert.notDeepEqual(EXPECT_PUNCTUATION_REALIZATIONS.slice().sort(),
    EXPECT_ENGINE_CAPABILITY_STATES.slice().sort())
})

// ─────────────────────────────────────────────────────────────────────────────
// 엔진 코드 튜플 전체
// ─────────────────────────────────────────────────────────────────────────────

test('엔진 코드 튜플(unsupported / degradation)이 픽스처·리터럴과 일치', () => {
  assert.deepEqual(pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES'), EXPECT_ENGINE_UNSUPPORTED_CODES)
  assert.deepEqual(FX.engine.unsupported_codes, EXPECT_ENGINE_UNSUPPORTED_CODES)
  assert.deepEqual(pyTuple(PLANNER_SRC, 'DEGRADATION_CODES'), EXPECT_ENGINE_DEGRADATION_CODES)
  assert.deepEqual(FX.engine.degradation_codes, EXPECT_ENGINE_DEGRADATION_CODES)
  assert.deepEqual(pyTuple(PLANNER_SRC, 'LAUGH_STRATEGY_REASONS'), FX.engine.laugh_strategy_reasons)
  assert.deepEqual(pyTuple(CAP_SRC, 'VOWEL_EXTEND_VERDICT_REASONS'), FX.engine.vowel_extend_verdict_reasons)
})

test('샘플러 전용 코드는 엔진에 없다(그리고 그 목록이 파생과 일치)', () => {
  const engineAll = new Set([
    ...pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES'),
    ...pyTuple(PLANNER_SRC, 'DEGRADATION_CODES'),
    ...pyTuple(PLANNER_SRC, 'STRATEGY_REASON_CODES'),
    ...pyTuple(PLANNER_SRC, 'LAUGH_STRATEGY_REASONS'),
    ...pyTuple(PLANNER_SRC, 'SPLIT_REASON_CODES'),
  ])
  for (const code of FX.sampler.sampler_only_reason_codes) {
    assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes(code), true, code)
    assert.equal(engineAll.has(code), false, `${code} 는 샘플러 전용이어야 한다`)
  }
  const derived = [...EMOTION_SAMPLE_REASON_CODES].filter((c) => !EXPECT_SHARED_REASON_CODES.includes(c))
  assert.deepEqual(derived, FX.sampler.sampler_only_reason_codes)
})

test('상태별 허용 사유가 TS·Python·픽스처 셋 다 일치', () => {
  const pyMap = pyTupleDict(PY_SAMPLER_SRC, 'EMOTION_SAMPLE_STATE_REASONS')
  for (const st of EMOTION_SAMPLE_STATES) {
    assert.deepEqual([...EMOTION_SAMPLE_STATE_REASONS[st]], FX.sampler.state_reasons[st], st)
    assert.deepEqual(pyMap[st], FX.sampler.state_reasons[st], `python 상태 ${st} 사유`)
  }
  assert.equal(Object.keys(pyMap).length, EMOTION_SAMPLE_STATES.length)
})

// ─────────────────────────────────────────────────────────────────────────────
// 기록된 divergence — 고치지 않고, '여전히 불일치인지' 확인한다
// ─────────────────────────────────────────────────────────────────────────────

const DIVERGENCE_BY_ID: Record<string, any> =
  Object.fromEntries(FX.known_divergences.map((d: any) => [d.id, d]))

test('divergence: D1~D9 전부 사유가 적혀 있다', () => {
  assert.deepEqual(Object.keys(DIVERGENCE_BY_ID).sort(),
    Array.from({ length: 9 }, (_, i) => `D${i + 1}`))
  for (const d of FX.known_divergences) {
    assert.ok(String(d.title).trim().length > 0, d.id)
    assert.ok(String(d.why_not_fixable_by_test).trim().length > 0, d.id)
  }
})

test("divergence D1/D2: '~' 판정표가 샘플러 쪽에서 여전히 그대로다", () => {
  assert.equal(FX.vowel_extend_verdicts.profile, 'unknown_profile')
  for (const row of FX.vowel_extend_verdicts.rows) {
    const smp = capabilityForVowelExtend(row.classification)
    assert.equal(smp.state, row.sampler_state, `${row.classification} 샘플러 상태`)
    assert.equal(smp.reason, row.sampler_reason, `${row.classification} 샘플러 사유`)
    assert.equal(smp.state === row.engine_state, row.states_agree,
      `${row.classification} 의 일치 여부가 기록과 다르다 — divergence 표를 갱신할 것`)
    if (row.states_agree) assert.equal(row.divergence_id, null, row.classification)
    else assert.ok(DIVERGENCE_BY_ID[row.divergence_id], row.classification)
    // 어떤 경로에서도 '됨' 이라고 말하지 않는다.
    assert.notEqual(smp.state, 'supported', row.classification)
    assert.notEqual(row.engine_state, 'supported', row.classification)
  }
})

test("divergence D1: 엔진은 'degraded', 샘플러는 'unsupported' (엔진 소스로 확인)", () => {
  assert.ok(DIVERGENCE_BY_ID.D1)
  // 엔진 capability 층의 분기 상수.
  assert.match(squash(CAP_SRC),
    /state, reason, allowed = "degraded", "NON_SUSTAINABLE_FINAL_DEGRADED", False/)
  // 엔진 planner 층은 같은 상황을 realization 'unsupported' + 공유 코드로 투영한다.
  assert.match(squash(PLANNER_SRC), /else "VOWEL_EXTEND_NOT_REALIZABLE"\)/)
  const smp = capabilityForVowelExtend('non_sustainable_final')
  assert.equal(smp.state, 'unsupported')
  assert.equal(smp.reason, 'VOWEL_EXTEND_NOT_REALIZABLE')
})

test("divergence D2: 엔진 capability 어휘에 'undeterminable' 이 없다", () => {
  assert.ok(DIVERGENCE_BY_ID.D2)
  assert.deepEqual(pyTuple(CAP_SRC, 'VOWEL_EXTEND_CLASSES'), EXPECT_ENGINE_CAP_VOWEL_CLASSES)
  assert.deepEqual(FX.engine.capability_vowel_extend_classes, EXPECT_ENGINE_CAP_VOWEL_CLASSES)
  assert.deepEqual(pyTuple(CAP_SRC, 'VOWEL_EXTEND_ADAPTER_CLASSES'), EXPECT_ENGINE_CAP_VOWEL_ADAPTERS)
  // 언어 계약(TS/Python 둘 다)에는 있고, 엔진 capability 어휘에는 없다.
  assert.equal((VOWEL_EXTEND_CLASSES as readonly string[]).includes('undeterminable'), true)
  assert.equal(EXPECT_ENGINE_CAP_VOWEL_CLASSES.includes('undeterminable'), false)
  assert.equal(FX.engine.capability_vowel_extend_all_classes.includes('undeterminable'), false)
  // 그 결과 엔진은 '판정 불가' 를 unsupported/NO_TARGET 으로 접는다(픽스처 기록과 동일).
  const row = FX.vowel_extend_verdicts.rows.find((r: any) => r.classification === 'undeterminable')
  assert.equal(row.engine_state, 'unsupported')
  assert.equal(row.engine_reason, 'NO_TARGET')
  assert.equal(row.sampler_state, 'unknown')
})

test('divergence D5: x-vector-only 코드 이름이 두 개다', () => {
  assert.ok(DIVERGENCE_BY_ID.D5)
  assert.equal(pyTuple(PLANNER_SRC, 'DEGRADATION_CODES').includes('REFERENCE_X_VECTOR_ONLY'), true)
  assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes('SAMPLER_XVECTOR_ONLY'), true)
  assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes('REFERENCE_X_VECTOR_ONLY'), false)
  assert.equal(pyTuple(PLANNER_SRC, 'DEGRADATION_CODES').includes('SAMPLER_XVECTOR_ONLY'), false)
})

test('divergence D6: CAPABILITY_UNVERIFIED 의 소속 분류가 다르다', () => {
  assert.ok(DIVERGENCE_BY_ID.D6)
  assert.equal(pyTuple(PLANNER_SRC, 'DEGRADATION_CODES').includes('CAPABILITY_UNVERIFIED'), true)
  assert.equal(pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES').includes('CAPABILITY_UNVERIFIED'), false)
  assert.deepEqual([...EMOTION_SAMPLE_STATE_REASONS.unverified], ['CAPABILITY_UNVERIFIED'])
  assert.equal((EMOTION_SAMPLE_STATE_REASONS.degraded as readonly string[]).includes('CAPABILITY_UNVERIFIED'), false)
})

test('divergence D9: 엔진 전용 코드는 샘플러에 쌍둥이가 없다', () => {
  assert.ok(DIVERGENCE_BY_ID.D9)
  const engineCodes = new Set([
    ...pyTuple(PLANNER_SRC, 'UNSUPPORTED_CODES'),
    ...pyTuple(PLANNER_SRC, 'DEGRADATION_CODES'),
  ])
  const shared = new Set(EXPECT_SHARED_REASON_CODES)
  for (const code of [...engineCodes].sort()) {
    if (shared.has(code)) continue
    assert.equal((EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes(code), false,
      `${code} 가 샘플러에 생겼다 — 공유 코드로 승격되었다면 픽스처를 갱신할 것`)
  }
  const intersection = [...engineCodes].filter((c) => (EMOTION_SAMPLE_REASON_CODES as readonly string[]).includes(c))
  assert.deepEqual(intersection.slice().sort(), EXPECT_SHARED_REASON_CODES.slice().sort())
})

// capability 상태 타입이 실제로 엔진 4상태만 받는지(타입 축 확인용 런타임 단언)
test('capability 상태 타입 축: 4개 이외의 값은 어휘에 없다', () => {
  const states: readonly EmotionSamplerCapabilityState[] = EMOTION_SAMPLER_CAPABILITY_STATES
  assert.equal(states.length, 4)
  assert.deepEqual([...states], EXPECT_ENGINE_CAPABILITY_STATES)
})
