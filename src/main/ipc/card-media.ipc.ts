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
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

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
