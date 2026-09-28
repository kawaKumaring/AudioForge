/**
 * 앱 설정 통로 — **만든 것을 둘 자리**와 **쌓인 것 비우기.**
 *
 * ★지우는 일은 여기 한 곳에만 둔다 (2026-09-28)
 *   화면이 경로를 만들어 보내면, 언젠가 반드시 엉뚱한 자리를 지운다.
 *   화면은 **무엇을 비울지(갈래)만** 말하고, 어디인지는 본체가 정한다.
 *
 * ★연결(정션·심볼릭)은 지우지 않는다
 *   Node 의 `rmSync` 는 연결을 따라가지 않지만, 연결 자체를 지우면 그것이 가리키던
 *   공용 자산으로 가는 길이 사라진다. 이 세션에서 실제로 한 번 당했다.
 */
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'fs'
import { OUTPUT_ROOT_DIRNAME } from '../../shared/outputLayout'
import { ourTempNames, LEGACY_TEMP_ENV_KEY } from '../../shared/tempRoot'
import { readSettingsFile, setSettingsKey } from '../services/settings-store'
import { rememberDir, startDir, type FolderHost } from '../services/dialogFolders'
import { outputBase, realAppRoot } from '../services/appPaths'
import { currentBuildInfo } from './app-version.ipc'

export const OUTPUT_ROOT_KEY = 'outputRoot'
export const OUTPUT_BESIDE_KEY = 'outputBesideSource'

/** 작업 기록이 사는 열쇠들. 비울 때 이 목록만 본다 — 앱 설정은 건드리지 않는다. */
const WORK_KEYS = [
  'synthesisCards', 'labWorkspace', 'workDrafts',
  'dialogueDrafts', 'dialogueEdits', 'transcriptDrafts', 'transcriptEdits',
]

/** 중간 산출물 폴더들. 다시 만들어지는 것만 여기 둔다. */
const MEDIA_DIRS = ['cardmedia', 'refclips', 'lab-takes', 'joinPreview', 'voicePreview', 'emotion-sampler-cache']

/** Electron 이 스스로 만드는 캐시. 지워도 다음에 켤 때 다시 생긴다. */
const CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Shared Dictionary', 'blob_storage',
]

function settingsPath(): string { return join(app.getPath('userData'), 'settings.json') }

/**
 * 대화상자의 **시작 폴더 기억**. 규칙은 `services/dialogFolders` 가 갖는다.
 *
 * ★시작 폴더를 주지 않으면 어디서 열릴지 우리가 정하지 못한다 —
 *   다른 툴을 쓰다 오면 엉뚱한 자리에서 열린다(검사가 이것을 잡는다).
 */
const folderHost: FolderHost = {
  read: (key) => {
    const got = readSettingsFile(settingsPath())
    return got.kind === 'ok' ? (got.settings as Record<string, unknown>)[key] : undefined
  },
  write: (key, value) => { setSettingsKey(settingsPath(), key, value, { writtenBy: currentBuildInfo().version }) },
  // ★기억해 둔 것이 없으면 **앱의 결과 자리**에서 연다 (2026-09-28).
  //   예전에는 사용자 음악 폴더(시스템 드라이브)에서 열렸다 — 자리를 고르는 화면이
  //   C 드라이브에서 시작하면 거기를 고르게 된다. 사용자는 그것을 원한 적이 없다.
  fallback: () => { try { return join(appRootPath(), OUTPUT_ROOT_DIRNAME) } catch { return undefined } },
}
/**
 * ★두 자리는 **다른 질문**이다 (2026-09-28 에 하나로 뭉쳐 있던 것을 갈랐다).
 *   · 결과를 쌓는 뿌리 — 검사는 자기 격리 자리로 간다
 *   · 앱이 실제로 깔린 자리 — "여기에는 두지 마세요" 판정은 늘 이쪽이다
 *   규칙은 `services/appPaths` 하나가 갖는다.
 */
function appRootPath(): string { return outputBase(__dirname, process.env) }
function installedAppRoot(): string { return realAppRoot(__dirname) }

function readOne(key: string): unknown {
  try {
    const got = readSettingsFile(settingsPath())
    return got.kind === 'ok' ? (got.settings as Record<string, unknown>)[key] : undefined
  } catch { return undefined }
}

function writeOne(key: string, value: unknown): boolean {
  const r = setSettingsKey(settingsPath(), key, value, { writtenBy: currentBuildInfo().version })
  return r.ok
}

/** 이 폴더가 실제로 차지하는 크기(바이트). 연결은 세지 않는다. */
function sizeOf(p: string): number {
  let st
  try { st = lstatSync(p) } catch { return 0 }
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let n = 0
  for (const e of readdirSync(p)) n += sizeOf(join(p, e))
  return n
}

/**
 * 폴더 하나를 비운다. **연결이면 건드리지 않는다.**
 * 돌려주는 것: 지운 개수와 바이트.
 */
function wipeDir(p: string): { removed: number; freed: number } {
  let st
  try { st = lstatSync(p) } catch { return { removed: 0, freed: 0 } }
  if (st.isSymbolicLink()) return { removed: 0, freed: 0 }
  const freed = sizeOf(p)
  try { rmSync(p, { recursive: true, force: true }) } catch { return { removed: 0, freed: 0 } }
  return { removed: 1, freed }
}

