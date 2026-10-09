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
import { ipcMain, app, BrowserWindow, dialog } from 'electron'
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { execFile, spawn, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { currentPythonPath, synthesisBusy, setReaderRunning, pickFiles, dialogFolderHost } from './audio.ipc'
import { rememberFile, rememberDir, startDir } from '../services/dialogFolders'
import { scanTextPaths, scannedPaths } from '../services/folder-scan'
import { keepReaderCover } from '../services/reader-cover'
import { keepVoiceClip } from '../services/reader-voice-store'
import type { ScanResult } from '../../shared/readerLibrary'
import { TEXT_FILE_LIMIT } from '../../shared/readerChunks'
import { usesGpu } from '../../shared/readerQueue'
import { appLog, fileLabel } from '../services/app-log'
import { createLane, failureReason, jsonLines, madeTrack, pythonReason, readerRunConfig, testSkipsPrep, qwenRefModelPath } from '../services/reader-run'
import { QwenVoiceWorker } from '../services/qwen-voice-worker'
import { ensureQwenResident, qwenWorker, stopQwenResident } from '../services/qwen-resident'
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
/**
 * 서수 읽기 보정(2026-10-09) — 화면이 이 요청의 소리 글을 어떤 규칙으로 만들었나.
 * plainSay = 규칙을 적용하지 않은 소리 글(참조 목소리가 Qwen 이 아닌 엔진으로 넘어갈 때만 쓴다).
 */
export interface SpokenRequest { rule: string | null; ordinalChanges: number; plainSay?: string }
/** 만든 덩이 옆 기록 — **그 소리를 만들 당시**의 규칙·실제로 보낸 글의 종류. 쌓아 둔 것을 쓸 때 지금 요청과 나란히 돌려준다. */
export interface SpokenRecord { rule: string | null; ordinalChanges: number; usedText: 'spoken' | 'plain'; engine?: string; spokenSha256: string; madeAt: string }

function spokenOf(raw: unknown): SpokenRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rule = typeof o.rule === 'string' && o.rule ? o.rule : null
  const n = Number(o.ordinalChanges)
  return { rule, ordinalChanges: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0, ...(typeof o.plainSay === 'string' ? { plainSay: o.plainSay } : {}) }
}
function spokenRecordPath(wav: string): string { return wav.replace(/\.wav$/i, '') + '.spoken.json' }
function readSpokenRecord(wav: string): SpokenRecord | null {
  try { return JSON.parse(readFileSync(spokenRecordPath(wav), 'utf-8')) as SpokenRecord } catch { return null }
}
/**
 * 쌓아 둔 소리를 이 요청에 써도 되나 — 규칙을 켠 요청인데 그 소리가 **바꾸지 않은 글로** 만들어졌으면(Qwen 이 없어 넘어간 때) 쓰지 않는다.
 * 이름(지문)은 바꾼 글로 붙으므로 그 밖의 조건(목소리·모델·설정·글)은 이름이 이미 가른다.
 */
function cachedUsable(wav: string, spoken: SpokenRequest | null): boolean {
  if (!existsSync(wav)) return false
  if (!spoken?.rule) return true
  return readSpokenRecord(wav)?.usedText !== 'plain'
}

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
    try { rmSync(f.p, { force: true }); rmSync(spokenRecordPath(f.p), { force: true }); total -= f.size } catch { /* 다음에 */ }
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
/** 감정 지시를 받는 Qwen 지정 목소리 모델(1.7B) 폴더 — 없으면 ''. 파이썬 `tts_worker.qwen_emotion_model` 과 같은 규칙. */
function qwenEmotionModel(): string {
  const ext = join(dirname(dirname(scriptPath())), 'externals')
  try {
    for (const name of readdirSync(ext).sort()) {
      if (!name.startsWith('qwen3_tts')) continue
      const cfg = join(ext, name, 'config.json')
      if (!existsSync(cfg)) continue
      try {
        const c = JSON.parse(readFileSync(cfg, 'utf-8')) as { tts_model_type?: string; tts_model_size?: string }
        if (c.tts_model_type === 'custom_voice' && c.tts_model_size === '1b7') return join(ext, name)
      } catch { /* 다음 폴더 */ }
    }
  } catch { /* 없다 */ }
  return ''
}

/** 낭독 감정 덩어리 — 화면이 보낸 것을 믿지 않는다(모양이 다르면 없는 것으로). */
export interface EmotionSegment { text: string; emotion: string }
function segmentsOf(raw: unknown): EmotionSegment[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) return null
  const out: EmotionSegment[] = []
  for (const s of raw) {
    const text = String((s as { text?: unknown })?.text ?? '').trim()
    const emotion = String((s as { emotion?: unknown })?.emotion ?? '')
    if (!/^[a-z]{0,20}$/.test(emotion)) return null
    if (text) out.push({ text, emotion })
  }
  return out.length ? out : null
}

