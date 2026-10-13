/** H3도 기존 상주 관리자 수명·파이프 작업 추적을 사용한다. 앱 밖 서버 없음. */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { QwenVoiceWorker } from './qwen-voice-worker'
import { appLog } from './app-log'

const addr = `\\\\.\\pipe\\audioforge-h3-${process.pid}-${randomBytes(4).toString('hex')}`
const key = randomBytes(16).toString('hex')
let worker: QwenVoiceWorker | null = null
let child: ChildProcess | null = null
let binding = ''
let activeJob: () => boolean = () => false
export function h3Running(): boolean { return !!child && child.exitCode === null && child.signalCode === null }
export async function ensureH3Resident(python: string, script: string, jobRunning: () => boolean = () => false): Promise<boolean> {
  activeJob = jobRunning
  if (!existsSync(python) || !existsSync(script)) return false
  const next = JSON.stringify([python, script])
  if (binding && binding !== next) {
    if (!await stopH3Resident('실행 경로 변경')) return false
    worker = null
  }
  binding = next
  if (!worker) worker = new QwenVoiceWorker({
    pythonPath: () => python, scriptPath: () => script, label: 'H3 상주 실행기',
    spawn: (cmd, args, options) => {
      const p = spawn(cmd, args, options as SpawnOptions); child = p
      p.once('close', () => { if (child === p) child = null }); return p
    },
    env: { AF_H3_PIPE_ADDR: addr, AF_H3_PIPE_KEY: key, AF_H3_SERVER: '1' },
    idleMs: process.env.AF_E2E === '1' && Number(process.env.AF_E2E_H3_IDLE_MS) > 0 ? Number(process.env.AF_E2E_H3_IDLE_MS) : undefined,
    onEvent: (event, fields) => appLog()?.info('job', `H3 상주 실행기 ${event} ${String(fields.reason || '')}`),
  })
  const ready = await worker.ensure()
  if (ready) { process.env.AF_H3_PIPE_ADDR = addr; process.env.AF_H3_PIPE_KEY = key }
  return ready
}
export async function stopH3Resident(reason: string): Promise<boolean> {
  delete process.env.AF_H3_PIPE_ADDR; delete process.env.AF_H3_PIPE_KEY
  const p = child
  worker?.stop(reason)
  if (!p || p.exitCode !== null || p.signalCode !== null) return true
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 3000)
    p.once('close', () => { clearTimeout(t); resolve(true) })
  })
}
export function h3PipeIdle(timeout: number): Promise<{ idle: boolean; wasBusy: boolean; why: string }> {
  if (!worker) return Promise.resolve({ idle: true, wasBusy: false, why: '' })
  const w = worker, wasBusy = w.pipeWorking
  return w.whenPipeIdle(timeout).then(r => ({ idle: r.idle, wasBusy, why: w.lastPipeWhy }))
}
/** 다른 목소리의 준비가 진행 중인 H3를 끊지는 않는다. 놀고 있을 때만 메모리를 양보한다. */
export async function yieldIdleH3(): Promise<boolean> {
  if (activeJob()) return false  // 파이프 접속 전 준비 중인 카드도 실행 소유권이 있다.
  if (!(await h3PipeIdle(0)).idle) return false
  return stopH3Resident('다른 목소리 사용')
}
