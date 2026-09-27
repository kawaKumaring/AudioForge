// 대화 작업실 — **상태 보존·교정·저장 경로**만 본다(2026-09-27 개편 1~4단계).
//   · 파일을 바꾸면 앞 파일의 발언이 남지 않는다(재현했던 결함)
//   · 늦게 온 지난 실행의 결과가 지금 작업을 덮지 않는다
//   · 인물 카드 — 이름·발언 수·대표 구간·필터·합치기(한 번에 되돌림)
//   · 시간순 목록 — 여러 개 골라 한 번에 인물 변경, 시간 입력은 평소 숨김
//   · 교정은 파일마다 따로 저장되고, 옛 한 칸 기록도 이어받는다
//   · 아직 음원에 반영하지 않은 교정을 '저장 완료' 로 말하지 않는다
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
import W from './src/renderer/components/DialogueWorkspace';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
createRoot(document.getElementById('root')).render(<W/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 980, height: 900 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

/** 분석 결과 한 벌 — A 가 둘, B 가 하나. */
const SEGS = [
  { start: 1, end: 3, speaker: '화자 A' },
  { start: 4, end: 12, speaker: '화자 B' },
  { start: 13, end: 15, speaker: '화자 A' },
]

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:20px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--cyan:#6cc;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate(() => {
    window.__settings = {}
    window.__getDelay = 0
    window.__transcripts = {}
    window.__readCalls = []
    window.__resultCbs = []
    window.__cancelCbs = []
    window.__errorCbs = []
    window.__exported = null
    window.api = {
      settings: {
        get: async () => {
          const d = window.__getDelay
          if (d) await new Promise((r) => setTimeout(r, d))
          return JSON.parse(JSON.stringify(window.__settings))
        },
        set: async (k, v) => { window.__settings[k] = JSON.parse(JSON.stringify(v)); return { ok: true } },
      },
      dialogue: {
        readTranscript: async (dir, name) => { window.__readCalls.push(name); return window.__transcripts[name] || '' },
      },
      audio: {
        process: async (_p, _m, o) => { window.__lastReq = o; window.__rebuilt = (window.__rebuilt || 0) + 1; return { ok: true } },
        onResult: (cb) => { window.__resultCbs.push(cb); return () => { window.__resultCbs = window.__resultCbs.filter((x) => x !== cb) } },
        onError: (cb) => { window.__errorCbs.push(cb); return () => { window.__errorCbs = window.__errorCbs.filter((x) => x !== cb) } },
        onCancelling: (cb) => { window.__cancelCbs.push(cb); return () => { window.__cancelCbs = window.__cancelCbs.filter((x) => x !== cb) } },
        exportTracks: async (paths) => { window.__exported = paths; return { ok: true, dir: 'D:/x', copied: paths.map((p) => p), failed: [] } },
      },
    }
    window.__fire = (kind, data) => {
      const list = kind === 'result' ? window.__resultCbs
        : kind === 'cancel' ? window.__cancelCbs : window.__errorCbs
      for (const cb of [...list]) cb(data)
    }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  const openWith = async (file, runId, segs = SEGS, extra = {}) => {
    await page.evaluate(({ file, runId, segs, extra }) => {
      const info = { path: file, name: file, duration: 20, channels: 1, sampleRate: 24000, format: 'wav' }
      window.store.getState().setFile(info, 'data:audio/wav;base64,UklGRgAAAABXQVZF')
      window.store.setState({ mode: 'conversation' })
      window.store.getState().beginDialogueRun(runId)
      window.store.getState().adoptDialogueAnalysis({
        sourceKey: file, runId, segments: segs,
        speakers: [...new Set(segs.map((s) => s.speaker))].sort(),
        overlaps: [], outputDir: 'C:/out', durationSec: 20,
        trimSilence: false, transcribe: false, ...extra,
      })
      // 최초 결과 트랙(엔진이 이미 만들어 둔 것).
      window.store.getState().setResult(
        [...new Set(segs.map((s) => s.speaker))].sort().map((id, i) => ({
          name: `speaker_${String.fromCharCode(97 + i)}`, label: id,
          path: `C:/out/speaker_${String.fromCharCode(97 + i)}.wav`,
        })), 'C:/out', null)
    }, { file, runId, segs, extra })
    await page.waitForSelector('[data-testid="dialogue-card"]')
  }

  // ══ 1. 상태 보존 ═══════════════════════════════════════════════════════
  await openWith('C:/work/A.wav', 'R1')
  assert.equal(await page.getByTestId('dialogue-card').count(), 2)
  assert.equal(await page.getByTestId('dialogue-row').count(), 3)
  pass('분석 결과가 인물 카드와 발언 목록으로 함께 나온다')

  // ★재현했던 결함 — 파일을 바꾸면 앞 파일의 발언이 남으면 안 된다.
  await page.evaluate(() => {
    const info = { path: 'C:/work/B.wav', name: 'B.wav', duration: 40, channels: 1, sampleRate: 24000, format: 'wav' }
    window.store.getState().setFile(info, 'data:audio/wav;base64,UklGRgAAAABXQVZF')
  })
  await page.waitForTimeout(150)
  assert.equal(await page.getByTestId('dialogue-row').count(), 0, '파일을 바꿨는데 앞 파일의 발언이 남았다')
  assert.equal(await page.evaluate(() => window.store.getState().dialogueAnalysis), null)
  pass('★파일을 바꾸면 앞 파일의 발언이 남지 않는다(재현했던 결함)')

  // 구간이 오지 않은 실행 — 앞 결과를 되살리지 않고 사유를 말한다.
  await page.evaluate(() => {
    window.store.getState().beginDialogueRun('R2')
    window.store.getState().adoptDialogueAnalysis(null, '이번 분석에서는 발언 구간이 오지 않았습니다.')
  })
  await page.waitForSelector('[data-testid="dialogue-workspace"]')
  assert.equal(await page.getByTestId('dialogue-row').count(), 0)
  assert.match(await page.getByTestId('dialogue-workspace').innerText(), /오지 않았습니다/)
  pass('★구간이 오지 않으면 앞 결과를 되살리지 않고 사유를 말한다')

  // ★늦게 온 지난 실행의 결과는 지금 작업을 덮지 않는다.
  await openWith('C:/work/B.wav', 'R3')
  await page.evaluate(() => {
    window.store.getState().adoptDialogueAnalysis({
      sourceKey: 'C:/work/B.wav', runId: 'R2',
      segments: [{ start: 0, end: 1, speaker: '화자 Z' }], speakers: ['화자 Z'],
      overlaps: [], outputDir: 'C:/old', durationSec: 40, trimSilence: false, transcribe: false,
    })
  })
  await page.waitForTimeout(120)
  assert.equal(await page.getByTestId('dialogue-row').count(), 3, '지난 실행의 결과가 들어왔다')
  assert.equal(await page.evaluate(() => window.store.getState().dialogueNotice), '지난 실행의 결과입니다.')
  pass('★늦게 온 지난 실행의 결과가 지금 작업을 덮지 않는다')

  // ══ 2. 인물 카드 ═══════════════════════════════════════════════════════
  await openWith('C:/work/A.wav', 'R10')
  const cards = page.getByTestId('dialogue-card')
  assert.match(await cards.nth(0).getByTestId('dialogue-card-count').innerText(), /발언 2개/)
  assert.match(await cards.nth(1).getByTestId('dialogue-card-count').innerText(), /발언 1개/)
  pass('카드가 인물별 발언 수를 보여 준다')

  await cards.nth(0).getByTestId('dialogue-card-name').fill('민수')
  await page.waitForTimeout(80)
  assert.equal(await cards.nth(0).getByTestId('dialogue-card-name').inputValue(), '민수')
  const firstOption = await page.getByTestId('dialogue-speaker').first().innerText()
  assert.match(firstOption, /민수/, '목록의 인물 이름도 함께 바뀐다')
  pass('★이름을 바꾸면 카드와 발언 목록이 같이 바뀐다')

  // 카드로 거르고 전체로 돌아온다.
  await cards.nth(1).getByTestId('dialogue-card-filter').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-row"]').length === 1)
  pass('★카드를 고르면 그 인물의 발언만 남는다')
  await page.getByTestId('dialogue-card-all').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-row"]').length === 3)
  pass("'전체' 로 돌아온다")

  // ── 합치기: 두 카드를 고르고 한쪽으로 ───────────────────────────────
  await cards.nth(0).getByTestId('dialogue-card-merge').check()
  await cards.nth(1).getByTestId('dialogue-card-merge').check()
  await page.waitForSelector('[data-testid="dialogue-merge-bar"]')
  await page.getByTestId('dialogue-merge-into').first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 1)
  assert.match(await page.getByTestId('dialogue-card-count').innerText(), /발언 3개/)
  pass('★잘못 나뉜 인물을 하나로 합친다')

  await page.getByTestId('dialogue-undo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 2)
  pass('★합치기를 되돌리기 **한 번**으로 되돌린다')
  await page.getByTestId('dialogue-redo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 1)
  await page.getByTestId('dialogue-undo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 2)
  pass('다시 적용도 된다')

  // ══ 3. 시간순 발언 목록 ═══════════════════════════════════════════════
  // 시간 입력은 평소 숨긴다.
  assert.equal(await page.getByTestId('dialogue-start').count(), 0, '시간 입력이 평소에 보인다')
  await page.getByTestId('dialogue-toggle-times').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-start"]').length === 3)
  pass('★시간 고치기는 평소 숨기고 눌렀을 때만 보인다')
  await page.getByTestId('dialogue-toggle-times').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-start"]').length === 0)

  // 여러 개 골라 한 번에 인물 변경.
  const picks = page.getByTestId('dialogue-pick')
  await picks.nth(0).check()
  await picks.nth(2).check()
  await page.waitForSelector('[data-testid="dialogue-bulk"]')
  await page.getByTestId('dialogue-bulk-assign').nth(1).click()   // 두 번째 인물에게
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')].filter((r) => r.dataset.edited === '1').length === 2)
  pass('★여러 발언을 골라 한 번에 인물을 바꾼다')
  await page.getByTestId('dialogue-undo').click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')].filter((r) => r.dataset.edited === '1').length === 0)
  pass('일괄 변경도 한 걸음으로 되돌린다')

  // ══ 4. 적용·저장 ══════════════════════════════════════════════════════
  await page.getByTestId('dialogue-speaker').first().selectOption({ index: 1 })
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('반영되지 않았'))
  pass('★아직 음원에 반영하지 않은 교정을 "저장 완료" 로 말하지 않는다')

  // ★요청을 넣은 것만으로 '만들었다' 고 하지 않는다.
  await page.getByTestId('dialogue-rebuild').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('만드는 중'))
  assert.equal(await page.evaluate(() => window.__rebuilt), 1)
  const reqId = await page.evaluate(() => window.__lastReq?.clientRequestId)
  assert.ok(reqId, '요청 식별자를 보내지 않았다')
  pass('★요청 접수는 "만드는 중" 이다 — 아직 만들었다고 하지 않는다')

  // 남의 요청 결과는 받지 않는다.
  await page.evaluate(() => window.__fire('result', { clientRequestId: 'SOMEONE_ELSE', tracks: [{ name: 'x', label: 'x', path: 'C:/x.wav' }] }))
  await page.waitForTimeout(120)
  assert.match(await page.getByTestId('dialogue-apply-state').innerText(), /만드는 중/,
    '다른 요청의 결과를 내 것으로 받았다')
  pass('★다른 요청의 결과를 내 것으로 받지 않는다')

  // ★실패하면 미적용을 유지한다.
  await page.evaluate((id) => window.__fire('error', { clientRequestId: id, message: '엔진이 실패했습니다' }), reqId)
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('만들지 못했'))
  assert.match(await page.getByTestId('dialogue-message').innerText(), /엔진이 실패/)
  pass('★실패하면 미적용을 유지하고 사유를 말한다')

  // 다시 해서 이번에는 내 요청의 결과가 온다.
  await page.getByTestId('dialogue-rebuild').click()
  const reqId2 = await page.evaluate(() => window.__lastReq?.clientRequestId)
  assert.notEqual(reqId2, reqId, '요청마다 다른 식별자여야 한다')
  await page.evaluate((id) => window.__fire('result', {
    clientRequestId: id, tracks: [{ name: 'edited_a', label: 'a', path: 'C:/out/edited_a.wav' }],
  }), reqId2)
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('음원을 만들었'))
  assert.match(await page.getByTestId('dialogue-message').innerText(), /최초 결과는 그대로/)
  pass('★그 요청의 결과를 받은 뒤에만 적용 완료로 표시한다')

  // ── 내보내기 대상 표시 ───────────────────────────────────────────────
  assert.match(await page.getByTestId('dialogue-export').innerText(), /교정본 내보내기/)
  await page.getByTestId('dialogue-export').click()
  await page.waitForFunction(() => window.__exported !== null)
  assert.deepEqual(await page.evaluate(() => window.__exported), ['C:/out/edited_a.wav'])
  assert.match(await page.getByTestId('dialogue-export-note').innerText(), /교정본/)
  pass('★교정본을 내보내면 교정본 파일이 나간다 — 무엇을 내보내는지 적는다')

  await page.getByTestId('dialogue-target-original').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-export"]').innerText.includes('최초 결과'))
  pass('★최초 결과와 교정본을 골라 내보낼 수 있다')

  // ── 파일별 보존: A 를 교정하고 B 에 갔다가 돌아온다 ──────────────────
  await page.waitForTimeout(700)                       // 저장 반영 대기
  const savedKeys = await page.evaluate(() => Object.keys(window.__settings))
  assert.ok(savedKeys.includes('dialogueDrafts'), `교정이 저장되지 않았다: ${JSON.stringify(savedKeys)}`)
  await openWith('C:/work/B.wav', 'R11')
  await page.waitForTimeout(200)
  await openWith('C:/work/A.wav', 'R10')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')].some((r) => r.dataset.edited === '1'))
  pass('★파일마다 교정을 따로 보존한다 — 다른 파일을 열어도 덮이지 않는다')

  // ── 옛 한 칸 기록 이어받기 ──────────────────────────────────────────
  await page.evaluate(() => {
    window.__settings = {
      dialogueEdits: {
        sourcePath: 'C:/work/C.wav',
        segments: [{ start: 1, end: 3, speaker: '화자 A' }, { start: 4, end: 12, speaker: '화자 B' },
          { start: 13, end: 15, speaker: '화자 A' }],
        edits: { 1: { speaker: '화자 A' } }, updatedAt: 7,
      },
    }
  })
  await openWith('C:/work/C.wav', 'R20')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')].some((r) => r.dataset.edited === '1'))
  assert.match(await page.getByTestId('dialogue-message').innerText(), /이어서 불러왔습니다/)
  pass('★옛 한 칸에 남아 있던 교정을 버리지 않고 이어받는다')

  // ══ 5. 보완 항목 ══════════════════════════════════════════════════════
  // ★취소하면 미적용을 유지한다.
  await openWith('C:/work/D.wav', 'R30')
  await page.getByTestId('dialogue-speaker').first().selectOption({ index: 1 })
  await page.getByTestId('dialogue-rebuild').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('만드는 중')
    || document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('요청을 보냈'))
  await page.evaluate(() => window.__fire('cancel', {}))
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('멈췄습니다'))
  pass('★취소하면 미적용을 유지한다')

  // ★만드는 동안 더 고치면, 완성된 음원은 **요청 당시** 것이다.
  await page.getByTestId('dialogue-rebuild').click()
  const rid = await page.evaluate(() => window.__lastReq?.clientRequestId)
  await page.getByTestId('dialogue-speaker').nth(1).selectOption({ index: 0 })
  await page.evaluate((id) => window.__fire('result', {
    clientRequestId: id, tracks: [{ name: 'edited_a', label: 'a', path: 'C:/out/edited_a.wav' }],
  }), rid)
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-apply-state"]').innerText.includes('반영되지 않았'))
  pass('★만드는 동안 더 고치면 나중 편집까지 반영된 것처럼 말하지 않는다')

  // ★결과 듣기 — 고른 쪽만 보여 준다.
  await page.waitForSelector('[data-testid="dialogue-result-tracks"]')
  await page.getByTestId('dialogue-target-edited').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-track-play"]').length === 1)
  await page.getByTestId('dialogue-target-original').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-track-play"]').length === 2)
  pass('★결과 듣기 목록이 고른 대상(최초/교정본)만 보여 준다')

  // ══ 6. 대본 — 인물을 바꿔도 대사가 따라간다 ════════════════════════════
  await page.evaluate(() => {
    window.__transcripts = {
      'speaker_a_timestamps.txt': '[0:01 → 0:03] 첫 마디\n[0:13 → 0:15] 끝 마디',
      'speaker_b_timestamps.txt': '[0:04 → 0:12] 비의 말\n[0:50 → 0:52] 엉뚱한 줄',
    }
    window.__readCalls = []
  })
  await openWith('C:/work/T.wav', 'R40', SEGS, { transcribe: true, outputDir: 'C:/out' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="dialogue-text"]')].some((e) => e.innerText.includes('비의 말')))
  pass('받아쓴 대사가 발언에 붙는다')

  // 인물 B 를 A 에 합쳐도 B 의 대본 파일을 읽고 대사가 남는다.
  const c2 = page.getByTestId('dialogue-card')
  await c2.nth(0).getByTestId('dialogue-card-merge').check()
  await c2.nth(1).getByTestId('dialogue-card-merge').check()
  await page.getByTestId('dialogue-merge-into').first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 1)
  await page.waitForTimeout(250)
  const afterMerge = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="dialogue-text"]')].map((e) => e.innerText))
  assert.ok(afterMerge.some((x) => x.includes('비의 말')),
    `합쳤더니 대사가 사라졌다: ${JSON.stringify(afterMerge)}`)
  pass('★인물을 합쳐도 그 인물의 대본을 읽고 대사가 남는다')

  // 발언을 다른 인물에게 옮겨도 그 대사는 그 발언을 따라간다.
  await page.getByTestId('dialogue-undo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dialogue-card"]').length === 2)
  await page.getByTestId('dialogue-speaker').nth(1).selectOption({ index: 0 })
  await page.waitForTimeout(200)
  const afterMove = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="dialogue-row"]')].map((r) => ({
      who: r.querySelector('[data-testid="dialogue-speaker"]').value,
      text: r.querySelector('[data-testid="dialogue-text"]').innerText,
    })))
  assert.ok(afterMove[1].text.includes('비의 말'),
    `인물을 옮겼더니 대사가 바뀌었다: ${JSON.stringify(afterMove)}`)
  pass('★발언을 다른 인물에게 옮겨도 대사는 그 발언을 따라간다')

  // 어디에도 못 붙은 줄은 '확인 필요' 로 남는다.
  await page.waitForSelector('[data-testid="dialogue-unsure-toggle"]')
  await page.getByTestId('dialogue-unsure-toggle').click()
  await page.waitForSelector('[data-testid="dialogue-orphans"]')
  assert.match(await page.getByTestId('dialogue-orphans').innerText(), /엉뚱한 줄/)
  pass('★맞지 않는 대사도 버리지 않고 원문을 볼 수 있다')

  // ══ 7. 빈 초안이 저장본을 지우지 않는다 ════════════════════════════════
  // 앞 파일의 저장이 끝나기를 기다린 뒤 보관함을 갈아 끼운다(검사 준비).
  await page.evaluate(() => { window.store.getState().adoptDialogueAnalysis(null, '') })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    window.__settings = { dialogueDrafts: { version: 1, drafts: {
      'C:/keep.wav\u001fRX': { sourceKey: 'C:/keep.wav', runId: 'RX', names: {}, merges: {}, edits: { 0: { speaker: 'X' } }, updatedAt: 5 },
    } } }
    window.__getDelay = 900          // 읽기가 늦다 — 저장이 먼저 돌 뻔한 상황
  })
  await openWith('C:/work/E.wav', 'R50')
  await page.waitForTimeout(1400)
  const kept = await page.evaluate(() => Object.keys(window.__settings.dialogueDrafts?.drafts || {}))
  assert.ok(kept.some((k) => k.startsWith('C:/keep.wav')),
    `읽기 전에 빈 초안이 저장본을 지웠다: ${JSON.stringify(kept)}`)
  pass('★읽기가 늦어도 빈 초안이 기존 저장본을 지우지 않는다')

  // ══ 8. 읽기 실패를 '저장 없음' 으로 단정하지 않는다 ════════════════════
  await page.evaluate(() => { window.store.getState().adoptDialogueAnalysis(null, '') })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    window.__getDelay = 0
    window.__settings = { dialogueDrafts: { version: 1, drafts: {
      'C:/keep.wav\u001fRX': { sourceKey: 'C:/keep.wav', runId: 'RX', names: {}, merges: {}, edits: { 0: { speaker: 'X' } }, updatedAt: 5 },
    } } }
    window.api.settings.get = async () => { throw new Error('읽기 실패') }
  })
  await openWith('C:/work/F.wav', 'R60')
  await page.waitForSelector('[data-testid="dialogue-read-fail"]')
  await page.getByTestId('dialogue-speaker').first().selectOption({ index: 1 })
  await page.waitForTimeout(900)
  const stillThere = await page.evaluate(() => Object.keys(window.__settings.dialogueDrafts?.drafts || {}))
  assert.ok(stillThere.some((k) => k.startsWith('C:/keep.wav')),
    `읽기 실패 뒤 남의 저장본을 덮었다: ${JSON.stringify(stillThere)}`)
  pass('★읽기 실패를 "저장 없음" 으로 단정하지 않고, 남의 저장본도 덮지 않는다')

  // ══ 9. 이전 분석 교정에 다시 접근할 수 있다 ════════════════════════════
  await page.evaluate(() => { window.store.getState().adoptDialogueAnalysis(null, '') })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    window.api.settings.get = async () => JSON.parse(JSON.stringify(window.__settings))
    window.__settings = { dialogueDrafts: { version: 1, drafts: {
      'C:/work/G.wav\u001fOLD': {
        sourceKey: 'C:/work/G.wav', runId: 'OLD', names: { '화자 A': '옛이름' },
        merges: {}, edits: { 1: { speaker: '화자 A' } }, updatedAt: 9,
      },
    } } }
  })
  await openWith('C:/work/G.wav', 'NEW')
  await page.waitForSelector('[data-testid="dialogue-past-toggle"]')
  const auto = await page.evaluate(() =>
    document.querySelector('[data-testid="dialogue-card-name"]').value)
  assert.notEqual(auto, '옛이름', '다른 실행의 교정을 저절로 적용했다')
  pass('★다른 실행의 교정을 저절로 적용하지 않는다')
  await page.getByTestId('dialogue-past-toggle').click()
  await page.getByTestId('dialogue-past-load').first().click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-card-name"]').value === '옛이름')
  pass('★사용자가 고르면 이전 분석의 교정을 가져온다')
  await page.getByTestId('dialogue-undo').click()
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="dialogue-card-name"]').value !== '옛이름')
  pass('가져오기도 되돌리기 한 번으로 되돌린다')

  // ══ 좁은 창 ════════════════════════════════════════════════════════════
  await page.setViewportSize({ width: 420, height: 900 })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  const scrolls = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="dialogue-cards"]')
    return { x: getComputedStyle(el).overflowX, wide: el.scrollWidth > el.clientWidth }
  })
  assert.equal(scrolls.x, 'auto', '카드 줄이 가로로 밀리지 않는다')
  pass('★좁은 창에서 카드 줄은 가로로 밀고 본문은 넘치지 않는다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-dialogue-narrow.png') })
  await page.setViewportSize({ width: 980, height: 900 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-dialogue-wide.png') })

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, shots: process.env.TEMP || '.' }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-dialogue-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
