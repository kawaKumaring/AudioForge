// 공용 결과 재생기 — **소리가 한 번에 하나이고, 늦게 온 로딩이 울리지 않는가.**
//   · 트랙을 바꾸는 중 늦게 도착한 앞 로딩이 이전 소리를 내지 않는다
//   · 짧은 파일로 바꾸면 재생 위치를 유효 범위로 자른다
//   · 화면을 떠나면 재생이 남지 않는다
//   · 원본 파형과 결과 재생기가 **동시에 울리지 않는다**
//
// 본체 응답은 모의다. 소리는 길이가 다른 검사용 합성 WAV 둘.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

/** seconds 초짜리 WAV data URL. */
function wavUrl(seconds) {
  const SR = 8000
  const n = Math.round(SR * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(Math.sin(i * 0.05) * 6000, i)
  return 'data:audio/wav;base64,' + b.toString('base64')
}
const LONG = wavUrl(12)
const SHORT = wavUrl(2)

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{useState}from'react';import{createRoot}from'react-dom/client';
import{ResultPlayer}from './src/renderer/components/ResultPlayer';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
function Host(){
  const [open,setOpen]=useState(true)
  const [p,setP]=useState('C:/out/long.wav')
  const [paused,setPaused]=useState(false)
  window.__setPath=setP; window.__setOpen=setOpen; window.__setPaused=setPaused
  return <div>
    {open && <ResultPlayer path={p} color="#a78bfa" paused={paused} onClose={()=>setOpen(false)}
      originalPath="C:/work/original.wav" originalLabel="original.wav" />}
  </div>
}
createRoot(document.getElementById('root')).render(<Host/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 400 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:20px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--accent:#a77cf0;--cyan:#6cc;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate(({ long, short }) => {
    window.__urls = { 'C:/out/long.wav': long, 'C:/out/short.wav': short, 'C:/work/original.wav': long }
    window.__delay = 0
    window.api = {
      settings: { get: async () => ({}), set: async () => ({ ok: true }) },
      audio: {
        getFileUrl: async (p) => {
          const d = window.__delay
          if (d) await new Promise((r) => setTimeout(r, d))
          return window.__urls[p] || window.__urls['C:/out/long.wav']
        },
      },
    }
  }, { long: LONG, short: SHORT })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForSelector('[data-testid="track-compare"]')

  // ★WebAudio 로 트므로 <audio> 요소가 없다. 재생기가 내는 상태 표시를 읽는다.
  const media = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].map((el) => ({
      paused: el.dataset.playing !== '1', t: +el.dataset.time, d: +el.dataset.dur,
    })))

  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => +el.dataset.time > 0.2))
  pass('재생기가 열리면 소리가 흐른다')
  assert.equal((await media()).filter((m) => !m.paused).length, 1, '재생기 하나인데 소리가 여럿이다')

  // ── 짧은 파일로 바꾸면 위치를 유효 범위로 자른다 ──────────────────────
  // 12초 파일에서 9초 자리까지 기다린다(끌어 옮기는 대신 흐르게 둔다 — 실제 재생이다).
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => +el.dataset.time > 1.2),
  null, { timeout: 15000 })
  await page.evaluate(() => window.__setPath('C:/out/short.wav'))
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => +el.dataset.dur > 0 && +el.dataset.dur < 5))
  await page.waitForTimeout(300)
  const afterShort = await media()
  assert.ok(afterShort.length === 1, `재생기가 여럿 남았다: ${JSON.stringify(afterShort)}`)
  assert.ok(afterShort[0].t <= afterShort[0].d + 0.05,
    `짧은 파일 길이를 넘는 자리에 있다: ${JSON.stringify(afterShort)}`)
  pass('★짧은 파일로 바꾸면 재생 위치를 유효 범위로 자른다')

  // ── 늦게 온 앞 로딩이 이전 소리를 내지 않는다 ─────────────────────────
  await page.evaluate(() => { window.__delay = 900 })
  await page.evaluate(() => window.__setPath('C:/out/long.wav'))   // 느리게 오는 긴 파일
  await page.waitForTimeout(120)
  await page.evaluate(() => { window.__delay = 0; window.__setPath('C:/out/short.wav') })
  await page.waitForTimeout(1400)                                   // 늦은 응답이 도착할 시간
  const afterRace = await media()
  assert.equal(afterRace.length, 1, `늦은 로딩이 재생기를 하나 더 만들었다: ${JSON.stringify(afterRace)}`)
  assert.ok((afterRace[0].d ?? 99) < 5,
    `늦게 온 앞 파일(긴 것)이 울린다: ${JSON.stringify(afterRace)}`)
  pass('★바꾸는 중 늦게 온 앞 로딩이 이전 소리를 내지 않는다')

  // ── 원본 비교 — 재생기는 그대로 하나 ──────────────────────────────────
  await page.getByTestId('track-compare').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="track-compare"]').dataset.listening === 'original')
  await page.waitForTimeout(400)
  assert.equal((await media()).length, 1, '원본으로 바꿨는데 재생기가 둘이다')
  pass('★원본 비교로 바꿔도 소리는 하나다')

  // ── 다른 자리가 소리를 가져가면 멈춘다 ────────────────────────────────
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => el.dataset.playing === '1'),
  null, { timeout: 10000 })
  await page.evaluate(() => window.store.getState().claimAudio('waveform'))
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="result-player"]')].every((el) => el.dataset.playing !== '1'))
  pass('★다른 자리(원본 파형)가 소리를 가져가면 결과 재생기가 멈춘다')

  // ── 읽는 동안 자리가 넘어갔으면 **늦게 틀지 않는다** ──────────────────
  //   ★파일을 읽어 오는 사이 사용자가 원본 파형을 틀 수 있다. 그때 뒤늦게 자동으로
  //     틀면 두 소리가 겹친다. 위치는 이어받되 소리는 내지 않아야 한다.
  await page.evaluate(() => { window.__delay = 700 })
  await page.evaluate(() => window.__setPath('C:/out/long.wav'))
  await page.waitForTimeout(120)
  await page.evaluate(() => window.store.getState().claimAudio('waveform'))  // 읽는 도중 자리를 넘긴다
  await page.waitForTimeout(1500)                                           // 다 읽고도 남을 시간
  const late = await page.evaluate(() => ({
    playing: [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => el.dataset.playing === '1'),
    owner: window.store.getState().audioClaim?.owner,
    ready: [...document.querySelectorAll('[data-testid="result-player"]')].some((el) => +el.dataset.dur > 0),
  }))
  assert.equal(late.ready, true, '늦은 로딩이 아예 끝나지 않았다 — 검사가 눈이 멀었다')
  assert.equal(late.owner, 'waveform', '자리가 넘어간 상태가 아니다')
  assert.equal(late.playing, false, '자리가 넘어갔는데 뒤늦게 소리를 냈다')
  pass('★읽는 동안 자리가 넘어가면 늦게 자동으로 틀지 않는다')

  // ── 사람이 다시 누르면 자리를 **가져온다** ────────────────────────────
  await page.evaluate(() => { window.__delay = 0 })
  await page.evaluate(() => window.__setPaused(true))
  await page.waitForTimeout(100)
  await page.evaluate(() => window.__setPaused(false))
  await page.waitForFunction(() => window.store.getState().audioClaim?.owner === 'result',
    null, { timeout: 5000 })
  pass('★사람이 다시 누르면 재생 자리를 가져온다')

  // ── 화면을 떠나면 재생이 남지 않는다 ──────────────────────────────────
  await page.evaluate(() => window.__setOpen(false))
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() =>
    document.querySelectorAll('[data-testid="result-player"]').length), 0,
  '화면을 떠났는데 재생기가 남아 있다')
  pass('★화면을 떠나면 재생이 남지 않는다')

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  process.exitCode = 1
} finally {
  await browser.close()
}
