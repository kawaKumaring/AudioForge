// 옛 작업 → 카드 가져오기 — **실제 앱에서** 본다.
//
// 붙드는 것:
//   1) 대사·생성본·채택이 그대로 옮겨진다
//   2) 하던 작업도 옛 기록도 **그대로 남는다**(복사이지 이사가 아니다)
//   3) 사라진 파일 · 설정 기록 없음 · 배역 대응 없음을 **그대로 말한다**
//   4) 저장이 실패하면 **카드가 한 장도 들어가지 않는다**
//   5) 같은 작업을 또 가져오려 하면 알리고 고르게 한다
//   6) 껐다 켜도 가져온 내용이 남는다
//
// 실행: node test/e2e/card-import.e2e.mjs   (사전: npm run build)
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
const GONE = path.join(APP, 'test', 'fixtures', 'audio', '__사라진생성본__.wav')

/** 옛 기록 두 자리를 심는다. 실제 앱의 설정 통로로만 쓴다. */
const seed = (wav, gone) => ({
  labWorkspace: {
    voicePath: wav, voiceLabel: '옛 목소리',
    settings: { speed: 1.25, pitch: -3, silenceGap: 0.9, engine: 'qwen', tailMode: 'auto' },
    updatedAt: 1700000000000,
    lines: [
      {
        id: 'l1', text: '첫째 줄입니다', adoptedTakeId: 't2',
        takes: [
          { id: 't1', path: gone, text: '첫째 줄 옛 대사', voiceKey: wav, createdAt: 10 },
          { id: 't2', path: wav, text: '첫째 줄입니다', voiceKey: wav, createdAt: 20 },
        ],
      },
      { id: 'l2', text: '둘째 줄입니다', adoptedTakeId: null, takes: [] },
    ],
  },
  workDrafts: {
    schemaVersion: 1,
    drafts: {
      d1: {
        schemaVersion: 1, sourcePath: 'E:/없는곳/대화.wav', updatedAt: '2026-09-20T10:00:00.000Z',
        ttsText: '누가 말했는지 모르는 대사', speakerMode: 'multi',
        speakers: {
          s1: { source: 'E:/없는곳/A.wav', region: null, label: 'A', emotionEnabled: false },
          s2: { source: 'E:/없는곳/B.wav', region: null, label: 'B', emotionEnabled: false },
        },
        renames: {}, inheritSpeakerId: null,
      },
    },
  },
})

const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
})

