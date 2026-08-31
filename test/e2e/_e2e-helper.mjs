// E2E 격리 헬퍼 — 실제 사용자 자산(resources/)을 절대 건드리지 않는다.
// 입력 파일을 os.tmpdir()/audioforge_e2e_<UUID>/ 로 복사해 주입하고, 합성 출력도 그 격리 폴더 안
// (dirname(input)/AudioForge_output)에 생성되게 한다. finally에서 자신이 만든 UUID 폴더만 삭제.
import { randomUUID, createHash } from 'crypto'
import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

// 실 Qwen 게이트 공용 fixture 계약(test-only) — 명시적 AF_E2E_REFERENCE만 사용한다.
// speaker_b.wav 하드코딩·자동 검색·복사·fallback 없음. 오디오 decode·전사는 하지 않는다(실 Qwen 실행 전 금지).
// 검사: 미설정 / 파일 없음 / .wav 아님 / 최소 바이트 미만(빈·손상 방어; 지속시간은 decode 없이 검사 불가라
// 호출자가 요구하는 실제 길이는 사용자가 승인 자산으로 보장). 순수 함수(process.exit·decode 없음)라 단위테스트 가능.
export function validateE2EReferencePath(raw, { minBytes = 64 * 1024 } = {}) {
  const p = (raw || '').trim()
  if (!p) return { ok: false, kind: 'unset', reason: 'AF_E2E_REFERENCE 미설정' }
  if (!fs.existsSync(p)) return { ok: false, kind: 'missing', reason: '경로에 파일 없음' }
  if (path.extname(p).toLowerCase() !== '.wav') return { ok: false, kind: 'ext', reason: '.wav 확장자 아님' }
  const bytes = fs.statSync(p).size
  if (bytes < minBytes) return { ok: false, kind: 'small', reason: `파일 크기 ${bytes}B < 최소 ${minBytes}B` }
  return { ok: true, path: p, bytes }
}

// exit 래퍼 — 미설정은 SKIP(prerequisite), 잘못된 값은 명시 오류. 어느 경우든 경로·내용을 로그로 출력하지 않는다.
export function requireE2EReference(opts = {}) {
  const r = validateE2EReferencePath(process.env.AF_E2E_REFERENCE, opts)
  if (!r.ok) {
    if (r.kind === 'unset') {
      console.error('SKIP(prerequisite): AF_E2E_REFERENCE 미설정 — 실 Qwen 게이트는 명시 참조 자산이 필요합니다. speaker_b.wav 자동 fallback·검색 없음.')
    } else {
      console.error(`prerequisite 오류: AF_E2E_REFERENCE ${r.reason} (경로·내용 미출력).`)
    }
    process.exit(2)
  }
  return r.path   // 유효 경로 반환(로그로 출력하지 않는다)
}

// test-only synthetic WAV 생성(사용자 미디어 미사용). 순수 Node Buffer로 PCM16 mono sine WAV를 쓴다.
// 이번 실행 전용 임시 경로에 만들고, 호출부가 finally에서 정확히 그 경로만 정리한다(resources/외부 파일 무접촉).
export function makeSyntheticWav(destPath, seconds = 30, sampleRate = 24000, freq = 180) {
  const n = Math.floor(seconds * sampleRate)
  const dataSize = n * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  const amp = Math.round(0.06 * 32767), w = (2 * Math.PI * freq) / sampleRate
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * Math.sin(w * i)), 44 + i * 2)
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, buf)
  return destPath
}

// 이번 실행이 만든 synthetic 소스 파일만 안전 삭제(존재할 때만, 정확 경로).
export function cleanupSyntheticWav(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch { /* noop */ }
}

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
// ── Qwen 워커 프로세스 관측(공용 마감 K2-보완) ──
// Windows 11(26200)에서 wmic가 제거되어 과거 구현은 항상 [] 반환(관측 불가)했다. PowerShell CIM으로 교체하고,
// '현재 worktree'의 qwen_bridge.py를 실행 중인 Qwen venv 프로세스만 스코프한다(다른 AudioForge checkout·ComfyUI 제외).
// 열거/파싱 실패는 조용한 []가 아니라 명확히 throw한다(테스트 관측 실패를 은폐 금지).

// 경로 정규화: slash 방향 통일 + 소문자(Windows 대소문자 무시). 순수 함수(단위테스트 대상).
export function normPathForMatch(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase()
}

