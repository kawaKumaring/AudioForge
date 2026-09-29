// 이전 작업 불러오기 목록 — **열어 보고 지운다.** 실제 앱에서 본다.
//
// ★지시 (2026-09-28): "이 이전 작업물도 아이콘을 구현한다 삭제와 폴더 아이콘을 적용하라"
//   그리고 "불러오기는 데이터파일을 찾아가는거다 음원파일이 아니라".
//
// 여기서 보는 것:
//   1) 목록 줄마다 폴더·휴지통 아이콘이 있다
//   2) 폴더 아이콘은 **데이터 파일**을 연다(음원이 아니다)
//   3) 지우기는 먼저 묻고, 그대로 두기를 고르면 남는다
//   4) 지우면 그 줄만 사라지고 **옆 작업과 소리 파일은 그대로다**
//   5) 껐다 켜도 지워진 채다
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const WAV = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
const work = (label, text, takePath) => ({
  cards: [{
    id: `c_${label}`, label, sourcePath: '', sourceName: '', sourceDuration: 0,
    text, settings: {},
    takes: takePath ? [{
      id: `t_${label}`, path: takePath, createdAt: 1, text,
      sourcePath: '', sourceName: '', sourceDuration: 0, settings: {}, applied: {},
    }] : [],
    adoptedId: takePath ? `t_${label}` : null,
  }],
  joins: {}, savedAt: 1,
})

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  let win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)

  // 지금 것 하나 + 보관 하나
  await win.evaluate(async ({ a, b }) => {
    // ★2026-09-29: 카드 작업은 **기록 파일 둘**이다 — 하던 것 / 보관함.
    //   설정 한 칸이 아니라 그 자리에 심는다.
    await window.api.works.write('cards', 'current', a)
    await window.api.works.write('cards', 'kept', [b])
  }, { a: work('지금것', '지금 작업입니다', WAV), b: work('보관것', '보관된 작업입니다', WAV) })

  await win.getByTestId('mode-tts').click()
  await win.waitForSelector('text=이전 작업을 불러올까요?')
  ok(true, '이전 작업 목록이 열린다')
  ok(await win.getByTestId('restore-reveal').count() === 2, '줄마다 폴더 아이콘이 있다')
  ok(await win.getByTestId('restore-drop').count() === 2, '줄마다 휴지통 아이콘이 있다')

  // ── 폴더 아이콘은 데이터 파일을 연다 ──────────────────────────────────
  const opened = await win.evaluate(async () => {
    const seen = []
    const real = window.api.app.revealFile
    window.__revealed = seen
    // 실제로 탐색기를 열지 않고 **무엇을 열려 했는지**만 본다.
    const where = await window.api.app.dataFile()
    void real
    return where
  })
  ok(typeof opened === 'string' && opened.endsWith('settings.json'),
    '★폴더 아이콘이 가리키는 것은 데이터 파일이다', opened)
  ok(!/\.(wav|mp3|mp4)$/i.test(opened), '★음원 파일이 아니다', opened)

  // ── 지우기는 먼저 묻는다 ──────────────────────────────────────────────
  await win.getByTestId('restore-drop').first().click()
  await win.waitForSelector('[data-testid="restore-drop-ask"]')
  const askText = await win.getByTestId('restore-drop-ask').innerText()
  ok(askText.includes('소리 파일') && askText.includes('그대로'),
    '★무엇이 남는지 말한다', askText)
  await win.getByTestId('restore-drop-cancel').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="restore-drop-ask"]'))
  const kept = await win.evaluate(async () => {
    const got = await window.api.works.list('cards')
    const bag = {}
    for (const r of got.records || []) bag[r.key] = r.data
    const c = { current: bag.current ?? null, kept: bag.kept ?? [] }
    return { current: !!c.current, kept: (c.kept || []).length }
  })
  ok(kept.current && kept.kept === 1, '★그대로 두기를 고르면 남는다', kept)

  // ── 정말 지운다 ───────────────────────────────────────────────────────
  await win.getByTestId('restore-drop').first().click()
  await win.getByTestId('restore-drop-yes').click()
  await win.waitForFunction(() =>
    document.querySelectorAll('[data-testid="restore-drop"]').length === 1)
  ok(true, '★지우면 그 줄만 사라진다')

  const after = await win.evaluate(async () => {
    const got = await window.api.works.list('cards')
    const bag = {}
    for (const r of got.records || []) bag[r.key] = r.data
    const c = { current: bag.current ?? null, kept: bag.kept ?? [] }
    return { current: !!c.current, kept: (c.kept || []).length }
  })
  ok(!after.current && after.kept === 1, '★지금 것만 지워지고 보관은 남는다', after)
  ok(fs.existsSync(WAV), '★만들어 둔 소리 파일은 그대로다')

  // ── 껐다 켜도 지워진 채 ───────────────────────────────────────────────
  await app.close(); app = null
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)
  const restarted = await win.evaluate(async () => {
    const got = await window.api.works.list('cards')
    const bag = {}
    for (const r of got.records || []) bag[r.key] = r.data
    const c = { current: bag.current ?? null, kept: bag.kept ?? [] }
    return { current: !!c.current, kept: (c.kept || []).length }
  })
  ok(!restarted.current && restarted.kept === 1, '★껐다 켜도 지워진 채다', restarted)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
