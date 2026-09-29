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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { currentPythonPath, synthesisBusy, pickFiles, dialogFolderHost } from './audio.ipc'
import { rememberFile } from '../services/dialogFolders'
import { TEXT_FILE_LIMIT } from '../../shared/readerChunks'

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

/** 지금 만들고 있는 것 — **한 번에 하나.** 같은 글을 또 부르면 그 약속을 나눠 준다. */
const inFlight = new Map<string, Promise<string>>()

export function registerReaderIpc(): void {
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

      // ★한 번에 하나. 이 판정은 `synthesisGate` 한 곳이 갖는다 — 낭독도 그 줄에 선다.
      const busy = synthesisBusy('낭독')
      if (busy) throw new Error(busy)

      const py = currentPythonPath()
      if (!py || !existsSync(py)) throw new Error('파이썬을 찾지 못했습니다')

      const workDir = join(readerDir(), 'work')
      mkdirSync(workDir, { recursive: true })
      const cfgPath = join(workDir, `chunk-${Date.now()}.json`)
      writeFileSync(cfgPath, JSON.stringify({
        mode: 'tts', input: '', output: workDir, ttsText: body,
        ttsEngine: v.kind === 'builtin' ? (v.engineId || 'piper') : undefined,
        ttsBuiltinModel: v.kind === 'builtin' ? v.path : undefined,
        ttsReferenceOverride: v.kind === 'reference' ? v.path : '',
        ttsSpeed: 1.0, ttsSilenceGap: 0.35, ttsPitch: 0.0,
        ttsTailMode: 'auto', ttsTailPaddingMs: 120, ttsTailFadeMs: 8,
        ttsSpeakerMode: 'single',
      }), 'utf-8')

      const run = execFileAsync(py, ['-X', 'utf8', scriptPath(), '--config', cfgPath], {
        // 긴 덩이도 기본 목소리면 몇 초다. 참조 목소리는 훨씬 오래 걸린다.
        timeout: 600000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      }).then(({ stdout }) => {
        const made = String(stdout).split(/\r?\n/).map((l) => {
          try { return JSON.parse(l) as { tracks?: { path?: string }[] } } catch { return null }
        }).filter(Boolean).reverse().find((o) => o!.tracks?.length)
        const wav = made?.tracks?.[0]?.path
        if (!wav || !existsSync(wav)) throw new Error('이 부분을 소리로 만들지 못했습니다')
        // 지문 이름으로 옮겨 둔다 — 다음에 같은 글·같은 목소리면 곧바로 쓴다.
        try { mkdirSync(dirname(out), { recursive: true }) } catch { /* 이미 있다 */ }
        try {
          if (wav !== out) {
            writeFileSync(out, readFileSync(wav))
            rmSync(wav, { force: true })
          }
        } catch { return wav }          // 못 옮기면 만든 자리를 그대로 쓴다
        trimCache()
        return out
      }).finally(() => {
        inFlight.delete(out)
        try { unlinkSync(cfgPath) } catch { /* 남아도 해롭지 않다 */ }
      })
      inFlight.set(out, run)
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