// CIM ConvertTo-Json 출력 파싱: 단일 객체/배열/빈 출력 처리. 비어있지 않은데 JSON이 아니면 throw.
export function parseCimProcJson(out) {
  const t = (out || '').trim()
  if (!t || t === 'null') return []            // 결과 없음(정상) — 파싱 실패와 구분
  let v
  try { v = JSON.parse(t) } catch (e) { throw new Error(`CIM JSON 파싱 실패: ${(e && e.message) || e}`) }
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

// 순수 필터(단위테스트 대상): procs 중 (Qwen venv 실행) AND (CommandLine에 현재 worktree bridge 경로 포함)만.
// bridgeCandidates = 현재 worktree qwen_bridge.py의 후보 경로들(resolve/realpath). 다른 candidate는 제외 근거.
export function filterWorktreeQwenPids(procs, bridgeCandidates) {
  const cands = (Array.isArray(bridgeCandidates) ? bridgeCandidates : [bridgeCandidates])
    .map(normPathForMatch).filter(Boolean)
  if (!cands.length) return []
  const out = []
  for (const p of (procs || [])) {
    const cmd = normPathForMatch(p.CommandLine)
    const exe = normPathForMatch(p.ExecutablePath)
    const isQwenVenv = cmd.includes('qwen3_tts_venv') || exe.includes('qwen3_tts_venv')
    const isThisWorktreeBridge = cands.some(c => cmd.includes(c))  // 최종 식별 권위 = 현재 worktree bridge 경로
    if (isQwenVenv && isThisWorktreeBridge) {
      const pid = Number(p.ProcessId)
      if (Number.isFinite(pid)) out.push(pid)
    }
  }
  return out
}

// 현재 worktree의 python/qwen_bridge.py 후보 경로(resolve + realpath). junction 대비 두 형태 모두 대조.
export function qwenBridgePathCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url))          // <worktree>/test/e2e
  const resolved = path.resolve(here, '..', '..', 'python', 'qwen_bridge.py')
  const set = new Set([resolved])
  try { set.add(fs.realpathSync(resolved)) } catch { /* 파일 없거나 realpath 불가 — resolved만 */ }
  return [...set]
}

// 실제 프로세스 열거(PowerShell CIM). execFile+인자 전달(shell 문자열 조합 회피). 실패는 throw.
export function enumWin32Processes() {
  const psScript = "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Depth 2 -Compress"
  let out
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`프로세스 열거 실패(powershell/CIM): ${(e && e.message) || e}`)
  }
  return parseCimProcJson(out)
}

// 현재 worktree의 Qwen bridge를 실행 중인 프로세스 PID들. 비-Windows는 []. 열거/파싱 실패는 throw.
export function qwenVenvPids() {
  if (process.platform !== 'win32') return []
  return filterWorktreeQwenPids(enumWin32Processes(), qwenBridgePathCandidates())
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

// ── E2E 전용 userData 격리 ────────────────────────────────────────────────────
//
// 앱은 `AF_E2E=1` + `AF_E2E_USER_DATA` 일 때만 userData 를 옮긴다. 이걸 주지 않으면
// 테스트가 **사용자의 실제 userData** 를 쓴다. 거기에 이전에 고른 참조가 남아 있으면
// 파일을 새로 넣어도 앱이 곧바로 ready 가 되어 파생 클립을 만들지 않는다 — 실제로
// reset-cleanup 이 그 이유로 깨졌고, synthesize 는 그 이유로 4초 만에 '통과' 했다.
// 검증한 것이 없는 초록이 가장 나쁘다.

const USER_DATA_PREFIX = 'audioforge-e2e-userdata-'

/** 이번 실행 전용 빈 userData 를 만든다. 반환 경로는 절대경로다. */
export function isolatedUserData() {
  const dir = path.join(os.tmpdir(), USER_DATA_PREFIX + randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 시작 시점에 정말 비어 있는지 — 남은 선택 참조·클립이 하나도 없어야 한다. */
export function userDataIsPristine(dir) {
  const lib = path.join(dir, 'reference-library')
  if (fs.existsSync(path.join(lib, 'selection.json'))) return false
  let files = []
  try { files = fs.readdirSync(lib) } catch { return true }   // 폴더 자체가 없으면 깨끗하다
  return files.length === 0
}

/** 이 userData 안에 실제로 생긴 것들(참조 라이브러리 파일 목록). */
export function userDataArtifacts(dir) {
  const lib = path.join(dir, 'reference-library')
  try { return fs.readdirSync(lib).sort() } catch { return [] }
}

/**
 * 임시 userData 정리 — **이번 테스트가 만든 정확히 그 경로 하나만** 지운다.
 *
 * 링크를 품은 트리를 재귀 삭제해 공용 자산을 지운 사고가 있었다. 그래서 지우기 전에
 * 절대경로·부모가 tmpdir·정해진 prefix·reparse point 아님을 모두 확인하고, 하나라도
 * 어긋나면 지우지 않고 사유를 돌려준다. 실패한 실행은 호출부가 아예 부르지 않는다.
 */
export function cleanupUserData(dir) {
  if (!dir || !path.isAbsolute(dir)) return 'ABS_PATH_아님'
  if (path.dirname(dir) !== os.tmpdir()) return '부모가_tmpdir_아님'
  if (!path.basename(dir).startsWith(USER_DATA_PREFIX)) return 'prefix_불일치'
  let st
  try { st = fs.lstatSync(dir) } catch { return '이미_없음' }
  if (st.isSymbolicLink() || (st.mode & 0o170000) === 0o120000) return 'reparse_point_삭제안함'
  try { fs.rmSync(dir, { recursive: true, force: true }); return null } catch (e) { return String(e && e.code) }
}

/**
 * 사용자의 **실제** userData 지문 — 이름·크기·mtime 만. 내용은 읽지 않는다.
 * 테스트가 실제 사용자 자산을 건드리지 않았음을 전후 비교로 보이기 위한 것이다.
 */
export function realUserDataFingerprint() {
  const root = path.join(process.env.APPDATA || '', 'audio-forge')
  const rows = []
  function walk(d, rel) {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { rows.push('D ' + r); walk(full, r) }
      else {
        let s
        try { s = fs.statSync(full) } catch { rows.push('F ' + r + ' ?'); continue }
        rows.push(`F ${r} ${s.size} ${s.mtimeMs}`)
      }
    }
  }
  walk(root, '')
  return rows.join('\n')
}
