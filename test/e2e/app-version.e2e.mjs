// 앱 버전 표시 E2E (GPU·Qwen·Whisper·미디어 없음). 실행: npm run test:e2e:app-version
//
// 고정하는 것:
//   · 표시 문자열은 app.getVersion() 에서 오고 renderer 에 하드코딩돼 있지 않다
//   · 위치는 `이전 결과 폴더 열기` **아래**, 같은 중앙 축, 14~18px 간격
//   · 배경·테두리·pill·badge 가 없고 보조 설명보다 어둡다
//   · 상세는 hover 뿐 아니라 **keyboard focus** 로도 열리고 aria-label 로도 읽힌다
//   · 작은 창·고배율에서 버튼과 겹치지도 잘리지도 않는다
//   · 기존 파일 선택·드래그·이전 결과 버튼 레이아웃은 그대로다
// 화면 캡처는 하지 않는다 — 수치로만 판정한다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'

const APP = process.cwd()
let failed = 0
const log = (...a) => console.log('[version]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요 — npm run build')
  process.exit(2)
}
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf-8'))
const metaPath = path.join(APP, 'build-metadata.json')
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : null

const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' }
})
const win = await app.firstWindow()
const pageErrors = []
win.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await win.waitForLoadState('domcontentloaded')
  const label = win.locator('[data-testid="app-version"]')
  await label.waitFor({ state: 'visible', timeout: 15000 })

  // ── 값 권위 ──────────────────────────────────────────────────────────────
  // 패키징하면 app.getVersion() 이 곧 package.json version 이다. 개발 실행처럼 Electron 이
  // 앱 package.json 을 못 찾는 경우에는 자기 런타임 버전을 돌려주므로, 그때 화면에 그 값이
  // 새어 나오지 않는지까지 본다(권위는 package.json 하나다).
  const runtime = await app.evaluate(({ app: a }) => ({
    reported: a.getVersion(), electron: process.versions.electron
  }))
  const appVersion = pkg.version
  const fellBack = runtime.reported === runtime.electron
  ok(fellBack || runtime.reported === appVersion,
    'app.getVersion() 은 package.json version 이거나 Electron 런타임 버전이다',
    `${runtime.reported} / pkg ${appVersion} / electron ${runtime.electron}`)
  const text = (await label.textContent() || '').trim()
  // develop 계열은 표시 시점에 build metadata 의 short SHA 를 합친다.
  const expected = /-dev(\.|$|-)/.test(appVersion) && meta && meta.commit && !appVersion.includes('+')
    ? `v${appVersion}+${meta.commit}`
    : `v${appVersion}`
  ok(text === expected, '표시 문자열이 package.json version 에서 온다', `${text} / ${expected}`)
  ok(text !== `v${runtime.electron}`, 'Electron 런타임 버전이 화면에 새지 않는다')
  ok(!text.includes('AudioForge'), 'AudioForge 를 반복하지 않는다')

  const aria = await label.getAttribute('aria-label')
  ok(!!aria && aria.startsWith(`AudioForge ${appVersion}`),
    'aria-label 로 상세를 읽을 수 있다', JSON.stringify(aria))
  if (meta && meta.commit) {
    ok(aria.includes(`Build ${meta.commit}`), 'aria-label 에 build commit 이 있다')
  }
  if (meta && meta.date) ok(aria.includes(meta.date), 'aria-label 에 build date 가 있다')
  if (meta && meta.channel) ok(aria.includes(meta.channel), 'aria-label 에 channel 이 있다')
  ok(!/[A-Za-z]:\\|\/Users\/|\/home\//.test(aria || ''), '상세에 절대경로가 없다')

  // ── 배치 ─────────────────────────────────────────────────────────────────
  const button = win.locator('button', { hasText: '이전 결과 폴더 열기' })
  ok(await button.count() === 1, '이전 결과 폴더 열기 버튼이 그대로 있다')
  const drop = await win.locator('text=/드래그|파일 선택|여기에/i').count()
  ok(drop > 0, '파일 선택·드래그 영역이 그대로 있다', `${drop}개 매치`)

  const boxes = async () => ({
    b: await button.boundingBox(), v: await label.boundingBox()
  })
  const { b, v } = await boxes()
  ok(!!b && !!v, '두 요소 모두 화면에 있다')
  const gap = v.y - (b.y + b.height)
  ok(gap >= 14 && gap <= 18, '버튼과 14~18px 간격', `${gap.toFixed(1)}px`)
  const bCenter = b.x + b.width / 2
  const vCenter = v.x + v.width / 2
  ok(Math.abs(bCenter - vCenter) <= 1.5, '기존 중앙 축을 그대로 쓴다',
    `버튼 ${bCenter.toFixed(1)} / 버전 ${vCenter.toFixed(1)}`)

  const style = await label.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      fontSize: parseFloat(s.fontSize), borderWidth: parseFloat(s.borderTopWidth) +
        parseFloat(s.borderBottomWidth) + parseFloat(s.borderLeftWidth) +
        parseFloat(s.borderRightWidth),
      background: s.backgroundColor, radius: s.borderRadius, weight: s.fontWeight
    }
  })
  ok(Math.abs(style.fontSize - 11) <= 0.5, '약 11px', `${style.fontSize}px`)
  // Tailwind preflight 가 border-style: solid / width: 0 을 깔아 둔다 — 폭으로 판정한다.
  ok(style.borderWidth === 0, '테두리 없음(폭 0)', String(style.borderWidth))
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(style.background), '배경 없음', style.background)
  ok(Number(style.weight) < 600, '제목·버튼처럼 강조하지 않는다', style.weight)

  // 보조 설명(부제)보다 어둡다 — 같은 화면의 부제 색과 비교한다.
  const subtitle = win.locator('p', { hasText: 'AI 기반' }).first()
  const lum = async (loc) => loc.evaluate((el) => {
    const s = getComputedStyle(el)
    const m = s.color.match(/[\d.]+/g).map(Number)
    const a = m.length > 3 ? m[3] : 1
    const o = parseFloat(s.opacity || '1')
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) * a * o
  })
  if (await subtitle.count()) {
    const [lv, ls] = [await lum(label), await lum(subtitle)]
    ok(lv < ls, '보조 설명보다 한 단계 어둡다', `버전 ${lv.toFixed(1)} < 부제 ${ls.toFixed(1)}`)
  }

  // ── 키보드 접근 ──────────────────────────────────────────────────────────
  await label.focus()
  ok(await label.evaluate((el) => document.activeElement === el), '키보드 focus 가 닿는다')
  const tip = win.locator('[data-testid="app-version-tooltip"]')
  await tip.waitFor({ state: 'visible', timeout: 3000 })
  const tipText = (await tip.textContent() || '')
  ok(tipText.includes(`AudioForge ${appVersion}`), 'focus 만으로 상세가 열린다')
  await label.evaluate((el) => el.blur())
  await win.waitForTimeout(100)
  ok(await tip.count() === 0, 'blur 하면 닫힌다')

  // ── 작은 창 · 고배율 ─────────────────────────────────────────────────────
  for (const [w, h, zoom] of [[820, 620, 1], [700, 520, 1], [820, 620, 1.5], [700, 560, 2]]) {
    await app.evaluate(({ BrowserWindow }, [ww, hh, z]) => {
      const win0 = BrowserWindow.getAllWindows()[0]
      win0.setSize(ww, hh)
      win0.webContents.setZoomFactor(z)
    }, [w, h, zoom])
    await win.waitForTimeout(160)
    const bb = await button.boundingBox()
    const vv = await label.boundingBox()
    const vp = win.viewportSize() || { width: w, height: h }
    if (!bb || !vv) { ok(false, `${w}x${h} @${zoom}x — 요소가 사라졌다`); continue }
    const overlap = vv.y < bb.y + bb.height - 0.5
    ok(!overlap, `${w}x${h} @${zoom}x 버튼과 겹치지 않는다`,
      `버튼끝 ${(bb.y + bb.height).toFixed(1)} / 버전 ${vv.y.toFixed(1)}`)
    const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    ok(!clipped, `${w}x${h} @${zoom}x 잘리지 않는다`)
    ok(vv.x >= -0.5 && vv.x + vv.width <= vp.width + 0.5,
      `${w}x${h} @${zoom}x 가로로 넘치지 않는다`)
  }

  ok(pageErrors.length === 0, 'renderer 오류 0', JSON.stringify(pageErrors))
} catch (e) {
  ok(false, `예외: ${e && e.message}`)
} finally {
  await app.close().catch(() => {})
}

log(failed === 0 ? '전부 통과' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
