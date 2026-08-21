import { readdirSync, rmSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'

// 파생 참조 클립은 trim-reference가 tmpdir 바로 아래에 `audioforge_refclip_<ts>/` 폴더로 만든다.
// (그 안에 reference_clip_24k.wav.) 이 폴더의 수명 관리 — AudioForge가 만든 정확한 폴더만 삭제한다.
//
// 안전 규칙(엄격):
//  - 대상은 오직 tmpDir '바로 아래'의, basename이 `audioforge_refclip_`로 시작하는 '디렉터리'.
//  - 사용자 원본 파일·synthesized.wav·다른 prefix·상위 경로·다른 위치는 절대 건드리지 않는다.
//  - 개별 삭제 실패는 무시(다른 항목 계속) — 사용 중 파일 등.

export const REFCLIP_PREFIX = 'audioforge_refclip_'

/** dir이 tmpDir 바로 아래의 정확한 파생 참조 폴더인지(경로 상향/타 prefix 방지). */
export function isRefClipDir(tmpDir: string, dir: string): boolean {
  if (!dir) return false
  // 정규화 비교: dir의 부모가 tmpDir이고 basename이 정확한 prefix로 시작
  if (dirname(dir) !== tmpDir) return false
  return basename(dir).startsWith(REFCLIP_PREFIX)
}

/** 정확히 하나의 파생 참조 폴더를 안전하게 삭제. 가드 통과 + 디렉터리일 때만. 반환: 삭제했는지. */
export function removeRefClipDir(tmpDir: string, dir: string): boolean {
  if (!isRefClipDir(tmpDir, dir)) return false
  try {
    if (!statSync(dir).isDirectory()) return false  // 동명 파일 보호
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** tmpDir 바로 아래의 stale 파생 참조 폴더 전부 정리(앱 시작/종료 방어). 반환: 삭제된 이름들. */
export function sweepRefClipDirs(tmpDir: string): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return removed
  }
  for (const name of entries) {
    if (!name.startsWith(REFCLIP_PREFIX)) continue
    const full = join(tmpDir, name)
    try {
      if (!statSync(full).isDirectory()) continue  // 동명 파일 보호
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // 개별 실패 무시
    }
  }
  return removed
}
