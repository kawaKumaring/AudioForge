// 옛 기록 지우기 — **정말 사라지는가.** 실제 앱에서 본다.
//
// ★신고 (2026-09-28): 지우기를 눌렀는데 기록이 그대로 있었다.
//   앞선 검사는 통과했지만 **옛 화면을 띄우지 않았다.** 그래서 못 봤다:
//   옛 화면은 문서를 메모리에 들고 바뀔 때마다·떠날 때마다 다시 쓴다.
//   지워도 탭을 한 번 옮기면 그 문서가 되살아난다.
//
// 여기서 보는 것:
//   1) 옛 화면을 **열었다 나온 뒤** 지워도 되살아나지 않는다
//   2) 지운 뒤 다시 옛 화면에 들어갔다 나와도 되살아나지 않는다
//   3) 껐다 켜도 지워진 채다
//   4) 옆 기록(자동 저장)과 가져온 카드 작업은 그대로다
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { createRequire } from 'node:module'
const TR = createRequire(import.meta.url)('../../tools/test-root.cjs')   // 테스트 전용 폴더(_local/테스트) — 2026-10-10
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

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
const seed = (wav) => ({
  labWorkspace: {
    voicePath: wav, voiceLabel: '옛 목소리',
    settings: { speed: 1, pitch: 0, silenceGap: 0.5 },
    updatedAt: 1700000000000,
    lines: [
      { id: 'l1', text: '지워질 첫 줄', adoptedTakeId: null, takes: [] },
      { id: 'l2', text: '지워질 둘째 줄', adoptedTakeId: null, takes: [] },
    ],
  },
  workDrafts: {
    schemaVersion: 1,
    drafts: {
      keep1: {
        schemaVersion: 1, sourcePath: 'E:/없는곳/남을것.wav', updatedAt: '2026-09-20T10:00:00.000Z',
        ttsText: '이 기록은 남아야 한다', speakerMode: 'single',
        speakers: {}, renames: {}, inheritSpeakerId: null,
      },
    },
  },
})

const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
})

/** 설정에 남아 있는 것을 센다. */
const countLegacy = (win) => win.evaluate(async () => {
  const all = await window.api.settings.get()
  return {
    lab: all.labWorkspace ? (all.labWorkspace.lines || []).length : -1,   // -1 = 항목 자체가 없다
    drafts: Object.keys(all.workDrafts?.drafts || {}).length,
  }
})

/** 옛 화면(합성 → 옛 버전)에 들어갔다 나온다. 되살아나기를 일으키는 조작이다. */
const visitLegacy = async (win) => {
  await win.getByTestId('open-legacy-synthesis').click()
  await win.waitForTimeout(900)           // 자동 저장 대기(600ms)보다 넉넉히
  await win.getByTestId('back-to-generation-cards').click()
  await win.waitForSelector('[data-testid="synthesis-card-workspace"]')
  await win.waitForTimeout(400)
}

let app = null
try {
  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  await win.evaluate(async (s) => {
    for (const [k, v] of Object.entries(s)) await window.api.settings.set(k, v)
  }, seed(WAV))

  await win.getByTestId('mode-tts').click()
  await win.waitForSelector('[data-testid="synthesis-card-workspace"]')
  if (await win.locator('text=이전 작업을 불러올까요?').count()) {
    await win.locator('button', { hasText: '현재 작업 계속' }).click()
  }

  // ── 1. 옛 화면을 열었다 나온 뒤 지운다 ────────────────────────────────
  await visitLegacy(win)
  const seen = await countLegacy(win)
  ok(seen.lab === 2, '옛 화면을 다녀와도 기록은 그대로다(아직 안 지웠다)', seen)

  await win.getByTestId('import-legacy').click()
  await win.waitForSelector('[data-testid="import-work"]')
  await win.locator('[data-testid="import-work"][data-key="lab"]').getByTestId('import-drop').click()
  await win.getByTestId('import-drop-yes').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="import-work"][data-key="lab"]'))
  await win.keyboard.press('Escape')
  await win.waitForFunction(() => !document.querySelector('dialog[aria-label="옛 작업 가져오기"]'))

  const justAfter = await countLegacy(win)
  ok(justAfter.lab === -1, '지운 직후 기록이 없다', justAfter)

  // ── 2. ★되살아나기 — 옛 화면에 다시 들어갔다 나온다 ───────────────────
  await visitLegacy(win)
  const afterVisit = await countLegacy(win)
  ok(afterVisit.lab === -1,
    '★지운 뒤 옛 화면을 다녀와도 되살아나지 않는다', afterVisit)
  ok(afterVisit.drafts === 1, '옆 기록(자동 저장)은 그대로다', afterVisit)

  // 한 번 더 — 화면을 떠날 때의 마지막 저장까지 본다
  await visitLegacy(win)
  const afterTwice = await countLegacy(win)
  ok(afterTwice.lab === -1, '★두 번 다녀와도 되살아나지 않는다', afterTwice)

  // ── 3. 껐다 켜도 지워진 채 ────────────────────────────────────────────
  await app.close(); app = null
  app = await launch()
  win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  const afterRestart = await countLegacy(win)
  ok(afterRestart.lab === -1, '★껐다 켜도 지워진 채다', afterRestart)
  ok(afterRestart.drafts === 1, '껐다 켜도 옆 기록은 남아 있다', afterRestart)

  // 다시 들어가 봐도 마찬가지
  await win.getByTestId('mode-tts').click()
  await win.waitForSelector('[data-testid="synthesis-card-workspace"]')
  if (await win.locator('text=이전 작업을 불러올까요?').count()) {
    await win.locator('button', { hasText: '현재 작업 계속' }).click()
  }
  await visitLegacy(win)
  const finalCheck = await countLegacy(win)
  ok(finalCheck.lab === -1, '★재시작 뒤 옛 화면을 다녀와도 되살아나지 않는다', finalCheck)

  const shot = TR.shot('legacy-delete.png')
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
