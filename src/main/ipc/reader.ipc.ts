/**
 * 낭독 통로 — **덩이 하나를 소리로 바꾼다.**
 *
 * ★지시 (2026-09-29): "기본음성으로 읽어주거나 적용한 목소리로 읽게" 하는 책 플레이어.
 *
 * 여기서 지키는 것
 *   · **한 번에 하나만** 만든다. 본체가 파이썬을 하나만 돌리기 때문이다 —
 *     그 판정은 `synthesisGate` 한 곳이 갖는다. 낭독도 그 줄에 선다.
 *   · 만든 것은 **덩이 글의 지문**으로 이름 붙여 쌓아 둔다. 같은 글을 다시 읽으면
 *     즉시 나온다(두 번째 듣기·되돌아가기).
 *   · 실패를 삼키지 않는다. 사유를 그대로 돌려준다 — 화면이 왜 조용한지 말해야 한다.
 *
 * ★소리 파일은 **앱 데이터 자리**에 쌓는다(결과물이 아니다).
 *   사용자가 만든 결과는 `AudioForge_output` 이 갖는다 — 낭독 조각은 캐시다.
 */
import { ipcMain, app, BrowserWindow } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { execFile, spawn, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { currentPythonPath, synthesisBusy, setReaderRunning, pickFiles, dialogFolderHost } from './audio.ipc'
import { rememberFile } from '../services/dialogFolders'
import { TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { usesGpu } from '../../shared/readerQueue'
import { appLog, fileLabel } from '../services/app-log'
import { createLane, failureReason, jsonLines, madeTrack, pythonReason, readerRunConfig } from '../services/reader-run'
import { QwenVoiceWorker } from '../services/qwen-voice-worker'
import { parseWav, envelope, alignParts, type TimingPart } from '../../shared/readerTiming'

const execFileAsync = promisify(execFile)

/** 낭독 조각이 쌓이는 자리. */
const READER_DIR = 'readerChunks'
/** 쌓아 둘 상한(바이트). 넘으면 오래된 것부터 지운다. */
const CACHE_LIMIT = 400 * 1024 * 1024

interface Reply<T> { data?: T; error?: string }
const ok = <T>(data: T): Reply<T> => ({ data })
const fail = (e: unknown): Reply<never> => ({ error: (e as Error)?.message || String(e) })

/**
 * 이 글을 이 목소리로 만든 소리의 **이름.**
 *
 * ★목소리·설정까지 지문에 넣는다. 글만 보면 목소리를 바꿔도 옛 소리가 나온다 —
 *   무엇으로 만든 소리인지 알 수 없게 된다(인수인계 8항).
 */
function chunkName(text: string, voiceKey: string): string {
  return createHash('sha256').update(`${voiceKey}${text}`).digest('hex').slice(0, 24) + '.wav'
}

function readerDir(): string {
  const d = join(app.getPath('userData'), READER_DIR)
  mkdirSync(d, { recursive: true })
  return d
}

/** 쌓인 것이 상한을 넘으면 **오래 안 쓴 것부터** 지운다. */
function trimCache(): void {
  const dir = readerDir()
  let files: { p: string; size: number; at: number }[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => {
      const p = join(dir, f)
      const st = statSync(p)
      return { p, size: st.size, at: st.mtimeMs }
    })
  } catch { return }
  let total = files.reduce((s, f) => s + f.size, 0)
  if (total <= CACHE_LIMIT) return
  files.sort((a, b) => a.at - b.at)
  for (const f of files) {
    if (total <= CACHE_LIMIT) break
    try { rmSync(f.p, { force: true }); total -= f.size } catch { /* 다음에 */ }
  }
}

function scriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const found = [
    join(here, '..', '..', '..', 'python', 'separate.py'),
    join(process.cwd(), 'python', 'separate.py'),
  ].find((p) => existsSync(p))
  if (!found) throw new Error('합성 스크립트를 찾지 못했습니다')
  return found
}

