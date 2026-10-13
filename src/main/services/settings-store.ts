/**
 * `settings.json` 원자 저장 — main 이 소유하는 키 단위 병합.
 *
 * 왜 별 모듈인가: 이 동작은 **실패했을 때 무엇이 남는가**가 전부다. 예전 구현은 평범한
 * `writeFileSync` 였고, 쓰다 죽으면 잘린 파일 하나가 `pythonPath` 까지 함께 날렸다.
 * 그 성질은 실제 파일로 눌러 봐야 확인되므로 electron 을 import 하지 않는 자리에 떼어
 * 놓고 `node --test` 로 직접 검증한다.
 *
 * 계약
 *   · renderer 는 **키 하나와 값 하나**만 보낸다. 설정 전체 사본을 보내지 않는다 —
 *     오래된 사본을 되쓰면 그 사이 다른 키가 되돌아간다.
 *   · main 이 **현재 파일을 읽어** 허용된 키 하나만 갱신한다.
 *   · 임시본은 **같은 폴더**(같은 볼륨)에 만들고 flush 한 뒤 rename 으로 교체한다.
 *   · 실패하면 기존 파일 바이트가 그대로 남는다. 실패를 성공으로 보고하지 않는다.
 *
 * 저장 위치는 호출부가 준다(테스트가 임시 폴더를 쓰고, 앱은 userData 를 쓴다).
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync,
} from 'fs'
import { dirname, join } from 'path'

// ── 판 번호 ─────────────────────────────────────────────────────────────────
// 설정 파일은 일곱 영역이 번호 없이 쌓여 있었다(2026-09-17 실측). 모양을 바꾸면 옛 파일이 조용히 깨지거나
// 조용히 되살아난다. 그래서 파일에 `meta` 하나를 두고, 쓸 때마다 **어느 판이 언제 썼는지** 찍는다.
//   · formatVersion — 이 파일 모양의 판. 모양을 바꾸는 사람은 번호를 올리고 MIGRATIONS 에 한 단계를 더한다.
//   · lastWrittenBy / lastWrittenAt — 마지막으로 쓴 앱 판과 시각(진단용).
// 규칙: 모르는 키는 **버리지 않는다.** 파일 판이 아는 판보다 높으면(더 새 앱이 썼다) 내리지 않고 그대로 둔다.
export const SETTINGS_META_KEY = 'meta'
export const SETTINGS_FORMAT_VERSION = 1

export interface SettingsMeta {
  formatVersion: number
  lastWrittenBy: string | null
  lastWrittenAt: string | null
}

/** 파일 안 meta 를 안전하게 읽는다. 없거나 깨졌으면 판 0(번호 이전 시대). */
export function readSettingsMeta(settings: Record<string, unknown>): SettingsMeta {
  const m = settings[SETTINGS_META_KEY]
  const o = (m && typeof m === 'object' && !Array.isArray(m)) ? m as Record<string, unknown> : {}
  const v = typeof o.formatVersion === 'number' && Number.isInteger(o.formatVersion) && o.formatVersion >= 0 ? o.formatVersion : 0
  return {
    formatVersion: v,
    lastWrittenBy: typeof o.lastWrittenBy === 'string' ? o.lastWrittenBy : null,
    lastWrittenAt: typeof o.lastWrittenAt === 'string' ? o.lastWrittenAt : null,
  }
}

/**
 * 판 n 의 설정을 판 n+1 로 올리는 단계들. 키는 **출발 판**. 각 단계는 새 객체를 돌려주고 모르는 키를 보존한다.
 *   0 → 1: 번호 이전 시대의 파일. 데이터 모양은 그대로다 — 판 번호를 붙이는 것만이 변화다.
 */
const MIGRATIONS: Record<number, (s: Record<string, unknown>) => Record<string, unknown>> = {
  0: (s) => ({ ...s }),
}

export interface MigrationResult {
  settings: Record<string, unknown>
  from: number
  to: number
  /** 파일이 아는 판보다 높다 — 더 새 앱이 썼다. 내리지 않았고 그대로 읽었다. */
  newerThanKnown: boolean
}

/** 읽은 설정을 현재 판까지 올린다(메모리에서만). meta 는 건드리지 않는다 — 쓰는 쪽이 찍는다. */
export function migrateSettings(settings: Record<string, unknown>): MigrationResult {
  const from = readSettingsMeta(settings).formatVersion
  if (from > SETTINGS_FORMAT_VERSION) return { settings: { ...settings }, from, to: from, newerThanKnown: true }
  let cur = { ...settings }
  for (let v = from; v < SETTINGS_FORMAT_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) throw new Error(`SETTINGS_MIGRATION_MISSING:${v}`)   // 번호만 올리고 단계를 안 쓴 것 — 개발 오류
    cur = step(cur)
  }
  return { settings: cur, from, to: SETTINGS_FORMAT_VERSION, newerThanKnown: false }
}

