/**
 * 생성 카드가 **영상을 받았을 때 소리를 꺼내는 자리.**
 *
 * ★왜 필요한가 (2026-09-26, 관리자 지시 1항 "영상은 필요한 오디오 추출 경로를 연결합니다")
 *   카드 화면은 mp4·mkv 같은 영상도 받는다. 그런데 참조 분석은 `python/reference_audio.py`
 *   가 **soundfile 로** 읽는다 — soundfile 은 영상 컨테이너를 열지 못한다.
 *   꺼내는 단계가 없으면 영상 카드는 참조 준비에서 그대로 실패한다.
 *
 * ★소유권 (관리자 지시 1항 "한 카드의 변경·삭제·정리가 다른 카드나 기존 작업의 파일을
 *   건드리지 않아야 한다")
 *   꺼낸 소리는 `userData/cardmedia/<카드 id>/` 아래에만 산다. 정리도 그 폴더만 지운다.
 *   `refclips`(참조 클립)·`dub`(더빙)·사용자 원본은 이 파일이 아예 알지 못한다.
 *
 * ★파이썬 통로를 쓰지 않는다
 *   합성은 파이썬 한 줄로 돌고, 그 줄이 바쁘면 참조 분석조차 거절된다.
 *   소리 꺼내기까지 그 줄에 세우면 카드 하나가 다른 카드를 막는다. ffmpeg 을 직접 부른다.
 */
import { ipcMain, app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentPythonPath, synthesisBusy } from './audio.ipc'

const execFileAsync = promisify(execFile)

export interface CardMediaReply<T> { ok: boolean; data?: T; error?: string }
const ok = <T>(data: T): CardMediaReply<T> => ({ ok: true, data })
const fail = (e: unknown): CardMediaReply<never> => ({
  ok: false, error: e instanceof Error ? e.message : String(e),
})

/** 영상으로 보는 확장자. 이 목록 밖은 소리 파일로 보고 그대로 쓴다. */
const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|wmv|flv|ts|mpg|mpeg)$/i
export function isVideoPath(p: string): boolean {
  return VIDEO.test(p || '')
}

