// 화면 구조 확인용 — 참조를 올린 뒤 실제로 무엇이 보이는지 그대로 찍는다.
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
const REF = path.join(APP, '_local', 'experiments', 'seedvc-20260906', 'clean_src', '럭끼_평소_2p6s.wav')
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-probe-'))
const PORT = 9820
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
  cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT) },
})
let exited = false
child.on('exit', () => { exited = true })
child.stdout.on('data', () => {}); child.stderr.on('data', () => {})
const kill = () => { if (exited || !child.pid) return; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ } }

let browser = null
try {
  for (let i = 0; i < 480 && !exited; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* */ }
    await sleep(500)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) {
      if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break }
    }
    if (!page) await sleep(500)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })

  const dump = async (label) => {
    const d = await page.evaluate(() => ({
      mode: window.__afStore.getState().mode,
      file: window.__afStore.getState().fileInfo?.path || null,
      refReady: window.__afStore.getState().ttsRefReady,
      refMsg: window.__afStore.getState().ttsRefMessage,
      refClip: window.__afStore.getState().ttsReferenceClip,
      sections: [...document.querySelectorAll('section[aria-label]')].map((s) => s.getAttribute('aria-label')),
      testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((s) => s.getAttribute('data-testid')))],
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      textareas: document.querySelectorAll('textarea').length,
      editable: document.querySelectorAll('[contenteditable="true"]').length,
      afEditor: document.querySelectorAll('[data-af-tts-editor]').length,
      dialogueHtml: (document.querySelector('section[aria-label="대사"]')?.innerText || '').slice(0, 400),
      runHtml: (document.querySelector('[data-testid="run-section"]')?.innerText || '').slice(0, 400),
      voiceHtml: (document.querySelector('section[aria-label="목소리"]')?.innerText || '').slice(0, 300),
    }))
    console.log(`\n----- ${label} -----`)
    console.log('mode=%s refReady=%s refMsg=%s refClip=%s', d.mode, d.refReady, d.refMsg, JSON.stringify(d.refClip))
    console.log('file:', d.file)
    console.log('sections:', JSON.stringify(d.sections, null, 0))
    console.log('testids:', JSON.stringify(d.testids, null, 0))
    console.log('buttons:', JSON.stringify(d.buttons, null, 0))
    console.log('textarea=%d editable=%d afEditor=%d', d.textareas, d.editable, d.afEditor)
    console.log('--목소리--'); console.log(d.voiceHtml)
    console.log('--대사--'); console.log(d.dialogueHtml)
    console.log('--음성 만들기--'); console.log(d.runHtml)
  }

  await dump('초기')
  await page.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().reset()
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await sleep(3000)
  await dump('참조 올리고 tts 모드')
  await sleep(4000)
  await dump('7초 뒤')
} catch (e) {
  console.log('FATAL', e?.stack || e)
} finally {
  try { await browser?.close() } catch { /* */ }
  kill()
  for (let i = 0; i < 40 && !exited; i++) await sleep(250)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
}
