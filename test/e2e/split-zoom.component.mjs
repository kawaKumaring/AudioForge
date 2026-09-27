// 트랙 분할 — **확대와 정밀 선택**만 본다(2026-09-27 2단계).
//   · 확대/전체 보기, 보고 있는 시간 범위 표시
//   · 가까운 두 경계를 각각 고르고 각각 고친다(손잡이가 겹쳐도 목록·화살표로)
//   · 확대 상태에서 경계 두 번 이동 → 되돌리기 두 번
//   · 확대·스크롤·선택은 **이력에 쌓지 않는다**
//   · 파형 위치 · 숫자 시각 · 저장에 전달되는 경계가 같다
//   · 전체 보기로 돌아와도 분할점·이름·저장 선택이 남는다
//   · 좁은 창에서 도구 묶음이 줄바꿈되고 주요 조작이 화면 안에 있다
//
// 마지막에 **긴 파일 대표 조건**(10분)으로 불러오기·조작 반응을 잰다.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

/** seconds 초짜리 WAV. */
function wav(seconds, sr = 8000) {
  const n = Math.round(sr * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 44; i < b.length; i += 2) b.writeInt16LE(Math.sin(i * 0.03) * 5000, i)
  return 'data:audio/wav;base64,' + b.toString('base64')
}
const SHORT_URL = wav(60)
const LONG_URL = wav(600)          // 10분 — 긴 파일 대표 조건

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import Split from './src/renderer/components/SplitEditor';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
function App(){const mode=useAppStore(s=>s.mode);return mode==='split'?<Split/>:<div id="elsewhere">다른 메뉴</div>}
createRoot(document.getElementById('root')).render(<App/>);`,
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

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:20px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--cyan:#22d3ee;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate(() => {
    window.api = { settings: { get: async () => ({}), set: async () => ({ ok: true }) } }
  })

  const open = async (url, dur) => {
    await page.evaluate(({ url, dur }) => {
      window.store.setState({ mode: 'split', splitDraft: null })
      window.store.getState().setFile(
        { path: `C:/work/x${dur}.wav`, name: 'x.wav', duration: dur, channels: 1, sampleRate: 8000, format: 'wav' }, url)
      window.store.setState({ mode: 'split' })
    }, { url, dur })
    await page.waitForFunction(() => !document.querySelector('[aria-label="분할 파형 재생"]')?.disabled,
      null, { timeout: 60000 })
  }
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await open(SHORT_URL, 60)

  // ── 가까운 두 경계를 만든다(시간 목록으로 정확히) ─────────────────────
  await page.getByRole('button', { name: '시간 목록 붙여넣기', exact: true }).click()
  await page.getByTestId('split-time-list').fill('0:00 첫\n0:20 둘\n0:21 셋')
  await page.getByRole('button', { name: /타임스탬프 적용/ }).click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 2)
  const marks0 = await page.evaluate(() => window.store.getState().splitMarkers)
  assert.deepEqual(marks0, [20, 21], `경계가 다르다: ${JSON.stringify(marks0)}`)
  pass('1초 떨어진 두 경계를 만든다(60초 파형에서 손잡이가 겹치는 거리)')

  // 손잡이가 실제로 겹치는지 — 겹치니까 대체 경로가 필요하다는 근거.
  // ★분할선은 그림자 DOM 안이라 document.querySelectorAll 로는 보이지 않는다 — 로케이터로 본다.
  const grabBoxes = async () => {
    const g = page.getByTestId('split-marker-grab')
    const n = await g.count()
    const out = []
    for (let i = 0; i < n; i++) { const b = await g.nth(i).boundingBox(); if (b) out.push({ x: b.x, w: b.width }) }
    return out.sort((a, b) => a.x - b.x)
  }
  const boxes = await grabBoxes()
  assert.equal(boxes.length, 2)
  const overlapped = boxes[0].x + boxes[0].w > boxes[1].x
  pass(`전체 보기에서 손잡이가 ${overlapped ? '겹친다' : '겹치지 않는다'}(간격 ${(boxes[1].x - boxes[0].x).toFixed(1)}px)`)

  // ── 목록·화살표로 각각 고른다 ─────────────────────────────────────────
  await page.getByTestId('split-marker-row').first().click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="split-marker-row"]').dataset.picked === '1')
  assert.equal(await page.getByTestId('split-picked-time').inputValue(), '20.00')
  pass('★목록에서 경계를 고르면 그 시각이 뜬다(손잡이가 겹쳐도 고를 수 있다)')

  await page.getByTestId('split-next').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="split-picked-time"]').value === '21.00')
  pass('★다음 경계로 넘어간다')
  const pickedRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="split-marker-row"]')].map((r) => r.dataset.picked))
  assert.deepEqual(pickedRows, ['0', '1'], `고른 표시가 하나가 아니다: ${JSON.stringify(pickedRows)}`)
  pass('고른 경계만 표시된다')

  // ── 확대 ──────────────────────────────────────────────────────────────
  assert.match(await page.getByTestId('split-zoom-state').innerText(), /전체 보기/)
  await page.getByTestId('split-zoom-in').click()
  await page.getByTestId('split-zoom-in').click()
  await page.waitForFunction(() =>
    !document.querySelector('[data-testid="split-zoom-state"]').innerText.includes('전체 보기'))
  pass('★확대하면 보고 있는 범위를 알려 준다')

  const zoomed = (await grabBoxes()).map((b) => b.x)
  assert.ok(zoomed.length === 2 && (zoomed[1] - zoomed[0]) > boxes[1].x - boxes[0].x,
    `확대했는데 더 벌어지지 않았다: ${JSON.stringify(zoomed)}`)
  assert.ok((zoomed[1] - zoomed[0]) >= 20, `확대해도 손잡이가 겹친다: ${(zoomed[1] - zoomed[0]).toFixed(1)}px`)
  pass(`★확대하면 두 경계가 떨어진다(${(boxes[1].x - boxes[0].x).toFixed(1)}px → ${(zoomed[1] - zoomed[0]).toFixed(1)}px)`)

  // ── 확대 상태에서 숫자로 두 번 옮기고 되돌리기 두 번 ──────────────────
  const undoCount = () => page.evaluate(() =>
    document.querySelector('[data-testid="split-undo"]').disabled)
  await page.getByTestId('split-picked-time').fill('21.50')
  await page.getByTestId('split-picked-time').press('Enter')
  await page.waitForFunction(() => window.store.getState().splitMarkers[1] === 21.5)
  await page.getByTestId('split-picked-time').fill('22.25')
  await page.getByTestId('split-picked-time').press('Enter')
  await page.waitForFunction(() => window.store.getState().splitMarkers[1] === 22.25)
  pass('★확대 상태에서 고른 경계를 숫자로 정확히 옮긴다')

  assert.equal(await undoCount(), false)
  await page.getByTestId('split-undo').click()
  await page.waitForFunction(() => window.store.getState().splitMarkers[1] === 21.5)
  pass('★되돌리기 한 번이 마지막 이동만 되돌린다')
  await page.getByTestId('split-undo').click()
  await page.waitForFunction(() => window.store.getState().splitMarkers[1] === 21)
  pass('★되돌리기 두 번이 각 이동을 하나씩 되돌린다')

  // 되돌린 뒤 파형·숫자·저장 값이 같다.
  await page.waitForTimeout(150)
  const agree = await page.evaluate(() => {
    const store = window.store.getState().splitMarkers
    const rows = [...document.querySelectorAll('[data-testid="split-marker-time"]')].map((e) => e.title)
    return { store, rows }
  })
  agree.grabs = await page.getByTestId('split-marker-grab').count()
  assert.deepEqual(agree.store, [20, 21], `저장에 가는 값이 다르다: ${JSON.stringify(agree.store)}`)
  assert.deepEqual(agree.rows, ['20.00초', '21.00초'], `목록 시각이 다르다: ${JSON.stringify(agree.rows)}`)
  assert.equal(agree.grabs, 2, '파형의 분할선 수가 다르다')
  pass('★되돌린 뒤 파형·목록 시각·저장 값이 모두 같다')

  // ── 확대·스크롤·선택은 이력에 쌓지 않는다 ─────────────────────────────
  const before = await page.evaluate(() => window.store.getState().splitMarkers.join(','))
  await page.getByTestId('split-zoom-out').click()
  await page.getByTestId('split-prev').click()
  await page.getByTestId('split-marker-row').first().click()
  await page.waitForTimeout(120)
  await page.getByTestId('split-undo').click()
  await page.waitForTimeout(150)
  const afterUndo = await page.evaluate(() => window.store.getState().splitMarkers.join(','))
  assert.notEqual(afterUndo, before, '확대·선택이 이력에 쌓여 되돌리기가 헛돌았다')
  pass('★확대·스크롤·선택은 이력에 쌓지 않는다(되돌리기는 편집만 되돌린다)')
  await page.getByTestId('split-redo').click()
  await page.waitForFunction((v) => window.store.getState().splitMarkers.join(',') === v, before)

  // ── 범위 밖·중복은 막고 기존 값을 지킨다 ──────────────────────────────
  await page.getByTestId('split-marker-row').nth(1).click()
  await page.getByTestId('split-picked-time').fill('20.01')      // 앞 경계와 너무 가깝다
  await page.getByTestId('split-picked-time').press('Enter')
  await page.waitForSelector('[data-testid="split-time-issue"]')
  assert.deepEqual(await page.evaluate(() => window.store.getState().splitMarkers), [20, 21],
    '겹치는 값이 적용됐다')
  pass('★겹치는 경계는 적용하지 않고 사유만 알린다(기존 값 유지)')
  await page.getByTestId('split-picked-time').fill('999')
  await page.getByTestId('split-picked-time').press('Enter')
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="split-time-issue"]').innerText.includes('원본 길이'))
  assert.deepEqual(await page.evaluate(() => window.store.getState().splitMarkers), [20, 21])
  pass('★원본 길이를 벗어난 값도 막는다')

  // ── 전체 보기·메뉴 왕복에서 편집이 남는다 ─────────────────────────────
  await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-testid="split-piece-keep"]')]
    if (boxes[1]) boxes[1].click()
  })
  await page.waitForFunction(() => window.store.getState().splitSelected?.length === 2)
  await page.getByTestId('split-zoom-fit').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="split-zoom-state"]').innerText.includes('전체 보기'))
  const keptAfterFit = await page.evaluate(() => ({
    marks: window.store.getState().splitMarkers,
    sel: window.store.getState().splitSelected,
    labels: window.store.getState().splitLabels,
  }))
  assert.deepEqual(keptAfterFit.marks, [20, 21])
  assert.equal(keptAfterFit.sel?.length, 2, '전체 보기로 왔더니 저장 선택이 바뀌었다')
  assert.deepEqual(keptAfterFit.labels, ['첫', '둘', '셋'])
  pass('★전체 보기로 돌아와도 분할점·이름·저장 선택이 그대로다')

  await page.evaluate(() => window.store.setState({ mode: 'music' }))
  await page.waitForSelector('#elsewhere')
  await page.evaluate(() => window.store.setState({ mode: 'split' }))
  await page.waitForFunction(() => !document.querySelector('[aria-label="분할 파형 재생"]')?.disabled)
  assert.deepEqual(await page.evaluate(() => window.store.getState().splitMarkers), [20, 21])
  pass('★메뉴를 옮겼다 와도 편집이 남는다')

  // ── 좁은 창 ───────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 420, height: 900 })
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  const reach = await page.evaluate(() => {
    const ids = ['split-zoom-in', 'split-zoom-fit', 'split-next']
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return { id, ok: false }
      const r = el.getBoundingClientRect()
      return { id, ok: r.right <= innerWidth + 1 && r.width > 10 && r.height > 10 }
    })
  })
  assert.ok(reach.every((r) => r.ok), `좁은 창에서 조작이 잘렸다: ${JSON.stringify(reach)}`)
  pass('★좁은 창에서도 확대·경계 이동 조작이 화면 안에 있다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-zoom-narrow.png') })
  await page.setViewportSize({ width: 940, height: 900 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-zoom-wide.png') })

  // ── 긴 파일 대표 조건(10분) ───────────────────────────────────────────
  const t0 = Date.now()
  await open(LONG_URL, 600)
  const loadMs = Date.now() - t0
  const t1 = Date.now()
  await page.getByRole('button', { name: '시간 목록 붙여넣기', exact: true }).click()
  await page.getByTestId('split-time-list').fill(
    Array.from({ length: 60 }, (_, i) => `${Math.floor((i * 10 + 5) / 60)}:${String((i * 10 + 5) % 60).padStart(2, '0')} T${i}`).join('\n'))
  await page.getByRole('button', { name: /타임스탬프 적용/ }).click()
  // 첫 시각이 0보다 크므로 60줄이 그대로 60개의 경계가 된다(0~첫 시각이 첫 트랙).
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 60,
    null, { timeout: 60000 })
  const markMs = Date.now() - t1
  const t2 = Date.now()
  await page.getByTestId('split-zoom-in').click()
  await page.waitForTimeout(50)
  await page.getByTestId('split-next').click()
  await page.waitForFunction(() => !!document.querySelector('[data-testid="split-picked-time"]').value)
  const opMs = Date.now() - t2
  console.log(`  긴 파일(10분·분할선 60개): 불러오기 ${loadMs}ms · 경계 적용 ${markMs}ms · 확대+선택 ${opMs}ms`)
  assert.ok(opMs < 3000, `확대·선택 반응이 느리다: ${opMs}ms`)
  pass('★긴 파일(10분) 대표 조건을 쟀다 — 조작 반응이 사람이 기다릴 수준이다')

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, loadMs, markMs, opMs }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-zoom-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
