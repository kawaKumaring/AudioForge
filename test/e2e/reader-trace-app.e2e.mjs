// 낭독 관측 기록 — **실제 앱에서** 본체 단계 길이가 화면 기록까지 오는가, 실행 방식이 붙는가(2026-10-03).
// 실제 앱 · 기본 목소리(CPU, Supertonic 상주) · 검사용 TXT. GPU 없음 — 성능을 재는 검사가 아니다(기록의 모양·출처만 본다).
// 실행: node test/e2e/reader-trace-app.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const BOOK = path.join(ISO, '관측 검사 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 12 }, (_, i) => `관측 검사 ${i + 1}번째 문단입니다. 그는 천천히 문을 열고 복도를 내다보았다.`).join('\n'), 'utf-8')
let passed = 0
const fails = []
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
let app = null
const launch = async (extra = {}) => {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK, ...extra } })
  const win = await app.firstWindow(); win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore); await enterStudio(win)
  await win.getByTestId('mode-reader').click()
  await win.waitForFunction(() => !!window.__readerStore && !!window.__readerTrace)
  return win
}
const dump = (win) => win.evaluate(() => window.__readerTrace.dump())
try {
  let win = await launch()
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-paragraph"]')
  await win.waitForFunction(() => !!window.__readerStore.getState().pick)
  ok((await dump(win)).mode === 'test(prep-off)', '★검사 모드 기록에는 실행 방식 test(prep-off) 가 붙는다')
  await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.first), null, { timeout: 90000 })
  const E = (await dump(win)).events
  const made = E.filter((e) => e.ev === 'gen-done' && !e.cached && e.ok)
  ok(made.length >= 1 && made.every((e) => typeof e.makeMs === 'number' && typeof e.waitMs === 'number' && e.engine === 'supertonic-resident' && typeof e.modelOpened === 'boolean'),
    '★본체 단계 길이(줄 대기·생성)·엔진·모델 처음 엶이 실제 앱 기록에 온다', made.slice(0, 2))
  ok(made.filter((e) => e.modelOpened).length <= 1, '모델을 처음 연 것은 많아야 한 번(상주)', made.map((e) => e.modelOpened))
  const p = E.find((e) => e.ev === 'play-start' && e.first)
  ok(p && p.after === 'start' && p.sinceRequestMs >= 0, '시작 누름부터 실제 재생 시작까지 기록', p)

  // 문단 이동 → 새 자리 실제 재생
  await win.evaluate(() => window.__readerTrace.clear())
  await win.getByTestId('reader-paragraph').nth(8).click()
  await win.waitForFunction(() => window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.after === 'seek'), null, { timeout: 60000 })
  const S = (await dump(win)).events
  ok(S.some((e) => e.ev === 'seek-request') && S.some((e) => e.ev === 'play-start' && e.after === 'seek' && e.sinceRequestMs >= 0), '★문단 이동 후 첫 소리가 기록된다', S.filter((e) => /seek|play-start/.test(e.ev)))
  await win.getByTestId('reader-play').click()        // 멈춤

  // 다시 누르면 큐가 들고 있는 소리를 쓴다(요청 없음) — 그 사실이 기록된다
  await win.evaluate(() => window.__readerTrace.clear())
  await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.first), null, { timeout: 60000 })
  const R = (await dump(win)).events
  ok(R.find((e) => e.ev === 'play-request')?.readyAtRequest === true, '누르기 전에 이미 만들어 둔 자리는 readyAtRequest 로 기록된다', R.find((e) => e.ev === 'play-request'))
  await win.getByTestId('reader-play').click()        // 멈춤

  // 디스크 캐시 적중 — 목소리를 B 로 바꿨다가 A 로 되돌리면 큐는 비지만 만든 소리 파일은 남는다
  const A = await win.evaluate(() => window.__readerStore.getState().pick)
  const voices = (await win.evaluate(() => window.api.cards.builtinVoices()))?.data?.voices || []
  const B = voices.find((v) => v.engineId === A.engineId && v.path !== A.path)
  await win.evaluate((b) => window.__readerStore.setState({ pick: { kind: 'builtin', path: b.path, engineId: b.engineId, modelId: b.modelId, label: b.label } }), B)
  await win.waitForTimeout(800)
  // ★기본 목소리(CPU)는 고르자마자 앞서 만든다 — 되돌리기 **전에** 기록을 비워야 그 요청(디스크 캐시 조회)이 보인다.
  await win.evaluate(() => window.__readerTrace.clear())
  await win.evaluate((a) => window.__readerStore.setState({ pick: a }), A)
  await win.waitForTimeout(800)
  await win.getByTestId('reader-play').click()
  await win.waitForFunction(() => window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.first), null, { timeout: 60000 })
  const C = (await dump(win)).events
  ok(C.some((e) => e.ev === 'gen-done' && e.cached === true), '★다시 들은 자리는 캐시 적중으로 기록된다', C.filter((e) => e.ev === 'gen-done'))
  const all = JSON.stringify(await dump(win)) + JSON.stringify(E) + JSON.stringify(S)
  ok(!all.includes('관측 검사') && !all.includes(ISO) && !/[A-Z]:\\\\/.test(all), '기록에 본문·경로가 없다')
  await app.close(); app = null

  // 보통 실행과 같은 준비를 고른 측정 실행 — 실행 방식 표시만 본다(GPU 를 쓰는 준비는 부르지 않는다)
  win = await launch({ AF_E2E_NORMAL_PREP: '1' })
  ok((await dump(win)).mode === 'test-normal-prep', '★측정 실행(AF_E2E_NORMAL_PREP=1)은 test-normal-prep 로 표시된다')
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD)
  cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
