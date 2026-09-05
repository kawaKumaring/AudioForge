// 현재 작업 자동 저장·복원 — 개발 앱을 **두 번** 띄워 확인한다(격리 userData·격리 입력).
//
// 핵심 흐름: 목소리 지정 → 구간 확정 → **합성하지 않고** 종료 → 재실행 → 같은 인물·목소리·구간 자동 복원.
// 곁들여: 임시 클립이 사라진 뒤 저장된 구간으로 자동 복구되는지, 한 명의 참조 해제가 여러 명의 참조를
// 손상시키지 않는지. GPU·음성 생성 없음(구간 확정까지만). 사용자 파일은 건드리지 않는다.
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedInput, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
const iso = isolatedInput(path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav'))
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-workrestore-'))
const PORT = 9870 + (process.pid % 40)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const ok = (id, pass, what, detail = '') => {
  results.push({ id, pass: !!pass, what, detail })
  console.log(`[work] ${pass ? 'PASS' : 'FAIL'} ${id} ${what}${detail ? ' — ' + detail : ''}`)
}

let child = null
let childExited = true
const killOwnTree = () => {
  if (childExited || !child?.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ }
}
async function waitForCdp(ms) {
  const t0 = Date.now()
  for (;;) {
    if (childExited) return false
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true } catch { /* */ }
    if (Date.now() - t0 > ms) return false
    await sleep(500)
  }
}

/** 같은 userData 로 앱을 띄우고 renderer 페이지를 돌려준다. */
async function boot() {
  childExited = false
  child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT) },
  })
  child.stdout.setEncoding('utf-8'); child.stdout.on('data', () => {})
  child.stderr.setEncoding('utf-8'); child.stderr.on('data', () => {})
  child.on('exit', () => { childExited = true })
  if (!(await waitForCdp(240000))) throw new Error('BOOT_TIMEOUT')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i += 1) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
      if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('NO_PAGE')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })
  return { browser, page }
}

async function shutdown(browser) {
  try { await browser?.close() } catch { /* */ }
  killOwnTree()
  for (let i = 0; i < 40 && !childExited; i += 1) await sleep(250)
}

const speakerSnapshot = (page) => page.evaluate(() => {
  const s = window.__afStore.getState()
  return {
    mode: s.ttsSpeakerMode, text: s.ttsText, refs: s.ttsSpeakerRefState,
    labels: s.ttsSpeakerLabels, defaultClip: s.ttsReferenceClip,
  }
})

