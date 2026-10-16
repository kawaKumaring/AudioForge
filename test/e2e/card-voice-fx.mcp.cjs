'use strict'
// 카드 고급 옵션의 음성 처리(P3) — 개발툴 MCP 로 실제 앱을 조작해 확인한다. 재료: 저장소 시험 음성(사용자 음성 없음).
// 실제 생성(GPU)은 하지 않는다 — 시험 음성을 생성본 하나로 놓고 처리 연결만 본다.
// 확인: 고급 옵션에 '음성 처리' · 켜기 · 들으며 조절(실시간 재생·압축량 표시) · 처리 전 비교 · 적용 → 원본 옆 처리본 저장·생성본이 처리본을
//       가리킴·원본 보존 · 처리본 길이 = 원본 · 최대치 ≤ −1dB · 다시 적용하면 직전 처리본 정리 · 끄면 원본으로 · 화면 오류 0.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { McpClient } = require('../../tools/mcp/client.cjs')

function wavInfo (file) {
  const b = fs.readFileSync(file)
  let o = 12, ch = 0, sr = 0, bits = 0, data = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4)
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22) }
    if (id === 'data') data = b.subarray(o + 8, o + 8 + n)
    o += 8 + n + (n & 1)
  }
  let peak = 0
  if (bits === 16) for (let i = 0; i + 1 < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)) / 32768)
  return { ch, sr, bits, seconds: data.length / (ch * bits / 8) / sr, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)) }
}

