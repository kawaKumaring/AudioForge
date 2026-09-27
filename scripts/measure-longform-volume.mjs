// 장문이 길어질수록 목소리가 작아지는가 — **실제 앱이 만든 파일을 잰다.**
//
// ★왜 (2026-09-28 사용자 신고)
// > "현제 파악한 문제로는 장문이 될수록 목소리가 작아지는걸 확인한적이있다."
//
//   귀로 들은 증상이다. 고치려면 **어디서 얼마나** 작아지는지 숫자가 있어야 한다.
//   추측으로 손대면 멀쩡한 자리를 건드린다.
//
// 재는 것 두 가지
//   (가) 글이 길어질수록 **전체가** 작아지는가  — 파일마다 전체 RMS
//   (나) 한 파일 **안에서** 뒤로 갈수록 작아지는가 — 앞 1/4 대비 뒤 1/4
//
// ★사용자 미디어를 쓰지 않는다. 앱에 설치된 기본 목소리로만 만든다.
//   재는 대상은 **우리가 방금 만든 파일**이다.
//
// 실행: node scripts/measure-longform-volume.mjs    (사전: npm run build)
import '../test/_temp-root.mjs'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from '../test/e2e/_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요: npm run build'); process.exit(2)
}

// 한 토막 = 약 60자. 이어 붙여 길이를 늘린다 — **같은 말투**라야 길이만 비교된다.
const PIECE = [
  '오늘 회의에서 정한 것을 다시 한 번 정리해서 말씀드리겠습니다. ',
  '먼저 일정은 다음 주 화요일까지로 미루기로 했고 담당자는 그대로 둡니다. ',
  '두 번째로 예산은 처음 계획보다 조금 줄이되 품질은 낮추지 않기로 했습니다. ',
  '세 번째는 결과를 매주 금요일에 짧게 공유하자는 이야기가 있었습니다. ',
  '마지막으로 궁금한 점이 있으면 언제든 편하게 물어봐 주시면 좋겠습니다. ',
]
// 토막 수. 사용자가 말한 300자를 **넘겨서**까지 본다 — 증상이 어디서 나타나는지 보려고.
const LENGTHS = [1, 3, 5, 8, 12, 16]

/** WAV(PCM16 모노/스테레오)를 읽어 표본으로. 우리가 만든 파일만 연다. */
function readWav(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('RIFF 아님')
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('fmt/data 없음')
  if (fmt.bits !== 16) throw new Error(`16비트가 아니다(${fmt.bits})`)
  const n = Math.floor(data.length / 2 / fmt.channels)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2) / 32768
    out[i] = sum / fmt.channels
  }
  return { samples: out, rate: fmt.rate, seconds: n / fmt.rate }
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m }
const dB = (x) => (x <= 0 ? -99 : 20 * Math.log10(x))

/** 소리가 있는 구간만 본다 — 앞뒤 정적이 평균을 끌어내리면 길이 탓이 아니게 된다. */
function voiced(a, rate) {
  const win = Math.max(1, Math.round(rate * 0.02))       // 20ms
  const floor = peak(a) * 0.02                           // 최대의 2% 미만은 정적으로 본다
  const keep = []
  for (let i = 0; i + win <= a.length; i += win) {
    if (rms(a, i, i + win) > floor) keep.push(i)
  }
  return { windows: keep, win }
}

