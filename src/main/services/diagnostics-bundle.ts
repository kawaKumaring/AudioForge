/**
 * 진단 묶음 — 사용자가 "안 된다" 를 전달할 때 화면 캡처 대신 건네는 폴더.
 *
 * 들어가는 것
 *   · `logs/`        최근 며칠의 앱 로그 파일(복사본)
 *   · `summary.txt`  앱 판·실행 환경·설정 파일의 **모양**(키 이름과 개수·글자 수만)·묶은 로그 목록
 *
 * 들어가지 않는 것 — 이 모듈의 존재 이유다
 *   · 설정의 **값**. 대사·전사 본문·마지막 폴더 같은 값은 한 글자도 옮기지 않는다. 문자열은 글자 수만,
 *     객체는 키 개수만, 배열은 항목 개수만 적는다.
 *   · 사용자 음원·생성본·참조 클립 파일.
 *   · 로그 자체는 그대로 복사한다. 로그에 무엇을 적는지는 app-log.ts 의 규칙(이름만, 본문 없음)이 지킨다.
 *
 * electron 을 import 하지 않는다 — 실제 파일로 `node --test` 한다.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
// node --test 가 이 파일을 곧바로 읽으므로 확장자를 붙인다(app.store 와 같은 이유).
// @ts-ignore TS5097
import { listLogFiles, logFileDate } from './app-log.ts'

export const BUNDLE_LOG_DAYS_DEFAULT = 3
export const BUNDLE_DIR_PREFIX = 'AudioForge_진단_'

export interface DiagnosticsRuntime {
  appVersion: string
  channel?: string
  commit?: string | null
  builtAt?: string | null
  platform: string
  arch: string
  electron?: string
  node?: string
  /** 앱 파이썬이 있는가만. 경로는 적지 않는다. */
  pythonPresent?: boolean
  /** 사용자 데이터 폴더 **이름**(audio-forge / audio-forge-dev). 경로는 적지 않는다. */
  dataDirName?: string
}

export interface DiagnosticsBundleInput {
  /** 묶음 폴더를 만들 곳(사용자가 고른 폴더). */
  targetDir: string
  logDir: string
  settingsPath: string
  runtime: DiagnosticsRuntime
  now?: () => Date
  logDays?: number
}

export interface DiagnosticsBundleResult {
  dir: string
  name: string
  files: string[]
  copiedLogs: string[]
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

export function bundleDirName(d: Date): string {
  return `${BUNDLE_DIR_PREFIX}${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/**
 * 값의 모양만 글로 만든다. 문자열의 내용·숫자의 값은 나오지 않는다.
 * 깊이 2까지만 — 그 아래는 개수로 접는다. 키 이름은 우리 코드가 정한 이름이라 적어도 된다.
 */
export function summarizeShape(value: unknown, depth = 0, indent = ''): string[] {
  const kind = (v: unknown): string => {
    if (v === null) return 'null'
    if (Array.isArray(v)) return `배열(항목 ${v.length}개)`
    if (typeof v === 'string') return `문자열(글자 ${v.length})`
    if (typeof v === 'number') return '숫자'
    if (typeof v === 'boolean') return '참/거짓'
    if (typeof v === 'object') return `객체(키 ${Object.keys(v as object).length}개)`
    return typeof v
  }
  const lines: string[] = []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      lines.push(`${indent}${k}: ${kind(v)}`)
      if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v)) {
        lines.push(...summarizeShape(v, depth + 1, indent + '  '))
      }
    }
  } else {
    lines.push(`${indent}${kind(value)}`)
  }
  return lines
}

function settingsShapeLines(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return ['설정 파일: 없음']
  let raw: string
  try { raw = readFileSync(settingsPath, 'utf-8') } catch { return ['설정 파일: 읽을 수 없음'] }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [`설정 파일: JSON 손상 (${Buffer.byteLength(raw)} 바이트)`] }
  return [`설정 파일: ${Buffer.byteLength(raw)} 바이트 — 아래는 모양만(값은 적지 않는다)`, ...summarizeShape(parsed)]
}

/** 최근 `days` 일의 로그 파일 이름(오늘 포함). */
export function recentLogFiles(logDir: string, now: Date, days: number): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return listLogFiles(logDir).filter((n) => {
    const d = logFileDate(n)
    return d !== null && d >= cutoff
  })
}

export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): DiagnosticsBundleResult {
  const now = (input.now ?? (() => new Date()))()
  const days = input.logDays ?? BUNDLE_LOG_DAYS_DEFAULT
  const name = bundleDirName(now)
  const dir = join(input.targetDir, name)
  if (existsSync(dir)) throw Object.assign(new Error('같은 이름의 진단 묶음이 이미 있습니다. 잠시 뒤 다시 시도하세요.'), { code: 'BUNDLE_EXISTS' })
  mkdirSync(join(dir, 'logs'), { recursive: true })

  const copiedLogs: string[] = []
  for (const n of recentLogFiles(input.logDir, now, days)) {
    try { copyFileSync(join(input.logDir, n), join(dir, 'logs', n)); copiedLogs.push(n) } catch { /* 없는 파일은 목록에 없다 */ }
  }

  const r = input.runtime
  const lines = [
    `AudioForge 진단 묶음 — ${now.toISOString()}`,
    '',
    '[앱]',
    `version: ${r.appVersion}${r.channel ? ` (${r.channel})` : ''}`,
    `commit: ${r.commit ?? '(모름)'}`,
    `builtAt: ${r.builtAt ?? '(모름)'}`,
    '',
    '[실행 환경]',
    `platform: ${r.platform} ${r.arch}`,
    `electron: ${r.electron ?? '(모름)'}`,
    `node: ${r.node ?? '(모름)'}`,
    `python: ${r.pythonPresent === undefined ? '(모름)' : r.pythonPresent ? '있음' : '없음'}`,
    `data: ${r.dataDirName ?? '(모름)'}`,
    '',
    '[설정 모양]',
    ...settingsShapeLines(input.settingsPath),
    '',
    `[로그] 최근 ${days}일, ${copiedLogs.length}개`,
    ...copiedLogs.map((n) => {
      let size = 0
      try { size = statSync(join(dir, 'logs', n)).size } catch { size = 0 }
      return `logs/${n} (${size} 바이트)`
    }),
    '',
    '이 묶음에는 대사·전사 본문, 설정 값, 사용자 음원·생성본 파일이 들어 있지 않다.',
    '로그에는 작업의 시작·끝·오류와 파일 이름(폴더 없이)만 적힌다.',
    '',
  ]
  writeFileSync(join(dir, 'summary.txt'), lines.join('\n'), 'utf-8')

  return { dir, name, files: ['summary.txt', ...copiedLogs.map((n) => `logs/${n}`)], copiedLogs }
}
