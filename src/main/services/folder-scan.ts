/**
 * 낭독 — 끌어 놓거나 고른 **폴더·파일을 훑어** 작품 묶음 후보를 만든다 (2026-10-03). 원본은 읽기만 한다.
 *
 * 규칙
 *  · 글 파일(.txt)만 가져온다. 다른 형식은 개수만 센다. 크기 상한을 넘으면 따로 센다.
 *  · 글 파일을 **직접 담은 폴더 하나**가 작품 하나다(이름 = 폴더 이름). 하위 폴더도 훑는다.
 *    파일 없이 하위 폴더만 담은 중간 폴더는 묶음을 만들지 않는다.
 *  · 폴더가 아니라 파일로 놓은 글은 묶지 않는다(loose).
 *  · ★연결(정션·심볼릭 링크)은 **따라가지 않는다** — 순환으로 끝없이 훑지 않게. 실제 자리(realpath)로 한 번 더 막는다.
 *  · 깊이·개수 상한을 넘으면 거기서 멈추고 truncated 로 알린다.
 */
import { lstat, readdir, realpath, stat } from 'fs/promises'
import { basename, extname, join } from 'path'
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(저장소 관례)
import { naturalCompare } from '../../shared/readerLibrary.ts'
import type { ScanFile, ScanResult, ScanWork } from '../../shared/readerLibrary'

export const SCAN_MAX_FILES = 5000
export const SCAN_MAX_DEPTH = 24
const TEXT_EXT = new Set(['.txt'])

export async function scanTextPaths(paths: readonly string[], limitBytes: number): Promise<ScanResult> {
  const out: ScanResult = { works: [], loose: [], unsupported: 0, tooLarge: 0, links: 0, missing: [], truncated: false }
  const seen = new Set<string>()
  let count = 0

  const fileEntry = async (p: string): Promise<ScanFile | 'large' | null> => {
    try {
      const s = await stat(p)
      if (s.size > limitBytes) return 'large'
      return { path: p, name: basename(p), size: s.size, mtimeMs: Math.round(s.mtimeMs) }
    } catch { return null }
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.truncated) return
    if (depth > SCAN_MAX_DEPTH) { out.truncated = true; return }
    let real: string
    try { real = (await realpath(dir)).toLowerCase() } catch { out.missing.push(dir); return }
    if (seen.has(real)) return                 // 이미 훑은 실제 자리(연결로 되돌아온 순환 등)
    seen.add(real)
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { out.missing.push(dir); return }
    entries.sort((a, b) => naturalCompare(a.name, b.name))
    const files: ScanFile[] = []
    const subdirs: string[] = []
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) { out.links++; continue }
      if (e.isDirectory()) {
        // 윈도우 정션은 Dirent 에서 디렉터리로 보일 수 있다 — lstat 로 한 번 더 본다.
        try { if ((await lstat(p)).isSymbolicLink()) { out.links++; continue } } catch { continue }
        subdirs.push(p); continue
      }
      if (!e.isFile()) continue
      if (!TEXT_EXT.has(extname(e.name).toLowerCase())) { out.unsupported++; continue }
      if (count >= SCAN_MAX_FILES) { out.truncated = true; break }
      const f = await fileEntry(p)
      if (f === 'large') { out.tooLarge++; continue }
      if (f) { files.push(f); count++ }
    }
    if (files.length) out.works.push({ root: dir, name: basename(dir), files })
    for (const s of subdirs) await walk(s, depth + 1)
  }

  for (const p of paths) {
    let s
    try { s = await lstat(p) } catch { out.missing.push(p); continue }
    // 사람이 직접 놓은 것은 연결이어도 그 대상을 연다(안쪽의 연결은 따라가지 않는다).
    let target = s
    if (s.isSymbolicLink()) { try { target = await stat(p) } catch { out.missing.push(p); continue } }
    if (target.isDirectory()) { await walk(p, 0); continue }
    if (!target.isFile()) continue
    if (!TEXT_EXT.has(extname(p).toLowerCase())) { out.unsupported++; continue }
    const f = await fileEntry(p)
    if (f === 'large') out.tooLarge++
    else if (f) { out.loose.push(f); count++ }
  }
  return out
}

/** 작품 묶음 목록에서 파일 자리만(읽기 허용 목록용). */
export const scannedPaths = (r: ScanResult): string[] => [...r.loose, ...r.works.flatMap((w: ScanWork) => w.files)].map((f) => f.path)
