// 낭독 — 문단 이동으로 **덩이를 다시 나눈 뒤 늦게 온 앞 응답**이 새 자리에 들어가지 않는가(2026-10-03 관리자 검수).
//
// ★위험(코드에서 발견): 결과를 받는 조건이 '같은 목소리 + 그 번호가 만드는 중' 뿐이었다. 문단을 눌러 덩이를 다시 나누면
//   새 큐의 같은 번호가 다른 글로 '만드는 중' 이 되고, 앞 요청이 먼저 끝나면 **다른 글로 만든 소리**가 그 자리에 들어간다.
// 여기서는 실제 낭독 엔진(useReadAloud)을 띄우고, 합성 응답을 손으로 붙들었다가 **앞 응답을 먼저** 풀어 그 조건을 만든다.
//   성공 응답과 오류 응답 둘 다 본다. 재생은 실제 소리 요소(짧은 합성 WAV)를 쓴다.
// 실행: node test/e2e/reader-resplit.component.mjs   (빌드 불필요 · GPU 불필요)
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
const code = out.outputFiles[0].text

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

// 문장마다 다른 글 — 어느 글로 만든 소리인지 가린다. 제품 나누기 규칙 그대로.
const TEXT = Array.from({ length: 24 }, (_, i) => `${i + 1}번째 문장은 어두운 복도를 조용히 내다보는 이야기입니다.`).join(' ')
const REF = { kind: 'reference', path: 'ref.wav', label: 'R' }

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })

async function open() {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.evaluate(({ url, text, pick }) => {
    window.__text = text; window.__pick = pick
    window.__held = []                  // 붙든 요청 { text, resolve, reject, id }
    window.__played = []                // 실제로 소리가 시작된 파일(playing 사건)
    let n = 0
    // ★어느 파일인지는 **주소를 넣는 순간** 적는다(브라우저가 주소를 고쳐 쓰므로 나중에 주소로 되찾지 않는다).
    const P = HTMLMediaElement.prototype
    const d = Object.getOwnPropertyDescriptor(P, 'src')
    Object.defineProperty(P, 'src', { configurable: true, get() { return d.get.call(this) }, set(v) { this.__wantFile = window.__fileOf[v]; d.set.call(this, v) } })
    // 소리 요소는 화면(DOM) 밖이라 문서로 올라오지 않는다 — 요소마다 'playing' 을 직접 듣는다.
    const origPlay = P.play
    P.play = function () {
      if (!this.__heard) { this.__heard = true; this.addEventListener('playing', () => window.__played.push(this.__wantFile || '?')) }
      return origPlay.call(this)
    }
    window.__fileOf = {}; window.__seq = 0
    const base = {
      reader: {
        speak: (t) => new Promise((resolve, reject) => { window.__held.push({ text: String(t), resolve, reject, id: ++n }) }),
      },
      audio: { getFileUrl: async (p) => { const u = url.replace('data:audio/wav;', 'data:audio/wav;f=' + window.__seq++ + ';'); window.__fileOf[u] = p; return u } },
    }
    const any = () => new Proxy(() => {}, { get: () => any(), apply: () => Promise.resolve({}) })
    window.api = new Proxy(base, { get: (t, k) => (k in t ? t[k] : any()) })
  }, { url: wavUrl(0.4), text: TEXT, pick: REF })
  await page.addScriptTag({ content: code })
  await page.waitForFunction(() => !!window.__r)
  return { page, errors }
}
// 붙든 요청을 푼다 — 글 앞부분으로 고른다. ok=false 면 오류로 끝낸다. 파일 이름 = 'F:' + 글 앞 12자.
const release = (page, pred, okResp = true) => page.evaluate(({ pred, okResp }) => {
  const i = window.__held.findIndex((h) => h.text.startsWith(pred))
  if (i < 0) return false
  const h = window.__held.splice(i, 1)[0]
  if (okResp) h.resolve({ data: { path: 'F:' + h.text.slice(0, 12), cached: false } })
  else h.resolve({ error: '앞 요청의 오류' })
  return true
}, { pred, okResp })

async function scenario(okResp) {
  const tag = okResp ? '앞 응답 성공' : '앞 응답 오류'
  const { page, errors } = await open()
  const chunks0 = await page.evaluate(() => window.__r.chunks.map((c) => ({ start: c.start, text: c.text })))
  // 0번을 틀고, 1번 요청을 붙든다(GPU 목소리는 앞서 둘 — 0번이 준비되면 1번을 보낸다).
  await page.evaluate(() => window.__r.start())
  await page.waitForFunction((t) => window.__held.some((h) => h.text.startsWith(t)), chunks0[0].text.slice(0, 6))
  await release(page, chunks0[0].text.slice(0, 6))
  await page.waitForFunction((t) => window.__held.some((h) => h.text.startsWith(t)), chunks0[1].text.slice(0, 6))
  const oldOne = chunks0[1].text.slice(0, 12)
  // 0번 덩이 안의 **둘째 문장**을 누른다 → 새 경계, 0번 = 첫 문장 · 1번 = 둘째 문장부터(옛 1번과 다른 글).
  const second = chunks0[0].start + chunks0[0].text.indexOf('2번째')
  await page.evaluate((c) => window.__r.seekToChar(c), second)
  await page.waitForFunction(() => window.__r.at === 1)
  const chunks1 = await page.evaluate(() => window.__r.chunks.map((c) => ({ start: c.start, text: c.text })))
  const newOne = chunks1[1].text.slice(0, 12)
  ok(newOne !== oldOne && chunks1[1].start === second, `[${tag}] 준비: 다시 나눈 1번은 옛 1번과 다른 글이다`, { oldOne, newOne })
  await page.waitForFunction((t) => window.__held.some((h) => h.text.startsWith(t)), newOne, { timeout: 5000 })
  ok(await page.evaluate((t) => window.__held.some((h) => h.text.startsWith(t)), oldOne), `[${tag}] 준비: 옛 1번 요청이 아직 붙들려 있다(새 요청보다 늦다)`)
  // ★옛 요청을 먼저 푼다.
  await release(page, oldOne, okResp)
  await page.waitForTimeout(400)
  const mid = await page.evaluate(() => ({ state: window.__r.wait, fault: window.__r.fault, played: window.__played.slice() }))
  ok(!mid.played.some((f) => f === 'F:' + oldOne), `★[${tag}] 옛 글로 만든 소리를 새 자리에서 틀지 않는다`, mid.played)
  ok(!mid.fault, `★[${tag}] 옛 요청의 결과로 새 자리를 실패로 만들지 않는다`, mid.fault)
  // 새 요청을 풀면 새 글의 소리가 실제로 시작된다.
  await release(page, newOne)
  await page.waitForFunction((f) => window.__played.includes(f), 'F:' + newOne, { timeout: 5000 }).catch(() => {})
  ok(await page.evaluate((f) => window.__played.includes(f), 'F:' + newOne), `[${tag}] 새 요청을 풀면 새 글의 소리가 시작된다`)
  ok(errors.length === 0, `[${tag}] 런타임 오류 없음`, errors)
  await page.close()
}

try {
  await scenario(true)
  await scenario(false)
} catch (e) {
  fails.push('예외: ' + String(e?.message || e).split('\n')[0]); console.log('FAIL 예외', String(e?.message || e).split('\n')[0])
} finally {
  await browser.close()
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
