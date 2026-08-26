// 생성 상한 telemetry 분석 계층 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/generationTelemetry.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeGenerationChunk, buildGenerationTelemetryReport, isAvailable,
  finiteNumber as tFinite, sampleRateOrNull as tRate, framesOrNull as tFrames,
  positiveSecondsOrNull as tSecs,
  type Metric, type MetricUnavailableReason,
} from './generationTelemetry.ts'
import {
  parseGenerationSummary,
  finiteNumber as cFinite, sampleRateOrNull as cRate, framesOrNull as cFrames,
  positiveSecondsOrNull as cSecs,
} from './ttsConfig.ts'

// ── 공통 헬퍼 ──────────────────────────────────────────────────────────────────
/** unavailable 의 정의: value 는 반드시 null(절대 0 아님) + available:false + reason 존재. */
function assertUnavailable(m: Metric, reason?: MetricUnavailableReason) {
  assert.equal(m.available, false)
  assert.equal(m.value, null, 'unavailable 은 value 가 null 이어야 한다')
  assert.notEqual(m.value, 0, 'unavailable 을 0 으로 위조 금지')
  assert.equal(isAvailable(m), false)
  assert.ok(m.reason, 'unavailable 은 이유를 남겨야 한다')
  if (reason) assert.equal(m.reason, reason)
}

function assertValue(m: Metric, v: number) {
  assert.equal(m.available, true)
  assert.equal(m.reason, null)
  assert.ok(isAvailable(m))
  assert.equal(m.value, v)
}

/** 현행 버전의 정상 chunk 행(python gen_chunks 가 내보내는 모양 그대로). */
const ROW = {
  original_segment_index: 0, chunk_index: 0, chunk_count: 1,
  production_tokens: 30, generation_limit: 247, generated_iterations: 90,
  termination_reason: 'completed_before_limit', emotion_id: 'happy',
  frames: 48000, gap_before_samples: 0, start_sample: 0, output_sample_rate: 24000,
}
/** 청정(속도 후처리 없음) 세션 */
const CLEAN = { speedPostprocessed: false as const }

// ── 1. 검증기 동작 일치(의도적 중복 두 벌이 갈라지지 않게 게이트에서 강제) ──
test('검증기 parity: ttsConfig 와 generationTelemetry 구현이 모든 적대적 입력에서 동일', () => {
  const table: unknown[] = [
    0, 1, -1, 0.5, -0.5, 24000, 24000.0, 48000, -24000,
    NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
    null, undefined, '', '0', '24000', true, false, [], [24000], {}, { sr: 1 }, () => 1,
  ]
  for (const v of table) {
    assert.equal(tFinite(v), cFinite(v), `finiteNumber(${String(v)})`)
    assert.equal(tRate(v), cRate(v), `sampleRateOrNull(${String(v)})`)
    assert.equal(tFrames(v), cFrames(v), `framesOrNull(${String(v)})`)
    assert.equal(tSecs(v), cSecs(v), `positiveSecondsOrNull(${String(v)})`)
  }
})

test('검증기: NaN/Infinity/음수/0 sample rate 거절 → null(0 아님)', () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, -24000, null, undefined, '24000', true, {}]) {
    assert.equal(cRate(bad), null, `sampleRateOrNull(${String(bad)})`)
    assert.notEqual(cRate(bad), 0, '0 으로 위조 금지')
  }
  assert.equal(cRate(24000), 24000)
})

test('검증기: 음수 frames 거절, 0 frames 는 유효 관측치', () => {
  for (const bad of [-1, -48000, NaN, Infinity, -Infinity, null, undefined, '0']) {
    assert.equal(cFrames(bad), null, `framesOrNull(${String(bad)})`)
  }
  assert.equal(cFrames(0), 0)
  assert.equal(cFrames(48000), 48000)
})

