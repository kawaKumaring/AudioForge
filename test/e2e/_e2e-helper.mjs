// E2E 격리 헬퍼 — 실제 사용자 자산(resources/)을 절대 건드리지 않는다.
// 입력 파일을 os.tmpdir()/audioforge_e2e_<UUID>/ 로 복사해 주입하고, 합성 출력도 그 격리 폴더 안
// (dirname(input)/AudioForge_output)에 생성되게 한다. finally에서 자신이 만든 UUID 폴더만 삭제.
import { randomUUID, createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

// 입력을 격리 폴더로 복사. 반환 { dir, input }.
export function isolatedInput(srcAbs) {
  const dir = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const input = path.join(dir, path.basename(srcAbs))
  fs.copyFileSync(srcAbs, input)
  return { dir, input }
}

// 격리 폴더만 삭제(prefix 가드).
export function cleanupIsolated(dir) {
  if (dir && path.basename(dir).startsWith('audioforge_e2e_') && path.dirname(dir) === os.tmpdir()) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// 디렉터리 트리의 (상대경로, size, sha8) 정렬 스냅샷 — 원본 불변 단언용.
export function snapshotTree(root) {
  const rows = []
  function walk(d, rel) {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { rows.push('D ' + r); walk(full, r) }
      else {
        let size = 0, h = ''
        try { const buf = fs.readFileSync(full); size = buf.length; h = createHash('sha256').update(buf).digest('hex').slice(0, 8) } catch { /* ignore */ }
        rows.push(`F ${r} ${size} ${h}`)
      }
    }
  }
  walk(root, '')
  return rows.join('\n')
}
