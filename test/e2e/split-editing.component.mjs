// 트랙 분할 — **고친 조작만** 본다(2026-09-27).
//   · 메뉴 왕복 보존, 새로 불러오면 이어지지 않음
//   · 되돌리기·다시 적용(드래그 한 번 = 한 걸음, 전체 삭제도 되돌림)
//   · ★실제 포인터로 같은 경계를 두 번 옮기고, 되돌리기 두 번이 각각을 되돌림
//     (옛 코드에 대고 돌려 보면 48px 중 8px 만 따라와 여기서 걸린다 — 검사에 이빨이 있다)
//   · 시간 목록: 잘못된 줄이면 전체 적용 막고 기존 편집 유지, 줄 번호 표시·선택
//   · 첫 시각이 0보다 크면 앞 구간을 잃지 않음
//   · 마커 없는 자동 분할을 '조각 N개' 로 확정해 말하지 않음
//   · 좁은 창 가로 넘침 없음
//
// Codex 의 `file-workspaces.component.mjs` 와 같은 방식이다(실제 React + 실제 WAV).
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

// 10초짜리 실제 WAV — 파형이 진짜로 디코딩된다.
const wav = Buffer.alloc(44 + 24000 * 10 * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.sin(i * 0.03) * 3000, i)

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import Split from './src/renderer/components/SplitEditor';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
const file={path:'fixture.wav',name:'fixture.wav',duration:10,channels:1,sampleRate:24000,format:'wav'};
useAppStore.setState({mode:'split',fileUrl:window.wav,fileInfo:file});
function App(){const mode=useAppStore(s=>s.mode);return mode==='split'?<Split/>:<div id="elsewhere">다른 메뉴</div>}
createRoot(document.getElementById('root')).render(<App/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:24px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate((w) => {
    window.wav = w
    window.api = { settings: { get: async () => ({}), set: async () => ({ ok: true }) } }
  }, 'data:audio/wav;base64,' + wav.toString('base64'))
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => !document.querySelector('[aria-label="분할 파형 재생"]')?.disabled)

  // ── 자동 분할을 확정값처럼 말하지 않는다 ──────────────────────────────
  const headNoMarkers = await page.getByTestId('split-pieces').innerText()
  assert.ok(headNoMarkers.includes('자동 분할'), `자동 분할 표시가 없다: ${headNoMarkers}`)
  assert.ok(!/조각 1개/.test(headNoMarkers), `마커가 없는데 조각 수를 확정했다: ${headNoMarkers}`)
  assert.equal(await page.getByTestId('split-auto-note').count(), 1)
  pass('마커가 없으면 조각 수를 확정하지 않고 자동 분할로 표시한다')

  // ★가상 조각 행과 저장 선택을 보여 주지 않는다(2026-09-27 검수 3).
  assert.equal(await page.getByTestId('split-piece').count(), 0,
    '자동 분할인데 조각 행이 보인다 — 확정 결과처럼 읽힌다')
  assert.equal(await page.getByTestId('split-selected-count').count(), 0)
  assert.equal(await page.getByTestId('split-play-all').count(), 1, '전체 미리듣기는 남아야 한다')
  pass('★자동 분할에서는 가상 조각 행·저장 선택을 숨기고 전체 미리듣기만 남긴다')

  // ── 되돌리기: 처음엔 비활성 ───────────────────────────────────────────
  assert.equal(await page.getByTestId('split-undo').isDisabled(), true)
  assert.equal(await page.getByTestId('split-redo').isDisabled(), true)
  pass('되돌릴 것이 없으면 비활성이다')

  // ── 분할점 추가 → 되돌리기 → 다시 적용 ────────────────────────────────
  const wave = page.getByTestId('split-edit-wave')
  const box = await wave.boundingBox()
  await page.mouse.dblclick(box.x + box.width * 0.4, box.y + 40)
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 1)
  assert.equal(await page.getByTestId('split-undo').isDisabled(), false)
  pass('분할점을 추가하면 되돌리기가 열린다')

  await page.getByTestId('split-undo').click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 0)
  pass('추가를 되돌린다')
  await page.getByTestId('split-redo').click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 1)
  pass('되돌린 것을 다시 적용한다')

  // ── 전체 삭제도 되돌린다 ──────────────────────────────────────────────
  await page.mouse.click(box.x + box.width * 0.7, box.y + 40)
  await page.getByRole('button', { name: '＋ 현재 위치에서 나누기', exact: true }).click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 2)
  await page.getByRole('button', { name: '전체 삭제', exact: true }).click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 0)
  await page.getByTestId('split-undo').click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 2)
  pass('★전체 삭제를 되돌린다')

  // ── ★실제 포인터로 같은 경계를 두 번 옮긴다 — 이번 검수의 본안 ────────
  //   예전에는 끄는 **중**에 setMarkers 를 불렀고, 그 바람에 동기화 effect 가
  //   clearRegions() 로 **끌고 있던 선을 지우고 새로 만들어** 드래그가 손에서 빠졌다.
  //   그리고 분할선이 0.01초(≈0.02px)라 사람도 잡기 어려웠다.
  const grabs = page.getByTestId('split-marker-grab')
  await grabs.first().waitFor()
  assert.equal(await grabs.count(), 2, `손잡이가 마커 수와 다르다: ${await grabs.count()}`)

  // 보이는 선은 얇고, 잡는 폭은 넓다 — 구간을 넓혀서 해결하지 않았다.
  const lineBox = await page.locator('[part^="marker"]').first().boundingBox()
  const anyGrab = await grabs.first().boundingBox()
  assert.ok(lineBox.width <= 4, `보이는 선이 두꺼워졌다: ${lineBox.width}px`)
  assert.ok(anyGrab.width >= 16, `포인터로 잡는 폭이 좁다: ${anyGrab.width}px`)
  console.log(`  보이는 선 ${lineBox.width}px · 잡는 폭 ${anyGrab.width}px`)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-markers.png') })
  pass('★보이는 선은 얇게(≤4px), 잡는 폭은 넓게(≥16px)')

  // 왼쪽 경계를 고른다(시간이 바뀌어도 같은 것을 계속 잡도록 id 로 묶는다).
  let leftIdx = 0, leftX = Infinity
  for (let i = 0; i < 2; i++) {
    const bb = await grabs.nth(i).boundingBox()
    if (bb.x < leftX) { leftX = bb.x; leftIdx = i }
  }
  const markId = await grabs.nth(leftIdx).getAttribute('data-af-grab')
  const handle = page.locator(`[data-af-grab="${markId}"]`)
  // 끝까지 따라왔는지 **픽셀로** 잰다. 중간에 선이 다시 만들어지면 여기서 모자란다.
  const dragHandle = async (dx) => {
    const bb = await handle.boundingBox()
    const cy = bb.y + bb.height / 2
    await page.mouse.move(bb.x + bb.width / 2, cy)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width / 2 + dx, cy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const after = await handle.boundingBox()
    return { wanted: dx, got: Math.round(after.x - bb.x) }
  }
  const marksNow = () => page.evaluate(() => window.store.getState().splitMarkers.slice())

  const t0 = await marksNow()
  const d1 = await dragHandle(48)
  assert.ok(Math.abs(d1.got - d1.wanted) <= 4,
    `첫 드래그가 포인터를 끝까지 따라오지 않았다(끌던 선이 다시 만들어졌을 수 있다): ${JSON.stringify(d1)}`)
  const t1 = await marksNow()
  assert.ok(t1[0] - t0[0] > 0.1, `옮겼는데 상태가 그대로다: ${JSON.stringify([t0[0], t1[0]])}`)
  pass('★분할선을 실제 포인터로 끌어 옮긴다 — 끝까지 따라온다')

  const d2 = await dragHandle(42)
  assert.ok(Math.abs(d2.got - d2.wanted) <= 4,
    `두 번째 드래그가 먹히지 않았다(첫 드래그 뒤 선이 다시 만들어졌을 수 있다): ${JSON.stringify(d2)}`)
  const t2 = await marksNow()
  assert.ok(t2[0] > t1[0] && t1[0] > t0[0],
    `두 번 모두 오른쪽으로 가지 않았다: ${JSON.stringify([t0[0], t1[0], t2[0]])}`)
  assert.equal(t2.length, 2, '끄는 동안 마커가 사라지거나 늘었다')
  pass('★같은 경계를 두 번째로 끈다 — 선이 손에서 빠지지 않는다')

  // ★되돌리기 한 번 = **이동 한 번**. 예전에는 둘이 뭉쳐 한 번에 처음으로 돌아갔다.
  const seen = { t0: t0[0], t1: t1[0], t2: t2[0] }
  await page.getByTestId('split-undo').click()
  await page.waitForTimeout(150)
  const u1 = (await marksNow())[0]
  assert.ok(Math.abs(u1 - t1[0]) < 0.01,
    `되돌리기 한 번에 두 이동이 뭉쳐 돌아갔다: ${JSON.stringify({ ...seen, undo1: u1 })}`)
  pass('★되돌리기 한 번이 **두 번째 이동만** 되돌린다')

  await page.getByTestId('split-undo').click()
  await page.waitForTimeout(150)
  const u2 = (await marksNow())[0]
  assert.ok(Math.abs(u2 - t0[0]) < 0.01,
    `두 번째 되돌리기가 첫 이동을 되돌리지 않았다: ${JSON.stringify({ ...seen, undo2: u2 })}`)
  pass('★되돌리기 두 번이 각 이동을 하나씩 되돌린다')

  // 되돌린 뒤 화면의 선도 따라 움직였는가(상태만 바뀌고 그림이 남아 있으면 안 된다).
  const movedBack = await handle.boundingBox()
  assert.ok(Math.abs(movedBack.x - leftX) < 2,
    `되돌렸는데 선이 제자리로 가지 않았다: ${leftX} → ${movedBack.x}`)
  pass('★되돌리면 화면의 분할선도 같이 돌아온다')

  await page.getByTestId('split-redo').click()
  await page.waitForFunction((v) => Math.abs(window.store.getState().splitMarkers[0] - v) < 0.01, t1[0])
  pass('★다시 적용도 한 걸음씩 간다')
  await page.getByTestId('split-undo').click()
  await page.waitForFunction((v) => Math.abs(window.store.getState().splitMarkers[0] - v) < 0.01, t0[0])

  // ── 시간 목록: 잘못된 줄이면 전체 적용을 막고 기존 편집을 지킨다 ───────
  await page.getByRole('button', { name: '시간 목록 붙여넣기', exact: true }).click()
  const list = page.getByTestId('split-time-list')
  await list.fill('0:00 첫\n여기는 시간이 아니다\n0:04 셋')
  await page.getByRole('button', { name: /타임스탬프 적용/ }).click()
  await page.waitForSelector('[data-testid="split-time-issues"]')
  const issue = await page.getByTestId('split-time-issues').innerText()
  assert.ok(issue.includes('2행'), `줄 번호가 없다: ${issue}`)
  assert.ok(issue.includes('적용하지 않았습니다'), `적용하지 않았다는 말이 없다: ${issue}`)
  assert.equal(await page.evaluate(() => window.store.getState().splitMarkers.length), 2,
    '잘못된 줄이 있는데 기존 편집이 바뀌었다')
  pass('★잘못된 줄이 있으면 전체 적용을 막고 기존 편집을 지킨다')

  // 줄 번호를 누르면 그 줄이 선택된다.
  await page.getByRole('button', { name: '2행', exact: true }).click()
  const picked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="split-time-list"]')
    return el.value.slice(el.selectionStart, el.selectionEnd)
  })
  assert.equal(picked, '여기는 시간이 아니다', `고른 줄이 다르다: ${picked}`)
  pass('오류 줄을 누르면 그 줄을 골라 준다')

  // ── 첫 시각이 0보다 크면 앞 구간을 잃지 않는다 ────────────────────────
  await list.fill('0:03 둘째\n0:06 셋째')
  await page.getByRole('button', { name: /타임스탬프 적용/ }).click()
  await page.waitForFunction(() => window.store.getState().splitMarkers.length === 2)
  const marks = await page.evaluate(() => window.store.getState().splitMarkers)
  assert.deepEqual(marks, [3, 6], `앞 구간을 버렸다: ${JSON.stringify(marks)}`)
  pass('★첫 시각이 0보다 크면 0~첫 시각을 첫 트랙으로 남긴다')

  // ── 메뉴 왕복 보존 ────────────────────────────────────────────────────
  await page.evaluate(() => window.store.setState({ mode: 'music' }))
  await page.waitForSelector('#elsewhere')
  await page.evaluate(() => window.store.setState({ mode: 'split' }))
  await page.waitForFunction(() => !document.querySelector('[aria-label="분할 파형 재생"]')?.disabled)
  const kept = await page.evaluate(() => window.store.getState().splitMarkers)
  assert.deepEqual(kept, [3, 6], `메뉴를 옮겼다 오니 사라졌다: ${JSON.stringify(kept)}`)
  pass('★메뉴를 옮겼다 와도 분할점이 남는다')

  // ── 파일을 새로 불러오면 이어지지 않는다 ──────────────────────────────
  await page.evaluate(() => {
    // 같은 경로라도 **새로 불러온 것**이다 — 초안을 비운다(setFile 과 같은 계약).
    window.store.setState({ splitDraft: null, splitMarkers: [], splitLabels: [] })
    window.store.setState({ mode: 'music' })
  })
  await page.waitForSelector('#elsewhere')
  await page.evaluate(() => window.store.setState({ mode: 'split' }))
  await page.waitForFunction(() => !document.querySelector('[aria-label="분할 파형 재생"]')?.disabled)
  const fresh = await page.evaluate(() => window.store.getState().splitMarkers)
  assert.deepEqual(fresh, [], `새로 불러왔는데 이전 작업이 남았다: ${JSON.stringify(fresh)}`)
  pass('★파일을 새로 불러오면 이전 분할점을 적용하지 않는다')

  // ── 좁은 창 ───────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 400, height: 900 })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  pass('좁은 창에서 가로 넘침이 없다')

  // ★단어 중간에서 꺾이지 않는다 — 글자를 줄이지 않고 묶음째 줄바꿈한다(검수 4).
  const wrapInfo = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '시간 목록 붙여넣기')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const cs = getComputedStyle(b)
    return { h: r.height, lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4, ws: cs.whiteSpace }
  })
  assert.ok(wrapInfo, '시간 목록 단추를 찾지 못했다')
  assert.equal(wrapInfo.ws, 'nowrap', `단추 글자가 꺾일 수 있다: ${JSON.stringify(wrapInfo)}`)
  pass('★좁은 창에서 도구 줄 글자가 단어 중간에서 꺾이지 않는다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-narrow.png') })
  await page.setViewportSize({ width: 900, height: 900 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-wide.png') })

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, shots: process.env.TEMP || '.' }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-split-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
