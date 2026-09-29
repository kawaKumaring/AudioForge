// 낭독 엔진 — **개발 모드(StrictMode)에서도** 처음부터 끝까지 읽는가.
//
// ★왜 생겼나 (2026-09-29 사용자 신고)
//   "낭독에서 목소리를 선택하면 적용이 되지 않고 텍스트도 첫 줄만을 읽고 꺼진다."
//   개발 실행은 StrictMode 라 React 가 화면을 붙였다 떼었다 다시 붙인다. 엔진은 뗄 때
//   '살아 있음' 을 끄고 다시 켜지 않아서 **만든 소리를 받아도 전부 버렸다.**
//   재현: 같은 글(덩이 8개)로 StrictMode 밖 재생 8회 · 안 재생 0회.
//   앱 검사(`reader-aloud.e2e.mjs`)는 배포 빌드로만 돌아 이것을 보지 못했다 —
//   그래서 여기서는 **React 개발판 + StrictMode** 로 엔진을 직접 돌린다.
//
// 여기서 보는 것
//   1) StrictMode 안에서 처음부터 끝까지 읽고, 끝에서 멈춘다(처음으로 돌아가지 않는다)
//   2) 목소리를 바꾸면 **곧바로** 옛 소리가 멎고, 지금 자리를 새 목소리로 다시 읽는다
//   3) 기본 목소리는 누르기 전에 미리 만들어 둔다 — 참조 목소리는 누를 때만 만든다
//
// 실행: node test/e2e/reader-aloud.component.mjs   (빌드 불필요 · GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

// 엔진만 띄운다. 목소리는 화면 밖에서 바꿀 수 있게 상태로 둔다.
const out = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import { useReadAloud } from './src/renderer/hooks/useReadAloud';
function H(){
  const [pick, setPick] = React.useState(window.__pick);
  window.__setPick = setPick;
  const r = useReadAloud(window.__text, pick);
  window.__r = r;
  return null
}
createRoot(document.getElementById('root')).render(window.__strict ? <React.StrictMode><H/></React.StrictMode> : <H/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },     // ★개발판 React — StrictMode 가 실제로 두 번 붙인다
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

// 덩이가 여럿 나오게 — 제품이 쓰는 나누기 규칙 그대로(목표 크기를 줄이지 않는다).
const S = '그는 천천히 문을 열고 어두운 복도를 조용히 내다보았다.'
const TEXT = Array.from({ length: 6 }, () => Array(5).fill(S).join(' ')).join('\n\n')

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })

/** 엔진 하나를 띄운다. 합성은 가짜 — 목소리 이름이 든 자리를 돌려준다. */
async function open({ strict, seconds, pick }) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.evaluate(({ url, text, strict, pick }) => {
    window.__text = text
    window.__strict = strict
    window.__pick = pick
    window.__speaks = []            // [목소리 이름, 글 앞 10자]
    window.__played = []            // 재생을 시작한 자리
    window.__pauses = 0
    const P = HTMLMediaElement.prototype, play = P.play, pause = P.pause
    P.play = function () { window.__played.push(window.__lastUrlFor); return play.call(this) }
    P.pause = function () { window.__pauses++; return pause.call(this) }
    const base = {
      reader: {
        speak: async (t, v) => {
          // ★엔진은 이름표 없이 **경로**로 목소리를 넘긴다 — 경로로 구분한다.
          const who = String(v.path).split('.')[0].toUpperCase()
          window.__speaks.push([who, String(t).slice(0, 10)])
          const n = window.__speaks.length
          await new Promise((r) => setTimeout(r, 30))
          return { data: { path: who + '-' + n + '.wav', cached: false } }
        },
      },
      audio: { getFileUrl: async (p) => { window.__lastUrlFor = p; return url } },
    }
    const any = () => new Proxy(() => {}, { get: () => any(), apply: () => Promise.resolve({}) })
    window.api = new Proxy(base, { get: (t, k) => (k in t ? t[k] : any()) })
  }, { url: wavUrl(seconds), text: TEXT, strict, pick })
  await page.addScriptTag({ content: code })
  await page.waitForFunction(() => !!window.__r)
  return { page, errors }
}

