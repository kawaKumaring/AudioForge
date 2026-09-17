/**
 * 채널별 사용자 데이터 폴더 — 개발선과 정식이 같은 폴더를 쓰지 않게 한다.
 *
 * 왜 있나(2026-09-17): master 빌드와 develop 빌드가 **같은** `%APPDATA%\audio-forge` 를 썼다.
 * 한쪽이 바꾼 설정 모양을 다른 쪽이 그대로 읽어 조용히 되살리는 일이 실제로 있었다("되살리기" 사건의 배경).
 *
 * 규칙
 *   · 정식(Stable)·RC·알 수 없는 접미사 → 기본 폴더 그대로(`audio-forge`). **바뀌는 것이 없다.**
 *   · 개발선(Development, `-dev`) → 옆의 `audio-forge-dev`.
 *   · 개발선 폴더가 아직 없으면(설정 파일이 없으면) 정식 폴더의 **앱 데이터만 한 번 복사**한다.
 *     Electron 캐시(Cache·Code Cache·GPUCache·Session Storage…)는 옮기지 않는다 — 190MB 중 187MB 가 그것이고,
 *     앱이 다시 만든다. 원본은 읽기만 한다. 복사한 사실은 개발선 폴더 안 표식 파일에 남긴다.
 *   · 두 번째 실행부터는 아무것도 하지 않는다. 두 폴더는 그 뒤로 따로 간다(동기화 없음).
 *
 * 하는 곳: main 기동, userData 가 정해진 직후·로그 파일을 만들기 전. electron 을 import 하지 않는다.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
// node --test 가 이 파일을 곧바로 읽으므로 확장자를 붙인다(app.store 와 같은 이유).
// @ts-ignore TS5097
import { CHANNEL_DEVELOPMENT } from '../../shared/buildMetadata.ts'

export const USER_DATA_DIR_STABLE = 'audio-forge'
export const USER_DATA_DIR_DEV = 'audio-forge-dev'
export const SEED_MARKER_FILE = 'seeded-from.json'

/** 개발선 폴더에 처음 옮기는 앱 소유 항목. 여기 없는 것은 옮기지 않는다(Electron 캐시 등). */
export const APP_OWNED_ENTRIES = [
  'settings.json',
  'reference-library',
  'refclips',
  'lab-takes',
  'emotion-sampler-cache',
] as const

export function userDataDirNameFor(channel: string | null): string {
  return channel === CHANNEL_DEVELOPMENT ? USER_DATA_DIR_DEV : USER_DATA_DIR_STABLE
}

export type SeedResult =
  | { seeded: true; copied: string[]; skipped: string[] }
  | { seeded: false; reason: 'already_initialized' | 'no_source' | 'same_dir' }

export interface SeedOptions {
  /** 정식 폴더(읽기만). */
  from: string
  /** 개발선 폴더(없으면 만든다). */
  to: string
  now?: () => Date
}

/**
 * 개발선 폴더가 비어 있을 때 정식 폴더의 앱 데이터를 한 번 복사한다.
 * "비어 있다" = `settings.json` 이 없다. 표식 파일이 있으면 설정이 없어도 다시 복사하지 않는다
 * (사용자가 지웠다면 그 뜻을 존중한다).
 */
export function seedDevUserData(opts: SeedOptions): SeedResult {
  const { from, to } = opts
  if (from === to) return { seeded: false, reason: 'same_dir' }
  if (existsSync(join(to, 'settings.json')) || existsSync(join(to, SEED_MARKER_FILE))) {
    return { seeded: false, reason: 'already_initialized' }
  }
  if (!existsSync(join(from, 'settings.json'))) return { seeded: false, reason: 'no_source' }

  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  const skipped: string[] = []
  for (const entry of APP_OWNED_ENTRIES) {
    const src = join(from, entry)
    if (!existsSync(src)) { skipped.push(entry); continue }
    try {
      cpSync(src, join(to, entry), { recursive: true, errorOnExist: false, force: false })
      copied.push(entry)
    } catch {
      skipped.push(entry)   // 하나가 실패해도 나머지는 옮긴다. 실패는 표식에 남는다.
    }
  }
  const now = (opts.now ?? (() => new Date()))()
  writeFileSync(join(to, SEED_MARKER_FILE), JSON.stringify({
    seededAt: now.toISOString(),
    fromDirName: USER_DATA_DIR_STABLE,   // 폴더 이름만 — 절대 경로는 적지 않는다
    copied, skipped,
  }, null, 2), 'utf-8')
  return { seeded: true, copied, skipped }
}

/** 폴더 안 항목 이름 목록(정렬). 검사·진단용. */
export function listEntries(dir: string): string[] {
  try { return readdirSync(dir).sort() } catch { return [] }
}
