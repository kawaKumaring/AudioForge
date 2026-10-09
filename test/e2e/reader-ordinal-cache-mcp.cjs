// 서수 읽기 보정 + 낭독 쌓아 두기 확정(2026-10-09) — 실제 앱(화면 밖) · 기본 목소리(Supertonic, CPU) · 격리 사용자 폴더.
// 확인: 다른 엔진은 보정하지 않음(화면 흐름) · 같은 덩이 다시 읽기 = 검증된 캐시 · 음원 변조/기록 누락/기록 깨짐/확정 실패에 잘못 쓰지 않음
//       · 재생 전용 파일이 임시 작업 정리 뒤에도 남음 · 다른 쌓아 둔 것을 지우지 않음.
// GPU 를 쓰지 않는다. 실행: node test/e2e/reader-ordinal-cache-mcp.cjs   (사전: npm run build)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ROOT = path.resolve(__dirname, '../..')
const { McpClient } = require(path.join(ROOT, 'tools/mcp/client.cjs'))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

;(async () => {
  const c = new McpClient(); await c.start()
  const call = async (n, a = {}) => { const r = await c.call(n, a); if (r.isError) throw Error(n + ': ' + r.text); return r.json }
  let passed = 0; const pass = (s) => { passed++; console.log('PASS', s) }
  try {
    await call('app_start', { build: 'never' })
    const st = await call('app_status')
    const dir = path.join(ROOT, st.userData, 'readerChunks')
    await call('app_mode', { mode: 'reader' })
    const t = await call('test_input', { kind: 'text', name: '서수 캐시', content: '그는 7번째 문을 열었다.\n값은 1.7번째 칸이다.\n둘째 줄은 조용했다.' })
    await call('dialog_queue', { kind: 'open', answers: [t.path] })
    await call('ui_click', { target: 'testid:reader-add-text' })
    await call('ui_wait', { code: '!!window.__readerStore.getState().pick', timeoutMs: 20000 })
    const pick = (await call('js_eval', { code: '({v: window.__readerStore.getState().pick})' })).v
    assert.ok(pick && pick.kind === 'builtin' && pick.engineId !== 'qwen-custom', JSON.stringify(pick))
    pass(`기본 목소리는 Qwen 이 아니다(${pick.engineId})`)

    // ── 화면 흐름: 다른 엔진은 서수 보정을 하지 않는다 ──
    await call('reader_trace', { clear: true })
    await call('ui_click', { target: 'testid:reader-play' })
    await call('ui_wait', { code: "window.__readerTrace.dump().events.some((e) => e.ev === 'gen-done' && e.ok)", timeoutMs: 90000 })
    const ev = (await call('reader_trace', { clear: true })).events.filter((e) => e.ev === 'gen-done' && e.ok)
    assert.ok(ev.length && ev.every((e) => e.spokenRule === null && e.spokenChanges === 0), JSON.stringify(ev.map((e) => [e.spokenRule, e.spokenChanges])))
    pass('화면 흐름(기본 목소리): 요청 규칙 없음 · 바꾼 수 0')
    await call('ui_click', { target: 'testid:reader-play' }).catch(() => {})          // 멈춤
    const recs = fs.readdirSync(dir).filter((n) => n.endsWith('.spoken.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')))
    assert.ok(recs.length >= 1 && recs.every((r) => r.rule === null && r.ordinalChanges === 0 && r.usedText === 'spoken'))
    pass(`쌓아 둔 기록 ${recs.length}개 — 모두 규칙 없음·바꾼 수 0`)

    // ── 본체 직접(화면이 부르는 같은 IPC) — 같은 글·같은 목소리 ──
    const key = `${pick.kind}:${pick.engineId || ''}:${pick.path}`
    const speak = async (text, spoken) => (await call('js_eval', {
      code: `(async () => ({ v: await window.api.reader.speak(${JSON.stringify(text)}, ${JSON.stringify({ kind: pick.kind, path: pick.path, engineId: pick.engineId })}, ${JSON.stringify(key)}, undefined, undefined, undefined, ${JSON.stringify(spoken)}) }))()`,
      timeoutMs: 120000,
    })).v
    const NO = { rule: null, ordinalChanges: 0 }
    const T1 = '검사용 덩이 하나. 그는 7번째 문을 열었다.'
    const a = await speak(T1, NO)
    assert.ok(a.data && !a.data.cached && a.data.trace.spoken.committed === true, JSON.stringify(a))
    const wav = a.data.path, rec = wav.replace(/\.wav$/i, '') + '.spoken.json'
    const r1 = JSON.parse(fs.readFileSync(rec, 'utf-8'))
    assert.equal(r1.sentSha256, sha(T1)); assert.equal(r1.wavSha256, sha(fs.readFileSync(wav))); assert.equal(r1.wavBytes, fs.statSync(wav).size)
    pass('새로 만든 덩이: 확정됨 · 기록의 보낸 글/음원 지문이 실제와 같다')

    const b = await speak(T1, NO)
    assert.ok(b.data.cached && b.data.trace.spoken.cacheState === 'verified' && b.data.trace.spoken.madeWith, JSON.stringify(b.data.trace))
    pass('같은 덩이 다시 읽기 → 검증된 캐시(verified) · 만들 당시 기록 표시')

    fs.appendFileSync(wav, Buffer.from([0, 0]))
    const c1 = await speak(T1, NO)
    assert.ok(!c1.data.cached && c1.data.trace.spoken.cacheState === 'wav-mismatch' && c1.data.trace.spoken.committed === true, JSON.stringify(c1.data.trace))
    pass('음원 변조 → 쓰지 않고 새로 만들어 다시 확정(wav-mismatch)')

    fs.writeFileSync(rec, '{깨진 기록')
    const d1 = await speak(T1, NO)
    assert.ok(!d1.data.cached && d1.data.trace.spoken.cacheState === 'record-unreadable', JSON.stringify(d1.data.trace))
    pass('기록 깨짐 → 쓰지 않음(record-unreadable)')

    fs.rmSync(rec)
    const e1 = await speak(T1, NO)
    assert.ok(e1.data.cached && e1.data.trace.spoken.cacheState === 'legacy-unrecorded' && e1.data.trace.spoken.madeWith === null, JSON.stringify(e1.data.trace))
    pass('기록 없는 옛 소리 + 바꾼 글 없는 요청 → 다시 쓰되 만들 당시 기록은 없음(null)')
    const e2 = await speak(T1, { rule: 'ordinal-ko-v1', ordinalChanges: 1 })
    assert.ok(!e2.data.cached && e2.data.trace.spoken.cacheState === 'legacy-needs-rule', JSON.stringify(e2.data.trace))
    pass('기록 없는 소리 + 보정 요청 → 쓰지 않고 새로 만듦(legacy-needs-rule)')

    // 확정 실패 — 기록 자리를 폴더로 막는다. 다른 쌓아 둔 것은 그대로여야 한다.
    const others = fs.readdirSync(dir).filter((n) => n.endsWith('.wav') && path.join(dir, n) !== wav)
    fs.rmSync(wav); fs.rmSync(rec, { force: true }); fs.mkdirSync(rec)
    const f1 = await speak(T1, NO)
    const playOnly = f1.data.path
    assert.ok(f1.data.trace.spoken.committed === false && /nocache-/.test(path.basename(playOnly)) && fs.existsSync(playOnly), JSON.stringify(f1.data))
    assert.ok(!fs.existsSync(wav), '확정 실패인데 이름 자리에 음원이 생겼다')
    pass('확정 실패 → 이름으로 쌓지 않고 재생 전용 파일(nocache)로')
    const g = await speak('다른 덩이 하나. 조용한 밤이었다.', NO)          // 새 작업 폴더를 만들고 지운다
    assert.ok(g.data && fs.existsSync(playOnly), '재생 전용 파일이 다음 작업 정리 뒤 사라졌다')
    pass('재생 전용 파일은 다음 작업의 임시 폴더 정리 뒤에도 남는다')
    assert.ok(others.every((n) => fs.existsSync(path.join(dir, n))), '다른 쌓아 둔 소리가 지워졌다')
    pass(`다른 쌓아 둔 소리 ${others.length}개는 그대로`)
    fs.rmdirSync(rec)

    const errs = await call('errors')
    assert.equal(errs.count, 0, JSON.stringify(errs).slice(0, 300))
    pass('오류 기록 없음')
    console.log(`RESULT ${passed} checks · 0 fail`)
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1 } finally { await c.call('app_stop'); await c.close() }
})()
