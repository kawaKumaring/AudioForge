// 만든 것이 **어디에 쌓이는가** — 실제 앱, 실제 본체 통로로 본다.
//
// ★신고 (2026-09-28): "영상파일을 합성에 넣고 작업을 하면 … C 드라이브에 폴더를 만들어서
//   생성을 한다." 원인은 화면이 **꺼낸 wav** 를 원본인 양 건네고, 본체가 그 폴더 옆에
//   결과를 만든 것이었다.
//
// 여기서 보는 것:
//   1) 영상을 목소리로 써도 결과가 **C 드라이브 중간 폴더로 가지 않는다**
//   2) 기본 자리는 앱 폴더의 `AudioForge_output/<기능>/<날짜>/` 다
//   3) '원본 옆' 을 켜면 **진짜 원본(영상) 옆**이다 — 꺼낸 wav 옆이 아니다
//   4) 고른 자리가 있으면 그쪽이 이긴다
//
// 모델은 저장소 fixture 로 갈아 끼운다. 사용자 음원·GPU·모델을 쓰지 않는다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isolatedUserData, cleanupUserData, makeSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
const FIXTURE = path.join(APP, 'test', 'e2e', 'fixtures', 'synthetic_tree.py')
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }
if (!fs.existsSync(FIXTURE)) { console.error('fixture 없음'); process.exit(2) }

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()

const UD = isolatedUserData()
// 사용자의 '영상' 과, 화면이 그것에서 꺼내 앱 자리에 둔 wav 를 흉내 낸다.
const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'audioforge_e2e_src-'))
const VIDEO = path.join(SRC, '인터뷰.mp4')
fs.writeFileSync(VIDEO, 'not a real video — 경로만 쓴다')
const EXTRACTED = makeSyntheticWav(path.join(UD, 'cardmedia', 'abc123', 'voice_x.wav'), 3)

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: {
      ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1',
      AF_E2E_TTS_SCRIPT: FIXTURE, AF_E2E_FIXTURE_MODE: 'ok',
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore)

  /** 본체에 한 번 요청하고 **결과 자리만** 받아 온다. 곧바로 멈춘다. */
  const askWhere = async (opts) => {
    const r = await win.evaluate(async ({ read, o }) => {
      try {
        const res = await window.api.audio.process(read, 'tts', { ttsText: '검사', ...o })
        return { dir: res?.outputDir || '' }
      } catch (e) { return { error: String(e?.message || e) } }
    }, { read: EXTRACTED, o: opts })
    await win.evaluate(() => window.api.audio.cancel().catch(() => {}))
    await win.waitForTimeout(600)
    return r
  }

  // ── 1. 기본 — 앱 자리의 기능·날짜 폴더 ────────────────────────────────
  const base = await askWhere({ sourceOriginalPath: VIDEO })
  ok(!base.error, '본체가 요청을 받아들였다', base)
  ok(base.dir && !norm(base.dir).startsWith(norm(UD)),
    '★꺼낸 wav 가 있는 앱 데이터 폴더(C)로 가지 않는다', base.dir)
  ok(norm(base.dir).startsWith(norm(APP) + '/audioforge_output/'),
    '★기본 자리는 앱 폴더의 AudioForge_output 이다', base.dir)
  ok(norm(base.dir).includes('/음성합성/'), '기능 이름으로 갈라 둔다', base.dir)
  ok(/\/\d{4}-\d{2}-\d{2}\//.test(norm(base.dir)), '날짜로 갈라 둔다', base.dir)
  ok(norm(base.dir).includes('인터뷰'), '폴더 이름이 꺼낸 wav 가 아니라 **원본 이름**이다', base.dir)

  // ── 2. '원본 옆' 을 켜면 진짜 원본 옆 ─────────────────────────────────
  await win.evaluate(() => window.api.settings.set('outputBesideSource', true))
  const beside = await askWhere({ sourceOriginalPath: VIDEO })
  ok(norm(beside.dir).startsWith(norm(SRC) + '/audioforge_output/'),
    '★체크하면 진짜 영상 옆이다(꺼낸 wav 옆이 아니다)', beside.dir)

  // 원본을 모르면(기본 목소리처럼) 조용히 C 로 가지 않고 앱 자리로 물러난다
  const noSource = await askWhere({})
  ok(!norm(noSource.dir).startsWith(norm(UD)),
    '★원본을 몰라도 앱 데이터 폴더로 흘러내리지 않는다', noSource.dir)

  // ── 3. 고른 자리가 이긴다 ─────────────────────────────────────────────
  const CHOSEN = fs.mkdtempSync(path.join(os.tmpdir(), 'audioforge_e2e_out-'))
  await win.evaluate((c) => Promise.all([
    window.api.settings.set('outputBesideSource', false),
    window.api.settings.set('outputRoot', c),
  ]), CHOSEN)
  const chosen = await askWhere({ sourceOriginalPath: VIDEO })
  ok(norm(chosen.dir).startsWith(norm(CHOSEN) + '/audioforge_output/음성합성/'),
    '★고른 자리가 있으면 그쪽에 쌓는다', chosen.dir)

  // 체크가 고른 자리보다 세다
  await win.evaluate(() => window.api.settings.set('outputBesideSource', true))
  const both = await askWhere({ sourceOriginalPath: VIDEO })
  ok(norm(both.dir).startsWith(norm(SRC) + '/audioforge_output/'),
    '★체크가 고른 자리보다 앞선다', both.dir)

  try { fs.rmSync(CHOSEN, { recursive: true, force: true }) } catch { /* noop */ }
} catch (e) {
  console.error('FAIL', e?.message || e)
  fails.push(String(e?.message || e))
} finally {
  await app?.close().catch(() => {})
  cleanupUserData(UD)
  try { fs.rmSync(SRC, { recursive: true, force: true }) } catch { /* noop */ }
}
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