/**
 * Qwen 지정 목소리 자리 → (모델 폴더, 화자). 파이썬 `tts_worker.qwen_voice_of` 와 같은 규칙.
 * · 모델의 config.json → 소희(예전부터 쓰던 자리)
 * · python/voices/qwen/<화자>.json → 그 화자(2026-10-01 — 소희 말고 일곱을 더 싣는다). 모델은 받아 둔 지정 목소리 모델.
 * 못 풀면 null.
 */
function qwenVoiceOf(path: string): { model: string; speaker: string } | null {
  if (basename(path) === 'config.json') return { model: dirname(path), speaker: 'sohee' }
  let speaker = ''
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as { engine?: string; speaker?: string }
    if (j.engine !== 'qwen-custom' || !j.speaker) return null
    speaker = String(j.speaker).toLowerCase()
  } catch { return null }
  const ext = join(dirname(dirname(scriptPath())), 'externals')
  try {
    for (const name of readdirSync(ext).sort()) {
      if (!name.startsWith('qwen3_tts')) continue
      const cfg = join(ext, name, 'config.json')
      if (!existsSync(cfg)) continue
      try { if ((JSON.parse(readFileSync(cfg, 'utf-8')) as { tts_model_type?: string }).tts_model_type === 'custom_voice') return { model: join(ext, name), speaker } } catch { /* 다음 폴더 */ }
    }
  } catch { /* 없다 */ }
  return null
}

/** Qwen 상주 실행기 — 하나만. 한동안 안 쓰면 내리고, 앱이 끝날 때 내린다. */
let qwenWorkerInstance: QwenVoiceWorker | null = null
function qwenWorker(): QwenVoiceWorker {
  if (qwenWorkerInstance) return qwenWorkerInstance
  const pyDir = dirname(scriptPath())
  const root = dirname(pyDir)
  qwenWorkerInstance = new QwenVoiceWorker({
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as SpawnOptions),
    pythonPath: () => join(root, 'externals', 'qwen3_tts_venv', 'Scripts', 'python.exe'),
    scriptPath: () => join(pyDir, 'qwen_voice_server.py'),
    // 검사 전용 — '한동안 안 쓰면 내린다' 를 몇 초 안에 보려고. 검사 밖에서는 3분.
    idleMs: process.env.AF_E2E === '1' && Number(process.env.AF_E2E_QWEN_IDLE_MS) > 0 ? Number(process.env.AF_E2E_QWEN_IDLE_MS) : undefined,
    onEvent: (e, f) => appLog()?.info('reader', `Qwen 상주 실행기 ${e === 'start' ? '띄움' : `내림${f.reason ? `(${String(f.reason)})` : ''}`}`),
  })
  return qwenWorkerInstance
}

/**
 * 기본 목소리(Supertonic) **상주 실행기** — 하나만 (2026-10-01).
 * ★조각마다 파이썬을 새로 띄우면 기동·모델 열기에 약 1.7초가 매번 들었다(15초 분량 한 덩이 4.8초 중). 띄워 두면 합성 시간만 든다.
 * ★소리는 예전 길과 똑같다 — 실행기가 같은 separate.main() 을 설정 파일로 부른다(같은 글 → 같은 소리, 실측 차이 0).
 * CPU 로만 돈다(그래픽카드를 잡지 않는다). 한동안 안 쓰면 내리고, 앱이 끝날 때 내린다.
 */
