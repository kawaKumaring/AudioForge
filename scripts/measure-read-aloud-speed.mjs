// 실시간 낭독이 되는가 — **만드는 속도가 읽는 속도보다 빠른가.**
//
// ★왜 (2026-09-29 질문): "실시간으로 소설을 낭독해주는 기능을 구현할수있는가"
//
//   답은 숫자 하나에 달려 있다.
//     실시간 배수 = 만들어진 소리 길이 ÷ 만드는 데 걸린 시간
//   이 값이 1보다 크면 읽는 속도를 앞지른다 — 앞 문장을 듣는 동안 뒤 문장이 준비된다.
//   1보다 작으면 아무리 잘 만들어도 중간에 끊긴다.
//
//   그리고 하나 더 — **첫 소리까지 얼마나 기다리는가.** 배수가 높아도 첫 문장을
//   30초 기다려야 하면 낭독으로 쓸 수 없다.
//
// 재는 것
//   1) 문장 하나(짧은 글)를 만드는 데 걸리는 시간 → 첫 소리까지의 지연
//   2) 글이 길어질 때 배수가 유지되는가
//
// ★사용자 미디어를 쓰지 않는다. 앱에 설치된 기본 목소리로만 만든다.
//
// 실행: node scripts/measure-read-aloud-speed.mjs   (사전: npm run build)
import '../test/_temp-root.mjs'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from '../test/e2e/_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

// 소설 낭독에 가까운 문장들. 짧은 것부터 — 첫 소리 지연을 보려고.
const CASES = [
  '그는 문을 열었다.',
  '그는 천천히 문을 열고 어두운 복도를 내다보았다. 아무 소리도 나지 않았다.',
  '그는 천천히 문을 열고 어두운 복도를 내다보았다. 아무 소리도 나지 않았다. '
  + '멀리서 물이 떨어지는 소리만 일정한 간격으로 이어졌고, 그 소리는 오래된 집이 '
  + '아직 숨을 쉬고 있다는 증거처럼 들렸다.',
  '그는 천천히 문을 열고 어두운 복도를 내다보았다. 아무 소리도 나지 않았다. '
  + '멀리서 물이 떨어지는 소리만 일정한 간격으로 이어졌고, 그 소리는 오래된 집이 '
  + '아직 숨을 쉬고 있다는 증거처럼 들렸다. 그는 한 걸음을 내디뎠다가 곧 멈췄다. '
  + '발밑의 마루가 낮게 울었고, 그 울림이 복도 끝까지 퍼져 나가는 것을 느꼈다. '
  + '누군가 이 소리를 들었다면 이미 알아차렸을 것이다.',
]

const wavSeconds = (file) => {
  const buf = fs.readFileSync(file)
  let pos = 12, rate = 0, ch = 1, bits = 16, bytes = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') { ch = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22) }
    else if (id === 'data') bytes = Math.min(size, buf.length - pos - 8)
    pos += 8 + size + (size % 2)
  }
  return rate ? bytes / (rate * ch * (bits / 8)) : 0
}

// ★참조 목소리도 잰다. 쓰는 음원은 **저장소의 검사용 음원**이다 —
//   사용자 음성이 아니므로 별도 승인 없이 속도만 볼 수 있다.
const FIXTURE = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const WITH_REF = process.argv.includes('--ref') && fs.existsSync(FIXTURE)