let browser = null
try {
  // ── 1차 실행: 목소리 지정 + 구간 확정, 합성은 하지 않는다 ──
  {
    const b = await boot(); browser = b.browser
    const page = b.page
    ok('boot1', true, '1차 실행 기동')
    const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200) } return false }

    await page.evaluate(async (fp) => {
      const s = window.__afStore
      s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp))
      s.getState().setMode('tts')
    }, iso.input)
    await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
    await page.click('[data-testid="dialogue-tabs"] [data-tab="multi"]')
    // 첫 인물이 기본 목소리를 이어받아 확정 구간까지 준비되기를 기다린다(18초 원본 → 자동 구간 확정).
    const ready1 = await waitUntil(async () => {
      const s = await speakerSnapshot(page)
      const one = Object.values(s.refs)[0]
      return !!one && one.ready === true && !!one.clip && !!one.region
    }, 180000)
    const before = await speakerSnapshot(page)
    const firstId = Object.keys(before.refs)[0]
    ok('1', ready1 && !!firstId, '목소리 지정 + 구간 확정(합성 없음)',
      JSON.stringify({ id: firstId, region: before.refs[firstId]?.region }))

    // 자동 저장이 디스크에 닿을 시간을 준다(디바운스 0.7초).
    await sleep(2000)
    const settingsPath = path.join(USER_DATA, 'settings.json')
    let saved = null
    try { saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) } catch { saved = null }
    const draftKey = saved?.workDrafts?.drafts ? Object.keys(saved.workDrafts.drafts)[0] : null
    const savedSpeaker = draftKey ? saved.workDrafts.drafts[draftKey].speakers?.[firstId] : null
    ok('2', !!savedSpeaker && !!savedSpeaker.region && savedSpeaker.source === iso.input,
      '합성하지 않아도 인물·원본·확정 구간이 저장된다',
      JSON.stringify({ region: savedSpeaker?.region }))
    ok('3', !!saved && saved.voiceCasts == null && saved.referenceAssets == null,
      '자동 저장이 저장된 목소리 구성·전역 자산 등록부를 만들거나 바꾸지 않는다',
      JSON.stringify({ keys: Object.keys(saved || {}) }))

    // 합성하지 않았으므로 결과 폴더도 없어야 한다(session.json 이 없다는 사실이 이 검사의 전제다).
    const outRoot = path.join(path.dirname(iso.input), 'AudioForge_output')
    ok('4', !fs.existsSync(outRoot), '합성하지 않았으므로 기존 결과 기록(session.json)은 없다')

    global.__before = { firstId, region: before.refs[firstId]?.region, clip: before.refs[firstId]?.clip, text: before.text, mode: before.mode }
    await shutdown(browser); browser = null
  }

  // ── 2차 실행: 같은 userData·같은 원본 → 자동 복원 ──
  {
    const b = await boot(); browser = b.browser
    const page = b.page
    ok('boot2', true, '2차 실행 기동(같은 설정 폴더)')
    const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200) } return false }
    const B = global.__before

    await page.evaluate(async (fp) => {
      const s = window.__afStore
      s.getState().setFile(await window.api.audio.getFileInfo(fp), await window.api.audio.getFileUrl(fp))
      s.getState().setMode('tts')
    }, iso.input)
    await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })

    // 복원이 끝나기 전 상태 — 그 인물은 '목소리 준비 중' 이고 준비됨이 아니다.
    const sawPreparing = await waitUntil(async () => {
      const s = await speakerSnapshot(page)
      const one = s.refs[B.firstId]
      return !!one && one.ready === false && one.message === '목소리 준비 중'
    }, 20000)
    ok('5', sawPreparing, '복원 중에는 준비됨이 아니라 목소리 준비 중으로 보인다')

    const restored = await waitUntil(async () => {
      const s = await speakerSnapshot(page)
      const one = s.refs[B.firstId]
      return !!one && one.ready === true && !!one.clip && !!one.region
    }, 180000)
    const after = await speakerSnapshot(page)
    const slot = after.refs[B.firstId]
    const sameRegion = !!slot?.region && !!B.region
      && Math.abs(slot.region.start - B.region.start) < 0.05
      && Math.abs(slot.region.duration - B.region.duration) < 0.05
    ok('6', restored && sameRegion && after.mode === B.mode && after.text === B.text,
      '재실행 후 같은 인물·목소리·구간이 사용자 조작 없이 복원된다',
      JSON.stringify({ before: B.region, after: slot?.region, mode: after.mode }))
    ok('7', restored && !!slot.clip && slot.clip !== B.clip,
      '임시 클립이 사라졌어도 저장된 구간으로 자동 재생성한다(같은 구간, 새 클립)',
      JSON.stringify({ regenerated: slot?.clip !== B.clip }))

    // 한 명의 참조를 해제해도 여러 명의 참조는 손상되지 않는다.
    const clipBefore = slot.clip
    await page.evaluate(() => window.api.audio.releaseReferenceClip('default'))
    await sleep(800)
    const afterRelease = await speakerSnapshot(page)
    const stillThere = await page.evaluate((p) => window.api.audio.sourcesPresent([p]), clipBefore)
    ok('8', afterRelease.refs[B.firstId]?.ready === true
      && afterRelease.refs[B.firstId]?.clip === clipBefore && stillThere[clipBefore] === true,
      '한 명의 참조 해제가 여러 명의 참조를 손상시키지 않는다',
      JSON.stringify({ ready: afterRelease.refs[B.firstId]?.ready, clipPresent: stillThere[clipBefore] }))

    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    await sleep(300)
    ok('err', errs.length === 0, 'renderer 오류 0', errs.slice(0, 2).join(' | '))
    await shutdown(browser); browser = null
  }
} catch (e) {
  ok('fatal', false, '치명 오류', String(e?.stack || e))
} finally {
  await shutdown(browser)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  cleanupIsolated(iso.dir)
  const fails = results.filter((r) => !r.pass).length
  console.log(`[work] SUMMARY pass=${results.length - fails} fail=${fails}`)
  process.exit(fails ? 1 : 0)
}