/** 쓸 때 찍는 meta. 파일 판이 더 높으면 그 번호를 유지한다(내리지 않는다). */
export function stampSettingsMeta(
  settings: Record<string, unknown>, writtenBy: string | null, now: Date = new Date(),
): Record<string, unknown> {
  const prev = readSettingsMeta(settings)
  const meta: SettingsMeta = {
    formatVersion: Math.max(prev.formatVersion, SETTINGS_FORMAT_VERSION),
    lastWrittenBy: writtenBy,
    lastWrittenAt: now.toISOString(),
  }
  return { ...settings, [SETTINGS_META_KEY]: meta }
}

/** 설정 파일을 읽을 때 나올 수 있는 결과. 손상을 빈 설정과 구분한다. */
export type SettingsReadResult =
  | { kind: 'ok'; settings: Record<string, unknown> }
  | { kind: 'absent' }
  /** JSON 자체가 깨졌다. **덮어쓰지 않는다** — 사용자가 복구할 원본을 남긴다. */
  | { kind: 'corrupt'; reason: string }

export function readSettingsFile(path: string): SettingsReadResult {
  if (!existsSync(path)) return { kind: 'absent' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { kind: 'corrupt', reason: `READ_FAILED:${(err as Error).name}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'corrupt', reason: 'NOT_AN_OBJECT' }
    }
    return { kind: 'ok', settings: parsed as Record<string, unknown> }
  } catch {
    return { kind: 'corrupt', reason: 'JSON_PARSE_FAILED' }
  }
}

export type SettingsWriteResult =
  | { ok: true }
  /**
   * 저장하지 않았다. `preserved` 는 기존 파일을 건드리지 않았다는 뜻이다 —
   * renderer 는 이 결과를 받으면 상태를 persisted 로 표시해서는 안 된다.
   */
  | { ok: false; code: string; preserved: boolean }

/**
 * 허용된 키 하나만 갱신해 원자적으로 교체한다.
 *
 * 기존 파일이 **손상**이면 저장하지 않는다. 손상본을 읽어 병합하면 다른 키를 잃고,
 * 덮어쓰면 사용자가 복구할 원본이 사라진다. 둘 다 하지 않고 사유를 돌려준다.
 *
 * `value === undefined` 는 그 키를 지우는 것이다(없는 키를 지우는 것도 성공이다).
 */
export interface SetSettingsOptions {
  /** meta.lastWrittenBy 에 찍을 앱 판. 모르면 null. */
  writtenBy?: string | null
  now?: () => Date
}

export function setSettingsKey(
  path: string, key: string, value: unknown, opts: SetSettingsOptions = {},
): SettingsWriteResult {
  if (key === SETTINGS_META_KEY) return { ok: false, code: 'SETTINGS_META_IS_OWNED_BY_STORE', preserved: true }
  const current = readSettingsFile(path)
  if (current.kind === 'corrupt') {
    return { ok: false, code: `SETTINGS_CORRUPT:${current.reason}`, preserved: true }
  }
  // 읽은 파일을 현재 판까지 올린 뒤 키 하나를 바꾸고 meta 를 찍는다. 모르는 키는 그대로 실려 간다.
  const base: Record<string, unknown> =
    current.kind === 'ok' ? migrateSettings(current.settings).settings : {}
  const next: Record<string, unknown> = { ...base }
  if (value === undefined) delete next[key]
  else next[key] = value
  const stamped = stampSettingsMeta(next, opts.writtenBy ?? null, (opts.now ?? (() => new Date()))())

  const dir = dirname(path)
  // 임시본은 반드시 같은 폴더에 — 다른 볼륨이면 rename 이 원자적이지 않다.
  const temp = join(dir, `.settings.${process.pid}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, JSON.stringify(stamped, null, 2))
      fsyncSync(fd)          // 여기까지 왔으면 임시본 내용이 디스크에 있다
    } finally {
      closeSync(fd)
    }
    // 되읽어 검증한다 — 깨진 것을 승격하지 않는다.
    const back = readSettingsFile(temp)
    if (back.kind !== 'ok') {
      throw new Error(`TEMP_UNREADABLE:${back.kind}`)
    }
    renameSync(temp, path)   // 같은 볼륨 교체. Windows 에서도 기존 대상을 대체한다
    return { ok: true }
  } catch (err) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 임시본 잔존만 남는다 */ }
    // 실패를 삼키지 않는다. 기존 파일은 rename 전이므로 바이트가 그대로다.
    return { ok: false, code: `SETTINGS_WRITE_FAILED:${(err as Error).name}`, preserved: true }
  }
}
