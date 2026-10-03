// 발언 목록의 **칸이 세로로 맞는가** — 눈 대신 좌표로 잰다.
//
// ★왜 (2026-09-28 지적)
// > "발언 되돌리기때문에 UX가 들쑥날쑥해진다"
// > "배치가 깔끔하지 못하고 들쑥날쑥하다"
//
//   화면 캡처 없이 확인해야 해서, 각 칸의 **왼쪽 좌표와 너비**를 직접 잰다.
//   같은 것이 줄마다 같은 자리에 있으면 눈으로도 가지런하다.
//
// 재는 것
//   1) 줄 높이가 모두 같은가
//   2) 같은 칸(인물·시간·시간칸·되돌리기)이 줄마다 같은 x 에 있는가
//   3) 고치기 전후로 그 좌표가 움직이지 않는가
//   4) 빈 공간이 가운데를 벌려 놓지 않는가 (칸 사이 틈)
//
// 실행: node scripts/measure-dialogue-layout.mjs   (사전: npm run build)
import '../test/_temp-root.mjs'
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from '../test/e2e/_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const SRC = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const UD = isolatedUserData()
const SEGMENTS = [
  { start: 0, end: 5, speaker: '화자 A' },
  { start: 5, end: 11, speaker: '화자 B' },
  { start: 11, end: 18, speaker: '화자 A' },
]

/** 줄마다 각 칸의 왼쪽 좌표·너비를 읽는다. */
const probe = `() => {
  const rows = [...document.querySelectorAll('[data-testid="dialogue-row"]')]
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), w: Math.round(r.width) } }
  return rows.map((r) => ({
    row: box(r),
    고르기: box(r.querySelector('[data-testid="dialogue-pick"]')),
    듣기: box(r.querySelector('[data-testid="dialogue-play"]')),
    인물: box(r.querySelector('[data-testid="dialogue-speaker"]')),
    시간글: box(r.querySelector('[data-testid="dialogue-time"]')),
    시작: box(r.querySelector('[data-testid="dialogue-start"]')),
    끝: box(r.querySelector('[data-testid="dialogue-end"]')),
    되돌리기: box(r.querySelector('[data-testid="dialogue-revert"]')),
    높이: Math.round(r.getBoundingClientRect().height),
  }))
}`

