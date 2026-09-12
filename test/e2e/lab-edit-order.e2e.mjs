// 문장 삭제·되돌리기·순서 바꾸기 — 표적 확인.
//
// 소리를 **새로 만들지 않는다.** 저장소 fixture 음성을 이미 만든 생성본처럼 얹고,
// 지우고·되돌리고·끌어 옮겼을 때 무엇이 따라가고 무엇이 남는지를 본다.
//
//   1) 삭제 단추가 줄을 고르지 않아도 보인다 / 빈 문장은 바로, 내용 있으면 되돌릴 수 있다
//   2) 되돌리면 문장 id·생성본·사용 중인 음성이 제자리로 돌아온다. 음원 파일은 지워지지 않는다
//   3) 손잡이로 끌어 옮기면 순서가 바뀌고 생성본·사용 중이 그대로 따라간다
//   4) 전체 듣기 중에 지우면 재생이 멈추고 **이전 순서로 다음 문장이 나가지 않는다**
//   5) 만드는 중인 문장은 삭제가 잠기고 이유가 뜬다
//   6) 결과는 화면 순번이 아니라 **문장 id** 로 붙는다 — 옮겨도 다른 문장에 붙지 않는다
//   7) 바뀐 순서가 저장되고 앱을 다시 켜도 그대로다
//
// 실행: node test/e2e/lab-edit-order.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const B = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
for (const f of [A, B]) if (!fs.existsSync(f)) { console.error(`fixture 없음: ${path.basename(f)}`); process.exit(2) }

const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[lab-edit]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch() {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__labStore, undefined, { timeout: 30000 })
  await win.getByTestId('open-lab').click()
  await win.waitForTimeout(800)
  return { app, win }
}

/** 지금 대본을 id·대사·생성본 수·사용 중으로 요약한다. */
const outline = (win) => win.evaluate(() => window.__labStore.getState().doc.lines.map((l) => ({
  id: l.id, text: l.text, takes: l.takes.length, adopted: l.adoptedTakeId,
})))

