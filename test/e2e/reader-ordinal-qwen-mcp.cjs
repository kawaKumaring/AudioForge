// 서수 읽기 보정 — **실제 앱 + 실제 Qwen(GPU)** 연결 확인(2026-10-09). 소리 품질은 판정하지 않는다(사람 청취 몫).
// 1) 낭독 · Qwen 지정 목소리(소희): 화면이 보낸 글 = 원문 기준 보정 글(범위 "2~7번째" 는 그대로) · 기록의 규칙/바꾼 수
// 2) 낭독 · 참조 목소리(승인된 기존 참조 조각): 같은 확인 + 파이썬이 다시 바꾸지 않았는지(실행 기록의 조각 글)
// 3) 카드 · Qwen 지정 목소리: 생성·다시 생성 — 실행 기록의 규칙/바꾼 수, 카드 원문·첫 결과 파일·최종 선택 보존
// 실행: AF_E2E_GPU=1 node test/e2e/reader-ordinal-qwen-mcp.cjs   (사전: npm run build · GPU 여유 확인)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const ROOT = path.resolve(__dirname, '../..')
const { McpClient } = require(path.join(ROOT, 'tools/mcp/client.cjs'))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const REF = path.join(ROOT, '_local/perf-ref/ref-clip.wav')
const REF_SHA = 'b51c864845b55e147c7dc7e88cc16a99c232ce6a159ea55862c053421623233e'
// 실행 기록 자리는 파이썬 local_assets 가 정한다(작업 트리에서도 본체 저장소의 _local) — 같은 판정을 그대로 쓴다.
const PY = JSON.parse(fs.readFileSync(path.join(ROOT, 'externals/env.json'), 'utf-8')).python
const RUNS = path.join(require('node:child_process').execFileSync(PY, ['-c', 'import sys;sys.path.insert(0,"python");import local_assets as l;print(l.local_root())'], { cwd: ROOT, encoding: 'utf-8' }).trim(), 'artifacts', 'runs')
const TEXT = '그는 7번째 문을 열었다. 범위는 2~7번째다.'

if (process.env.AF_E2E_GPU !== '1') { console.log('SKIP AF_E2E_GPU=1 일 때만(GPU 사용)'); process.exit(0) }

