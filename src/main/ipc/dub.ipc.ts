// 더빙이 화면에서 부르는 창구.
//
// 하는 일은 셋뿐이다 — 앞단 돌리기 / 번역문 고쳐 쓰기 / 내보내기.
// 판단은 전부 파이썬(dub_pipeline·dub_timing)에 있고, 파일 읽고 쓰는 규칙은
// services/dub-job 에 있다. 여기는 **둘을 잇는 자리**다.
//
// ★여기서 번역 백엔드를 고르지 않는다. 파이썬이 실행 경로 안쪽에서 막고 고른다 —
//   화면이 무엇을 보내든 구글로는 나가지 않는다.
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { basename, extname, join } from 'path'

import { PythonRunner } from '../services/python-runner'
import { rememberFile, saveTarget, startDir, type FolderHost } from '../services/dialogFolders'
import { createPreviewGuard } from '../services/preview-transcribe'
import { scrubPathsForLog } from '../services/log-scrub'
import { readSettingsFile, migrateSettings, setSettingsKey } from '../services/settings-store'
import { resolveWorkDir, workRootBlockReason, workRootOf } from '../../shared/workRoot'
import {
  DubJobError, readDoneStages, readLines, readRenderReport, reapplyKoreanEdits,
  saveKoreanEdits, saveKoreanEditsSidecar, workFolderName,
  writeTakesFile,
} from '../services/dub-job'
import type { DubCancelOutcome, DubFrontResult, DubRenderResult } from '../../shared/dubbing'

export const DUB_PROGRESS_CHANNEL = 'dub:progress'

interface DubReply<T> { ok: boolean; data?: T; error?: string }

function ok<T>(data: T): DubReply<T> { return { ok: true, data } }
function fail(e: unknown): DubReply<never> {
  const msg = e instanceof DubJobError || e instanceof Error ? e.message : String(e)
  // ★원시 오류 문구를 그대로 올리지 않는다(2026-09-25 3차 감사).
  //   우리가 쓴 문장(DubJobError)에는 경로가 없지만, 여기로는 **남의 오류**도 온다 —
  //   파일 쓰기 실패(`EACCES … rename 'E:\…\lines.json'`)와 실행 실패(`spawn … ENOENT`)다.
  //   이번 회차에 원자 교체를 넣으면서 던질 수 있는 자리를 늘렸다.
  //   폴더만 지우고 파일 이름은 남긴다 — 무엇이 실패했는지는 알아야 한다.
  return { ok: false, error: scrubPathsForLog(msg) }
}

/** 작업 자리를 적어 두는 설정 칸. */
export const DUB_WORK_ROOT_KEY = 'dubWorkRoot'

/** 지금까지 쓰던 자리 — 아무것도 고르지 않았을 때의 기본. */
function defaultRoot(): string {
  return app.getPath('userData')
}

/** 사용자가 고른 자리(없으면 빈 문자열). 읽기 전용이라 손상은 빈 것으로 본다. */
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

/**
 * 이 영상의 작업 폴더. **옛 자리에 있으면 옛 자리에서 연다.**
 *
 * ★왜 (2026-09-26 신고: "왜 자꾸 C 드라이브에다 생산시키는건가")
 *   작업 폴더가 앱 데이터 폴더로 코드에 박혀 있었고 옮길 설정도 없었다.
 *   곡 하나에 약 100MB — 실측으로 이미 535MB 가 시스템 드라이브에 쌓여 있었다.
 *
 * ★이미 쌓인 것을 옮기지 않는다. 옮기다 실패하면 작업을 잃는다.
 *   새 작업은 고른 자리에, 옛 작업은 있던 자리에서 그대로 열린다.
 *   고르는 규칙은 `shared/workRoot` 가 소유한다(여기서 판단하지 않는다).
 */
function dubWorkDir(videoPath: string): string {
  const r = resolveWorkDir({
    chosenRoot: chosenRoot(),
    defaultRoot: defaultRoot(),
    folder: workFolderName(videoPath),
    exists: existsSync,
  })
  mkdirSync(r.dir, { recursive: true })
  return r.dir
}

