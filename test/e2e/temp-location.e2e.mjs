// 앱이 쓰는 **임시 자리** — C 드라이브로 가지 않는다.
//
// ★지시 (2026-09-28)
//   "가장 중요한건 6번이다. C 드라이브로 가지 않아야한다."
//
// ★왜 이 검사가 필요한가
//   자리를 옮기는 일은 **조용히 실패한다.** 환경 변수 하나를 빠뜨리거나, 옮기는 줄이
//   tmpdir() 을 처음 부르는 곳보다 뒤에 있으면 앱은 아무 말 없이 옛 자리에 계속 쌓는다.
//   그래서 "옮겼다" 를 코드로 믿지 않고 **실제 앱에 물어본다.**
//
// 여기서 보는 것:
//   1) 본체의 임시 자리가 앱 데이터 자리 **안**이다
//   2) 화면이 그 자리를 보여 준다 (사용자가 새는 것을 알아볼 수 있다)
//   3) 앱을 띄우고 실제로 일을 시킨 뒤에도 **시스템 임시 폴더가 늘지 않는다**
//   4) 파이썬 자식도 같은 자리를 물려받는다 (env 로 전달되는가)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { isolatedUserData, cleanupUserData, makeSyntheticWav, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

// ★진짜 시스템 임시 폴더. 검사 스스로도 자리를 옮겼으므로(`test/_temp-root.mjs`)
//   os.tmpdir() 은 이미 저장소 안이다 — 그래서 윈도우 기본 자리를 직접 짚는다.
function systemTemp() {
  if (process.platform !== 'win32') return '/tmp'
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, 'AppData', 'Local', 'Temp')
}
const SYS = systemTemp()
const ourNames = (dir) => {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('audioforge_') || n.startsWith('audioforge-')) }
  catch { return [] }
}

let app = null
try {
  // 앱을 띄우기 **전** 시스템 폴더의 우리 이름 개수를 적어 둔다.
  const before = new Set(ourNames(SYS))

  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)

  // ── 1. 본체의 임시 자리 ───────────────────────────────────────────────
  // ★본체 평가 문맥에는 `require` 가 없다. 그래서 `os.tmpdir()` 자체는
  //   **앱이 부팅하며 스스로 남긴 기록**으로 확인한다(아래 7번) — 그것이 실제 앱의 말이다.
  const seen = await app.evaluate(async ({ app: a }) => ({
    temp: a.getPath('temp'),
    userData: a.getPath('userData'),
    env: { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR },
  }))
  const inside = (p, root) => typeof p === 'string' && typeof root === 'string'
    && p.toLowerCase().startsWith(root.toLowerCase())

  ok(inside(seen.temp, seen.userData), '★Electron 의 임시 자리가 앱 데이터 자리 안이다', seen)
  ok(!inside(seen.temp, SYS), '★시스템 임시 폴더가 아니다', { temp: seen.temp, SYS })

  // ── 2. 세 변수를 모두 돌렸는가 — 하나라도 빠지면 그것을 읽는 쪽만 샌다 ──
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) {
    ok(inside(seen.env[k], seen.userData), `★${k} 가 앱 안을 가리킨다`, seen.env[k])
  }

  // ── 3. 화면이 그 자리를 보여 준다 ─────────────────────────────────────
  await win.getByTestId('open-app-options').click()
  await win.waitForSelector('[data-testid="app-options"]')
  const shownTemp = (await win.getByTestId('options-temp').innerText()).trim()
  ok(shownTemp.length > 0 && shownTemp !== '(아직 모름)', '설정이 임시 자리를 보여 준다', shownTemp)
  // ★화면이 보여 주는 값은 본체의 `os.tmpdir()` 이다 — Electron 의 temp 와 같은 자리여야 한다.
  //   둘이 갈리면 "보여 주는 자리" 와 "실제로 쓰는 자리" 가 다르다는 뜻이다.
  ok(shownTemp.toLowerCase() === seen.temp.toLowerCase(),
    '★보여 주는 자리가 본체가 쓰는 자리와 같다', { shownTemp, electron: seen.temp })
  await win.getByTestId('options-close').click()

  // 앱의 임시 자리가 **실제로 쓰이는지** 보려고 손댄 시각을 적어 둔다.
  const stamp = (d) => { try { return fs.statSync(d).mtimeMs } catch { return 0 } }
  const tempBefore = stamp(seen.temp)
  // ── 4. 실제로 일을 시킨다 — 임시 파일을 만드는 길을 지나가게 ──────────
  //   목소리 파일을 하나 넣고 앱이 그것을 다루게 한다. 여기서 만들어지는
  //   중간물이 어디로 가는지가 이 검사의 핵심이다.
  const src = makeSyntheticWav(path.join(UD, 'temp-probe', 'voice.wav'), 1)
  // ★임시 설정 JSON 을 **확실히** 만드는 길을 고른다. 결과는 보지 않는다 —
  //   파이썬이 없어도 본체는 그 전에 이미 설정 파일을 임시 자리에 쓴다.
  //   그냥 지나가기만 하는 호출을 쓰면 5번 검사가 아무것도 안 본 채 통과한다.
  await win.evaluate(async (p) => {
    const tries = [
      () => window.api.pitch?.curve?.(p, 1),
      () => window.api.analyzeReference?.(p, 'k', {}),
      () => window.api.pitchPreflight?.(),
    ]
    for (const run of tries) { try { await run() } catch { /* 자리를 보는 검사다 — 결과는 상관없다 */ } }
  }, src)
  await win.waitForTimeout(1500)

  // ── 5. 시스템 임시 폴더가 늘지 않았다 ─────────────────────────────────
  const after = ourNames(SYS)
  const added = after.filter((n) => !before.has(n))
  ok(added.length === 0, '★앱을 띄우고 일을 시켜도 시스템 임시 폴더가 늘지 않는다', added.slice(0, 10))

  // ★5번이 헛통과하지 않았음을 보인다 — 앱 임시 자리가 실제로 손을 탔다.
  //   여기가 0 이면 아무 일도 안 일어난 것이고, 그러면 5번은 아무것도 증명하지 않는다.
  ok(stamp(seen.temp) !== tempBefore || fs.readdirSync(seen.temp).length > 0,
    (String.fromCharCode(9733)) + '앱 임시 자리가 실제로 쓰였다 — 5번이 헛통과가 아니다',
    { before: tempBefore, after: stamp(seen.temp) })
  // ── 6. 앱이 쓴 것은 격리 자리 안에 있다 ───────────────────────────────
  ok(fs.existsSync(seen.temp), '★앱의 임시 폴더가 실제로 만들어졌다', seen.temp)

  // ── 7. 앱 스스로 남긴 부팅 기록 — `os.tmpdir()` 의 실제 값 ────────────
  //   본체 평가로는 못 보는 값이라, 앱이 부팅하며 적은 한 줄로 확인한다.
  const logDir = path.join(UD, 'logs')
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((n) => n.endsWith('.log')) : []
  const read = (n) => { try { return fs.readFileSync(path.join(logDir, n), "utf-8") } catch { return "" } }
  const lines = logs.flatMap((n) => read(n).split(/\r?\n/))
  const line = lines.find((l) => l.includes("임시 자리")) || ""
  ok(line.includes('앱 안'), '★부팅 기록이 임시 자리를 "앱 안" 으로 적는다', line || '(그 줄이 없다)')
  ok(!line.includes('앱 밖'), '★"앱 밖" 으로 적힌 실행이 없다', line)
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
