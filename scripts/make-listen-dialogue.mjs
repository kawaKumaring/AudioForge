// 다섯 사람이 대화하듯 — **들어 보기 위한 음원을 만든다.**
//
// ★지시 (2026-09-28)
// > "음성파일들을 5개이용하여 서로 대화를 하는거처럼 제작을 진행해보고 파일을 생성한뒤
// >  다음으로 작업을 넘어간다. 청취는 모든 작업이 끝나고 해도 늦지않다."
// > "대사는 300자정도의 장문으로 테스트한다."
// > "장문이 될수록 목소리가 작아지는걸 확인한적이있다."
//
// ★참조 목소리는 **사용자 음성**이다. 이번 작업에 한해 사용 승인을 받았다.
//   경로를 합성 엔진에 건네는 것 외에 열지·분석하지·복사하지 않는다.
//   보고에는 사람 이름 대신 A~E 로만 적는다.
//
// 만든 뒤 **길이·크기·음량**을 재서 장문 증상을 함께 본다. 듣기는 나중이다.
//
// 실행: node scripts/make-listen-dialogue.mjs    (사전: npm run build · GPU 사용)
import '../test/_temp-root.mjs'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from '../test/e2e/_e2e-helper.mjs'
import { OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS, dayFolder } from '../src/shared/outputLayout.ts'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

// 참조 목소리가 사는 자리 — 인물 폴더마다 한 개.
const VOICE_ROOT = path.resolve(APP, '..', '..', '..', 'master', 'AudioForge',
  '사용자', '작업파일', 'AudioForge_output')

/** 인물 폴더에서 참조 음원 하나씩. 이름은 밖으로 내지 않는다(A~E 로만 부른다). */
function referenceVoices(limit = 5) {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(VOICE_ROOT).sort() } catch { return out }
  for (const d of dirs) {
    const full = path.join(VOICE_ROOT, d)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (!st.isDirectory()) continue
    const wav = (() => {
      try { return fs.readdirSync(full).find((f) => /\.wav$/i.test(f)) } catch { return null }
    })()
    if (!wav) continue
    out.push({ label: String.fromCharCode(65 + out.length), path: path.join(full, wav) })
    if (out.length >= limit) break
  }
  return out
}

// ── 대사 — 다섯 사람이 한 가지 일을 두고 주고받는다. 각 300자 안팎 ──────────
const SCRIPT = [
  '제가 먼저 정리해 볼게요. 지난주에 올린 판이 사용자 쪽에서 문제가 있다고 들어와서, 저희가 어디서부터 어긋났는지 되짚어 봤습니다. '
  + '처음에는 화면 쪽 문제로 보였는데 기록을 하나씩 따라가 보니 그게 아니라 파일을 어디에 쌓느냐가 원인이었어요. '
  + '누구도 그 자리를 고른 적이 없는데 기능을 붙일 때마다 조용히 그쪽으로 흘러가고 있었던 겁니다. 그래서 자리부터 다시 잡기로 했습니다. 자리를 정하는 일은 한 번 해 두면 다시 건드릴 일이 없으니, 이번에 확실히 매듭짓고 넘어가는 게 좋겠습니다. 저는 그렇게 진행하겠습니다.',

  '그 이야기를 들으니 이제 앞뒤가 맞네요. 저는 계속 화면이 느린 게 이상하다고 생각했는데, 쌓이는 자리가 다르면 읽는 속도도 달라지니까요. '
  + '다만 한 가지 걱정되는 건 이미 만들어 둔 것들이에요. 자리를 옮기면 예전에 만든 결과를 못 찾게 되는 건 아닌지, 그게 제일 마음에 걸립니다. '
  + '옮기더라도 옛 자리를 계속 읽을 수 있게 남겨 두면 좋겠어요. 사용자는 그런 걸 미리 백업해 두지 않으니까요. 그리고 옮기고 나면 어디에 쌓이는지 화면에 적어 두면 좋겠어요. 보이지 않으면 또 같은 일이 생길 테니까요. 그 한 줄이 생각보다 큰 차이를 만듭니다.',

  '저도 같은 생각이에요. 그리고 하나 더 있는데, 지우는 기능을 만들 때 무엇이 사라지고 무엇이 남는지 먼저 말해 줘야 합니다. '
  + '예전에 기록을 비웠더니 만들어 둔 소리 파일까지 같이 없어진 줄 알고 한참을 찾은 적이 있었거든요. 실제로는 남아 있었는데 화면이 아무 말도 안 해 줬어요. '
  + '한 줄이면 되는 일입니다. 지우기 전에 무엇이 남는지 적어 두기만 해도 그런 일은 다시 안 생길 거예요. 무엇이 남는지 미리 말해 주는 것만으로도 사람은 안심하고 단추를 누를 수 있습니다. 반대로 말이 없으면 아무리 안전해도 손이 안 나가요.',

  '좋습니다. 그러면 순서를 정하죠. 먼저 자리를 바로잡고, 그다음에 지우기 안내를 손보고, 마지막으로 기록을 파일마다 나누는 걸로 하면 어떨까요. '
  + '기록이 한 파일에 몰려 있어서 하나를 지우려 해도 전체를 건드려야 하는 지금 구조가 사실 모든 문제의 뿌리 같습니다. '
  + '다만 그건 손이 많이 가니까 앞의 두 가지를 먼저 끝내고 나서 시간을 충분히 두고 하는 게 안전하겠어요. 순서를 지키면 중간에 문제가 생겨도 어디까지 됐는지 알 수 있으니, 되돌리기도 훨씬 쉬워집니다. 급하게 몰아서 하는 것보다 그게 결국 빠릅니다.',

  '정리해 주셔서 고맙습니다. 저는 마지막으로 확인하는 방법을 이야기하고 싶어요. 지금까지는 파일이 만들어졌는지만 보고 잘 됐다고 했는데, '
  + '그건 만들어졌다는 증거일 뿐이지 제대로 들린다는 증거는 아니잖아요. 실제로 한 번도 귀로 들어 본 적이 없다는 게 저는 좀 놀랍습니다. '
  + '그러니 이번에는 다섯 사람 목소리로 긴 대사를 만들어 두고, 작업이 끝나면 다 같이 앉아서 처음부터 끝까지 들어 봤으면 합니다. 다 만들어 두고 한꺼번에 듣는 게 좋겠어요. 중간에 하나씩 들으면 기준이 흔들려서, 나중에 무엇이 나아졌는지 비교하기가 어려워집니다.',
]