const A = { kind: 'builtin', path: 'a.onnx', engineId: 'piper', label: 'A' }
const B = { kind: 'builtin', path: 'b.onnx', engineId: 'piper', label: 'B' }
const REF = { kind: 'reference', path: 'ref.wav', label: 'R' }

try {
  // ── 1. StrictMode 안에서 처음부터 끝까지 ──────────────────────────────
  for (const strict of [true, false]) {
    const tag = strict ? 'StrictMode' : '배포와 같은 조건'
    const { page, errors } = await open({ strict, seconds: 0.3, pick: A })
    const count = await page.evaluate(() => window.__r.chunks.length)
    await page.evaluate(() => window.__r.start())
    const done = await page.waitForFunction((n) => window.__played.length >= n && !window.__r.playing,
      count, { timeout: 20000 }).then(() => true).catch(() => false)
    const got = await page.evaluate(() => ({ at: window.__r.at, played: window.__played.length, wait: window.__r.wait }))
    ok(count >= 5, `[${tag}] 글이 여러 덩이로 나뉜다`, count)
    ok(done && got.played === count, `★[${tag}] 처음부터 끝까지 읽는다 (${got.played}/${count})`, got)
    ok(got.at === count - 1, `[${tag}] 끝에서 멈춘다 — 처음으로 돌아가지 않는다`, got)
    ok(errors.length === 0, `[${tag}] 화면 오류가 없다`, errors)
    await page.close()
  }

  // ── 2. 목소리를 바꾸면 곧바로 적용된다 ────────────────────────────────
  {
    const { page } = await open({ strict: true, seconds: 3, pick: A })
    await page.evaluate(() => window.__r.start())
    await page.waitForFunction(() => window.__played.length >= 1, null, { timeout: 10000 })
    const before = await page.evaluate(() => ({ pauses: window.__pauses, at: window.__r.at }))
    await page.evaluate((b) => window.__setPick(b), B)
    // 옛 목소리 덩이(3초)가 끝나기 **훨씬 전에** 새 목소리가 들려야 한다.
    const switched = await page.waitForFunction(() => String(window.__played.at(-1) || '').startsWith('B-'),
      null, { timeout: 1500 }).then(() => true).catch(() => false)
    const after = await page.evaluate(() => ({
      pauses: window.__pauses, at: window.__r.at, last: window.__played.at(-1),
      madeWithB: window.__speaks.filter((s) => s[0] === 'B').length,
    }))
    ok(after.pauses > before.pauses, '★목소리를 바꾸면 옛 목소리 소리가 곧바로 멎는다', { before, after })
    ok(switched, '★같은 자리를 새 목소리로 다시 읽는다 — 덩이가 끝나기를 기다리지 않는다', after)
    ok(after.at === before.at, '듣던 자리를 잃지 않는다', { before, after })
    await page.close()
  }

  // ── 3. 누르기 전에 미리 만들어 둔다 ───────────────────────────────────
  {
    const { page } = await open({ strict: true, seconds: 0.3, pick: A })
    const made = await page.waitForFunction(() => window.__speaks.length >= 3, null, { timeout: 5000 })
      .then(() => true).catch(() => false)
    const got = await page.evaluate(() => ({ speaks: window.__speaks.length, played: window.__played.length }))
    ok(made && got.speaks === 3, '★기본 목소리는 누르기 전에 앞 덩이를 만들어 둔다 — 지금 자리 + 둘', got)
    ok(got.played === 0, '누르기 전에는 소리를 내지 않는다', got)
    const t0 = Date.now()
    await page.evaluate(() => window.__r.start())
    await page.waitForFunction(() => window.__played.length >= 1, null, { timeout: 5000 })
    ok(Date.now() - t0 < 500, `누르면 곧바로 들린다 (${Date.now() - t0}ms)`)
    await page.close()
  }
  {
    const { page } = await open({ strict: true, seconds: 0.3, pick: REF })
    await page.waitForTimeout(800)
    const speaks = await page.evaluate(() => window.__speaks.length)
    ok(speaks === 0, '참조 목소리는 누르기 전에 만들지 않는다 — GPU 로 수십 초가 든다', speaks)
    await page.close()
  }
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await browser.close().catch(() => {})
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
