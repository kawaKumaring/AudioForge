// 분할(split) 실행이 tmpdir에 만드는 '원본 전체 사본' 폴더의 정리·조회.
//
// 왜 필요한가: split 워커는 ffmpeg 호환을 위해 입력 파일 전체를 tmpdir 아래로 복사한다
// (수백 MB~GB). 파이썬 쪽 finally가 지우지만, 취소·watchdog·앱 종료는 taskkill /T /F 로
// 프로세스를 죽이므로 그 finally가 **실행되지 않는다**. 그래서 취소 1회마다 원본 크기만큼
// 영구 잔류했다(감사 R7). main은 실행이 어떻게 끝났는지 항상 알고 있으므로 여기서 지운다.
//
// 안전 규칙(refclip-cleanup의 선례와 동일):
//  - 대상은 tmpDir '바로 아래'의 디렉터리뿐. 재귀 탐색·상위 이동 없음.
//  - basename이 정확히 `audioforge_split_<runToken>_`로 시작하는 것만. 다른 접두사는 손대지 않는다.
//  - runToken은 이번 실행이 생성한 값이어야 한다 — 다른 실행/다른 앱의 폴더를 지우지 않는다.
//  - 기존 orphan(토큰을 모르는 과거 잔류물)은 **자동 삭제하지 않는다**. list만 제공한다.

import { readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'

export const SPLIT_TEMP_PREFIX = 'audioforge_split_'

/** runToken이 이 실행의 것인지 확인하는 최소 형태 검사(경로 조작 방지). */
export function isSafeRunToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9-]{4,64}$/.test(token)
}

/** 이번 실행이 만든 폴더 이름의 접두사. 워커에 그대로 전달된다. */
export function splitTempPrefixFor(runToken: string): string {
  if (!isSafeRunToken(runToken)) throw new Error('invalid runToken')
  return `${SPLIT_TEMP_PREFIX}${runToken}_`
}

function listDirsWithPrefix(tmpDir: string, prefix: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const full = join(tmpDir, name)
    try {
      if (statSync(full).isDirectory()) out.push(full)
    } catch { /* 사라졌거나 접근 불가 — 건너뜀 */ }
  }
  return out
}

/** 이번 실행(runToken)이 만든 임시 폴더만 삭제. 삭제한 경로 목록 반환. */
export function removeSplitTempDirs(tmpDir: string, runToken: string): string[] {
  if (!isSafeRunToken(runToken)) return []
  const removed: string[] = []
  for (const full of listDirsWithPrefix(tmpDir, splitTempPrefixFor(runToken))) {
    try {
      rmSync(full, { recursive: true, force: true })
      removed.push(full)
    } catch { /* 잠김 등 — 다음 기회에 */ }
  }
  return removed
}

/** 과거 실행이 남긴 split 임시 폴더 조회. **삭제하지 않는다**(보고 전용). */
export function listSplitTempDirs(tmpDir: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = []
  for (const full of listDirsWithPrefix(tmpDir, SPLIT_TEMP_PREFIX)) {
    try {
      out.push({ path: full, mtimeMs: statSync(full).mtimeMs })
    } catch { /* 사라짐 */ }
  }
  return out
}
