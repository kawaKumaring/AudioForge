// 채널별 사용자 데이터 폴더 — 실제 앱 기동으로 확인한다(GPU 없음, 합성 없음).
//
// 이 저장소의 판은 -dev(개발선)다. 그래서 앱은 기본 폴더(audio-forge)가 아니라 옆의 audio-forge-dev 를
// 써야 하고, 처음 뜰 때 정식 폴더의 앱 데이터(설정·참조·생성본)만 한 번 복사하되 원본은 그대로 두어야 한다.
//
// AF_E2E_USER_DATA_BASE: 실제 %APPDATA% 대신 이 폴더를 "부모" 로 삼는다(그 아래 audio-forge / audio-forge-dev).
// 실행: node test/e2e/user-data-channel.e2e.mjs   (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf-8')).version
if (!/-dev(\.|\+|$|-)/.test(pkgVersion)) { console.error(`이 검사는 개발선 판에서만 뜻이 있다(현재 ${pkgVersion})`); process.exit(2) }

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'af-udbase-'))
const STABLE = path.join(BASE, 'audio-forge')
const DEV = path.join(BASE, 'audio-forge-dev')
fs.mkdirSync(path.join(STABLE, 'lab-takes', 'doc1'), { recursive: true })
fs.mkdirSync(path.join(STABLE, 'Cache'), { recursive: true })
fs.writeFileSync(path.join(STABLE, 'settings.json'), JSON.stringify({ playbackVolume: 0.42, lastDir: 'E:/검사용' }), 'utf-8')
fs.writeFileSync(path.join(STABLE, 'lab-takes', 'doc1', 'take.wav'), Buffer.alloc(128, 3))
fs.writeFileSync(path.join(STABLE, 'Cache', 'junk.bin'), Buffer.alloc(2048, 9))

function fingerprint(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, n.name); const r = rel + '/' + n.name
      if (n.isDirectory()) walk(p, r); else out.push(`${r}:${fs.statSync(p).size}`)
    }
  }
  walk(dir, ''); return out.join('\n')
}
const stableBefore = fingerprint(STABLE)

let failed = 0
const log = (...a) => console.log('[udc]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA_BASE: BASE },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })
  return { app, win }
}

let app = null
try {
  // ── 1회차: 개발선 폴더가 없다 → 만들고 앱 데이터만 복사 ────────────────────────
  ;({ app } = await launch())
  await sleep(500)
  ok(fs.existsSync(DEV), '개발선 판은 audio-forge-dev 폴더를 만든다')
  ok(fs.existsSync(path.join(DEV, 'settings.json')) &&
     JSON.parse(fs.readFileSync(path.join(DEV, 'settings.json'), 'utf-8')).playbackVolume === 0.42,
     '정식 폴더의 설정이 복사돼 있다(값 그대로)')
  ok(fs.existsSync(path.join(DEV, 'lab-takes', 'doc1', 'take.wav')), '생성본 폴더도 복사된다')
  ok(!fs.existsSync(path.join(DEV, 'Cache', 'junk.bin')), 'Electron 캐시 파일은 옮기지 않는다')
  const marker = fs.existsSync(path.join(DEV, 'seeded-from.json')) ? JSON.parse(fs.readFileSync(path.join(DEV, 'seeded-from.json'), 'utf-8')) : null
  ok(!!marker && marker.fromDirName === 'audio-forge', '복사한 사실이 표식 파일에 남는다', JSON.stringify(marker))
  ok(!!marker && !JSON.stringify(marker).includes(BASE), '표식에 절대 경로가 없다')
  const logDir = path.join(DEV, 'logs')
  const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir) : []
  ok(logFiles.length === 1, '로그도 개발선 폴더 안에 생긴다', JSON.stringify(logFiles))
  const logText = logFiles.length ? fs.readFileSync(path.join(logDir, logFiles[0]), 'utf-8') : ''
  ok(/\[boot\] 데이터 폴더 audio-forge-dev/.test(logText), '어느 데이터 폴더를 쓰는지 기동 기록에 남는다')
  ok(/복사 settings\.json/.test(logText), '무엇을 복사했는지도 남는다')
  ok(!fs.existsSync(path.join(STABLE, 'logs')), '정식 폴더에는 로그를 남기지 않는다(읽기만)')
  ok(fingerprint(STABLE) === stableBefore, '**정식 폴더는 이름·크기 그대로다**')
  await app.close(); app = null

  // ── 2회차: 개발선에서 바꾼 값이 정식 값으로 되돌아가지 않는다 ─────────────────
  fs.writeFileSync(path.join(DEV, 'settings.json'), JSON.stringify({ playbackVolume: 0.77 }), 'utf-8')
  ;({ app } = await launch())
  await sleep(500)
  ok(JSON.parse(fs.readFileSync(path.join(DEV, 'settings.json'), 'utf-8')).playbackVolume === 0.77,
     '두 번째 기동은 다시 복사하지 않는다')
  const log2 = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf-8')
  ok(/이미 초기화됨|already/.test(log2) || (log2.match(/데이터 폴더 audio-forge-dev/g) || []).length === 2,
     '두 번째 기동 기록도 남는다')
  ok(fingerprint(STABLE) === stableBefore, '정식 폴더는 여전히 그대로다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 개발선은 자기 폴더를 쓰고, 정식 폴더는 읽기만 한다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
