/**
 * 노래 변환 — 화면과 `python/song_worker.py` 사이의 통로.
 *
 * ★사슬을 다시 만들지 않는다. 이 파일이 하는 일은 넷뿐이다.
 *   · 작업 폴더를 정한다(사용자가 고른 자리 아래 `song/` — **새 설정을 만들지 않는다**)
 *   · 파이썬을 띄우고 진행·결과·오류를 화면에 그대로 넘긴다(요청 식별자를 실어서)
 *   · 멈추기 — **바깥 변환기(seed-vc)까지** 끝난 것을 확인하고 나서 잠금을 푼다
 *   · 내보내기 — 원곡·참조·결과를 **덮지 않는** 자리에만 저장한다
 *
 * ★GPU 를 두고 다른 작업과 서로 거절한다. 더빙·합성이 이미 그렇게 하고 있고,
 *   한쪽만 모르면 파이썬 둘이 같은 GPU 를 문다(2026-09-24 2차 감사에서 데인 자리).
 */
import { ipcMain, app, dialog, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, statSync, realpathSync, copyFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PythonRunner } from '../services/python-runner'
import { readSettingsFile, migrateSettings } from '../services/settings-store'
import { workRootOf, workRootBlockReason } from '../../shared/workRoot'
import { DUB_WORK_ROOT_KEY } from './dub.ipc'
import {
  songWorkFolderName, songExportFault, songRequestFault, guardedFilesOf,
  type SongRequest, type SongResult,
} from '../../shared/songJob'
import { joinOutputFault, type PathProbe } from '../../shared/joinOutputGuard'
import { rememberFile, saveTarget, type FolderHost } from '../services/dialogFolders'

export interface SongReply<T> { ok: boolean; data?: T; error?: string; code?: string }
const ok = <T>(data: T): SongReply<T> => ({ ok: true, data })
const fail = (e: unknown, code?: string): SongReply<never> => ({
  ok: false, error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}),
})

export class SongError extends Error {}
/** 사용자가 멈춘 것을 실패와 **구분한다** — '실패' 로 뭉개면 겁을 준다. */
export class SongCancelled extends SongError {}

/** 실제 파일을 보고 같은 파일인지 판정하는 수단(`joinOutputGuard` 와 같은 것을 쓴다). */
const fsProbe: PathProbe = {
  real: (p) => {
    try { return realpathSync.native(resolve(p)) } catch { /* 아직 없는 파일 */ }
    try { return resolve(p) } catch { return p }
  },
  fileId: (p) => {
    try {
      const st = statSync(p, { bigint: true })
      return st.ino ? `${st.dev}:${st.ino}` : null
    } catch { return null }
  },
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  try { win?.webContents.send(channel, payload) } catch { /* 창이 닫혔으면 할 일이 없다 */ }
}

