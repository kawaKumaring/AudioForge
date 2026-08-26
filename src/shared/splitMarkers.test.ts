// 분할 마커 검증 단위테스트 + TS↔Python parity (C2-P0.3). 실행: npm test (node --test). 새 의존성 0.
// parity는 '파싱으로' 한다: python/split_markers.py 의 상수 블록을 읽어 문자열 집합·숫자 상수를 대조
// (ttsGrammar 계약 테스트가 tts_worker.py를 ast로 읽는 것과 같은 드리프트 가드 패턴).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MIN_TRACK_SECONDS, MAX_MARKER_COUNT, TRACK_LENGTH_EPSILON, LIST_LEVEL_INDEX,
  SPLIT_MARKER_REASON_CODES, AUTO_SILENCE_SPLIT_NOTICE,
  validateMarkers, fingerprintMatches, formatSplitMarkerError,
  type SplitMarkerError, type SplitMarkerReasonCode, type ValidateMarkersResult,
} from './splitMarkers.ts'

const PY_PATH = fileURLToPath(new URL('../../python/split_markers.py', import.meta.url))
const EDITOR_PATH = fileURLToPath(new URL('../renderer/components/SplitEditor.tsx', import.meta.url))
const pySource = readFileSync(PY_PATH, 'utf-8')

/** `#` 주석 제거(문자열 리터럴 안에 #을 쓰지 않는다는 전제 — 이 파일은 지킨다). */
function stripPyComments(s: string): string {
  return s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n')
}

function pyReasonCodes(): string[] {
  const m = pySource.match(/^SPLIT_MARKER_REASON_CODES = \(([\s\S]*?)^\)/m)
  assert.ok(m, 'python SPLIT_MARKER_REASON_CODES 튜플 블록을 찾지 못함')
  return [...stripPyComments(m![1]).matchAll(/"([A-Z_]+)"/g)].map((x) => x[1])
}

function pyConst(name: string): number {
  const m = pySource.match(new RegExp(`^${name} = (-?[0-9.eE+-]+)\\s*$`, 'm'))
  assert.ok(m, `python 상수 ${name} 를 찾지 못함`)
  return Number(m![1])
}

function reject(r: ValidateMarkersResult): SplitMarkerError[] {
  assert.equal(r.ok, false, '거부(reject)를 기대했는데 통과했다')
  return (r as { ok: false; errors: SplitMarkerError[] }).errors
}

function codesOf(r: ValidateMarkersResult): string[] {
  return reject(r).map((e) => e.reasonCode)
}

// ── parity: TS ↔ Python ────────────────────────────────────────────────
test('parity: reasonCode 집합·순서가 python/split_markers.py 와 동일', () => {
  assert.deepEqual(pyReasonCodes(), [...SPLIT_MARKER_REASON_CODES])
})

test('parity: 공유 상수(최소 트랙 길이/최대 개수/epsilon/목록 index) 동일', () => {
  assert.equal(pyConst('MIN_TRACK_SECONDS'), MIN_TRACK_SECONDS)
  assert.equal(pyConst('MAX_MARKER_COUNT'), MAX_MARKER_COUNT)
  assert.equal(pyConst('TRACK_LENGTH_EPSILON'), TRACK_LENGTH_EPSILON)
  assert.equal(pyConst('LIST_LEVEL_INDEX'), LIST_LEVEL_INDEX)
})

test('parity: python 미러가 무거운 의존성을 import 하지 않는다(stdlib only)', () => {
  const body = stripPyComments(pySource)
  for (const banned of ['numpy', 'torch', 'soundfile', 'librosa', 'scipy']) {
    assert.ok(!new RegExp(`import\\s+${banned}\\b|from\\s+${banned}\\b`).test(body), `${banned} import 금지`)
  }
})

