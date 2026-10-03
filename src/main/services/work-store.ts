/**
 * 작업 기록 창고 — **기록 하나가 파일 하나.**
 *
 * ★지시 (2026-09-28)
 * > "셋팅.json 에 저장하는게 아닌 생성한 파일마다 정보를 따로 가지고있어서
 * >  그 파일만 삭제하게 하도록한다"
 *
 * 여기서 지키는 것
 *   · **지우기는 그 파일 하나만 지운다.** 남의 기록을 다시 쓰는 일이 없다.
 *   · 쓰기는 임시본 → 이름 바꾸기. 쓰다 멈춰도 **반쯤 쓴 파일이 남지 않는다.**
 *   · 깨진 파일 하나가 나머지를 가리지 않는다 — 그 파일만 건너뛰고 사유를 남긴다.
 *   · 옮기기는 **한 번만**, 그리고 옮긴 뒤 옛 열쇠를 지운다.
 *     남겨 두면 지운 기록이 다음 실행에 되살아난다(실제로 그렇게 됐다).
 */
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync,
  readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
// ★확장자를 붙인다 — `node --test` 가 이 파일을 곧바로 읽는다(dub-job 과 같은 관례).
//   붙이지 않으면 실행 시점에 모듈을 못 찾는다.
// @ts-ignore TS5097
import {
  WORK_DIR_NAME, LEGACY_KEY_OF, fileNameOf, isWorkFile, makeRecord, parseRecord, splitLegacyMap,
// @ts-ignore TS5097
} from '../../shared/workRecord.ts'
import type { WorkKind, WorkRecord } from '../../shared/workRecord'

export interface WorkStoreHost {
  /** 기록이 사는 뿌리(보통 userData). */
  root: string
  /** 지금 시각(밀리초). 검사가 흔들리지 않게 밖에서 준다. */
  now: () => number
}

function dirOf(host: WorkStoreHost, kind: WorkKind): string {
  return join(host.root, WORK_DIR_NAME, kind)
}

/** 기록 하나를 **원자적으로** 쓴다. 성공 여부를 돌려준다. */
export function writeRecord(
  host: WorkStoreHost, kind: WorkKind, key: string, data: unknown,
): { ok: true; file: string } | { ok: false; why: string } {
  const dir = dirOf(host, kind)
  const file = join(dir, fileNameOf(key))
  const temp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    const body = JSON.stringify(makeRecord(key, data, host.now()), null, 2)
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, body)
      fsyncSync(fd)          // 여기까지 오면 임시본 내용이 디스크에 있다
    } finally { closeSync(fd) }
    renameSync(temp, file)   // 이름 바꾸기는 한 번에 일어난다
    return { ok: true, file }
  } catch (e) {
    try { if (existsSync(temp)) rmSync(temp, { force: true }) } catch { /* 다음에 */ }
    return { ok: false, why: (e as Error)?.message || '쓰지 못했습니다' }
  }
}

/** 기록 하나를 읽는다. 없거나 깨졌으면 null — **빈 기록으로 꾸미지 않는다.** */
export function readRecord(host: WorkStoreHost, kind: WorkKind, key: string): WorkRecord | null {
  const file = join(dirOf(host, kind), fileNameOf(key))
  try {
    if (!existsSync(file)) return null
    return parseRecord(JSON.parse(readFileSync(file, 'utf-8')))
  } catch { return null }
}

export interface ListResult {
  records: WorkRecord[]
  /** 깨져서 읽지 못한 파일 이름들. **조용히 버리지 않는다.** */
  broken: string[]
}

/** 갈래 하나의 기록 전부. 최근 손댄 순. */
export function listRecords(host: WorkStoreHost, kind: WorkKind): ListResult {
  const dir = dirOf(host, kind)
  const out: WorkRecord[] = []
  const broken: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return { records: [], broken: [] } }
  for (const n of names) {
    if (!isWorkFile(n)) continue
    try {
      const got = parseRecord(JSON.parse(readFileSync(join(dir, n), 'utf-8')))
      if (got) out.push(got)
      else broken.push(n)
    } catch { broken.push(n) }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return { records: out, broken }
}

