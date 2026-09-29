/**
 * 기능 검사 — 기능 하나를 **앱이 실제로 쓰는 길 그대로** 돌려 본다.
 *
 * ★지시 (2026-09-30): 설정의 기능 검사 탭에서 기능별로 눌러 확인한다. 통과는 초록, 문제는 붉은 아이콘.
 * ★사용자 파일을 쓰지 않는다. 참조 목소리 검사도 **앱의 기본 목소리로 만든 말소리**를 참조로 쓴다.
 *   만든 소리는 검사 자리(readerChunks/selfcheck)에 두었다가 들여다본 뒤 지운다.
 * ★결과는 동작 기록(`check`)에 남는다 — 콘솔 복사·진단 묶음에 함께 실린다.
 */
import { ipcMain } from 'electron'
import { existsSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { currentPythonPath, dialogFolderHost } from './audio.ipc'
import { builtinVoiceList, findFfmpeg } from './card-media.ipc'
import { readerSelfTest } from './reader.ipc'
import { appLog } from '../services/app-log'
import { scrubPathsForLog } from '../services/log-scrub'
import { CHECKS, resultLine, type CheckId, type CheckResult } from '../../shared/selfCheck'

const execFileAsync = promisify(execFile)
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

const results = new Map<CheckId, CheckResult>()
const running = new Set<CheckId>()

/** 다른 모듈(진단 묶음)이 마지막 결과를 싣는다. */
export function selfCheckResults(): CheckResult[] {
  return CHECKS.map((c) => results.get(c.id)).filter((r): r is CheckResult => !!r)
}

function pythonScript(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = [join(here, '..', '..', '..', 'python', name), join(process.cwd(), 'python', name)].find((p) => existsSync(p))
  if (!found) throw new Error(`${name} 을 찾지 못했습니다`)
  return found
}

function needPython(): string {
  const py = currentPythonPath()
  if (!py || !existsSync(py)) throw new Error('앱이 쓰는 파이썬을 찾지 못했습니다 — 설정의 파이썬 자리를 확인하세요')
  return py
}

const drop = (p: string) => { try { rmSync(p, { force: true }) } catch { /* 다음 정리에서 */ } }

/** 검사 하나. 통과면 확인한 것을 한 줄로 돌려주고, 아니면 던진다. */
const RUN: Record<CheckId, () => Promise<string>> = {
  python: async () => {
    const { stdout } = await execFileAsync(needPython(), ['-c', 'import sys; print(sys.version.split()[0])'], { timeout: 30000, env: PY_ENV })
    return `파이썬 ${String(stdout).trim()} 실행됨`
  },
  ffmpeg: async () => {
    const bin = await findFfmpeg()
    const { stdout } = await execFileAsync(bin, ['-version'], { timeout: 10000 })
    return String(stdout).split(/\r?\n/)[0].replace(/ Copyright.*$/, '').slice(0, 80)
  },
  models: async () => {
    const { stdout } = await execFileAsync(needPython(), ['-X', 'utf8', pythonScript('selfcheck_models.py')], { timeout: 60000, env: PY_ENV })
    const j = JSON.parse(String(stdout).trim() || '{}') as {
      piper?: { voices?: string[] }; supertonic?: { voices?: string[]; why?: string }; qwen?: { ok?: boolean; missing?: string[] }
    }
    const piper = j.piper?.voices ?? [], supertonic = j.supertonic?.voices ?? []
    const voices = [...piper, ...supertonic]
    const bad: string[] = []
    if (!voices.length) bad.push('기본 목소리 모델이 하나도 없습니다')
    if (j.supertonic?.why) bad.push(`Supertonic 목소리를 쓸 수 없습니다: ${j.supertonic.why}`)
    if (!j.qwen?.ok) bad.push(`참조 목소리 모델 파일이 빠졌습니다${j.qwen?.missing?.length ? ': ' + j.qwen.missing.join(', ') : ''}`)
    if (bad.length) throw new Error(bad.join(' · '))
    return `기본 목소리 ${voices.length}개(piper ${piper.length} · Supertonic ${supertonic.length}) · 참조 목소리 모델 파일 모두 있음`
  },
  'reader-builtin': async () => {
    const v = (await builtinVoiceList()).voices[0]
    if (!v) throw new Error('쓸 수 있는 기본 목소리가 없습니다')
    const made = await readerSelfTest('기능 검사입니다. 이 문장이 들리면 기본 목소리가 동작합니다.', { kind: 'builtin', path: v.path, engineId: v.engineId })
    try {
      if (made.bytes < 20000) throw new Error('만든 소리가 너무 짧습니다')
      return `${v.label} 로 한 문장을 만들었습니다`
    } finally { drop(made.path) }
  },
  'reader-reference': async () => {
    const v = (await builtinVoiceList()).voices[0]
    if (!v) throw new Error('참조로 쓸 말소리를 만들 기본 목소리가 없습니다')
    // 참조 — 앱의 기본 목소리로 만든 6초 남짓의 말소리(사용자 파일을 쓰지 않는다).
    const ref = await readerSelfTest('오늘은 날씨가 맑고 바람이 조금 불었다. 그는 창문을 열고 먼 산을 오래 바라보았다.',
      { kind: 'builtin', path: v.path, engineId: v.engineId })
    try {
      const made = await readerSelfTest('기능 검사입니다. 참조 목소리로 이 문장을 읽습니다.', { kind: 'reference', path: ref.path })
      try {
        if (made.bytes < 20000) throw new Error('만든 소리가 너무 짧습니다')
        return '참조 목소리로 한 문장을 만들었습니다'
      } finally { drop(made.path) }
    } finally { drop(ref.path) }
  },
  settings: async () => {
    const host = dialogFolderHost()
    const key = 'selfCheckProbe'
    const stamp = `probe-${Date.now()}`
    host.write(key, stamp)
    try {
      if (host.read(key) !== stamp) throw new Error('써 넣은 값이 다시 읽히지 않습니다')
      return '써 넣은 값이 다시 읽혔습니다'
    } finally { host.write(key, undefined as unknown as string) }
  },
  log: async () => {
    const log = appLog()
    if (!log) throw new Error('동작 기록기가 켜져 있지 않습니다')
    const stamp = `probe-${Date.now()}`
    log.info('check', `기록 확인 ${stamp}`)
    if (!log.recent().some((l) => l.includes(stamp))) throw new Error('콘솔에 남지 않았습니다')
    let file = ''
    try { file = readFileSync(log.currentFile(), 'utf-8') } catch { /* 아래에서 */ }
    if (!file.includes(stamp)) throw new Error('로그 파일에 남지 않았습니다')
    return '파일과 콘솔에 남았습니다'
  },
}

let registered = false

export function registerSelfCheckIpc(): void {
  // 창을 다시 만들어도 한 번만.
  if (registered) return
  registered = true
  ipcMain.handle('selfcheck:results', () => selfCheckResults())

  ipcMain.handle('selfcheck:run', async (_e, id: unknown): Promise<CheckResult | { error: string }> => {
    const check = CHECKS.find((c) => c.id === id)
    if (!check) return { error: '모르는 검사입니다' }
    if (running.has(check.id)) return { error: '이미 검사 중입니다' }
    running.add(check.id)
    const t0 = Date.now()
    let r: CheckResult
    try {
      // 검사 전용 — 붉은 표시가 실제로 뜨는지 보려고 일부러 실패시킨다. AF_E2E=1 이 아니면 없는 길이다.
      if (process.env.AF_E2E === '1' && (process.env.AF_E2E_SELFCHECK_FAIL || '').split(',').includes(check.id)) {
        throw new Error('검사용으로 일부러 실패시켰습니다')
      }
      const reason = await RUN[check.id]()
      r = { id: check.id, ok: true, reason: scrubPathsForLog(reason), ms: Date.now() - t0, at: new Date().toISOString() }
    } catch (e) {
      const why = scrubPathsForLog((e as Error)?.message || String(e)).split(/\r?\n/)[0].slice(0, 300)
      r = { id: check.id, ok: false, reason: why, ms: Date.now() - t0, at: new Date().toISOString() }
    } finally {
      running.delete(check.id)
    }
    results.set(check.id, r)
    if (r.ok) appLog()?.info('check', resultLine(r))
    else appLog()?.warn('check', resultLine(r))
    return r
  })
}