const UD = isolatedUserData()
const rows = []
let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: {
      ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD,
      AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1',
      ...(WITH_REF ? { AF_E2E_SELECT_FILE: FIXTURE } : {}),
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)

  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) { console.log('건너뜀 — 쓸 수 있는 기본 목소리가 없습니다.'); process.exit(0) }
  console.log('목소리:', voices[0].label)
  console.log('')

  await win.getByTestId('mode-tts').click()
  await win.getByTestId('add-generation-card').click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  if (WITH_REF) {
    console.log('참조 목소리(검사용 음원)로 잰다')
    await win.getByTestId('pick-voice-file').click()
    await win.getByTestId('generation-card').first().waitFor({ timeout: 120000 })
    process.stdout.write('  준비 기다리는 중 ')
    for (let t = 0; t < 60; t++) {
      if (await win.getByTestId('card-generate').first().isEnabled().catch(() => false)) break
      if (t % 6 === 5) process.stdout.write(`[${(t + 1) * 10}초] `)
      await win.waitForTimeout(10000)
    }
    console.log('끝')
  } else {
    await win.getByTestId('pick-voice-builtin').first().click()
    await win.getByTestId('generation-card').first().waitFor()
  }

  for (const [i, text] of CASES.entries()) {
    await win.getByTestId('card-script').first().fill(text)
    await win.waitForTimeout(300)
    const before = await win.evaluate(() => window.__synthesisCards.getState().cards[0].takes.length)
    const t0 = Date.now()
    await win.getByTestId('card-generate').first().click()
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 300000 }).catch(() => {})
    const took = (Date.now() - t0) / 1000
    const got = await win.evaluate((n) => {
      const c = window.__synthesisCards.getState().cards[0]
      return c.takes.length > n ? c.takes[c.takes.length - 1].path : null
    }, before)
    if (!got || !fs.existsSync(got)) { console.log(`  ${text.length}자 — 만들지 못했다`); continue }
    const sec = wavSeconds(got)
    rows.push({ chars: text.length, sec, took, x: sec / took })
    console.log(`  ${String(text.length).padStart(4)}자 → 소리 ${sec.toFixed(1)}초 · 만드는 데 ${took.toFixed(1)}초`
      + ` · 실시간 배수 ${(sec / took).toFixed(2)}`)
    void i
  }
} catch (e) {
  console.error('실패:', e?.message || e)
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}

console.log('')
console.log('── 판정 ──────────────────────────────────────────────')
if (rows.length < 2) { console.log('  잰 것이 모자라다.'); process.exit(0) }

// 만드는 시간 = 고정비 + 소리길이 × 비례비 (최소제곱)
const n = rows.length
const sx = rows.reduce((s, r) => s + r.sec, 0)
const sy = rows.reduce((s, r) => s + r.took, 0)
const sxx = rows.reduce((s, r) => s + r.sec * r.sec, 0)
const sxy = rows.reduce((s, r) => s + r.sec * r.took, 0)
const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
const fixed = (sy - slope * sx) / n

console.log(`  만드는 시간 = ${fixed.toFixed(2)}초(고정) + ${slope.toFixed(4)} × 소리길이`)
console.log(`  ★고정비를 뺀 실질 속도: ${slope > 0 ? (1 / slope).toFixed(0) : '?'}배 실시간`)
console.log(`  ★한 번 부를 때마다 ${fixed.toFixed(1)}초를 버린다 — 문단을 잘게 쪼갤수록 손해다`)
console.log('')
console.log('  문단 크기별 — 낭독이 끊기지 않으려면 배수가 1보다 커야 한다')
for (const c of [5, 10, 20, 30, 60]) {
  const t = fixed + slope * c
  console.log(`    ${String(c).padStart(2)}초 분량 → ${t.toFixed(1)}초에 만든다 · 배수 ${(c / t).toFixed(1)}`)
}
console.log('')
const at20 = 20 / (fixed + slope * 20)
if (at20 > 2) {
  console.log('  → **된다.** 20초 분량 문단이면 여유가 충분하다.')
  console.log(`     첫 소리까지 ${fixed.toFixed(1)}초 기다리고, 그 뒤로는 앞서 만들어 두면 끊기지 않는다.`)
} else if (at20 > 1) {
  console.log('  → 겨우 된다. 앞서 만들어 두는 여유분을 크게 잡아야 한다.')
} else {
  console.log('  → 이 경로로는 실시간 낭독이 안 된다. 미리 만들어 두는 방식만 가능하다.')
}