let app = null
try {
  // 사라진 생성본 자리는 **일부러 없는 경로**다. 만들지 않는다.
  if (fs.existsSync(GONE)) fs.rmSync(GONE)

  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)

  // 옛 기록을 심고, 하던 카드 작업도 하나 만들어 둔다(보관되는지 보려고).
  await win.evaluate(async (s) => {
    for (const [k, v] of Object.entries(s)) await window.api.settings.set(k, v)
    await window.api.settings.set('synthesisCards', {
      current: {
        cards: [{ id: 'now', label: '하던 것', sourcePath: '', sourceName: '', sourceDuration: 0,
          text: '하던 대사', settings: {}, takes: [], adoptedId: null }],
        joins: {}, savedAt: 1,
      },
      kept: [],
    })
  }, seed(WAV, GONE))

  await win.getByTestId('mode-tts').click()
  await win.waitForSelector('[data-testid="synthesis-card-workspace"]')
  // 되살리기 팝업이 떠 있으면 닫는다(이 검사의 주제가 아니다).
  if (await win.locator('text=이전 작업을 불러올까요?').count()) {
    await win.locator('button', { hasText: '현재 작업 계속' }).click()
  }
  // 하던 작업을 화면에 세운다 — 가져오기가 이것을 지우지 않는지 보려고.
  await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    s.replaceAll([{ id: 'now', label: '하던 것', source: null, text: '하던 대사',
      settings: { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 0 },
      takes: [], adoptedId: null }], { gap: 0.35, level: true, edges: true, gaps: {} })
  })

  // ── 1. 고르기 ──────────────────────────────────────────────────────────
  await win.getByTestId('import-legacy').click()
  await win.waitForSelector('[data-testid="import-work"]')
  const keys = await win.locator('[data-testid="import-work"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-key')))
  ok(keys.includes('lab') && keys.includes('draft:d1'), '두 자리의 옛 작업이 모두 보인다', keys)

  // ── 2. 가져올 내용 확인 ────────────────────────────────────────────────
  await win.locator('[data-testid="import-work"][data-key="lab"]').getByTestId('import-pick').click()
  await win.waitForSelector('[data-testid="import-counts"]')
  const counts = await win.getByTestId('import-counts').innerText()
  ok(counts.includes('2') , '카드 수·생성본 수를 먼저 보여 준다', counts)
  const skips = await win.getByTestId('import-skips').innerText()
  ok(skips.includes('쉼') && skips.includes('생성본별 설정'),
    '★옮기지 못하는 항목을 가져오기 전에 말한다', skips)
  ok(await win.getByTestId('import-duplicate').count() === 0, '처음 가져오는 것은 중복이 아니다')

  // ── 3. 진짜로 가져온다 ─────────────────────────────────────────────────
  await win.getByTestId('import-run').click()
  await win.waitForSelector('[data-testid="import-done"]')
  await win.getByTestId('import-close').click()

  const got = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return {
      texts: s.cards.map((c) => c.text),
      takes: s.cards.map((c) => c.takes.length),
      adopted: s.cards.map((c) => c.adoptedId),
      unknown: s.cards[0]?.takes.map((t) => !!t.settingsUnknown),
      missing: s.cards[0]?.takes.map((t) => !!t.missing),
      speed: s.cards[0]?.settings.speed,
      pitch: s.cards[0]?.settings.pitch,
      gap: s.joins.gap,
      takeTexts: s.cards[0]?.takes.map((t) => t.text),
    }
  })
  ok(JSON.stringify(got.texts) === JSON.stringify(['첫째 줄입니다', '둘째 줄입니다']),
    '★줄 순서와 대사가 그대로 옮겨졌다', got.texts)
  ok(got.takes[0] === 2 && got.takes[1] === 0, '생성본이 그 줄에 붙었다', got.takes)
  ok(got.adopted[0] === 'lab_t2' && got.adopted[1] === null, '★채택 관계가 보존됐다', got.adopted)
  ok(got.takeTexts[0] === '첫째 줄 옛 대사', '생성본의 당시 대사를 지금 대사로 덮지 않았다', got.takeTexts)
  ok(got.speed === 1.25 && got.pitch === -3, '뜻이 같은 속도·음높이는 옮겼다', got)
  ok(got.gap !== 0.9, '★대사 안의 쉼(0.9)을 카드 사이 간격으로 옮기지 않았다', got.gap)
  ok(JSON.stringify(got.unknown) === JSON.stringify([true, true]),
    '★생성본은 설정 기록 없음으로 남았다', got.unknown)
  ok(got.missing[0] === true && got.missing[1] === false,
    '★사라진 파일은 없음으로 표시하고 다른 파일로 바꾸지 않았다', got.missing)

  // 화면에도 그대로 보이는가
  await win.locator('[data-testid="generation-card"]').first().getByTestId('card-takes').click()
  await win.waitForSelector('[data-testid="take-row"]')
  ok(await win.getByTestId('take-unknown-settings').count() === 2,
    '생성본 목록이 설정 기록 없음을 말한다')
  ok((await win.locator('[data-testid="take-row"]').first().innerText()).includes('파일 없음'),
    '생성본 목록이 파일 없음을 말한다')
  await win.keyboard.press('Escape')

  // ── 4-1. 저장 왕복이 '기록 없음' 을 지어내지 않는다 ────────────────────
  //   ★카드의 참조 설정 '자동' 은 **다음 생성**에 쓸 값이다. 그것이 옛 생성본의
  //     '그때 쓴 값' 으로 새어 들어가면, 하지 않은 기록이 생긴다.
  await win.locator('[data-testid="generation-card"]').first().getByTestId('card-script').fill('첫째 줄 고침')
  await win.waitForFunction(() => {
    const el = document.querySelector('[data-testid="card-save-failed"]')
    return !el
  })
  await win.waitForTimeout(1200)          // 저장은 편집이 멎은 뒤에 쓴다
  const stored = await win.evaluate(async () => {
    const all = await window.api.settings.get()
    const t = all.synthesisCards?.current?.cards?.[0]?.takes?.[0] || {}
    return { settings: t.settings, applied: t.applied, unknown: t.settingsUnknown, text: t.text }
  })
  ok(JSON.stringify(stored.settings) === '{}' && JSON.stringify(stored.applied) === '{}',
    '★저장 왕복 뒤에도 생성본 설정은 비어 있다(자동 구간을 썼다고 적지 않는다)', stored)
  ok(stored.unknown === true, '기록 없음 표시가 저장에도 남는다', stored)
  ok(stored.text === '첫째 줄 옛 대사', '생성본의 당시 대사는 고친 대사로 덮이지 않는다', stored)

  // ── 5. 하던 작업과 옛 기록이 그대로 남았다 ─────────────────────────────
  const kept = await win.evaluate(async () => {
    const all = await window.api.settings.get()
    const cards = all.synthesisCards || {}
    const lab = all.labWorkspace || {}
    return {
      keptTexts: (cards.kept || []).map((w) => w.cards?.[0]?.text),
      importedFrom: cards.current?.importedFrom || null,
      labLines: (lab.lines || []).length,
      labAdopted: lab.lines?.[0]?.adoptedTakeId,
      drafts: Object.keys(all.workDrafts?.drafts || {}),
    }
  })
  ok(kept.keptTexts.includes('하던 대사'), '★하던 작업은 보관함에 그대로 있다', kept.keptTexts)
  ok(kept.labLines === 2 && kept.labAdopted === 't2', '★옛 기록은 손대지 않았다', kept)
  ok(kept.drafts.length === 1, '자동 저장 기록도 그대로다', kept.drafts)
  ok(kept.importedFrom && kept.importedFrom.key === 'lab', '어디서 가져왔는지 남겼다', kept.importedFrom)

  // ── 6. 같은 작업 다시 가져오기 ─────────────────────────────────────────
  await win.getByTestId('import-legacy').click()
  await win.locator('[data-testid="import-work"][data-key="lab"]').getByTestId('import-pick').click()
  await win.waitForSelector('[data-testid="import-duplicate"]')
  ok(true, '★이미 가져온 작업임을 알린다')
  ok(await win.getByTestId('import-open-existing').count() === 1, '가져온 작업을 열 수 있다')
  ok((await win.getByTestId('import-run').innerText()).includes('한 벌 더'),
    '따로 한 벌 더 복사하는 길도 남긴다')
  // 확인 화면의 Esc 는 **목록으로 돌아간다**(닫기가 아니다). 한 번 더 눌러야 닫힌다.
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('dialog[aria-label="옛 작업 가져오기"]'))

  // ── 7. 배역 대응이 없는 자동 저장 ──────────────────────────────────────
  await win.getByTestId('import-legacy').click()
  await win.locator('[data-testid="import-work"][data-key="draft:d1"]').getByTestId('import-pick').click()
  await win.waitForSelector('[data-testid="import-skips"]')
  const dskips = await win.getByTestId('import-skips').innerText()
  ok(dskips.includes('인물 2명'), '★배역 대응이 없다는 것을 먼저 말한다', dskips)
  await win.getByTestId('import-run').click()
  await win.waitForSelector('[data-testid="import-done"]')
  await win.getByTestId('import-close').click()
  const dgot = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards.length, text: s.cards[0]?.text, src: s.cards[0]?.source }
  })
  ok(dgot.n === 1 && dgot.text === '누가 말했는지 모르는 대사',
    '★원문은 보존한다', dgot)
  ok(dgot.src === null, '★배역을 지어내지 않는다 — 목소리는 비어 있다', dgot.src)

  // ── 8. 껐다 켜도 남는가 ────────────────────────────────────────────────
  await app.close(); app = null
  app = await launch()
  win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  const after = await win.evaluate(async () => {
    const all = await window.api.settings.get()
    const c = all.synthesisCards || {}
    return {
      currentText: c.current?.cards?.[0]?.text,
      keptCount: (c.kept || []).length,
      labTexts: (c.kept || []).map((w) => w.cards?.[0]?.text),
      labLines: (all.labWorkspace?.lines || []).length,
    }
  })
  ok(after.currentText === '누가 말했는지 모르는 대사', '★껐다 켜도 가져온 작업이 지금 것이다', after)
  // 가져온 뒤 대사를 고쳤으므로 보관된 것은 **고친 대사**다(가져온 그 작업이 맞다).
  ok(after.labTexts.includes('첫째 줄 고침') && after.labTexts.includes('하던 대사'),
    '★먼저 가져온 작업도 하던 작업도 보관함에 남아 있다', after.labTexts)
  ok(after.labLines === 2, '★옛 기록은 재시작 뒤에도 그대로다', after.labLines)

  // 재시작 뒤에는 화면이 처음 자리로 돌아간다 — 카드 화면으로 다시 들어간다.
  await win.getByTestId('mode-tts').click()
  await win.waitForSelector('[data-testid="synthesis-card-workspace"]')
  if (await win.locator('text=이전 작업을 불러올까요?').count()) {
    await win.locator('button', { hasText: '현재 작업 계속' }).click()
  }

  // ── 9. 저장이 실패하면 한 장도 들어가지 않는다 ─────────────────────────
  //   ★맨 끝에서 한다. 본체의 설정 통로를 대신 구현해 두면 그 뒤 검사가 진짜 앱을
  //     보는 것이 아니게 된다. 여기서는 막기만 하고 되돌리지 않는다.
  const beforeFail = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards.length, texts: s.cards.map((c) => c.text) }
  })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', async () => { throw new Error('검사용 저장 실패') })
  })
  await win.getByTestId('import-legacy').click()
  await win.locator('[data-testid="import-work"][data-key="lab"]').getByTestId('import-pick').click()
  await win.getByTestId('import-run').click()
  await win.waitForSelector('[data-testid="import-fault"]')
  ok(true, '★저장 실패를 그 자리에서 말한다')
  const afterFail = await win.evaluate(() => {
    const s = window.__synthesisCards.getState()
    return { n: s.cards.length, texts: s.cards.map((c) => c.text) }
  })
  ok(JSON.stringify(beforeFail) === JSON.stringify(afterFail),
    '★저장이 실패하면 카드가 한 장도 들어가지 않는다', { beforeFail, afterFail })
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')

  const shot = path.join(APP, '_local', 'artifacts', 'diagnostics', 'card-import.png')
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  await win.screenshot({ path: shot })
  console.log('  [증거] 캡처:', shot)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