/** 설계 목소리(고정 참조)를 읽는 Base 1.7B 폴더 — 없으면 ''. */
function qwenBaseModel(): string {
  try {
    const ext = join(dirname(dirname(scriptPath())), 'externals')
    for (const name of readdirSync(ext).sort()) {
      if (!name.startsWith('qwen3_tts')) continue
      const cfg = join(ext, name, 'config.json')
      if (!existsSync(cfg)) continue
      try {
        const c = JSON.parse(readFileSync(cfg, 'utf-8')) as { tts_model_type?: string; tts_model_size?: string }
        if (c.tts_model_type === 'base' && c.tts_model_size === '1b7') return join(ext, name)
      } catch { /* 다음 폴더 */ }
    }
  } catch { /* 없다 */ }
  return ''
}

export interface QwenVoice { model: string; speaker: string; clone?: { ref: string; text: string } }
function qwenVoiceOf(path: string): QwenVoice | null {
  if (basename(path) === 'config.json') return { model: dirname(path), speaker: 'sohee' }
  let speaker = ''
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as { engine?: string; speaker?: string; clone?: { ref?: string; text?: string } }
    if (j.engine !== 'qwen-custom') return null
    if (j.clone) {
      // 설계 목소리 — 고정 참조 소리(목소리 파일 옆) + Base 1.7B. 화자 이름은 없다.
      const ref = j.clone.ref ? join(dirname(path), basename(String(j.clone.ref))) : ''
      const model = qwenBaseModel()
      return ref && j.clone.text && existsSync(ref) && model ? { model, speaker: '', clone: { ref, text: String(j.clone.text) } } : null
    }
    if (!j.speaker) return null
    speaker = String(j.speaker).toLowerCase()
  } catch { return null }
  const ext = join(dirname(dirname(scriptPath())), 'externals')
  try {
    // 빠른 0.6B 를 고른다 — 1.7B(감정 지시용)도 같은 종류라 이름 차례에 기대지 않는다.
    let fallback = ''
    for (const name of readdirSync(ext).sort()) {
      if (!name.startsWith('qwen3_tts')) continue
      const cfg = join(ext, name, 'config.json')
      if (!existsSync(cfg)) continue
      try {
        const c = JSON.parse(readFileSync(cfg, 'utf-8')) as { tts_model_type?: string; tts_model_size?: string }
        if (c.tts_model_type !== 'custom_voice') continue
        if (c.tts_model_size === '0b6') return { model: join(ext, name), speaker }
        fallback = fallback || join(ext, name)
      } catch { /* 다음 폴더 */ }
    }
    if (fallback) return { model: fallback, speaker }
  } catch { /* 없다 */ }
  return null
}

// Qwen 상주 실행기는 생성 카드와 함께 쓴다 — services/qwen-resident(2026-10-01).

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
/**
 * 낭독 요청의 **세대**(2026-10-03 — 관리자 실측: 문단 이동 후 첫 소리 4.74초 중 2.59초가 지난 생성을 기다린 시간).
 * 화면이 자리를 옮기거나·목소리를 바꾸거나·멈추면 세대를 올린다(reader:supersede). 그보다 옛 세대의 요청은
 *   · 아직 시작하지 않았으면 **시작 전에 버린다**(줄을 비운다)
 *   · 돌고 있으면 **협조적 정지**를 건다 — Qwen(지정·설계·감정·참조)은 정지 파일을 보고 16걸음 안에 멈춘다. 기본 목소리(CPU, 1~2초)는 멈출 수 없어 끝까지 간다.
 *   · 멈춘 결과는 쌓지 않는다(잘린 소리를 다음에 꺼내 쓰지 않게). GPU 표시(readerJob)는 실제로 끝난 뒤에 내린다(makeChunk finally).
 */
/**
 * ★세대는 **크기를 견주지 않는다**(2026-10-03 관리자 재현): 화면(낭독 엔진)이 다시 만들어지면 그 세대 번호가 0 부터 다시 셌는데,
 *   본체는 앞 화면의 큰 번호를 들고 있어 새 화면의 모든 요청을 '지난 것' 으로 버렸다 — 화면은 다시 청하고 또 버려지길 수십 번,
 *   끝내 '목소리를 만드는 중' 에 멈췄다(재생 0회). 이제 세대는 화면 인스턴스마다 다른 **표**(인스턴스:번호)이고,
 *   지금 것 = 화면이 **마지막으로 알린 표**와 같은 요청이다. 표가 없는 요청(개발툴 직접 호출 등)은 세대에 묶이지 않는다.
 */
let currentEpoch: string | null = null
const isStale = (ep: string | undefined): boolean => ep !== undefined && currentEpoch !== null && ep !== currentEpoch
interface ReaderCtl { epoch: string | undefined; stopFile?: string; superseded?: boolean; cancellable?: boolean; killed?: boolean }
/** 줄에 서서 **아직 시작하지 않은** 덩이 요청 수 — 미리 열기가 준비 생성을 건너뛸지 본다(실제 요청이 곧 그 준비를 치른다). */
const queuedSpeaks = new Set<ReaderCtl>()
/** 지금 세대로 줄에 서 있는(아직 시작 전) 요청이 있는가 — 지난 세대(버려질 것)는 세지 않는다. */
const currentSpeakWaiting = (): boolean => [...queuedSpeaks].some((c) => !isStale(c.epoch))
let runningCtl: ReaderCtl | null = null
class SupersededError extends Error {
  constructor(readonly phase: 'queued' | 'running') { super('지난 요청이라 버렸습니다') }
}

