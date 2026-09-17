/**
 * 앱 로그 파일 — main 이 소유하는 날짜별 텍스트 로그.
 *
 * 왜 있나: 2026-09-17 까지 main 은 console 로만 찍고 파일에 남기지 않았다. 사용자가 "안 된다" 고
 * 하면 화면 캡처 외에 전달할 길이 없었고, 캡처는 이름표 없이 밖으로 나가 지울 수 없다.
 * 이 모듈은 그 빈자리를 채운다 — **무엇이, 언제, 어떤 순서로** 일어났는지를 사용자 폴더에 남긴다.
 *
 * 계약
 *   · 위치: `<userData>/logs/audioforge-YYYY-MM-DD.log` (현지 날짜). 하루 한 파일.
 *   · 한 기록 = 한 줄로 시작한다: `시각 수준 [꼬리표] 내용`. 내용이 여러 줄이면 뒷줄을 4칸 들여 쓴다 —
 *     줄 머리의 시각으로 기록 경계를 다시 찾을 수 있다.
 *   · **대사·전사 본문·사용자 음원의 절대 경로는 적지 않는다.** 경로가 필요하면 `fileLabel()` 로
 *     이름만 적는다. 이 규칙의 책임은 호출부에 있고, 이 파일 머리에 적어 두는 이유가 그것이다.
 *   · 로그는 앱을 절대 멈추지 못한다 — 쓰기 실패는 조용히 삼킨다(그 대신 아무것도 기록되지 않는다).
 *   · 하루 파일이 20MB 를 넘으면 그 사실을 한 줄 남기고 그 날은 더 쓰지 않는다(디스크 보호).
 *   · 만들 때 `keepDays` 보다 오래된 로그 파일을 지운다. 이 폴더의 `audioforge-*.log` 만 본다.
 *
 * electron 을 import 하지 않는다 — `node --test` 로 실제 파일에 눌러 확인한다.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { basename, join } from 'path'
import { format } from 'util'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export const LOG_DIR_NAME = 'logs'
export const LOG_FILE_PREFIX = 'audioforge-'
export const LOG_FILE_SUFFIX = '.log'
export const LOG_KEEP_DAYS_DEFAULT = 14
export const LOG_MAX_BYTES_PER_FILE = 20 * 1024 * 1024

export interface AppLog {
  readonly dir: string
  write(level: LogLevel, tag: string, message: string): void
  info(tag: string, message: string): void
  warn(tag: string, message: string): void
  error(tag: string, message: string): void
  /** 지금 시각 기준으로 기록될 파일 경로. */
  currentFile(): string
  /** `keepDays` 보다 오래된 로그 파일을 지우고, 지운 파일 이름을 돌려준다. */
  prune(): string[]
}