const readWav = (file) => {
  const buf = fs.readFileSync(file)
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) }
    else if (id === 'data') data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length))
    pos += 8 + size + (size % 2)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  const n = Math.floor(data.length / 2 / fmt.channels)
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2) / 32768
    a[i] = s / fmt.channels
  }
  return { samples: a, rate: fmt.rate, seconds: n / fmt.rate }
}
const rmsOf = (a, from = 0, to = a.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
const peakOf = (a) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m }
const dB = (x) => (x <= 0 ? -99 : 20 * Math.log10(x))

const voices = referenceVoices(5)
if (voices.length < 5) {
  console.error(`참조 목소리가 ${voices.length}개뿐입니다 — 5명 대화를 만들 수 없습니다.`)
  process.exit(2)
}
console.log('참조 목소리 —', voices.map((v) => v.label).join(', '), `(${voices.length}명)`)
console.log('대사 길이 —', SCRIPT.map((t) => t.length + '자').join(' · '))
console.log('')

const UD = isolatedUserData()
const made = []
let app = null
try {
  // ★다섯 경로를 **한 번에** 건넨다.
  //   새 카드를 만드는 길은 `selectFile(multi=true)` 로 부른다 — 그때 앱의 검사 통로는
  //   하나씩 무장하는 값이 아니라 **이 환경 변수 목록**을 본다(실측으로 확인).
  //   목록을 주면 카드가 사람 수만큼 한 번에 생긴다.
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: {
      ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD,
      AF_E2E_SELECT_FILE: voices.map((v) => v.path).join('|'),
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)
  await win.getByTestId('mode-tts').click()

  await win.getByTestId('add-generation-card').click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  await win.getByTestId('pick-voice-file').click()
  await win.getByTestId('generation-card').first().waitFor({ timeout: 120000 })
  await win.waitForTimeout(1500)

  const cardCount = await win.getByTestId('generation-card').count()
  console.log(`카드 ${cardCount}장이 생겼다 (참조 ${voices.length}명)`)
  if (cardCount < voices.length) {
    console.log('★사람 수만큼 생기지 않았다 — 나온 만큼만 만든다.')
  }

  // 대사를 카드마다 넣는다. 카드 순서는 건넨 경로 순서를 따른다.
  for (let k = 0; k < Math.min(cardCount, SCRIPT.length); k++) {
    await win.getByTestId('card-script').nth(k).fill(SCRIPT[k])
  }
  await win.waitForTimeout(800)

  // ★**모든** 카드의 준비가 끝날 때까지 기다린다.
  //   본체는 파이썬을 하나만 돌린다 — 남의 준비가 도는 동안 생성을 누르면 거절당한다
  //   (2026-09-28 실측: 다섯 중 넷이 그렇게 튕겼다).
  process.stdout.write('  준비 기다리는 중 ')
  for (let t = 0; t < 90; t++) {
    const st = await win.evaluate(() => {
      const s2 = window.__synthesisCards.getState()
      const r = Object.values(s2.refs)
      return {
        preparing: r.filter((x) => x && x.phase === 'preparing').length,
        ready: r.filter((x) => x && x.phase === 'ready').length,
        other: r.filter((x) => x && x.phase !== 'preparing' && x.phase !== 'ready')
          .map((x) => x.phase + ':' + (x.message || '').slice(0, 40)),
      }
    })
    if (st.preparing === 0) { console.log(`끝 (준비됨 ${st.ready}${st.other.length ? ' · ' + st.other.join(' ') : ''})`); break }
    if (t % 6 === 5) process.stdout.write(`[${(t + 1) * 10}초 준비중 ${st.preparing}] `)
    await win.waitForTimeout(10000)
  }

  for (let k = 0; k < Math.min(cardCount, SCRIPT.length); k++) {
    const who = voices[k]
    const text = SCRIPT[k]
    const t0 = Date.now()
    process.stdout.write(`  ${who.label} — ${text.length}자 … `)

    const ready = await win.getByTestId('card-generate').nth(k).isEnabled().catch(() => false)
    if (!ready) {
      const why = await win.evaluate((i) =>
        document.querySelectorAll('[data-testid="card-generate"]')[i]?.title || '', k)
      console.log(`건너뜀 — ${why || '단추가 닫혀 있다'}`)
      continue
    }

    const before = await win.evaluate((i) => window.__synthesisCards.getState().cards[i].takes.length, k)
    await win.getByTestId('card-generate').nth(k).click()
    await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 1800000 })
      .catch(() => {})
    const got = await win.evaluate(([i, n]) => {
      const c = window.__synthesisCards.getState().cards[i]
      return {
        grew: c.takes.length > n,
        path: c.takes[c.takes.length - 1]?.path ?? null,
        말: [...document.querySelectorAll('[role="status"],[role="alert"]')]
          .map((e) => (e.textContent || '').trim()).filter(Boolean).join(' | '),
      }
    }, [k, before])
    const took = Math.round((Date.now() - t0) / 1000)
    if (!got.grew || !got.path || !fs.existsSync(got.path)) {
      console.log(`실패 (${took}초) — ${got.말 || '사유 없음'}`)
    } else {
      const w = readWav(got.path)
      const bytes = fs.statSync(got.path).size
      made.push({ who: who.label, chars: text.length, path: got.path, bytes, took, wav: w })
      console.log(`됨 (${took}초) · ${w ? w.seconds.toFixed(1) + '초' : '?'} · ${Math.round(bytes / 1024)}KB`)
    }
  }
} catch (e) {
  console.error('실패:', e?.message || e)
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}