// ── 2. 필드 전달 왕복(python emit shape → ttsConfig parse) ──
test('왕복: python gen_chunks emit 모양 → parseGenerationSummary 가 frames/output_sample_rate 전달', () => {
  const metadata = JSON.parse(JSON.stringify({
    output_sample_rate: 24000, elapsed_seconds: 12.34, device: 'cuda:0',
    speed_postprocessed: false,
    generation_limit: 247, generated_iterations: 90, termination_reason: 'completed_before_limit',
    generation_chunks: [ROW, { ...ROW, chunk_index: 1, frames: 24000, generated_iterations: 45 }],
  }))
  const g = parseGenerationSummary(metadata)
  assert.ok(g)
  assert.equal(g.chunks.length, 2)
  assert.equal(g.chunks[0].frames, 48000)
  assert.equal(g.chunks[0].output_sample_rate, 24000)
  assert.equal(g.chunks[1].frames, 24000)
  assert.equal(g.chunks[1].output_sample_rate, 24000)
  // 기존 계약이 그대로다(회귀 방지).
  assert.equal(g.chunks[0].generated_iterations, 90)
  assert.equal(g.chunks[0].generation_limit, 247)
  assert.equal(g.chunks[0].production_tokens, 30)
  assert.equal(g.chunks[0].termination_reason, 'completed_before_limit')
  assert.equal(g.chunks[0].emotion_id, 'happy')
})

test('왕복: JSON 직렬화 후에도 새 필드가 살아남는다(세션 저장/복원 경로)', () => {
  const before = parseGenerationSummary({ generation_chunks: [ROW] })
  const restored = parseGenerationSummary(JSON.parse(JSON.stringify({ generation_chunks: [ROW] })))
  assert.deepEqual(restored, before)
  assert.equal(restored!.chunks[0].output_sample_rate, 24000)
  // 파싱 결과 자체도 직렬화 가능해야 한다(세션에 그대로 실려도 안전).
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), restored)
})

// ── 3. 구 metadata 복원(새 필드 없음) → unavailable, 절대 0 아님 ──
test('구 session 복원: frames/output_sample_rate 부재 → null(0 아님), crash 없음', () => {
  const old = {
    generation_limit: 256, generated_iterations: 180, termination_reason: 'completed_before_limit',
    generation_chunks: [{
      original_segment_index: 0, chunk_index: 0, chunk_count: 1,
      production_tokens: 30, generation_limit: 247, generated_iterations: 90,
      termination_reason: 'completed_before_limit',
    }],
  }
  const g = parseGenerationSummary(old)
  assert.ok(g)
  assert.equal(g.chunks[0].frames, null)
  assert.notEqual(g.chunks[0].frames, 0)
  assert.equal(g.chunks[0].output_sample_rate, null)
  assert.notEqual(g.chunks[0].output_sample_rate, 0)
  // 기존 필드는 그대로 살아있다 — 구 소비자 호환.
  assert.equal(g.chunks[0].generated_iterations, 90)
  assert.equal(g.limit, 256)
})

test('구 session 복원: 이상값도 throw 하지 않고 unavailable 로 표면화', () => {
  const nasty = {
    speed_postprocessed: false,
    generation_chunks: [
      { ...ROW, frames: -1, output_sample_rate: 0 },
      { ...ROW, chunk_index: 1, frames: NaN, output_sample_rate: NaN },
      { ...ROW, chunk_index: 2, frames: Infinity, output_sample_rate: -24000 },
      { ...ROW, chunk_index: 3, frames: '48000', output_sample_rate: '24000' },
    ],
  }
  const g = parseGenerationSummary(nasty)      // throw 하지 않는다
  assert.ok(g)
  assert.equal(g.chunks.length, 4)
  for (const c of g.chunks) {
    assert.equal(c.frames, null)
    assert.equal(c.output_sample_rate, null)
    assert.notEqual(c.frames, 0)
    assert.notEqual(c.output_sample_rate, 0)
  }
  const rep = buildGenerationTelemetryReport(nasty)   // 분석도 throw 하지 않는다
  assert.equal(rep.chunks.length, 4)
  assertUnavailable(rep.chunks[0].output_duration_sec, 'invalid_frames')
  assertUnavailable(rep.chunks[1].output_duration_sec, 'invalid_frames')
})