export interface AppLogOptions {
  dir: string
  now?: () => Date
  keepDays?: number
  maxBytesPerFile?: number
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

/** 현지 날짜의 파일 이름 — `audioforge-2026-09-17.log`. */
export function logFileName(d: Date): string {
  return `${LOG_FILE_PREFIX}${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}${LOG_FILE_SUFFIX}`
}

/** 파일 이름에서 날짜를 꺼낸다. 규칙에 맞지 않으면 null — 남의 파일은 건드리지 않는다. */
export function logFileDate(name: string): Date | null {
  const m = new RegExp(`^${LOG_FILE_PREFIX}(\\d{4})-(\\d{2})-(\\d{2})${LOG_FILE_SUFFIX.replace('.', '\\.')}$`).exec(name)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const day = Number(m[3])
  const d = new Date(y, mo - 1, day)
  // Date 는 13월·40일을 조용히 다음 달로 넘긴다 — 되읽어 같은 값인지 본다.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null
  return d
}

/** 현지 시각 + 시간대 오프셋. `2026-09-17T21:10:03.123+09:00`. */
export function localTimestamp(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
}

/** 기록 한 건을 줄로 만든다. 뒷줄은 4칸 들여 써서 줄 머리의 시각이 기록 경계가 된다. */
export function formatLogLine(now: Date, level: LogLevel, tag: string, message: string): string {
  const body = String(message).replace(/\r/g, '').split('\n')
  const head = `${localTimestamp(now)} ${level.padEnd(5)} [${tag}] ${body[0]}`
  const rest = body.slice(1).map((l) => `    ${l}`)
  return [head, ...rest].join('\n') + '\n'
}

/** 로그에 경로를 적을 때 쓴다 — 이름만. 폴더는 적지 않는다. */
export function fileLabel(p: string | null | undefined): string {
  if (!p) return '(없음)'
  return basename(String(p)) || '(이름 없음)'
}

export function createAppLog(opts: AppLogOptions): AppLog {
  const dir = opts.dir
  const now = opts.now ?? (() => new Date())
  const keepDays = opts.keepDays ?? LOG_KEEP_DAYS_DEFAULT
  const maxBytes = opts.maxBytesPerFile ?? LOG_MAX_BYTES_PER_FILE
  const capped = new Set<string>()

  try { mkdirSync(dir, { recursive: true }) } catch { /* 쓰기 실패는 write 에서 드러난다 */ }

  const currentFile = (): string => join(dir, logFileName(now()))

  const write = (level: LogLevel, tag: string, message: string): void => {
    try {
      const file = currentFile()
      if (capped.has(file)) return
      let size = 0
      try { size = statSync(file).size } catch { size = 0 }
      const line = formatLogLine(now(), level, tag, message)
      if (size + Buffer.byteLength(line) > maxBytes) {
        capped.add(file)
        appendFileSync(file,
          formatLogLine(now(), 'WARN', 'log', `이 파일이 ${Math.round(maxBytes / 1024 / 1024)}MB 를 넘어 오늘은 더 기록하지 않는다.`),
          'utf-8')
        return
      }
      appendFileSync(file, line, 'utf-8')
    } catch {
      // 로그가 앱을 멈추게 하지 않는다.
    }
  }

  const prune = (): string[] => {
    const removed: string[] = []
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return removed }
    const today = now()
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - keepDays)
    for (const name of names) {
      const d = logFileDate(name)
      if (!d || d >= cutoff) continue
      try { rmSync(join(dir, name), { force: true }); removed.push(name) } catch { /* 다음 기동에 다시 시도 */ }
    }
    return removed
  }

  prune()

  return {
    dir, write, currentFile, prune,
    info: (tag, message) => write('INFO', tag, message),
    warn: (tag, message) => write('WARN', tag, message),
    error: (tag, message) => write('ERROR', tag, message),
  }
}

/** 로그 폴더에 있는 로그 파일 이름을 날짜 오름차순으로. 규칙에 맞는 것만. */
export function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => logFileDate(n) !== null).sort()
}

// ── 프로세스 연결 ────────────────────────────────────────────────────────────

/**
 * `console.warn` / `console.error` 를 파일에도 남긴다. `console.log` 는 남기지 않는다 —
 * 파이썬 stdout 이 그 길로 흐르고, 거기에는 진행 메시지가 섞여 양이 많고 내용을 통제할 수 없다.
 * 기존 출력은 그대로 나간다(터미널·E2E 수집 유지). 되돌리는 함수를 돌려준다.
 */
export function mirrorConsole(log: AppLog, target: Pick<Console, 'warn' | 'error'> = console): () => void {
  const origWarn = target.warn.bind(target)
  const origError = target.error.bind(target)
  target.warn = (...args: unknown[]) => { origWarn(...args); log.warn('console', format(...args)) }
  target.error = (...args: unknown[]) => { origError(...args); log.error('console', format(...args)) }
  return () => { target.warn = origWarn; target.error = origError }
}

/**
 * main 프로세스의 잡히지 않은 예외를 기록한다. `uncaughtExceptionMonitor` 를 쓰는 이유:
 * 'uncaughtException' 리스너를 달면 Electron 의 기본 동작(오류 대화상자)이 사라진다.
 * monitor 는 기본 동작을 바꾸지 않고 **보기만** 한다. 되돌리는 함수를 돌려준다.
 */
export function watchUncaught(log: AppLog, proc: NodeJS.Process = process): () => void {
  const onUncaught = (err: unknown, origin: string) => {
    const e = err as { stack?: unknown; message?: unknown }
    log.error('uncaught', `${origin}: ${String(e?.stack ?? e?.message ?? err)}`)
  }
  proc.on('uncaughtExceptionMonitor', onUncaught)
  return () => { proc.off('uncaughtExceptionMonitor', onUncaught) }
}

// ── 앱 전역 하나 ─────────────────────────────────────────────────────────────
// index.ts 가 기동 때 만들어 넣고, IPC 모듈들은 `appLog()` 로 가져다 쓴다.
// 없을 수도 있다(단위 검사·기동 실패) — 호출부는 항상 `?.` 로 부른다.
let current: AppLog | null = null
export function setAppLog(log: AppLog | null): void { current = log }
export function appLog(): AppLog | null { return current }
