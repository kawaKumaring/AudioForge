// 개발툴 MCP — 낭독 관측 도구(reader_trace)와 실행 방식 선택(app_start prep)이 붙어 있는가(2026-10-03).
// 실제 앱(화면 밖) · 검사용 글(test_input) · 기본 목소리(CPU). GPU 를 쓰는 준비는 부르지 않는다.
// 실행: node test/e2e/reader-trace-mcp.cjs   (사전: npm run build)
const assert = require('node:assert/strict')
const { McpClient } = require('../../tools/mcp/client.cjs')
;(async () => {
  const c = new McpClient()
  await c.start()
  const call = async (name, args = {}) => { const r = await c.call(name, args); if (r.isError) throw Error(name + ': ' + r.text); return r.json }
  let passed = 0
  const pass = (s) => { passed++; console.log('PASS', s) }
  try {
    const tools = await c.listTools()
    const start = tools.find((t) => t.name === 'app_start')
    assert.deepEqual(start.inputSchema.properties.prep.enum, ['test', 'normal'])
    assert.ok(tools.some((t) => t.name === 'reader_trace'))
    pass('도구 목록: app_start 의 prep(test/normal) · reader_trace')
    const s = await call('app_start', { build: 'never' })
    assert.match(String(s.prep), /^test/)
    pass('기본 실행은 test(미리 준비 꺼짐)로 알린다: ' + s.prep)
    await call('app_mode', { mode: 'reader' })
    const txt = await call('test_input', { kind: 'text', name: '관측 검사', content: Array.from({ length: 10 }, (_, i) => `${i + 1}번째 문단이다. 그는 천천히 문을 열었다.`).join('\n') })
    await call('dialog_queue', { kind: 'open', answers: [txt.path] })
    await call('ui_click', { target: 'testid:reader-add-text' })
    await call('ui_wait', { code: "document.querySelectorAll('[data-testid=reader-paragraph]').length >= 10", timeoutMs: 10000 })
    await call('ui_wait', { code: '!!window.__readerStore.getState().pick', timeoutMs: 20000 })
    await call('reader_trace', { clear: true })
    await call('ui_click', { target: 'testid:reader-play' })
    const w = await call('ui_wait', { code: "window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.first)", timeoutMs: 90000 })
    assert.equal(w.met, true)
    const d = await call('reader_trace', { clear: true })
    assert.equal(d.mode, 'test(prep-off)')
    assert.ok(d.events.some((e) => e.ev === 'play-request') && d.events.some((e) => e.ev === 'play-start'))
    pass(`reader_trace: 실행 방식 ${d.mode} · 사건 ${d.events.length}개(재생 요청·실제 재생 시작 포함)`)
    const d2 = await call('reader_trace')
    assert.ok(d2.events.length <= 2, '읽은 뒤 비우기가 되지 않았다')
    pass('reader_trace clear:true 로 다음 측정을 새로 시작한다')
    console.log(`RESULT ${passed} checks · 0 fail`)
  } catch (e) {
    console.log('FAIL', e.message); process.exitCode = 1
  } finally {
    await c.call('app_stop')
    await c.close()
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
