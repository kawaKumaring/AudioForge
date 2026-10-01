import { app, BrowserWindow, protocol, net, session } from 'electron'
import { applyOfflineEnv, isLocalUrl } from '../shared/offlinePolicy'
import { join } from 'path'
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { statSync, mkdirSync, copyFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { registerAudioIpc, dialogFolderHost } from './ipc/audio.ipc'
import { registerAppVersionIpc, currentBuildInfo } from './ipc/app-version.ipc'
import { registerOptionsIpc } from './ipc/options.ipc'
import { registerWorksIpc } from './ipc/works.ipc'
import { registerReaderIpc } from './ipc/reader.ipc'
import { registerConsoleIpc } from './ipc/console.ipc'
import { registerSelfCheckIpc } from './ipc/selfcheck.ipc'
import { registerConsoleWindowIpc } from './ipc/console-window.ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics.ipc'
import { registerDubIpc } from './ipc/dub.ipc'
import { registerSongIpc } from './ipc/song.ipc'
import { registerDialogueIpc } from './ipc/dialogue.ipc'
import { registerPitchIpc } from './ipc/pitch.ipc'
import { registerCardMediaIpc } from './ipc/card-media.ipc'
import { createAppLog, mirrorConsole, setAppLog, watchUncaught, LOG_DIR_NAME } from './services/app-log'
import { seedDevUserData, userDataDirNameFor, USER_DATA_DIR_STABLE, type SeedResult } from './services/user-data-channel'
import { warmUpBridge, type WarmupHandle } from './services/bridge-warmup'
/** 배경 데우기 손잡이 — 종료 때 멈추려면 붙들고 있어야 한다. */
let warmupHandle: WarmupHandle | null = null
import { channelForVersion } from '../shared/buildMetadata'
import { planTempRoot, redirectTemp, LEGACY_TEMP_ENV_KEY } from '../shared/tempRoot'
import { readSettingsFile, readSettingsMeta, SETTINGS_FORMAT_VERSION } from './services/settings-store'
import { basename, dirname } from 'path'
import { disposeAnalysisIpc, registerAnalysisIpc } from './ipc/analysis.ipc'
import { currentPythonPath } from './ipc/audio.ipc'
import { registerReferenceLibraryIpc } from './ipc/reference-library.ipc'
import { createReferenceStore } from './services/reference-store'
import { createTranscriptStore } from './services/reference-transcript'
import {
  buildLibraryEntry, emptyManifest, assertManifestValid, promoteReferenceClip,
  normalizeTranscript, sha256HexOfString,
  removeManifestRecord, findManifestRecordByClipId, verifyStoredClip, clipFileName,
  runScopedStagingDirName, runJournalFileName, manifestTempFileName,
  MANIFEST_FILE_NAME, REFERENCE_LIBRARY_DIR_NAME, REFERENCE_STAGING_DIR_NAME,
} from '../shared/referenceLibrary'
import { inspectWavContainer, wavSamplesAreFinite } from '../shared/wavContainer'
import { createSamplerCache, SAMPLER_CACHE_DIR_NAME } from './services/sampler-cache'
import { registerSamplerIpc, resolveSamplerPreviewPath } from './ipc/sampler.ipc'
import type { SamplerCache } from './services/sampler-cache'
import {
  buildEmotionSampleScript, buildEmotionSampleCacheKey, capabilityForRow, isCapabilityUsable,
  emotionSampleExpressionFromTimeline, EMOTION_SAMPLER_DEFAULT_CONFIG,
} from '../shared/emotionSampler'
import { parseExpressiveTimeline } from '../shared/expressiveTimeline'
import { applyOffscreenSwitches, keepOffscreen, offscreenWindowOptions } from './services/offscreen'

let mainWindow: BrowserWindow | null = null
// 프로토콜 핸들러가 키를 경로로 바꿀 때 쓴다. 창 생성 시 채워진다.
let samplerCache: SamplerCache | null = null

// E2E 격리 — AF_E2E=1 에서만 userData 를 임시 폴더로 돌린다.
// 사용자의 실제 참조 라이브러리·샘플 캐시를 테스트가 건드리지 않게 하기 위한 게이트이며,
// production 실행에서는 이 분기가 동작하지 않는다.
if (process.env.AF_E2E === '1' && process.env.AF_E2E_USER_DATA) {
  try { app.setPath('userData', process.env.AF_E2E_USER_DATA) } catch { /* noop */ }
}

// ── 채널별 사용자 데이터 폴더 ─────────────────────────────────────────────────
// 개발선(-dev)은 옆의 audio-forge-dev 를 쓴다. 정식·RC 는 바뀌는 것이 없다. 개발선 폴더가 처음이면
// 정식 폴더의 앱 데이터만 한 번 복사한다(원본은 읽기만, Electron 캐시는 옮기지 않는다).
// E2E 는 AF_E2E_USER_DATA(폴더 직접 지정)가 우선이고, AF_E2E_USER_DATA_BASE 는 이 분기를 검사할 때 부모를 바꾼다.
// app.getVersion() 은 package.json 을 못 찾는 실행(electron out/main/index.js)에서 Electron 판을 돌려준다 —
// 그래서 판의 권위는 currentBuildInfo()(pickAppVersion) 하나로 둔다.
/**
 * 옛 자리 — **이름으로 짚는다.** 설정 한 장을 가져올 때만 쓴다.
 *
 * ★`app.getPath('userData')` 를 그대로 쓰면 안 된다. 개발 실행(`electron out/main/index.js`)은
 *   앱 이름을 모르는 채 뜨므로 그 값이 `Roaming/Electron` 이다 — 사용자의 설정이 있는
 *   `Roaming/audio-forge` 가 아니다. 실측으로 엉뚱한 파일을 가져오는 것을 확인했다(2026-09-28).
 */
const legacyUserDataBase = app.getPath('appData')
const USER_DATA_CHANNEL = channelForVersion(currentBuildInfo().version)
const USER_DATA_DIR_NAME = userDataDirNameFor(USER_DATA_CHANNEL)
let userDataSeed: SeedResult | null = null
if (!(process.env.AF_E2E === '1' && process.env.AF_E2E_USER_DATA)) {
  // 검사가 부모 폴더를 준 경우에는 **정식 채널도** 그 아래를 쓴다. 그러지 않으면 정식 판을 확인하는 검사가
  // 실제 사용자 폴더에 로그를 쓰게 된다 — 검사는 사용자 자산을 건드리지 않는다.
  const e2eBase = (process.env.AF_E2E === '1' && process.env.AF_E2E_USER_DATA_BASE)
    ? process.env.AF_E2E_USER_DATA_BASE : null
  const base = e2eBase ?? dirname(app.getPath('userData'))
  const targetDir = join(base, USER_DATA_DIR_NAME)
  if (USER_DATA_DIR_NAME !== USER_DATA_DIR_STABLE) {
    try { userDataSeed = seedDevUserData({ from: join(base, USER_DATA_DIR_STABLE), to: targetDir }) } catch { userDataSeed = null }
    try { app.setPath('userData', targetDir) } catch { /* 실패하면 기본 폴더 그대로 — boot 기록에 실제 이름이 남는다 */ }
  } else if (e2eBase) {
    // 정식 채널은 **옮기는 것이 없다**(복사도 없다). 검사 격리를 위해 자리만 바꾼다.
    try { app.setPath('userData', targetDir) } catch { /* 같음 */ }
  }
}


// ── 앱이 도는 자리 안에 데이터를 둔다 (2026-09-28 지시) ─────────────────────
//
// ★왜 (사용자 지시): "C드라이브에 있는 파일들은 전부 삭제할것이고 구성을 개발툴
//   내부에 셋팅되도록 구성한다." 예전에는 윈도우가 정한 자리(시스템 드라이브)에
//   설정·꺼낸 소리·참조 클립·미리듣기·로그가 모두 쌓였다. 사용자는 그것을 고른 적이 없다.
//
// ★한 줄로 옮기는 이유: 자리를 쓰는 곳이 여덟 군데다. 각자 고치면 반드시 하나를 빠뜨린다.
//   Electron 의 userData 자체를 옮기면 그 여덟이 **자동으로 따라온다.**
//
// ★맞바꿈: 앱 폴더를 지우면 데이터도 함께 사라진다. 그래서 산출물과 달리 이 자리는
//   앱이 관리하는 것만 둔다 — 사용자가 만든 결과는 `AudioForge_output` 이 따로 갖는다.
//
// 검사 격리(AF_E2E_USER_DATA)가 가장 세다 — 검사는 사용자 자산을 건드리지 않는다.
const APP_ROOT = join(__dirname, '..', '..')
const APP_DATA_ROOT = join(APP_ROOT, 'AudioForge_data')
/**
 * 검사가 자리를 **직접 짚었으면 그대로 둔다.**
 *
 * ★두 가지를 모두 봐야 한다 (2026-09-28 에 하나를 빠뜨려 검사가 울었다)
 *   · `AF_E2E_USER_DATA`      — 폴더를 콕 집는다
 *   · `AF_E2E_USER_DATA_BASE` — 부모만 주고 채널 분기를 확인한다
 *   뒤엣것을 무시하면 채널 분기를 보는 검사가 **앱 폴더로 끌려와** 아무것도 확인하지
 *   못한다. 검사 격리가 앱 정리보다 세다 — 검사는 사용자 자산을 건드리지 않는다.
 */
const e2ePinnedUserData = process.env.AF_E2E === '1'
  && !!(process.env.AF_E2E_USER_DATA || process.env.AF_E2E_USER_DATA_BASE)
if (!e2ePinnedUserData) {
  const target = join(APP_DATA_ROOT, USER_DATA_DIR_NAME)
  try {
    mkdirSync(target, { recursive: true })
    // 옛 자리의 **설정 한 장만** 가져온다. 캐시·중간 산출물은 가져오지 않는다
    // (지시: "필요한 파일만 옴기고 생성으로 만들어진 파일들은 전부 제거").
    const oldSettings = join(legacyUserDataBase, USER_DATA_DIR_NAME, 'settings.json')
    const newSettings = join(target, 'settings.json')
    if (existsSync(oldSettings) && !existsSync(newSettings)) {
      copyFileSync(oldSettings, newSettings)
    }
    app.setPath('userData', target)
  } catch { /* 못 옮기면 있던 자리 그대로 — 조용히 실패하지 않게 아래 기록에 남는다 */ }
}
// ── 임시 자리도 앱 안으로 (2026-09-28 지시) ─────────────────────────────────
//
// ★왜 (사용자 지시): "가장 중요한건 6번이다. C 드라이브로 가지 않아야한다."
//   데이터는 위에서 옮겼지만 **임시 파일은 그대로 시스템 드라이브**에 쌓이고 있었다.
//   본체가 만드는 설정 JSON 15자리, 파이썬이 만드는 중간 폴더(음원 분리는 기가 단위),
//   검사 격리 폴더까지. 사용자가 고른 적 없는 자리다.
//
// ★한 줄로 막는 이유 (실측): `os.tmpdir()` 은 **부를 때마다** TEMP/TMP 를 다시 읽고,
//   파이썬 자식은 `...process.env` 를 그대로 물려받는다. 그래서 여기 한 번이면
//   본체·파이썬이 함께 따라온다. 75자리를 각각 고치면 반드시 하나를 빠뜨린다.
//
// ★userData 가 정해진 **뒤**여야 한다 — 임시 자리는 데이터 자리 아래다.
//   그리고 tmpdir() 을 쓰는 어떤 코드보다 **앞**이어야 한다(아래 등록들보다 위).
const LEGACY_TEMP = tmpdir()
{
  const target = planTempRoot(app.getPath('userData'))
  try {
    mkdirSync(target, { recursive: true })
    // 옛 자리는 적어 둔다 — 거기 남은 우리 잔해를 설정에서 비울 때 쓴다.
    process.env[LEGACY_TEMP_ENV_KEY] = LEGACY_TEMP
    redirectTemp(target, process.env)
    app.setPath('temp', target)          // Electron 자신이 쓰는 자리도 함께
  } catch { /* 못 만들면 옛 자리 그대로 — 아래 boot 기록에 실제 자리가 남는다 */ }
}

// ★외부 전송 금지 — 모든 파이썬 자식이 물려받을 오프라인 설정을 **한 곳에서** 켠다(2026-09-30).
//   예전에는 작업자마다 따로 켜서 노래 변환기처럼 빠진 곳이 실행마다 허깅페이스에 확인 요청을 보냈다.
const OFFLINE_CHANGED = applyOfflineEnv(process.env)

// ── 앱 로그 파일 — <userData>/logs/audioforge-<날짜>.log ─────────────────────────
// userData 가 정해진 직후, 다른 어떤 것보다 먼저 만든다. 그래야 기동 중 오류도 파일에 남는다.
// console.warn/error 는 그대로 나가면서 파일에도 적히고(터미널·E2E 수집 유지), 잡히지 않은 예외는
// monitor 로만 본다(Electron 의 오류 대화상자를 없애지 않는다). 대사·전사 본문·음원 경로는 적지 않는다.
const APP_LOG = createAppLog({ dir: join(app.getPath('userData'), LOG_DIR_NAME) })
setAppLog(APP_LOG)
mirrorConsole(APP_LOG)
watchUncaught(APP_LOG)

// 개발 경로(`npm run dev`) 자동 검증용 디버깅 포트.
// 사용자가 실제로 쓰는 실행은 `run.bat -> af-launch.mjs -> npm run dev` 이고, 그 경로에만
// React 개발 빌드의 StrictMode 이중 effect 가 있다. production 번들을 띄우는 기존 E2E 는
// 그 조건을 재현하지 못해 실제 결함을 놓쳤다. 그 경로를 붙잡으려면 이미 떠 있는 Electron 에
// 붙어야 하므로 여기서 포트를 연다 — **AF_E2E=1 이고 포트가 명시됐을 때만**.
// 개발툴 MCP·검사 — 화면 밖 창도 그리게(두 스위치가 모두 켜졌을 때만. services/offscreen).
applyOffscreenSwitches(app)
if (process.env.AF_E2E === '1' && /^\d+$/.test(process.env.AF_E2E_CDP_PORT ?? '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.AF_E2E_CDP_PORT as string)
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

// ── 선택된 참조 — 논리 ID 하나만 앱 소유 위치에 남긴다(절대 경로 저장 금지) ──
// 앱의 다른 설정(settings.json)과 파일을 나누어 동시 쓰기 충돌을 피한다.
function selectionFilePath(): string {
  return join(app.getPath('userData'), REFERENCE_LIBRARY_DIR_NAME, 'selection.json')
}

function readSelectedReferenceId(): string | null {
  try {
    const raw = JSON.parse(readFileSync(selectionFilePath(), 'utf-8')) as { referenceId?: unknown }
    const id = String(raw?.referenceId ?? '').trim().toLowerCase()
    return /^[0-9a-f]{16}$/.test(id) ? id : null
  } catch {
    return null   // 없음·손상은 '선택 없음'이다. 다른 참조로 대신 고르지 않는다.
  }
}

function writeSelectedReferenceId(referenceId: string | null): void {
  const p = selectionFilePath()
  try {
    if (referenceId === null) {
      if (existsSync(p)) rmSync(p, { force: true })
      return
    }
    writeFileSync(p, JSON.stringify({ referenceId }), 'utf-8')
  } catch {
    // 저장 실패를 성공으로 보고하지 않는다 — 다음 조회에서 '선택 없음'으로 드러난다.
  }
}

function createWindow(): void {
  const preloadPath = join(__dirname, '../preload/index.js')
  console.log(`[main] preload: ${preloadPath} · exists=${existsSync(preloadPath)}`)
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#a0a0b0',
      height: 36
    },
    backgroundColor: '#0a0a0f',
    // ★검사로 띄운 창이 **사람이 하던 일을 빼앗지 않게** 한다(2026-09-27 사용자 요청).
    //   검사는 자주·오래 돌고 그때마다 창이 앞으로 튀어나오면 다른 작업을 할 수 없다.
    //   그래서 검사에서는 창을 만들 때 감춰 두었다가 **활성화하지 않고** 보여 준다.
    //   보통 실행은 지금까지와 똑같다 — 만들자마자 보이고 앞으로 나온다.
    ...(process.env.AF_E2E === '1' ? { show: false } : {}),
    ...offscreenWindowOptions(),
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      // ★맞춤법 검사기를 끈다 — 켜 두면 크롬이 구글 서버에서 사전을 스스로 내려받는다(앱 데이터에 ko-3-0.bdic).
      spellcheck: false,
    }
  })
  if (process.env.AF_E2E === '1') {
    // showInactive: 창은 보이되 포커스를 가져오지 않는다(화면 캡처·클릭은 그대로 된다).
    mainWindow.once('ready-to-show', () => { try { mainWindow?.showInactive() } catch { /* 이미 닫혔다 */ } })
    // ★검사·개발툴 MCP 는 **소리를 내지 않는다** (2026-10-01 사용자 요청: "테스트를 할 때는 무음으로").
    //   창의 소리 출력만 끈다 — 재생 자체(시각이 흐르고, 끝나면 다음으로 넘어가고, 음량·빠르기 값)는 그대로라 검사가 보는 것은 같다.
    //   들어야 하는 검사만 AF_E2E_AUDIBLE=1 로 켠다.
    if (process.env.AF_E2E_AUDIBLE !== '1') mainWindow.webContents.setAudioMuted(true)
  }
  keepOffscreen(mainWindow)

  // ── Electron 진단 로그 — 검은 화면/크래시 원인 규명용(stdout으로 E2E·터미널이 수집) ──
  const wc = mainWindow.webContents
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main][did-fail-load] code=${code} desc=${desc} url=${url}`)
  })
  wc.on('preload-error', (_e, path, error) => {
    console.error(`[main][preload-error] ${path}: ${error?.stack || error}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[main][render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  wc.on('unresponsive', () => console.error('[main][unresponsive] renderer 응답 없음'))
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // renderer의 console + 아래 preload에서 잡은 pageerror가 여기로 올라온다
    if (level >= 2) console.error(`[main][renderer-console:${level}] ${message} (${sourceId}:${line})`)
  })

  // Prevent Electron from navigating when files are dropped
  wc.on('will-navigate', (e) => e.preventDefault())

  registerAppVersionIpc()
  // 생성 카드가 영상을 받았을 때 소리를 꺼내는 통로(카드별 폴더만 소유한다).
  registerCardMediaIpc()
  registerOptionsIpc()
  registerWorksIpc()
  registerReaderIpc()
  // 콘솔 창 — 앱 로그의 최근 줄을 보여 주고 화면의 동작 기록을 받는다(2026-09-30).
  registerConsoleIpc()
  // 기능 검사 — 설정의 기능 검사 탭에서 기능별로 누른다(2026-09-30).
  registerSelfCheckIpc()
  // 콘솔 창 — 앱 밖에 따로 뜬다. 켜 두었으면 앱 창이 뜰 때 함께 연다(2026-09-30 피드백).
  registerConsoleWindowIpc(mainWindow, preloadPath)
  // 진단 묶음 — 로그 복사본 + 설정의 모양(값 없음). 시작 화면의 단추가 부른다.
  registerDiagnosticsIpc(() => mainWindow, () => currentPythonPath())
  // ★양쪽이 서로를 본다(2026-09-24 2차 감사). 더빙은 제 실행기를 따로 만들어서
  //   공용 판정에 잡히지 않았고, 반대로 더빙도 다른 작업을 보지 않고 시작했다.
  //   등록 순서상 더빙이 먼저이므로, 더빙에는 **늦게 부르는 함수**를 넘기고
  //   더빙이 돌려준 것을 합성 쪽이 받는다.
  const dubAdapter = registerDubIpc(
    () => mainWindow, () => currentPythonPath(),
    () => previewAdapter?.busyReason() ?? (songAdapter?.isRunning() ? '노래를 변환하는 중입니다' : null),
    // 대화상자 시작 폴더는 audio.ipc 가 소유한 **같은 기억**을 쓴다.
    dialogFolderHost())
  // ★노래 변환도 **같은 판정에 참여한다.** 바깥 변환기(seed-vc)가 GPU 를 물기 때문에
  //   한쪽만 모르면 파이썬 둘이 같은 GPU 를 문다 — 더빙이 데인 것과 같은 구조다.
  registerDialogueIpc()
  const songAdapter = registerSongIpc(
    () => mainWindow, () => currentPythonPath(),
    () => previewAdapter?.busyReason() ?? (dubAdapter.isRunning() ? '영상 더빙 중입니다' : null),
    // 대화상자 시작 폴더는 audio.ipc·더빙이 쓰는 **같은 기억**을 쓴다.
    dialogFolderHost())
  const previewAdapter = registerAudioIpc(mainWindow,
    () => dubAdapter.isRunning() || songAdapter.isRunning())
  // 입력 분석 — GPU 를 쓰지 않는 상주 CPU worker. audio.ipc 와 같은 인터프리터를 쓴다.
  registerAnalysisIpc({ pythonPath: currentPythonPath })
  registerPitchIpc(() => currentPythonPath())

  // 참조 라이브러리 — 저장 루트·선택 상태는 앱 소유 userData 안에만 둔다.
  // 파이썬 실행은 audio.ipc 가 만든 adapter 를 그대로 쓴다(같은 pythonPath·타임아웃·정리).
  const referenceStore = createReferenceStore(
      {
        emptyManifest, assertManifestValid, promoteReferenceClip, removeManifestRecord,
        findManifestRecordByClipId, verifyStoredClip, clipFileName,
        runScopedStagingDirName, runJournalFileName, manifestTempFileName,
        manifestFileName: MANIFEST_FILE_NAME,
        stagingDirName: REFERENCE_STAGING_DIR_NAME,
        inspectWavContainer, wavSamplesAreFinite,
      },
      join(app.getPath('userData'), REFERENCE_LIBRARY_DIR_NAME),
      // 실제 ref_text 는 sidecar 가 유일한 durable 권위다. 정규화·해시는 계약 함수를 그대로 쓴다.
      createTranscriptStore(
        { normalizeTranscript, sha256HexOfString },
        join(app.getPath('userData'), REFERENCE_LIBRARY_DIR_NAME),
      ),
  )

  registerReferenceLibraryIpc({
    store: referenceStore,
    preview: previewAdapter.reference,
    readSelectedId: () => readSelectedReferenceId(),
    writeSelectedId: (id) => writeSelectedReferenceId(id),
    isReadableFile: (p) => { try { return statSync(p).isFile() } catch { return false } },
    sha256OfFile: (p) => {
      try {
        const hash = createHash('sha256')
        const fd = openSync(p, 'r')
        try {
          const buf = Buffer.alloc(1024 * 1024)
          for (;;) {
            const read = readSync(fd, buf, 0, buf.length, null)
            if (read <= 0) break
            hash.update(buf.subarray(0, read))
          }
        } finally {
          closeSync(fd)
        }
        return hash.digest('hex')
      } catch {
        return null
      }
    },
    readFileBytes: (p) => readFileSync(p),
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'audioforge_reflib_')),
    removeTempDir: (d) => { try { rmSync(d, { recursive: true, force: true }) } catch { /* noop */ } },
    joinPath: (...parts) => join(...parts),
    buildLibraryEntry,
    makeRunId: () => randomUUID().replace(/-/g, '').slice(0, 16),
  })

  // 감정 샘플러 — 캐시 루트는 참조 라이브러리와 분리된 앱 소유 디렉터리다.
  samplerCache = createSamplerCache(
    { inspectWavContainer, wavSamplesAreFinite },
    join(app.getPath('userData'), SAMPLER_CACHE_DIR_NAME),
  )
  registerSamplerIpc({
    cache: samplerCache,
    // AF_E2E=1 에서만 가짜 실행 결과를 주입할 수 있다(기존 __afCleanupFailCount 선례와 같은 게이트).
    // production 경로는 언제나 기존 TTS 실행이며, 이 분기는 개발 빌드 밖에서 동작하지 않는다.
    runner: {
      run: async (job) => {
        if (process.env.AF_E2E === '1') {
          const g = globalThis as { __afSamplerFake?: string; __afSamplerRuns?: number }
          g.__afSamplerRuns = (g.__afSamplerRuns ?? 0) + 1
          const mode = g.__afSamplerFake
          if (mode === 'error') return { kind: 'error' as const }
          if (mode === 'cancelled') return { kind: 'cancelled' as const }
          if (mode === 'limit') return { kind: 'limit' as const }
          if (mode === 'no-result') return { kind: 'no-result' as const }
          if (mode === 'silent' || mode === 'success') {
            const frames = 24000
            const data = frames * 2
            const buf = Buffer.alloc(44 + data)
            buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8)
            buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
            buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
            buf.write('data', 36); buf.writeUInt32LE(data, 40)
            if (mode === 'success') {
              for (let i = 0; i < frames; i++) buf.writeInt16LE(i % 2 ? 9000 : -9000, 44 + i * 2)
            }
            const out = join(job.stagingDir, 'synthesized.wav')
            writeFileSync(out, buf)
            return { kind: 'success' as const, outputPath: out }
          }
        }
        return previewAdapter.runSamplerTts(job)
      },
    },
    requestDeps: {
      referenceStore,
      buildEmotionSampleScript,
      parseExpressiveTimeline: (script, opts) => parseExpressiveTimeline(script, opts as never),
      emotionSampleExpressionFromTimeline,
      buildEmotionSampleCacheKey,
      capabilityForRow,
      isCapabilityUsable,
    },
    settings: () => ({
      engineId: 'qwen',
      modelId: 'qwen3-omni-flash',
      config: { ...EMOTION_SAMPLER_DEFAULT_CONFIG },
    }),
    readSelectedReferenceId,
    busyReason: previewAdapter.busyReason,
    makeRunId: () => randomUUID().replace(/-/g, '').slice(0, 8),
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register local-file protocol for serving audio files
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
])

