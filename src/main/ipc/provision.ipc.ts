import { ipcMain, app, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { PythonRunner } from '../services/python-runner'
import { assertNoAbsolutePaths, type PlanResult, type VerifyResult } from '../../shared/provisionContract'
import type { ReasonCode } from '../../shared/runtimeContract'
import type {
  ProvisionPlanResponse,
  ProvisionVerifyResponse,
  ProvisionApplyResponse,
} from '../../shared/provisionIpc'
import { ALL_OPTIONAL, pickProvisionPython, parseProvisionEnvelope, envelopeReasonCode } from './provision-helpers'

// managed provisioner의 Electron 표면(Agent Q). P의 pure core가 산출한 canonical JSON을 subprocess로
// 받아 renderer로 실어 나른다 — plan/verify state machine·DAG·manifest·fingerprint·staging은 재구현 0.
//
// 계약:
//  - plan/verify: provision_cli.py(얇은 어댑터)를 경로로 실행 → 마지막 envelope 라인 파싱 → renderer 전달 전
//    assertNoAbsolutePaths 가드(§11). 파일 쓰기·다운로드·pip·venv 생성 0(plan/verify는 순수 stdlib).
//  - apply: **항상 차단**(APPLY_DISABLED). 실제 설치 로직 없음 — subprocess조차 띄우지 않는다.
//  - provisioner 실행용 Python은 **명시 주입만** 인정(자동 system·외부 배포판 채택 금지):
//    env AUDIOFORGE_PROVISION_PYTHON → settings.provisionPythonPath → settings.pythonPath(사용자가 고른 인터프리터).
//    셋 다 없으면 plan/verify는 실행 불가 → BOOTSTRAP_PYTHON_UNRESOLVED(production 해석은 STOP 표 항목).

const PROVISION_TIMEOUT_MS = 30000

// ── subprocess 실행 ─────────────────────────────────────────────────────────

const launcherPath = (): string => PythonRunner.getScriptPath('provision_cli.py')

// 실행 중인 provision child들(cancel 대상). plan/verify는 짧지만 취소 전달을 최소 배선한다.
const activeChildren = new Set<ChildProcess>()

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }

function runProvisionCli(pyPath: string, mode: string, engineIds: readonly string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const script = launcherPath()
    const cwd = dirname(script)
    const cfgPath = join(tmpdir(), `audioforge_provision_${randomUUID()}.json`)
    let settled = false
    const finish = (r: RunResult): void => {
      if (settled) return
      settled = true
      try { unlinkSync(cfgPath) } catch { /* ignore */ }
      resolve(r)
    }
    try {
      writeFileSync(cfgPath, JSON.stringify({ mode, engineIds }), 'utf-8')
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(pyPath, ['-X', 'utf8', '-B', script, '--config', cfgPath], {
        cwd,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        windowsHide: true,
      })
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message })
      return
    }
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8') })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      activeChildren.delete(child)
      finish({ code: null, stdout, stderr, timedOut: true })
    }, PROVISION_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      activeChildren.delete(child)
      finish({ code: -1, stdout, stderr, timedOut: false, spawnError: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      activeChildren.delete(child)
      finish({ code, stdout, stderr, timedOut: false })
    })
  })
}

export function registerProvisionIpc(_mainWindow: BrowserWindow): void {
  const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
  const loadSettings = (): Record<string, unknown> => {
    try {
      const f = settingsFile()
      if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf-8'))
    } catch { /* ignore */ }
    return {}
  }

  // plan/verify 공통 실행 — 성공 시 renderer-safe envelope, 실패 시 사유 코드. 절대경로 가드는 여기서.
  async function planOrVerify(mode: 'provision-plan' | 'provision-verify'):
    Promise<{ ok: true; result: unknown } | { ok: false; reasonCode: ReasonCode; message?: string }> {
    const py = pickProvisionPython(process.env, loadSettings())
    if (!py) {
      // provisioner를 돌릴 Python이 명시 주입되지 않음 — 자동 채택 금지(STOP 표). plan은 순수여도 실행기 없음.
      return { ok: false, reasonCode: 'BOOTSTRAP_PYTHON_UNRESOLVED', message: 'provisioner Python 미지정' }
    }
    const run = await runProvisionCli(py, mode, ALL_OPTIONAL)
    if (run.spawnError || run.timedOut) {
      return { ok: false, reasonCode: 'PREFLIGHT_FAILED', message: run.timedOut ? 'provision 시간 초과' : 'provisioner 실행 실패' }
    }
    const env = parseProvisionEnvelope(run.stdout)
    if (!env) {
      return { ok: false, reasonCode: 'PREFLIGHT_FAILED', message: 'provision 출력 파싱 실패' }
    }
    if (!env.ok) {
      return { ok: false, reasonCode: envelopeReasonCode(env.error), message: 'provision 계획 실패' }
    }
    // renderer로 나가기 전 전체 절대경로 가드(§11). 위반 시 renderer로 아무 경로도 보내지 않는다.
    try {
      assertNoAbsolutePaths(env.result)
    } catch {
      return { ok: false, reasonCode: 'PATH_OUTSIDE_ROOT', message: 'provision 결과 경로 계약 위반' }
    }
    return { ok: true, result: env.result }
  }

  ipcMain.handle('provision:plan', async (): Promise<ProvisionPlanResponse> => {
    const r = await planOrVerify('provision-plan')
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, message: r.message }
    return { ok: true, plan: r.result as PlanResult }
  })

  ipcMain.handle('provision:verify', async (): Promise<ProvisionVerifyResponse> => {
    const r = await planOrVerify('provision-verify')
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, message: r.message }
    return { ok: true, verify: r.result as VerifyResult }
  })

  // apply는 이번 단계 항상 차단 — 실제 설치 로직 없음. subprocess도 띄우지 않는다(다운로드/pip/venv 0).
  ipcMain.handle('provision:apply', async (): Promise<ProvisionApplyResponse> => {
    return { ok: false, reasonCode: 'APPLY_DISABLED', message: '실제 설치는 아직 비활성입니다(승인 전).' }
  })

  // 진행 중 provision plan/verify subprocess 취소(최소 배선). 반환: 취소 시도한 child 수.
  ipcMain.handle('provision:cancel', async (): Promise<{ ok: true; cancelled: number }> => {
    let n = 0
    for (const child of activeChildren) {
      try { child.kill() } catch { /* ignore */ }
      n++
    }
    activeChildren.clear()
    return { ok: true, cancelled: n }
  })
}