/**
 * 기록 하나를 지운다 — **그 파일만.**
 *
 * 이미 없으면 지운 것으로 본다(`removed: false`). 없는 것을 지우라는 요청은
 * 실패가 아니다 — 사용자가 원한 상태가 이미 이루어져 있다.
 */
export function deleteRecord(
  host: WorkStoreHost, kind: WorkKind, key: string,
): { ok: true; removed: boolean } | { ok: false; why: string } {
  const file = join(dirOf(host, kind), fileNameOf(key))
  try {
    if (!existsSync(file)) return { ok: true, removed: false }
    rmSync(file, { force: true })
    return { ok: true, removed: true }
  } catch (e) {
    return { ok: false, why: (e as Error)?.message || '지우지 못했습니다' }
  }
}

/** 갈래 하나를 통째로 비운다. 쓰는 것은 '쌓인 것 비우기' 뿐이다. */
export function clearKind(host: WorkStoreHost, kind: WorkKind): number {
  const dir = dirOf(host, kind)
  let n = 0
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    if (!isWorkFile(name)) continue        // 남의 파일은 세지도 지우지도 않는다
    try { rmSync(join(dir, name), { force: true }); n++ } catch { /* 다음에 */ }
  }
  return n
}

export interface MoveResult {
  kind: WorkKind
  /** 옮긴 기록 수. */
  moved: number
  /** 옮기지 못한 것 — 사유와 함께. */
  failed: { key: string; why: string }[]
  /** 지운 옛 열쇠들. */
  clearedKeys: string[]
}

/**
 * 옛 `settings.json` 의 한 덩어리를 **기록 여럿으로 옮긴다.**
 *
 * ★이미 그 갈래에 파일이 있으면 **건너뛴다.** 두 번 옮기면 사용자가 지운 것이
 *   되살아난다 — 이 프로젝트에서 실제로 겪은 사고다.
 * ★옮기기가 **다 성공했을 때만** 옛 열쇠를 지운다. 반쯤 옮기고 지우면 기록이 사라진다.
 */
export function migrateKind(
  host: WorkStoreHost,
  kind: WorkKind,
  readLegacy: (key: string) => unknown,
  dropLegacy: (key: string) => boolean,
): MoveResult {
  const out: MoveResult = { kind, moved: 0, failed: [], clearedKeys: [] }
  // 이미 옮겼는가 — 파일이 하나라도 있으면 다시 옮기지 않는다.
  if (listRecords(host, kind).records.length > 0) return out

  for (const legacyKey of LEGACY_KEY_OF[kind]) {
    const raw = readLegacy(legacyKey)
    if (raw === undefined || raw === null) continue
    const records = splitLegacyMap(raw, host.now())
    // 가를 것이 없으면 **덩어리 자체를 한 기록으로** 둔다(카드 작업실 같은 모양).
    const list: WorkRecord[] = records.length
      ? records
      : [makeRecord(legacyKey, raw, host.now())]
    let allOk = true
    for (const r of list) {
      const w = writeRecord(host, kind, r.key, r.data)
      if (w.ok) out.moved += 1
      else { allOk = false; out.failed.push({ key: r.key, why: w.why }) }
    }
    // ★다 옮겼을 때만 옛 자리를 비운다. 남겨 두면 지운 것이 되살아난다.
    if (allOk && dropLegacy(legacyKey)) out.clearedKeys.push(legacyKey)
  }
  return out
}

/** 기록이 차지하는 크기(바이트). 비우기 안내에 쓴다. */
export function sizeOfKind(host: WorkStoreHost, kind: WorkKind): number {
  const dir = dirOf(host, kind)
  let n = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!isWorkFile(name)) continue
      try { n += statSync(join(dir, name)).size } catch { /* 건너뛴다 */ }
    }
  } catch { return 0 }
  return n
}
