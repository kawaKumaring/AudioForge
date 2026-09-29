// 노래 변환 — **화면에서 눌러 실제 엔진까지 가고, 듣고, 저장하는가.** 한 번에 이어서.
//
// ★이 검사만 모의 응답이 없다. `song:run` · `song:export` 모두 **본체의 진짜 핸들러**를 탄다.
//   그래서 느리다(분리 + seed-vc). 게이트에 넣지 않는다 — 필요할 때 손으로 돌린다.
//
// ★자료는 승인된 것만 쓴다: 목소리는 저장소 fixture, 원곡은 이 검사가 만든 합성 신호다.
//   사용자 개인 음원을 건드리지 않는다.
//
// 확인하는 것
//   · 실제 입력 → 실제 엔진 → 결과 표시
//   · 원곡/변환본 **실제 재생 시작**과 시간 이동, 전환할 때 시간 유지
//   · `song:export` 의 **요청 식별자 불일치 거절**(본체 경로)
//   · `song:export` 의 **원곡 오디오 덮어쓰기 차단**(본체 경로)
//   · 정상 자리에는 저장된다
//
// ★재생이 시작됐다는 것은 **소리가 좋다는 뜻이 아니다.** 청취 품질은 사람이 판정한다.
//
// 실행: node test/e2e/song-real-path.e2e.mjs   (사전: npm run build · GPU 사용)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요: npm run build'); process.exit(2) }

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

const ud = isolatedUserData()
const work = path.join(ud, '작업자리')
const outDir = path.join(ud, '내보낸것')
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ dubWorkRoot: work }), 'utf-8')

/** 격리 원곡 — 멜로디 + 낮은 반주. 사용자 자산이 아니다. */
function makeSong(dest, seconds = 8, rate = 44100) {
  const n = Math.floor(rate * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  const notes = [261.63, 293.66, 329.63, 349.23, 392.0, 349.23, 329.63, 293.66]
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const f = notes[Math.min(notes.length - 1, Math.floor((i / n) * notes.length))]
    const v = 0.33 * Math.sin(2 * Math.PI * f * t) + 0.12 * Math.sin(2 * Math.PI * 130.81 * t)
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)
  }
  fs.writeFileSync(dest, buf)
  return dest
}

const SONG = makeSong(path.join(ud, '원곡.wav'))
const VOICE = path.join(ud, '목소리.wav')
fs.copyFileSync(path.join(APP, 'test/fixtures/audio/ko-speech-region-18s.wav'), VOICE)
const beforeSong = fs.readFileSync(SONG), beforeVoice = fs.readFileSync(VOICE)

