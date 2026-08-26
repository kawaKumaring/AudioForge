// 생성 상한(계약 A/B) 분석 계층 — 순수 함수만. 여기서 나오는 수치는 전부 **계산 결과**이고
// metadata 에는 절대 저장되지 않는다. metadata 는 관측한 원시값(frames, output_sample_rate,
// generated_iterations, generation_limit)만 담고, 비율/초 환산은 이 파일이 책임진다.
//
// 왜 src/shared 인가: 이 저장소는 프로세스 경계를 넘는 순수 로직을 전부 src/shared 에 두고
// 옆에 *.test.ts 를 붙인다(ttsConfig / ttsGrammar / splitMarkers / sidecarEvents / cancelContract).
// npm test 가 src/**/*.test.ts 를 글롭하므로 여기 두면 자동으로 게이트에 들어가고, main(진단 로그)
// 과 renderer(결과 패널) 양쪽에서 같은 코드로 같은 숫자를 낸다. 새 의존성 0.
//
// 왜 ttsConfig.ts 의 검증기를 import 하지 않는가(의도적 중복):
//   - 이 파일은 tsc 대상(src/shared/**/*.ts)이라 './ttsConfig.ts' 로 쓸 수 없다 → TS5097
//     (allowImportingTsExtensions 미설정). 빌드 설정을 이 진단 작업으로 바꾸지 않는다.
//   - './ttsConfig' 로 확장자를 빼면 node --test 가 ERR_MODULE_NOT_FOUND 로 죽는다(ESM 은 확장자
//     탐색을 하지 않는다). 테스트 파일들만 '.ts' 를 쓸 수 있는 이유는 tsc 가 그것들을 exclude 하기 때문.
// 그래서 검증기를 여기에 한 벌 더 둔다. 두 벌이 갈라지면 파싱과 분석이 다른 숫자를 내므로,
// generationTelemetry.test.ts 가 적대적 입력 표로 두 구현의 동작 일치를 게이트에서 강제한다.

// finiteNumber: NaN/Infinity/-Infinity/비수치 → null
export function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
// sampleRateOrNull: 0과 음수도 거절(0 이면 duration 이 Infinity 가 된다).
export function sampleRateOrNull(v: unknown): number | null {
  const n = finiteNumber(v)
  return n != null && n > 0 ? n : null
}
// framesOrNull: 음수 거절, 0 은 유효(길이 0 이라는 실재 관측치).
export function framesOrNull(v: unknown): number | null {
  const n = finiteNumber(v)
  return n != null && n >= 0 ? n : null
}

// ── 'unavailable' 표현 ─────────────────────────────────────────────────────────
// value 는 계산이 성립한 경우에만 number 이고, 그 외에는 **항상 null** 이다. 0 으로 위조하지
// 않는다: 0 초/0 iteration 은 '측정값 0' 이라는 전혀 다른 주장이고, 평균에 섞이면 분석이
// 조용히 틀린다. available:false + reason 으로 '왜 없는지'까지 남긴다.
export type MetricUnavailableReason =
  | 'missing_frames'                  // frames 부재/거절 (Python 쪽 조건부 필드 — 현행 실행에서도 가능)
  | 'invalid_frames'                  // frames 가 음수/NaN/Infinity
  | 'missing_sample_rate'             // output_sample_rate 부재 (구 session)
  | 'invalid_sample_rate'             // sample rate 가 0/음수/NaN/Infinity
  | 'missing_iterations'              // generated_iterations 부재
  | 'zero_iterations'                 // 0 으로 나눌 수 없음(복원/구 데이터에서 실제로 0 가능)
  | 'missing_applied_limit'           // 이 chunk 에 적용된 동적 상한 부재
  | 'zero_applied_limit'              // 0 으로 나눌 수 없음
  | 'missing_generation_elapsed_sec'  // 아직 존재하지 않는 필드 — 추가되면 자동으로 available 이 된다
  | 'speed_postprocessed'            // 속도 후처리가 frames 를 오염시켰다 → iteration 당 지표 무효
  | 'speed_unknown'                  // 오염 여부를 증명할 수 없다 → 보수적으로 무효 취급
  | 'no_valid_rows'                  // 집계에 넣을 유효 행이 하나도 없다

export interface Metric {
  value: number | null
  available: boolean
  reason: MetricUnavailableReason | null
}

const ok = (value: number): Metric => ({ value, available: true, reason: null })
const na = (reason: MetricUnavailableReason): Metric => ({ value: null, available: false, reason })

/** 이 Metric 이 유효한 수치인지. value 를 쓰기 전 유일한 관문. */
export function isAvailable(m: Metric): m is Metric & { value: number } {
  return m.available && m.value != null
}

