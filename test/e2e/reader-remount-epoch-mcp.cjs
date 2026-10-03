// 낭독 — 작업실 왕복·책 변경·문단 이동 뒤에도 새 요청이 실행되고, 앞 화면의 요청은 끼어들지 않는다(2026-10-03 관리자 재현).
// ★결함: 요청 세대를 번호 크기로 견줬다 — 화면이 다시 만들어지면 번호가 0 부터 다시 세는데 본체는 앞 화면의 큰 번호를 들고 있어
//   새 화면의 요청을 모두 '지난 것' 으로 버렸고, 화면은 다시 청하기를 수십 번(실측 85회) 되풀이하다 '목소리를 만드는 중' 에 멈췄다(재생 0회).
// 실제 앱(화면 밖) · 기본 목소리(CPU) · 검사용 글. GPU 없음. 실행: node test/e2e/reader-remount-epoch-mcp.cjs   (사전: npm run build)
const assert = require('node:assert/strict')
const { McpClient } = require('../../tools/mcp/client.cjs')
;(async () => {
  const c = new McpClient()
  await c.start()
  const call = async (n, a = {}) => { const r = await c.call(n, a); if (r.isError) throw Error(n + ': ' + r.text); return r.json }
  let passed = 0
  const pass = (s) => { passed++; console.log('PASS', s) }
  const events = async () => (await call('reader_trace')).events
  const add = async (name) => {
    const t = await call('test_input', { kind: 'text', name: name + '.txt', content: Array.from({ length: 22 }, (_, i) => `${name} ${i + 1}번째 문단입니다. 그는 문을 열고 복도를 내다보았다.`).join('\n') })
    await call('dialog_queue', { kind: 'open', answers: [[t.path]] })
    await call('ui_click', { target: 'testid:reader-add-text' })
    await call('ui_wait', { code: '!!document.querySelector("[data-testid=reader-paragraph]")', timeoutMs: 7000 })
  }
  try {
    await call('app_start', { build: 'never' })
    await call('app_mode', { mode: 'reader' })
    // ── 1. 관리자 재현 그대로: 문단 여러 번 이동 → 음악 → 낭독 → 새 책 → 재생 ──
    await add('앞 책')
    for (const i of [2, 4, 6, 8]) await call('ui_click', { target: `[data-testid=reader-paragraph][data-index="${i}"]` })
    await call('app_mode', { mode: 'music' })
    await call('app_mode', { mode: 'reader' })
    await add('새 책')
    const mark = (await events()).length
    await call('ui_click', { target: 'testid:reader-play' })
    const w = await call('ui_wait', { code: `window.__readerTrace.dump().events.slice(${mark}).some(e=>e.ev==='play-start'&&e.first)`, timeoutMs: 12000 })
    assert.equal(w.met, true, '왕복 뒤 새 책이 12초 안에 실제로 재생되지 않았다')
    pass('★작업실 왕복·책 변경 뒤 새 책이 실제로 재생된다')
    await call('ui_wait', { code: 'false', timeoutMs: 2500 })
    const E = (await events()).slice(mark)
    const st = await call('app_state')
    assert.equal(st.reader.state === '목소리를 만드는 중입니다' && E.filter((e) => e.ev === 'play-start').length === 0, false)
    assert.equal(E.filter((e) => e.ev === 'epoch-desync').length, 0, '세대가 어긋났다')
    const reqs = E.filter((e) => e.ev === 'gen-request').length
    assert.ok(reqs <= 12, `거절·재요청이 되풀이된다(요청 ${reqs}번)`)
    pass(`★거절된 요청을 되풀이해 청하지 않는다(재생 뒤 요청 ${reqs}번 — 앞서 만들기 범위)`)
    // 실제로 울린 덩이는 모두 '버려지지 않고 성공한 답' 으로 채워졌다(버려진 답은 그 자리를 비워 다시 청할 뿐 — 소리·오류가 되지 않는다).
    const played = E.filter((e) => e.ev === 'play-start' && e.first).map((e) => e.chunk)
    const okDone = new Set(E.filter((e) => e.ev === 'gen-done' && e.ok && e.accepted && !e.superseded).map((e) => e.chunk))
    const preMade = new Set((await events()).slice(0, mark).filter((e) => e.ev === 'gen-done' && e.ok && e.accepted && !e.superseded).map((e) => e.chunk))
    assert.ok(played.every((ch) => okDone.has(ch) || preMade.has(ch)), `버려진 답으로 울린 덩이가 있다: ${JSON.stringify({ played, ok: [...okDone] })}`)
    assert.equal(st.reader.state.includes('어긋') || /못했/.test(st.reader.state || ''), false, `오류 상태: ${st.reader.state}`)
    pass('앞 화면 요청의 늦은 답은 받아들여지지 않고 오류·상태를 만들지 않는다')
    await call('ui_click', { target: 'testid:reader-play' })   // 멈춤

    // ── 2. 생성이 도는 중에 작업실을 떠났다 돌아오고 곧바로 다른 책 → 늦게 도착한 앞 답이 새 화면에 끼어들지 않는다 ──
    await call('ui_click', { target: '[data-testid=reader-paragraph][data-index="15"]' })
    await call('ui_click', { target: 'testid:reader-play' })
    await call('ui_wait', { code: `(()=>{const E=window.__readerTrace.dump().events;const d=new Set(E.filter(e=>e.ev==='gen-done').map(e=>e.req));return E.some(e=>e.ev==='gen-request'&&!d.has(e.req))})()`, timeoutMs: 8000 })
    await call('app_mode', { mode: 'music' })
    await call('app_mode', { mode: 'reader' })
    await add('셋째 책')
    const mark2 = (await events()).length
    await call('ui_click', { target: 'testid:reader-play' })
    const w2 = await call('ui_wait', { code: `window.__readerTrace.dump().events.slice(${mark2}).some(e=>e.ev==='play-start'&&e.first)`, timeoutMs: 12000 })
    assert.equal(w2.met, true, '생성 중 왕복 뒤 새 책이 재생되지 않았다')
    await call('ui_wait', { code: 'false', timeoutMs: 2500 })
    const E2 = (await events()).slice(mark2)
    const st2 = await call('app_state')
    assert.equal(E2.filter((e) => e.ev === 'gen-done' && e.accepted && e.chunk >= 10).length, 0, '앞 책의 뒤쪽 덩이(15번 문단 근처) 답이 새 화면에 받아들여졌다')
    assert.equal(st2.reader.book, '셋째 책')
    pass('★생성 중 왕복 뒤에도 새 책이 재생되고, 앞 책의 늦은 답은 새 화면에 들어오지 않는다')
    const errs = await call('errors')
    assert.equal(errs.count, 0, JSON.stringify(errs).slice(0, 300))
    pass('오류 기록 없음')
    console.log(`RESULT ${passed} checks · 0 fail`)
  } catch (e) {
    console.log('FAIL', e.message); process.exitCode = 1
  } finally {
    await c.call('app_stop')
    await c.close()
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