function send(win: BrowserWindow | null, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(DUB_PROGRESS_CHANNEL, payload)
}

/**
 * 파이썬 하나를 돌리고 끝날 때까지 기다린다.
 *
 * 진행 알림은 창으로 그대로 흘린다. 실패하면 **파이썬이 낸 사유를 그대로** 올린다 —
 * '실패했습니다' 로 뭉개면 어디가 막혔는지 알 수 없다.
 */
/**
 * 지금 도는 더빙 실행기. **멈추려면 붙잡고 있어야 한다**(2026-09-25).
 *
 * ★예전에는 실행기를 만들고 그대로 놓아 버려서, 시작한 작업을 멈출 방법이 없었다.
 *   앞단은 영상 길이만큼 도는 가장 긴 구간이고 GPU 를 문다.
 */
let activeRun: { runner: PythonRunner; tag: string; cancelling: boolean } | null = null

/** 사용자가 멈춘 것을 실패와 **구분해서** 알린다 — '실패' 로 뭉개면 겁을 준다. */
export class DubCancelled extends DubJobError {}

function runPython(
  pythonPath: string, script: string, args: string[], win: BrowserWindow | null, tag: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const runner = new PythonRunner(pythonPath)
    activeRun = { runner, tag, cancelling: false }
    let lastError = ''
    runner.on('progress', (d: unknown) => { send(win, { tag, kind: 'progress', data: d }) })
    runner.on('error', (m: unknown) => { lastError = String(m) })
    runner.on('done', (code: number, end?: { killedByUs?: boolean }) => {
      const stopped = !!activeRun?.cancelling || !!end?.killedByUs
      activeRun = null
      if (code === 0) resolve()
      else if (stopped) reject(new DubCancelled(`${tag} 을(를) 멈췄습니다`))
      else reject(new DubJobError(lastError || `${tag} 이(가) 코드 ${code} 로 끝났습니다`))
    })
    try {
      runner.run(PythonRunner.getScriptPath(script), args)
    } catch (e) {
      activeRun = null
      reject(e)
    }
  })
}

/** 더빙이 밖에 알려 주는 것 — 지금 **앞단·내보내기**가 도는가. */
export interface DubIpcAdapter {
  isRunning: () => boolean
}

/**
 * @param busyReason 다른 곳이 바쁜지 묻는다. **늦게 부른다** — 더빙이 먼저 등록되므로
 *   등록 시점에는 아직 상대가 없다.
 */