// ── 통과 경로 ──────────────────────────────────────────────────────────
test('정상 마커 → 통과, 입력 그대로 반환(정렬/보정 흔적 없음)', () => {
  const input = [30, 60.5, 120]
  const r = validateMarkers(input, { durationSeconds: 200 })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.markers, input)
  assert.equal(r.trackCount, 4)
  assert.equal(r.autoSilenceSplit, false)
  // 반환 배열은 복사본 — 호출자가 만져도 입력이 오염되지 않는다.
  r.markers.push(999)
  assert.deepEqual(input, [30, 60.5, 120])
})

test('마커 0개 → 통과 + autoSilenceSplit=true, trackCount=null(무음 감지가 정함)', () => {
  const r = validateMarkers([], { durationSeconds: 200 })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.markers, [])
  assert.equal(r.autoSilenceSplit, true)
  assert.equal(r.trackCount, null)
})

test('마커 0개는 길이/지문이 이상해도 통과(스테일 마커가 없으므로)', () => {
  const r = validateMarkers([], { durationSeconds: 0, fingerprint: 'A', expectedFingerprint: 'B' })
  assert.equal(r.ok, true)
})

// ── 경계 ───────────────────────────────────────────────────────────────
test('경계: 정확히 0초 마커 → MARKER_NOT_POSITIVE(첫 트랙 시작은 마커가 아니다)', () => {
  assert.deepEqual(codesOf(validateMarkers([0], { durationSeconds: 200 })), ['MARKER_NOT_POSITIVE'])
})

test('경계: 음수 마커 → MARKER_NOT_POSITIVE', () => {
  const errs = reject(validateMarkers([-0.5], { durationSeconds: 200 }))
  assert.equal(errs[0].reasonCode, 'MARKER_NOT_POSITIVE')
  assert.equal(errs[0].value, -0.5)
  assert.equal(errs[0].limit, 0)
})

test('경계: 정확히 duration 마커 → MARKER_BEYOND_DURATION(ffmpeg 음수 -t 원인)', () => {
  assert.deepEqual(codesOf(validateMarkers([200], { durationSeconds: 200 })), ['MARKER_BEYOND_DURATION'])
})

test('duration 초과 마커 → MARKER_BEYOND_DURATION + 숫자 limit', () => {
  const errs = reject(validateMarkers([30, 500], { durationSeconds: 200 }))
  assert.deepEqual(errs.map((e) => e.reasonCode), ['MARKER_BEYOND_DURATION'])
  assert.equal(errs[0].index, 1)
  assert.equal(errs[0].value, 500)
  assert.equal(errs[0].limit, 200)
})

test('경계: duration - epsilon 미만 위치는 통과', () => {
  const r = validateMarkers([199], { durationSeconds: 200 })
  assert.equal(r.ok, true)
})

test('경계: 1ms 간격 두 마커 → TRACK_TOO_SHORT', () => {
  const errs = reject(validateMarkers([10, 10.001], { durationSeconds: 200 }))
  assert.deepEqual(errs.map((e) => e.reasonCode), ['TRACK_TOO_SHORT'])
  assert.equal(errs[0].index, 1)
  assert.equal(errs[0].limit, MIN_TRACK_SECONDS)
  assert.ok(errs[0].value! < MIN_TRACK_SECONDS)
})

test('경계: 정확히 최소 트랙 길이 → 통과(clamp 아님, 미만만 거부)', () => {
  const r = validateMarkers([MIN_TRACK_SECONDS, MIN_TRACK_SECONDS * 2], { durationSeconds: 100 })
  assert.equal(r.ok, true)
})

test('경계: 이진오차(10.2-9.2=0.9999999999999996)는 epsilon으로 통과', () => {
  const r = validateMarkers([9.2, 10.2], { durationSeconds: 100 })
  assert.equal(r.ok, true, '부동소수 오차로 정확히 1.0초 트랙을 거부하면 안 된다')
})

