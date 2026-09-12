// 일괄 생성 안내와 **잘못 나타나던 공용 실행 화면** — 표적 확인.
//
// 소리를 **새로 만들지 않는다.** 저장소 fixture 음성을 이미 만든 생성본처럼 얹고 본다.
//
//   1) '텍스트 추출 시작' 이 작업실에 나오지 않는다. 다른 모드에서는 그대로 나온다.
//   2) 일괄 생성 단추의 이름·설명과, 누르기 전에 보이는 **대상 문장 번호와 이유**
//   3) 새 생성본이 생겼는데 자동 선택되지 않은 경우를 **문장에도 결과 목록에도** 알린다
//   4) 목소리 준비 중에는 무엇을 하는 중인지 밝힌다
//
// 실행: node test/e2e/lab-batch-and-shell.e2e.mjs   (사전: npm run build. 참조·GPU 불필요)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import { isolatedUserData, cleanupUserData } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const A = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
const B = path.join(APP, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
for (const f of [A, B]) if (!fs.existsSync(f)) { console.error(`fixture 없음: ${path.basename(f)}`); process.exit(2) }

const UD = isolatedUserData()
let failed = 0
const log = (...a) => console.log('[lab-batch]', ...a)
const ok = (c, m, extra = '') => { log(c ? 'PASS' : 'FAIL', m, extra); if (!c) failed++ }

let app = null
try {
  app = await electron.launch({
    args: ['out/main/index.js'], cwd: APP,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD, AF_E2E_SELECT_FILE: A },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore && !!window.__labStore, undefined, { timeout: 30000 })

  // ── 1) 공용 실행 화면이 작업실에 섞여 나오지 않는다 ─────────────────────
  // 원본 파일을 불러온 상태(= 증상이 나오던 상태)로 만든다.
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
  }, A)
  await win.getByTestId('mode-lab').waitFor({ timeout: 30000 })

  // 먼저 다른 모드에서는 예전 그대로인지 본다(덮어 가리지 않았다는 확인)
  await win.getByTestId('mode-transcribe').click().catch(() => {})
  await win.waitForTimeout(600)
  const inTranscribe = await win.evaluate(() => document.body.innerText.includes('텍스트 추출 시작'))
  ok(inTranscribe, '텍스트 추출 모드에서는 그 실행 버튼이 그대로 있다')

  await win.getByTestId('mode-lab').click()
  await win.waitForTimeout(800)
  const inLab = await win.evaluate(() => document.body.innerText)
  ok(!inLab.includes('텍스트 추출 시작'), '작업실에는 "텍스트 추출 시작" 이 나오지 않는다')
  ok(!inLab.includes('음악 분리 시작') && !inLab.includes('트랙 분할 시작'),
    '다른 모드의 실행 버튼도 섞여 나오지 않는다')
  ok(await win.getByTestId('lab-bottom-bar').count() === 1,
    '작업실의 실행·진행·취소는 작업실 막대 안에 있다')

  // ── 4) 목소리 준비 중 안내 ──────────────────────────────────────────────
  await win.evaluate(() => window.__labStore.getState().setVoice('C:/voice/A.wav', 'A'))
  await win.waitForTimeout(500)
  const preparing = await win.getByTestId('lab-status').textContent()
  ok((preparing || '').includes('참조 음성의 말을 분석하고 있습니다'),
    '목소리 준비 중에 무엇을 하는 중인지 밝힌다', `"${(preparing || '').trim()}"`)

  // ── 2) 일괄 생성 — 이름·설명·대상 ───────────────────────────────────────
  // 준비가 끝난 것으로 두고(분석은 돌리지 않는다) 대본을 얹는다.
  await win.evaluate(([a, b]) => {
    const s = window.__labStore.getState()
    s.setRef({ clip: a, region: null, phase: 'ready', message: '', reqId: s.ref.reqId })
    s.setDoc({
      voicePath: a, voiceLabel: 'A',
      lines: [
        { id: 'ln_1', text: '하나입니다.', adoptedTakeId: 'tk_1',
          takes: [{ id: 'tk_1', path: a, text: '하나입니다.', voiceKey: a, createdAt: 1 }] },
        { id: 'ln_2', text: '둘입니다.', takes: [], adoptedTakeId: null },
        { id: 'ln_3', text: '셋으로 고쳤습니다.', adoptedTakeId: 'tk_3',
          takes: [{ id: 'tk_3', path: b, text: '셋입니다.', voiceKey: a, createdAt: 1 }] },
      ],
      settings: s.doc.settings, updatedAt: Date.now(),
    })
    s.markLoaded()
  }, [A, B])
  await win.waitForTimeout(600)

  const batch = win.getByTestId('lab-generate-changed')
  const label = (await batch.textContent() || '').trim()
  ok(label === '필요한 문장 생성 (2개)', '단추 이름이 "필요한 문장 생성 (N개)" 다', `"${label}"`)
  ok(await batch.getAttribute('title')
     === '아직 음성이 없거나 대사·목소리를 바꾼 문장의 음성을 만듭니다.', '설명 툴팁이 붙는다')

  const status = (await win.getByTestId('lab-status').textContent() || '').trim()
  ok(status.includes('음성을 다시 만들어야 하는 문장'), '"준비 안 된 자리" 대신 설명으로 알린다', `"${status}"`)
  ok(status.includes('2번(아직 음성 없음)') && status.includes('3번(대사 바뀜)'),
    '누르기 전에 대상 문장 번호와 이유를 보여 준다', `"${status}"`)

  // 목소리를 바꾼 경우의 사유도 같은 자리에 나온다
  await win.evaluate(() => window.__labStore.getState().setDoc({
    ...window.__labStore.getState().doc, voicePath: 'C:/voice/다른목소리.wav', updatedAt: Date.now(),
  }))
  await win.waitForTimeout(500)
  const s2 = (await win.getByTestId('lab-status').textContent() || '')
  ok(s2.includes('목소리 바뀜'), '목소리를 바꾼 문장도 사유가 나온다', `"${s2.trim().slice(0, 80)}"`)

  // ── 3) 새 생성본이 자동 선택되지 않은 경우를 알린다 ─────────────────────
  await win.evaluate((a) => {
    const s = window.__labStore.getState()
    s.setDoc({ ...s.doc, voicePath: a, updatedAt: Date.now() })       // 원래 목소리로 되돌린다
    s.selectLine('ln_1')
  }, A)
  await win.waitForTimeout(400)
  let lineStatus = (await win.getByTestId('lab-line-status').first().textContent() || '').trim()
  ok(lineStatus === '준비됨', '새 생성본이 없을 때는 "준비됨"', `"${lineStatus}"`)

  await win.evaluate((b) => window.__labStore.getState().addTake('ln_1', {
    id: 'tk_1b', path: b, text: '하나입니다.', voiceKey: window.__labStore.getState().doc.voicePath, createdAt: 9,
  }), B)
  await win.waitForTimeout(500)
  lineStatus = (await win.getByTestId('lab-line-status').first().textContent() || '').trim()
  ok(lineStatus === '새 생성본 있음', '자동 선택되지 않은 새 생성본을 문장에 표시한다', `"${lineStatus}"`)
  const guide = await win.evaluate(() => [...document.querySelectorAll('span')]
    .some((e) => e.textContent === '새 생성본이 있습니다. 사용할 음성을 선택하세요.'))
  ok(guide, '결과 목록에도 "사용할 음성을 선택하세요" 로 알린다')
  const takes = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="lab-take"]')].map((e) => e.getAttribute('data-adopted')))
  ok(takes.join(',') === '1,0', '이전 결과 보존 원칙은 그대로다 — 자동 교체하지 않는다', JSON.stringify(takes))

  // 고르면 표시가 사라진다
  await win.getByTestId('lab-take-adopt').nth(1).click()
  await win.waitForTimeout(400)
  lineStatus = (await win.getByTestId('lab-line-status').first().textContent() || '').trim()
  ok(lineStatus === '준비됨', '고르고 나면 "새 생성본 있음" 이 사라진다', `"${lineStatus}"`)
} catch (e) {
  failed++
  log('FAIL 예외:', e && e.message)
} finally {
  if (app) await app.close().catch(() => {})
  cleanupUserData(UD)
}

log(failed === 0 ? '전부 통과 — 일괄 생성 안내와 공용 화면 분리 확인(음성 생성 없음).' : `실패 ${failed}건`)
process.exit(failed === 0 ? 0 : 1)
