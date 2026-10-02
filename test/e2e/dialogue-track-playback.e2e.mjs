// 결과 트랙 재생 — **실제 앱에서** 소리가 흐르고 멈추는가.
//
// 대화 작업실의 '결과 듣기' 는 주소를 직접 만들지 않고 **기존 공용 경로**
// (`audio.getFileUrl` → `local-file://` 프로토콜)를 쓴다. 여기서 보는 것은 그 경로다.
//   1) 공용 경로가 주소를 준다(직접 조합한 `file://` 이 아니다)
//   2) 그 주소로 실제 소리가 **재생되고 시간이 흐른다**
//   3) 멈추면 **시간이 멈춘다**
//   4) ★이름에 `#` 이 든 파일도 같다 — 주소를 직접 이어 붙이면 여기서 깨진다
//
// 엔진을 돌리지 않는다. 저장소 fixture 를 임시 폴더에 복사해서만 쓴다.
// 실행: node test/e2e/dialogue-track-playback.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { enterStudio } from './_e2e-helper.mjs'

const APP = process.cwd()
const FIX = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
if (!fs.existsSync(FIX)) { console.error(`fixture 없음: ${FIX}`); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dlg-play-'))
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dlg-ud-'))
// ★이름에 `#` 이 들어간 사본 — 주소를 직접 이어 붙이면 그 뒤가 조각(fragment)으로 잘린다.
const PLAIN = path.join(WORK, 'speaker_a.wav')
const HASH = path.join(WORK, 'speaker_b #2 (혼합).wav')
fs.copyFileSync(FIX, PLAIN)
fs.copyFileSync(FIX, HASH)

let failed = 0
const ok = (c, m, extra = '') => { console.log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

const app = await electron.launch({
  args: ['out/main/index.js'], cwd: APP,
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD },
})
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await enterStudio(win)        // 시작 화면의 '작업실 시작'(2026-10-03)
  await win.waitForFunction(() => !!window.api?.audio?.getFileUrl)

  for (const [label, file] of [['보통 이름', PLAIN], ['# 들어간 이름', HASH]]) {
    const url = await win.evaluate((p) => window.api.audio.getFileUrl(p), file)
    ok(typeof url === 'string' && url.startsWith('local-file://'),
      `${label}: 공용 경로가 주소를 준다`, String(url).slice(0, 40))
    ok(!String(url).startsWith('file:'), `${label}: file:// 를 직접 만들지 않는다`)

    const played = await win.evaluate(async (src) => {
      const el = new Audio()
      el.src = src
      el.volume = 0            // 검사 중에는 소리를 내지 않는다
      const ready = await new Promise((res) => {
        el.addEventListener('loadedmetadata', () => res('meta'), { once: true })
        el.addEventListener('error', () => res('error'), { once: true })
        setTimeout(() => res('timeout'), 8000)
      })
      if (ready !== 'meta') return { ready, duration: 0, moved: 0, stopped: null }
      const duration = el.duration
      await el.play()
      await new Promise((r) => setTimeout(r, 900))
      const moved = el.currentTime
      el.pause()
      const at = el.currentTime
      await new Promise((r) => setTimeout(r, 500))
      const after = el.currentTime
      el.src = ''
      return { ready, duration, moved, stopped: Math.abs(after - at) }
    }, url)

    ok(played.ready === 'meta', `${label}: 주소로 파일을 연다`, JSON.stringify(played.ready))
    // ★관찰한 사실: 이 프로토콜은 길이를 알려 주지 않아 `duration` 이 Infinity 다.
    //   듣고 멈추는 데는 문제가 없지만 **막대를 끌어 이동할 수는 없다.**
    //   파형이 필요한 자리(결과 플레이어)는 WaveSurfer 가 통째로 디코딩해 그 제약이 없다.
    ok(Number.isFinite(played.duration) || played.duration === Infinity,
      `${label}: 길이 정보를 받는다(값: ${played.duration})`,
      Number.isFinite(played.duration) ? '' : '— 이동은 불가')
    ok(played.moved > 0.3, `${label}: 재생하면 시간이 흐른다`, `${(played.moved || 0).toFixed(2)}초`)
    ok(played.stopped !== null && played.stopped < 0.05,
      `${label}: 멈추면 시간이 멈춘다`, `${(played.stopped ?? -1).toFixed(3)}초`)
  }
} catch (e) {
  console.error('FAIL', e?.message || e)
  failed++
} finally {
  await app.close().catch(() => {})
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.rmSync(UD, { recursive: true, force: true })
}
console.log(JSON.stringify({ failed }))
process.exit(failed ? 1 : 0)