/** 관측 전용 — 줄에서 실제로 시작한 때·끝난 때(본체 단조 시계)와 모델을 이번에 열었는가. 동작은 이것을 읽지 않는다. */
/** 응답에 싣는 관측 — 본체 단계 길이(ms). */
/** spoken.requested = 이 요청의 규칙 · spoken.madeWith = 돌려준 소리를 **만들 당시** 기록(옛 소리는 기록이 없어 null). */
type SpeakTrace = { cached?: boolean; shared?: boolean; waitMs?: number; makeMs?: number; totalMs?: number; modelOpened?: boolean | null; engine?: string;
  spoken?: { requested: { rule: string | null; ordinalChanges: number } | null; madeWith: SpokenRecord | null } }
export interface ChunkTrace { startedAt?: number; endedAt?: number; modelOpened?: boolean | null; engine?: string; madeWhileWaiting?: boolean; spokenFallback?: boolean }

async function makeChunk(body: string, v: ReaderVoice, out: string, segments: EmotionSegment[] | null = null, info: ChunkTrace = {}, ctl: ReaderCtl = { epoch: undefined }, spoken: SpokenRequest | null = null): Promise<string> {
  info.startedAt = performance.now()
  // 차례를 기다리는 사이 같은 글·같은 목소리가 만들어졌을 수 있다.
  if (cachedUsable(out, spoken)) { info.madeWhileWaiting = true; info.endedAt = performance.now(); return out }
  // ★다른 화면의 작업이 돌면 비킨다. 판정은 `synthesisGate` 한 곳이 갖는다.
  const busy = synthesisBusy('낭독')
  if (busy) throw new Error(busy)
  const py = currentPythonPath()
  if (!py || !existsSync(py)) throw new Error('파이썬을 찾지 못했습니다')

  const runDir = join(readerDir(), 'work', `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(runDir, { recursive: true })
  const cfgPath = join(runDir, 'chunk.json')
  // ★참조 목소리에 규칙을 켠 요청이면 — 파이썬에 '이미 원문 기준으로 바꿨다'(다시 바꾸지 않게)와, Qwen 이 아닌 엔진으로 갈 때 쓸 바꾸지 않은 글을 함께 준다.
  const spokenCfg = v.kind === 'reference' && spoken?.rule
    ? { ttsSpokenPrepared: spoken.rule, ...(spoken.ordinalChanges > 0 && typeof spoken.plainSay === 'string' ? { ttsTextNonQwen: spoken.plainSay } : {}) }
    : {}
  writeFileSync(cfgPath, JSON.stringify({ ...readerRunConfig(body, v, runDir), ...spokenCfg }), 'utf-8')
  // 협조적 정지 — 이 덩이 전용 파일(세대가 지나면 reader:supersede 가 만든다). 기본 목소리(CPU)는 멈출 수 없다.
  ctl.stopFile = join(runDir, 'stop.flag')
  ctl.cancellable = !residentBuiltin(v)
  runningCtl = ctl

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
      info.engine = 'supertonic-resident'; info.modelOpened = !!r.loaded_now
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
      // 설계 목소리(고정 참조)는 감정 지시를 받지 않는다 — 덩어리가 와도 보통으로 한 번에.
      const emoModel = segments && !qv.clone ? qwenEmotionModel() : ''
      if (qv.clone) {
        const r = await qwenWorker().call({ model: qv.model, clone: qv.clone, language: 'korean', text_file: textFile, out: wav, seed: 0, stop_flag: ctl.stopFile })
        info.engine = 'qwen-clone-1.7b'; info.modelOpened = !!r.loaded_now
        note = ` 상주 설계(Base 1.7B)${r.loaded_now ? '(모델 엶)' : ''} 생성=${Number(r.gen_sec || 0).toFixed(1)}s 소리=${Number(r.seconds || 0).toFixed(1)}s`
      } else if (segments && emoModel) {
        // ★감정 담아 읽기(2026-10-01) — 덩이 전체를 1.7B 로(감정 없는 덩어리도 — 목소리가 바뀌지 않게), 덩어리마다 지시.
        const r = await qwenWorker().call({ model: emoModel, speaker: qv.speaker, language: 'korean', segments, out: wav, seed: 0, stop_flag: ctl.stopFile })
        info.engine = 'qwen-emotion-1.7b'; info.modelOpened = !!r.loaded_now
        const emos = segments.filter((s) => s.emotion).map((s) => s.emotion)
        note = ` 상주 감정(1.7B)${r.loaded_now ? '(모델 엶)' : ''} 덩어리=${segments.length} 감정=${emos.length ? emos.join(',') : '없음'} 생성=${Number(r.gen_sec || 0).toFixed(1)}s 소리=${Number(r.seconds || 0).toFixed(1)}s`
      } else {
        const r = await qwenWorker().speak({ model: qv.model, speaker: qv.speaker, language: 'korean', textFile, out: wav, stopFlag: ctl.stopFile })
        info.engine = 'qwen-0.6b'; info.modelOpened = !!r.loadedNow
        note = ` 상주${r.loadedNow ? '(모델 엶)' : ''} 생성=${r.genSec.toFixed(1)}s 소리=${r.seconds.toFixed(1)}s`
      }
      if (!existsSync(wav)) throw new Error('이 부분을 소리로 만들지 못했습니다')
    } else {
      // 참조 목소리 — 합성 프로세스(separate.py)가 덩이마다 뜬다. ★Qwen 은 **띄워 둔 실행기**가 불러 둔 모델로 만든다(2026-10-03):
      //   예전에는 덩이마다 모델을 새로 열었다(약 9.5초 · 관리자 실측 두 구절 모두 modelOpened=true). 실행기가 없으면 예전 길 그대로.
      const resident = v.kind === 'reference' && await ensureQwenResident()
      const { stdout } = await execFileAsync(py, ['-X', 'utf8', scriptPath(), '--config', cfgPath], {
        // 긴 덩이도 기본 목소리면 몇 초다. 참조 목소리는 훨씬 오래 걸린다.
        timeout: 600000, maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          // 정지 파일 — 띄워 둔 실행기(AF_QWEN_STOP_FILE)와 새 브리지 프로세스(AUDIOFORGE_DIAG_STOP_FLAG) 둘 다 같은 파일을 본다.
          AF_QWEN_STOP_FILE: ctl.stopFile, AUDIOFORGE_DIAG_STOP_FLAG: ctl.stopFile,
          ...(resident ? { AUDIOFORGE_QWEN_RESIDENT_BRIDGE: '1' } : {}),
        },
      })
      const lines = jsonLines(stdout)
      // 관측 — 실제로 어느 길로 만들었나(실행기가 답한 진행 줄로 안다), 모델을 이번에 열었나.
      const said = lines.map((l) => String(l.message ?? '')).join('\n')
      const viaResident = /띄워 둔 Qwen 으로 만듭니다/.test(said)
      info.engine = viaResident ? 'qwen-resident-bridge' : 'separate-process'
      info.modelOpened = viaResident ? /방금 엶/.test(said) : true
      // 서수 보정 — Qwen 이 아닌 엔진으로 넘어가 바꾸지 않은 글로 만들었나(파이썬이 알린다).
      info.spokenFallback = lines.some((l) => l.type === 'stage' && l.stage === 'spoken_text_fallback')
      const made = madeTrack(lines)
      if (!made || !existsSync(made)) throw new Error(pythonReason(lines) || '이 부분을 소리로 만들지 못했습니다')
      wav = made
    }
    // ★지난 세대로 멈춘 것은 쌓지 않는다 — 잘렸을 수 있다(멈출 수 없는 기본 목소리는 온전한 소리라 쌓는다).
    if (ctl.superseded && ctl.cancellable) throw new SupersededError('running')
    // 지문 이름으로 옮겨 둔다 — 다음에 같은 글·같은 목소리면 곧바로 쓴다.
    writeFileSync(out, readFileSync(wav))
    // ★만든 당시의 기록을 소리 옆에 — 나중에 쌓아 둔 것을 쓸 때 '지금 요청의 규칙' 과 섞지 않는다. 글 본문은 넣지 않는다(지문만).
    try {
      const rec: SpokenRecord = {
        rule: info.spokenFallback ? null : (spoken?.rule ?? null),
        ordinalChanges: info.spokenFallback ? 0 : (spoken?.ordinalChanges ?? 0),
        usedText: info.spokenFallback ? 'plain' : 'spoken', engine: info.engine,
        spokenSha256: createHash('sha256').update(info.spokenFallback && spoken?.plainSay != null ? spoken.plainSay : body).digest('hex'),
        madeAt: new Date().toISOString(),
      }
      writeFileSync(spokenRecordPath(out), JSON.stringify(rec), 'utf-8')
    } catch { /* 기록 실패가 낭독을 막지 않는다 */ }
    info.endedAt = performance.now()
    trimCache()
    // 동작 기록 — 글 내용 없이 글자 수·걸린 시간만. 낭독이 얼마나 빠른지 사용자가 볼 수 있다.
    appLog()?.info('reader', `만듦 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s${note}`)
    return out
  } catch (e) {
    if (e instanceof SupersededError || (ctl.superseded && (ctl.cancellable || ctl.killed))) {
      appLog()?.info('reader', `지난 요청 멈춤·버림 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      throw e instanceof SupersededError ? e : new SupersededError('running')
    }
    const shown = failureReason(e)
    // ★로그에 남긴다 — 낭독은 실패를 한 줄도 남기지 않아 신고를 받고도 사유를 알 수 없었다.
    //   **글 내용은 적지 않는다.** 글자 수와 목소리 파일 이름만.
    // ★앱을 끄면서 멈춘 조각은 실패가 아니다 — 경고로 남기면 끌 때마다 문제가 난 것처럼 보였다(2026-10-01 · MCP 검사).
    if (quitting) appLog()?.info('reader', `앱 종료로 멈춤 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length}`)
    else appLog()?.warn('reader', `만들지 못함 kind=${v.kind} voice=${fileLabel(v.path)} 글자=${body.length} ${((Date.now() - t0) / 1000).toFixed(1)}s: ${shown}`)
    throw new Error(shown)
  } finally {
    if (gpu) setReaderRunning(false)
    // ★↑ 실제로 끝난 뒤에야 내린다 — 멈추라고 한 것도 파이썬/실행기가 답한 다음이다(정지 확인 전에 GPU 표시를 풀지 않는다).
    if (runningCtl === ctl) runningCtl = null
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
const inFlight = new Map<string, { run: Promise<string>; ctl: ReaderCtl }>()

export function registerReaderIpc(): void {
  // Qwen 상주 실행기는 앱과 함께 끝난다(그래픽카드 메모리를 붙든 채 남지 않게).
  app.on('will-quit', () => { quitting = true; stopQwenResident('앱 종료'); readerWorkerInstance?.stop('앱 종료') })

  /**
   * 목소리를 **미리 연다** — 고른 순간(또는 책을 연 순간) 모델을 올려 둬 첫 조각을 기다리지 않게 (2026-10-01).
   * ★기본 목소리는 CPU 라 언제든. Qwen 소희는 그래픽카드를 쓰므로 다른 작업이 돌면 열지 않는다(그때는 누를 때 연다).
   * ★줄에 세운다 — 여는 동안 온 조각은 연 다음에 만든다.
   */
  /**
   * Qwen 실행기를 **모델 없이** 띄워 라이브러리만 불러 둔다 — 낭독 화면이 목소리 목록을 열 때 부른다.
   * ★모델 열기 13초 중 6.5초가 불러오기였다(2026-10-02 실측). 그래픽카드 메모리는 잡지 않고, 안 쓰면 3분 뒤 내린다.
   */
  ipcMain.handle('reader:prepare', async (_e, voice: unknown, prepOpts?: unknown): Promise<Reply<{ prepared: boolean; ms?: number }>> => {
    const t = performance.now()
    try {
      if (testSkipsPrep()) return ok({ prepared: false })
      const prepared = await ensureQwenResident()
      // 고를 법한 모델 파일을 미리 읽어 둔다 — 처음 열 때 디스크 읽기(1.7B 7.3초)를 목록을 보는 동안 치른다.
      const v = voice as ReaderVoice | null
      const qv = prepared && v?.path && v.engineId === 'qwen-custom' ? qwenVoiceOf(v.path) : null
      if (qv) {
        const emotion = !!(prepOpts as { emotion?: unknown } | undefined)?.emotion
        void qwenWorker().call({ prefetch: [(emotion && !qv.clone && qwenEmotionModel()) || qv.model] }).catch(() => { /* 못 읽어도 고를 때 연다 */ })
      }
      return ok({ prepared, ms: Math.round(performance.now() - t) })
    } catch (e) { return fail(e) }
  })

  ipcMain.handle('reader:warm', async (_e, voice: unknown, warmOpts?: unknown): Promise<Reply<{ warmed: boolean; why?: string; loadedNow?: boolean; primeSec?: number; waitMs?: number; ms?: number }>> => {
    // 관측 — 줄 대기(waitMs)와 실제 준비(ms), 모델을 이번에 열었나, 첫 생성 준비(primeSec).
    const asked = performance.now()
    try {
      const v = voice as ReaderVoice | null
      if (v?.kind === 'reference' && v.path && existsSync(v.path)) {
        // ★참조 목소리도 **고르는 순간** 그 모델(합성이 쓰는 0.6B Base 고정판) 하나만 띄워 둔 실행기에 연다(2026-10-03).
        //   예전에는 첫 덩이가 모델 열기를 기다렸다(실측 첫 소리 12.9초 중 약 6.4초). 다른 작업이 돌면 열지 않는다(누를 때 연다).
        if (testSkipsPrep()) return ok({ warmed: false, why: '검사(GPU 끔)' })
        const model = qwenRefModelPath(join(dirname(dirname(scriptPath())), 'externals'))
        if (!existsSync(model)) return ok({ warmed: false, why: '참조 목소리 모델이 없습니다' })
        if (!(await ensureQwenResident())) return ok({ warmed: false, why: '띄워 둔 실행기를 쓰지 못합니다' })
        return ok(await inLane(async () => {
          const busy = synthesisBusy('낭독')
          if (busy) return { warmed: false, why: busy }
          const t = performance.now()
          setReaderRunning(true)
          try {
            const r = await qwenWorker().call({ warm: true, model })
            return { warmed: true, loadedNow: !!r.loaded_now, waitMs: Math.round(t - asked), ms: Math.round(performance.now() - t) }
          } finally { setReaderRunning(false) }
        }))
      }
      if (!v || v.kind !== 'builtin' || !v.path || !existsSync(v.path)) return ok({ warmed: false, why: '미리 열 목소리가 아닙니다' })
      if (residentBuiltin(v)) {
        if (!currentPythonPath()) return ok({ warmed: false, why: '파이썬을 찾지 못했습니다' })
        let t = 0
        const r = await inLane(() => { t = performance.now(); return readerWorker().call({ warm: true, model: v.path }) })
        return ok({ warmed: true, loadedNow: !!r.loaded_now, waitMs: Math.round(t - asked), ms: Math.round(performance.now() - t) })
      }
      if (v.engineId === 'qwen-custom') {
        // 검사 전용 — GPU 를 쓰지 않는 기본 검사에서는 그래픽카드에 모델을 올리지 않는다(AF_E2E_GPU=1 일 때만 연다).
        if (testSkipsPrep()) return ok({ warmed: false, why: '검사(GPU 끔)' })
        return ok(await inLane(async () => {
          const busy = synthesisBusy('낭독')
          if (busy) return { warmed: false, why: busy }
          // ★알아보지 못하면 '도는 중' 을 세우기 **전에** 돌아간다(예전에는 세운 채 돌아가 다른 합성을 막을 수 있었다).
          const qv = qwenVoiceOf(v.path)
          if (!qv) return { warmed: false, why: '고른 Qwen 목소리를 알아보지 못했습니다' }
          // 감정 담아 읽기면 1.7B 를 연다(덩이 전체를 그 모델로 읽는다).
          const emotion = !!(warmOpts as { emotion?: unknown } | undefined)?.emotion
          const model = (emotion && !qv.clone && qwenEmotionModel()) || qv.model
          const t = performance.now()
          setReaderRunning(true)
          // 화자를 넘기면 막 연 모델로 짧은 글을 한 번 만들어 버린다 — 첫 생성의 준비를 여기서 치른다.
          // ★모델 열기와 준비 생성(짧은 글 한 번)을 **나눠** 청한다 — 열기(약 9초) 사이에 사용자가 재생을 눌렀으면 실제 덩이 요청이 줄에 서 있다.
          //   그때 준비 생성은 건너뛴다: 그 요청이 곧 같은 준비(첫 생성의 묶어 실행 준비)를 치르고, 버릴 글을 먼저 만들 까닭이 없다(실측 준비 생성 2.2~2.4초, 2026-10-03).
          try {
            const r = await qwenWorker().call({ warm: true, model })
            let primeSec = 0
            const primed = !!r.loaded_now && !currentSpeakWaiting()
            if (primed) {
              const p = await qwenWorker().call({ warm: true, prime: true, model, language: 'korean', ...(qv.clone ? { clone: qv.clone } : { speaker: qv.speaker }) })
              primeSec = Number(p.prime_sec || 0)
            }
            return { warmed: true, loadedNow: !!r.loaded_now, primeSec, primeSkipped: !!r.loaded_now && !primed, waitMs: Math.round(t - asked), ms: Math.round(performance.now() - t) }
          } finally { setReaderRunning(false) }
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
    _e, text: unknown, voice: unknown, voiceKey: unknown, rawParts?: unknown, rawSegments?: unknown,
    epoch?: unknown, rawSpoken?: unknown,
  ): Promise<Reply<{ path: string; cached: boolean; timing: Array<[number, number]>; trace?: SpeakTrace }> & { trace?: SpeakTrace; superseded?: 'queued' | 'running' }> => {
    // 관측 — 요청이 본체에 닿은 때부터 줄 대기·생성 길이(본체 단조 시계, ms). 응답에 함께 싣는다(화면이 기록).
    const asked = performance.now()
    const info: ChunkTrace = {}
    const spoken = spokenOf(rawSpoken)
    const spokenTrace = (wav?: string) => ({ requested: spoken ? { rule: spoken.rule, ordinalChanges: spoken.ordinalChanges } : null, madeWith: wav ? readSpokenRecord(wav) : null })
    const traceOf = (extra: { cached?: boolean; shared?: boolean } = {}, wav?: string) => ({
      ...extra, spoken: spokenTrace(wav),
      waitMs: info.startedAt != null ? Math.round(info.startedAt - asked) : undefined,
      makeMs: info.startedAt != null && info.endedAt != null ? Math.round(info.endedAt - info.startedAt) : undefined,
      modelOpened: info.modelOpened ?? null, engine: info.engine,
    })
    try {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('읽을 글이 없습니다')
      const v = voice as ReaderVoice | null
      if (!v || (v.kind !== 'builtin' && v.kind !== 'reference')) throw new Error('목소리를 고르세요')
      if (!v.path || !existsSync(v.path)) throw new Error('고른 목소리를 찾지 못했습니다')
      const key = String(voiceKey ?? '')
      const parts = partsOf(rawParts)
      // 감정 덩어리 — Qwen 지정 목소리에만. 쌓아 둔 이름에 감정까지 넣는다(같은 글이라도 감정이 다르면 다른 소리).
      const segments = v.kind === 'builtin' && v.engineId === 'qwen-custom' ? segmentsOf(rawSegments) : null

      // ★참조 목소리는 **경로만으로** 같은 목소리라 보지 않는다 — 같은 자리의 파일이 바뀌면(크기·시각) 다른 이름(2026-10-03).
      //   만드는 방식이 바뀐 것(띄워 둔 실행기·본 모델 묶어 실행)도 이름에 넣어 예전 소리와 섞지 않는다.
      const refTag = v.kind === 'reference' ? (() => { try { const s = statSync(v.path); return `|ref:${s.size}:${Math.round(s.mtimeMs)}|gen2` } catch { return '|ref:?' } })() : ''
      const out = join(readerDir(), segments
        ? chunkName(body + '\u0000' + JSON.stringify(segments.map((s) => [s.text, s.emotion])), key + '|감정')
        : chunkName(body, key + refTag))
      if (cachedUsable(out, spoken)) return ok({ path: out, cached: true, timing: timingOf(out, parts), trace: traceOf({ cached: true }, out) })

      // 세대 — 화면이 보낸 표(없으면 세대에 묶이지 않음). 지금 표가 아니면 줄에 세우지도 않는다.
      const ep = typeof epoch === 'string' && epoch ? epoch : undefined
      if (isStale(ep)) throw new SupersededError('queued')
      // 같은 글·같은 목소리가 이미 가 있으면 함께 받는다 — 단 **멈추라고 한 것**은 함께 받지 않는다(새로 만든다).
      const already = inFlight.get(out)
      if (already && !already.ctl.superseded) { const p = await already.run; return ok({ path: p, cached: false, timing: timingOf(p, parts), trace: { ...traceOf({ shared: true }, p), totalMs: Math.round(performance.now() - asked) } }) }

      // ★한 번에 하나 — 줄에 세운다. 앞 작업이 끝나야 다음이 돈다. ★차례가 왔을 때 세대가 지났으면 시작하지 않고 버린다.
      const ctl: ReaderCtl = { epoch: ep }
      queuedSpeaks.add(ctl)
      const run = inLane(() => {
        queuedSpeaks.delete(ctl)
        if (isStale(ctl.epoch)) { ctl.superseded = true; throw new SupersededError('queued') }
        return makeChunk(body, v, out, segments, info, ctl, spoken)
      })
      const entry = { run, ctl }
      inFlight.set(out, entry)
      void run.finally(() => { if (inFlight.get(out) === entry) inFlight.delete(out) }).catch(() => { /* 아래에서 받는다 */ })
      const made = await run
      return ok({ path: made, cached: !!info.madeWhileWaiting, timing: timingOf(made, parts), trace: traceOf({ cached: !!info.madeWhileWaiting }, made) })
    } catch (e) {
      // 지난 세대 — 화면이 오류로 보이지 않게 따로 표시한다(그 자리가 아직 필요하면 화면이 다시 청한다).
      if (e instanceof SupersededError) return { error: e.message, superseded: e.phase, trace: traceOf() }
      return { ...fail(e), trace: traceOf() }
    }
  })

  /**
   * 낭독 세대를 올린다 — 화면이 자리를 옮기거나·목소리를 바꾸거나·멈출 때(2026-10-03).
   * 돌고 있는 옛 세대 작업에 협조적 정지를 걸고(멈출 수 있는 것만), 줄에 선 옛 것은 차례가 오면 시작하지 않는다.
   * 답: 무엇이 돌고 있었고 멈추라고 했는지 — '멈춤 완료' 는 그 작업의 답(superseded:'running')이 와야 확인된다.
   */
  ipcMain.handle('reader:supersede', (_e, epoch: unknown, why?: unknown): Reply<{ running: boolean; stopRequested: boolean; cancellable: boolean | null }> => {
    if (typeof epoch !== 'string' || !epoch) return fail(new Error('세대 표가 없습니다'))
    currentEpoch = epoch
    const r = runningCtl
    let stopRequested = false
    if (r && isStale(r.epoch) && !r.superseded) {
      r.superseded = true
      if (r.cancellable && r.stopFile) {
        try { writeFileSync(r.stopFile, 'stop'); stopRequested = true } catch { /* 작업 폴더가 이미 지워졌다 — 끝난 것 */ }
      } else if (why === 'voice' && readerWorkerInstance?.running) {
        // ★목소리를 **바꿨으면** 고르지 않은 기본 목소리(CPU) 덩이를 기다리지 않는다 — 그 실행기를 내린다(낭독 전용, 다음에 쓸 때 다시 뜬다 · 열기 1초 안팎).
        //   실측(2026-10-03): 소희를 고르자 미리 열기가 기본 목소리 덩이 뒤에서 2.66초 기다렸다. 자리 이동·멈춤에는 내리지 않는다(같은 목소리를 곧 다시 쓴다).
        r.killed = true
        readerWorkerInstance.stop('목소리를 바꿈')
        stopRequested = true
      }
    }
    for (const [k, en] of inFlight) if (isStale(en.ctl.epoch)) { en.ctl.superseded = true; inFlight.delete(k) }
    return ok({ running: !!r, stopRequested, cancellable: r ? !!r.cancellable : null })
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

  // ── 폴더 가져오기 (2026-10-03) ─────────────────────────────────────────────
  // ★원본은 읽기만 한다. 화면은 **이 실행에서 훑어 건넨 글 파일만** 읽을 수 있다(아무 자리나 읽는 통로가 되지 않게).
  const scanned = new Set<string>()
  const coverPaths = new Set<string>()
  const remember = (r: ScanResult): ScanResult => { for (const w of r.works) if (w.coverPath) coverPaths.add(w.coverPath.toLowerCase()); for (const p of scannedPaths(r)) scanned.add(p.toLowerCase()); return r }
  ipcMain.handle('reader:cover', async (e, path?: unknown): Promise<Reply<string | null>> => {
    try {
      let source: string
      if (typeof path === 'string') {
        if (!coverPaths.has(path.toLowerCase())) throw new Error('가져오기에서 확인한 표지만 읽을 수 있습니다.')
        source = path
      } else {
        const win = BrowserWindow.fromWebContents(e.sender)
        if (!win) throw new Error('창을 찾지 못했습니다.')
        const paths = await pickFiles(win, { multi: false, slot: 'text', filters: [{ name: '표지 이미지', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
        if (!paths.length) return ok(null)
        source = paths[0]
      }
      return ok(await keepReaderCover(source, app.getPath('userData')))
    } catch (err) { return fail(err) }
  })
  /** 폴더를 고른다(여러 개) → 훑은 결과. 취소하면 빈 결과. */
  ipcMain.handle('reader:pick-folders', async (e): Promise<Reply<ScanResult | null>> => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('창을 찾지 못했습니다')
      let dirs: string[]
      const e2ePick = process.env.AF_E2E === '1' ? ((globalThis as { __afE2eSelectFolder?: string }).__afE2eSelectFolder ?? process.env.AF_E2E_SELECT_FOLDER) : undefined
      if (e2ePick !== undefined) {
        // 검사 전용 — OS 대화상자 대신 지정한 폴더('|' 로 여러 개, 빈 값은 취소). 실행 중에는 globalThis.__afE2eSelectFolder 로 바꾼다.
        dirs = e2ePick.split('|').filter(Boolean)
      } else {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'], defaultPath: startDir(dialogFolderHost(), 'text') })
        dirs = r.canceled ? [] : r.filePaths
      }
      if (!dirs.length) return ok(null)
      rememberDir(dialogFolderHost(), 'text', dirs[0])
      return ok(remember(await scanTextPaths(dirs, TEXT_FILE_LIMIT)))
    } catch (err) { return fail(err) }
  })
  /** 끌어 놓은 자리(파일·폴더 섞여도) 또는 '새 파일 확인' 의 작품 폴더를 훑는다. */
  ipcMain.handle('reader:scan-paths', async (_e, paths: unknown): Promise<Reply<ScanResult>> => {
    try {
      const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length < 4000).slice(0, 200) : []
      return ok(remember(await scanTextPaths(list, TEXT_FILE_LIMIT)))
    } catch (err) { return fail(err) }
  })
  /** 훑어 건넨 글 파일 하나를 읽는다(바이트 그대로 — 글자 방식 판정은 화면의 readerDecode). */
  ipcMain.handle('reader:read-text-path', async (_e, p: unknown): Promise<Reply<{ bytes: Uint8Array; size: number; mtimeMs: number }>> => {
    try {
      if (typeof p !== 'string' || !scanned.has(p.toLowerCase())) throw new Error('훑지 않은 파일은 읽지 않습니다')
      const s = statSync(p)
      if (s.size > TEXT_FILE_LIMIT) throw new Error('10MB 를 넘는 글입니다')
      return ok({ bytes: readFileSync(p), size: s.size, mtimeMs: Math.round(s.mtimeMs) })
    } catch (err) { return fail(err) }
  })

  /**
   * 끌어 놓은 글 파일의 폴더도 기억한다 — 끌어 온 것도 "불러온 자리" 다.
   * 없는 폴더는 기억하지 않는다(규칙은 `dialogFolders` 가 갖는다).
   */
  ipcMain.handle('reader:remember-text-dir', (_e, filePath: unknown) => {
    if (typeof filePath === 'string' && filePath) rememberFile(dialogFolderHost(), 'text', filePath)
    return true
  })

  /**
   * 구간을 잘라 쓴 내 목소리를 **앱이 관리하는 자리**(userData/readerVoices)에 보관한다(2026-10-03).
   * ★임시 조각 자리(refclips)는 켤 때·끌 때 치운다 — 그 경로를 저장하면 다시 켰을 때 목소리가 사라졌다. 보관 이유·비교는 reader-voice-store.
   * @param keep 남길 보관본(고른 목소리·최근 목소리 경로).
   */
  ipcMain.handle('reader:keep-voice', (_e, clip: unknown, keep: unknown): Reply<{ path: string }> => {
    try {
      if (typeof clip !== 'string' || !clip) throw new Error('준비한 목소리 조각이 없습니다')
      const ud = app.getPath('userData')
      const path = keepVoiceClip(clip, {
        tempRoot: join(ud, 'refclips'), storeDir: join(ud, 'readerVoices'),
        keep: Array.isArray(keep) ? keep.filter((k): k is string => typeof k === 'string') : [],
      })
      return ok({ path })
    } catch (e) { return fail(e) }
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