test('첫 트랙이 짧으면 index 0, 마지막 트랙이 짧으면 마지막 마커 index', () => {
  const first = reject(validateMarkers([0.5], { durationSeconds: 200 }))
  assert.deepEqual(first.map((e) => [e.index, e.reasonCode]), [[0, 'TRACK_TOO_SHORT']])
  const last = reject(validateMarkers([30, 199.5], { durationSeconds: 200 }))
  assert.deepEqual(last.map((e) => [e.index, e.reasonCode]), [[1, 'TRACK_TOO_SHORT']])
})

// ── 순서·중복 ──────────────────────────────────────────────────────────
test('정렬 안 된 입력 → MARKER_NOT_INCREASING(검증기가 정렬해주지 않는다)', () => {
  const errs = reject(validateMarkers([60, 30], { durationSeconds: 200 }))
  assert.deepEqual(errs.map((e) => e.reasonCode), ['MARKER_NOT_INCREASING'])
  assert.equal(errs[0].index, 1)
  assert.equal(errs[0].value, 30)
  assert.equal(errs[0].limit, 60)
})

test('비인접 중복 [10,20,10] 도 강한 증가 위반으로 거부', () => {
  assert.deepEqual(codesOf(validateMarkers([10, 20, 10], { durationSeconds: 200 })), ['MARKER_NOT_INCREASING'])
})

test('인접 동일 값 → MARKER_DUPLICATE(0초 트랙 원인)', () => {
  const errs = reject(validateMarkers([30, 30], { durationSeconds: 200 }))
  assert.deepEqual(errs.map((e) => e.reasonCode), ['MARKER_DUPLICATE'])
  assert.equal(errs[0].index, 1)
})

// ── 유한성 ─────────────────────────────────────────────────────────────
test('NaN/Infinity/문자열/boolean/null → MARKER_NOT_FINITE(강제 변환 없음)', () => {
  for (const bad of [NaN, Infinity, -Infinity, '30', true, null, undefined, {}]) {
    const errs = reject(validateMarkers([bad], { durationSeconds: 200 }))
    assert.deepEqual(errs.map((e) => e.reasonCode), ['MARKER_NOT_FINITE'], `${String(bad)}`)
    assert.equal(errs[0].index, 0)
    assert.equal('value' in errs[0], false, 'NaN 등은 숫자 value를 싣지 않는다')
  }
})

test('NaN 마커는 앞뒤 순서 비교 기준을 오염시키지 않는다', () => {
  const errs = reject(validateMarkers([30, NaN, 60], { durationSeconds: 200 }))
  assert.deepEqual(errs.map((e) => [e.index, e.reasonCode]), [[1, 'MARKER_NOT_FINITE']])
})

// ── 개수 / 길이 / 지문 ─────────────────────────────────────────────────
test('최대 개수 초과 → 목록 단위 MARKER_COUNT_EXCEEDED 1건', () => {
  const many = Array.from({ length: MAX_MARKER_COUNT + 1 }, (_, i) => (i + 1) * 10)
  const errs = reject(validateMarkers(many, { durationSeconds: 1e6 }))
  assert.equal(errs.length, 1)
  assert.equal(errs[0].reasonCode, 'MARKER_COUNT_EXCEEDED')
  assert.equal(errs[0].index, LIST_LEVEL_INDEX)
  assert.equal(errs[0].value, MAX_MARKER_COUNT + 1)
  assert.equal(errs[0].limit, MAX_MARKER_COUNT)
})

test('정확히 최대 개수 → 통과', () => {
  const many = Array.from({ length: MAX_MARKER_COUNT }, (_, i) => (i + 1) * 10)
  assert.equal(validateMarkers(many, { durationSeconds: 1e6 }).ok, true)
})

