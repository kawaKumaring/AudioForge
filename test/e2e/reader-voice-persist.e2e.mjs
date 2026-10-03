// 낭독 — **고른 목소리를 앱을 껐다 켜도 되살린다**. 파일·모델이 없어도 다른 목소리로 바꾸지 않는다(누락 상태 + 다시 고르기). 조회 실패 ≠ 실제 누락.
// 왜(2026-10-02 재검수 2항): 고른 목소리가 화면 메모리에만 있어 재시작하면 처음 값이 됐다. 저장은 **지정만** — 기본 목소리는 엔진 + 모델 이름(경로 아님),
//   내 목소리 파일은 준비해 둔 조각의 경로. 소리 파일을 복사하지 않는다.
// 실제 화면 · 실제 창 닫기 · 실제 설정 파일 · 실제 목소리 조회(파이썬). 사용자 목소리·음원은 쓰지 않는다 — 검사용 무음 WAV 만.
// 한 곳은 본체의 목소리 조회 통로를 검사용 프로세스에서 잠시 실패로 바꾼다(실패를 일으키는 수단일 뿐).
// 실행: node test/e2e/reader-voice-persist.e2e.mjs     (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const BOOK = path.join(ISO, '목소리 복원 책.txt')
fs.writeFileSync(BOOK, Array.from({ length: 6 }, (_, i) => `목소리 복원 ${i + 1}번째 문단입니다.`).join('\n'), 'utf-8')
/** 0.3초 무음 WAV — 내 목소리 파일 자리 표시(사용자 음원이 아니다). */
const REF = path.join(ISO, '내목소리_조각.wav')
{
  const n = 2400, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  fs.writeFileSync(REF, b)
}
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const SETTINGS = path.join(UD, 'settings.json')
const readPrefs = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')).readerPrefs ?? null } catch { return null } }
const seedPrefs = (patch) => { fs.mkdirSync(UD, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify({ readerPrefs: patch }), 'utf-8') }

let app = null
const launch = async (beforeWindow) => {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: BOOK } })
  if (beforeWindow) await beforeWindow(app)
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  return win
}
/** 사용자가 창을 닫는 것과 같은 길 — 닫는 순간의 저장까지 거친다. */
const closeWindow = async () => {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
  app = null
}
const openReader = async (win) => {
  await win.getByTestId('mode-reader').click()
  await win.waitForTimeout(1500)
}
const pick = (win) => win.evaluate(() => { const p = window.__readerStore.getState().pick; return p ? { kind: p.kind, label: p.label, path: String(p.path), engineId: p.engineId, modelId: p.modelId } : null })
const addBook = async (win) => {
  await win.getByTestId('reader-add-text').first().click()
  await win.waitForSelector('[data-testid="reader-library-book"], [data-testid="reader-paragraph"]')
}

