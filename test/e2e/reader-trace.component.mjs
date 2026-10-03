// 낭독 관측 기록(lib/readerTrace)이 **실제와 맞는가** — 알고 있는 지연을 넣고 기록된 시각을 대 본다(2026-10-03 관리자 승인 '최소 관측').
//
// 실제 낭독 엔진(useReadAloud) + 실제 소리 요소(짧은 합성 WAV). 합성 응답은 가짜 — 요청마다 정한 만큼 늦게 오고, 본체 단계 길이(trace)를 싣는다.
// ★'재생 시작' 이 play() 호출이 아니라 **소리가 실제로 흐르기 시작한 때**인지 보려고, play() 를 부른 뒤 250ms 늦게 실제 재생이 시작되게 한다.
// 보는 것: 요청·생성 시작(유도)·완료·실제 재생 시작 순서와 간격 · 버퍼 부족 시작/끝 · 미리 불러 둔 이어 틂 · 캐시 적중 · 문단 이동 후 첫 소리 · 본문/경로 없음.
// 실행: node test/e2e/reader-trace.component.mjs   (빌드 불필요 · GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

const out = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import { useReadAloud } from './src/renderer/hooks/useReadAloud';
function H(){ const r = useReadAloud(window.__text, window.__pick, {}); window.__r = r; return null }
createRoot(document.getElementById('root')).render(<H/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

function wavUrl(seconds) {
  const SR = 8000, n = Math.floor(SR * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 0.1) * 5000), 44 + i * 2)
  return 'data:audio/wav;base64,' + b.toString('base64')
}
const SENT = '어두운 복도를 조용히 내다보는 이야기입니다'
const TEXT = Array.from({ length: 24 }, (_, i) => `${i + 1}번째 문장은 ${SENT}.`).join(' ')
const REF = { kind: 'reference', path: 'C:/개인/목소리/ref.wav', label: 'R' }
const PLAY_DELAY = 250

let passed = 0
const fails = []
const ok = (v, label, extra) => { if (v) { passed++; console.log('PASS', label) } else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) } }
const near = (v, want, tol) => typeof v === 'number' && Math.abs(v - want) <= tol

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.setContent('<div id="root"></div>')
await page.evaluate(({ url, text, pick, PLAY_DELAY }) => {
  window.__text = text; window.__pick = pick
  // 요청 차례별 응답 계획: 지연(ms) · 본체가 싣는 단계 길이
  window.__plan = [
    { delay: 300, trace: { waitMs: 40, makeMs: 200, modelOpened: true, engine: 'separate-process' } },   // 0번 — 첫 덩이
    { delay: 1500, trace: { waitMs: 0, makeMs: 1400, modelOpened: false, engine: 'separate-process' } }, // 1번 — 늦어서 버퍼 부족
    { delay: 30, trace: { cached: true } },                                                              // 2번 — 캐시 적중
  ]
  window.__calls = 0
  window.__playCalls = []                 // play() 를 부른 시각
  const P = HTMLMediaElement.prototype, play = P.play
  // ★play() 를 부른 뒤 PLAY_DELAY 만큼 지나서야 실제 재생이 시작된다 — 관측이 play() 호출을 재생 시작으로 쓰면 잡힌다.
  P.play = function () { window.__playCalls.push(performance.now()); const el = this; return new Promise((res, rej) => setTimeout(() => play.call(el).then(res, rej), PLAY_DELAY)) }
  const base = {
    reader: {
      speak: (t) => new Promise((res) => {
        const p = window.__plan[window.__calls++] || { delay: 100, trace: { waitMs: 0, makeMs: 80, modelOpened: false } }
        setTimeout(() => res({ data: { path: 'chunk-' + window.__calls + '.wav', cached: !!p.trace.cached, trace: p.trace } }), p.delay)
      }),
    },
    audio: { getFileUrl: async () => url },
  }
  const any = () => new Proxy(() => {}, { get: () => any(), apply: () => Promise.resolve({}) })
  window.api = new Proxy(base, { get: (t, k) => (k in t ? t[k] : any()) })
}, { url: wavUrl(0.4), text: TEXT, pick: REF, PLAY_DELAY })
await page.addScriptTag({ content: out.outputFiles[0].text })
await page.waitForFunction(() => !!window.__r && !!window.__readerTrace)
const dump = () => page.evaluate(() => window.__readerTrace.dump())
const evs = async (name) => (await dump()).events.filter((e) => e.ev === name)

