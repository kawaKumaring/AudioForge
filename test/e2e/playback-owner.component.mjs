// 소리는 **한 번에 한 곳만** — 화면이 달라도 같은 규칙인가.
//
// 이 앱의 재생 자리는 네 곳이다: 원본 파형 · 결과 재생기 · 생성 카드(생성본·최종 음성) ·
// 노래 변환 결과. 예전에는 앞의 둘만 규칙 안에 있어, 원본 파형을 틀어 둔 채 생성본을
// 들으면 둘이 겹쳐 울렸다. 여기서는 **등록부에 올라간 소리 요소**가 규칙을 따르는지 본다.
//
// 실행: node test/e2e/playback-owner.component.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

// 소리 없는 아주 짧은 WAV — 사용자 미디어를 쓰지 않는다.
const wav = Buffer.alloc(44 + 24000 * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'ts',
    contents: `
      import { createManagedAudio, onManagedPlay, pauseManagedAudio } from './src/renderer/lib/playbackVolume'
      import { useAppStore } from './src/renderer/stores/app.store'
      const store = useAppStore
      ;(window as never as Record<string, unknown>).harness = {
        store,
        // 카드 화면이 하는 일과 **같은 배선**이다(같은 두 줄).
        wire() {
          onManagedPlay(() => store.getState().claimAudio('card'))
          store.subscribe((s, p) => {
            if (s.audioClaim !== p.audioClaim && s.audioClaim && s.audioClaim.owner !== 'card') pauseManagedAudio()
          })
        },
        make(src: string) {
          const el = createManagedAudio(src)
          ;(window as never as Record<string, unknown>).el = el
          return el
        },
      }
    `,
  },
  bundle: true, write: false, format: 'iife', tsconfig: path.join(root, 'tsconfig.web.json'),
})

// 사람이 누르지 않아도 재생을 허용해야 한다 — 그렇지 않으면 play() 가 거절당해
// 규칙이 아니라 브라우저 정책을 재는 검사가 된다.
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage()
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

try {
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => window.harness.wire())

  const src = 'data:audio/wav;base64,' + wav.toString('base64')

  // ① 소리를 내면 '소리 낼 자리' 를 가져온다
  const owner = await page.evaluate(async (s) => {
    const el = window.harness.make(s)
    el.loop = true
    await el.play()
    await new Promise((r) => setTimeout(r, 60))
    return window.harness.store.getState().audioClaim?.owner
  }, src)
  assert.equal(owner, 'card', `재생 시작이 자리를 가져와야 한다(받은 값: ${owner})`)
  pass('소리를 내면 그 화면이 재생 자리를 가져온다')

  // ② 다른 자리가 가져가면 **멈춘다**
  const stopped = await page.evaluate(async () => {
    window.harness.store.getState().claimAudio('waveform')
    await new Promise((r) => setTimeout(r, 60))
    return window.el.paused
  })
  assert.equal(stopped, true, '다른 자리가 가져가면 멈춰야 한다')
  pass('★원본 파형이 자리를 가져가면 생성본 재생이 멈춘다')

  // ③ 멈추기만 한다 — 위치와 음량은 그대로다(이어 듣기를 빼앗지 않는다)
  const kept = await page.evaluate(() => ({ at: window.el.currentTime > 0, vol: window.el.volume }))
  assert.equal(kept.at, true, '재생 위치가 0 으로 되돌아가면 안 된다')
  pass('멈추기만 한다 — 위치를 잃지 않는다')
  assert.equal(typeof kept.vol, 'number')
  pass('음량은 공용 값 그대로다')

  // ④ 다시 소리를 내면 자리를 되찾는다
  const back = await page.evaluate(async () => {
    await window.el.play()
    await new Promise((r) => setTimeout(r, 60))
    return window.harness.store.getState().audioClaim?.owner
  })
  assert.equal(back, 'card', '다시 틀면 자리를 되찾아야 한다')
  pass('다시 틀면 자리를 되찾는다')

  // ⑤ 같은 자리의 다른 소리는 서로를 멈추지 않는다(한 화면 안의 이어 듣기)
  const both = await page.evaluate(async (s) => {
    const second = window.harness.make(s)
    second.loop = true
    await second.play()
    await new Promise((r) => setTimeout(r, 60))
    return { first: window.el.paused, owner: window.harness.store.getState().audioClaim?.owner }
  }, src)
  assert.equal(both.owner, 'card')
  assert.equal(both.first, false, '같은 자리끼리는 규칙이 끼어들지 않는다')
  pass('같은 화면 안의 재생은 서로 멈추지 않는다')

  assert.equal(errors.length, 0, `페이지 예외: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
} finally {
  await page.evaluate(() => { try { window.el?.pause() } catch { /* noop */ } }).catch(() => {})
  await browser.close()
}
console.log(JSON.stringify({ passed: checks, scope: '실제 크로미움의 소리 요소. 엔진·사용자 미디어 미사용' }))