// 단일 인스턴스 — 사용자가 관찰한 '여러 AudioForge 인스턴스' 혼란을 방지(방어적; 검은 화면의
// 근본 원인은 아님). 락을 못 얻으면 즉시 종료하고, 기존 인스턴스는 두 번째 실행 시 창을 복원/포커스.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // ★맞춤법 검사기를 **세션에서** 끈다 — 창마다 끄는 것으로는 부족했다. 세션이 켜진 채(한국어)로 떠서
    //   크롬이 구글 서버에서 사전(ko-3-0.bdic)을 스스로 내려받았고, 이 내려받기는 아래 요청 차단 창구를
    //   **거치지 않았다**(실측: 막은 기록 0건). 받는 주소도 이 컴퓨터 안의 빈 자리로 돌린다.
    try {
      session.defaultSession.setSpellCheckerEnabled(false)
      session.defaultSession.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')
    } catch { /* 이 판의 Electron 에 없으면 아래 요청 차단이 남는다 */ }
    // ★외부 전송 금지 — 이 컴퓨터 밖으로 가는 웹 요청은 막고 기록한다(2026-09-30).
    //   화면·본체(net)의 요청이 이 창구를 지난다. ★맞춤법 사전 내려받기는 지나지 않았다(실측) — 그래서 위에서 따로 끈다.
    //   파이썬은 오프라인 설정이 막는다. 웹소켓은 '*' 가 덮는지 판마다 다를 수 있어 따로 적는다.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
      if (isLocalUrl(d.url)) { cb({}); return }
      let host = '(알 수 없음)'
      try { host = new URL(d.url).hostname } catch { /* 그대로 */ }
      APP_LOG.warn('net', `바깥 요청을 막았다 — ${host} (${d.resourceType})`)
      cb({ cancel: true })
    })
    try {
      const b = currentBuildInfo()
      APP_LOG.info('boot', `AudioForge v${b.version}${b.commit ? '+' + b.commit : ''} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform} ${process.arch}`)
    } catch { APP_LOG.info('boot', 'AudioForge 시작(판 정보 읽기 실패)') }
    // 어느 데이터 폴더를 쓰는지 — 이름만(절대 경로 없음). 처음 복사했으면 무엇을 옮겼는지도.
    APP_LOG.info('boot', `데이터 폴더 ${basename(app.getPath('userData'))} (채널 ${USER_DATA_CHANNEL ?? '모름'})`)
    APP_LOG.info('boot', `바깥 전송 막음 · 파이썬 오프라인${OFFLINE_CHANGED.length ? '(켜 둠: ' + OFFLINE_CHANGED.join(',') + ')' : ''} · 웹 요청은 이 컴퓨터 안만`)
    // ★임시 자리가 **실제로** 옮겨졌는지 기록에 남긴다. 조용히 실패하면 여기서 드러난다 —
    //   '앱 안' 이 아니면 그 실행은 시스템 드라이브에 쌓고 있다는 뜻이다.
    APP_LOG.info('boot', `임시 자리 ${tmpdir().startsWith(app.getPath('userData')) ? '앱 안' : '앱 밖(!)'} · ${basename(tmpdir())}`)
    // 설정 파일의 판 — 어느 앱이 언제 썼는지. 아는 판보다 높으면 더 새 앱이 쓴 것이다(내리지 않는다).
    try {
      const got = readSettingsFile(join(app.getPath('userData'), 'settings.json'))
      if (got.kind === 'ok') {
        const m = readSettingsMeta(got.settings)
        const line = `설정 판 ${m.formatVersion}(아는 판 ${SETTINGS_FORMAT_VERSION}) · 마지막 쓴 앱 ${m.lastWrittenBy ?? '(번호 이전)'} · ${m.lastWrittenAt ?? '(모름)'}`
        if (m.formatVersion > SETTINGS_FORMAT_VERSION) APP_LOG.warn('boot', line + ' — 더 새 앱이 쓴 파일이다')
        else APP_LOG.info('boot', line)
      } else APP_LOG.info('boot', `설정 파일 ${got.kind === 'absent' ? '없음(첫 실행)' : '손상 — 덮어쓰지 않는다: ' + got.reason}`)
    } catch { /* 기록 실패는 기동을 막지 않는다 */ }
    if (userDataSeed?.seeded) {
      APP_LOG.info('boot', `개발선 폴더 첫 초기화 — 정식 폴더에서 복사 ${userDataSeed.copied.join(', ') || '(없음)'}; 건너뜀 ${userDataSeed.skipped.join(', ') || '(없음)'}`)
    } else if (userDataSeed) {
      APP_LOG.info('boot', `개발선 폴더 초기화 생략 — ${userDataSeed.reason === 'already_initialized' ? '이미 초기화됨' : userDataSeed.reason}`)
    }
    protocol.handle('local-file', async (request) => {
      const raw = request.url.replace('local-file://', '')
      // 캐시 전용 형식(local-file://sampler/<64hex>) — 실제 경로는 여기서만 해석한다.
      // 키가 규격 밖이거나 캐시 루트 밖을 가리키면 열지 않는다.
      let filePath: string
      if (raw.startsWith('sampler/')) {
        const resolved = samplerCache
          ? resolveSamplerPreviewPath(samplerCache, raw.slice('sampler/'.length))
          : null
        if (!resolved) return new Response(null, { status: 404 })
        filePath = resolved
      } else {
        filePath = decodeURIComponent(raw)   // 기존 절대경로 동작 — 그대로 보존
      }
      // 소비자(렌더러 미디어/fetch)가 로드를 포기하면 Electron 34.2.0이 알려주는 경로는
      // '우리가 돌려준 body의 cancel()' 하나뿐이다. request.signal은 존재하지만 어떤 취소
      // 시나리오에서도 발화하지 않고, net.fetch 응답 body를 cancel해도 상류 로더는 살아남아
      // 파일 핸들과 전송 버퍼가 세션 내내 남는다. 그래서 자체 AbortController를 net.fetch에
      // 넘기고, 반환한 body가 cancel될 때 정확히 그 요청만 abort한다.
      // 주의: 여기서는 어떤 로그도 남기지 않는다(경로·미디어 바이트가 로그에 닿을 수 없게).
      const upstream = new AbortController()
      const res = await net.fetch(pathToFileURL(filePath).href, { signal: upstream.signal })
      if (!res.body) return res
      const reader = res.body.getReader()
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else controller.enqueue(value)
            } catch (err) {
              try { controller.error(err) } catch { /* 이미 닫힘 */ }
            }
          },
          cancel() { upstream.abort() }
        }),
        { status: res.status, statusText: res.statusText, headers: res.headers }
      )
    })

    createWindow()

    // ★합성 엔진 라이브러리를 **배경에서 미리 읽어 둔다**(2026-09-25 실측).
    //   합성 준비 8.4초 중 5.8초가 라이브러리 읽기인데, 그 값은 **데워진 뒤**이고
    //   처음에는 25.9초다 — 앱을 켜고 첫 합성이 유독 느린 이유가 이것이다.
    //   처음 한 번을 여기로 옮기면 사용자가 기다리는 시간이 아니게 된다.
    //   ★모델은 올리지 않는다 — GPU 를 한 바이트도 쓰지 않음을 실측으로 확인했다.
    // ★핸들을 **붙들어 둔다**(2026-09-25 3차 감사에서 내가 낸 결함).
    //   버리면 종료 때 멈출 수 없다. `detached:false` 는 윈도에서 자동 종료를
    //   보장하지 않는다 — 앱을 껐는데 파이썬이 남아 도는 모양이 된다.
    //   이 저장소가 분석 worker 를 세 자리에서 정리하는 것과 같은 규율을 따른다.
    warmupHandle = warmUpBridge({
      root: join(__dirname, '..', '..'),
      log: (m) => { APP_LOG.info('warmup', m) },
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Electron 이 정상 경로를 못 타고 내려가도(dev 서버 종료·창 강제 종료) 자기가 띄운
// 자식들은 함께 내려가야 한다. app 훅만으로는 부족해 process 수준에서도 건다.
const stopWarmup = (): void => { try { warmupHandle?.stop() } catch { /* 이미 죽었으면 그만 */ } }
app.on('will-quit', () => { disposeAnalysisIpc(); stopWarmup() })
process.once('exit', () => { disposeAnalysisIpc(); stopWarmup() })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(sig, () => { disposeAnalysisIpc(); stopWarmup(); app.quit() })
}

app.on('before-quit', () => {
  // 분석은 편집 보조일 뿐이므로 종료를 붙들지 않는다 — 대기 요청을 취소하고 프로세스를 닫는다.
  disposeAnalysisIpc()
  stopWarmup()
  APP_LOG.info('boot', '종료')
})

app.on('window-all-closed', () => {
  disposeAnalysisIpc()
  if (process.platform !== 'darwin') app.quit()
})