test('duration 0/음수/NaN → DURATION_INVALID(조용히 통과시키지 않는다)', () => {
  assert.deepEqual(codesOf(validateMarkers([30], { durationSeconds: 0 })), ['DURATION_INVALID'])
  assert.deepEqual(codesOf(validateMarkers([30], { durationSeconds: -1 })), ['DURATION_INVALID'])
  assert.deepEqual(codesOf(validateMarkers([30], { durationSeconds: NaN })), ['DURATION_INVALID'])
  // ffprobe 실패 시 separate.py의 total_dur = 0 이 정확히 이 경로다.
  const errs = reject(validateMarkers([30], { durationSeconds: 0 }))
  assert.equal(errs[0].index, LIST_LEVEL_INDEX)
  assert.equal(errs[0].value, 0)
})

test('지문 일치 → 통과 / 불일치 → FINGERPRINT_MISMATCH(값 미노출)', () => {
  const ok = validateMarkers([30], { durationSeconds: 200, fingerprint: 'fp-1', expectedFingerprint: 'fp-1' })
  assert.equal(ok.ok, true)

  const errs = reject(validateMarkers([30], { durationSeconds: 200, fingerprint: 'fp-1', expectedFingerprint: 'fp-2' }))
  assert.equal(errs.length, 1)
  assert.equal(errs[0].reasonCode, 'FINGERPRINT_MISMATCH')
  assert.equal(errs[0].index, LIST_LEVEL_INDEX)
  assert.equal('value' in errs[0], false)
})

test('지문 불일치는 좌표 오류보다 먼저 — 다른 파일 기준 마커는 좌표 검증 자체가 무의미', () => {
  const errs = reject(validateMarkers([-5, 9999], { durationSeconds: 200, fingerprint: 'A', expectedFingerprint: 'B' }))
  assert.deepEqual(errs.map((e) => e.reasonCode), ['FINGERPRINT_MISMATCH'])
})

test('fingerprintMatches: 둘 다 없음=true, 한쪽만=false, 공백/빈문자열=없음 취급', () => {
  assert.equal(fingerprintMatches(undefined, undefined), true)
  assert.equal(fingerprintMatches(null, ''), true)
  assert.equal(fingerprintMatches('  ', undefined), true)
  assert.equal(fingerprintMatches('fp', undefined), false)
  assert.equal(fingerprintMatches(undefined, 'fp'), false)
  assert.equal(fingerprintMatches('fp', 'fp'), true)
  assert.equal(fingerprintMatches(' fp ', 'fp'), true)
  assert.equal(fingerprintMatches('fp', 'FP'), false)
})

// ── 조용한 복구 금지 ───────────────────────────────────────────────────
test('no silent repair: 거부된 입력은 절대 "고쳐진" 형태로 반환되지 않는다', () => {
  const dirty: unknown[][] = [
    [60, 30],            // 정렬 필요
    [30, 30],            // 중복 제거 필요
    [0, 30],             // clamp 필요
    [30, 250],           // clamp 필요
    [30, NaN],           // 제거 필요
    [10, 10.001],        // 병합 필요
  ]
  for (const input of dirty) {
    const r = validateMarkers(input, { durationSeconds: 200 })
    assert.equal(r.ok, false, `${JSON.stringify(input)} 는 거부되어야 한다`)
    assert.equal('markers' in r, false, '거부 결과에는 markers 필드가 없어야 한다')
    assert.ok(reject(r).length > 0)
  }
})

test('배열이 아니면 TypeError(조용히 빈 목록 취급 금지)', () => {
  assert.throws(() => validateMarkers(null as unknown as number[], { durationSeconds: 200 }), TypeError)
  assert.throws(() => validateMarkers('30,60' as unknown as number[], { durationSeconds: 200 }), TypeError)
})

