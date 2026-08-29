// 장문(long-form) TTS job 안정성 원시 — 순수 로직 + 주입 시계. Electron·프로세스 의존 없음.
//
// 왜 필요한가(감사 결과):
//   현행 Electron 감시는 축이 **하나뿐**이다(src/main/ipc/audio.ipc.ts WATCHDOG_MS=300000).
//   그 타이머는 'progress' 이벤트 아무거나 하나만 오면 리셋된다. 그런데 Python 쪽은 모델 로딩
//   heartbeat 를 일부러 progress 로 옮겨 보낸다(python/tts_worker.py _QWEN_LOAD_PCT_MIN/MAX 주석:
//   "heartbeat를 progress로 옮기지 않으면 ... 300s에 Electron이 먼저 죽인다"). 즉 Electron 이 보는
//   progress 스트림에는 '살아있다'는 신호와 '실제로 뭔가를 만들어냈다'는 신호가 **섞여 있고**,
//   Electron 은 둘을 구분하지 못한다. 결과:
//     - 살아있지만 아무것도 생산하지 않는 job 은 Electron 쪽에서 **영원히** 종료되지 않는다.
//     - job 전체 길이에 대한 상한이 **어디에도 없다**.
//     - 조각(chunk) 이 40/50 까지 끝난 뒤 죽어도 그 사실이 아무 데도 남지 않는다.
//
// 그래서 축을 셋으로 가른다. 이건 Python 이 이미 쓰는 패턴을 그대로 따른 것이다 —
// python/tts_worker.py 는 '비활성 timer(280s, heartbeat 가 갱신)' 과 '기동 deadline(600s,
// heartbeat 가 절대 연장 못 함)' 을 서로 다른 축으로 둔다. 여기서도 같은 규율을 쓴다:
//
//   ① inactivity  — 마지막 '어떤' 신호 이후 경과. liveness/forward 둘 다 갱신한다.
//                   기존 300000 그대로. 정상 heartbeat 가 있는 느린 콜드 로딩을 죽이지 않기 위함.
//   ② stall       — 마지막 'forward progress' 이후 경과. **liveness 는 갱신하지 못한다.**
//                   heartbeat 만 계속 오는 job 이 영원히 사는 것을 막는 유일한 축.
//   ③ job budget  — job 시작 이후 총 경과. **아무 것도 갱신하지 못한다.**
//
// 상수는 새로 지어내지 않는다 — 전부 이미 승인된 값에서 **유도**한다(아래 각 상수 주석 참조).
// 280(_QWEN_INACTIVITY_SEC)·300000(WATCHDOG_MS)·생성 상한(generation_limit.py)은 손대지 않는다.

// ─────────────────────────────────────────────────────────────────────────────
// 0) 시계 · 상수
// ─────────────────────────────────────────────────────────────────────────────

/** 단조 시계(ms). 테스트가 가상 시계를 주입한다 — Date.now() 를 직접 부르지 않는다. */
export type Clock = () => number

/**
 * ① 비활성 상한. **기존 audio.ipc.ts WATCHDOG_MS 와 같은 값·같은 의미**다(신규 값 아님).
 * "어떤 신호도 5분간 없음" = 프로세스가 얼어붙었다.
 */
export const INACTIVITY_MS = 300_000

/**
 * ② 무진행 상한 — '살아있지만 생산하지 않음'.
 * 유도: Python 의 기동 hard deadline(_QWEN_STARTUP_DEADLINE_SEC = 600s)이 '살아있지만 아직
 * 아무 chunk 도 못 낸' 구간의 이미 승인된 최대치다. Electron 이 그보다 먼저 끼어들면 Python 이
 * 스스로 QWEN_LOAD_TIMEOUT 을 구조화해 보고할 기회를 빼앗는다(진단이 일반 timeout 으로 뭉개진다).
 * 그래서 600s + 자기보고 유예. 이 축은 기존 어떤 값도 '늘린' 것이 아니라 없던 천장을 새로 세운 것이다.
 */
export const STALL_MS = 600_000 + 30_000

