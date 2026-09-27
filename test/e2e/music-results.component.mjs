// 음악 분리 결과 작업실 — **듣고, 고르고, 저장하는 흐름**만 본다(2026-09-27 개편).
//   · 결과 이름 · 재생 중 표시 · 저장 선택이 서로 구분된다
//   · 모델마다 결과 수가 달라도 그대로 나온다(보컬·반주 둘이라고 가정하지 않는다)
//   · 고른 결과만 내보낸다. 개별 결과만 고를 수도 있다
//   · 세부 조작(가사·번역)은 그 결과의 메뉴 안에 있다
//   · 재생하면 원곡과 견주는 단추가 함께 온다. 재생기는 한 번에 하나다
//   · 다른 원본으로 바꾸면 이전 결과가 새 원본의 결과처럼 보이지 않는다
//
// 본체 응답은 모의다(엔진을 돌리지 않는다). 소리는 검사용 합성 WAV.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

const SR = 8000
const wav = Buffer.alloc(44 + SR * 2 * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.sin(i * 0.05) * 6000, i)
const WAV_URL = 'data:audio/wav;base64,' + wav.toString('base64')

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import TrackList from './src/renderer/components/TrackList';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
createRoot(document.getElementById('root')).render(<TrackList/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 940, height: 900 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

/** 4트랙 모델의 결과(보컬·반주 둘이라고 가정하지 않는다). */
const FOUR = [
  { name: 'vocals', label: '보컬', path: 'C:/out/vocals.wav' },
  { name: 'drums', label: '드럼', path: 'C:/out/drums.wav' },
  { name: 'bass', label: '베이스', path: 'C:/out/bass.wav' },
  { name: 'other', label: '그 외', path: 'C:/out/other.wav' },
]
const TWO = [
  { name: 'vocals', label: '보컬', path: 'C:/out2/vocals.wav' },
  { name: 'instrumental', label: '반주', path: 'C:/out2/instrumental.wav' },
]

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:20px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--cyan:#6cc;--emerald:#5c9;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate((w) => {
    window.wavUrl = w
    window.__exported = null
    window.__opened = null
    window.api = {
      settings: { get: async () => ({}), set: async () => ({ ok: true }) },
      app: { openFolder: (d) => { window.__opened = d }, readTextFile: async () => null },
      audio: {
        getFileUrl: async (p) => { window.__urlAsked = p; return window.wavUrl },
        exportTracks: async (paths) => { window.__exported = paths; return { ok: true, dir: 'D:/x', copied: paths, failed: [] } },
        processTrack: async () => ({ ok: true }),
        onTrackResult: () => () => {},
        onError: () => () => {},
        readTrackText: async () => null,
      },
      utils: { copyToClipboard: () => {} },
    }
  }, WAV_URL)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  const show = async (tracks, dir) => {
    await page.evaluate(({ tracks, dir }) => {
      window.store.setState({ mode: 'music', resultMode: 'music', playingTrack: null })
      window.store.getState().setResult(tracks, dir, null)
    }, { tracks, dir })
    await page.waitForSelector('[data-testid="track-keep"]')
  }

  // ══ 결과가 모델대로 나온다 ═════════════════════════════════════════════
  await show(FOUR, 'C:/out')
  assert.equal(await page.getByTestId('track-keep').count(), 4, '4트랙 모델 결과가 다 나오지 않았다')
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="track-keep"]')].map((c) => c.getAttribute('aria-label')))
  assert.ok(labels.some((l) => l.includes('드럼')) && labels.some((l) => l.includes('베이스')),
    `보컬·반주만 가정했다: ${JSON.stringify(labels)}`)
  pass('★모델마다 다른 결과 수가 그대로 나온다(4트랙)')

  // ══ 저장 선택은 재생 상태와 다르다 ═════════════════════════════════════
  assert.match(await page.getByTestId('track-keep-count').innerText(), /4\/4/)
  await page.getByTestId('track-keep').nth(1).uncheck()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="track-keep-count"]').innerText.includes('3/4'))
  pass('★저장 선택을 빼면 저장 수가 줄어든다')

  await page.getByTestId('result-export').click()
  await page.waitForFunction(() => window.__exported !== null)
  const sent = await page.evaluate(() => window.__exported)
  assert.equal(sent.length, 3, `고르지 않은 것까지 내보냈다: ${JSON.stringify(sent)}`)
  assert.ok(!sent.some((p) => p.includes('drums')), `뺀 결과가 나갔다: ${JSON.stringify(sent)}`)
  assert.match(await page.getByTestId('result-export-note').innerText(), /분리 결과 3개/)
  pass('★고른 결과만 내보내고, 무엇을 내보냈는지 적는다')

  // ══ 결과별 메뉴 — 세부 조작은 그 안에 ══════════════════════════════════
  assert.equal(await page.getByRole('button', { name: /가사 뽑기/ }).count(), 0, '세부 조작이 줄에 나와 있다')
  await page.getByTestId('track-menu').first().click()
  await page.waitForSelector('[data-testid="track-menu-list"]')
  assert.equal(await page.getByTestId('track-menu-transcribe').count(), 1)
  pass('★세부 조작(가사 뽑기)은 그 결과의 메뉴 안에 있다')

  // '이것만 저장 선택' — 개별 결과 저장(나머지는 빠진다)
  await page.getByTestId('track-menu-only').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="track-keep-count"]').innerText.includes('1/4'))
  await page.getByTestId('result-export').click()
  await page.waitForFunction(() => window.__exported && window.__exported.length === 1)
  assert.ok((await page.evaluate(() => window.__exported))[0].includes('vocals'))
  pass('★개별 결과 하나만 저장할 수 있다')

  // ══ 재생 — 원곡 비교가 함께 오고, 한 번에 하나만 ═══════════════════════
  await page.evaluate(() => window.store.setState({
    fileInfo: { path: 'C:/work/song.mp3', name: 'song.mp3', duration: 2, channels: 2, sampleRate: 44100, format: 'mp3' },
  }))
  await page.getByRole('button', { name: /보컬 재생/ }).click()
  await page.waitForSelector('[data-testid="track-compare"]')
  pass('★재생하면 원곡과 견주는 단추가 함께 온다')
  assert.equal(await page.getByTestId('track-volume').count(), 1, '음량 손잡이가 재생기마다 늘어난다')

  await page.getByRole('button', { name: /그 외 재생/ }).click()
  await page.waitForTimeout(250)
  assert.equal(await page.getByTestId('track-compare').count(), 1,
    '재생기가 둘 열렸다 — 두 소리가 겹칠 수 있다')
  pass('★재생기는 한 번에 하나다')

  // 원곡으로 바꿔도 재생기는 하나 그대로.
  await page.getByTestId('track-compare').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="track-compare"]').dataset.listening === 'original')
  assert.equal(await page.getByTestId('track-compare').count(), 1)
  pass('★원곡 비교로 바꿔도 재생기는 하나다')

  // ══ 폴더 열기 ══════════════════════════════════════════════════════════
  await page.getByTestId('result-open-folder').click()
  assert.equal(await page.evaluate(() => window.__opened), 'C:/out')
  pass('폴더 열기가 결과 폴더를 연다')

  // ══ 다른 원본 → 이전 결과가 남지 않는다 ════════════════════════════════
  await show(TWO, 'C:/out2')
  assert.equal(await page.getByTestId('track-keep').count(), 2)
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="track-keep-count"]').innerText.includes('2/2'))
  assert.equal(await page.getByTestId('result-export-note').count(), 0, '이전 내보내기 알림이 남았다')
  pass('★결과가 바뀌면 저장 선택과 알림이 새로 시작한다')

  // ══ 좁은 창 ════════════════════════════════════════════════════════════
  await page.setViewportSize({ width: 430, height: 900 })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  const reachable = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="result-export"]').getBoundingClientRect()
    return b.right <= innerWidth + 1 && b.width > 20
  })
  assert.ok(reachable, '좁은 창에서 내보내기 단추가 화면 밖으로 나갔다')
  pass('★좁은 창에서도 내보내기가 화면 안에 있다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-music-narrow.png') })
  await page.setViewportSize({ width: 940, height: 900 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-music-wide.png') })

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, shots: process.env.TEMP || '.' }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-music-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
