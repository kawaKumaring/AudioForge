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
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { currentPythonPath, synthesisBusy, setReaderRunning, pickFiles, dialogFolderHost } from './audio.ipc'
import { rememberFile } from '../services/dialogFolders'
import { TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { appLog, fileLabel } from '../services/app-log'
import { createLane, failureReason, jsonLines, madeTrack, pythonReason, readerRunConfig } from '../services/reader-run'

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
  // ★참조 목소리(GPU)만 남에게 '도는 중' 으로 알린다. 기본 목소리는 CPU 로 한 덩이 2초이고, 책을 열기만 해도
  //   앞서 만들어 두므로(누르기 전에도) 그것까지 알리면 **책을 열어 둔 것만으로 합성이 거절된다.**
  // ★남을 본 **다음에** 세운다 — 먼저 세우면 제 판정에 제가 걸린다. 바로 아래 try 의 finally 가 내린다.
  const gpu = v.kind === 'reference'
  if (gpu) setReaderRunning(true)
  try {
    const { stdout } = await execFileAsync(py, ['-X', 'utf8', scriptPath(), '--config', cfgPath], {
      // 긴 덩이도 기본 목소리면 몇 초다. 참조 목소리는 훨씬 오래 걸린다.
      timeout: 600000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const lines = jsonLines(stdout)
    const wav = madeTrack(lines)
    if (!wav || !existsSync(wav)) throw new Error(pythonReason(lines) || '이 부분을 소리로 만들지 못했습니다')
    // 지문 이름으로 옮겨 둔다 — 다음에 같은 글·같은 목소리면 곧바로 쓴다.
    writeFileSync(out, readFileSync(wav))
    trimCache()
    // 동작 기록 — 글 내용 없이 글자 수·걸린 시간만. 낭독이 얼마나 빠른지 사용자가 볼 수 있다.
    appLog()?.info('reader', `만듦 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return out
  } catch (e) {
    const shown = failureReason(e)
    // ★로그에 남긴다 — 낭독은 실패를 한 줄도 남기지 않아 신고를 받고도 사유를 알 수 없었다.
    //   **글 내용은 적지 않는다.** 글자 수와 목소리 파일 이름만.
    appLog()?.warn('reader', `만들지 못함 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s: ${shown}`)
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
    _e, text: unknown, voice: unknown, voiceKey: unknown,
  ): Promise<Reply<{ path: string; cached: boolean }>> => {
    try {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('읽을 글이 없습니다')
      const v = voice as ReaderVoice | null
      if (!v || (v.kind !== 'builtin' && v.kind !== 'reference')) throw new Error('목소리를 고르세요')
      if (!v.path || !existsSync(v.path)) throw new Error('고른 목소리를 찾지 못했습니다')
      const key = String(voiceKey ?? '')

      const out = join(readerDir(), chunkName(body, key))
      if (existsSync(out)) return ok({ path: out, cached: true })

      const already = inFlight.get(out)
      if (already) return ok({ path: await already, cached: false })

      // ★한 번에 하나 — 줄에 세운다. 앞 작업이 끝나야 다음이 돈다.
      const run = inLane(() => makeChunk(body, v, out))
      inFlight.set(out, run)
      void run.finally(() => { inFlight.delete(out) }).catch(() => { /* 아래에서 받는다 */ })
      return ok({ path: await run, cached: false })
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