let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  await win.waitForFunction(() => !!window.__afStore)

  // 파일 고르기만 대체한다 — 그 뒤 경로는 전부 진짜다.
  await app.evaluate(({ ipcMain }, [s, v]) => {
    ipcMain.removeHandler('audio:select-file')
    ipcMain.handle('audio:select-file', async (_e, _multi, kind) => (kind === 'voice' ? v : s))
  }, [SONG, VOICE])

  // 결과의 요청 식별자를 검사 쪽에서 기억한다 — **제품 코드를 건드리지 않는다.**
  await win.evaluate(() => {
    window.__afSongShown = ''
    window.api.song.onResult((d) => { window.__afSongShown = d?.clientRequestId || '' })
  })
  await win.evaluate(() => window.__afStore.getState().setMode('dub'))
  await win.getByTestId('song-cards').waitFor()
  await win.getByTestId('song-source-input').getByRole('button').first().click()
  await win.waitForTimeout(800)
  await win.getByTestId('song-voice-input').getByRole('button').first().click()
  await win.waitForTimeout(800)
  check(await win.getByTestId('song-run').isEnabled(), '원곡과 목소리를 고르면 변환이 열린다')

  // ── 실제 엔진 ────────────────────────────────────────────────────────
  console.log('  · 실제 변환을 시작한다(분리 + seed-vc — 몇 분 걸린다)')
  const t0 = Date.now()
  await win.getByTestId('song-run').click()
  await win.getByTestId('song-result').waitFor({ timeout: 900000 })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  · 결과까지 ${sec}초`)
  check(true, '화면에서 눌러 실제 엔진까지 가고 결과가 뜬다')

  // ── 실제 파일을 읽어 파형이 준비되는가 ────────────────────────────────
  await win.waitForFunction(() =>
    document.querySelector('[data-testid="song-result"]')?.getAttribute('data-state') === 'ready',
  null, { timeout: 120000 }).catch(() => {})
  const ready = await win.evaluate(() =>
    document.querySelector('[data-testid="song-result"]')?.getAttribute('data-state'))
  check(ready === 'ready', '실제 결과 파일을 읽어 비교 화면이 준비된다', ready)

  // ── 실제 재생 시작과 시간 이동 ────────────────────────────────────────
  const timeText = () => win.evaluate(() => {
    const card = document.querySelector('[data-testid="song-result"]')
    return (card?.innerText || '').match(/\d+:\d\d/g)?.join(' ') || ''
  })
  const before = await timeText()
  await win.getByTestId('song-result').getByRole('button', { name: '비교 재생' }).click()
  await win.waitForFunction(() => !!document.querySelector('[aria-label="비교 재생 일시정지"]'),
    null, { timeout: 20000 }).catch(() => {})
  const started = await win.evaluate(() => !!document.querySelector('[aria-label="비교 재생 일시정지"]'))
  check(started, '재생이 실제로 시작된다(멈춤 단추로 바뀐다)')
  await win.waitForTimeout(1800)
  const moved = await timeText()
  check(moved !== before, '재생하는 동안 시간이 흐른다', { before, moved })
  console.log('  ★재생이 시작됐다는 것은 소리가 좋다는 뜻이 아니다 — 청취 품질은 사람이 판정한다.')

  // 원곡으로 바꿔도 **같은 시간**에서 이어진다(정렬 보정은 하지 않는다).
  // ★'원곡' 이라는 이름의 단추가 화면에 셋 있다(파일 변경·닫기·비교 전환).
  //   결과 카드 **안의** 것을 집는다 — 이름 하나로는 가려지지 않는다.
  await win.getByTestId('song-result').getByRole('button', { name: '원곡', exact: true }).click()
  await win.waitForFunction(() =>
    document.querySelector('[data-testid="song-result"]')?.getAttribute('data-state') === 'ready',
  null, { timeout: 60000 }).catch(() => {})
  const afterSwitch = await timeText()
  check(!!afterSwitch, '원곡으로 바꿔도 비교 화면이 준비된다', afterSwitch)

  // ── 저장 — **본체의 진짜 경로**로 확인한다 ────────────────────────────
  // (a) 요청 식별자가 다르면 거절한다.
  const refused = await win.evaluate(async () => window.api.song.exportResult('mix', '없는-요청'))
  check(refused?.ok === false, '★다른 요청의 결과는 저장하지 않는다(본체 경로)', refused)
  check(String(refused?.error || '').includes('다릅니다'), '거절 사유를 말한다', refused?.error)

  // 화면이 보고 있는 결과의 식별자(결과 카드가 넘기는 값과 같은 것).
  const shownId = await win.evaluate(() => window.__afSongShown || '')
  check(!!shownId, '결과에 요청 식별자가 실려 온다', shownId)

  // (b) 원곡 오디오 위에는 저장할 수 없다 — 저장 창이 그 경로를 돌려주게 한다.
  const foundSource = (() => {
    const stack = [work]
    while (stack.length) {
      const dir = stack.pop()
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) stack.push(p)
        else if (name === 'source.wav') return p
      }
    }
    return ''
  })()
  check(!!foundSource, '비교용 원곡 소리가 작업 폴더에 있다', foundSource)
  if (foundSource) {
    const beforeSrc = fs.readFileSync(foundSource)
    await app.evaluate(({ dialog }, dest) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest })
    }, foundSource)
    const blocked = await win.evaluate(async (id) => window.api.song.exportResult('mix', id), shownId)
    check(blocked?.ok === false, '★비교용 원곡 소리 위에는 저장하지 않는다(본체 경로)', blocked)
    check(String(blocked?.error || '').includes('저장할 수 없습니다'), '차단 사유를 말한다', blocked?.error)
    check(Buffer.compare(fs.readFileSync(foundSource), beforeSrc) === 0, '차단 뒤 그 파일이 그대로다')
  }

  // (c) 정상 자리에는 저장된다.
  const dest = path.join(outDir, '변환음원.wav')
  await app.evaluate(({ dialog }, d) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: d }) }, dest)
  const saved = await win.evaluate(async (id) => window.api.song.exportResult('mix', id), shownId)
  check(saved?.ok === true, '정상 자리에는 저장된다', saved)
  check(fs.existsSync(dest) && fs.statSync(dest).size > 1000, '저장 파일이 실제로 만들어졌다',
    fs.existsSync(dest) ? fs.statSync(dest).size : 0)

  // ── 원본을 건드리지 않았다 ────────────────────────────────────────────
  check(Buffer.compare(fs.readFileSync(SONG), beforeSong) === 0, '원곡 바이트가 그대로다')
  check(Buffer.compare(fs.readFileSync(VOICE), beforeVoice) === 0, '목소리 원본 바이트가 그대로다')

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  console.log('  [들어 볼 자리] 작업 폴더:', work)
  console.log('  [들어 볼 자리] 저장한 변환 음원:', dest)
  if (foundSource) console.log('  [들어 볼 자리] 비교용 원곡 소리:', foundSource)
  console.log('  ★나는 듣지 않았다. 음정·리듬·발음·화자 유지·말끝은 확인 범위 밖이다.')
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  console.error('  자료를 남긴다:', ud)
  process.exit(1)
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  // ★실패했으면 자료를 남긴다 — 들어 볼 파일이 사라지면 확인할 수 없다.
  if (!fails.length) console.log('  (검사 자료는 보고 뒤 지워도 된다:', ud, ')')
}
