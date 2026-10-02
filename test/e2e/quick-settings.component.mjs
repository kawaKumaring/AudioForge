// 빠른 설정과 세부 옵션 — **같은 것을 두 번 보여 주지 않는가, 지금 값이 보이는가.**
//
// ★2026-09-27 지시 6: "빠른 설정에 없는 모델을 사용 중이면 '세부 설정 사용 중'만 표시하지 말고
//   현재 모델 이름을 짧게 보여 준다. 중복 제거 과정에서 선택 가능한 기존 모델을 없애지 않는다."
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import Options from './src/renderer/components/Options';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
useAppStore.setState({mode:'music',fileInfo:{path:'f.wav',name:'f.wav',duration:10,channels:1,sampleRate:24000,format:'wav'}});
createRoot(document.getElementById('root')).render(<Options/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:24px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--cyan:#6cc;--cyan-glow:#6cc2;--emerald:#5c9;--emerald-glow:#5c92;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate(() => { window.api = { settings: { get: async () => ({}), set: async () => ({ ok: true }) } } })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForSelector('[aria-label="빠른 작업 설정"]')

  // ── 빠른 설정이 고르는 모델 ───────────────────────────────────────────
  await page.getByRole('button', { name: '보컬 · 반주', exact: true }).click()
  assert.equal(await page.evaluate(() => window.store.getState().demucsModel), 'roformer')
  assert.equal(await page.getByTestId('quick-demucs-current').count(), 0,
    '빠른 설정으로 고른 모델인데 "사용 중" 이 떴다')
  pass('빠른 설정으로 고른 모델은 그대로 표시된다')

  // ── ★빠른 설정에 없는 모델이면 **이름**을 보여 준다 ───────────────────
  await page.evaluate(() => window.store.getState().setDemucsModel('roformer_ensemble'))
  await page.waitForSelector('[data-testid="quick-demucs-current"]')
  const shown = await page.getByTestId('quick-demucs-current').innerText()
  assert.ok(shown.includes('보컬 앙상블'), `모델 이름이 없다: ${shown}`)
  assert.ok(!/세부 설정 사용 중/.test(shown), `이름 대신 뭉뚱그렸다: ${shown}`)
  pass('★빠른 설정에 없는 모델은 현재 이름을 보여 준다')

  await page.evaluate(() => window.store.getState().setDemucsModel('htdemucs_ft'))
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="quick-demucs-current"]')?.innerText.includes('고품질 4트랙'))
  pass('다른 모델도 이름으로 말한다')

  // ── 선택 가능한 모델을 없애지 않았다 ──────────────────────────────────
  await page.getByRole('button', { name: /옵션/ }).click()
  const models = await page.evaluate(() =>
    [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent.trim()))
  for (const name of ['기본 4트랙', '고품질 4트랙', '보컬 2트랙', '보컬 Mel-Band', '보컬 앙상블']) {
    assert.ok(models.includes(name), `세부에서 ${name} 이(가) 사라졌다`)
  }
  pass('★세부 옵션의 모델 다섯 개가 그대로 있다')

  // 세부에서 고른 값이 빠른 설정에 그대로 보인다.
  await page.getByRole('button', { name: '보컬 Mel-Band', exact: true }).click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="quick-demucs-current"]')?.innerText.includes('보컬 Mel-Band'))
  pass('세부에서 고른 값이 빠른 설정에 그대로 보인다')

  // 선택 표시가 보조기술에 전달된다.
  const pressed = await page.evaluate(() =>
    [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim()))
  assert.ok(pressed.includes('보컬 Mel-Band'), `선택 표시가 없다: ${JSON.stringify(pressed)}`)
  pass('선택한 것이 aria-pressed 로 표시된다')

  // ── 대화 인원: 한 곳에서만 고른다 ─────────────────────────────────────
  await page.evaluate(() => window.store.setState({ mode: 'conversation' }))
  await page.waitForSelector('[role="group"][aria-label="대화 인원"]')
  const threes = await page.getByRole('button', { name: '3명', exact: true }).count()
  assert.equal(threes, 1, `같은 인원 단추가 ${threes}곳에 있다`)
  pass('★대화 인원이 한 곳에서만 보인다(중복 제거)')
  await page.getByRole('button', { name: '3명', exact: true }).click()
  assert.equal(await page.evaluate(() => window.store.getState().nSpeakers), 3)
  pass('인원을 바꾸는 기능은 그대로다')

  // ── 받아쓰기 언어: 모드에서는 한 곳 ───────────────────────────────────
  await page.evaluate(() => window.store.setState({ mode: 'transcribe' }))
  await page.waitForSelector('select[aria-label="빠른 음성 언어"]')
  const koCount = await page.getByRole('button', { name: '한국어', exact: true }).count()
  assert.equal(koCount, 0, '빠른 설정이 언어를 보여 주는데 세부에도 같은 단추가 있다')
  pass('★받아쓰기 모드에서 언어가 한 곳에서만 보인다')
  await page.selectOption('select[aria-label="빠른 음성 언어"]', 'ja')
  assert.equal(await page.evaluate(() => window.store.getState().whisperLang), 'ja')
  pass('언어를 바꾸는 기능은 그대로다')

  // ★SRT 도 받아쓰기 모드에서는 한 곳에서만 보인다(2026-09-27 검수 5).
  const srtCount = await page.evaluate(() =>
    [...document.querySelectorAll('button,label')].filter((el) => /SRT/.test(el.textContent || '')).length)
  assert.equal(srtCount, 1, `SRT 설정이 ${srtCount}곳에 있다`)
  pass('★받아쓰기 모드에서 SRT 가 한 곳에서만 보인다')
  await page.getByRole('button', { name: /SRT/ }).click()
  assert.equal(await page.evaluate(() => window.store.getState().exportSrt), true)
  pass('SRT 를 켜는 기능은 그대로다')

  // 다른 모드(분할)에서는 세부에만 있으므로 남아 있어야 한다.
  await page.evaluate(() => window.store.setState({ mode: 'split', transcribe: true }))
  await page.waitForTimeout(150)
  await page.getByTestId('processing-options').click()
  const koInSplit = await page.getByRole('button', { name: '한국어', exact: true }).count()
  assert.equal(koInSplit, 1, '분할 모드에서는 세부에만 있어야 하는데 사라졌다')
  pass('★다른 모드에서는 언어 선택이 그대로 남는다')
  const srtInSplit = await page.evaluate(() =>
    [...document.querySelectorAll('button,label')].filter((el) => /SRT/.test(el.textContent || '')).length)
  assert.ok(srtInSplit >= 1, '분할 모드에서 SRT 가 사라졌다')
  pass('★다른 모드에서는 SRT 가 그대로 남는다')

  // ── 좁은 창 ───────────────────────────────────────────────────────────
  await page.evaluate(() => window.store.setState({ mode: 'music' }))
  await page.setViewportSize({ width: 400, height: 800 })
  await page.waitForTimeout(200)
  await page.getByTestId('processing-options').click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  pass('좁은 창에서 가로 넘침이 없다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-quick-narrow.png') })
  await page.setViewportSize({ width: 900, height: 800 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-quick-wide.png') })

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, shots: process.env.TEMP || '.' }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-quick-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
