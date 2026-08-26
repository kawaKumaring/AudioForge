// 감정 샘플 생성 오케스트레이션 — 캐시 히트 판정, 중복 실행 차단, staging→publish 를 맡는다.
//
// 모델 실행 자체는 하지 않는다. 기존 PythonRunner/Qwen 경로를 감싼 runner 를 주입받아 쓴다
// (별도 모델 실행기·중복 lifecycle 을 만들지 않는다). generation-limit·watchdog·timeout·
// CPU/GPU 정책은 이 파일이 건드리지 않는다 — 실행 계약은 기존 것 그대로다.
//
// 규칙:
//   · 같은 cacheKey 는 동시에 한 번만 실행한다(single-flight). 뒤따라온 요청은 같은 결과를 받는다.
//   · terminal 은 정확히 1회다. 성공·실패·취소·한도 초과 어느 쪽이든 한 번만 마감한다.
//   · 성공한 WAV 만 검증을 거쳐 캐시로 올라간다. error/cancel/limit/no-result 는 등록하지 않는다.
//   · 어떤 경로로 끝나든 이번 run 의 staging 은 정리한다.
//   · 자동 재시도·CPU fallback·x-vector 강등·기본 전사 대체는 없다.
//   · 반환값에 경로·전사·미디어가 없다 — renderer 로 그대로 나가도 새어 나갈 것이 없어야 한다.
//
// ⚠️ 값 import 를 하지 않는다(타입만). node --test 가 이 파일을 직접 로드한다.
import type { SamplerCache, SamplerCacheRejection } from './sampler-cache'
import type { SamplerRequestResolved } from './sampler-request'

/** 기존 TTS 실행 경로를 감싼 adapter 가 돌려주는 마감 결과. */
export type SamplerRunOutcome =
  | { kind: 'success'; outputPath: string }
  | { kind: 'error'; code?: string }
  | { kind: 'cancelled' }
  | { kind: 'limit' }
  /** 프로세스는 끝났는데 결과가 없었다 — 조용한 성공으로 취급하지 않는다. */
  | { kind: 'no-result' }

export interface SamplerJob {
  runId: string
  stagingDir: string
  /** durable clip 절대 경로(main 전용). */
  referenceAudioPath: string
  /** 검증된 참조 전사(main 전용). ICL 입력. */
  referenceText: string
  referenceLanguage: string
  /** 합성 대본(프롬프트). */
  script: string
}

export interface SamplerRunner {
  run: (job: SamplerJob) => Promise<SamplerRunOutcome>
}

export interface SamplerGenerationDeps {
  cache: SamplerCache
  runner: SamplerRunner
  makeRunId: () => string
}

export type SamplerGenerationStatus =
  | 'ready'          // 캐시에 올라갔다(새로 만들었거나 이미 있었다)
  | 'failed'
  | 'cancelled'
  | 'limitExceeded'

export interface SamplerGenerationResult {
  status: SamplerGenerationStatus
  cacheKey: string
  /** 이미 캐시에 있어 실행하지 않았는가. */
  reused: boolean
  /** failed 일 때의 사유. 경로·전사·원시 메시지는 담지 않는다. */
  reason?: SamplerCacheRejection | 'RUN_FAILED' | 'NO_RESULT'
}

/**
 * 같은 cacheKey 의 동시 요청을 하나로 합치는 실행기.
 * 진행 중인 것이 있으면 그 Promise 를 공유하고, 끝나면 해제해 다음 요청이 새로 시작할 수 있다.
 */
export function createSamplerGenerator(deps: SamplerGenerationDeps): {
  generate: (request: SamplerRequestResolved) => Promise<SamplerGenerationResult>
  readonly inFlight: number
} {
  const inflight = new Map<string, Promise<SamplerGenerationResult>>()

  const runOnce = async (request: SamplerRequestResolved): Promise<SamplerGenerationResult> => {
    const cacheKey = request.cacheKey

    // 1) 이미 있으면 만들지 않는다. 같은 키는 같은 결과다.
    if (deps.cache.has(cacheKey)) {
      return { status: 'ready', cacheKey, reused: true }
    }

    const runId = deps.makeRunId()
    let stagingDir: string
    try {
      stagingDir = deps.cache.createStagingDir(runId)
    } catch {
      return { status: 'failed', cacheKey, reused: false, reason: 'RUN_FAILED' }
    }

    try {
      // 2) 기존 실행 경로에 넘긴다. 여기서 재시도하지 않는다 — 실패는 실패로 남는다.
      const outcome = await deps.runner.run({
        runId,
        stagingDir,
        referenceAudioPath: request.filePath,
        referenceText: request.refText,
        referenceLanguage: request.language,
        script: request.script,
      })

      if (outcome.kind === 'cancelled') return { status: 'cancelled', cacheKey, reused: false }
      if (outcome.kind === 'limit') return { status: 'limitExceeded', cacheKey, reused: false }
      if (outcome.kind === 'no-result') {
        return { status: 'failed', cacheKey, reused: false, reason: 'NO_RESULT' }
      }
      if (outcome.kind === 'error') {
        return { status: 'failed', cacheKey, reused: false, reason: 'RUN_FAILED' }
      }

      // 3) 성공했다고 바로 캐시가 되지 않는다. 검증을 통과해야 final 이름을 얻는다.
      const published = deps.cache.publish(cacheKey, outcome.outputPath)
      if (!published.ok) {
        return { status: 'failed', cacheKey, reused: false, reason: published.reason }
      }
      return { status: 'ready', cacheKey, reused: false }
    } catch {
      return { status: 'failed', cacheKey, reused: false, reason: 'RUN_FAILED' }
    } finally {
      // 4) 어떤 경로로 끝나든 이번 run 의 staging 은 남기지 않는다.
      deps.cache.sweepStaging(runId)
    }
  }

  return {
    generate(request: SamplerRequestResolved): Promise<SamplerGenerationResult> {
      const key = request.cacheKey
      const running = inflight.get(key)
      if (running) return running          // 같은 키는 실행을 겹치지 않는다

      const p = runOnce(request)
      inflight.set(key, p)
      void p.finally(() => {
        if (inflight.get(key) === p) inflight.delete(key)
      }).catch(() => { /* 정리 체인이 unhandled 가 되지 않게 */ })
      return p
    },
    get inFlight() { return inflight.size },
  }
}

/**
 * 마감을 한 번으로 강제하는 게이트. 기존 실행 경로가 result 와 done 을 모두 보내거나
 * 늦은 error 를 덧붙여도 두 번 마감되지 않는다.
 */
export function createTerminalOnce<T>(): {
  settle: (outcome: T) => boolean
  readonly settled: boolean
  readonly value: T | null
  readonly count: number
} {
  let done = false
  let value: T | null = null
  let count = 0
  return {
    settle(outcome: T): boolean {
      count += 1
      if (done) return false      // 두 번째부터는 무시되지만 관측은 남는다
      done = true
      value = outcome
      return true
    },
    get settled() { return done },
    get value() { return value },
    get count() { return count },
  }
}