test('frames 는 현행 버전에서도 조건부 부재 가능(layout 불일치) → missing_frames', () => {
  // sample rate 는 있고 frames 만 없는 조합 = python 의 조건부 frames 첨부 실패 상태.
  const row: Record<string, unknown> = { ...ROW }
  delete row.frames
  delete row.gap_before_samples
  delete row.start_sample
  const a = analyzeGenerationChunk(row, CLEAN)
  assertUnavailable(a.output_duration_sec, 'missing_frames')
  assertUnavailable(a.samples_per_iteration, 'missing_frames')
  assertUnavailable(a.output_seconds_per_iteration, 'missing_frames')
  // frames 와 무관한 지표는 계속 나온다.
  assertValue(a.safety_margin_iterations, 247 - 90)
  assertValue(a.utilization_ratio, 90 / 247)
})

test('부재와 거절을 이유로 구분한다(missing_* vs invalid_*)', () => {
  const noRate: Record<string, unknown> = { ...ROW }
  delete noRate.output_sample_rate
  assertUnavailable(analyzeGenerationChunk(noRate, CLEAN).output_duration_sec, 'missing_sample_rate')
  assertUnavailable(analyzeGenerationChunk({ ...ROW, output_sample_rate: 0 }, CLEAN).output_duration_sec,
                    'invalid_sample_rate')
  assertUnavailable(analyzeGenerationChunk({ ...ROW, output_sample_rate: NaN }, CLEAN).output_duration_sec,
                    'invalid_sample_rate')
  assertUnavailable(analyzeGenerationChunk({ ...ROW, output_sample_rate: -24000 }, CLEAN).output_duration_sec,
                    'invalid_sample_rate')
})

// ── 4. 파생 지표 계산 ──────────────────────────────────────────────────────────
test('output_duration_sec = frames / output_sample_rate', () => {
  assertValue(analyzeGenerationChunk(ROW, CLEAN).output_duration_sec, 2.0)
  assertValue(analyzeGenerationChunk({ ...ROW, frames: 31200 }, CLEAN).output_duration_sec, 1.3)
  // 0 frames 는 유효 관측치 → 0 초. (여기서의 0 은 '측정된 0' 이고 unavailable 이 아니다.)
  const zero = analyzeGenerationChunk({ ...ROW, frames: 0 }, CLEAN)
  assertValue(zero.output_duration_sec, 0)
})

test('samples_per_iteration / output_seconds_per_iteration (청정 행)', () => {
  const a = analyzeGenerationChunk(ROW, CLEAN)
  assertValue(a.samples_per_iteration, 48000 / 90)
  assertValue(a.output_seconds_per_iteration, 2.0 / 90)
})

test('safety_margin_iterations = applied_limit − generated_iterations, utilization_ratio', () => {
  const a = analyzeGenerationChunk({ ...ROW, generation_limit: 256, generated_iterations: 200 }, CLEAN)
  assertValue(a.safety_margin_iterations, 56)
  assertValue(a.utilization_ratio, 200 / 256)
  // 상한에 도달한 행: 여유 0 은 '측정된 0' 이므로 유효값이다.
  const at = analyzeGenerationChunk({ ...ROW, generation_limit: 256, generated_iterations: 256 }, CLEAN)
  assertValue(at.safety_margin_iterations, 0)
  assertValue(at.utilization_ratio, 1)
})