// ── 입력 행 ────────────────────────────────────────────────────────────────────
// generation_chunks 항목을 그대로 받는다(구조적 호환 — GenerationChunk 를 그대로 넣을 수 있고,
// 아직 GenerationChunk 에 없는 필드가 metadata 에 생기면 여기서 먼저 읽힌다).
export interface TelemetryChunkInput {
  original_segment_index?: unknown
  chunk_index?: unknown
  frames?: unknown
  output_sample_rate?: unknown
  generated_iterations?: unknown
  generation_limit?: unknown
  production_tokens?: unknown
  termination_reason?: unknown
  // 아직 Python 에 존재하지 않는 필드. 지금은 언제나 부재 → seconds_per_iteration 은 unavailable.
  // 나중에 chunk 단위로 추가되면 이 코드 변경 없이 즉시 동작한다.
  generation_elapsed_sec?: unknown
}

export interface AnalysisOptions {
  // 상위 metadata 의 speed_postprocessed. true = frames 오염, false = 청정, null = 불명.
  speedPostprocessed?: boolean | null
  // 상위 metadata 의 generation_elapsed_sec(아직 없음). chunk 값이 없을 때만 쓰인다.
  jobGenerationElapsedSec?: unknown
}

export interface ChunkAnalysis {
  original_segment_index: number | null
  chunk_index: number | null
  /** frames 가 속도 후처리로 오염됐는가(또는 오염 여부 불명인가). true 면 iteration 당 지표 무효. */
  speed_contaminated: boolean
  /** frames / output_sample_rate — 이 chunk 의 pre-pitch 출력 길이(초). */
  output_duration_sec: Metric
  /** generation_elapsed_sec / generated_iterations — 필드가 생기기 전에는 항상 unavailable. */
  seconds_per_iteration: Metric
  /** output_duration_sec / generated_iterations — 오염 행에서는 무효. */
  output_seconds_per_iteration: Metric
  /** frames / generated_iterations — 오염 행에서는 무효. */
  samples_per_iteration: Metric
  /** applied_limit − generated_iterations — 상한까지 남은 여유. */
  safety_margin_iterations: Metric
  /** generated_iterations / applied_limit — 상한 소진율. */
  utilization_ratio: Metric
}

// ── 단일 chunk 분석 ────────────────────────────────────────────────────────────
/**
 * 한 chunk 행의 파생 지표를 계산한다. 어떤 입력에도 throw 하지 않는다 —
 * 세션 복원 중 이상값 하나가 복원을 깨뜨리면 안 된다.
 *
 * 오염 규칙(중요): frames 는 **pitch 적용 전 pending 파일**에서 측정되고 **속도 후처리를 포함**한다.
 * 따라서 speed_postprocessed 가 true 면 frames 는 모델이 생성한 양이 아니라 atempo 로 늘어나거나
 * 줄어든 양이다. iteration 으로 나누는 두 지표(samples_per_iteration,
 * output_seconds_per_iteration)는 그 경우 의미가 없으므로 값을 내지 않고 이유와 함께 무효로 만든다.
 * output_duration_sec 자체는 '그 파일의 실제 길이'라는 사실이므로 계속 계산한다.
 */