/** Python 쪽 hard deadline 이 스스로 오류를 보고하고 자식 트리를 정리할 유예(ms). */
export const SELF_REPORT_GRACE_MS = 30_000

/**
 * ③ job 전체 예산은 고정 상수가 아니라 **조각 수에서 유도**한다. 임의의 천장을 두면
 * "긴 글은 못 만든다" 가 되고, 천장이 없으면 고착이 영원히 산다. 그래서 선언된 작업량에 비례시킨다.
 *   budget = 로딩 예산 + 조각수 × 조각당 예산 + 유예
 * 조각당 예산은 INACTIVITY_MS 를 쓴다 — 한 조각이 그보다 오래 걸리는 것은 이미 현행 계약상 불가능하다
 * (Python 이 280s 에 끊는다). 조각 수를 아직 모르면 예산은 **없다**(Infinity) — 모르는 것을 아는 척하지 않는다.
 *
 * ※ 여기 들어가는 조각 수는 반드시 **job 전체 총 조각 수의 상한**이어야 한다. bridge 가 문구에 싣는
 *    `조각 i/cc` 의 cc 는 '그 세그먼트의' 조각 수라서 그걸 그대로 쓰면 예산이 수십 배 모자란다
 *    (정상 장문을 조기 종료시킨다). estimatedChunkTotal(= 세그먼트 수 × 관측된 최대 cc)을 쓴다 —
 *    과대추정 방향이라 조기 종료를 만들지 않고, 고착은 stall 축이 따로 잡는다.
 */
export const LOAD_BUDGET_MS = 600_000
export const PER_CHUNK_BUDGET_MS = INACTIVITY_MS

/**
 * ④ '작업이 스스로 되돌아가 처음부터 다시 만든다' 를 인정하는 최대 횟수.
 *
 * 왜 필요한가: 참조 사용 방식 '자동'은 참조 억양(ICL)으로 먼저 만들어 보고, 경계 정렬이 실패하면
 * **그 결과를 통째로 버리고** 안정 방식으로 한 번 더 만든다(python/tts_worker.py). 2회차는 1회차와
 * **같은 조각 번호**를 다시 낸다 — 원장은 단조 증가라 그 완료들을 전부 '재전송(liveness)' 으로
 * 보고, 그러면 2회차 내내 forward 축이 갱신되지 않아 긴 작업이 stall 로 오판돼 죽는다.
 * 그래서 재시작 신호를 받으면 원장을 새로 깔고 축들을 그 시점부터 다시 잰다.
 *
 * 왜 상한이 1 인가: Python 계약이 '전환 최대 1회' 다. 같은 수를 여기서도 강제해, 신호가 반복돼도
 * 예산이 무한히 늘어나는 통로를 만들지 않는다(계층이 둘 다 같은 천장을 갖는다).
 */
export const MAX_JOB_RESTARTS = 1