// ── 5. 0 나눗셈 방어 ──────────────────────────────────────────────────────────
test('0 나눗셈 방어: generated_iterations === 0 → 관련 지표 전부 unavailable(Infinity/NaN 아님)', () => {
  const a = analyzeGenerationChunk({ ...ROW, generated_iterations: 0, generation_elapsed_sec: 5 }, CLEAN)
  assertUnavailable(a.seconds_per_iteration, 'zero_iterations')
  assertUnavailable(a.output_seconds_per_iteration, 'zero_iterations')
  assertUnavailable(a.samples_per_iteration, 'zero_iterations')
  for (const m of [a.seconds_per_iteration, a.output_seconds_per_iteration, a.samples_per_iteration]) {
    assert.notEqual(m.value, Infinity)
    assert.ok(!Number.isNaN(m.value as unknown as number))
  }
  // 나눗셈이 없는 지표는 0 iteration 에서도 유효하다.
  assertValue(a.safety_margin_iterations, 247)
  assertValue(a.utilization_ratio, 0)
})

test('0 나눗셈 방어: applied_limit === 0 → utilization_ratio unavailable', () => {
  const a = analyzeGenerationChunk({ ...ROW, generation_limit: 0 }, CLEAN)
  assertUnavailable(a.utilization_ratio, 'zero_applied_limit')
  assert.notEqual(a.utilization_ratio.value, Infinity)
  // 뺄셈은 성립한다.
  assertValue(a.safety_margin_iterations, -90)
})

test('0 나눗셈 방어: iterations/limit 부재 → missing_*', () => {
  const noIter: Record<string, unknown> = { ...ROW }
  delete noIter.generated_iterations
  const a = analyzeGenerationChunk(noIter, CLEAN)
  assertUnavailable(a.samples_per_iteration, 'missing_iterations')
  assertUnavailable(a.safety_margin_iterations, 'missing_iterations')
  assertUnavailable(a.utilization_ratio, 'missing_iterations')
  const noLimit: Record<string, unknown> = { ...ROW }
  delete noLimit.generation_limit
  const b = analyzeGenerationChunk(noLimit, CLEAN)
  assertUnavailable(b.safety_margin_iterations, 'missing_applied_limit')
  assertUnavailable(b.utilization_ratio, 'missing_applied_limit')
})

// ── 6. seconds_per_iteration: 아직 없는 필드. elapsed_seconds 로 대체하지 않는다. ──
test('seconds_per_iteration: generation_elapsed_sec 부재 → unavailable', () => {
  const a = analyzeGenerationChunk(ROW, CLEAN)
  assertUnavailable(a.seconds_per_iteration, 'missing_generation_elapsed_sec')
})

test('seconds_per_iteration: elapsed_seconds 는 절대 대체값이 아니다', () => {
  // elapsed_seconds 는 device 선택·참조 평가·모델 로딩·concat·pitch·원자적 배치를 포함한
  // 작업 전체 시간이므로 생성 시간이 아니다. 있어도 seconds_per_iteration 은 나오지 않는다.
  const rep = buildGenerationTelemetryReport({
    elapsed_seconds: 123.45, speed_postprocessed: false, generation_chunks: [ROW],
  })
  assertUnavailable(rep.chunks[0].seconds_per_iteration, 'missing_generation_elapsed_sec')
  assertUnavailable(rep.aggregate.mean_seconds_per_iteration, 'missing_generation_elapsed_sec')
})

test('seconds_per_iteration: 필드가 chunk 단위로 추가되면 코드 변경 없이 동작', () => {
  const a = analyzeGenerationChunk({ ...ROW, generation_elapsed_sec: 45 }, CLEAN)
  assertValue(a.seconds_per_iteration, 0.5)     // 45 / 90
})