let app1 = null, app2 = null
try {
  const first = await launch()
  app1 = first.app
  const win = first.win

  // 이미 만들어 둔 결과를 얹는다(새로 만들지 않는다). 3번째는 빈 문장.
  await win.evaluate(([a, b]) => {
    const s = window.__labStore.getState()
    const mk = (id, text, p) => ({
      id: `ln_${id}`, text, adoptedTakeId: `tk_${id}`,
      takes: [{ id: `tk_${id}`, path: p, text, voiceKey: a, createdAt: 1 }],
    })
    s.setDoc({
      voicePath: a, voiceLabel: 'A',
      lines: [mk('1', '하나입니다.', a), mk('2', '둘입니다.', b),
              { id: 'ln_3', text: '', takes: [], adoptedTakeId: null }],
      settings: s.doc.settings, updatedAt: Date.now(),
    })
    s.markLoaded()
  }, [A, B])
  await win.waitForTimeout(500)

  // ── 1) 삭제 단추가 늘 보인다 ────────────────────────────────────────────
  ok(await win.getByTestId('lab-line-remove').count() === 3,
    '줄을 고르지 않아도 문장마다 삭제 단추가 보인다')
  ok(await win.getByTestId('lab-line-remove').first().getAttribute('title') === '문장 삭제',
    '삭제 툴팁이 "문장 삭제" 다')

  // 빈 문장은 바로 사라지고 되돌릴 것이 없다
  await win.getByTestId('lab-line-remove').nth(2).click()
  await win.waitForTimeout(400)
  let o = await outline(win)
  ok(o.length === 2, '빈 문장은 바로 지워진다', JSON.stringify(o.map((l) => l.id)))
  ok(await win.getByTestId('lab-undo-remove').count() === 0, '빈 문장 삭제에는 실행 취소가 붙지 않는다')

  // ── 2) 내용 있는 문장 삭제 → 실행 취소 ──────────────────────────────────
  await win.getByTestId('lab-line-remove').first().click()
  await win.waitForTimeout(400)
  o = await outline(win)
  ok(o.length === 1 && o[0].id === 'ln_2', '내용 있는 문장도 지워진다', JSON.stringify(o.map((l) => l.id)))
  ok(await win.getByTestId('lab-undo-remove').count() === 1, '실행 취소가 나타난다')
  ok(fs.existsSync(A), '삭제해도 생성 음원 파일을 즉시 지우지 않는다')

  await win.getByTestId('lab-undo-remove').click()
  await win.waitForTimeout(400)
  o = await outline(win)
  ok(o.length === 2 && o[0].id === 'ln_1' && o[1].id === 'ln_2',
    '실행 취소가 원래 자리로 되살린다', JSON.stringify(o.map((l) => l.id)))
  ok(o[0].takes === 1 && o[0].adopted === 'tk_1', '되살린 문장의 생성본·사용 중이 그대로다')

  // ── 3) 손잡이로 끌어 옮긴다 ─────────────────────────────────────────────
  ok(await win.getByTestId('lab-line-handle').count() === 2, '문장마다 드래그 손잡이가 있다')
  await win.getByTestId('lab-line-handle').first()
    .dragTo(win.locator('[data-testid="lab-line"]').nth(1), { targetPosition: { x: 40, y: 34 } })
  await win.waitForTimeout(500)
  o = await outline(win)
  ok(o.length === 2 && o[0].id === 'ln_2' && o[1].id === 'ln_1',
    '끌어 놓으면 순서가 바뀐다', JSON.stringify(o.map((l) => l.id)))
  ok(o[1].takes === 1 && o[1].adopted === 'tk_1' && o[1].text === '하나입니다.',
    '문장 id·생성본·사용 중인 음성이 그대로 따라간다')
  const shown = await win.getByTestId('lab-line-input').allTextContents()
    .then(() => win.evaluate(() =>
      [...document.querySelectorAll('[data-testid="lab-line-input"]')].map((e) => e.value)))
  ok(shown[0] === '둘입니다.' && shown[1] === '하나입니다.', '화면에도 바뀐 순서로 보인다', JSON.stringify(shown))

  // 내보내기·전체 듣기가 읽는 목록도 같은 순서여야 한다
  const order = await win.evaluate(() =>
    window.__labStore.getState().doc.lines.map((l) => l.takes.find((t) => t.id === l.adoptedTakeId)?.path))
  ok(order[0].includes('7s') && order[1].includes('18s'),
    '출력 순서가 바뀐 순서를 따른다', JSON.stringify(order.map((p) => p.split(/[\\/]/).pop())))

  // ── 6) 결과는 문장 id 로 붙는다 ─────────────────────────────────────────
  // 'ln_1' 로 요청이 나간 뒤 그 문장을 맨 앞으로 옮기고 결과를 받는다.
  await win.evaluate((b) => {
    const s = window.__labStore.getState()
    s.setJob({ lineId: 'ln_1', text: '하나입니다.', voiceKey: s.doc.voicePath, startedAt: Date.now(), queue: [] })
    s.moveLine('ln_1', 0)                                   // 도중에 순서를 바꾼다
    const j = window.__labStore.getState().job
    window.__labStore.getState().addTake(j.lineId, {        // 결과는 id 로 붙는다
      id: 'tk_late', path: b, text: '하나입니다.', voiceKey: s.doc.voicePath, createdAt: 9,
    })
    window.__labStore.getState().setJob(null)
  }, B)
  await win.waitForTimeout(400)
  o = await outline(win)
  const late = o.find((l) => l.id === 'ln_1')
  ok(late.takes === 2, '결과가 요청한 문장에 붙는다', JSON.stringify(o.map((l) => [l.id, l.takes])))
  ok(o.find((l) => l.id === 'ln_2').takes === 1, '순서를 옮겼다고 다른 문장에 붙지 않는다')
  ok(late.adopted === 'tk_1', '이미 고른 음성은 새 결과가 밀어내지 않는다')

  // ── 5) 만드는 중인 문장은 삭제가 잠긴다 ─────────────────────────────────
  await win.evaluate(() => window.__labStore.getState().setJob({
    lineId: 'ln_2', text: '둘입니다.', voiceKey: window.__labStore.getState().doc.voicePath,
    startedAt: Date.now(), queue: [],
  }))
  await win.waitForTimeout(400)
  const busyIdx = (await outline(win)).findIndex((l) => l.id === 'ln_2')
  const busyBtn = win.getByTestId('lab-line-remove').nth(busyIdx)
  ok(await busyBtn.isDisabled(), '만드는 중인 문장은 삭제가 잠긴다')
  ok(await busyBtn.getAttribute('title') === '만드는 중에는 지울 수 없습니다.', '잠긴 이유를 알려 준다')
  await win.evaluate(() => window.__labStore.getState().setJob(null))
  await win.waitForTimeout(300)

  // ── 4) 전체 듣기 중 삭제 → 멈추고 다음 문장이 안 나간다 ─────────────────
  await win.evaluate(() => {
    window.__plays = []; window.__els = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function patched(...a) {
      window.__plays.push(this.src)
      if (!window.__els.includes(this)) window.__els.push(this)
      return play.apply(this, a)
    }
  })
  await win.getByTestId('lab-play-all').click()
  await sleep(1500)
  const during = await win.evaluate(() => window.__plays.length)
  ok(during >= 1, '전체 듣기가 시작된다', String(during))
  await win.getByTestId('lab-line-remove').first().click()      // 재생 중에 지운다
  await sleep(800)
  ok(await win.evaluate(() => window.__els.every((e) => e.paused)), '삭제하면 재생이 멈춘다')
  const rightAfter = await win.evaluate(() => window.__plays.length)
  await sleep(2500)
  ok(await win.evaluate(() => window.__plays.length) === rightAfter,
    '이전 순서로 다음 문장이 재생되지 않는다', `(${rightAfter} 그대로)`)
  await win.getByTestId('lab-undo-remove').click()              // 되돌려 놓고 순서 확인으로 간다
  await win.waitForTimeout(500)

  // ── 7) 바뀐 순서가 저장·복원된다 ────────────────────────────────────────
  const beforeClose = (await outline(win)).map((l) => l.id)
  await win.waitForTimeout(1200)
  await app1.close()
  app1 = null

  const second = await launch()
  app2 = second.app
  const after = (await outline(second.win)).map((l) => l.id)
  ok(JSON.stringify(after) === JSON.stringify(beforeClose),
    '앱을 다시 켜도 바뀐 순서가 그대로다', `${JSON.stringify(beforeClose)} → ${JSON.stringify(after)}`)
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app1) await app1.close().catch(() => {})
  if (app2) await app2.close().catch(() => {})
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 삭제·되돌리기·순서 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