export function jobBudgetMs(chunkCount: number | null | undefined): number {
  if (typeof chunkCount !== 'number' || !Number.isFinite(chunkCount) || chunkCount <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return LOAD_BUDGET_MS + Math.ceil(chunkCount) * PER_CHUNK_BUDGET_MS + SELF_REPORT_GRACE_MS
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 진행 신호 해석 — liveness vs forward progress
// ─────────────────────────────────────────────────────────────────────────────

/** 조각 위치. python/qwen_bridge.py `_progress` 가 만든 문구에서 읽는다. */
export interface ChunkPosition {
  segIndex: number      // 0-base
  segCount: number
  chunkIndex: number    // 0-base
  chunkCount: number
  phase: 'start' | 'complete'
}

// python/qwen_bridge.py:
//   message=f"합성 중... (문장 {seg_index + 1}/{n_seg}, 조각 {ci + 1}/{cc} {tag})", tag ∈ {시작, 완료}
// 문구가 바뀌면 위치를 '모름'으로 떨어뜨릴 뿐 절대 throw 하지 않는다. 모름은 liveness 로 취급된다 —
// 즉 파싱이 깨져도 감시가 느슨해지지 않고 **더 보수적**으로 판정된다(fail-safe 방향).
const CHUNK_RE = /문장\s*(\d+)\s*\/\s*(\d+)\s*,\s*조각\s*(\d+)\s*\/\s*(\d+)\s*(시작|완료)/

export function parseChunkPosition(message: unknown): ChunkPosition | null {
  if (typeof message !== 'string') return null
  const m = CHUNK_RE.exec(message)
  if (!m) return null
  const segIndex = Number(m[1]) - 1
  const segCount = Number(m[2])
  const chunkIndex = Number(m[3]) - 1
  const chunkCount = Number(m[4])
  if (segIndex < 0 || chunkIndex < 0 || segCount <= 0 || chunkCount <= 0) return null
  if (segIndex >= segCount || chunkIndex >= chunkCount) return null
  return { segIndex, segCount, chunkIndex, chunkCount, phase: m[5] === '완료' ? 'complete' : 'start' }
}

/**
 * 신호 종류.
 *   forward  — 조각 하나가 **완료**됐다. 유일한 '실제 전진' 정의다.
 *   liveness — 살아있다는 사실만. 조각 시작 알림·로딩 heartbeat·해석 불가 문구가 전부 여기.
 *
 * '조각 시작' 을 forward 로 세지 않는 것이 핵심이다: 시작 알림은 blocking 생성 호출 **직전**에
 * 나가므로, 그걸 전진으로 세면 아무 것도 못 만든 채로 예산만 갱신된다.
 */
export type SignalKind = 'forward' | 'liveness'

// ─────────────────────────────────────────────────────────────────────────────
// 2) checkpoint 원장 — 완료된 조각만 기록. resume 계약의 단일 소스.
// ─────────────────────────────────────────────────────────────────────────────

/** 조각 식별자 — 정수 둘. 대사·전사·경로는 절대 담지 않는다(민감정보 경계). */
export interface ChunkKey { segIndex: number; chunkIndex: number }

export interface CheckpointSnapshot {
  version: 1
  completed: ChunkKey[]
  /** 마지막으로 관측한 총 조각 수(모르면 null). */
  chunkCount: number | null
  /** 완료된 조각 수 기준 누적 생성 시간(ms) — ETA 산출용. */
  elapsedMs: number
}

export interface ResumePlan {
  completed: ChunkKey[]
  /** 이어서 만들어야 할 조각. chunkCount 를 모르면 null(계획 불가 — 처음부터 다시). */
  remaining: ChunkKey[] | null
  /** 완료분을 재사용해 이어서 시작할 수 있는가. */
  resumable: boolean
  reason: 'ok' | 'nothing-completed' | 'chunk-count-unknown' | 'plan-mismatch'
}

const keyOf = (k: ChunkKey) => `${k.segIndex}:${k.chunkIndex}`

export interface ChunkLedger {
  /** 조각 완료 기록. 처음 보는 조각이면 true(중복 기록은 false — 원장은 단조 증가한다). */
  recordComplete(pos: ChunkPosition, atMs: number): boolean
  readonly completedCount: number
  readonly completed: ChunkKey[]
  readonly chunkCount: number | null
  snapshot(atMs: number): CheckpointSnapshot
  /** 저장된 checkpoint 로 이어서 만들 계획. 완료분이 없으면 처음부터. */
  resumePlan(): ResumePlan
}

export function createChunkLedger(restore?: CheckpointSnapshot | null): ChunkLedger {
  const seen = new Map<string, ChunkKey>()
  let chunkCount: number | null = null
  let firstAtMs: number | null = null   // 이 원장이 처음 조각을 받은 시각(경과 계산 기준점)
  let lastAtMs: number | null = null
  let baseElapsedMs = 0                 // 복원된 이전 실행분의 누적 생성 시간
  // 복원: 형태가 어긋나면 조용히 '완료분 없음' 으로 떨어진다(복원 실패가 실행을 깨뜨리지 않는다).
  if (restore && restore.version === 1 && Array.isArray(restore.completed)) {
    for (const k of restore.completed) {
      if (!k || typeof k.segIndex !== 'number' || typeof k.chunkIndex !== 'number') continue
      if (k.segIndex < 0 || k.chunkIndex < 0) continue
      seen.set(keyOf(k), { segIndex: k.segIndex, chunkIndex: k.chunkIndex })
    }
    if (typeof restore.chunkCount === 'number' && restore.chunkCount > 0) chunkCount = restore.chunkCount
    if (typeof restore.elapsedMs === 'number' && restore.elapsedMs > 0) baseElapsedMs = restore.elapsedMs
  }
  return {
    recordComplete(pos, atMs) {
      if (pos.phase !== 'complete') return false
      // 총 조각 수는 bridge 가 세그먼트별 cc 를 보내므로 '누적 관측 최대' 가 아니라
      // 세그먼트 경계마다 달라진다. 여기서는 '이 세그먼트의 조각 수' 를 마지막 관측으로만 들고 간다.
      chunkCount = pos.chunkCount
      if (firstAtMs === null) firstAtMs = atMs
      lastAtMs = atMs
      const k = keyOf(pos)
      if (seen.has(k)) return false
      seen.set(k, { segIndex: pos.segIndex, chunkIndex: pos.chunkIndex })
      return true
    },
    get completedCount() { return seen.size },
    get completed() { return [...seen.values()] },
    get chunkCount() { return chunkCount },
    snapshot(atMs) {
      // atMs 는 '시각'이고 elapsedMs 는 '기간'이다 — 시각을 그대로 기간으로 쓰지 않는다.
      // 이 원장이 조각을 받기 시작한 시점부터의 기간 + 복원된 이전 실행분.
      const end = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : (lastAtMs ?? 0)
      const span = firstAtMs === null ? 0 : Math.max(0, end - firstAtMs)
      return { version: 1, completed: [...seen.values()], chunkCount, elapsedMs: baseElapsedMs + span }
    },
    resumePlan() {
      const completed = [...seen.values()]
      if (completed.length === 0) {
        return { completed, remaining: null, resumable: false, reason: 'nothing-completed' }
      }
      if (chunkCount == null) {
        return { completed, remaining: null, resumable: false, reason: 'chunk-count-unknown' }
      }
      const segIndexes = new Set(completed.map((c) => c.segIndex))
      const remaining: ChunkKey[] = []
      for (const segIndex of [...segIndexes].sort((a, b) => a - b)) {
        for (let ci = 0; ci < chunkCount; ci++) {
          if (!seen.has(keyOf({ segIndex, chunkIndex: ci }))) remaining.push({ segIndex, chunkIndex: ci })
        }
      }
      return { completed, remaining, resumable: true, reason: 'ok' }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 진행 표시 계약 — 렌더러가 쓸 값의 단일 정의
// ─────────────────────────────────────────────────────────────────────────────

export interface LongformProgressReport {
  /** 현재 세그먼트(0-base). 모르면 null. */
  segIndex: number | null
  /** 전체 세그먼트 수. 모르면 null. */
  segCount: number | null
  /** 현재 세그먼트 안에서의 조각 위치(0-base). 모르면 null. */
  chunkIndex: number | null
  /** 현재 **세그먼트의** 조각 수. job 전체 조각 수가 아니다. 모르면 null. */
  chunkCount: number | null
  /** 지금까지 **완료**된 조각 수. 시작 알림은 세지 않는다. */
  completedChunks: number
  /**
   * job 전체 조각 수의 **상한 추정**(= segCount × 관측된 최대 chunkCount). 정확한 총합이 아니다 —
   * bridge 는 세그먼트별 조각 수만 알려주므로 총합은 마지막 세그먼트가 끝나야 확정된다.
   * 진행률·ETA·job 예산은 전부 이 상한을 쓴다(과대추정 = 안전 방향).
   */
  estimatedTotalChunks: number | null
  /** job 시작 이후 경과(ms). */
  elapsedMs: number
  /**
   * 예상 잔여(ms). 완료된 조각이 1개 이상이고 총량 추정이 있을 때만 값이 있다.
   * 0 이나 추측으로 위조하지 않는다 — 모르면 null 이다(generationTelemetry 의 Metric 규율과 같은 원칙).
   */
  etaMs: number | null
  /** 마지막 forward progress 이후 경과(ms). '살아있지만 안 만든다' 를 UI 가 그대로 볼 수 있게. */
  sinceForwardMs: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 세 축 감시기
// ─────────────────────────────────────────────────────────────────────────────

/** 어떤 축이 터졌는가. 'ok' 는 아직 아무 축도 안 터졌다는 뜻. */
export type WatchVerdict =
  | 'ok'
  | 'inactivity-timeout'      // ① 어떤 신호도 없음 = 얼어붙음
  | 'no-forward-progress'     // ② 살아있으나 조각을 못 만듦
  | 'job-budget-exhausted'    // ③ 선언된 작업량 대비 총 시간 초과

export interface JobWatchdogOptions {
  now: Clock
  inactivityMs?: number
  stallMs?: number
  /** 총 조각 수를 알게 되면 setChunkCount 로 넣는다. 처음에는 보통 모른다. */
  chunkCount?: number | null
  ledger?: ChunkLedger
}

export interface JobWatchdog {
  /**
   * 러너 progress 를 먹인다. 반환값은 이 신호를 어떻게 판정했는지.
   * job_restarted=true 는 '지금까지 만든 것을 버리고 처음부터 다시 만든다'는 선언이다
   * (MAX_JOB_RESTARTS 회까지만 인정). 인정되면 원장을 비우고 세 축을 그 시점부터 다시 잰다.
   */
  observe(signal: { percent?: unknown; message?: unknown; job_restarted?: unknown }): SignalKind
  /** 지금 시점의 판정. 부수효과 없음 — 호출해도 타이머가 갱신되지 않는다. */
  evaluate(): WatchVerdict
  /** job 전체 조각 수를 확정적으로 알게 됐을 때(결과 metadata 의 chunk_count 등). */
  setTotalChunks(n: number | null | undefined): void
  report(): LongformProgressReport
  readonly ledger: ChunkLedger
  readonly startedAtMs: number
  /** 인정된 재시작 횟수(0 또는 1). 계약 위반을 사후에 확인할 수 있게 노출한다. */
  readonly restarts: number
  /** 현재 job 예산(ms). 총량 추정이 없으면 Infinity. */
  readonly budgetMs: number
}

export function createJobWatchdog(opts: JobWatchdogOptions): JobWatchdog {
  const now = opts.now
  const inactivityMs = opts.inactivityMs ?? INACTIVITY_MS
  const stallMs = opts.stallMs ?? STALL_MS
  let ledger = opts.ledger ?? createChunkLedger()
  let startedAtMs = now()
  let restarts = 0                    // ④ 인정된 재시작 횟수(MAX_JOB_RESTARTS 까지)
  let lastSignalAtMs = startedAtMs    // ① liveness/forward 둘 다 갱신
  let lastForwardAtMs = startedAtMs   // ② forward 만 갱신
  let lastPosition: ChunkPosition | null = null
  let segCount: number | null = null
  let maxChunkCount = 0
  // 확정 총량(결과 metadata 등에서 직접 받은 값). 있으면 추정보다 우선한다.
  let declaredTotal: number | null =
    typeof opts.chunkCount === 'number' && opts.chunkCount > 0 ? Math.ceil(opts.chunkCount) : null

  // 총 조각 수의 상한. 확정값 > (세그먼트 수 × 관측된 최대 세그먼트당 조각 수) > 미상.
  const totalChunks = (): number | null => {
    if (declaredTotal != null) return declaredTotal
    if (segCount != null && maxChunkCount > 0) return segCount * maxChunkCount
    return null
  }

  return {
    observe(signal) {
      const t = now()
      lastSignalAtMs = t                       // ① 은 어떤 신호로도 갱신된다(느린 콜드 로딩 보호)
      // ④ 재시작 선언 — 앞서 만든 조각들은 폐기됐으므로 '완료' 로 남겨 두면 안 되고(원장을 비운다),
      // 다시 만드는 시간을 앞 라운드의 축으로 재면 정상 작업이 stall 로 오판된다(축을 다시 잰다).
      // 상한을 넘은 재시작 신호는 그냥 liveness 로 흘린다 — 예산 무한 연장 통로를 막는다.
      if (signal?.job_restarted === true) {
        if (restarts < MAX_JOB_RESTARTS) {
          restarts += 1
          ledger = createChunkLedger()
          startedAtMs = t
          lastForwardAtMs = t
          lastPosition = null
        }
        return 'liveness'
      }
      const pos = parseChunkPosition(signal?.message)
      if (!pos) return 'liveness'
      lastPosition = pos
      segCount = pos.segCount
      if (pos.chunkCount > maxChunkCount) maxChunkCount = pos.chunkCount
      // '완료' 이고 처음 보는 조각일 때만 전진이다. 시작 알림·재전송은 liveness.
      if (!ledger.recordComplete(pos, t)) return 'liveness'
      lastForwardAtMs = t                      // ② 는 오직 여기서만 갱신된다
      return 'forward'
    },
    evaluate() {
      const t = now()
      // ③ 을 먼저 본다 — 총 예산이 끝났으면 다른 축의 상태와 무관하게 끝이다.
      if (t - startedAtMs >= jobBudgetMs(totalChunks())) return 'job-budget-exhausted'
      if (t - lastSignalAtMs >= inactivityMs) return 'inactivity-timeout'
      if (t - lastForwardAtMs >= stallMs) return 'no-forward-progress'
      return 'ok'
    },
    setTotalChunks(n) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) declaredTotal = Math.ceil(n)
    },
    report() {
      const t = now()
      const elapsedMs = t - startedAtMs
      const done = ledger.completedCount
      const total = totalChunks()
      let etaMs: number | null = null
      if (done > 0 && total != null) {
        etaMs = total > done ? Math.round((elapsedMs / done) * (total - done)) : 0
      }
      return {
        segIndex: lastPosition ? lastPosition.segIndex : null,
        segCount,
        chunkIndex: lastPosition ? lastPosition.chunkIndex : null,
        chunkCount: lastPosition ? lastPosition.chunkCount : null,
        completedChunks: done,
        estimatedTotalChunks: total,
        elapsedMs,
        etaMs,
        sinceForwardMs: t - lastForwardAtMs
      }
    },
    get ledger() { return ledger },
    get startedAtMs() { return startedAtMs },
    get restarts() { return restarts },
    get budgetMs() { return jobBudgetMs(totalChunks()) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4-b) 감시 타이머 소유권 — 취소·종료 후 타이머가 남지 않는다는 것을 '검증 가능하게' 만든다
// ─────────────────────────────────────────────────────────────────────────────
//
// ②③ 축은 비활성 축과 달리 '신호가 오면 리셋' 이 아니라 주기 점검이어야 한다(아무 신호도 없이
// 예산만 흘러가는 경우가 바로 그 축들이 잡아야 할 상황이다). 그 주기 타이머를 audio.ipc.ts 안에
// 두면 **누수 여부를 유닛 테스트로 확인할 방법이 없다** — 그 파일은 electron 을 import 하므로
// node --test 가 로드하지 못한다. 그래서 타이머 소유권만 여기로 옮기고 setInterval/clearInterval 을
// 주입받는다. 이제 '취소·앱 종료 후 타이머가 남지 않는다' 가 단언 가능한 사실이 된다.

export interface IntervalDeps {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: never) => void
}

export interface JobWatchHandle {
  /** 타이머 해제. 멱등 — 실제로 이번 호출이 멈췄으면 true, 이미 멈춰 있었으면 false. */
  stop(): boolean
  readonly stopped: boolean
  /** 실제로 실행된 점검 횟수(테스트·진단용). */
  readonly tickCount: number
  /** 어떤 축이 터져서 스스로 멈췄는가. 정상 종료로 멈췄으면 null. */
  readonly breached: WatchVerdict | null
}

export interface StartJobWatchOptions {
  watchdog: JobWatchdog
  intervalMs: number
  /** 자식 프로세스가 아직 살아있는가. false 면 이번 점검은 건너뛴다(종료 중 오판 금지). */
  isRunning: () => boolean
  /** ②③ 축이 터졌을 때 정확히 1회 호출. 호출 시점에 타이머는 이미 멈춰 있다. */
  onBreach: (verdict: WatchVerdict, report: LongformProgressReport) => void
  deps: IntervalDeps
}

export function startJobWatch(opts: StartJobWatchOptions): JobWatchHandle {
  let handle: unknown = null
  let stopped = false
  let tickCount = 0
  let breached: WatchVerdict | null = null

  const stop = (): boolean => {
    if (stopped) return false
    stopped = true
    if (handle !== null) {
      try { opts.deps.clearInterval(handle as never) } catch { /* noop */ }
      handle = null
    }
    return true
  }

  const tick = () => {
    if (stopped) return
    // 프로세스가 이미 끝났으면 판정하지 않는다 — done 핸들러가 곧 stop() 을 부른다.
    if (!opts.isRunning()) return
    tickCount++
    const verdict = opts.watchdog.evaluate()
    // ① 비활성 축은 자기 타이머(audio.ipc 의 resetWatchdog)가 담당한다 — 여기서 중복 판정하지 않는다.
    if (verdict === 'ok' || verdict === 'inactivity-timeout') return
    breached = verdict
    stop()                       // onBreach 가 터져도 타이머는 이미 정리됐다
    opts.onBreach(verdict, opts.watchdog.report())
  }

  handle = opts.deps.setInterval(tick, opts.intervalMs)
  // 이 타이머가 앱 종료를 막지 않게(Node Timeout 에만 있는 기능 — 없으면 조용히 건너뛴다).
  const maybeUnref = (handle as { unref?: unknown } | null)?.unref
  if (typeof maybeUnref === 'function') {
    try { maybeUnref.call(handle) } catch { /* noop */ }
  }

  return {
    stop,
    get stopped() { return stopped },
    get tickCount() { return tickCount },
    get breached() { return breached }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) staging 게이트 — staging 이 끝나기 전에는 final 을 공개하지 않는다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 결과를 **보류**했다가 staging 완료가 확인된 뒤에만 공개한다.
 * audio.ipc.ts 는 이미 result 를 pendingResult 로 버퍼링해 done 이후에 보내는데, 그 기준은
 * '자식 프로세스가 끝났는가' 이지 '임시 산출물 정리·배치가 끝났는가' 가 아니다. 이 게이트는
 * 후자를 명시적 전제로 만든다 — 정리 실패 시 결과가 새어나가지 않는다.
 *
 * run-settlement 의 createTerminalGate 위에 얹는다(정확히 1회 공개 — 새 상태기계를 만들지 않는다).
 */
export type StagingOutcome = 'published' | 'abandoned'

export interface StagingGate<T> {
  /** 결과 후보를 맡긴다. staging 이 이미 완료됐으면 즉시 공개된다. */
  offerFinal(value: T): void
  /** staging 완료 확인. 보류 중인 결과가 있으면 이때 공개된다. 실제 공개했으면 true. */
  markStagingComplete(): boolean
  /** 실패·취소 — 보류분을 버린다. 이후 어떤 공개도 없다. */
  abandon(): void
  readonly hasPending: boolean
  readonly outcome: StagingOutcome | null
}

export function createStagingGate<T>(
  publish: (value: T) => void,
  gateFactory: (emit: (v: T) => void) => { settle(v: T): boolean; readonly settled: boolean }
): StagingGate<T> {
  const gate = gateFactory(publish)
  let pending: { value: T } | null = null
  let stagingComplete = false
  let outcome: StagingOutcome | null = null
  const tryPublish = (): boolean => {
    if (!stagingComplete || !pending || outcome !== null) return false
    const v = pending.value
    pending = null
    if (!gate.settle(v)) return false
    outcome = 'published'
    return true
  }
  return {
    offerFinal(value) {
      if (outcome !== null) return          // 이미 공개/폐기됨 — 늦은 결과는 무시
      pending = { value }
      tryPublish()
    },
    markStagingComplete() {
      if (outcome !== null) return false
      stagingComplete = true
      return tryPublish()
    },
    abandon() {
      if (outcome !== null) return
      pending = null
      outcome = 'abandoned'
    },
    get hasPending() { return pending !== null },
    get outcome() { return outcome }
  }
}