test('seconds_per_iteration: 필드가 상위(job) 단위로 추가되면 코드 변경 없이 동작', () => {
  const rep = buildGenerationTelemetryReport({
    speed_postprocessed: false, generation_elapsed_sec: 45, generation_chunks: [ROW],
  })
  assertValue(rep.chunks[0].seconds_per_iteration, 0.5)
  assertValue(rep.aggregate.mean_seconds_per_iteration, 0.5)
  // chunk 값이 있으면 chunk 값이 이긴다(더 정확한 관측 단위).
  const rep2 = buildGenerationTelemetryReport({
    speed_postprocessed: false, generation_elapsed_sec: 900,
    generation_chunks: [{ ...ROW, generation_elapsed_sec: 45 }],
  })
  assertValue(rep2.chunks[0].seconds_per_iteration, 0.5)
})

// ── 7. 속도 후처리 오염 규칙 ──────────────────────────────────────────────────
test('오염: speed_postprocessed === true → samples/output-sec per iteration 무효, 나머지 유지', () => {
  const a = analyzeGenerationChunk(ROW, { speedPostprocessed: true })
  assert.equal(a.speed_contaminated, true)
  assertUnavailable(a.samples_per_iteration, 'speed_postprocessed')
  assertUnavailable(a.output_seconds_per_iteration, 'speed_postprocessed')
  // frames 는 'pre-pitch 파일의 실제 길이' 라는 사실이므로 duration 은 계속 계산한다.
  assertValue(a.output_duration_sec, 2.0)
  assertValue(a.safety_margin_iterations, 157)
  assertValue(a.utilization_ratio, 90 / 247)
})

test('오염: speed_postprocessed 불명(구 session) → 보수적으로 오염 취급', () => {
  const a = analyzeGenerationChunk(ROW, {})
  assert.equal(a.speed_contaminated, true)
  assertUnavailable(a.samples_per_iteration, 'speed_unknown')
  assertUnavailable(a.output_seconds_per_iteration, 'speed_unknown')
  const rep = buildGenerationTelemetryReport({ generation_chunks: [ROW] })   // speed 키 없음
  assert.equal(rep.speed_postprocessed, null)
  assert.equal(rep.excluded_for_speed, 1)
})

test('오염 행은 집계 평균에 섞이지 않고 제외 수로 보고된다', () => {
  const contaminated = buildGenerationTelemetryReport({
    speed_postprocessed: true,
    generation_chunks: [ROW, { ...ROW, chunk_index: 1, frames: 24000, generated_iterations: 45 }],
  })
  assert.equal(contaminated.speed_postprocessed, true)
  assert.equal(contaminated.excluded_for_speed, 2)
  assert.equal(contaminated.aggregate.counted.samples_per_iteration, 0)
  assert.equal(contaminated.aggregate.counted.output_seconds_per_iteration, 0)
  assertUnavailable(contaminated.aggregate.mean_samples_per_iteration, 'speed_postprocessed')
  assertUnavailable(contaminated.aggregate.mean_output_seconds_per_iteration, 'speed_postprocessed')
  // 오염과 무관한 집계는 계속 나온다 — 조용한 침묵도, 조용한 평균도 없다.
  assertValue(contaminated.aggregate.total_output_duration_sec, 3.0)
  assertValue(contaminated.aggregate.min_safety_margin_iterations, 247 - 90)
  assertValue(contaminated.aggregate.max_utilization_ratio, 90 / 247)

  const clean = buildGenerationTelemetryReport({
    speed_postprocessed: false,
    generation_chunks: [ROW, { ...ROW, chunk_index: 1, frames: 24000, generated_iterations: 45 }],
  })
  assert.equal(clean.excluded_for_speed, 0)
  assert.equal(clean.aggregate.counted.samples_per_iteration, 2)
  // (48000/90 + 24000/45) / 2
  assertValue(clean.aggregate.mean_samples_per_iteration, (48000 / 90 + 24000 / 45) / 2)
})