export function registerDubIpc(
  getWindow: () => BrowserWindow | null,
  getPython: () => string,
  busyReason: () => string | null = () => null,
  /**
   * 대화상자 시작 폴더의 기억 창구. **audio.ipc 와 같은 것**을 받는다 —
   * 통로를 둘로 만들면 한쪽이 기억한 것을 다른 쪽이 모른다.
   * 없으면(검사 등) 폴더를 정하지 않는다 — 없는 값을 지어내지 않는다.
   */
  folders?: FolderHost,
): DubIpcAdapter {
  const fh = folders
  // 지금 작업 중인 폴더. 화면이 매번 경로를 들고 다니지 않게 여기서 기억한다.
  let workDir: string | null = null
  let videoPath: string | null = null

  // ★더빙 앞단·내보내기는 **제 실행기를 새로 만든다**(아래 runPython).
  //   그래서 합성 쪽이 보는 공용 실행기에는 잡히지 않았고, 어느 방향으로도 판정을
  //   거치지 않았다 — 더빙이 도는 중에 합성을 눌러도, 그 반대로도 그냥 통과했다.
  //   감정 미리듣기가 낸 사고와 **똑같은 구조**다(2026-09-24 2차 감사).
  //
  //   줄 세우지 않고 **거절**한다: 더빙 시작은 사용자가 단추로 한 번 누르는 긴 GPU
  //   작업이라, 조용히 기다리게 하는 쪽이 더 나쁘다.
  const dubGuard = createPreviewGuard()

  /**
   * 시작해도 되는지 본다. **순서가 중요하다** — 남이 바쁜지 먼저 보고,
   * 그다음에 내 가드를 세운다. 순서를 뒤집으면 **제 자신을 보고 거절한다.**
   */
  function beginDubWork(): void {
    const why = busyReason()
    if (why) throw new DubJobError(why)
    dubGuard.begin()
  }

  ipcMain.handle('dub:pick-video', async (): Promise<DubReply<string | null>> => {
    const win = getWindow()
    const r = await dialog.showOpenDialog(win!, {
      title: '더빙할 영상 고르기',
      defaultPath: fh ? startDir(fh, 'video') : undefined,
      properties: ['openFile'],
      filters: [{ name: '영상', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] }],
    })
    if (r.canceled || r.filePaths.length === 0) return ok(null)
    if (fh) rememberFile(fh, 'video', r.filePaths[0])
    videoPath = r.filePaths[0]
    workDir = dubWorkDir(videoPath)
    return ok(videoPath)
  })

  ipcMain.handle('dub:run-front', async (
    _e, opts?: { language?: string; register?: string; force?: boolean },
  ): Promise<DubReply<DubFrontResult>> => {
    try {
      if (!videoPath || !workDir) throw new DubJobError('먼저 영상을 고르세요')
      // ★`beginDubWork()` 을 try **밖**에 둔다(2026-09-25 3차 감사에서 내가 낸 결함).
      //   안에 두고 아래 finally 로 풀면, **이미 더빙 중이라 거절당한 두 번째 요청이**
      //   **먼저 돌고 있는 작업의 가드를 풀어 버린다.** 그 순간 합성 쪽 판정이 더빙을
      //   못 보게 되어 파이썬 둘이 같은 GPU 를 문다 — 이번 회차에 고치려던 바로 그 사고다.
      //   `dub:render` 는 처음부터 이 모양이었다. 같은 파일 안에서 두 모양이 갈려 있었다.
      beginDubWork()
      return await runFrontGuarded(videoPath, workDir, opts)
    } catch (e) {
      return fail(e)
    }
  })

  /** 가드를 **세운 뒤에만** 도는 본체. 풀기는 여기서만 한다. */
  async function runFrontGuarded(
    video: string, work: string,
    opts?: { language?: string; register?: string; force?: boolean },
  ): Promise<DubReply<DubFrontResult>> {
    try {
      // 돌리기 전에 무엇이 끝나 있었는지 기억한다 - 끝나고 견주면 무엇을 실제로 했는지 알 수 있다.
      // ★무엇을 다시 할지는 여기서 정하지 않는다(파이썬의 몫). 여기서는 말해 주기만 한다.
      const before = opts?.force ? [] : readDoneStages(work)
      const args = ['--video', video, '--out', work]
      if (opts?.language) args.push('--language', opts.language)
      if (opts?.register) args.push('--register', opts.register)
      if (opts?.force) args.push('--force')
      await runPython(getPython(), 'dub_worker.py', args, getWindow(), '앞단')
      // ★파이썬이 줄 목록을 새로 썼을 수 있다 — 사람이 손본 번역문을 되씌운다.
      //   이것이 없으면 화면에는 고친 것이 보이는데 **영상에는 고치기 전 문장이 실린다.**
      reapplyKoreanEdits(work)
      const after = readDoneStages(work)
      return ok({
        ...readLines(work),
        skipped: before,
        ran: after.filter((s) => !before.includes(s)),
      })
    } catch (e) {
      return fail(e)
    } finally {
      dubGuard.end()
    }
  }

  // 영상 속 목소리를 그대로 참조로 쓴다 - 인물은 그대로 두고 언어만 바꾸는 길이다.
  // 갈라낸 보컬이 이미 있으므로 새로 만들 것이 없다.
  ipcMain.handle('dub:original-voice', async (): Promise<DubReply<string>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      const p = join(workDir, 'vocals.wav')
      if (!existsSync(p)) {
        throw new DubJobError('갈라낸 목소리가 없습니다 - 먼저 앞단을 끝내세요')
      }
      return ok(p)
    } catch (e) {
      return fail(e)
    }
  })

  /** 지금 새 작업이 쌓이는 자리. 화면이 사람에게 보여 준다. */
  ipcMain.handle('dub:work-root', async (): Promise<DubReply<string>> =>
    ok(workRootOf(chosenRoot(), defaultRoot())))

  /**
   * 작업 자리를 고른다.
   *
   * ★이미 쌓인 것을 **옮기지 않는다.** 535MB 를 옮기다 중간에 실패하면 작업을 잃는다.
   *   새 작업만 새 자리에 쌓이고, 옛 작업은 있던 자리에서 그대로 열린다.
   */
  ipcMain.handle('dub:set-work-root', async (): Promise<DubReply<string>> => {
    try {
      const win = getWindow()
      const r = await dialog.showOpenDialog(win!, {
        title: '만든 것을 둘 자리 고르기',
        defaultPath: workRootOf(chosenRoot(), defaultRoot()),
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || r.filePaths.length === 0) return ok(workRootOf(chosenRoot(), defaultRoot()))
      const picked = r.filePaths[0]
      // 판단은 shared 가 한다 — 여기서 규칙을 새로 만들지 않는다.
      const why = workRootBlockReason(picked, { exists: existsSync, appDir: app.getAppPath() })
      if (why) throw new DubJobError(why)
      const res = setSettingsKey(join(app.getPath('userData'), 'settings.json'),
                                 DUB_WORK_ROOT_KEY, picked, {})
      if (!res.ok) throw new DubJobError('자리를 기억하지 못했습니다 — 다시 시도해 주세요.')
      // 고른 뒤에는 지금 영상의 작업 폴더도 새 규칙으로 다시 정한다.
      if (videoPath) workDir = dubWorkDir(videoPath)
      return ok(picked)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('dub:load', async (): Promise<DubReply<DubFrontResult>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      return ok(readLines(workDir))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('dub:save-korean', async (
    _e, edits: Record<number, string>,
  ): Promise<DubReply<DubFrontResult>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      return ok(saveKoreanEdits(workDir, edits ?? {}))
    } catch (e) {
      return fail(e)
    }
  })

  // 화면이 **고치는 즉시** 부른다 — 저장 단추를 기다리지 않는다.
  // ★예전에는 저장 전까지 편집이 화면 안에만 있었다. 앱을 닫거나 영상을 바꾸면
  //   수십 줄이 한 번에 사라졌고, 그 자리에 경고도 없었다(2026-09-24 2차 감사).
  ipcMain.handle('dub:save-edits', async (
    _e, edits: Record<number, string>,
  ): Promise<DubReply<number>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      saveKoreanEditsSidecar(workDir, edits ?? {})
      return ok(Object.keys(edits ?? {}).length)
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 도는 작업을 멈춘다.
   *
   * ★줄 소리 합성은 여기로 오지 않는다 — 그쪽은 공용 실행기를 타므로 공용 취소가
   *   멈춘다. 통로를 잘못 고르면 단추는 눌리는데 아무것도 멈추지 않는다.
   */
  ipcMain.handle('dub:cancel', async (): Promise<DubReply<DubCancelOutcome>> => {
    const cur = activeRun
    if (!cur) return ok({ accepted: false, reason: 'NO_ACTIVE_JOB' })
    if (cur.cancelling) return ok({ accepted: false, reason: 'ALREADY_CANCELLING' })
    cur.cancelling = true
    try {
      const r = await cur.runner.cancel()
      // ★확인 못 한 것을 확인한 척하지 않는다 — 그 값을 그대로 올린다.
      return ok({ accepted: true, treeKillConfirmed: !!r.treeKillConfirmed })
    } catch {
      return ok({ accepted: true, treeKillConfirmed: false })
    }
  })

  ipcMain.handle('dub:render', async (
    _e, takes: Record<number, string>, destPath?: string,
  ): Promise<DubReply<DubRenderResult>> => {
    try {
      if (!videoPath || !workDir) throw new DubJobError('먼저 영상을 고르세요')
      if (!takes || Object.keys(takes).length === 0) {
        throw new DubJobError('줄마다 소리를 먼저 만드세요')
      }
      let dest = destPath
      if (!dest) {
        const win = getWindow()
        const r = await dialog.showSaveDialog(win!, {
          title: '더빙한 영상 저장',
          // ★파일 이름만 주면 **폴더는 여전히 운영체제가 정한다**(2026-09-25).
          //   제안 이름도 원본에서 만든다 — 고정 '더빙.mp4' 는 두 번째 영상이
          //   첫 번째를 덮어쓸 자리에 커서를 놓는다.
          defaultPath: fh
            ? saveTarget(fh, 'export', `${basename(videoPath, extname(videoPath))}_더빙.mp4`, join)
            : `${basename(videoPath, extname(videoPath))}_더빙.mp4`,
          filters: [{ name: '영상', extensions: ['mp4'] }],
        })
        if (r.canceled || !r.filePath) throw new DubJobError('저장을 취소했습니다')
        dest = r.filePath
        if (fh) rememberFile(fh, 'export', dest)
      }
      // 저장 자리를 고른 **뒤에** 가드를 세운다 — 대화상자에서 취소하면 세울 것이 없다.
      beginDubWork()
      try {
        const takesPath = writeTakesFile(workDir, takes)
        await runPython(getPython(), 'dub_render.py', [
          '--work', workDir, '--takes', takesPath, '--video', videoPath, '--dest', dest,
        ], getWindow(), '내보내기')
        return ok(readRenderReport(workDir))
      } finally {
        dubGuard.end()
      }
    } catch (e) {
      return fail(e)
    }
  })

  /**
   * 이미 만들어 둔 줄 소리를 되살린다.
   *
   * ★왜 생겼나 (2026-09-26 사용자 신고)
   *   줄 소리는 `takes/` 에 그대로 쌓여 있는데, 영상을 다시 고르거나 앱을 껐다 켜면
   *   화면이 목록을 비웠다. **되살리는 길이 아예 없었다.**
   *   그래서 6분짜리 합성을 매번 다시 해야 했다 — 파일은 옆에 있는데.
   */
  ipcMain.handle('dub:takes', async (): Promise<DubReply<Record<number, string>>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      const dir = join(workDir, 'takes')
      if (!existsSync(dir)) return ok({})
      const found: Record<number, string> = {}
      for (const name of readdirSync(dir)) {
        // `line-0007.wav` 처럼 저장한다(dub:keep-take 와 같은 규칙).
        const m = /^line-(\d+)\.wav$/i.exec(name)
        if (m) found[Number(m[1])] = join(dir, name)
      }
      return ok(found)
    } catch (e) {
      return fail(e)
    }
  })

  // 만든 소리를 작업 폴더 안 안전한 자리로 옮긴다.
  // 합성 결과가 생기는 자리는 다음 처리나 정리 때 사라질 수 있다 - 줄 소리는 사라지면 안 된다.
  ipcMain.handle('dub:keep-take', async (
    _e, srcPath: string, index: number,
  ): Promise<DubReply<string>> => {
    try {
      if (!workDir) throw new DubJobError('먼저 영상을 고르세요')
      if (!srcPath || !existsSync(srcPath)) throw new DubJobError('만든 소리를 찾지 못했습니다')
      const dir = join(workDir, 'takes')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const dest = join(dir, `line-${String(index).padStart(4, '0')}.wav`)
      copyFileSync(srcPath, dest)
      return ok(dest)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('dub:work-dir', async (): Promise<DubReply<string | null>> => ok(workDir))

  // 합성 쪽이 이 값을 보고 **더빙 중에는 시작하지 않는다.**
  // ★줄 소리 합성은 여기 포함되지 않는다 — 그쪽은 공용 실행기를 타므로 이미 보인다.
  //   포함하면 더빙이 제 합성 요청을 스스로 막는다.
  return { isRunning: () => dubGuard.running }
}