;(async () => {
  const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)
  const { splitForReading, START_RAMP_SECONDS } = await imp('src/shared/readerChunks.ts')
  const { readingPlan } = await imp('src/shared/readerText.ts')
  const { ordinalContextBefore } = await imp('src/shared/spokenOrdinals.ts')
  const expectSay = (doc, ordinals) => splitForReading(doc, { ramp: START_RAMP_SECONDS })
    .map((c) => readingPlan(c.text, { skipHanjaInParens: false, ordinals, before: ordinals ? ordinalContextBefore(doc, c.start) : '' }).say)
  const runsAfter = (t0) => (fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []).map((n) => path.join(RUNS, n))
    .filter((d) => fs.statSync(d).mtimeMs >= t0 && fs.existsSync(path.join(d, 'manifest.json')))
  const privateText = (d) => fs.readdirSync(d, { recursive: true }).filter((n) => /\.json$/.test(n)).map((n) => { try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(d, n), 'utf-8'))) } catch { return '' } }).join('\n')

  const c = new McpClient(); await c.start()
  const call = async (n, a = {}) => { const r = await c.call(n, a); if (r.isError) throw Error(n + ': ' + r.text); return r.json }
  const js = async (code, extra = {}) => (await call('js_eval', { code: `({ v: ${code} })`, ...extra })).v
  let passed = 0; const pass = (s) => { passed++; console.log('PASS', s) }
  const out = { reader: {}, card: {} }
  try {
    assert.equal(sha(fs.readFileSync(REF)), REF_SHA, '승인된 참조 조각이 아니다')
    await call('app_start', { build: 'never' })
    const st = await call('app_status')
    const dir = path.join(ROOT, st.userData, 'readerChunks')
    const voices = (await call('api_call', { method: 'cards.builtinVoices' }))?.data?.voices || (await call('api_call', { method: 'cards.builtinVoices' })).voices
    const sohee = voices.find((v) => v.engineId === 'qwen-custom' && v.modelId === 'sohee')
    assert.ok(sohee, 'Qwen 소희가 설치되어 있지 않다')
    await call('app_mode', { mode: 'reader' })
    const t = await call('test_input', { kind: 'text', name: '서수 Qwen', content: TEXT })
    await call('dialog_queue', { kind: 'open', answers: [t.path] })
    await call('ui_click', { target: 'testid:reader-add-text' })
    await call('ui_wait', { code: "document.querySelectorAll('[data-testid=reader-paragraph]').length >= 1", timeoutMs: 10000 })

    const readWith = async (pick, label, extra = {}) => {
      await js(`(window.__readerStore.setState({ pick: ${JSON.stringify(pick)}, voice: ${JSON.stringify(pick.label)} }), true)`, extra)
      await call('reader_trace', { clear: true })
      const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      const t0 = Date.now()
      await call('ui_click', { target: 'testid:reader-play' })
      const w = await call('ui_wait', { code: "window.__readerTrace.dump().events.some((e) => e.ev === 'gen-done' && e.ok)", timeoutMs: 600000 })
      assert.ok(w.met, label + ': 생성 응답 없음')
      // 앞 목소리의 미리 만들기가 세대로 버려진 응답(superseded)은 빼고, 이 목소리로 만든 응답만 본다.
      const ev = (await call('reader_trace', { clear: true })).events.filter((e) => e.ev === 'gen-done' && e.ok)
      await call('ui_click', { target: 'testid:reader-play' }).catch(() => {})
      const first = ev[0]
      assert.ok(first.ok, label + ': 생성 실패 ' + JSON.stringify(first))
      const recs = fs.readdirSync(dir).filter((n) => n.endsWith('.spoken.json') && !before.has(n)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')))
      return { first, recs, t0 }
    }
    const want = expectSay(TEXT, true)
    assert.ok(want[0].includes('일곱 번째') && want[0].includes('2에서 7번째'), want[0])

    // ── 1) 낭독 · 소희 ──
    const r1 = await readWith({ kind: 'builtin', path: sohee.path, engineId: 'qwen-custom', modelId: 'sohee', label: sohee.label }, '소희')
    assert.ok(r1.first.spokenRule === 'ordinal-ko-v1' && r1.first.spokenChanges === 1, JSON.stringify(r1.first))
    assert.ok(r1.recs.length >= 1 && r1.recs[0].sentSha256 === sha(want[0]) && r1.recs[0].usedText === 'spoken' && /qwen/.test(r1.recs[0].engine), JSON.stringify(r1.recs[0]))
    out.reader.sohee = { engine: r1.recs[0].engine, rule: r1.recs[0].rule, changes: r1.recs[0].ordinalChanges }
    pass(`낭독·소희: 실제 보낸 글 = 원문 기준 보정 글(1곳, 범위는 그대로) · 엔진 ${r1.recs[0].engine}`)

    // ── 2) 낭독 · 참조 목소리 ──
    const r2 = await readWith({ kind: 'reference', path: REF, label: '승인 참조' }, '참조', { userApproved: true })
    assert.ok(r2.first.spokenRule === 'ordinal-ko-v1' && r2.first.spokenChanges === 1, JSON.stringify(r2.first))
    assert.ok(r2.recs.length >= 1 && r2.recs[0].sentSha256 === sha(want[0]) && r2.recs[0].usedText === 'spoken', JSON.stringify(r2.recs[0]))
    const runs2 = runsAfter(r2.t0)
    const man2 = runs2.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf-8')))
    const hdr2 = man2.map((m) => m.run || m.header || m).find((h) => h && h.spoken_route)
    assert.ok(hdr2 && hdr2.spoken_route === 'qwen' && hdr2.spoken_prepared_by_caller === 'ordinal-ko-v1', JSON.stringify(hdr2))
    const priv2 = runs2.map(privateText).join('\n')
    assert.ok(priv2.includes('일곱 번째') && priv2.includes('2에서 7번째') && !priv2.includes('2에서 일곱'), '참조 경로 실행 기록의 조각 글이 기대와 다르다')
    out.reader.reference = { engine: r2.recs[0].engine, runs: runs2.map((d) => path.basename(d)) }
    pass(`낭독·참조: 화면 보정 글을 파이썬이 다시 바꾸지 않고 Qwen 으로(실행 기록 ${runs2.length}개) · 엔진 ${r2.recs[0].engine}`)

    // ── 3) 카드 · 소희 — 생성과 다시 생성 ──
    await call('app_mode', { mode: 'tts' })
    const CARD_TEXT = '그는 7번째 문을 열었다.'
    await js(`(() => { const s = window.__synthesisCards.getState(); const settings = { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: 0 };
      s.replaceAll([{ id: 'card-q', label: '서수 카드', source: null, builtin: { engineId: 'qwen-custom', modelId: 'sohee', path: ${JSON.stringify(sohee.path)}, label: ${JSON.stringify(sohee.label)}, language: 'ko' },
        text: ${JSON.stringify(CARD_TEXT)}, settings, takes: [], adoptedId: null }], { gap: .3, level: false, edges: false, gaps: {} }); return true })()`)
    const gen = async (n) => {
      const t0 = Date.now()
      await call('ui_click', { target: 'testid:card-generate' })
      const w = await call('ui_wait', { code: `window.__synthesisCards.getState().cards[0].takes.length >= ${n}`, timeoutMs: 600000 })
      assert.ok(w.met, `카드 ${n}번째 생성이 끝나지 않았다`)
      return t0
    }
    const c0 = await gen(1)
    const take1 = await js('window.__synthesisCards.getState().cards[0].takes[0]')
    await js(`(window.__synthesisCards.getState().update('card-q', { adoptedId: ${JSON.stringify(take1.id)} }), true)`)
    const take1Sha = sha(fs.readFileSync(take1.path))
    const c1 = await gen(2)
    const card = await js('window.__synthesisCards.getState().cards[0]')
    assert.equal(card.text, CARD_TEXT, '카드 원문이 바뀌었다')
    assert.equal(card.adoptedId, take1.id, '최종 선택이 바뀌었다')
    const t1now = card.takes.find((x) => x.id === take1.id)
    assert.ok(t1now && t1now.path === take1.path && sha(fs.readFileSync(take1.path)) === take1Sha, '첫 결과 파일이 바뀌었다')
    const take2 = card.takes.find((x) => x.id !== take1.id)
    assert.ok(take2 && take2.path !== take1.path && fs.existsSync(take2.path), '다시 생성이 새 결과를 만들지 않았다')
    pass('카드: 다시 생성은 새 결과 · 원문/첫 결과 파일/최종 선택 그대로')
    const cardRuns = runsAfter(c0)
    const hdrs = cardRuns.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf-8'))).map((m) => m.run || m.header || m).filter((h) => h && h.spoken_route)
    assert.ok(hdrs.length >= 2 && hdrs.every((h) => h.spoken_route === 'qwen' && h.spoken_rule === 'ordinal-ko-v1' && h.spoken_ordinal_changes === 1 && !h.spoken_prepared_by_caller), JSON.stringify(hdrs))
    // 실제로 엔진에 보낸 글 = sent.private.json(보정 글) · 원문 = script.private.json(그대로)
    for (const d of cardRuns.filter((x) => fs.existsSync(path.join(x, 'sent.private.json')))) {
      const sent = JSON.parse(fs.readFileSync(path.join(d, 'sent.private.json'), 'utf-8')).segments
      const script = JSON.parse(fs.readFileSync(path.join(d, 'script.private.json'), 'utf-8'))
      assert.ok(sent.length === 1 && sent[0].text === '그는 일곱 번째 문을 열었다.' && sent[0].engine && script.raw_text === CARD_TEXT, JSON.stringify({ sent, raw: script.raw_text }))
    }
    assert.equal(cardRuns.filter((x) => fs.existsSync(path.join(x, 'sent.private.json'))).length, hdrs.length, '실제 보낸 글 기록이 없는 실행이 있다')
    pass('카드: 실행 기록에 실제 보낸 글(일곱 번째)과 원문(7번째)이 따로 남는다')
    out.card = { runs: cardRuns.map((d) => path.basename(d)), take1: take1.path, take2: take2.path }
    pass(`카드: 두 실행 모두 실행 기록에 규칙 ordinal-ko-v1 · 바꾼 수 1 · Qwen 경로(${hdrs.length}개)`)

    const errs = await call('errors')
    assert.equal(errs.count, 0, JSON.stringify(errs).slice(0, 300))
    pass('오류 기록 없음')
    fs.mkdirSync(path.join(ROOT, '_local/integ-2026-10-09'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, '_local/integ-2026-10-09/qwen-connection.json'), JSON.stringify(out, null, 2))
    console.log(`RESULT ${passed} checks · 0 fail`)
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1 } finally { await c.call('app_stop'); await c.close() }
})()
