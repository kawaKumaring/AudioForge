// 앱을 껐다 켜도 **무엇으로 만든 소리인가**가 남아 있는가.
//
// ★2026-09-27 Codex 재현: 저장 왕복에서 기본 목소리 지정·생성본 목소리·실제 쓰인 참조 구간이
//   사라졌다. 파서 단위 검사는 `source` 만 있는 fixture 를 써서 이것을 잡지 못했다.
//   그래서 여기서는 **진짜 앱을 두 번 띄운다** — 기본 목소리로 실제 생성하고, 끄고, 켜서,
//   사용자가 '불러오기' 를 누르는 경로 그대로 되살린다.
//
// 실행: node test/e2e/synthesis-cards-restart.e2e.mjs   (사전: npm run build)
//   쓸 수 있는 기본 목소리가 없으면 건너뛴다(없는 것을 있는 척하지 않는다).
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const ud = isolatedUserData()          // 두 번의 실행이 **같은** 보관 자리를 쓴다
const LINE = '저장 확인용 문장입니다.'

const launch = () => electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
})

let app = null
try {
  // ── 1차 실행: 기본 목소리로 실제 생성하고 끈다 ──────────────────────────
  app = await launch()
  let win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)

  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다')
    await app.close(); cleanupUserData(ud); process.exit(0)
  }
  console.log('  [증거] 기본 목소리:', voices[0].label, voices[0].modelId)

  await win.getByTestId('mode-tts').click()
  await win.getByTestId('add-generation-card').click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  await win.getByTestId('pick-voice-builtin').first().click()
  await win.getByTestId('pick-voice-confirm').click()
  await win.getByTestId('generation-card').first().waitFor()
  await win.getByTestId('card-script').first().fill(LINE)
  await win.waitForTimeout(300)
  await win.getByTestId('card-generate').first().click()
  await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 180000 }).catch(() => {})

  const before = await win.evaluate(() => {
    const c = window.__synthesisCards.getState().cards[0]
    return {
      builtin: c.builtin ?? null,
      takes: c.takes.length,
      takeVoice: c.takes[0]?.voice ?? null,
      applied: c.takes[0]?.applied ?? null,
      path: c.takes[0]?.path ?? '',
      adopted: c.adoptedId,
    }
  })
  check(before.takes === 1 && !!before.path, '기본 목소리로 실제 생성본이 만들어졌다', before)
  check(before.builtin?.modelId === voices[0].modelId, '끄기 전 카드가 기본 목소리를 가진다', before.builtin)
  check(before.takeVoice?.kind === 'builtin', '끄기 전 생성본에 목소리 기록이 있다', before.takeVoice)

  // 저장이 디스크에 닿을 때까지 기다린다(저장은 화면 수명과 분리돼 있다).
  await win.waitForFunction(async () => {
    const got = await window.api.settings.get()
    const raw = got?.synthesisCards
    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw
    const cur = doc?.current ?? doc
    return !!(cur?.cards?.[0]?.takes?.length)
  }, null, { timeout: 30000 }).catch(() => {})
  await app.close(); app = null

  // ★디스크에 실제로 무엇이 적혔는지 **검사 프로세스에서** 본다(main 은 ESM 이라 동적 import 불가).
  //
  // ★2026-09-29: 카드 작업이 **설정 한 칸에서 파일 하나씩**으로 옮겨졌다.
  //   하던 것과 보관함이 각자 파일이다 — 하나를 지워도 다른 하나를 다시 쓰지 않는다.
  const cardDir = path.join(ud, 'works', 'cards')
  const cardFiles = fs.existsSync(cardDir) ? fs.readdirSync(cardDir).filter((f) => f.endsWith('.json')) : []
  check(cardFiles.length >= 1, '★카드 작업이 기록 파일로 적힌다', cardFiles)
  const readRecord = (key) => {
    for (const f of cardFiles) {
      try {
        const got = JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf-8'))
        if (got?.key === key) return got.data
      } catch { /* 깨진 파일은 건너뛴다 */ }
    }
    return null
  }
  const savedCard = readRecord('current')?.cards?.[0]
  check(!!savedCard?.builtin?.modelId, '저장 파일에 기본 목소리 지정이 적힌다', savedCard?.builtin ?? null)
  check(!!savedCard?.takes?.[0]?.voice, '저장 파일에 생성본 목소리가 적힌다', savedCard?.takes?.[0]?.voice ?? null)

  // ── 2차 실행: 다시 켜고 사용자가 '불러오기' 를 누른다 ────────────────────
  app = await launch()
  win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  await win.getByTestId('mode-tts').click()

  const restoreDialog = win.getByRole('dialog', { name: '이전 작업을 불러올까요?' })
  await restoreDialog.waitFor({ timeout: 30000 })
  check(true, '다시 켜면 이전 작업을 묻는다(묻지 않고 되살리지 않는다)')
  const emptyBefore = await win.evaluate(() => window.__synthesisCards.getState().cards.length)
  check(emptyBefore === 0, '묻는 동안에는 아직 되살리지 않았다', emptyBefore)

  await restoreDialog.getByRole('button', { name: '불러오기' }).first().click()
  await win.waitForFunction(() => window.__synthesisCards.getState().cards.length > 0,
    null, { timeout: 30000 })

  const after = await win.evaluate(() => {
    const c = window.__synthesisCards.getState().cards[0]
    return {
      builtin: c.builtin ?? null,
      text: c.text,
      takes: c.takes.length,
      takeVoice: c.takes[0]?.voice ?? null,
      applied: c.takes[0]?.applied ?? null,
      missing: c.takes[0]?.missing ?? null,
      adopted: c.adoptedId,
    }
  })
  check(after.text === LINE, '대사가 돌아온다', after.text)
  check(after.takes === 1, '생성본이 돌아온다', after.takes)
  check(after.builtin?.modelId === before.builtin?.modelId
    && after.builtin?.engineId === before.builtin?.engineId
    && after.builtin?.path === before.builtin?.path,
  '★기본 목소리 지정이 그대로 돌아온다(엔진·모델·경로)', { before: before.builtin, after: after.builtin })
  check(after.takeVoice?.kind === 'builtin' && after.takeVoice?.modelId === before.takeVoice?.modelId,
    '★생성본의 목소리 기록이 그대로 돌아온다', { before: before.takeVoice, after: after.takeVoice })
  check(after.adopted === before.adopted, '채택 여부가 그대로다', { before: before.adopted, after: after.adopted })
  check(after.missing !== true, '있는 파일을 없다고 하지 않는다', after.missing)

  // 되살린 카드로 **곧바로 다시 만들 수 있어야** 한다 — 목소리가 없으면 생성이 막힌다.
  const canGenerate = await win.getByTestId('card-generate').first().isEnabled()
  check(canGenerate, '되살린 카드로 바로 생성할 수 있다(목소리를 잃지 않았다)',
    await win.evaluate(() => document.querySelector('[data-testid="card-generate"]')?.title))

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  console.log('  [증거] 기록 파일:', cardDir, cardFiles.join(', '))
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  process.exit(1)
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(ud)
}
