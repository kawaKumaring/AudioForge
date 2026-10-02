// 낭독 서재 — 작품 묶음 · 폴더 가져오기 (2026-10-03). 실제 앱 · 실제 폴더 훑기 · 실제 저장 · 실제 창 닫기/다시 켜기.
// 사용자 자료는 쓰지 않는다 — 검사용 폴더와 TXT 를 만든다. GPU·음성 생성 없음.
// 끌어 놓기는 OS 끌기 사건을 만들 수 없어 화면이 경로를 받은 뒤의 길(__readerImportPaths)을 탄다 — 경로를 꺼내는 한 줄은 미확인.
// 실행: node test/e2e/reader-folder-import.e2e.mjs     (사전: npm run build)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
const LIB = path.join(ISO, '서재 원본')
const W = (rel, text) => { const p = path.join(LIB, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p }
const body = (tag, n = 6) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}번째 문단입니다.`).join('\n')
W('작품A/1화.txt', body('작품A 1화')); W('작품A/2화.txt', body('작품A 2화')); W('작품A/10화.txt', body('작품A 10화')); W('작품A/표지.jpg', 'x')
W('묶음/시리즈B/1권/1화.txt', body('B1권 1화')); W('묶음/시리즈B/1권/2화.txt', body('B1권 2화')); W('묶음/시리즈B/2권/1화.txt', body('B2권 1화'))
W('낱권.txt', body('낱권'))
fs.mkdirSync(path.join(LIB, '깨진작품'), { recursive: true })
fs.writeFileSync(path.join(LIB, '깨진작품', '1화.txt'), Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x00, 0xd8, 0x41]))   // 읽을 수 없는 글자 방식
for (let i = 1; i <= 150; i++) W(`많은작품/${i}화.txt`, body(`많은 ${i}화`, 3))
fs.symlinkSync(LIB, path.join(LIB, '작품A', '되돌이'), 'junction')       // 순환 연결

let passed = 0
const fails = []
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
const shot = async (win, name) => { const p = path.join(APP, '_local', `folder-import-${name}.png`); fs.mkdirSync(path.dirname(p), { recursive: true }); await win.screenshot({ path: p }); return p }
let app = null
const launch = async () => {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD } })
  const win = await app.firstWindow(); win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore); await enterStudio(win)
  await win.getByTestId('mode-reader').click()
  await win.waitForFunction(() => !!window.__readerStore && !!window.__readerImportPaths)
  return win
}
const closeWindow = async () => { await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() }); await app.waitForEvent('close', { timeout: 15000 }).catch(() => {}); app = null }
const books = (win) => win.evaluate(() => window.__readerStore.getState().books.map((b) => ({ id: b.id, name: b.name, group: b.group ?? null, order: b.order ?? null, position: b.position, root: b.source?.root ?? null, path: b.source?.path ?? null, paragraphs: b.paragraphs.length, history: (b.history || []).length })))
const disk = () => { const d = path.join(UD, 'works', 'books'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8')).data) : [] }
const resultText = (win) => win.getByTestId('reader-import-result').innerText().catch(() => '')
const waitIdle = (win) => win.waitForFunction(() => !document.querySelector('[data-testid=reader-import-progress]'), null, { timeout: 60000 })
const groupNames = (bs) => [...new Set(bs.map((b) => b.group).filter(Boolean))].sort()

try {
  let win = await launch()
  // ── 1. 폴더 선택 — 하위 폴더 · 여러 작품 · 자연 정렬 · 순환 연결 · 지원하지 않는 형식 ────────────────
  await app.evaluate((_, p) => { globalThis.__afE2eSelectFolder = p }, [path.join(LIB, '작품A'), path.join(LIB, '묶음')].join('|'))
  await win.getByTestId('reader-add-folder').click()
  await win.getByTestId('reader-import-preview').waitFor()
  const works = await win.getByTestId('reader-import-work').evaluateAll((els) => els.map((e) => [e.querySelector('[data-testid=reader-import-work-name]').value, e.textContent.trim().match(/(\d+)개/)?.[1]]))
  ok(JSON.stringify(works) === JSON.stringify([['작품A', '3'], ['1권', '2'], ['2권', '1']]), '★미리 보기: 작품별 파일 수 — 하위 폴더도 훑고, 파일 없는 중간 폴더(묶음·시리즈B)는 묶음이 아니다', works)
  const skipped = await win.getByTestId('reader-import-skipped').innerText()
  ok(/지원하지 않는 형식 1/.test(skipped) && /연결 1/.test(skipped), '★지원하지 않는 파일·연결은 건너뛰고 개수만 알린다(순환 연결을 따라가지 않는다)', skipped)
  await shot(win, '01-preview')
  await win.getByTestId('reader-import-confirm').click()
  await waitIdle(win)
  ok(/완료 6 · 중복 0 · 실패 0/.test(await resultText(win)), '폴더 6권을 가져온다', await resultText(win))
  let bs = await books(win)
  const a = bs.filter((b) => b.group === '작품A').sort((x, y) => x.order - y.order).map((b) => b.name)
  ok(JSON.stringify(a) === JSON.stringify(['1화', '2화', '10화']), '★자연 정렬 — 1화 → 2화 → 10화(묶음 차례)', a)
  ok(JSON.stringify(groupNames(bs)) === JSON.stringify(['1권', '2권', '작품A']) && disk().length === 6, '여러 작품은 각각 묶음, 디스크에도 6권', { g: groupNames(bs), disk: disk().length })
  await win.getByTestId('reader-grouped').evaluate((b) => { if (b.getAttribute('aria-pressed') !== 'true') b.click() })
  await win.getByTestId('reader-view-cover').click()
  ok(await win.getByTestId('reader-group-tile').count() === 3, '서재에 묶음 칸 셋(겹친 표지)')
  await shot(win, '02-groups')

  // ── 2. 끌어 놓기 — 파일과 폴더가 섞여도 · 중복 · 읽기 실패 · 실패만 다시 ─────────────────────────────
  await win.evaluate((p) => window.__readerImportPaths(p), [path.join(LIB, '깨진작품'), path.join(LIB, '낱권.txt'), path.join(LIB, '작품A')])
  await win.getByTestId('reader-import-preview').waitFor()
  await win.getByTestId('reader-import-confirm').click()
  await waitIdle(win)
  ok(/완료 1 · 중복 3 · 실패 1/.test(await resultText(win)), '★섞인 끌기: 낱권 완료 · 같은 파일 3 중복(새로 만들지 않음) · 깨진 1 실패', await resultText(win))
  ok((await books(win)).length === 7 && disk().length === 7, '저장에 성공한 책만 서재에 들어간다', { mem: (await books(win)).length, disk: disk().length })
  fs.writeFileSync(path.join(LIB, '깨진작품', '1화.txt'), body('고친 1화'))
  await win.getByTestId('reader-import-retry').click()
  await waitIdle(win)
  ok(/완료 1 · 중복 0 · 실패 0/.test(await resultText(win)) && (await books(win)).some((b) => b.group === '깨진작품'), '★실패한 파일만 다시 시도한다', await resultText(win))

  // ── 3. 내용이 바뀐 원본 — 묻는다 · 교체(같은 문단이면 자리 유지·이력) · 별도 등록 ─────────────────────
  bs = await books(win)
  const two = bs.find((b) => b.group === '작품A' && b.name === '2화')
  await win.evaluate((id) => window.__readerStore.setState((s) => ({ books: s.books.map((b) => b.id === id ? { ...b, position: 3 } : b) })), two.id)
  W('작품A/2화.txt', '새로 앞에 넣은 문단입니다.\n' + body('작품A 2화'))     // 앞에 한 문단 → 같은 글은 한 칸 뒤
  W('작품A/1화.txt', body('작품A 1화 고침'))                                 // 완전히 다른 글
  await win.evaluate((p) => window.__readerImportPaths(p), [path.join(LIB, '작품A')])
  await win.getByTestId('reader-import-preview').waitFor(); await win.getByTestId('reader-import-confirm').click()
  await win.getByTestId('reader-conflicts').waitFor()
  const conflictNames = await win.getByTestId('reader-conflict').allInnerTexts()
  ok(conflictNames.length === 2, '★같은 원본 자리인데 내용이 바뀐 2권을 묻는다(조용히 덮지 않는다)', conflictNames)
  const ch = win.getByTestId('reader-conflict-choice')
  for (let i = 0; i < 2; i++) await ch.nth(i).selectOption((await win.getByTestId('reader-conflict').nth(i).innerText()).includes('2화') ? 'replace' : 'separate')
  await shot(win, '03-conflicts')
  await win.getByTestId('reader-conflict-apply').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid=reader-conflicts]'))
  bs = await books(win)
  const two2 = bs.find((b) => b.id === two.id)
  ok(two2.paragraphs === 7 && two2.position === 4 && two2.history === 1, '★교체: 같은 문단을 찾아 자리 4(예전 3)로 옮기고 이전 기록을 남긴다', two2)
  ok(bs.some((b) => b.name === '1화 (새 판)' && b.group === '작품A') && bs.some((b) => b.name === '1화' && b.group === '작품A'), '★별도 등록: 예전 책은 그대로 두고 새 책을 하나 더', bs.filter((b) => b.group === '작품A').map((b) => b.name))
  ok(fs.readFileSync(path.join(LIB, '작품A', '2화.txt'), 'utf-8').startsWith('새로 앞에'), '원본 파일은 고치지 않는다')

  // ── 4. 많은 파일 · 취소 — 넣은 것은 남고 나머지는 넣지 않는다 ──────────────────────────────────────
  const before = (await books(win)).length
  await win.evaluate((p) => window.__readerImportPaths(p), [path.join(LIB, '많은작품')])
  await win.getByTestId('reader-import-preview').waitFor(); await win.getByTestId('reader-import-confirm').click()
  await win.getByTestId('reader-import-progress').waitFor()
  const responsive = await win.evaluate(() => new Promise((r) => { const t0 = performance.now(); setTimeout(() => r(performance.now() - t0), 0) }))
  await win.waitForFunction(() => /가져오는 중 ([1-9]\d*) /.test(document.querySelector('[data-testid=reader-import-progress]')?.textContent || ''))
  await win.getByTestId('reader-import-cancel').click()
  await waitIdle(win)
  const rt = await resultText(win)
  const m = /완료 (\d+) · 중복 0 · 실패 0 · 취소로 미처리 (\d+)/.exec(rt)
  const nowBooks = (await books(win)).length
  ok(!!m && Number(m[1]) + Number(m[2]) === 150 && Number(m[2]) > 0, '★취소: 완료 + 취소로 미처리 = 150', rt)
  ok(!!m && nowBooks === before + Number(m[1]) && disk().length === nowBooks, '★취소해도 넣은 책만 남는다(화면 = 디스크)', { before, now: nowBooks, disk: disk().length })
  ok(responsive < 500, '가져오는 동안 화면이 멈추지 않는다(한 박자 대기 ms)', responsive)

  // ── 5. 묶음 — 열기·고정 경로·차례·다른 묶음으로·꺼내기·해제 · 이어 읽기 ──────────────────────────────
  await win.getByRole('button', { name: '작품A 작품 열기' }).click()
  await win.getByTestId('reader-group-crumb').waitFor()
  const crumb = await win.getByTestId('reader-group-crumb').innerText()
  ok(/내 서재/.test(crumb) && /작품A/.test(crumb), '★묶음 안: ‘내 서재 › 작품명’ 고정 막대', crumb)
  const inside = await win.getByTestId('reader-library-book').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  ok(inside.length === 4 && inside.slice(0, 3).join() === '1화,2화,10화', '묶음을 열면 그 안의 책만 권 차례로', inside)
  await win.getByTestId('reader-library-manage').click()
  await win.getByRole('button', { name: '10화' }).click()
  await win.getByTestId('reader-move-up').click()
  await win.waitForTimeout(400)
  const reordered = await win.getByTestId('reader-library-book').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  ok(reordered.slice(0, 3).join() === '1화,10화,2화', '★정리에서 차례를 앞으로', reordered)
  await win.getByRole('button', { name: '10화' }).click()                    // 선택 풀기
  await win.getByRole('button', { name: '1화 (새 판)' }).click()
  await win.getByTestId('reader-group-name').fill('1권')
  await win.getByTestId('reader-group-apply').click()
  await win.waitForFunction(() => window.__readerStore.getState().books.some((b) => b.name === '1화 (새 판)' && b.group === '1권'))
  ok(true, '★다른 묶음으로 옮긴다')
  await win.getByTestId('reader-group-back').click()
  await win.getByRole('button', { name: '2권 작품 열기' }).click()
  await win.getByTestId('reader-group-ungroup').click(); await win.getByTestId('reader-group-ungroup').click()
  await win.waitForFunction(() => window.__readerStore.getState().books.some((b) => b.name === '1화' && !b.group))
  ok((await books(win)).filter((b) => b.name === '1화' && b.group === null).length === 1 && disk().length === (await books(win)).length, '★묶음 해제 — 책은 서재에 남는다(지우지 않는다)')
  // 이어 읽기 — 마지막으로 읽은 책
  const target = (await books(win)).find((b) => b.group === '1권' && b.name === '2화')
  await win.evaluate((id) => window.__readerStore.setState((s) => ({ books: s.books.map((b) => b.id === id ? { ...b, readAt: Date.now() } : b) })), target.id)
  await win.getByRole('button', { name: '1권 이어 읽기' }).click()
  ok(await win.evaluate(() => window.__readerStore.getState().active) === target.id, '★묶음 이어 읽기는 마지막으로 읽던 책을 연다(열기와 다르다)')
  await win.getByTestId('reader-library').click()

  // ── 6. 새 회차 확인 · 원본에서 사라짐 · 원본 폴더 누락과 다시 선택 ───────────────────────────────────
  W('작품A/11화.txt', body('작품A 11화'))
  fs.rmSync(path.join(LIB, '작품A', '10화.txt'))
  await win.getByRole('button', { name: '작품A 작품 열기' }).click()
  await win.getByTestId('reader-group-check').click()
  await waitIdle(win)
  await win.waitForTimeout(300)
  ok(/완료 1/.test(await resultText(win)) && (await books(win)).some((b) => b.name === '11화' && b.group === '작품A'), '★새 파일 확인으로 추가 회차를 가져온다', await resultText(win))
  ok((await books(win)).some((b) => b.name === '10화'), '★원본에서 사라진 회차도 서재에서 지우지 않는다')
  fs.renameSync(path.join(LIB, '작품A'), path.join(LIB, '작품A 옮김'))
  await win.getByTestId('reader-group-check').click()
  await win.getByTestId('reader-group-fault').waitFor()
  ok(/원본 폴더를 찾지 못했습니다/.test(await win.getByTestId('reader-group-fault').innerText()), '★원본 폴더가 없으면 사유와 다시 선택 조작')
  await app.evaluate((_, p) => { globalThis.__afE2eSelectFolder = p }, path.join(LIB, '작품A 옮김'))
  await win.getByTestId('reader-group-relink').click()
  await win.waitForFunction(() => !document.querySelector('[data-testid=reader-group-fault]'))
  const relinked = (await books(win)).filter((b) => b.group === '작품A')
  ok(relinked.every((b) => !b.root || b.root.endsWith('작품A 옮김')), '다시 고른 폴더로 원본 기록을 잇는다(책·자리는 그대로)', relinked.map((b) => b.root))
  const relinkNote = await win.getByTestId('reader-notice').innerText().catch(() => '')
  ok(relinked.every((b) => !b.path || b.path.includes('작품A 옮김')) && /원본 폴더에 없는 책 1권/.test(relinkNote), '★다시 고른 뒤 원본에 없는 책은 실제로 사라진 1권(10화)만 센다', { relinkNote, paths: relinked.map((b) => b.path) })
  await shot(win, '04-inside-group')

  // ── 7. 다시 켜도 묶음·차례·원본 기록이 남는다 ──────────────────────────────────────────────────────
  const snap = JSON.stringify((await books(win)).map((b) => [b.name, b.group, b.order, b.root]).sort())
  await closeWindow()
  win = await launch()
  await win.waitForFunction(() => window.__readerStore.getState().books.length > 0)
  ok(JSON.stringify((await books(win)).map((b) => [b.name, b.group, b.order, b.root]).sort()) === snap, '★다시 켜도 묶음·차례·원본 폴더 관계가 그대로다')

  // ── 8. 좁은 창 — 가져오기 · 돌아가기 · 정리 조작 ───────────────────────────────────────────────────
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 600)); await win.waitForTimeout(400)
  const inView = (id) => win.getByTestId(id).first().evaluate((e) => { e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })
  ok(await inView('reader-add-folder') && await inView('reader-library-manage'), '좁은 창: 폴더 가져오기·정리에 닿는다')
  await win.getByRole('button', { name: '작품A 작품 열기' }).click()
  ok(await inView('reader-group-back') && await inView('reader-group-check') && await inView('reader-group-ungroup'), '좁은 창: 묶음 안 돌아가기·새 파일 확인·해제에 닿는다')
  const crumbAt = () => win.getByTestId('reader-group-crumb').evaluate((e) => { const r = e.getBoundingClientRect(), s = e.closest('[data-testid=reader-shelf-scroll]').getBoundingClientRect(); return Math.round(r.top - s.top) })
  const scroller = () => win.getByTestId('reader-library-dialog').evaluate((e) => { const s = e.closest('[data-testid=reader-shelf-scroll]'); return { st: s.scrollTop, max: s.scrollHeight - s.clientHeight } })
  await win.getByTestId('reader-library-dialog').evaluate((e) => { e.closest('[data-testid=reader-shelf-scroll]').scrollTop = 0 }); await win.waitForTimeout(150)
  const top0 = await crumbAt()
  await win.getByTestId('reader-library-dialog').evaluate((e) => { e.closest('[data-testid=reader-shelf-scroll]').scrollTop = 99999 }); await win.waitForTimeout(200)
  const s1 = await scroller(), top1 = await crumbAt()
  ok(s1.max > 0 && s1.st > 0 && top1 === top0 && top0 >= 0 && top0 <= 8, '★좁은 창에서 끝까지 굴려도 경로 막대가 같은 자리(칸 위)에 고정', { top0, top1, ...s1 })
  await shot(win, '05-narrow-group')
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD)
  try { fs.unlinkSync(path.join(LIB, '작품A 옮김', '되돌이')) } catch { try { fs.unlinkSync(path.join(LIB, '작품A', '되돌이')) } catch { /* 없음 */ } }
  fs.rmSync(ISO, { recursive: true, force: true })
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