const UD = isolatedUserData()
let app = null
const rows = []
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)

  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) { console.log('건너뜀 — 쓸 수 있는 기본 목소리가 없습니다.'); process.exit(0) }
  console.log('목소리:', voices[0].label, `(${voices[0].language})`)

  await win.getByTestId('mode-tts').click()
  for (const pieces of LENGTHS) {
    // 토막을 돌려 쓴다 — 같은 말투로 길이만 늘린다.
    const text = Array.from({ length: pieces }, (_, i) => PIECE[i % PIECE.length]).join('')
    await win.getByTestId('add-generation-card').click()
    await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
    await win.getByTestId('pick-voice-builtin').first().click()
    await win.getByTestId('generation-card').first().waitFor()
    await win.getByTestId('card-script').first().fill(text)
    await win.waitForTimeout(300)
    await win.getByTestId('card-generate').first().click()
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 300000 })
      .catch(() => {})
    const made = await win.evaluate(() => {
      const c = window.__synthesisCards.getState().cards[0]
      return c.takes[c.takes.length - 1]?.path ?? null
    })
    if (!made || !fs.existsSync(made)) { console.log(`${text.length}자 — 만들지 못했다`); continue }

    const { samples, rate, seconds } = readWav(made)
    const { windows, win: w } = voiced(samples, rate)
    const all = rms(samples)
    const voicedRms = windows.length
      ? Math.sqrt(windows.reduce((s, i) => s + rms(samples, i, i + w) ** 2, 0) / windows.length) : 0
    // 앞 1/4 과 뒤 1/4 — **소리 있는 구간만** 비교한다.
    const avg = (ws) => (ws.length
      ? Math.sqrt(ws.reduce((s, i) => s + rms(samples, i, i + w) ** 2, 0) / ws.length) : 0)
    const q = Math.max(1, Math.floor(windows.length / 4))
    const headWins = windows.slice(0, q)
    const tailWins = windows.slice(-q)
    // 4분면별 — 뒤로 갈수록 내려가는지 **줄 세워** 본다(앞뒤 두 점만 보면 요동에 속는다).
    const quarters = [0, 1, 2, 3].map((k) => {
      const ws = windows.slice(Math.floor(windows.length * k / 4), Math.floor(windows.length * (k + 1) / 4))
      return +dB(avg(ws)).toFixed(1)
    })
    rows.push({
      quarters,
      chars: text.length, seconds: +seconds.toFixed(2),
      peak: +dB(peak(samples)).toFixed(2),
      rmsAll: +dB(all).toFixed(2),
      rmsVoiced: +dB(voicedRms).toFixed(2),
      head: +dB(avg(headWins)).toFixed(2),
      tail: +dB(avg(tailWins)).toFixed(2),
      drop: +(dB(avg(tailWins)) - dB(avg(headWins))).toFixed(2),
      file: made,
    })
    // 다음 길이는 새 카드로 — 카드를 지우고 다시 만든다.
    await win.evaluate(() => window.__synthesisCards.getState().removeCard?.(
      window.__synthesisCards.getState().cards[0].id))
    await win.waitForTimeout(400)
  }
} catch (e) {
  console.error('실패:', e?.message || e)
} finally {
  await app?.close().catch(() => {})
}

console.log('')
console.log('글자수  길이(초)  최대(dB)  발화RMS   뒤-앞    4분면별 발화 크기(dB)')
for (const r of rows) {
  console.log(
    String(r.chars).padStart(5),
    String(r.seconds).padStart(9),
    String(r.peak).padStart(9),
    String(r.rmsVoiced).padStart(8),
    String(r.drop).padStart(8),
    '   ' + r.quarters.map((x) => String(x).padStart(6)).join(' '),
  )
}
console.log('')
if (rows.length >= 2) {
  const first = rows[0], last = rows[rows.length - 1]
  console.log(`글이 길어질 때 발화 크기 변화: ${(last.rmsVoiced - first.rmsVoiced).toFixed(2)} dB`
    + `  (${first.chars}자 → ${last.chars}자)`)
  console.log(`한 파일 안에서 뒤로 갈수록: ${rows.map((r) => `${r.chars}자 ${r.drop}dB`).join(' · ')}`)
  console.log('')
  console.log('읽는 법 — -1 dB 이하면 귀로는 거의 같다. -3 dB 면 체감상 눈에 띄게 작다.')
}
// 만든 파일은 남긴다 — 들어 보려면 필요하다. 자리는 위에 적혀 있다.
cleanupUserData(UD)