try {
  // ── 1. 기본 목소리를 고르고 창을 닫는다 → 다시 켜면 그 목소리 ──────────────────────────────────
  let win = await launch()
  await openReader(win)
  await addBook(win)
  const voices = (await win.evaluate(() => window.api.cards.builtinVoices()))?.data?.voices || []
  const target = voices.find((v) => v.engineId === 'supertonic' && /남성 2/.test(v.label)) || voices.filter((v) => v.engineId === 'supertonic')[3]
  ok(!!target, '검사 준비: 고를 기본 목소리가 있다', voices.length)
  await win.getByTestId('reader-voice').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  await win.getByTestId('voice-source-builtin').click()
  // 묶음 탭(빠른 낭독)에서 칩을 찾는다
  const chipFor = win.getByTestId('reader-voice-builtin').filter({ has: win.locator(`text=${target.label.replace(/^Supertonic\s*/, '')}`) }).first()
  await chipFor.click()
  await win.getByTestId('reader-voice-confirm').click()
  await win.waitForTimeout(500)
  const chosen = await pick(win)
  ok(chosen?.modelId === target.modelId, '고른 기본 목소리가 적용된다', chosen)
  await closeWindow()                             // 고른 직후 닫는다 — 닫는 순간 저장도 함께 본다
  const saved = readPrefs()
  ok(saved?.voice?.kind === 'builtin' && saved.voice.engineId === target.engineId && saved.voice.modelId === target.modelId && !('path' in saved.voice),
    '★설정 파일에 지정만 남는다(엔진 + 모델 이름 — 경로·소리 파일 없음)', saved?.voice)

  win = await launch()
  await openReader(win)
  const restored = await pick(win)
  ok(restored?.modelId === target.modelId && restored.path.length > 0 && restored.path === target.path,
    '★다시 켜면 고른 기본 목소리가 복원되고 현재 경로가 이어진다(처음 값으로 돌아가지 않는다)', { restored, want: target.path })
  ok(restored?.modelId !== voices[0]?.modelId, '처음 값(첫 기본 목소리)이 아니다', restored?.modelId)
  await closeWindow()

  // ── 2. 저장된 경로가 달라도(앱을 옮겨도) 이름으로 찾는다 ─────────────────────────────────────────
  seedPrefs({ voice: { kind: 'builtin', engineId: target.engineId, modelId: target.modelId, label: '예전 이름표' } })
  win = await launch(); await openReader(win)
  const byName = await pick(win)
  ok(byName?.path === target.path && byName.label === target.label, '경로 없이 엔진 + 모델 이름으로 현재 목소리를 찾는다(이름표도 현재 것으로)', byName)
  await closeWindow()

  // ── 3. 저장된 기본 목소리가 목록에 없다 — 첫 목소리로 바꾸지 않는다 ───────────────────────────────
  seedPrefs({ voice: { kind: 'builtin', engineId: 'qwen-custom', modelId: 'no_such_voice', label: 'Qwen 없어진 목소리' } })
  win = await launch(); await openReader(win)
  const gone = await pick(win)
  ok(gone?.label === 'Qwen 없어진 목소리' && gone.modelId === 'no_such_voice', '★저장된 목소리가 목록에 없어도 다른 목소리로 바꾸지 않는다', gone)
  ok(await win.getByTestId('reader-voice-missing').count() === 1 && await win.getByTestId('reader-voice-pick-other').count() === 1, '누락 상태와 다시 고르는 조작이 보인다')
  await win.getByTestId('reader-voice-pick-other').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  await win.getByTestId('voice-source-builtin').click()
  const anyChip = win.getByTestId('reader-voice-builtin').first()
  const anyLabel = await anyChip.getAttribute('aria-label')
  await anyChip.click(); await win.getByTestId('reader-voice-confirm').click(); await win.waitForTimeout(400)
  ok((await pick(win))?.label === anyLabel && await win.getByTestId('reader-voice-missing').count() === 0, '다시 고르면 그 목소리로 바뀌고 누락 줄이 사라진다', { anyLabel })
  await closeWindow()
  ok(readPrefs()?.voice?.modelId !== 'no_such_voice', '다시 고른 것이 저장된다(누락된 지정이 계속 남지 않는다)', readPrefs()?.voice)

  // ── 4. 내 목소리 파일 — 고르면 저장되고, 다시 켜면 복원된다 ─────────────────────────────────────
  seedPrefs({ recentVoices: [{ path: REF, label: '내 목소리 조각' }] })
  win = await launch(); await openReader(win)
  await win.getByTestId('reader-voice').click()
  await win.getByRole('dialog', { name: '낭독자 고르기' }).waitFor()
  await win.getByTestId('voice-source-reference').click()
  await win.getByTestId('reader-voice-recent').first().click()
  await win.waitForTimeout(500)
  ok((await pick(win))?.kind === 'reference' && (await pick(win))?.path === REF, '내 목소리 파일을 고른다(최근 목소리에서)', await pick(win))
  await closeWindow()
  const savedRef = readPrefs()
  ok(savedRef?.voice?.kind === 'reference' && savedRef.voice.path === REF, '★내 목소리는 파일 자리만 저장한다(복사하지 않는다)', savedRef?.voice)
  win = await launch(); await openReader(win)
  const refBack = await pick(win)
  ok(refBack?.kind === 'reference' && refBack.path === REF && await win.getByTestId('reader-voice-missing').count() === 0, '★다시 켜면 내 목소리 지정이 복원된다(파일이 있으면 누락 줄 없음)', refBack)
  await closeWindow()

  // ── 5. 그 파일이 없어졌다 — 바꾸지 않고 누락으로 보인다 ─────────────────────────────────────────
  fs.rmSync(REF, { force: true })
  win = await launch(); await openReader(win)
  const refGone = await pick(win)
  ok(refGone?.kind === 'reference' && refGone.path === REF, '★파일이 없어도 다른 목소리로 바꾸지 않는다', refGone)
  const note = await win.getByTestId('reader-voice-missing').innerText().catch(() => '')
  ok(/내 목소리 파일을 찾지 못했습니다/.test(note) && await win.getByTestId('reader-play').isDisabled(), '누락 사유가 보이고 낭독 시작은 막힌다', note)
  await closeWindow()

  // ── 6. 시작할 때 목소리 조회가 실패한다 — 저장된 목소리를 그대로 두고 '확인하지 못했다' 로 보인다 ────────
  seedPrefs({ voice: { kind: 'builtin', engineId: target.engineId, modelId: target.modelId, label: target.label } })
  win = await launch(async (a) => {
    // ★통로가 등록된 **뒤에** 바꾼다 — 등록 전에 넣어 두면 본체가 같은 통로를 또 등록하다 죽는다. 첫 조회보다는 먼저(창은 그 뒤에 뜬다).
    await a.evaluate(async ({ ipcMain }) => {
      const m = ipcMain._invokeHandlers
      for (let i = 0; i < 200 && !m.has('card:builtin-voices'); i++) await new Promise((r) => setTimeout(r, 25))
      globalThis.__origVoices = m.get('card:builtin-voices')
      m.set('card:builtin-voices', () => ({ error: '파이썬이 응답하지 않습니다' }))
    })
  })
  await openReader(win)
  const failedPick = await pick(win)
  ok(failedPick?.modelId === target.modelId && failedPick.label === target.label, '★조회가 실패해도 저장된 목소리를 지우거나 바꾸지 않는다', failedPick)
  ok(await win.getByTestId('reader-voice-lookup-failed').count() === 1 && await win.getByTestId('reader-voice-missing').count() === 0, '조회 실패는 \'없다\' 가 아니라 \'확인하지 못했다\' 로 보인다')
  ok(await win.getByTestId('reader-play').isDisabled(), '경로를 찾기 전에는 낭독 시작이 막힌다')
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('card:builtin-voices', globalThis.__origVoices) })
  await win.getByTestId('reader-voice-recheck').click()
  await win.waitForTimeout(2000)
  const afterRecheck = await pick(win)
  ok(afterRecheck?.path === target.path && await win.getByTestId('reader-voice-lookup-failed').count() === 0, '다시 확인하면 경로가 이어지고 조회 실패 줄이 사라진다', afterRecheck)
  await closeWindow()
  ok(readPrefs()?.voice?.modelId === target.modelId, '조회 실패를 겪어도 저장된 지정은 그대로다', readPrefs()?.voice)
} catch (e) {
  fails.push('예외: ' + (e?.message || e)); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD); cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
