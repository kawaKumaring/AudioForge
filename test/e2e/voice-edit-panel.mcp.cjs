'use strict'
// 음성 편집 패널 — 개발툴 MCP 로 실제 앱을 조작해 확인한다. 재료: 저장소 시험 음성 + 합성 톤(사용자 음성 없음).
// 확인: 화자 트랙 2개 · 소리 추가 · 다른 트랙끼리 겹치기(끼어들기) · 같은 트랙 겹치기 = 크로스페이드(한계에서 멈춤) ·
//       자르기 · 페이드 만들기 · 되돌리기 · 음성 처리 켜기 · 재생 위치 진행 · 섞어서 저장(파일 수치).
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { McpClient } = require('../../tools/mcp/client.cjs')

const clips = `[...document.querySelectorAll('[data-testid^="ve-clip-c"]')].map(e => ({ id: e.dataset.testid.slice(8), start: +e.dataset.start, duration: +e.dataset.duration, lane: [...document.querySelectorAll('[data-testid^="ve-lane-"]')].findIndex(l => l.contains(e)) }))`
/** 시간축(ve-lanes) 안의 비율 좌표 — 초·트랙 번호·클립 안 세로 비율로. */
const ratio = (sec, lane, yIn = 0.6) => `(() => { const L = document.querySelector('[data-testid="ve-lanes"]').getBoundingClientRect(); const R = document.querySelector('[data-testid="ve-ruler"]').getBoundingClientRect(); const lane0 = document.querySelector('[data-testid="ve-lane-0"]').getBoundingClientRect(); const pps = (() => { const c = document.querySelector('[data-testid^="ve-clip-c"]'); return c.getBoundingClientRect().width / +c.dataset.duration })(); return [(${sec} * pps + 1) / L.width, (R.height + ${lane} * lane0.height + 5 + ${yIn} * (lane0.height - 10)) / L.height] })()`

