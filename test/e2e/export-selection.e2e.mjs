// 선택 내보내기 — **화면에서 고른 것과 실제로 저장된 파일이 같은가.**
//
// 실제 앱에서 본다(엔진은 돌리지 않는다). 폴더 고르기 대화상자만 본체에서 가로채고,
// 나머지(복사·덮어쓰기 보호·실패 보고)는 제품 코드 그대로 돈다.
//   1) 고른 것만 저장된다 — 고르지 않은 것은 **폴더에 없다**
//   2) 내용이 그 결과의 것이다(이름만 같고 다른 파일이 아니다)
//   3) 같은 이름이 이미 있으면 **덮지 않고** 사유를 돌려준다
//   4) 결과 폴더 자신을 고르면 **결과를 지우지 않는다**
//
// 실행: node test/e2e/export-selection.e2e.mjs   (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'af-exp-out-'))
const DEST = fs.mkdtempSync(path.join(os.tmpdir(), 'af-exp-dest-'))
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'af-exp-ud-'))

/** 결과 트랙 네 개 — 내용이 서로 달라 뒤바뀌면 알 수 있다. */
const NAMES = ['vocals', 'drums', 'bass', 'other']
for (const n of NAMES) fs.writeFileSync(path.join(OUT, `${n}.wav`), `THIS-IS-${n}`)

let failed = 0
const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }
const p = (dir, n) => path.join(dir, `${n}.wav`)

const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
})
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.audio?.exportTracks)

  /** 폴더 고르기만 가로챈다 — 복사와 보호는 제품 코드 그대로 돈다. */
  const aim = async (dir) => app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
  }, dir)

  // ── 1. 고른 것만 저장된다 ────────────────────────────────────────────
  await aim(DEST)
  const picked = [p(OUT, 'vocals'), p(OUT, 'bass')]
  const r1 = await win.evaluate((paths) => window.api.audio.exportTracks(paths), picked)
  ok(r1 && r1.ok === true, '내보내기가 성공을 돌려준다', JSON.stringify(r1?.copied))
  const got = fs.readdirSync(DEST).sort()
  ok(JSON.stringify(got) === JSON.stringify(['bass.wav', 'vocals.wav']),
    '★고른 것만 저장된다', JSON.stringify(got))
  ok(!fs.existsSync(p(DEST, 'drums')) && !fs.existsSync(p(DEST, 'other')),
    '★고르지 않은 결과는 폴더에 없다')
  ok(fs.readFileSync(p(DEST, 'vocals'), 'utf-8') === 'THIS-IS-vocals'
    && fs.readFileSync(p(DEST, 'bass'), 'utf-8') === 'THIS-IS-bass',
    '★저장된 내용이 그 결과의 것이다')

  // ── 2. 같은 이름이 이미 있으면 덮지 않는다 ───────────────────────────
  fs.writeFileSync(p(DEST, 'drums'), 'USER-FILE')
  const r2 = await win.evaluate((paths) => window.api.audio.exportTracks(paths),
    [p(OUT, 'drums'), p(OUT, 'other')])
  ok(r2 && r2.ok === false && r2.failed.length === 1,
    '한 건이 막혀도 나머지는 저장하고 실패를 돌려준다', JSON.stringify(r2?.failed))
  ok(fs.readFileSync(p(DEST, 'drums'), 'utf-8') === 'USER-FILE',
    '★이미 있는 파일을 덮지 않는다')
  ok(fs.existsSync(p(DEST, 'other')), '막히지 않은 것은 저장된다')

  // ── 3. 결과 폴더 자신을 골라도 결과를 지우지 않는다 ──────────────────
  await aim(OUT)
  const before = Object.fromEntries(NAMES.map((n) => [n, fs.readFileSync(p(OUT, n), 'utf-8')]))
  const r3 = await win.evaluate((paths) => window.api.audio.exportTracks(paths),
    NAMES.map((n) => p(OUT, n)))
  ok(r3 && r3.ok === false && r3.failed.length === NAMES.length,
    '★결과 폴더 자신에는 저장하지 않는다', JSON.stringify(r3?.failed?.[0]))
  const after = Object.fromEntries(NAMES.map((n) => [n, fs.readFileSync(p(OUT, n), 'utf-8')]))
  ok(JSON.stringify(before) === JSON.stringify(after), '★결과 파일이 그대로 남는다')
  ok(String(r3?.failed?.[0]?.why || '').includes('저장할 수 없습니다'),
    '사람이 읽을 사유를 돌려준다', String(r3?.failed?.[0]?.why))

} catch (e) {
  console.error('FAIL', e?.message || e)
  failed++
} finally {
  await app.close().catch(() => {})
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.rmSync(UD, { recursive: true, force: true })
}
console.log(JSON.stringify({ failed }))
process.exit(failed ? 1 : 0)