/** 사용자가 고른 작업 자리(없으면 빈 문자열). 더빙과 **같은 설정 열쇠**를 읽는다. */
function chosenRoot(): string {
  try {
    const got = readSettingsFile(join(app.getPath('userData'), 'settings.json'))
    if (got.kind !== 'ok') return ''
    const v = migrateSettings(got.settings).settings[DUB_WORK_ROOT_KEY]
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 시각 도장 — 폴더 이름에 쓴다. */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface SongIpcAdapter {
  isRunning: () => boolean
}

export function registerSongIpc(
  getWindow: () => BrowserWindow | null,
  getPython: () => string,
  busyReason: () => string | null = () => null,
  /**
   * 대화상자 시작 폴더의 기억 창구. **audio.ipc·더빙과 같은 것**을 받는다 —
   * 통로를 따로 만들면 한쪽이 기억한 자리를 다른 쪽이 모른다.
   */
  folders?: FolderHost,
): SongIpcAdapter {
  const fh = folders
  let active: { runner: PythonRunner; reqId: string; cancelling: boolean } | null = null
  /** 마지막 결과 — 내보내기에서 '덮으면 안 되는 파일' 을 알기 위해 들고 있는다. */
  let lastResult: SongResult | null = null

  /**
   * 이 실행의 작업 폴더.
   *
   * ★같은 곡을 연속으로 돌려도 부딪히지 않는다 — 시각 + 요청 식별자 앞 토막(2026-09-27 지시 1).
   * ★사용자가 고른 자리에 닿지 못하면 **알리고 멈춘다.** 시스템 드라이브로 슬쩍 내려가지 않는다.
   */
  function makeWorkDir(sourceName: string, reqId: string): string {
    const chosen = chosenRoot()
    if (chosen) {
      // 고른 자리가 살아 있는지 먼저 본다(USB 를 빼 두었을 수 있다).
      const why = workRootBlockReason(chosen, { exists: existsSync, appDir: app.getAppPath() })
      if (why) {
        throw new SongError(
          `만든 것을 둘 자리에 닿지 못했습니다 — ${why} 고른 자리: ${chosen}`)
      }
    }
    const root = workRootOf(chosen, app.getPath('userData'))
    const dir = join(root, 'song', songWorkFolderName(sourceName, stamp(), reqId))
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e) {
      throw new SongError(
        `작업 폴더를 만들지 못했습니다(${dir}). 다른 자리를 고르거나 권한을 확인해 주세요.`)
    }
    return dir
  }

  /** 지금 새 작업이 쌓이는 자리. 화면이 사람에게 보여 준다. */
  ipcMain.handle('song:work-root', async (): Promise<SongReply<string>> => {
    try { return ok(join(workRootOf(chosenRoot(), app.getPath('userData')), 'song')) }
    catch (e) { return fail(e) }
  })

  /**
   * 노래 변환을 돌린다. **요청 시점의 입력을 그대로 결과에 되돌려 준다.**
   */
  ipcMain.handle('song:run', async (_e, req: SongRequest): Promise<SongReply<SongResult>> => {
    // ★가드를 try **밖**에서 세운다. 안에 두면 거절당한 두 번째 요청이 finally 로
    //   **먼저 돌고 있는 작업의 가드를 풀어 버린다**(더빙이 같은 자리에서 데였다).
    const why = busyReason()
    if (why) return fail(new SongError(why), 'BUSY')
    if (active) return fail(new SongError('이미 노래를 변환하고 있습니다'), 'BUSY')

    const fault = songRequestFault({ source: req?.source ?? null, voice: req?.voice ?? null })
    if (fault) return fail(new SongError(fault), 'BAD_REQUEST')

    const reqId = String(req.clientRequestId || randomUUID())
    const win = getWindow()
    let workDir = ''
    try {
      workDir = makeWorkDir(req.source.name || basename(req.source.path), reqId)
    } catch (e) {
      return fail(e, 'NO_WORK_DIR')
    }

    const python = getPython()
    if (!python || !existsSync(python)) {
      return fail(new SongError('파이썬을 찾지 못했습니다'), 'NO_PYTHON')
    }

    const args = [
      '--source', req.source.path, '--voice', req.voice.path,
      '--work', workDir, '--request-id', reqId,
    ]
    if (req.splitLead) args.push('--split-lead')

    return await new Promise<SongReply<SongResult>>((resolvePromise) => {
      const runner = new PythonRunner(python)
      active = { runner, reqId, cancelling: false }
      let made: SongResult | null = null
      let lastError = ''
      let lastCode = ''

      // ★진행률에 **요청 식별자를 여기서 싣는다.** PythonRunner 는 percent·message 만 남기고
      //   나머지 필드를 버리므로, 파이썬이 보낸 식별자는 여기까지 오지 않는다.
      runner.on('progress', (d: unknown) => {
        send(win, 'song:progress', { ...(d as object), clientRequestId: reqId })
      })
      runner.on('result', (d: unknown) => {
        const got = (d as { song?: SongResult })?.song
        if (got) made = { ...got, clientRequestId: reqId }
      })
      // 오류는 **객체 하나**로 온다(`{type:'error', message, code, ...}`). 사유와 코드를 함께 잡는다.
      runner.on('error', (m: unknown) => {
        const msg = m as { message?: unknown; code?: unknown } | null
        if (typeof msg?.message === 'string' && msg.message) lastError = msg.message
        else if (typeof m === 'string') lastError = m
        if (typeof msg?.code === 'string') lastCode = msg.code
      })
      runner.on('done', async (code: number, end?: { killedByUs?: boolean }) => {
        const stopped = !!active?.cancelling || !!end?.killedByUs
        // ★잠금은 여기서 풀지 않는다 — 취소 쪽이 **트리 종료를 확인한 뒤** 푼다.
        //   여기서 먼저 풀면 바깥 변환기가 아직 GPU 를 물고 있는데 다음 작업이 시작된다.
        if (!stopped) active = null
        if (code === 0 && made) {
          // 요청 시점의 입력을 결과에 싣는다 — 무엇으로 만든 소리인지 결과만 보고 알 수 있게.
          made = {
            ...made,
            input: { source: req.source, voice: req.voice, splitLead: !!req.splitLead },
          }
          lastResult = made
          send(win, 'song:result', made)
          resolvePromise(ok(made))
          return
        }
        if (stopped) {
          const payload = { clientRequestId: reqId, message: '노래 변환을 멈췄습니다' }
          send(win, 'song:cancelled', payload)
          resolvePromise(fail(new SongCancelled(payload.message), 'CANCELLED'))
          return
        }
        const message = lastError || `노래 변환이 코드 ${code} 로 끝났습니다`
        send(win, 'song:error', { clientRequestId: reqId, message, code: lastCode })
        resolvePromise(fail(new SongError(message), lastCode || 'SONG_FAILED'))
      })

      try {
        runner.run(PythonRunner.getScriptPath('song_worker.py'), args)
      } catch (e) {
        active = null
        resolvePromise(fail(e, 'SPAWN_FAILED'))
      }
    })
  })

  /**
   * 멈추기.
   *
   * ★`PythonRunner.cancel()` 은 Windows 에서 `taskkill /T /F` 로 **트리 전체**를 끝내고
   *   그것이 확인됐는지(`treeKillConfirmed`)까지 돌려준다. 노래 변환은 바깥 변환기
   *   (seed-vc)를 **손자 프로세스**로 띄우므로 이 확인이 특히 중요하다.
   * ★확인이 끝나기 전에는 잠금을 풀지 않는다(2026-09-27 지시 4).
   */
  ipcMain.handle('song:cancel', async (): Promise<SongReply<{
    stopped: boolean; treeKillConfirmed: boolean; reason?: string
  }>> => {
    try {
      if (!active) return ok({ stopped: false, treeKillConfirmed: true, reason: '돌고 있는 변환이 없습니다' })
      active.cancelling = true
      const r = await active.runner.cancel()
      const confirmed = !!r?.treeKillConfirmed
      // ★여기서만 잠금을 푼다. 트리 종료가 확인되지 않았으면 **풀지 않는다** —
      //   바깥 변환기가 아직 GPU 를 물고 있을 수 있다.
      if (confirmed) active = null
      return ok({
        stopped: true, treeKillConfirmed: confirmed,
        ...(confirmed ? {} : { reason: r?.reason || '바깥 변환기가 끝난 것을 확인하지 못했습니다' }),
      })
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 결과를 파일로 내보낸다.
   *
   * ★원곡·목소리·참조 클립·생성 결과 **어느 것도 덮지 않는다**(2026-09-27 지시 5).
   *   이름이 달라도 같은 파일이면 막는다. 판정은 `joinOutputGuard` 의 것을 그대로 쓴다.
   */
  ipcMain.handle('song:export', async (
    _e, which: 'mix' | 'vocal' | 'withHarmony', requestId: string,
  ): Promise<SongReply<{ path: string; canceled?: boolean }>> => {
    try {
      const r = lastResult
      if (!r) throw new SongError('내보낼 결과가 없습니다')
      // ★화면이 **보고 있는 결과**만 저장한다(2026-09-27 지시 1).
      //   본체가 들고 있는 마지막 결과를 그냥 쓰면, 새 변환이 끝난 뒤 화면의 옛 결과에서
      //   저장을 눌렀을 때 **다른 파일이 저장된다.** 요청 식별자로 맞춰 본다.
      const want = String(requestId || '')
      if (!want) throw new SongError('저장할 결과를 지정하지 않았습니다')
      if (want !== r.clientRequestId) {
        throw new SongError('화면에 보이는 결과와 저장할 결과가 다릅니다. 결과를 다시 확인해 주세요.')
      }
      const from = which === 'vocal' ? r.vocalPath
        : which === 'withHarmony' ? (r.withHarmonyPath || '') : r.mixPath
      if (!from || !existsSync(from)) throw new SongError('결과 파일을 찾지 못했습니다')

      const suggested = `${basename(r.input.source.path).replace(/\.[^.]+$/, '')}_${
        which === 'vocal' ? '변환보컬' : which === 'withHarmony' ? '원래화음까지' : '변환음원'}.wav`
      const d = await dialog.showSaveDialog(getWindow()!, {
        title: '노래 변환 결과 저장',
        defaultPath: fh ? saveTarget(fh, 'export', suggested, join) : suggested,
        filters: [{ name: 'WAV', extensions: ['wav'] }],
      })
      if (d.canceled || !d.filePath) return ok({ path: '', canceled: true })

      // 보호 목록은 **결과 계약이 정한다** — 여기서 따로 적지 않는다(두 벌이 되면 갈라진다).
      const guarded = guardedFilesOf(r)
      const clash = songExportFault(d.filePath, guarded, fsProbe)
      if (clash) throw new SongError(clash)
      // 임시 자리까지 겹치지 않는지도 본다(같은 규칙을 두 벌로 만들지 않는다).
      const tempClash = joinOutputFault(d.filePath, guarded.map((g) => ({ label: g.label, path: g.path })), fsProbe)
      if (tempClash) throw new SongError(tempClash)

      copyFileSync(from, d.filePath)       // ★원본은 그대로 둔다. 옮기지 않는다.
      if (fh) rememberFile(fh, 'export', d.filePath)
      return ok({ path: d.filePath })
    } catch (e) {
      return fail(e)
    }
  })

  return { isRunning: () => !!active }
}