;(async () => {
  const c = new McpClient()
  await c.start()
  let count = 0
  const ok = (v, label) => { assert.ok(v, label); count++; console.log('PASS', label) }
  const ev = async (code) => { const r = await c.call('js_eval', { code: `JSON.stringify(${code})` }); if (r.isError) throw new Error(r.text); const v = r.json?.result ?? r.json ?? r.text; if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }
  const click = (t) => c.call('ui_click', { target: 'testid:' + t })
  const drag = async (from, to) => { const r = await c.call('ui_pointer', { target: 'testid:ve-lanes', action: 'drag', at: from, to, steps: 12 }); if (r.isError) throw new Error(r.text) }
  let saved = ''
  try {
    const s = await c.call('app_start', {}); if (s.isError) throw new Error(s.text)
    await c.call('app_mode', { mode: 'voiceedit' })
    await c.call('ui_wait', { selector: 'testid:ve-lanes', timeoutMs: 15000 })
    ok((await ev(`document.querySelectorAll('[data-testid^="ve-lane-"]').length`)) === 2, '처음 열면 화자 트랙 2개')

    const speech = (await c.call('test_input', { kind: 'fixture', name: 'ko-speech-7s.wav' })).json.path
    const tone = (await c.call('test_input', { kind: 'tone', seconds: 2, freq: 300 })).json.path
    await click('ve-head-0'); await c.call('dialog_queue', { kind: 'open', answers: [[speech]] }); await click('ve-add-clip')
    await c.call('ui_wait', { code: `document.querySelectorAll('[data-testid^="ve-clip-c"]').length === 1`, timeoutMs: 15000 })
    await click('ve-head-1'); await c.call('dialog_queue', { kind: 'open', answers: [[tone]] }); await click('ve-add-clip')
    await c.call('ui_wait', { code: `document.querySelectorAll('[data-testid^="ve-clip-c"]').length === 2`, timeoutMs: 15000 })
    let cl = await ev(clips)
    const sp = cl.find((x) => x.lane === 0), tn = cl.find((x) => x.lane === 1)
    ok(sp && tn && sp.duration > 6.5 && sp.duration < 8 && Math.abs(tn.duration - 2) < 0.05, `소리 2개를 각 화자 트랙에 놓음(${sp?.duration.toFixed(2)}초 · ${tn?.duration.toFixed(2)}초)`)

    // 끼어들기: 다른 트랙에서 말소리 한가운데로 옮긴다
    await drag(await ev(ratio(1, 1)), await ev(ratio(4, 1)))
    cl = await ev(clips); let t = cl.find((x) => x.id === tn.id)
    ok(t.lane === 1 && Math.abs(t.start - 3) < 0.2, `다른 화자 트랙에서 겹쳐 놓음(끼어들기, 시작 ${t.start.toFixed(2)}초)`)

    // 같은 트랙으로 내려 말소리 끝과 3초 겹치게 → 한계(짧은 쪽 절반 = 1초)에서 멈춘다
    const spEnd = sp.start + sp.duration
    await drag(await ev(ratio(t.start + 1, 1)), await ev(ratio(spEnd - 2, 0)))
    cl = await ev(clips); t = cl.find((x) => x.id === tn.id)
    ok(t.lane === 0 && t.start >= spEnd - 1.95 - 0.02 && t.start < spEnd - 1.5, `같은 트랙 겹침은 한계(1.95초)에서 멈춤(시작 ${t.start.toFixed(2)} · 말소리 끝 ${spEnd.toFixed(2)})`)
    const panel = await ev(`document.querySelector('[data-testid="ve-clip-panel"]').innerText`)
    ok(/크로스페이드/.test(panel), '겹친 구간은 크로스페이드로 표시')

    // 1초 겹침으로 옮긴 뒤(크로스페이드 1초)
    await drag(await ev(ratio(t.start + 0.5, 0)), await ev(ratio(t.start + 0.5 + (spEnd - 1 - t.start), 0)))
    cl = await ev(clips); t = cl.find((x) => x.id === tn.id)
    ok(Math.abs(t.start - (spEnd - 1)) < 0.06, `1초 겹침으로 옮김(시작 ${t.start.toFixed(2)})`)
    // 자르기: 톤 클립 오른쪽(겹치지 않은 쪽) 끝을 0.5초 앞으로
    const before = t.duration
    await drag(await ev(ratio(t.start + t.duration - 0.02, 0)), await ev(ratio(t.start + t.duration - 0.52, 0)))
    cl = await ev(clips); t = cl.find((x) => x.id === tn.id)
    ok(t.duration < before - 0.3, `오른쪽 끝을 끌어 자름(${before.toFixed(2)} → ${t.duration.toFixed(2)}초)`)

    // 되돌리기
    await c.call('ui_key', { target: 'testid:ve-lanes', keys: 'Control+z' })
    cl = await ev(clips); const back = cl.find((x) => x.id === tn.id)
    ok(Math.abs(back.duration - before) < 0.01, '되돌리기(Ctrl+Z)로 자르기 전 길이')

    // 페이드 만들기: 말소리 클립 왼쪽 위 모서리를 오른쪽으로
    await drag(await ev(ratio(sp.start + 0.05, 0, 0.1)), await ev(ratio(sp.start + 0.8, 0, 0.1)))
    await click(`ve-clip-${sp.id}`).catch(() => {})
    const fadeTxt = await ev(`document.querySelector('[data-testid="ve-clip-panel"]').innerText`)
    const fi = Number((/페이드 인 ([\d.]+)초/.exec(fadeTxt) || [])[1])
    ok(fi > 0.4, `위 모서리를 끌어 페이드 인(${fi}초)`)

    // 음성 처리: 치찰음 줄이기 켜기
    await click('ve-head-0'); await click('ve-fx-deesser-on')
    ok(await ev(`document.querySelector('[data-testid="ve-fx-deesser-on"]').getAttribute('aria-checked') === 'true'`), '화자 트랙에 치찰음 줄이기 켬(켠 항목은 스위치로 펼쳐짐)')

    // 재생 — 재생 위치선이 움직인다
    await click('ve-play')
    await new Promise((r) => setTimeout(r, 900))
    const x = await ev(`(() => { const m = /translateX\\(([\\d.]+)px\\)/.exec(document.querySelector('[data-testid="ve-playhead"]').style.transform); return m ? +m[1] : 0 })()`)
    const stopShown = await ev(`!!document.querySelector('[data-testid="ve-stop"]')`)
    ok(stopShown && x > 10, `재생 중 재생 위치선이 움직임(${x.toFixed(0)}px)`)
    await click('ve-stop')

    // 화면 캡처(이 화면에는 프롬프트가 없다)
    await c.call('ui_screenshot', { selector: 'testid:voiceedit-workspace', savePath: '음성편집/패널-2026-10-16.png' })

    // 섞어서 저장
    await click('ve-save')
    await c.call('ui_wait', { code: `/저장했습니다/.test(document.querySelector('[data-testid="ve-notice"]')?.innerText || '')`, timeoutMs: 60000 })
    saved = await ev(`document.querySelector('[data-testid="ve-notice"]').dataset.path`)
    const buf = fs.readFileSync(saved)
    const sr = buf.readUInt32LE(24), ch = buf.readUInt16LE(22), bits = buf.readUInt16LE(34), n = (buf.length - 44) / (ch * bits / 8)
    let peak = 0; for (let i = 44; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)) / 32768)
    const total = Math.max(...(await ev(clips)).map((x) => x.start + x.duration))
    ok(sr === 48000 && ch === 2 && Math.abs(n / sr - total) < 0.05, `저장 WAV 48kHz 스테레오 · 길이 ${(n / sr).toFixed(2)}초 = 시간축 ${total.toFixed(2)}초`)
    ok(20 * Math.log10(peak) <= -0.9, `저장 결과 최대치 ${(20 * Math.log10(peak)).toFixed(2)}dBFS (리미터 −1)`)
    ok(fs.existsSync(require('node:path').join(require('node:path').dirname(saved), 'project.json')), '작업(project.json)도 함께 저장')

    const errs = await c.call('errors', {})
    ok((errs.json?.count ?? 0) === 0, '화면 오류 0건')
    console.log('RESULT', count, 'checks, 0 fail')
  } finally {
    await c.call('app_stop', {}).catch(() => {})
    await c.close()
    if (saved) fs.rmSync(require('node:path').dirname(saved), { recursive: true, force: true })   // 시험 결과물 정리
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
