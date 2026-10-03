// 작업 기록 — **기록 하나가 파일 하나이고, 지우면 되살아나지 않는다.**
//
// ★지시 (2026-09-28)
// > "셋팅.json 에 저장하는게 아닌 생성한 파일마다 정보를 따로 가지고있어서
// >  그 파일만 삭제하게 하도록한다"
//
// ★이 검사가 붙드는 것 — 이 프로젝트에서 **실제로 겪은 사고**들이다
//   1) 지운 기록이 다음에 켤 때 되살아났다 (설정 한 칸에 모여 있어서)
//   2) 하나를 지우면 남의 기록까지 다시 쓰였다
//   3) 옮기고 나서 옛 열쇠를 남겨 두면 다시 옮겨져 되살아난다
//
//   그래서 **앱을 껐다 켜서** 확인한다. 메모리에서만 지워진 것은 지운 것이 아니다.
//
// 실행: node test/e2e/work-records.e2e.mjs   (사전: npm run build. GPU 불필요)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData, enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const UD = isolatedUserData()
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

// ★옛 자리에 기록을 심어 둔다 — 옮기기가 실제로 도는지 보려고.
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  playbackVolume: 0.42,
  transcriptDrafts: {
    version: 1,
    drafts: {
      '옛것A': { sourcePath: 'A.wav', base: 'a', segments: [], edits: { 0: '가' }, updatedAt: 100 },
      '옛것B': { sourcePath: 'B.wav', base: 'b', segments: [], edits: { 0: '나' }, updatedAt: 200 },
    },
  },
}, null, 2), 'utf-8')

const launch = async () => {
  const app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  return { app, win }
}
const filesIn = (kind) => {
  const d = path.join(UD, 'works', kind)
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')) } catch { return [] }
}
const settings = () => {
  try { return JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf-8')) } catch { return {} }
}

let app = null
try {
  // ── 1. 첫 실행 — 옛 열쇠를 파일로 옮긴다 ──────────────────────────────
  {
    const s = await launch(); app = s.app
    const got = await s.win.evaluate(() => window.api.works.list('transcript'))
    ok((got.records || []).length === 2, '옛 기록 둘을 읽는다', got)
    ok(filesIn('transcript').length === 2, '★기록 하나가 파일 하나다', filesIn('transcript'))
    const keys = (got.records || []).map((r) => r.key).sort()
    ok(keys.join(',') === '옛것A,옛것B', '열쇠가 그대로다', keys)
    const before = (got.records || []).find((r) => r.key === '옛것A')
    ok(JSON.stringify(before?.data?.edits) === '{"0":"가"}', '내용을 바꾸지 않고 옮겼다', before?.data)

    ok(settings().transcriptDrafts === undefined,
      '★옮긴 뒤 옛 열쇠를 지운다 — 남기면 다음에 되살아난다', Object.keys(settings()))
    ok(settings().playbackVolume === 0.42, '★앱 설정은 건드리지 않는다', settings().playbackVolume)
    await app.close(); app = null
  }

  // ── 2. 하나를 지운다 ──────────────────────────────────────────────────
  {
    const s = await launch(); app = s.app
    const del = await s.win.evaluate(() => window.api.works.remove('transcript', '옛것A'))
    ok(del.ok && del.removed, '지웠다고 답한다', del)
    ok(filesIn('transcript').length === 1, '★그 파일 하나만 사라졌다', filesIn('transcript'))
    const left = await s.win.evaluate(() => window.api.works.list('transcript'))
    ok((left.records || []).length === 1 && left.records[0].key === '옛것B',
      '★남의 기록은 그대로다', left.records)
    await app.close(); app = null
  }

  // ── 3. ★껐다 켜도 되살아나지 않는다 — 이것이 핵심이다 ────────────────
  {
    const s = await launch(); app = s.app
    const got = await s.win.evaluate(() => window.api.works.list('transcript'))
    ok((got.records || []).length === 1 && got.records[0].key === '옛것B',
      '★껐다 켜도 지운 기록이 되살아나지 않는다', got.records)
    ok(await s.win.evaluate(() => window.api.works.read('transcript', '옛것A'))
      .then((r) => r.record === null), '지운 기록은 읽어도 없다')
    await app.close(); app = null
  }

  // ── 4. 새로 쓰고, 지우고, 다시 켠다 ───────────────────────────────────
  {
    const s = await launch(); app = s.app
    const w = await s.win.evaluate(() => window.api.works.write('transcript', '새것', { edits: { 0: '다' } }))
    ok(w.ok, '새 기록을 쓴다', w)
    ok(filesIn('transcript').length === 2, '파일이 하나 늘었다', filesIn('transcript'))
    await s.win.evaluate(() => window.api.works.remove('transcript', '옛것B'))
    ok(filesIn('transcript').length === 1, '지운 만큼만 줄었다', filesIn('transcript'))
    await app.close(); app = null

    const s2 = await launch(); app = s2.app
    const after = await s2.win.evaluate(() => window.api.works.list('transcript'))
    ok((after.records || []).length === 1 && after.records[0].key === '새것',
      '★다시 켜도 새것만 남는다', after.records)
    await app.close(); app = null
  }

  // ── 5. 갈래를 통째로 비운다 ───────────────────────────────────────────
  {
    const s = await launch(); app = s.app
    const c = await s.win.evaluate(() => window.api.works.clear('transcript'))
    ok(c.ok && c.removed === 1, '비운 개수를 말한다', c)
    ok(filesIn('transcript').length === 0, '파일이 없다', filesIn('transcript'))
    await app.close(); app = null

    const s2 = await launch(); app = s2.app
    const after = await s2.win.evaluate(() => window.api.works.list('transcript'))
    ok((after.records || []).length === 0,
      '★비운 뒤 다시 켜도 옛 기록이 돌아오지 않는다', after.records)
    ok(settings().playbackVolume === 0.42, '★비워도 앱 설정은 그대로다', settings().playbackVolume)
    await app.close(); app = null
  }

  // ── 6. 모르는 갈래는 거절한다 ─────────────────────────────────────────
  {
    const s = await launch(); app = s.app
    const bad = await s.win.evaluate(() => window.api.works.write('없는갈래', 'x', {}))
    ok(bad.ok === false, '★모르는 갈래에 쓰지 않는다', bad)
    const badDir = path.join(UD, 'works', '없는갈래')
    ok(!fs.existsSync(badDir), '폴더를 만들지도 않는다')
    await app.close(); app = null
  }
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