const READER_WORKER_IDLE_MS = 10 * 60_000
/** 앱이 끝나는 중 — 이때 끊긴 조각은 실패로 적지 않는다. */
let quitting = false
let readerWorkerInstance: QwenVoiceWorker | null = null
function readerWorker(): QwenVoiceWorker {
  if (readerWorkerInstance) return readerWorkerInstance
  readerWorkerInstance = new QwenVoiceWorker({
    label: '기본 목소리 상주 실행기',
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as SpawnOptions),
    pythonPath: () => currentPythonPath() || '',
    scriptPath: () => join(dirname(scriptPath()), 'reader_voice_server.py'),
    idleMs: process.env.AF_E2E === '1' && Number(process.env.AF_E2E_QWEN_IDLE_MS) > 0 ? Number(process.env.AF_E2E_QWEN_IDLE_MS) : READER_WORKER_IDLE_MS,
    timeoutMs: 600000,
    onEvent: (e, f) => appLog()?.info('reader', `기본 목소리 상주 실행기 ${e === 'start' ? '띄움' : `내림${f.reason ? `(${String(f.reason)})` : ''}`}`),
  })
  return readerWorkerInstance
}
/** 상주 실행기로 만드는 기본 목소리인가. */
const residentBuiltin = (v: { kind: string; engineId?: string }) => v.kind === 'builtin' && v.engineId === 'supertonic'

/**
 * 만든 소리 안에서 **구절마다의 시각** — 따라가기가 읽는 줄을 안다(규칙은 readerTiming).
 * ★소리 파일을 읽어 크기만 잰다(10ms 마다). 못 읽으면 빈 배열 — 화면은 덩이 단위로 돌아간다.
 */
function timingOf(wavPath: string, parts: TimingPart[] | null): Array<[number, number]> {
  if (!parts?.length) return []
  try {
    const w = parseWav(new Uint8Array(readFileSync(wavPath)))
    return w ? alignParts(envelope(w), parts) : []
  } catch { return [] }
}

/** 화면이 보낸 구절 무게를 믿지 않는다 — 모양이 다르면 없는 것으로. */
function partsOf(raw: unknown): TimingPart[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 2000) return null
  const out: TimingPart[] = []
  for (const p of raw) {
    const w = Number((p as { weight?: unknown })?.weight)
    if (!Number.isFinite(w) || w < 0) return null
    out.push({ weight: w, strong: !!(p as { strong?: unknown })?.strong })
  }
  return out
}

export interface ReaderVoice {
  /** 'builtin' 이면 설치된 목소리, 'reference' 면 참조 클립. */
  kind: 'builtin' | 'reference'
  /** builtin: 모델 파일 경로 · reference: 준비된 클립 경로. */
  path: string
  engineId?: string
}

/**
 * 낭독 작업의 **줄** — 한 번에 하나씩 차례로 돈다.
 *
 * ★없어서 깨졌다 (2026-09-30 사용자 신고: "기본음성 참조 목소리 둘 다 안 된다",
 *   "붉은색으로 경로가 빠르게 보였다 사라진다"). 목소리·설정을 바꾸면 화면은 새로 만들기 시작하는데
 *   앞서 돌던 작업은 멈추지 않는다. 둘이 **같은 자리에 같은 이름**(synthesized.wav)으로 쓰다가
 *   하나가 "다른 프로세스가 파일을 사용 중" 으로 죽었다 — 재현: 하나씩 정상, 동시에 둘이면 하나 실패.
 *   둘 다 살아도 서로의 소리를 가져갈 수 있었다.
 */
const inLane = createLane()

/**
 * 덩이 하나를 소리로 — **제 자리에서** 만든다.
 *
 * ★작업마다 제 폴더를 쓴다. 같은 폴더를 나눠 쓰면 이름이 겹친다(위 사고).
 * ★실패하면 **파이썬이 말한 사유**를 돌려준다. 예전에는 실행한 명령줄("Command failed: E:\\…")이
 *   그대로 화면에 떴다 — 사유도 아니고, 폴더 경로가 드러났다. 경로는 파일 이름만 남긴다.
 */
