/**
 * Qwen 지정 목소리 **상주 실행기 하나** — 낭독과 생성 카드가 함께 쓴다 (2026-10-01).
 *
 * ★왜 따로 두나: 처음에는 낭독(reader.ipc)이 혼자 들고 있었다. 생성 카드는 합성 프로세스(separate.py → tts_worker)가
 *   Qwen 을 부르는데, 그 프로세스는 생성마다 새로 뜨고 조각마다 모델(감정용 1.7B)을 새로 열었다 — 한 번에 30~60초.
 *   이제 이 실행기가 **이름 있는 파이프**도 열어, 합성 프로세스가 같은 실행기에 요청을 보낸다(모델은 이미 올라 있다).
 * ★파이프 주소·열쇠는 앱 실행마다 새로 만든다. 환경 변수로 자식 프로세스(합성 파이썬)에 내려간다 — 이 컴퓨터 안의 통로다.
 * ★실행기는 한동안 안 쓰면 내린다(그래픽카드 메모리) — 파이프로 일하는 동안에는 실행기가 '일함' 을 알려 내리지 않는다.
 */
import { spawn, type SpawnOptions } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { QwenVoiceWorker } from './qwen-voice-worker'
import { appLog } from './app-log'

/** 이 실행의 파이프 — 주소는 프로세스 번호 + 무작위, 열쇠는 무작위 32자. */
export const QWEN_PIPE = {
  addr: `\\\\.\\pipe\\audioforge-qwen-${process.pid}-${randomBytes(4).toString('hex')}`,
  key: randomBytes(16).toString('hex'),
}
// 자식 프로세스(합성 파이썬)가 물려받는다 — tts_worker 가 이 값으로 붙는다.
process.env.AF_QWEN_PIPE_ADDR = QWEN_PIPE.addr
process.env.AF_QWEN_PIPE_KEY = QWEN_PIPE.key

function pythonDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = [join(here, '..', '..', '..', 'python'), join(process.cwd(), 'python')]
    .find((p) => existsSync(join(p, 'qwen_voice_server.py')))
  if (!found) throw new Error('합성 스크립트를 찾지 못했습니다')
  return found
}

let instance: QwenVoiceWorker | null = null
export function qwenWorker(): QwenVoiceWorker {
  if (instance) return instance
  const pyDir = pythonDir()
  const root = dirname(pyDir)
  instance = new QwenVoiceWorker({
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as SpawnOptions),
    pythonPath: () => join(root, 'externals', 'qwen3_tts_venv', 'Scripts', 'python.exe'),
    scriptPath: () => join(pyDir, 'qwen_voice_server.py'),
    env: { AF_QWEN_PIPE_ADDR: QWEN_PIPE.addr, AF_QWEN_PIPE_KEY: QWEN_PIPE.key },
    // 검사 전용 — '한동안 안 쓰면 내린다' 를 몇 초 안에 보려고. 검사 밖에서는 3분.
    idleMs: process.env.AF_E2E === '1' && Number(process.env.AF_E2E_QWEN_IDLE_MS) > 0 ? Number(process.env.AF_E2E_QWEN_IDLE_MS) : undefined,
    onEvent: (e, f) => appLog()?.info('reader', `Qwen 상주 실행기 ${e === 'start' ? '띄움' : `내림${f.reason ? `(${String(f.reason)})` : ''}`}`),
  })
  return instance
}

/**
 * 떠 있지 않으면 띄우고 **준비될 때까지** 기다린다(요청 없이) — 생성 카드가 Qwen 목소리로 합성을 시작하기 전에 부른다.
 * ★기다리지 않으면 합성 파이썬이 먼저 붙으려다 실패해 그 실행 내내 예전 길(조각마다 모델 열기)로 간다.
 * 격리 환경이 없거나 준비가 늦으면 false — 합성은 예전 길로 그대로 돈다.
 */
export async function ensureQwenResident(): Promise<boolean> {
  try {
    if (!existsSync(join(dirname(pythonDir()), 'externals', 'qwen3_tts_venv', 'Scripts', 'python.exe'))) return false
    return await qwenWorker().ensure()
  } catch { return false }
}

/** 띄워 둔 실행기의 파이프 작업(카드·참조 낭독)이 끝날 때까지 — 실행기가 없거나 놀고 있으면 곧바로. */
export function qwenPipeIdle(timeoutMs: number): Promise<{ idle: boolean; stopped: boolean; why: string; wasBusy: boolean }> {
  if (!instance) return Promise.resolve({ idle: true, stopped: false, why: '', wasBusy: false })
  const w = instance
  const wasBusy = w.pipeWorking
  return w.whenPipeIdle(timeoutMs).then((r) => ({ ...r, why: wasBusy ? w.lastPipeWhy : '', wasBusy }))
}

export function stopQwenResident(reason: string): void {
  instance?.stop(reason)
}