;(async () => {
  const c = new McpClient()
  await c.start()
  let count = 0, cleanup = ''
  const ok = (v, label) => { assert.ok(v, label); count++; console.log('PASS', label) }
  const ev = async (code) => { const r = await c.call('js_eval', { code: `JSON.stringify(${code})` }); if (r.isError) throw new Error(r.text); const v = r.json?.result ?? r.json ?? r.text; if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
  const click = (t) => c.call('ui_click', { target: 'testid:' + t })
  const take = () => ev(`(() => { const t = window.__afCards.getState().cards[0].takes[0]; return { path: t.path, raw: t.rawPath || '', fx: !!t.settings.voiceFx } })()`)
  const apply = () => ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '적용' && !b.disabled); b.click(); return !!b })()`)
  const openSettings = async () => {
    await ev(`document.querySelector('[aria-label="1번 카드 고급 옵션"]').click()`)
    await c.call('ui_wait', { selector: 'testid:card-fx-settings', timeoutMs: 8000 })
  }
  try {
    const s = await c.call('app_start', {}); if (s.isError) throw new Error(s.text)
    await c.call('app_mode', { mode: 'tts' })
    await c.call('ui_wait', { code: `!!window.__afCards`, timeoutMs: 15000 })
    const fixture = (await c.call('test_input', { kind: 'fixture', name: 'ko-speech-7s.wav' })).json.path
    // 생성본처럼 쓸 사본 — 처리본이 '원본 옆' 에 생기므로 시험 재료 폴더를 더럽히지 않게 따로 둔다.
    const dir = path.join(path.dirname(fixture), 'card-fx'); fs.mkdirSync(dir, { recursive: true }); cleanup = dir
    const raw = path.join(dir, 'take1.wav'); fs.copyFileSync(fixture, raw)
    const rawInfo = wavInfo(raw)
    const settings = { speed: 1, pitch: 0, emotion: '자연스럽게', reference: 'auto', start: 0, end: rawInfo.seconds }
    const src = { path: raw, name: 'take1.wav', duration: rawInfo.seconds }
    await ev(`(() => { const st = window.__afCards.getState(); st.replaceAll([{ id: 'c1', label: '시험', source: ${JSON.stringify(src)}, text: '안녕하세요', settings: ${JSON.stringify(settings)},
      takes: [{ id: 't1', path: ${JSON.stringify(raw)}, createdAt: 1, text: '안녕하세요', source: ${JSON.stringify(src)}, settings: ${JSON.stringify(settings)}, applied: { speed: 1, pitch: 0, notes: [] } }], adoptedId: 't1' }], st.joins); st.setView && st.setView('cards'); return true })()`)
    await c.call('ui_wait', { code: `!!document.querySelector('[aria-label="1번 카드 고급 옵션"]')`, timeoutMs: 10000 })

    await openSettings()
    ok((await ev(`document.querySelector('[data-testid="card-fx-settings"]').innerText`)).includes('음성 처리'), '고급 옵션에 음성 처리 칸')
    await ev(`(() => { const d = document.querySelector('[data-testid="card-fx-settings"]'); d.open = true; return true })()`)
    await click('card-fx-on')
    ok(await ev(`!!document.querySelector('[data-testid="card-fx-compressor-on"]')`), '켜면 처리 항목이 나온다(기본: 저음 자르기·크기 고르게·최대치 보호)')
    await click('card-fx-deesser-on')

    await click('card-fx-play')
    await c.call('ui_wait', { code: `document.querySelector('[data-testid="card-fx-play"]').getAttribute('aria-pressed') === 'true'`, timeoutMs: 15000 })
    ok(true, '들으며 조절 — 최신 음성 반복 재생 시작')
    const gr = await c.call('ui_wait', { selector: 'testid:card-fx-compressor-gr', timeoutMs: 8000 })
    ok(!gr.isError, '재생 중 크기 고르게 압축량 표시가 실시간으로 온다')
    await click('card-fx-bypass')
    ok((await ev(`document.querySelector('[data-testid="card-fx-bypass"]').getAttribute('aria-pressed') === 'true'`)) === true, '처리 전 비교 전환')
    await click('card-fx-play')
    ok((await ev(`document.querySelector('[data-testid="card-fx-play"]').getAttribute('aria-pressed') === 'false'`)) === true, '멈춤')

    ok(await apply(), '적용')
    await c.call('ui_wait', { code: `(window.__afCards.getState().cards[0].takes[0].path || '').includes('_처리_')`, timeoutMs: 30000 })
    let t = await take()
    ok(t.raw === raw && t.fx && fs.existsSync(t.path) && path.dirname(t.path) === dir, '생성본이 원본 옆 처리본을 가리키고 원본 경로를 남김')
    ok(fs.existsSync(raw) && wavInfo(raw).seconds === rawInfo.seconds, '처리 전 원본은 그대로')
    const fxInfo = wavInfo(t.path)
    ok(Math.abs(fxInfo.seconds - rawInfo.seconds) < 0.01, `처리본 길이 = 원본(${fxInfo.seconds.toFixed(3)} / ${rawInfo.seconds.toFixed(3)}초)`)
    ok(fxInfo.peakDb <= -0.99, `처리본 최대치 ${fxInfo.peakDb.toFixed(2)}dB ≤ −1dB(최대치 보호)`)
    const first = t.path

    // 값을 바꿔 다시 적용 → 새 처리본, 직전 처리본 정리, 늘 원본에서 시작
    await openSettings()
    await ev(`(() => { const d = document.querySelector('[data-testid="card-fx-settings"]'); d.open = true; return true })()`)
    await click('card-fx-reverb-on')
    await apply()
    await c.call('ui_wait', { code: `window.__afCards.getState().cards[0].takes[0].path !== ${JSON.stringify(first)}`, timeoutMs: 30000 })
    t = await take()
    ok(t.raw === raw && fs.existsSync(t.path) && !fs.existsSync(first), '다시 적용 → 새 처리본, 직전 처리본 정리, 원본 기준')
    ok(fs.readdirSync(dir).filter((n) => n.includes('_처리_')).length === 1, '폴더에 처리본은 하나만')

    // 끄면 원본으로
    await openSettings()
    await ev(`(() => { const d = document.querySelector('[data-testid="card-fx-settings"]'); d.open = true; return true })()`)
    await click('card-fx-on')
    await apply()
    await c.call('ui_wait', { code: `window.__afCards.getState().cards[0].takes[0].path === ${JSON.stringify(raw)}`, timeoutMs: 10000 })
    t = await take()
    ok(t.path === raw && !t.raw && !t.fx, '처리를 끄면 생성본이 원본을 가리킨다')

    const errs = await c.call('errors', {})
    ok((errs.json?.count ?? 0) === 0, '화면 오류 0건')
    console.log(`\n${count}건 통과`)
  } catch (e) {
    console.error('FAIL', e.message)
    process.exitCode = 1
  } finally {
    await c.call('app_stop', {}).catch(() => {})
    await c.close()
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true })   // 시험 결과물 정리
  }
})()