// ffmpeg 자리. `audio.ipc.ts` 의 ffprobe 찾기와 같은 규칙이다(winget 설치 자리 + PATH).
const FFMPEG_PATHS = [
  'ffmpeg',
  join(process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffmpeg.exe'),
]

async function findFfmpeg(): Promise<string> {
  for (const p of FFMPEG_PATHS) {
    try {
      await execFileAsync(p, ['-version'], { timeout: 8000 })
      return p
    } catch { /* 다음 자리 */ }
  }
  throw new Error('ffmpeg 을 찾을 수 없습니다. ffmpeg 을 설치해 주세요.')
}

/** 이 카드의 소리가 사는 폴더. **카드 하나당 폴더 하나.** */
function cardDir(cardId: string): string {
  // 카드 id 가 경로가 되지 않게 지문으로 바꾼다 — 사용자 입력이 폴더 이름이 되면 안 된다.
  const safe = createHash('sha256').update(String(cardId)).digest('hex').slice(0, 16)
  const dir = join(app.getPath('userData'), 'cardmedia', safe)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 원본이 바뀌면 다른 이름이 되게 — 경로·크기·수정시각. */
function stampOf(p: string): string {
  try {
    const st = statSync(p)
    return createHash('sha256').update(`${p}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16)
  } catch {
    return createHash('sha256').update(p).digest('hex').slice(0, 16)
  }
}

export interface BuiltinVoice {
  engineId: string; modelId: string; label: string
  language: string; sampleRate: number; path: string
}

/** 목소리 목록을 여러 번 묻지 않는다 — 설치가 바뀌는 일은 드물다. */
let voiceCache: { at: number; data: { voices: BuiltinVoice[]; skipped: unknown[] } } | null = null
const VOICE_CACHE_MS = 60_000

/** 미리듣기로 읽는 짧은 문장. 화면·대사와 무관한 고정 문장이다. */
export const PREVIEW_TEXT = '안녕하세요. 이 목소리로 읽습니다.'
/** 이미 만들어 둔 미리듣기 — 같은 모델은 다시 만들지 않는다. */
const previewMade = new Map<string, string>()
/** 같은 모델을 동시에 두 번 만들지 않는다. */
const previewInFlight = new Map<string, Promise<string>>()

export function registerCardMediaIpc(): void {
  /**
   * 영상에서 소리를 꺼낸다. **소리 파일이면 그대로 돌려준다**(쓸데없이 다시 쓰지 않는다).
   * 이미 꺼내 둔 것이 있으면 다시 꺼내지 않는다 — 같은 원본이면 같은 이름이 된다.
   */
  ipcMain.handle('card:extract-audio', async (_e, cardId: string, filePath: string): Promise<CardMediaReply<string>> => {
    try {
      if (!cardId) throw new Error('카드를 알 수 없습니다')
      if (!filePath || !existsSync(filePath)) throw new Error(`파일을 찾을 수 없습니다: ${basename(filePath || '')}`)
      if (!isVideoPath(filePath)) return ok(filePath)

      const out = join(cardDir(cardId), `voice_${stampOf(filePath)}.wav`)
      if (existsSync(out) && statSync(out).size > 0) return ok(out)

      const ffmpeg = await findFfmpeg()
      // 참조 분석이 읽는 모양으로 맞춘다 — 24kHz 모노 16비트.
      // `-vn` 으로 그림을 버리고, `-y` 로 반쯤 쓰다 만 파일을 덮는다.
      await execFileAsync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', filePath, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out,
      ], { timeout: 300000, maxBuffer: 1024 * 1024 })

      if (!existsSync(out) || statSync(out).size === 0) {
        throw new Error('이 영상에서 소리를 찾지 못했습니다')
      }
      return ok(out)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 참조 소리 없이 바로 읽을 수 있는 **기본 목소리** 목록.
   *
   * ★'폴더가 있으니 된다' 고 말하지 않는다. 판정은 `python/builtin_voices.py` 가 하고
   *   런타임·모델·설정을 모두 본다. 여기서는 부르고 건네기만 한다.
   */
  ipcMain.handle('card:builtin-voices', async (): Promise<CardMediaReply<{ voices: BuiltinVoice[]; skipped: unknown[] }>> => {
    try {
      if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_MS) return ok(voiceCache.data)
      const py = currentPythonPath()
      if (!py || !existsSync(py)) throw new Error('파이썬을 찾지 못했습니다')
      const here = dirname(fileURLToPath(import.meta.url))
      const script = [
        join(here, '..', '..', '..', 'python', 'builtin_voices.py'),
        join(process.cwd(), 'python', 'builtin_voices.py'),
      ].find((p) => existsSync(p))
      if (!script) throw new Error('기본 목소리 조회 스크립트를 찾지 못했습니다')
      const { stdout } = await execFileAsync(py, ['-X', 'utf8', script], {
        timeout: 20000, maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      const parsed = JSON.parse(String(stdout).trim() || '{}') as { voices?: BuiltinVoice[]; skipped?: unknown[] }
      const data = { voices: parsed.voices || [], skipped: parsed.skipped || [] }
      voiceCache = { at: Date.now(), data }
      return ok(data)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 기본 목소리 **미리듣기** — 그 모델로 짧은 문장을 실제로 읽어 소리 파일을 돌려준다.
   *
   * ★카드·대사·생성본·채택을 건드리지 않는다. 이 통로는 그것들을 알지도 못한다.
   * ★합성이 도는 동안에는 만들지 않는다 — 파이썬 통로가 하나라 실제 생성과 부딪힌다.
   *   대신 이미 만들어 둔 것이 있으면 그것을 돌려준다(부딪히지 않는다).
   * ★같은 모델은 한 번만 만든다. 같은 소리를 다시 만들 이유가 없다.
   */
  ipcMain.handle('card:preview-builtin', async (_e, modelPath: string, engineId?: string): Promise<CardMediaReply<string>> => {
    try {
      if (!modelPath) throw new Error('목소리를 고르세요')
      const done = previewMade.get(modelPath)
      if (done && existsSync(done)) return ok(done)
      const flying = previewInFlight.get(modelPath)
      if (flying) return ok(await flying)

      const busy = synthesisBusy('미리듣기')
      if (busy) throw new Error(busy)
      if (!existsSync(modelPath)) throw new Error('고른 목소리 파일을 찾지 못했습니다')
      const py = currentPythonPath()
      if (!py || !existsSync(py)) throw new Error('파이썬을 찾지 못했습니다')
      const here = dirname(fileURLToPath(import.meta.url))
      const script = [
        join(here, '..', '..', '..', 'python', 'separate.py'),
        join(process.cwd(), 'python', 'separate.py'),
      ].find((p) => existsSync(p))
      if (!script) throw new Error('합성 스크립트를 찾지 못했습니다')

      const outDir = join(app.getPath('userData'), 'voicePreview',
        createHash('sha256').update(modelPath).digest('hex').slice(0, 16))
      mkdirSync(outDir, { recursive: true })
      const cfgPath = join(outDir, 'preview.json')
      writeFileSync(cfgPath, JSON.stringify({
        mode: 'tts', input: '', output: outDir, ttsText: PREVIEW_TEXT,
        ttsEngine: engineId || 'piper', ttsBuiltinModel: modelPath,
        ttsSpeed: 1.0, ttsSilenceGap: 0.5, ttsPitch: 0.0,
        ttsTailMode: 'auto', ttsTailPaddingMs: 120, ttsTailFadeMs: 8,
        ttsSpeakerMode: 'single', ttsReferenceOverride: '',
      }), 'utf-8')

      const run = execFileAsync(py, ['-X', 'utf8', script, '--config', cfgPath], {
        timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      }).then(({ stdout }) => {
        const made = String(stdout).split(/\r?\n/).map((l) => {
          try { return JSON.parse(l) as { type?: string; tracks?: { path?: string }[] } } catch { return null }
        }).filter(Boolean).reverse().find((o) => o!.tracks?.length)
        const wav = made?.tracks?.[0]?.path
        if (!wav || !existsSync(wav)) throw new Error('미리듣기 소리를 만들지 못했습니다')
        previewMade.set(modelPath, wav)
        return wav
      }).finally(() => {
        previewInFlight.delete(modelPath)
        try { unlinkSync(cfgPath) } catch { /* 남아도 해롭지 않다 */ }
      })
      previewInFlight.set(modelPath, run)
      return ok(await run)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 이 카드가 꺼내 둔 소리를 지운다. **그 카드 폴더만** 지운다.
   * 카드를 지우거나 원본을 바꿀 때 부른다. 다른 카드·기존 작업·사용자 원본은 건드리지 않는다.
   */
  ipcMain.handle('card:release-media', async (_e, cardId: string): Promise<CardMediaReply<boolean>> => {
    try {
      if (!cardId) return ok(false)
      const dir = cardDir(cardId)
      rmSync(dir, { recursive: true, force: true })
      return ok(true)
    } catch (e) {
      return fail(e)
    }
  })
}