// ── 8. 리포트 전반: 빈/비정상 입력, 파생값 비저장 ──
test('리포트: null/빈 metadata → chunk 0, 집계는 전부 unavailable(0 아님)', () => {
  for (const m of [null, undefined, {}, { generation_chunks: 'nope' }, { generation_chunks: [] }]) {
    const rep = buildGenerationTelemetryReport(m as Record<string, unknown> | null)
    assert.equal(rep.chunks.length, 0)
    assert.equal(rep.aggregate.chunk_count, 0)
    assertUnavailable(rep.aggregate.total_output_duration_sec, 'no_valid_rows')
    assertUnavailable(rep.aggregate.min_safety_margin_iterations, 'no_valid_rows')
    assert.notEqual(rep.aggregate.total_output_duration_sec.value, 0)
  }
})

test('리포트: 배열 안 비정상 항목은 무시하고 crash 없음', () => {
  const rep = buildGenerationTelemetryReport({
    speed_postprocessed: false,
    generation_chunks: [null, 42, 'nope', [], ROW],
  })
  assert.equal(rep.chunks.length, 1)
  assertValue(rep.chunks[0].output_duration_sec, 2.0)
})

test('파생 지표는 계산 결과이며 metadata 에 저장되지 않는다', () => {
  const metadata: Record<string, unknown> = {
    speed_postprocessed: false, generation_chunks: [{ ...ROW }],
  }
  const snapshot = JSON.stringify(metadata)
  buildGenerationTelemetryReport(metadata)
  assert.equal(JSON.stringify(metadata), snapshot, '분석이 입력 metadata 를 변경하면 안 된다')
  const derived = ['output_duration_sec', 'seconds_per_iteration', 'output_seconds_per_iteration',
                   'samples_per_iteration', 'safety_margin_iterations', 'utilization_ratio']
  for (const k of derived) {
    assert.ok(!(k in metadata), `${k} 은 metadata 에 저장되지 않는다`)
    assert.ok(!(k in (metadata.generation_chunks as Record<string, unknown>[])[0]),
              `${k} 은 chunk 행에도 저장되지 않는다`)
  }
})

test('리포트 자체가 JSON 직렬화 가능(진단 로그/세션에 실어도 안전)', () => {
  const rep = buildGenerationTelemetryReport({
    speed_postprocessed: false, generation_chunks: [ROW, { ...ROW, chunk_index: 1, frames: 0 }],
  })
  const round = JSON.parse(JSON.stringify(rep))
  assert.deepEqual(round, rep)
  assert.equal(round.chunks[0].output_duration_sec.value, 2.0)
  assert.equal(round.chunks[1].output_duration_sec.value, 0)
})

test('parseGenerationSummary 출력 행을 그대로 분석에 넣을 수 있다(구조적 호환)', () => {
  const g = parseGenerationSummary({ speed_postprocessed: false, generation_chunks: [ROW] })
  assert.ok(g)
  const a = analyzeGenerationChunk(g.chunks[0], CLEAN)
  assertValue(a.output_duration_sec, 2.0)
  assertValue(a.samples_per_iteration, 48000 / 90)
})

// ── 9. generation_elapsed_sec 가 실재하게 된 뒤의 계약 ─────────────────────────
// 이 필드는 이제 production 에 존재한다(qwen_bridge 가 blocking 생성 호출 하나만 감싸 측정하고
// tts_worker 가 chunk 행에 가산한다). 위 6절 테스트들이 '부재 → unavailable' 을 계속 고정하는
// 이유는, 필드가 조건부로 빠질 수 있고(구 session, bridge 가 값을 못 남긴 실행) 그때 0 으로
// 위조되면 안 되기 때문이다.

test('검증기: 0/음수 generation_elapsed_sec 거절 → null(0 아님)', () => {
  // elapsed 는 분자다. 0 이 통과하면 crash 없이 seconds_per_iteration = 0 이라는 거짓이 나온다.
  for (const bad of [0, -0.0, -1, -35.2, NaN, Infinity, -Infinity, null, undefined, '35.2', true, {}]) {
    assert.equal(tSecs(bad), null, `positiveSecondsOrNull(${String(bad)})`)
    assert.notEqual(tSecs(bad), 0, '0 으로 위조 금지')
  }
  assert.equal(tSecs(35.271), 35.271)
  assert.equal(tSecs(1e-6), 1e-6)
})

