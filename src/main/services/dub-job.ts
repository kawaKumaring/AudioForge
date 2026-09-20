// 더빙 일감 — 파이썬이 남긴 파일을 읽고 쓰는 부분.
//
// 프로세스를 띄우는 일은 여기서 하지 않는다(dub.ipc 의 몫). 여기 있는 것은 **읽고 쓰는 규칙**뿐이라
// Electron 없이 그대로 검사된다. 깨진 파일을 만났을 때 무엇을 하는지가 이 파일의 핵심이다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
// node --test 가 이 파일을 곧바로 읽으므로 **값** import 에는 확장자를 붙인다
// (voicePrepRunner.ts 와 같은 관례). 붙이지 않으면 실행 시점에 모듈을 못 찾는다.
// @ts-ignore TS5097
import { DUB_STAGES } from '../../shared/dubbing.ts'
import type {
  DubFrontResult, DubLine, DubLineResult, DubRenderResult, DubRenderSummary, DubStage,
} from '../../shared/dubbing'

export const DUB_LINES_FILE = 'lines.json'
export const DUB_REPORT_FILE = 'render-report.json'
export const DUB_TAKES_FILE = 'takes.json'
export const DUB_STATE_FILE = 'state.json'

export class DubJobError extends Error {}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 앞단이 남긴 lines.json 을 읽는다.
 *
 * 줄 하나가 이상해도 **그 줄만 버리지 않는다** — 빠진 값은 기본값으로 채우고 나머지를 살린다.
 * 대사 하나가 조용히 사라지면 결과 영상에서 그 대목만 비고 아무도 이유를 모른다.
 * 다만 파일 자체를 못 읽으면 사유와 함께 실패한다.
 */
export function parseLinesFile(raw: string, outDir = ''): DubFrontResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new DubJobError(`줄 목록을 읽지 못했습니다(형식 깨짐): ${(e as Error).message}`)
  }
  const obj = (data ?? {}) as Record<string, unknown>
  const rawLines = Array.isArray(obj.lines) ? obj.lines : []
  const lines: DubLine[] = rawLines.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>
    return {
      index: Number.isFinite(Number(r.index)) ? Number(r.index) : i,
      start: num(r.start),
      end: num(r.end),
      source: str(r.source),
      korean: str(r.korean).trim(),
    }
  })
  return {
    outDir,
    language: str(obj.language) || 'unknown',
    lines,
    emptyIndexes: lines.filter((l) => !l.korean).map((l) => l.index),
  }
}

/**
 * 파이썬이 남긴 진행 상태에서 **끝난 단계**를 읽는다.
 *
 * 못 읽으면 빈 목록이다 - 그것 때문에 멈추지 않는다. 이 값은 '무엇을 했는지 말해 주기'
 * 에만 쓰이고, 무엇을 다시 할지는 파이썬이 파일을 보고 정한다(판단이 두 곳에 생기지 않게).
 */
export function readDoneStages(outDir: string): DubStage[] {
  try {
    const raw = readFileSync(join(outDir, DUB_STATE_FILE), 'utf-8')
    const done = (JSON.parse(raw) ?? {}).done
    if (!Array.isArray(done)) return []
    return done.filter((d): d is DubStage => DUB_STAGES.includes(d as DubStage))
  } catch {
    return []
  }
}

export function readLines(outDir: string): DubFrontResult {
  const path = join(outDir, DUB_LINES_FILE)
  if (!existsSync(path)) {
    throw new DubJobError('앞단 결과가 없습니다 — 먼저 영상을 넣고 시작하세요')
  }
  return parseLinesFile(readFileSync(path, 'utf-8'), outDir)
}

/**
 * 사용자가 고친 번역문을 되쓴다.
 *
 * ★원문·시각은 건드리지 않는다. 고칠 수 있는 것은 한국어뿐이다 — 알아들은 것과 시각은
 * 측정 결과이지 의견이 아니다. 그리고 **파일에 있는 다른 값은 그대로 둔다**(낱말 시각 등).
 */
