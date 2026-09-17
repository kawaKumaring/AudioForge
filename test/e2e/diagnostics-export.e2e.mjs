// 로그 파일 + 진단 묶음 내보내기 — 실제 앱에서 확인한다(GPU 없음, 합성 없음).
//
// 보는 것
//   · 앱이 뜨면 <userData>/logs/audioforge-<날짜>.log 가 생기고 기동 기록이 있다
//   · renderer 의 console.error 가 main 을 거쳐 파일에 남는다(화면 오류가 로그에 닿는가)
//   · 시작 화면의 '진단 묶음 내보내기' 를 누르면 지정 폴더에 묶음이 생기고 화면이 결과를 말한다
//   · 묶음에는 summary.txt 와 logs/ 가 있고, 설정에 심어 둔 **대사 본문·폴더 값은 어디에도 없다**
//
// 실행: node test/e2e/diagnostics-export.e2e.mjs   (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
const DIAG = fs.mkdtempSync(path.join(os.tmpdir(), 'af-diag-out-'))
const SECRET_TEXT = '검사용_비밀_대사_본문_4e2c'
const SECRET_DIR = 'E:/검사용_비밀폴더_91ab'
// 설정 파일에 값이 있는 상태로 시작한다 — 묶음이 값을 옮기지 않는지 보려면 값이 있어야 한다.
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  lastDir: SECRET_DIR,
  workDrafts: { 'k': { ttsText: SECRET_TEXT, speakerMode: 'single', savedAt: 1 } },
  playbackVolume: 0.7,
}), 'utf-8')

let failed = 0
const log = (...a) => console.log('[diag]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function everyFileText(dir) {
  let out = ''
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name)
    out += n.isDirectory() ? everyFileText(p) : fs.readFileSync(p, 'utf-8')
  }
  return out
}

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_DIAG_DIR: DIAG },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore, undefined, { timeout: 30000 })

  // ── 로그 파일 ────────────────────────────────────────────────────────────
  const logDir = path.join(UD, 'logs')
  let logFiles = []
  for (let i = 0; i < 20 && logFiles.length === 0; i++) {
    await sleep(250)
    try { logFiles = fs.readdirSync(logDir).filter((n) => /^audioforge-\d{4}-\d{2}-\d{2}\.log$/.test(n)) } catch { logFiles = [] }
  }
  ok(logFiles.length === 1, '기동하면 오늘 날짜 로그 파일 하나가 생긴다', JSON.stringify(logFiles))
  const logPath = path.join(logDir, logFiles[0] || 'none')
  const boot = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
  ok(/INFO {2}\[boot\] /.test(boot), '기동 기록이 있다(판·전자 판·노드 판)')
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} /m.test(boot), '줄 머리가 현지 시각이다')

  await win.evaluate(() => console.error('[e2e-probe] 화면 오류 흘려보내기 PROBE_7f2e'))
  let mirrored = false
  for (let i = 0; i < 20 && !mirrored; i++) {
    await sleep(250)
    mirrored = fs.readFileSync(logPath, 'utf-8').includes('PROBE_7f2e')
  }
  ok(mirrored, '화면(renderer)의 console.error 가 로그 파일에 닿는다')
  ok(/ERROR \[console\] .*PROBE_7f2e/.test(fs.readFileSync(logPath, 'utf-8')), '수준 ERROR · 꼬리표 console 로 남는다')

  // ── 진단 묶음 ────────────────────────────────────────────────────────────
  const btn = win.getByTestId('export-diagnostics')
  ok(await btn.count() === 1, "시작 화면에 '진단 묶음 내보내기' 가 있다")
  await btn.click()
  const result = win.getByTestId('export-diagnostics-result')
  await result.waitFor({ timeout: 10000 })
  const resultText = (await result.textContent()) || ''
  ok(/진단 묶음을 만들었습니다/.test(resultText), '화면이 만들었다고 말한다', resultText.slice(0, 80))

  const bundles = fs.readdirSync(DIAG).filter((n) => n.startsWith('AudioForge_진단_'))
  ok(bundles.length === 1, '지정 폴더에 묶음 폴더 하나가 생긴다', JSON.stringify(bundles))
  const bdir = path.join(DIAG, bundles[0] || 'none')
  ok(resultText.includes(bundles[0] || '∅'), '화면이 말한 이름이 실제 폴더 이름이다')
  ok(fs.existsSync(path.join(bdir, 'summary.txt')), 'summary.txt 가 있다')
  const copied = fs.existsSync(path.join(bdir, 'logs')) ? fs.readdirSync(path.join(bdir, 'logs')) : []
  ok(copied.length === 1 && copied[0] === logFiles[0], '오늘 로그가 복사돼 있다', JSON.stringify(copied))
  const summary = fs.readFileSync(path.join(bdir, 'summary.txt'), 'utf-8')
  ok(/version: \d+\.\d+\.\d+/.test(summary), '요약에 앱 판이 있다')
  ok(/^workDrafts: 객체\(키 1개\)$/m.test(summary) && /^lastDir: 문자열\(글자 \d+\)$/m.test(summary), '설정은 모양만 적힌다')
  ok(summary.includes('PROBE_7f2e') === false, '요약에는 로그 본문이 섞이지 않는다')
  const all = everyFileText(bdir)
  ok(!all.includes(SECRET_TEXT), '**대사 본문이 묶음 어디에도 없다**')
  ok(!all.includes('검사용_비밀폴더'), '**설정의 폴더 값이 묶음 어디에도 없다**')
  ok(fs.readFileSync(logPath, 'utf-8').includes('진단 묶음 완료 name=' + bundles[0]), '내보낸 사실도 로그에 남는다')
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(DIAG, { recursive: true, force: true }) } catch { /* noop */ }
}

log(failed === 0 ? '전부 통과 — 로그가 남고, 진단 묶음이 값 없이 만들어진다.' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
