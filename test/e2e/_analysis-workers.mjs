// 분석 worker 프로세스 관찰 도구 — E2E 공용.
//
// 왜 개수가 아니라 PID 인가
// -------------------------
// 처음에는 `analysis_worker.py` 를 포함한 프로세스의 **개수**만 세어 before/after 를
// 비교했다. 두 가지가 잘못됐다.
//
//   1) 질의를 실행하는 powershell.exe 자신의 CommandLine 에 `analysis_worker.py` 가 들어
//      있어서 **스스로를 세었다**. 그래서 실제 worker 가 0 이어도 1 이 나왔다.
//   2) 개수만 같으면 통과였다. 테스트가 worker 를 애초에 못 띄웠어도 `before=N after=N`
//      으로 초록이 된다. 종료 계약을 아무것도 검사하지 않은 셈이다.
//
// 그래서 여기서는 **프로세스 이름이 python 인 것만** 보고, 개수 대신 **PID 집합**을 다룬다.
// 테스트는 "내가 띄운 PID 가 실제로 생겼는가" 를 먼저 확인한 뒤 "그 PID 가 사라졌는가" 를
// 묻는다. 남의 python 이나 합성 작업은 이름·명령줄이 달라 애초에 목록에 들어오지 않는다.
import { execFileSync } from 'child_process'

// PowerShell 5.1 에는 `-AsArray` 가 없다. 배열 유지를 위해 `@()` 로 감싸 `-InputObject` 로 넘긴다.
const PS_QUERY = [
  "$r = @(Get-CimInstance Win32_Process -Filter \"Name LIKE '%python%'\"",
  "Where-Object { $_.CommandLine -like '*analysis_worker.py*' }",
  'Select-Object ProcessId,ParentProcessId)',
].join(' | ') + '; ConvertTo-Json -Compress -Depth 3 -InputObject $r'

/**
 * 지금 살아 있는 분석 worker 목록. `[{ pid, ppid }]`.
 * 조회 자체가 실패하면 `null` — 그때는 "없다" 로 단정하지 않는다.
 */
export function listAnalysisWorkers() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_QUERY],
      { encoding: 'utf-8', timeout: 20000 }).trim()
    if (!out) return []
    const parsed = JSON.parse(out)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((r) => ({ pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId) }))
  } catch {
    return null
  }
}

/** PID 집합. 조회 실패는 `null` 로 그대로 전달한다. */
export function workerPidSet() {
  const rows = listAnalysisWorkers()
  return rows === null ? null : new Set(rows.map((r) => r.pid))
}

/** `before` 이후에 새로 생긴 worker PID. 조회 실패면 `null`. */
export function newWorkerPids(before) {
  const now = workerPidSet()
  if (now === null || before === null) return null
  return [...now].filter((pid) => !before.has(pid))
}

/**
 * 주어진 PID 들이 전부 사라질 때까지 기다린다.
 * 돌려주는 값은 **아직 살아 있는 PID 목록** — 계약을 지켰다면 빈 배열이다.
 */
export async function waitForGone(pids, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    const now = workerPidSet()
    if (now === null) return null
    const alive = pids.filter((pid) => now.has(pid))
    if (alive.length === 0 || Date.now() - t0 > timeoutMs) return alive
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * 주어진 **PID 만** 강제 종료한다. 목록은 `listAnalysisWorkers()` 가 준 것이어야 한다.
 *
 * 명령줄 문자열로 골라 죽이지 않는다 — 그 방식은 질의를 실행하는 powershell 자신이
 * 목록에 들어와 스스로를 죽였고, 따옴표가 한 겹 어긋나자 아무것도 죽이지 않은 채
 * 조용히 실패해 그 검사를 껍데기로 만들었다. PID 는 그런 애매함이 없다.
 *
 * 돌려주는 값은 **실제로 종료 명령이 통한 개수**다. 0 이면 호출한 쪽이 알아야 한다.
 */
export function killWorkerPids(pids) {
  let killed = 0
  for (const pid of pids ?? []) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
      killed += 1
    } catch { /* 이미 죽었다 */ }
  }
  return killed
}
