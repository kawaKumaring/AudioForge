// 낭독 저장 유실 — 실제 앱(격리 Electron + 내부 MCP) · 실제 IPC · 실제 디스크 · 실제 재시작으로 본다.
// 왜(2026-10-02 관리자 검수): 읽던 자리(600ms)·서재 보기(250ms)가 화면 안 effect 의 타이머라, 화면을 떠나면 취소돼 디스크에 안 남았다.
// 사용자 책·음원은 쓰지 않는다 — 검사용 TXT 를 도구가 만든다. GPU 도 쓰지 않는다.
// ★창을 닫는 **순간**(마지막 편집 직후 종료)은 도구의 종료가 창 닫기 이벤트를 거치지 않아 여기서 못 본다 — reader-save-close.e2e.mjs 가 실제 창 닫기로 본다.
// 실행: node test/e2e/reader-save-mcp.cjs      (사전: npm run build — 도구가 소스가 새로우면 자동으로 빌드한다)
const { McpClient } = require('../../tools/mcp/client.cjs')
let failed = 0
const ok = (cond, name, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + JSON.stringify(extra)}`); if (!cond) failed++ }
;(async () => {
  const c = new McpClient(); await c.start()
  try {
    const call = async (name, args = {}) => { const r = await c.call(name, args); if (r.isError) throw Error(`${name}: ${r.text}`); return r.json }
    const wait = (code, timeoutMs = 7000) => call('ui_wait', { code, timeoutMs })
    const sleep = (ms) => call('ui_wait', { code: 'false', timeoutMs: ms })
    const disk = async () => {
      const r = await call('api_call', { method: 'works.list', args: ['books'], full: true })
      return Object.fromEntries((r?.records || []).map((x) => [x.data?.name, x.data?.position]))
    }
    const evalText = async (code) => (await c.call('js_eval', { code })).text      // 글자 값은 json 이 아니라 text 로 온다
    const prefsOnDisk = async () => (await call('api_call', { method: 'settings.get', full: true }))?.readerPrefs
    const text = (name) => call('test_input', { kind: 'text', name, content: Array.from({ length: 80 }, (_, i) => `${name} ${i + 1}번째 문단입니다.`).join('\n') })
    const addBooks = async (files) => {
      await call('dialog_queue', { kind: 'open', answers: [files.map((f) => f.path)] })
      await call('ui_click', { target: 'testid:reader-add-text' })
      await wait(`window.__readerStore.getState().books.length===${files.length}`)
    }

    await call('app_start', { width: 1000, height: 720 }); await call('app_mode', { mode: 'reader' })
    const A = await text('저장검사 가'), B = await text('저장검사 나')
    await addBooks([A, B])
    await sleep(900)


    // ── 1. 문단을 누르고 곧바로 다른 메뉴로 — 화면이 사라져도 마지막 자리가 디스크에 남는다 ──────────
    await call('ui_click', { target: '[data-testid=reader-library-book]', waitMs: 0 })
    await wait('!!document.querySelector("[data-index=\\"25\\"]")')
    await call('ui_click', { target: '[data-index="25"]', waitMs: 0 })
    await call('app_mode', { mode: 'music' })
    await sleep(1200)
    const d1 = await disk()
    ok(Object.values(d1).includes(25), '★문단을 누르고 곧바로 메뉴를 옮겨도 읽던 자리가 디스크에 남는다', d1)

    // ── 2. 메뉴를 옮겼다가 앱을 다시 켜도 그 자리다 ──────────────────────────────────────────────────
    await call('app_mode', { mode: 'reader' })
    await call('js_eval', { code: 'document.querySelectorAll("[data-testid=reader-library-book]")[0].click()' })      // 돌아오면 서재가 먼저 열린다 — 책을 연다
    await wait('!!document.querySelector("[data-index=\\"40\\"]")')
    await call('ui_click', { target: '[data-index="40"]', waitMs: 0 })
    await call('app_mode', { mode: 'music' })
    await sleep(900)
    await call('app_restart', {})
    await call('app_mode', { mode: 'reader' })
    await wait('window.__readerStore.getState().books.length===2')
    const pos = await call('js_eval', { code: 'window.__readerStore.getState().books.map(b=>[b.name,b.position])' })
    ok(pos.some(([n, p]) => p === 40), '★다시 켜면 메뉴를 옮기기 직전에 누른 자리가 복원된다', pos)

    // ── 3. 빠른 책 전환 — 앞 책의 마지막 자리도, 뒤 책의 자리도 남는다 ─────────────────────────────
    await call('ui_click', { target: 'testid:reader-library', waitMs: 0 })
    await call('js_eval', { code: 'document.querySelectorAll("[data-testid=reader-library-book]")[0].click()' })
    await wait('!!document.querySelector("[data-index=\\"10\\"]")')
    await call('ui_click', { target: '[data-index="10"]', waitMs: 0 })
    const ACTIVE = 'window.__readerStore.getState().books.find(b=>b.id===window.__readerStore.getState().active).name'
    const firstName = await evalText(ACTIVE)
    await call('ui_click', { target: 'testid:reader-library', waitMs: 0 })
    await call('js_eval', { code: 'document.querySelectorAll("[data-testid=reader-library-book]")[1].click()' })
    await wait('!!document.querySelector("[data-index=\\"7\\"]")')
    await call('ui_click', { target: '[data-index="7"]', waitMs: 0 })
    const secondName = await evalText(ACTIVE)
    await call('app_mode', { mode: 'music' })
    await sleep(1500)
    const d3 = await disk()
    ok(firstName !== secondName && d3[firstName] === 10 && d3[secondName] === 7, '★빠르게 책을 바꿔도 두 책의 마지막 자리가 모두 남는다', { firstName, secondName, d3 })

    // ── 4. 서재 보기 — 바꾸고 곧바로 메뉴를 옮겨도 설정 파일에 남는다 ───────────────────────────────
    await call('app_mode', { mode: 'reader' })
    await wait('!!document.querySelector("[data-testid=reader-view-list]")')
    await call('ui_click', { target: 'testid:reader-view-list', waitMs: 0 })
    await call('app_mode', { mode: 'music' })
    await sleep(700)
    const p4 = await prefsOnDisk()
    ok(p4 && p4.shelfView === 'list', '★서재 보기를 바꾸고 곧바로 메뉴를 옮겨도 설정 파일에 남는다', p4)

    // ── 4-2. 같은 저장 길을 쓰는 다른 설정(작품별 묶어 보기) — 바꾸고 곧바로 옮겨도 남는다 ────────────
    await call("app_mode", { mode: "reader" })
    await wait("!!document.querySelector(\"[data-testid=reader-grouped]\")")
    await call("ui_click", { target: "testid:reader-grouped", waitMs: 0 })
    await call("app_mode", { mode: "music" })
    await sleep(700)
    const p42 = await prefsOnDisk()
    ok(p42 && p42.shelfGrouped === false && p42.shelfView === "list", "★작품별 보기도 곧바로 메뉴를 옮겨도 남고 앞서 고른 목록 보기도 그대로다", p42)

    // ── 5. 서재 보기를 바꾸고 메뉴를 옮겼다가 앱을 다시 켜도 그 보기다 ──────────────────────────────
    await call('app_mode', { mode: 'reader' })
    await wait('!!document.querySelector("[data-testid=reader-view-cover]")')
    await call('ui_click', { target: 'testid:reader-view-cover', waitMs: 0 })
    await call('app_mode', { mode: 'music' })
    await sleep(700)
    await call('app_restart', {})
    await call('app_mode', { mode: 'reader' })
    await wait('document.querySelector("[data-testid=reader-view-cover]")?.getAttribute("aria-pressed")==="true"')
    const p5 = await prefsOnDisk()
    ok(p5 && p5.shelfView === 'cover', '★다시 켜면 그 서재 보기다(설정 파일 확인)', p5)

    // ── 6. 읽던 자리와 묶기가 서로 덮지 않는다 — 문단을 누른 직후 묶어도 자리·묶음이 둘 다 남는다 ─────────
    const tile0 = 'document.querySelectorAll("[data-testid=reader-library-book]")[0]'
    const grpBook = await evalText(tile0 + '.getAttribute("aria-label")')
    await call('js_eval', { code: tile0 + '.click()' })
    await wait('!!document.querySelector("[data-index=\\"33\\"]")')
    await call('ui_click', { target: '[data-index="33"]', waitMs: 0 })
    await call('ui_click', { target: 'testid:reader-library', waitMs: 0 })
    await call('ui_click', { target: 'testid:reader-library-manage', waitMs: 0 })
    await call('js_eval', { code: 'Array.from(document.querySelectorAll("[data-testid=reader-library-book]")).find(b=>b.getAttribute("aria-label")===' + JSON.stringify(grpBook) + ').click()' })
    await call('ui_set', { target: 'testid:reader-group-name', value: '검사 작품' })
    await call('ui_click', { target: 'testid:reader-group-apply', waitMs: 0 })
    await wait('window.__readerStore.getState().books.some(b=>b.group==="검사 작품")')
    await sleep(1500)
    const rec = await call('api_call', { method: 'works.list', args: ['books'], full: true })
    const mine = (rec?.records || []).map((x) => x.data).find((d) => d?.name === grpBook)
    ok(mine && mine.group === '검사 작품' && mine.position === 33, '★문단을 누른 직후 묶어도 묶음과 읽던 자리가 둘 다 디스크에 남는다', { group: mine?.group, position: mine?.position })

    const errs = await call('errors')
    ok(errs.count === 0, '화면·본체 오류 0', errs.items?.slice(0, 2))
  } finally { await c.call('app_stop'); await c.close() }
  console.log(failed ? `RESULT ${failed} fail` : 'RESULT 0 fail')
  process.exitCode = failed ? 1 : 0
})().catch((e) => { console.error(e); process.exitCode = 1 })
