/**
 * 합성 엔진의 라이브러리를 **배경에서 미리 읽어 둔다.** 모델은 올리지 않는다.
 *
 * ★왜(2026-09-25 실측, 실제 합성 18회 + import 측정 3회)
 *   합성 한 건의 준비 시간 8.4초 중 **5.8초가 라이브러리 읽기**였다.
 *   그런데 그 5.8초는 **데워진 값**이고, 처음 읽을 때는 **25.9초**다.
 *   앱을 켜고 처음 합성할 때 사용자가 겪는 "유독 느리다" 가 이것이다 —
 *   찬 시작 35.5초에서 더운 8.4초를 뺀 27초와 거의 같다.
 *
 *   처음 한 번을 **배경으로 옮기면** 사용자가 기다리는 시간이 아니게 된다.
 *
 * ★왜 안전한가 — GPU 를 한 바이트도 안 쓴다
 *   `import torch, qwen_tts` 뒤에도 `torch.cuda.is_initialized()` 가 False 이고
 *   VRAM 이 변하지 않는 것을 실측으로 확인했다. 모델을 올리지 않으므로
 *   이 앱의 GPU 양보 정책이나 ComfyUI 병행 전제를 건드리지 않는다.
 *
 * ★이것이 **매 작업의 5.8초를 줄이지는 못한다**
 *   그 5.8초는 파일 읽기가 아니라 파이썬이 프로세스마다 하는 일이다(더운 상태에서도
 *   5.83초로 일정, 편차 0.01초). 그것을 없애려면 프로세스를 상주시켜야 하고,
 *   그것은 별도 결정이다. **여기서 파는 것은 "처음 한 번" 뿐이다** — 과장하지 않는다.
 *
 * 규칙
 *   · 앱 기동을 막지 않는다(배경, 우선순위 낮음).
 *   · 실패해도 아무 일도 일어나지 않는다 — 합성은 원래대로 동작한다.
 *   · 앱이 닫히면 함께 죽는다. 좀비를 남기지 않는다.
 *   · 검사 실행(E2E)에서는 돌지 않는다 — 검사를 느리게 만들면 안 된다.
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/** 끄는 스위치. 되돌리려면 이 값을 1 로 두면 된다. */
export const DISABLE_ENV = 'AUDIOFORGE_NO_WARMUP'

/** 이만큼 지나도 안 끝나면 포기한다 — 배경 일이 영원히 남지 않게. */
export const WARMUP_TIMEOUT_MS = 120_000

export interface WarmupDeps {
  /** 저장소 루트(= `externals` 의 부모). */
  root: string
  env?: NodeJS.ProcessEnv
  /** 기록 한 줄. 없으면 아무 데도 안 적는다. */
  log?: (message: string) => void
  spawnFn?: typeof spawn
  now?: () => number
  /** 파일이 있는지. 검사에서 갈아 끼운다. */
  exists?: (p: string) => boolean
}

export interface WarmupHandle {
  /** 띄웠는가. 건너뛰었으면 false 와 그 이유. */
  started: boolean
  reason?: string
  stop: () => void
}

/** 이 파이썬으로 데운다 — **합성이 실제로 쓰는 그것**이어야 뜻이 있다. */
export function bridgePython(root: string): string {
  return join(root, 'externals', 'qwen3_tts_venv', 'Scripts', 'python.exe')
}

/**
 * 왜 건너뛰는가. 건너뛸 이유가 없으면 null.
 *
 * ★"조용히 안 함" 을 만들지 않는다 — 건너뛰면 그 사유를 돌려준다.
 */
export function skipReason(deps: WarmupDeps): string | null {
  const env = deps.env ?? process.env
  if ((env[DISABLE_ENV] || '').trim() === '1') return '꺼져 있음'
  if ((env.AF_E2E || '').trim() === '1') return '검사 실행'
  const has = deps.exists ?? existsSync
  if (!has(bridgePython(deps.root))) return '합성 엔진 파이썬 없음'
  return null
}

/** 배경에서 돌릴 아주 작은 프로그램. **읽기만 하고 아무것도 만들지 않는다.** */
export const WARMUP_SNIPPET = [
  'import time',
  't = time.monotonic()',
  'import torch, qwen_tts',
  // 모델을 올리지 않는다. GPU 도 건드리지 않는다(cuda 초기화 없음).
  'print("warmed %.2f" % (time.monotonic() - t))',
].join('\n')

/**
 * 배경에서 한 번 데운다. **기다리지 않는다.**
 *
 * 앱 기동을 막지 않고, 실패는 조용히 지나간다 — 데우기가 실패해도 합성은 원래대로 된다.
 */
export function warmUpBridge(deps: WarmupDeps): WarmupHandle {
  const why = skipReason(deps)
  if (why) {
    deps.log?.(`엔진 미리 데우기 건너뜀 — ${why}`)
    return { started: false, reason: why, stop: () => {} }
  }
  const spawnIt = deps.spawnFn ?? spawn
  const t0 = (deps.now ?? Date.now)()
  let child: ChildProcess | null = null
  let timer: NodeJS.Timeout | null = null
  const done = (how: string) => {
    if (timer) { clearTimeout(timer); timer = null }
    const sec = (((deps.now ?? Date.now)() - t0) / 1000).toFixed(1)
    deps.log?.(`엔진 미리 데우기 ${how} (${sec}초)`)
    child = null
  }
  try {
    child = spawnIt(bridgePython(deps.root), ['-X', 'utf8', '-c', WARMUP_SNIPPET], {
      // 앱이 닫히면 함께 죽는다 — 좀비를 남기지 않는다.
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...(deps.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
    })
  } catch (e) {
    deps.log?.(`엔진 미리 데우기 못 시작 — ${(e as Error)?.name || 'error'}`)
    return { started: false, reason: 'spawn 실패', stop: () => {} }
  }
  child.once('exit', (code) => done(code === 0 ? '끝남' : `끝남(코드 ${code})`))
  child.once('error', () => done('실패'))
  timer = setTimeout(() => {
    // 배경 일이 영원히 남지 않게. 죽여도 아무 문제 없다 — 읽기만 했으므로.
    try { child?.kill() } catch { /* 이미 죽었으면 그만 */ }
    done('시간 초과')
  }, WARMUP_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  deps.log?.('엔진 미리 데우기 시작(배경, GPU 미사용)')
  return {
    started: true,
    stop: () => {
      if (timer) { clearTimeout(timer); timer = null }
      try { child?.kill() } catch { /* 이미 죽었으면 그만 */ }
      child = null
    },
  }
}