export function analyzeGenerationChunk(row: TelemetryChunkInput | null | undefined,
                                       opts: AnalysisOptions = {}): ChunkAnalysis {
  const r = (row && typeof row === 'object') ? row : {}
  const speed = opts.speedPostprocessed
  // 청정임을 명시적으로 확인한 경우(=== false)에만 청정으로 본다. 불명(null/undefined)은 오염 취급 —
  // 증명할 수 없는 데이터로 조용히 평균을 내는 것보다 표시하고 빼는 쪽이 옳다.
  const contaminated = speed !== false
  const contamReason: MetricUnavailableReason = speed === true ? 'speed_postprocessed' : 'speed_unknown'

  // 원시값 검증 — 부재와 '거절된 이상값'을 이유로 구분한다.
  const rawFrames = r.frames
  const frames = framesOrNull(rawFrames)
  const framesReason: MetricUnavailableReason | null =
    frames != null ? null : (rawFrames == null ? 'missing_frames' : 'invalid_frames')

  const rawRate = r.output_sample_rate
  const rate = sampleRateOrNull(rawRate)
  const rateReason: MetricUnavailableReason | null =
    rate != null ? null : (rawRate == null ? 'missing_sample_rate' : 'invalid_sample_rate')

  const iters = finiteNumber(r.generated_iterations)
  const limit = finiteNumber(r.generation_limit)   // 이 chunk 에 실제로 적용된 동적 상한
  const elapsed = finiteNumber(r.generation_elapsed_sec) ?? finiteNumber(opts.jobGenerationElapsedSec)

  // output_duration_sec = frames / rate
  let outDur: Metric
  if (framesReason) outDur = na(framesReason)
  else if (rateReason) outDur = na(rateReason)
  else outDur = ok(frames! / rate!)

  // iteration 으로 나누는 지표들의 공통 분모 검사 — 0 나눗셈 방어.
  // (production 은 iters==0 이면 예외를 던지지만, 복원된/구 데이터에는 0 이 실제로 들어있을 수 있다.)
  const iterDenom: MetricUnavailableReason | null =
    iters == null ? 'missing_iterations' : (iters === 0 ? 'zero_iterations' : null)

  // seconds_per_iteration = generation_elapsed_sec / generated_iterations
  // elapsed_seconds 로 대체하지 않는다: 그 값은 device 선택·참조 평가·모델 로딩·concat·pitch·원자적
  // 배치까지 포함한 작업 전체 시간이라 '생성 시간'이 아니다.
  let secPerIter: Metric
  if (elapsed == null) secPerIter = na('missing_generation_elapsed_sec')
  else if (iterDenom) secPerIter = na(iterDenom)
  else secPerIter = ok(elapsed / iters!)

  // output_seconds_per_iteration / samples_per_iteration — 오염 시 무효.
  let outSecPerIter: Metric
  let samplesPerIter: Metric
  if (contaminated) {
    outSecPerIter = na(contamReason)
    samplesPerIter = na(contamReason)
  } else {
    outSecPerIter = !isAvailable(outDur) ? na(outDur.reason!)
      : iterDenom ? na(iterDenom) : ok(outDur.value / iters!)
    samplesPerIter = framesReason ? na(framesReason)
      : iterDenom ? na(iterDenom) : ok(frames! / iters!)
  }

  // safety_margin_iterations = applied_limit − generated_iterations (나눗셈 없음 → 0 상한 허용)
  let margin: Metric
  if (limit == null) margin = na('missing_applied_limit')
  else if (iters == null) margin = na('missing_iterations')
  else margin = ok(limit - iters)

  // utilization_ratio = generated_iterations / applied_limit — 0 상한 방어
  let util: Metric
  if (iters == null) util = na('missing_iterations')
  else if (limit == null) util = na('missing_applied_limit')
  else if (limit === 0) util = na('zero_applied_limit')
  else util = ok(iters / limit)

  return {
    original_segment_index: finiteNumber(r.original_segment_index),
    chunk_index: finiteNumber(r.chunk_index),
    speed_contaminated: contaminated,
    output_duration_sec: outDur,
    seconds_per_iteration: secPerIter,
    output_seconds_per_iteration: outSecPerIter,
    samples_per_iteration: samplesPerIter,
    safety_margin_iterations: margin,
    utilization_ratio: util,
  }
}

// ── 리포트(집계) ───────────────────────────────────────────────────────────────
export interface GenerationTelemetryReport {
  /** 상위 metadata 의 speed_postprocessed 를 그대로. null = 구 session 등에서 불명. */
  speed_postprocessed: boolean | null
  chunks: ChunkAnalysis[]
  /** 오염(또는 오염 불명)으로 iteration 당 지표에서 제외된 행 수. 조용히 평균에 섞지 않는다. */
  excluded_for_speed: number
  aggregate: {
    chunk_count: number
    /** 유효한 output_duration_sec 의 합. 하나도 없으면 unavailable. */
    total_output_duration_sec: Metric
    mean_seconds_per_iteration: Metric
    /** 오염 행 제외 후 평균. */
    mean_output_seconds_per_iteration: Metric
    /** 오염 행 제외 후 평균. */
    mean_samples_per_iteration: Metric
    /** 상한에 가장 가까웠던 chunk 의 여유(최솟값) — 상한 위험 판단의 핵심 수치. */
    min_safety_margin_iterations: Metric
    /** 최대 소진율. */
    max_utilization_ratio: Metric
    /** 각 집계에 실제로 들어간 행 수. 평균을 몇 개로 냈는지 숨기지 않는다. */
    counted: {
      output_duration_sec: number
      seconds_per_iteration: number
      output_seconds_per_iteration: number
      samples_per_iteration: number
      safety_margin_iterations: number
      utilization_ratio: number
    }
  }
}

type MetricKey = 'output_duration_sec' | 'seconds_per_iteration' | 'output_seconds_per_iteration'
  | 'samples_per_iteration' | 'safety_margin_iterations' | 'utilization_ratio'

function values(rows: ChunkAnalysis[], key: MetricKey): number[] {
  const out: number[] = []
  for (const r of rows) {
    const m = r[key]
    if (isAvailable(m)) out.push(m.value)
  }
  return out
}