const same = (vals) => new Set(vals.filter((v) => v !== null)).size <= 1
let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)
  await win.evaluate(async ([src, segs]) => {
    const s = window.__afStore
    const info = await window.api.audio.getFileInfo(src)
    s.getState().setFile(info, await window.api.audio.getFileUrl(src))
    s.setState({ mode: 'conversation', resultMode: 'conversation', status: 'done', outputDir: '' })
    s.getState().beginDialogueRun('M1')
    s.getState().adoptDialogueAnalysis({
      sourceKey: src, runId: 'M1', segments: segs,
      speakers: [...new Set(segs.map((x) => x.speaker))],
      overlaps: [], outputDir: '', durationSec: info?.duration || 18,
      trimSilence: false, transcribe: false,
    })
  }, [SRC, SEGMENTS])
  await win.waitForSelector('[data-testid="dialogue-row"]')
  await win.waitForTimeout(400)

  const show = (title, rows) => {
    console.log('')
    console.log(title)
    console.log('  줄  높이   인물 x/너비    시간글 x    시작 x   끝 x    되돌리기 x')
    rows.forEach((r, i) => {
      const f = (b) => (b ? String(b.x).padStart(6) : '     —')
      console.log('  ' + String(i + 1).padStart(2), String(r.높이).padStart(5),
        String(r.인물?.x ?? '—').padStart(7) + '/' + String(r.인물?.w ?? '—').padEnd(4),
        f(r.시간글), f(r.시작), f(r.끝), f(r.되돌리기))
    })
  }

  // ── 1) 시간 칸을 켜기 전 ──────────────────────────────────────────────
  const before = await win.evaluate(eval(probe))
  show('시간 고치기 — 꺼짐', before)

  // ── 2) 시간 칸을 켠다 ────────────────────────────────────────────────
  await win.getByTestId('dialogue-toggle-times').click()
  await win.waitForTimeout(300)
  const withTimes = await win.evaluate(eval(probe))
  show('시간 고치기 — 켜짐', withTimes)

  // ── 3) 한 줄을 고친다 (되돌리기가 생긴다) ────────────────────────────
  await win.getByTestId('dialogue-speaker').nth(1).selectOption('화자 A')
  await win.waitForTimeout(400)
  const edited = await win.evaluate(eval(probe))
  show('가운데 줄을 고친 뒤', edited)

  console.log('')
  console.log('── 판정 ──────────────────────────────────────────────')
  const check = (v, label, extra) => console.log(' ', v ? 'OK  ' : 'NG  ', label, extra ?? '')
  for (const [name, set] of [['꺼짐', before], ['켜짐', withTimes], ['고친 뒤', edited]]) {
    check(same(set.map((r) => r.높이)), `[${name}] 줄 높이가 모두 같다`,
      set.map((r) => r.높이).join(','))
    check(same(set.map((r) => r.인물?.x ?? null)), `[${name}] 인물 칸이 세로로 맞는다`,
      set.map((r) => r.인물?.x).join(','))
    check(same(set.map((r) => r.인물?.w ?? null)), `[${name}] 인물 칸 너비가 같다`,
      set.map((r) => r.인물?.w).join(','))
    check(same(set.map((r) => r.시간글?.x ?? null)), `[${name}] 시간 글이 세로로 맞는다`,
      set.map((r) => r.시간글?.x).join(','))
  }
  check(same(withTimes.map((r) => r.시작?.x ?? null)), '[켜짐] 시작 칸이 세로로 맞는다',
    withTimes.map((r) => r.시작?.x).join(','))
  check(same(withTimes.map((r) => r.끝?.x ?? null)), '[켜짐] 끝 칸이 세로로 맞는다',
    withTimes.map((r) => r.끝?.x).join(','))

  // 고쳐도 다른 칸이 움직이지 않는다 — 이것이 '들쑥날쑥' 의 핵심이었다.
  const moved = ['인물', '시간글', '시작', '끝'].filter((k) =>
    withTimes.some((r, i) => (r[k]?.x ?? null) !== (edited[i]?.[k]?.x ?? null)))
  check(moved.length === 0, '★고쳐도 다른 칸이 한 픽셀도 움직이지 않는다',
    moved.length ? '움직인 칸: ' + moved.join(', ') : '')

  // 되돌리기는 고친 줄에만, 그리고 오른쪽 끝에 고정된 자리에 온다.
  const rev = edited.map((r) => r.되돌리기)
  check(rev.filter(Boolean).length === 1, '되돌리기는 고친 줄에만 뜬다')
  // ★조작이 한자리에 모여 있는가 — 마지막 시간 칸과 되돌리기 사이가 벌어지면
  //   가운데가 텅 빈 채 단추 하나만 멀리 떠 있는 그 모양이 된다(2026-09-28 지적).
  const lastInput = withTimes[1].끝
  const gap = rev[1] && lastInput ? rev[1].x - (lastInput.x + lastInput.w) : null
  check(gap !== null && gap < 80, '★조작이 한자리에 모인다 — 가운데가 벌어지지 않는다',
    `끝 칸과 되돌리기 사이 ${gap}px`)
  const rowRight = edited[0].row.x + edited[0].row.w
  const revRight = rev[1] ? rev[1].x + rev[1].w : null
  console.log('  참고  칸 시작 —',
    '고르기', edited[0].고르기?.x, '· 듣기', edited[0].듣기?.x,
    '· 인물', edited[0].인물?.x, '· 시간글', edited[0].시간글?.x)
  console.log('  참고  줄 오른쪽 끝', rowRight, '· 되돌리기 끝', revRight,
    '· 남는 자리', revRight === null ? '—' : rowRight - revRight)
} catch (e) {
  console.error('실패:', e?.message || e)
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
}