test('seconds_per_iteration: 0/이상값은 missing 이 아니라 invalid 로 구분된다', () => {
  // 부재(구 session)와 '있지만 못 쓰는 값'을 섞으면 원인 추적이 불가능해진다.
  assertUnavailable(
    analyzeGenerationChunk({ ...ROW }, CLEAN).seconds_per_iteration,
    'missing_generation_elapsed_sec')
  for (const bad of [0, -1, NaN, Infinity]) {
    assertUnavailable(
      analyzeGenerationChunk({ ...ROW, generation_elapsed_sec: bad }, CLEAN).seconds_per_iteration,
      'invalid_generation_elapsed_sec')
  }
})

test('seconds_per_iteration: 실제 관측 형태로 계산된다', () => {
  const a = analyzeGenerationChunk({ ...ROW, generation_elapsed_sec: 35.271 }, CLEAN)
  assertValue(a.seconds_per_iteration, 35.271 / 90)
  // 오염과 무관하다 — elapsed 는 speed 후처리의 영향을 받지 않는다(frames 만 오염된다).
  const c = analyzeGenerationChunk({ ...ROW, generation_elapsed_sec: 35.271 },
    { speedPostprocessed: true })
  assertValue(c.seconds_per_iteration, 35.271 / 90)
  assertUnavailable(c.samples_per_iteration, 'speed_postprocessed')
})

test('왕복: generation_elapsed_sec 가 python emit → parseGenerationSummary 를 통과한다', () => {
  const metadata = JSON.parse(JSON.stringify({
    output_sample_rate: 24000, elapsed_seconds: 120.5, device: 'cuda:0', speed_postprocessed: false,
    generation_chunks: [
      { ...ROW, generation_elapsed_sec: 35.271 },
      { ...ROW, chunk_index: 1, generated_iterations: 45, generation_elapsed_sec: 17.8 },
    ],
  }))
  const g = parseGenerationSummary(metadata)
  assert.ok(g)
  assert.equal(g.chunks[0].generation_elapsed_sec, 35.271)
  assert.equal(g.chunks[1].generation_elapsed_sec, 17.8)
  // 작업 전체 시간이 chunk 행으로 새어 들어오지 않는다.
  assert.notEqual(g.chunks[0].generation_elapsed_sec, 120.5)
  const rep = buildGenerationTelemetryReport(metadata)
  assertValue(rep.chunks[0].seconds_per_iteration, 35.271 / 90)
  assertValue(rep.chunks[1].seconds_per_iteration, 17.8 / 45)
})

test('구 session 복원: generation_elapsed_sec 부재 → null(0 아님), crash 없음', () => {
  const g = parseGenerationSummary({
    speed_postprocessed: false,
    generation_chunks: [{
      original_segment_index: 0, chunk_index: 0, chunk_count: 1,
      generated_iterations: 90, generation_limit: 247,
      termination_reason: 'completed_before_limit',
    }],
  })
  assert.ok(g)
  assert.equal(g.chunks[0].generation_elapsed_sec, null)
  assert.notEqual(g.chunks[0].generation_elapsed_sec, 0)
})

test('구 session 복원: 이상 generation_elapsed_sec 도 throw 하지 않고 null 로 정규화', () => {
  for (const bad of [0, -5, 'x', {}, [], true, NaN, Infinity]) {
    const g = parseGenerationSummary({
      speed_postprocessed: false,
      generation_chunks: [{ ...ROW, generation_elapsed_sec: bad }],
    })
    assert.ok(g)
    assert.equal(g.chunks[0].generation_elapsed_sec, null, `bad=${String(bad)}`)
  }
})