// 행들이 모두 같은 이유로 무효면 그 이유를 그대로 올린다(예: 필드가 아예 없는 세션 → 전부
// missing_generation_elapsed_sec). 이유가 섞였거나 행이 아예 없으면 no_valid_rows.
function emptyReasonOf(rows: ChunkAnalysis[], key: MetricKey): MetricUnavailableReason {
  const reasons = new Set<MetricUnavailableReason>()
  for (const r of rows) {
    const m = r[key]
    if (!isAvailable(m) && m.reason) reasons.add(m.reason)
  }
  return reasons.size === 1 ? [...reasons][0] : 'no_valid_rows'
}

// 유효 행이 0 이면 0 이 아니라 unavailable. 합계 0 은 '길이가 0' 이라는 거짓 주장이 된다.
// reasonRows: 값은 valueRows(오염 제외 후)에서 오지만, 그것이 비었을 때 '왜 비었는지'는 제외 전
// 전체 행에서 읽어야 한다. 그러지 않으면 전 행이 오염된 세션이 'no_valid_rows' 로 뭉개져
// '속도 후처리 때문에 뺐다'는 진짜 이유가 사라진다.
function reduceOrNa(valueRows: ChunkAnalysis[], key: MetricKey, f: (v: number[]) => number,
                    reasonRows: ChunkAnalysis[] = valueRows): Metric {
  const vals = values(valueRows, key)
  return vals.length === 0 ? na(emptyReasonOf(reasonRows, key)) : ok(f(vals))
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
const mean = (v: number[]) => sum(v) / v.length

/**
 * 결과 metadata 하나에서 리포트를 만든다. 저장하지 않는다 — 호출할 때마다 계산한다.
 *
 * 입력은 raw metadata 를 그대로 받는다(parseGenerationSummary 의 출력이 아니라). 이유: 아직
 * 존재하지 않는 generation_elapsed_sec 이 Python 에 chunk 단위로든 상위 단위로든 추가되기만 하면
 * 이 파일과 파싱 계층 어디도 고치지 않고 seconds_per_iteration 이 살아나야 하기 때문이다.
 */
export function buildGenerationTelemetryReport(
  metadata: Record<string, unknown> | null | undefined,
): GenerationTelemetryReport {
  const m = (metadata && typeof metadata === 'object') ? metadata : {}
  const sp = m.speed_postprocessed
  const speedPostprocessed: boolean | null = typeof sp === 'boolean' ? sp : null
  const opts: AnalysisOptions = {
    speedPostprocessed,
    // 상위 단위로 추가될 경우의 자리. 지금은 metadata 에 없으므로 항상 undefined 다.
    // elapsed_seconds 는 절대 여기 들어오지 않는다(작업 전체 시간 ≠ 생성 시간).
    jobGenerationElapsedSec: m.generation_elapsed_sec,
  }

  const raw = Array.isArray(m.generation_chunks) ? m.generation_chunks : []
  const chunks: ChunkAnalysis[] = []
  for (const c of raw) {
    // 배열도 typeof 'object' 라서 그냥 두면 유령 행(전 지표 unavailable)이 되어 chunk_count 를
    // 오염시킨다. parseGenerationSummary 와 같은 기준으로 행 모양이 아닌 항목을 버린다.
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue     // 비정상 항목은 무시(crash 없음)
    chunks.push(analyzeGenerationChunk(c as TelemetryChunkInput, opts))
  }

  // 오염 행은 iteration 당 지표 집계에서 **제외**한다(조용히 평균에 섞지 않는다).
  const clean = chunks.filter((c) => !c.speed_contaminated)

  return {
    speed_postprocessed: speedPostprocessed,
    chunks,
    excluded_for_speed: chunks.length - clean.length,
    aggregate: {
      chunk_count: chunks.length,
      total_output_duration_sec: reduceOrNa(chunks, 'output_duration_sec', sum),
      mean_seconds_per_iteration: reduceOrNa(chunks, 'seconds_per_iteration', mean),
      mean_output_seconds_per_iteration: reduceOrNa(clean, 'output_seconds_per_iteration', mean, chunks),
      mean_samples_per_iteration: reduceOrNa(clean, 'samples_per_iteration', mean, chunks),
      min_safety_margin_iterations: reduceOrNa(chunks, 'safety_margin_iterations', (v) => Math.min(...v)),
      max_utilization_ratio: reduceOrNa(chunks, 'utilization_ratio', (v) => Math.max(...v)),
      counted: {
        output_duration_sec: values(chunks, 'output_duration_sec').length,
        seconds_per_iteration: values(chunks, 'seconds_per_iteration').length,
        output_seconds_per_iteration: values(clean, 'output_seconds_per_iteration').length,
        samples_per_iteration: values(clean, 'samples_per_iteration').length,
        safety_margin_iterations: values(chunks, 'safety_margin_iterations').length,
        utilization_ratio: values(chunks, 'utilization_ratio').length,
      },
    },
  }
}
