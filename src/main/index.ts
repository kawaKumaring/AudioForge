import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { createHash, randomUUID } from 'crypto'
import { statSync } from 'fs'
import { pathToFileURL } from 'url'
import { registerAudioIpc } from './ipc/audio.ipc'
import { registerAppVersionIpc } from './ipc/app-version.ipc'
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

let mainWindow: BrowserWindow | null = null
// 프로토콜 핸들러가 키를 경로로 바꿀 때 쓴다. 창 생성 시 채워진다.
let samplerCache: SamplerCache | null = null

// E2E 격리 — AF_E2E=1 에서만 userData 를 임시 폴더로 돌린다.
// 사용자의 실제 참조 라이브러리·샘플 캐시를 테스트가 건드리지 않게 하기 위한 게이트이며,
// production 실행에서는 이 분기가 동작하지 않는다.
if (process.env.AF_E2E === '1' && process.env.AF_E2E_USER_DATA) {
  try { app.setPath('userData', process.env.AF_E2E_USER_DATA) } catch { /* noop */ }
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
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })

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
  const previewAdapter = registerAudioIpc(mainWindow)

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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
