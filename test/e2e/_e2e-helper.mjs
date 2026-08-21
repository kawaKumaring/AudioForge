// E2E 격리 헬퍼 — 실제 사용자 자산(resources/)을 절대 건드리지 않는다.
// 입력 파일을 os.tmpdir()/audioforge_e2e_<UUID>/ 로 복사해 주입하고, 합성 출력도 그 격리 폴더 안
// (dirname(input)/AudioForge_output)에 생성되게 한다. finally에서 자신이 만든 UUID 폴더만 삭제.
import { randomUUID, createHash } from 'crypto'
import { execSync } from 'child_process'
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

// os.tmpdir()의 파생 참조 클립 임시폴더 목록(audioforge_refclip_*). 종료 후 0이어야 정상.
export function refClipDirs() {
  try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('audioforge_refclip_')) } catch { return [] }
}

// 합성 output_dir(base) 아래 .qwen-job-* 중간 산출물 폴더 목록(2단계까지). 종료 후 0이어야 정상.
export function qwenJobDirs(base) {
  const out = []
  let top = []
  try { top = fs.readdirSync(base, { withFileTypes: true }) } catch { return out }
  for (const d of top) {
    if (!d.isDirectory()) continue
    const sub = path.join(base, d.name)
    if (d.name.startsWith('.qwen-job-')) out.push(sub)
    try { for (const c of fs.readdirSync(sub, { withFileTypes: true })) if (c.isDirectory() && c.name.startsWith('.qwen-job-')) out.push(path.join(sub, c.name)) } catch { /* ignore */ }
  }
  return out
}

// Qwen 브리지 자식(격리 venv python.exe) PID 목록. 조회 명령 자신을 배제하려 name='python.exe'로 좁힌다.
// 종료 후 0이어야 정상(worker/venv 자식 잔존 없음). win32 전용, 그 외엔 [].
export function qwenVenvPids() {
  if (process.platform !== 'win32') return []
  try {
    const out = execSync(
      'wmic process where "name=\'python.exe\' and commandline like \'%qwen3_tts_venv%\'" get processid',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number)
  } catch { return [] }
}

// GPU 0의 (used, free) MiB — 장치 선택 근거 기록용(측정 실패 시 null). WDDM에서 per-process는 N/A.
export function nvidiaSmiGpu0() {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader,nounits',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.split(/\r?\n/).find(l => /\d/.test(l))
    if (!line) return null
    const [used, free] = line.split(',').map(s => Number(s.trim()))
    return { used, free }
  } catch { return null }
}
