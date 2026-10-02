// 카드 순서 — **첫 카드부터 마지막 카드까지** 손잡이로 옮길 수 있다(2026-10-03 관리자 검수).
// 왜: 새 앱 틀에서 카드 목록은 고정 머리와 고정 하단 막대 사이의 굴림 칸에서만 굴러간다. 끄는 도중 칸 끝에 머물러도 굴러가지 않아
//   첫 카드를 맨 뒤로 놓을 자리가 화면에 나오지 않았다(수정 전 측정: scrollTop 0 그대로). 이제 앱이 끝자리에서 직접 굴린다(useDragEdgeScroll).
// 실제 앱 · 기본 목소리 카드 5장(합성하지 않는다) · 넓은 창과 좁은 창. 실행: node test/e2e/synthesis-cards-order.e2e.mjs [너비 높이]
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'
let failed = 0
const ok = (v, label, extra) => { console.log(`${v ? 'PASS' : 'FAIL'} ${label}${v || extra === undefined ? '' : ' ' + JSON.stringify(extra)}`); if (!v) failed++ }
const SIZES = process.argv[2] ? [[Number(process.argv[2]), Number(process.argv[3])]] : [[1280, 850], [760, 700]]
for (const [W, H] of SIZES) {
const UD = isolatedUserData()
const app = await electron.launch({ args: ['out/main/index.js'], cwd: process.cwd(), env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' } })
const win = await app.firstWindow(); win.setDefaultTimeout(30000)
await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s.W, s.H), { W, H })
await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
await enterStudio(win)
await win.getByTestId('mode-tts').click()
await win.getByTestId('add-generation-card').first().click()
await win.getByTestId('pick-voice-confirm').click()
await win.getByTestId('generation-card').first().waitFor()
for (let i = 0; i < 4; i++) { await win.getByRole('button', { name: '1번 카드 복제' }).click(); await win.waitForTimeout(150) }
const settle = () => win.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))))
await settle()
const ids = () => win.evaluate(() => window.__synthesisCards.getState().cards.map((c) => c.id))
const start = await ids()
const snapshot = () => win.evaluate(() => window.__synthesisCards.getState().cards.map((c) => JSON.stringify({ id: c.id, label: c.label, script: c.script, source: c.source, settings: c.settings, takes: c.takes, adopted: c.adopted ?? null })).sort())
const domOrder = () => win.evaluate(() => [...document.querySelectorAll('[data-testid=generation-card]')].map((e) => e.getAttribute('data-card-id')))
const before = JSON.stringify(await snapshot())
const content = win.getByTestId('workspace-content')
const geo = () => content.evaluate((el) => {
  const c = el.getBoundingClientRect(), dock = document.querySelector('[data-testid=workspace-dock]')?.getBoundingClientRect()
  const cards = [...el.querySelectorAll('[data-testid=generation-card]')].map((e) => e.getBoundingClientRect())
  const hs = [...el.querySelectorAll('[data-testid=card-drag-handle]')].map((e) => e.getBoundingClientRect())
  return { top: Math.round(c.top), bottom: Math.round(c.bottom), dockTop: dock ? Math.round(dock.top) : null, st: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight,
    lastBottom: Math.round(cards.at(-1).bottom), lastHandle: Math.round(hs.at(-1).top), n: cards.length }
})
await content.evaluate((el) => { el.scrollTop = el.scrollHeight }); await settle()
const b = await geo()
ok(b.lastBottom <= b.bottom && !(b.dockTop !== null && b.lastBottom > b.dockTop), `[${W}x${H}] 끝까지 굴리면 마지막 카드가 하단 막대에 가리지 않고 다 보인다`, b)
// 끌기 — 칸 끝(또는 칸 밖 막대 위)에 머물러 굴러가게 한 뒤 목적지의 절반에 놓는다
async function drag(from, to, after, holdY) {
  await settle()
  await content.evaluate((el, a) => { el.scrollTop = a.after ? 0 : el.scrollHeight }, { after })
  await settle()
  const h = await win.getByTestId('card-drag-handle').nth(from).boundingBox()
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await win.mouse.down(); await win.mouse.move(h.x + h.width / 2, h.y + (after ? 30 : -30), { steps: 3 })
  const st0 = (await geo()).st; let tries = 0, dropped = false
  while (tries++ < 120 && !dropped) {
    const g = await geo()
    const r = await win.getByTestId('generation-card').nth(to).boundingBox()
    const mid = r.y + r.height / 2
    const lo = after ? Math.max(mid + 6, g.top + 6) : Math.max(r.y + 6, g.top + 6), hi = after ? Math.min(r.y + r.height - 6, g.bottom - 6) : Math.min(mid - 6, g.bottom - 6)
    if (hi - lo >= 8) { await win.mouse.move(r.x + 120, (lo + hi) / 2, { steps: 6 }); await win.mouse.up(); dropped = true; break }
    await win.mouse.move(r.x + 120, holdY(g) + (tries % 2), { steps: 1 }); await win.waitForTimeout(60)
  }
  if (!dropped) await win.mouse.up()
  await settle()
  return { dropped, scrolled: (await geo()).st !== st0 }
}
const r1 = await drag(0, 4, true, (g) => g.bottom - 10)
const o1 = await ids()
ok(r1.dropped && r1.scrolled && o1.at(-1) === start[0], `[${W}x${H}] ★첫 카드를 맨 뒤로 — 끄는 동안 칸 아래 끝에 머물면 굴러가 놓을 자리가 나온다`, { r1, order: o1.map((x) => start.indexOf(x)) })
ok(JSON.stringify(await domOrder()) === JSON.stringify(o1), `[${W}x${H}] 화면 순서 = 저장 순서(= 최종 연결 순서)`)
const r2 = await drag(4, 0, false, (g) => g.top + 10)
const o2 = await ids()
ok(r2.dropped && r2.scrolled && JSON.stringify(o2) === JSON.stringify(start), `[${W}x${H}] ★맨 뒤 카드를 맨 앞으로 — 칸 위 끝에 머물면 위로 굴러간다`, { r2, order: o2.map((x) => start.indexOf(x)) })
const r3 = await drag(0, 4, true, (g) => (g.dockTop ?? g.bottom) + 20)
const o3 = await ids()
ok(r3.dropped && o3.at(-1) === start[0], `[${W}x${H}] ★하단 막대 위에 머물러도 아래로 굴러간다(막대가 놓기를 막지 않는다)`, r3)
ok(JSON.stringify(await snapshot()) === before, `[${W}x${H}] 여러 번 옮겨도 카드 대사·목소리·생성본·채택이 그대로다`)
await app.close(); cleanupUserData(UD)
}
console.log(`RESULT ${failed} fail`)
process.exit(failed ? 1 : 0)