console.log('')
console.log('── 만든 것 ──────────────────────────────────────────────')
if (!made.length) console.log('  하나도 만들지 못했습니다.')
console.log(' 사람  글자   길이(초)   걸린시간  최대(dB)  발화RMS   앞1/4    뒤1/4   뒤-앞')
for (const m of made) {
  if (!m.wav) { console.log(` ${m.who}  ${m.chars}  — 잴 수 없음`); continue }
  const { samples, rate } = m.wav
  const win20 = Math.max(1, Math.round(rate * 0.02))
  const floor = peakOf(samples) * 0.02
  const voiced = []
  for (let i = 0; i + win20 <= samples.length; i += win20) {
    if (rmsOf(samples, i, i + win20) > floor) voiced.push(i)
  }
  const avg = (ws) => (ws.length ? Math.sqrt(ws.reduce((s, i) => s + rmsOf(samples, i, i + win20) ** 2, 0) / ws.length) : 0)
  const q = Math.max(1, Math.floor(voiced.length / 4))
  const head = dB(avg(voiced.slice(0, q)))
  const tail = dB(avg(voiced.slice(-q)))
  console.log(
    ` ${m.who} ${String(m.chars).padStart(6)} ${m.wav.seconds.toFixed(1).padStart(9)}`
    + ` ${(m.took + '초').padStart(9)} ${dB(peakOf(samples)).toFixed(1).padStart(9)}`
    + ` ${dB(avg(voiced)).toFixed(1).padStart(8)} ${head.toFixed(1).padStart(8)}`
    + ` ${tail.toFixed(1).padStart(8)} ${(tail - head).toFixed(1).padStart(7)}`)
}
if (made.length) {
  console.log('')
  console.log('들을 파일 —', path.dirname(path.dirname(made[0].path)))
  console.log('(자리 규칙:', `${OUTPUT_ROOT_DIRNAME}/${FEATURE_FOLDERS.tts}/${dayFolder(new Date())}/…)`)
}