async function makeChunk(body: string, v: ReaderVoice, out: string): Promise<string> {
  // 차례를 기다리는 사이 같은 글·같은 목소리가 만들어졌을 수 있다.
  if (existsSync(out)) return out
  // ★다른 화면의 작업이 돌면 비킨다. 판정은 `synthesisGate` 한 곳이 갖는다.
  const busy = synthesisBusy('낭독')
  if (busy) throw new Error(busy)
  const py = currentPythonPath()
  if (!py || !existsSync(py)) throw new Error('파이썬을 찾지 못했습니다')

  const runDir = join(readerDir(), 'work', `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(runDir, { recursive: true })
  const cfgPath = join(runDir, 'chunk.json')
  writeFileSync(cfgPath, JSON.stringify(readerRunConfig(body, v, runDir)), 'utf-8')

  const t0 = Date.now()
  // ★GPU 목소리(참조 · Qwen 지정 목소리 — 규칙은 readerQueue.usesGpu)만 남에게 '도는 중' 으로 알린다. CPU 기본 목소리는 한 덩이 2초이고, 책을 열기만 해도
  //   앞서 만들어 두므로(누르기 전에도) 그것까지 알리면 **책을 열어 둔 것만으로 합성이 거절된다.**
  // ★남을 본 **다음에** 세운다 — 먼저 세우면 제 판정에 제가 걸린다. 바로 아래 try 의 finally 가 내린다.
  const gpu = usesGpu(v)
  if (gpu) setReaderRunning(true)
  try {
    let wav: string
    let note = ''
    if (residentBuiltin(v)) {
      // ★기본 목소리는 **띄워 둔 실행기**로 — 같은 설정 파일, 같은 소리.
      const r = await readerWorker().call({ config: cfgPath })
      wav = String(r.path || '')
      note = ` 상주${r.loaded_now ? '(모델 엶)' : ''} 생성=${Number(r.gen_sec || 0).toFixed(1)}s`
      if (!wav || !existsSync(wav)) throw new Error('이 부분을 소리로 만들지 못했습니다')
    } else if (v.kind === 'builtin' && v.engineId === 'qwen-custom') {
      // ★Qwen 소희는 **띄워 둔 실행기**로 만든다 — 조각마다 모델을 여는 약 10초가 첫 조각에만 든다(2026-09-30 실측).
      //   글은 화면이 이미 소리 내지 않을 기호를 뺀 것이다(speakableText).
      const textFile = join(runDir, 'text.txt')
      writeFileSync(textFile, body, 'utf-8')
      wav = join(runDir, 'qwen.wav')
      const qv = qwenVoiceOf(v.path)
      if (!qv) throw new Error('고른 Qwen 목소리를 알아보지 못했습니다')
      const r = await qwenWorker().speak({ model: qv.model, speaker: qv.speaker, language: 'korean', textFile, out: wav })
      note = ` 상주${r.loadedNow ? '(모델 엶)' : ''} 생성=${r.genSec.toFixed(1)}s 소리=${r.seconds.toFixed(1)}s`
      if (!existsSync(wav)) throw new Error('이 부분을 소리로 만들지 못했습니다')
    } else {
      const { stdout } = await execFileAsync(py, ['-X', 'utf8', scriptPath(), '--config', cfgPath], {
        // 긴 덩이도 기본 목소리면 몇 초다. 참조 목소리는 훨씬 오래 걸린다.
        timeout: 600000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      const lines = jsonLines(stdout)
      const made = madeTrack(lines)
      if (!made || !existsSync(made)) throw new Error(pythonReason(lines) || '이 부분을 소리로 만들지 못했습니다')
      wav = made
    }
    // 지문 이름으로 옮겨 둔다 — 다음에 같은 글·같은 목소리면 곧바로 쓴다.
    writeFileSync(out, readFileSync(wav))
    trimCache()
    // 동작 기록 — 글 내용 없이 글자 수·걸린 시간만. 낭독이 얼마나 빠른지 사용자가 볼 수 있다.
    appLog()?.info('reader', `만듦 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s${note}`)
    return out
  } catch (e) {
    const shown = failureReason(e)
    // ★로그에 남긴다 — 낭독은 실패를 한 줄도 남기지 않아 신고를 받고도 사유를 알 수 없었다.
    //   **글 내용은 적지 않는다.** 글자 수와 목소리 파일 이름만.
    // ★앱을 끄면서 멈춘 조각은 실패가 아니다 — 경고로 남기면 끌 때마다 문제가 난 것처럼 보였다(2026-10-01 · MCP 검사).
    if (quitting) appLog()?.info('reader', `앱 종료로 멈춤 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length}`)
    else appLog()?.warn('reader', `만들지 못함 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s: ${shown}`)
    throw new Error(shown)
  } finally {
    if (gpu) setReaderRunning(false)
    try { rmSync(runDir, { recursive: true, force: true }) } catch { /* 다음 정리에서 */ }
  }
}

/**
 * **기능 검사**용 — 낭독과 똑같은 길(줄·제 폴더·같은 설정)로 한 덩이를 만들어 본다(2026-09-30).
 * ★쌓아 두는 자리에 남기지 않는다: 만든 소리는 검사 자리에 두고, 부르는 쪽이 들여다본 뒤 지운다.
 */
export async function readerSelfTest(text: string, v: ReaderVoice): Promise<{ path: string; bytes: number }> {
  const dir = join(readerDir(), 'selfcheck')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  const made = await inLane(() => makeChunk(text, v, out))
  return { path: made, bytes: statSync(made).size }
}

/** 지금 만들고 있는 것 — 같은 글을 또 부르면 그 약속을 나눠 준다. */
const inFlight = new Map<string, Promise<string>>()

export function registerReaderIpc(): void {
  // Qwen 상주 실행기는 앱과 함께 끝난다(그래픽카드 메모리를 붙든 채 남지 않게).
  app.on('will-quit', () => { quitting = true; qwenWorkerInstance?.stop('앱 종료'); readerWorkerInstance?.stop('앱 종료') })

  /**
   * 목소리를 **미리 연다** — 고른 순간(또는 책을 연 순간) 모델을 올려 둬 첫 조각을 기다리지 않게 (2026-10-01).
   * ★기본 목소리는 CPU 라 언제든. Qwen 소희는 그래픽카드를 쓰므로 다른 작업이 돌면 열지 않는다(그때는 누를 때 연다).
   * ★줄에 세운다 — 여는 동안 온 조각은 연 다음에 만든다.
   */
  ipcMain.handle('reader:warm', async (_e, voice: unknown): Promise<Reply<{ warmed: boolean; why?: string }>> => {
    try {
      const v = voice as ReaderVoice | null
      if (!v || v.kind !== 'builtin' || !v.path || !existsSync(v.path)) return ok({ warmed: false, why: '미리 열 목소리가 아닙니다' })
      if (residentBuiltin(v)) {
        if (!currentPythonPath()) return ok({ warmed: false, why: '파이썬을 찾지 못했습니다' })
        await inLane(() => readerWorker().call({ warm: true, model: v.path }))
        return ok({ warmed: true })
      }
      if (v.engineId === 'qwen-custom') {
        // 검사 전용 — GPU 를 쓰지 않는 기본 검사에서는 그래픽카드에 모델을 올리지 않는다(AF_E2E_GPU=1 일 때만 연다).
        if (process.env.AF_E2E === '1' && process.env.AF_E2E_GPU !== '1') return ok({ warmed: false, why: '검사(GPU 끔)' })
        return ok(await inLane(async () => {
          const busy = synthesisBusy('낭독')
          if (busy) return { warmed: false, why: busy }
          setReaderRunning(true)
          const qv = qwenVoiceOf(v.path)
          if (!qv) return { warmed: false, why: '고른 Qwen 목소리를 알아보지 못했습니다' }
          try { await qwenWorker().call({ warm: true, model: qv.model }) } finally { setReaderRunning(false) }
          return { warmed: true }
        }))
      }
      return ok({ warmed: false, why: '미리 열 목소리가 아닙니다' })
    } catch (e) { return fail(e) }
  })

  /**
   * 줄에 선 것을 다 만들 때까지 기다린다 — 낭독 화면이 참조 목소리를 준비하기 전에 부른다.
   * ★준비도 파이썬을 띄운다. 낭독이 만들던 것과 겹치면 공용 판정에 거절된다 — 거절 대신 기다린다.
   */
  ipcMain.handle('reader:idle', async (): Promise<Reply<true>> => {
    try { await inLane(async () => undefined); return ok(true) } catch (e) { return fail(e) }
  })

  /**
   * 덩이 하나를 소리로. 이미 만들어 둔 것이 있으면 **곧바로** 그 자리를 돌려준다.
   */
  ipcMain.handle('reader:speak', async (
    _e, text: unknown, voice: unknown, voiceKey: unknown, rawParts?: unknown,
  ): Promise<Reply<{ path: string; cached: boolean; timing: Array<[number, number]> }>> => {
    try {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('읽을 글이 없습니다')
      const v = voice as ReaderVoice | null
      if (!v || (v.kind !== 'builtin' && v.kind !== 'reference')) throw new Error('목소리를 고르세요')
      if (!v.path || !existsSync(v.path)) throw new Error('고른 목소리를 찾지 못했습니다')
      const key = String(voiceKey ?? '')
      const parts = partsOf(rawParts)

      const out = join(readerDir(), chunkName(body, key))
      if (existsSync(out)) return ok({ path: out, cached: true, timing: timingOf(out, parts) })

      const already = inFlight.get(out)
      if (already) { const p = await already; return ok({ path: p, cached: false, timing: timingOf(p, parts) }) }

      // ★한 번에 하나 — 줄에 세운다. 앞 작업이 끝나야 다음이 돈다.
      const run = inLane(() => makeChunk(body, v, out))
      inFlight.set(out, run)
      void run.finally(() => { inFlight.delete(out) }).catch(() => { /* 아래에서 받는다 */ })
      const made = await run
      return ok({ path: made, cached: false, timing: timingOf(made, parts) })
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 책으로 읽을 글 파일을 고른다 — **지난번에 불러온 폴더에서 연다.**
   *
   * ★지시 (2026-09-29): "소설 또는 텍스트를 불러온 위치를 기억" 해야 한다.
   *   예전에는 화면이 브라우저식 파일 입력칸을 써서 여는 자리를 운영체제가 정했다.
   * ★내용 판정(글자 규칙·빈 글)은 화면이 한다 — 끌어 놓기와 **같은 규칙**을 타야 해서다.
   *   여기서는 파일을 읽어 넘기기만 하고, 상한을 넘는 파일은 **읽지도 않는다.**
   */
  ipcMain.handle('reader:pick-texts', async (e): Promise<Reply<{ name: string; size: number; bytes?: Uint8Array }[]>> => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('창을 찾지 못했습니다')
      const paths = await pickFiles(win, {
        multi: true, slot: 'text',
        filters: [{ name: '텍스트', extensions: ['txt'] }, { name: 'All Files', extensions: ['*'] }],
      })
      return ok(paths.map((p) => {
        const name = basename(p)
        try {
          const size = statSync(p).size
          if (size > TEXT_FILE_LIMIT) return { name, size }
          return { name, size, bytes: readFileSync(p) }
        } catch {
          return { name, size: -1 }      // 읽지 못한 것은 화면이 사유를 말한다
        }
      }))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 끌어 놓은 글 파일의 폴더도 기억한다 — 끌어 온 것도 "불러온 자리" 다.
   * 없는 폴더는 기억하지 않는다(규칙은 `dialogFolders` 가 갖는다).
   */
  ipcMain.handle('reader:remember-text-dir', (_e, filePath: unknown) => {
    if (typeof filePath === 'string' && filePath) rememberFile(dialogFolderHost(), 'text', filePath)
    return true
  })

  /** 쌓아 둔 낭독 조각을 비운다. 설정의 '중간 산출물 비우기' 와 같은 갈래다. */
  ipcMain.handle('reader:clear-cache', () => {
    const dir = readerDir()
    let removed = 0
    let freed = 0
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.wav')) continue
        const p = join(dir, f)
        try { freed += statSync(p).size; rmSync(p, { force: true }); removed++ } catch { /* 다음에 */ }
      }
    } catch { /* 없으면 비울 것도 없다 */ }
    return { removed, freedMb: Math.round(freed / 1048576) }
  })
}