export function applyKoreanEdits(raw: string, edits: Record<number, string>): string {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new DubJobError(`줄 목록을 읽지 못했습니다(형식 깨짐): ${(e as Error).message}`)
  }
  const obj = (data ?? {}) as Record<string, unknown>
  const rawLines = Array.isArray(obj.lines) ? obj.lines : []
  const next = rawLines.map((item, i) => {
    const r = { ...((item ?? {}) as Record<string, unknown>) }
    const idx = Number.isFinite(Number(r.index)) ? Number(r.index) : i
    if (Object.prototype.hasOwnProperty.call(edits, idx)) r.korean = String(edits[idx]).trim()
    return r
  })
  const emptied = next.filter((r) => !String(r.korean ?? '').trim())
    .map((r, i) => (Number.isFinite(Number(r.index)) ? Number(r.index) : i))
  return JSON.stringify({ ...obj, lines: next, empty_indexes: emptied }, null, 2)
}

export function saveKoreanEdits(outDir: string, edits: Record<number, string>): DubFrontResult {
  const path = join(outDir, DUB_LINES_FILE)
  if (!existsSync(path)) throw new DubJobError('앞단 결과가 없습니다')
  const next = applyKoreanEdits(readFileSync(path, 'utf-8'), edits)
  writeFileSync(path, next, 'utf-8')
  return parseLinesFile(next, outDir)
}

/** 줄 번호와 만든 소리의 짝을 파이썬이 읽을 형태로 쓴다. */
export function writeTakesFile(outDir: string, takes: Record<number, string>): string {
  const path = join(outDir, DUB_TAKES_FILE)
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  const body: Record<string, string> = {}
  for (const [k, v] of Object.entries(takes)) {
    if (v) body[String(k)] = v
  }
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf-8')
  return path
}

function parseSummary(v: unknown): DubRenderSummary {
  const s = (v ?? {}) as Record<string, unknown>
  const list = (x: unknown): number[] => (Array.isArray(x) ? x.map((n) => num(n, -1)).filter((n) => n >= 0) : [])
  return {
    total: num(s.total),
    fit: num(s.fit),
    stretched: num(s.stretched),
    over: num(s.over),
    overIndexes: list(s.over_indexes),
    missingIndexes: list(s.missing_indexes),
    worstOverflowSec: num(s.worst_overflow_sec),
    maxRatioUsed: num(s.max_ratio_used, 1),
    trimmed: num(s.trimmed),
  }
}

/** 내보내기가 남긴 보고서를 읽는다. 줄마다의 결과가 화면의 상태 칸이 된다. */
export function parseRenderReport(raw: string): DubRenderResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new DubJobError(`내보내기 보고서를 읽지 못했습니다: ${(e as Error).message}`)
  }
  const obj = (data ?? {}) as Record<string, unknown>
  const rawLines = Array.isArray(obj.lines) ? obj.lines : []
  const lines: DubLineResult[] = rawLines.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>
    const st = str(r.status)
    return {
      index: Number.isFinite(Number(r.index)) ? Number(r.index) : i,
      status: st === 'fit' || st === 'stretched' || st === 'over' ? st : 'over',
      ratio: num(r.ratio, 1),
      overflowSec: num(r.overflow_sec),
      placeStart: num(r.place_start),
      borrowedBeforeSec: num(r.borrowed_before_sec),
      borrowedAfterSec: num(r.borrowed_after_sec),
      pushedSec: num(r.pushed_sec),
      reason: str(r.reason),
      loudnessMatched: r.loudness_matched === true,
      loudnessNote: str(r.loudness_note),
    }
  })
  return {
    video: str(obj.video),
    srt: str(obj.srt),
    summary: parseSummary(obj.summary),
    lines,
  }
}

export function readRenderReport(outDir: string): DubRenderResult {
  const path = join(outDir, DUB_REPORT_FILE)
  if (!existsSync(path)) throw new DubJobError('내보내기 결과가 없습니다')
  return parseRenderReport(readFileSync(path, 'utf-8'))
}

/**
 * 이 영상의 작업 폴더 이름. 같은 영상을 다시 열면 **같은 자리로 돌아온다**
 * — 그래야 이어 하기가 성립한다.
 *
 * 파일 이름을 그대로 쓰지 않는다: 일본어·기호가 섞인 이름은 폴더 이름으로 위험하다.
 * 이름의 글자를 재료로 짧은 표를 만들되, **내용은 읽지 않는다.**
 */
export function workFolderName(videoPath: string): string {
  const base = videoPath.replace(/\\/g, '/').split('/').pop() || 'video'
  let h = 2166136261
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const safe = base.replace(/\.[^.]*$/, '').replace(/[^0-9A-Za-z가-힣]+/g, '-').slice(0, 24) || 'video'
  return `${safe}-${(h >>> 0).toString(16).padStart(8, '0')}`
}