// ── 오류 payload 위생 ──────────────────────────────────────────────────
test('모든 reasonCode가 실제 입력으로 재현된다(사문화 코드 없음)', () => {
  const produced = new Set<string>()
  const cases: Array<[unknown[], number, Record<string, unknown>]> = [
    [[NaN], 200, {}],
    [[0], 200, {}],
    [[200], 200, {}],
    [[60, 30], 200, {}],
    [[30, 30], 200, {}],
    [[10, 10.001], 200, {}],
    [Array.from({ length: MAX_MARKER_COUNT + 1 }, (_, i) => i + 1), 1e6, {}] as [unknown[], number, Record<string, unknown>],
    [[30], 200, { fingerprint: 'A', expectedFingerprint: 'B' }],
    [[30], 0, {}],
  ]
  for (const [markers, durationSeconds, extra] of cases) {
    const r = validateMarkers(markers, { durationSeconds, ...extra })
    for (const e of reject(r)) produced.add(e.reasonCode)
  }
  assert.deepEqual([...produced].sort(), [...SPLIT_MARKER_REASON_CODES].sort())
})

test('오류 payload는 index/reasonCode/숫자값만 — 경로·파일명 필드 없음', () => {
  const cases: Array<() => ValidateMarkersResult> = [
    () => validateMarkers([NaN, 0, 250, 30], { durationSeconds: 200 }),
    () => validateMarkers([30], { durationSeconds: 200, fingerprint: '/tmp/a.wav', expectedFingerprint: '/tmp/b.wav' }),
    () => validateMarkers([30], { durationSeconds: 0 }),
    () => validateMarkers([10, 10.001], { durationSeconds: 200 }),
  ]
  const allowed = new Set(['index', 'reasonCode', 'value', 'limit'])
  for (const make of cases) {
    for (const e of reject(make())) {
      for (const k of Object.keys(e)) assert.ok(allowed.has(k), `허용되지 않은 필드: ${k}`)
      assert.equal(typeof e.index, 'number')
      assert.ok((SPLIT_MARKER_REASON_CODES as readonly string[]).includes(e.reasonCode))
      if ('value' in e) assert.equal(typeof e.value, 'number')
      if ('limit' in e) assert.equal(typeof e.limit, 'number')
      // 지문 문자열이 payload에 새어나오지 않는지 직접 확인.
      assert.equal(JSON.stringify(e).includes('.wav'), false)
      assert.equal(JSON.stringify(e).includes('tmp'), false)
    }
  }
})

// ── 사용자 문구 ────────────────────────────────────────────────────────
test('formatSplitMarkerError: 모든 코드가 한국어 문구를 갖고 경로를 노출하지 않는다', () => {
  for (const code of SPLIT_MARKER_REASON_CODES) {
    const msg = formatSplitMarkerError({ index: 0, reasonCode: code as SplitMarkerReasonCode, value: 12.5, limit: 200 })
    assert.ok(msg.length > 0, code)
    assert.ok(/[가-힣]/.test(msg), `${code} 는 한국어 문구여야 한다`)
    for (const leak of ['/', '\\', '.wav', '.mp3', 'undefined', 'NaN']) {
      assert.equal(msg.includes(leak), false, `${code} 문구에 ${leak} 노출 금지`)
    }
  }
})

test('formatSplitMarkerError: 마커 순번은 1-based, 목록 단위 오류는 순번 없음', () => {
  assert.ok(formatSplitMarkerError({ index: 0, reasonCode: 'MARKER_DUPLICATE', value: 30, limit: 30 }).startsWith('1번째'))
  assert.ok(!formatSplitMarkerError({ index: LIST_LEVEL_INDEX, reasonCode: 'FINGERPRINT_MISMATCH' }).includes('번째'))
})

test('마커 0개 안내 문구는 고정 문자열이고 SplitEditor가 그 상수를 쓴다', () => {
  assert.equal(AUTO_SILENCE_SPLIT_NOTICE, '마커가 없어 자동 무음 분할을 사용합니다.')
  const editor = readFileSync(EDITOR_PATH, 'utf-8')
  assert.ok(editor.includes('AUTO_SILENCE_SPLIT_NOTICE'), 'SplitEditor가 공유 상수를 쓰지 않고 문구를 복제하고 있다')
})