try {
  await page.evaluate(() => window.__r.start())
  // 2번 덩이까지 실제로 흐를 때까지
  await page.waitForFunction(() => window.__readerTrace.dump().events.filter((e) => e.ev === 'play-start' && e.first).length >= 3, null, { timeout: 15000 })
  const d = await dump()
  const E = d.events
  const req0 = E.find((e) => e.ev === 'play-request')
  const g0 = E.find((e) => e.ev === 'gen-request' && e.chunk === 0)
  const done0 = E.find((e) => e.ev === 'gen-done' && e.chunk === 0)
  const start0 = E.find((e) => e.ev === 'gen-start' && e.chunk === 0)
  const p0 = E.find((e) => e.ev === 'play-start' && e.chunk === 0 && e.first)
  ok(d.clock.includes('단조') && d.max === 500 && typeof d.mode === 'string', '기록 머리: 단조 시계 · 최대 500개 · 실행 방식', { clock: d.clock, max: d.max, mode: d.mode })
  ok(!!(req0 && g0 && done0 && start0 && p0) && req0.t <= g0.t && g0.t <= start0.t && start0.t < done0.t && done0.t < p0.t, '★순서: 재생 요청 ≤ 덩이 요청 ≤ 생성 시작 < 완료 < 실제 재생 시작', [req0?.t, g0?.t, start0?.t, done0?.t, p0?.t])
  ok(near(done0.t - g0.t, 300, 80), '덩이 요청 → 완료 = 넣은 응답 지연(300ms)', done0.t - g0.t)
  ok(near(done0.t - start0.t, 200, 5) && start0.derived === true, '생성 시작 = 완료 − 본체 생성 길이(200ms) · 유도값 표시', { gap: done0.t - start0.t, derived: start0.derived })
  ok(done0.waitMs === 40 && done0.makeMs === 200 && done0.modelOpened === true && done0.cached === false && done0.accepted === true && typeof done0.req === 'string' && typeof done0.gen === 'number', '완료 기록: 요청 이름표·세대·줄 대기·생성 길이·모델 처음 엶·받아들임', done0)
  const call0 = (await page.evaluate(() => window.__playCalls))[0]
  const playCallT = Math.round(call0 * 10) / 10
  ok(p0.t - playCallT >= PLAY_DELAY - 10, `★실제 재생 시작은 play() 호출이 아니다 — 호출 ${PLAY_DELAY}ms 뒤 실제로 흐른 때`, { sincePlayCall: p0.t - playCallT })
  ok(near(p0.sinceRequestMs, p0.t - req0.t, 2) && p0.after === 'start' && p0.sinceRequestMs >= 300 + PLAY_DELAY - 20, '★첫 소리: 시작 누름부터 실제 재생까지(응답 300 + 재생 250 이상)', p0.sinceRequestMs)

  // 버퍼 부족 — 0번(0.4초)이 끝났는데 1번은 아직(1.5초 지연)
  const low = E.find((e) => e.ev === 'buffer-low-start' && e.chunk === 1)
  const lowEnd = E.find((e) => e.ev === 'buffer-low-end' && e.chunk === 1)
  const p1 = E.find((e) => e.ev === 'play-start' && e.chunk === 1 && e.first)
  ok(!!low && low.initial === false, '★재생 도중 버퍼 부족 시작이 잡힌다(시작 직후 기다림과 구분: initial=false)', low)
  ok(!!lowEnd && !!p1 && near(lowEnd.t, p1.t, 1) && near(lowEnd.lowMs, p1.t - low.t, 2), '버퍼 부족 끝 = 다음 실제 재생 시작, 길이 일치', { lowMs: lowEnd?.lowMs, span: p1 && low && p1.t - low.t })
  const done1 = E.find((e) => e.ev === 'gen-done' && e.chunk === 1)
  ok(!!p1 && p1.gapMs >= (done1.t - low.t) - 5, '덩이 사이 틈(앞 끝 → 다음 실제 재생)이 기다린 만큼 길다', { gapMs: p1?.gapMs })
  // 캐시 적중 + 미리 불러 둔 이어 틂
  const done2 = E.find((e) => e.ev === 'gen-done' && e.chunk === 2)
  const p2 = E.find((e) => e.ev === 'play-start' && e.chunk === 2 && e.first)
  ok(done2?.cached === true && !E.some((e) => e.ev === 'gen-start' && e.chunk === 2), '★캐시 적중이 기록되고, 적중에는 생성 시작을 만들지 않는다', done2)
  ok(p2?.via === 'preloaded' && typeof p2.gapMs === 'number', '미리 불러 둔 요소로 이어 틀었는지와 그 틈', p2)

  // 문단 이동 — 이동 요청부터 새 자리 실제 재생까지
  await page.evaluate(() => window.__readerTrace.clear())
  const chunks = await page.evaluate(() => window.__r.chunks.map((c) => ({ start: c.start, text: c.text })))
  const k = chunks.length - 2
  await page.evaluate((c) => window.__r.seekToChar(c), chunks[k].start + chunks[k].text.indexOf('번째') + 6)
  await page.waitForFunction(() => window.__readerTrace.dump().events.some((e) => e.ev === 'play-start' && e.after === 'seek'), null, { timeout: 8000 })
  const S = (await dump()).events
  const sk = S.find((e) => e.ev === 'seek-request')
  const ps = S.find((e) => e.ev === 'play-start' && e.after === 'seek')
  const rs = S.find((e) => e.ev === 'resplit')
  ok(!!sk && !!rs && rs.gen > (sk.gen ?? -1), '문단 이동이 새 세대(다시 나눔)로 기록된다', { seekGen: sk?.gen, resplitGen: rs?.gen })
  ok(!!ps && ps.chunk === rs.chunk && near(ps.sinceRequestMs, ps.t - sk.t, 2) && ps.sinceRequestMs >= 100 + PLAY_DELAY - 20, '★이동 후 첫 소리: 이동 요청부터 새 자리 실제 재생까지', ps)
  ok(S.filter((e) => e.ev === 'gen-done').every((e) => e.gen === rs.gen || e.accepted === false), '옛 세대의 늦은 응답은 받아들이지 않음으로 기록된다')

  // 내용 없음
  const all = JSON.stringify(await dump()) + JSON.stringify(d)
  ok(!all.includes(SENT.slice(0, 6)) && !all.includes('개인') && !all.includes('ref.wav') && !all.includes('chunk-'), '★기록에 본문·개인 경로·파일 이름이 없다')
  ok(errors.length === 0, '런타임 오류 없음', errors)
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
