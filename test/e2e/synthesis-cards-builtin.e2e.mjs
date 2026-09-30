// 기본 목소리(설치된 로컬 모델) — **참조 음원 없이** 실제로 만들어지는가.
//
// ★모형이 아니다. 실제 `audio:process` → PythonRunner → piper 를 탄다.
//   파일을 하나도 열지 않고, 앱을 비운 상태에서 시작한다(명세 4항 ①).
//   쓸 수 있는 기본 목소리가 없는 환경이면 **건너뛴다**(없는 것을 있는 척하지 않는다).
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS, dayFolder } from '../../src/shared/outputLayout.ts'
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
// ★기본값 1.0 과 구별되는 음량으로 시작한다(2026-09-27 검수 3항).
//   1 만 확인하면 앱 음량을 아예 반영하지 않는 구현도 통과한다.
const APP_VOLUME = 0.35
fs.writeFileSync(path.join(ud, 'settings.json'),
  JSON.stringify({ playbackVolume: APP_VOLUME }), 'utf-8')

/**
 * 재생이 시작되는 순간의 요소를 엿본다 — 미리듣기 요소는 `new Audio()` 라 **화면에 붙지 않는다.**
 * DOM 질의로는 보이지 않으므로 이 관측이 유일한 증거다(제품 코드는 건드리지 않는다).
 */
const installPlayProbe = (win) => win.evaluate(() => {
  window.__volProbe = []
  window.__playedEls = []
  const orig = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function patched(...a) {
    window.__volProbe.push(this.volume)
    window.__playedEls.push(this)      // 강참조 — 재생이 끝나도 음량을 다시 볼 수 있다
    return orig.apply(this, a)
  }
})