/**
 * 옛 임시 자리(시스템 드라이브)에 남은 **우리 것만** 고른다.
 *
 * ★자리를 옮기기 전에 쌓인 것은 스스로 사라지지 않는다. 실측 2026-09-28 에
 *   시스템 임시 폴더에서 우리 이름 275개가 나왔다.
 * ★이름 접두로만 고른다 — 남의 파일은 개수조차 세지 않는다.
 */
function strayTempEntries(): string[] {
  const old = process.env[LEGACY_TEMP_ENV_KEY]
  if (!old || old === tmpdir()) return []        // 안 옮겼으면 치울 옛 자리도 없다
  return ourTempNames(readDirNames(old)).map((n) => join(old, n))
}

function readDirNames(p: string): string[] {
  try { return readdirSync(p) } catch { return [] }
}

export function registerOptionsIpc(): void {
  ipcMain.handle('options:get', () => ({
    chosenRoot: typeof readOne(OUTPUT_ROOT_KEY) === 'string' ? readOne(OUTPUT_ROOT_KEY) as string : '',
    beside: readOne(OUTPUT_BESIDE_KEY) === true,
    appRoot: appRootPath(),
    dataDir: app.getPath('userData'),
    // 임시 자리 — 앱 안이어야 한다. 화면이 이것을 보여 주므로 조용히 새면 눈에 띈다.
    tempDir: tmpdir(),
    // 옛 자리에 남아 있는 **우리 잔해 개수.** 0 이면 비우기 줄을 감춘다.
    strayTemp: strayTempEntries().length,
  }))

  ipcMain.handle('options:set', (_e, next: { chosenRoot?: string; beside?: boolean }) => {
    if (typeof next?.chosenRoot === 'string') {
      writeOne(OUTPUT_ROOT_KEY, next.chosenRoot.trim() || undefined)
    }
    if (typeof next?.beside === 'boolean') writeOne(OUTPUT_BESIDE_KEY, next.beside || undefined)
    return {
      chosenRoot: typeof readOne(OUTPUT_ROOT_KEY) === 'string' ? readOne(OUTPUT_ROOT_KEY) as string : '',
      beside: readOne(OUTPUT_BESIDE_KEY) === true,
      appRoot: appRootPath(),
    }
  })

  /**
   * 결과물을 둘 폴더를 고른다.
   * ★앱이 도는 자리 안은 막는다 — 앱을 지울 때 작업도 함께 사라진다.
   *   기본값(앱 자리)과 다른 이야기다. 기본은 앱이 책임지는 자리이고,
   *   여기서 고르는 것은 **사용자가 오래 두려는 자리**다.
   */
  ipcMain.handle('options:pick-root', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    // ★시작 폴더를 **호출 자리에서** 준다. 검사가 이 자리를 글자로 확인한다 —
    //   변수로 빼 두면 사람이 읽을 때도 "어디서 열리지?" 를 한 번 더 찾아가야 한다.
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: startDir(folderHost, 'export') })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: startDir(folderHost, 'export') })
    if (r.canceled || !r.filePaths[0]) return null
    const picked = r.filePaths[0]
    const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (norm(picked).startsWith(norm(installedAppRoot()))) {
      return { error: '앱이 있는 자리에는 둘 수 없습니다 — 앱을 지울 때 함께 사라집니다.' }
    }
    if (!existsSync(picked)) return { error: '그 폴더가 없습니다.' }
    rememberDir(folderHost, 'export', picked)      // 다음에 여기서 열린다
    return { path: picked }
  })

  /**
   * 쌓인 것을 비운다. 화면은 **갈래만** 말하고 자리는 여기서 정한다.
   *  · cache — Electron 이 스스로 만드는 것. 다시 생긴다.
   *  · media — 꺼낸 소리·참조 클립·미리듣기. 다시 만들어진다.
   *  · works — 작업 기록. ★만든 소리 파일은 건드리지 않는다.
   */
  ipcMain.handle('options:wipe', (_e, kind: string) => {
    const base = app.getPath('userData')
    let removed = 0
    let freed = 0

    if (kind === 'cache' || kind === 'media') {
      for (const name of kind === 'cache' ? CACHE_DIRS : MEDIA_DIRS) {
        const r = wipeDir(join(base, name))
        removed += r.removed; freed += r.freed
      }
      // ★자리를 옮기기 전에 옛 임시 폴더에 쌓인 우리 것도 함께 치운다 (2026-09-28).
      //   우리 이름으로 시작하는 것만이다 — 남의 파일은 손대지 않는다.
      if (kind === 'media') {
        for (const full of strayTempEntries()) {
          const r = wipeDir(full)
          removed += r.removed; freed += r.freed
        }
      }
    } else if (kind === 'works') {
      // ★기록만 지운다. 결과 폴더(`AudioForge_output`)는 이름조차 여기 나오지 않는다.
      for (const key of WORK_KEYS) {
        if (readOne(key) === undefined) continue
        if (writeOne(key, undefined)) removed += 1
      }
    } else {
      return { removed: 0, freedMb: 0, error: '알 수 없는 갈래입니다.' }
    }
    return { removed, freedMb: Math.round(freed / 1048576) }
  })

  /** 결과가 쌓이는 자리를 연다. 없으면 만들지 않고 없다고 말한다. */
  ipcMain.handle('options:output-root', () => {
    const chosen = typeof readOne(OUTPUT_ROOT_KEY) === 'string' ? readOne(OUTPUT_ROOT_KEY) as string : ''
    const root = join(chosen.trim() || appRootPath(), OUTPUT_ROOT_DIRNAME)
    return { root, exists: existsSync(root) }
  })

  void dirname; void statSync
}