let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: ud, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(20000)
  await win.waitForFunction(() => !!window.__afStore && !!window.__synthesisCards)

  // 쓸 수 있는 기본 목소리가 있는가 — 본체가 설치·구동을 확인해 돌려준다.
  const listed = await win.evaluate(() => window.api.cards.builtinVoices())
  const voices = listed?.data?.voices || []
  if (!voices.length) {
    console.log('SKIP 이 환경에는 쓸 수 있는 기본 목소리가 없습니다 —', JSON.stringify(listed?.data?.skipped || listed?.error))
    await app.close(); cleanupUserData(ud); process.exit(0)
  }
  console.log('  [증거] 기본 목소리:', voices.map((v) => `${v.label}(${v.language}/${v.engineId})`).join(', '))

  // ── 파일을 열지 않고 시작한다 ────────────────────────────────────────
  await win.getByTestId('mode-tts').click()
  check(await win.getByTestId('synthesis-version-tabs').count() === 1, '버전 탭이 보인다')
  check(await win.getByTestId('generation-card').count() === 0, '공통 원본이 없으면 카드도 없다')

  await win.getByTestId('add-generation-card').click()
  await win.getByRole('dialog', { name: '목소리 고르기' }).waitFor()
  check(await win.getByTestId('pick-voice-builtin').count() >= 1, '기본 목소리를 고를 수 있다')
  // ★낭독과 같은 고르기 창(2026-10-01) — 열면 첫 목소리가 골라져 있어 곧바로 들어 보고 확정한다.
  check(await win.getByTestId('pick-voice-builtin').first().getAttribute('aria-checked') === 'true', '★열자마자 첫 목소리가 골라져 있다')
  check(await win.getByTestId('pick-voice-confirm').isEnabled(), '★곧바로 확정할 수 있다')
  // ── 고르기 전에 들어 본다 (실제 로컬 엔진) ──────────────────────────
  check(await win.getByTestId('voice-preview').count() >= 1, '고르기 창에서 들어 볼 수 있다')
  await installPlayProbe(win)
  await win.getByTestId('voice-preview').first().click()
  await win.waitForFunction(() => {
    const b = document.querySelector('[data-testid="voice-preview"]')
    return b && (b.textContent.includes('멈춤') || b.textContent.includes('다시'))
  }, null, { timeout: 120000 }).catch(() => {})
  const pv = await win.evaluate(() => {
    const b = document.querySelector('[data-testid="voice-preview"]')
    return { label: b?.textContent?.trim(), title: b?.title || '' }
  })
  check(pv.label === '멈춤', '미리듣기가 실제로 울린다', pv)

  // ── 앱 음량을 따르는가 — **실제 play() 에 들어간 요소로** 확인한다 ───────────
  // ★예전 검사는 DOM 에서 audio 를 찾고 없으면 통과했다(2026-09-27 검수 3항).
  //   미리듣기 요소는 화면에 붙지 않으므로 그 검사는 늘 빈 통과였다. 이제 관측이 없으면 실패한다.
  const played = await win.evaluate(() => ({
    vols: window.__volProbe || [],
    nowVols: (window.__playedEls || []).map((el) => el.volume),
  }))
  check(played.vols.length > 0, '미리듣기가 실제 재생 요소를 거친다(관측 실패는 통과가 아니다)', played)
  check(played.vols.length > 0 && played.vols.every((v) => Math.abs(v - APP_VOLUME) < 0.005),
    `재생 순간의 음량이 앱 음량(${APP_VOLUME})이다 — 기본값 1 이 아니다`, played.vols)

  // 재생 중 음량을 바꾸면 **울리고 있는 요소**에 즉시 반영된다.
  const LIVE = 0.62
  const live = await win.evaluate(async (v) => {
    const el = (window.__playedEls || [])[0]
    if (!el) return { changed: null }
    const before = el.volume
    await window.__afSetPlaybackVolume(v)
    return { before, after: el.volume }
  }, LIVE)
  check(live.changed !== null && Math.abs(live.after - LIVE) < 0.005,
    '재생 중 음량 변경이 울리고 있는 요소에 반영된다', live)
  await win.evaluate((v) => window.__afSetPlaybackVolume(v), APP_VOLUME)
  const before = await win.evaluate(() => ({
    cards: window.__synthesisCards.getState().cards.length,
    takes: window.__synthesisCards.getState().cards[0]?.takes.length ?? 0,
  }))
  check(before.cards === 0 && before.takes === 0, '미리듣기가 카드·생성본을 만들지 않는다', before)

  await win.getByTestId('pick-voice-builtin').first().click()
  await win.getByTestId('pick-voice-confirm').click()
  await win.getByTestId('generation-card').first().waitFor()

  const card = await win.evaluate(() => {
    const c = window.__synthesisCards.getState().cards[0]
    return { builtin: c.builtin?.modelId ?? null, source: c.source, label: c.label }
  })
  check(card.builtin === voices[0].modelId, '카드가 고른 기본 목소리를 가진다', card)
  check(card.source === null, '기본 목소리 카드에 가짜 참조 파일이 없다', card)
  check(await win.getByTestId('compact-voice-wave').count() === 0, '없는 파형을 그리지 않는다')

  // ── 실제로 만든다 ────────────────────────────────────────────────────
  check(await win.getByTestId('voice-preview').count() === 1, '카드에서도 들어 볼 수 있다')
  const takesBefore = await win.evaluate(() => window.__synthesisCards.getState().cards[0].takes.length)
  await win.getByTestId('voice-preview').first().click()
  await win.waitForTimeout(1500)
  const takesAfter = await win.evaluate(() => window.__synthesisCards.getState().cards[0].takes.length)
  check(takesAfter === takesBefore, '카드 미리듣기가 생성본을 늘리지 않는다', { takesBefore, takesAfter })
  await win.getByTestId('voice-preview').first().click()   // 멈춘다

  await win.getByTestId('card-script').first().fill('안녕하세요. 기본 목소리로 읽습니다.')
  await win.waitForTimeout(300)
  check(await win.getByTestId('card-generate').first().isEnabled(),
    '참조가 없어도 생성 단추가 열린다',
    await win.evaluate(() => document.querySelector('[data-testid="card-generate"]')?.title))

  await win.getByTestId('card-generate').first().click()
  await win.waitForFunction(() => !window.__synthesisCards.getState().job, null, { timeout: 180000 }).catch(() => {})
  const after = await win.evaluate(() => {
    const c = window.__synthesisCards.getState().cards[0]
    return {
      takes: c.takes.length, path: c.takes[0]?.path ?? null,
      voice: c.takes[0]?.voice ?? null, text: c.takes[0]?.text ?? null,
      notice: (document.querySelector('[role="status"]')?.textContent || '').trim(),
    }
  })
  check(after.takes === 1, '생성본이 하나 붙는다', after)
  check(!!after.path && fs.existsSync(after.path) && fs.statSync(after.path).size > 1000,
    '실제 소리 파일이 만들어졌다', { path: after.path, bytes: after.path && fs.existsSync(after.path) ? fs.statSync(after.path).size : 0 })
  check(after.voice?.kind === 'builtin' && after.voice?.modelId === voices[0].modelId,
    '생성본에 그때의 기본 목소리가 남는다', after.voice)
  check(after.text === '안녕하세요. 기본 목소리로 읽습니다.', '생성본에 그때 대사가 남는다', after.text)
  // ★원본 파일 옆이 아니라 앱이 관리하는 자리에 쌓인다(원본이 없으므로).
  //   자리 규칙은 `doc/folder-rules.md` 와 `src/shared/outputLayout.ts` 가 갖는다 —
  //   2026-09-28 에 `cardOutput` 한 칸에서 `AudioForge_output/<기능>/<날짜>/<시각_이름>`
  //   으로 바뀌었다. 검사도 **그 규칙을 그대로** 본다(글자 하나를 외우지 않는다).
  const madePath = (after.path || '').replace(/\\/g, '/')
  // ★앱과 **같은 함수**로 날짜 칸을 만든다. UTC 로 따로 계산하면 자정 무렵에 하루가 어긋난다.
  const day = dayFolder(new Date())
  check(madePath.includes(`/${OUTPUT_ROOT_DIRNAME}/${FEATURE_FOLDERS.tts}/`),
    '앱이 관리하는 결과 폴더에 쌓인다', after.path)
  check(madePath.includes(`/${FEATURE_FOLDERS.tts}/${day}/`),
    '날짜 칸 아래에 쌓인다', after.path)
  check(madePath.startsWith(APP.replace(/\\/g, '/') + '/'),
    '★앱이 도는 자리 안이다 — 시스템 드라이브가 아니다', after.path)

  console.log('RESULT', passed, 'checks ·', fails.length, 'fail')
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
} catch (e) {
  console.error('예외:', e?.stack || e?.message || e)
  process.exit(1)
} finally {
  if (app) await app.close()
  cleanupUserData(ud)
}
