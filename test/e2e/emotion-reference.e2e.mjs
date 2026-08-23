// 감정별 참조 구간 선택 E2E — 실제 합성(Qwen) 없이 파생 클립 수명·게이팅/전송·세션 재구성을 검증한다.
// 빠름(트림만). 실행: node test/e2e/emotion-reference.e2e.mjs  (사전 npm run build)
//
// 커버(계약 §5·§11):
//  - 기본+기쁨+슬픔 3개 파생 클립 동시 유지(각 clipKey 폴더 분리)
//  - 한 감정 재확정 시 타 감정/기본 클립 파일 불변(경로/존재)
//  - 게이팅/전송: 사용 감정만 effective 전송, 미사용 비차단·미전송, 미준비 차단(planEmotionRefs)
//  - 삭제/ reset이 해당/전체 클립만 정리
//  - 앱 재시작 후 Sources+Regions로 effective 재구성(임시 경로 비의존)
//  - 종료 후 refclip 0, resources/ 원본 불변
import { _electron as electron } from 'playwright'
import fs from 'fs'; import path from 'path'; import os from 'os'
import { randomUUID } from 'crypto'
import { cleanupIsolated, snapshotTree, refClipDirs, makeSyntheticWav, cleanupSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
const RES_DIR = path.join(APP, 'resources')
let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요(npm run build)'); process.exit(2) }
// 사용자 미디어 미사용: 이번 실행 전용 synthetic WAV(30s)를 생성해 참조로 쓴다. region 테스트(20~26s)가 ≥26s를
// 요구하므로 짧은 AF_E2E_REFERENCE로 대체하지 않고 항상 30s synthetic을 만든다. finally에서 이 경로만 정리.
const SRC = makeSyntheticWav(path.join(os.tmpdir(), 'af_e2e_synth_' + randomUUID() + '.wav'), 30)

const resBefore = snapshotTree(RES_DIR)
// 격리 폴더에 원본을 default/happy/sad 세 이름으로 복사(경로·basename 구분).
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
const DEF = path.join(ISO, 'default.wav'); fs.copyFileSync(SRC, DEF)
const HAPPY = path.join(ISO, 'happy.wav'); fs.copyFileSync(SRC, HAPPY)
const SAD = path.join(ISO, 'sad.wav'); fs.copyFileSync(SRC, SAD)

const launch = () => electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })

// 감정 clip을 IPC로 직접 트림 + store slot 확정(패널 UI 다중 버튼 클릭 대신 결정적으로 keyed 수명 검증).
async function confirmEmotion(win, emotionId, srcPath, start, dur) {
  return win.evaluate(async ({ id, p, s, d }) => {
    const st = window.__afStore.getState()
    st.registerEmotionRef(id, p)
    const res = await window.api.audio.trimReference(p, s, d, id)
    window.__afStore.getState().setEmotionRefState(id, { clip: res.clip_path, region: { start: s, duration: d }, ready: true })
    return res.clip_path
  }, { id: emotionId, p: srcPath, s: start, d: dur })
}

let capturedHappySource = ''
let capturedHappyRegion = null

// ── Session 1: 3클립 동시 유지 / 재확정 격리 / 게이팅 / 삭제 ──
let app = await launch()
let win = await app.firstWindow()
try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, DEF)
  // 기본 참조: 패널 자동 분석 완료 = '이 구간으로 확정' 버튼 등장(지속시간 하드코딩 대신 의미 기반 대기 — synthetic 길이 무관)
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 30000 })
  await win.getByText('이 구간으로 확정').click({ timeout: 20000 })
  await win.waitForFunction(() => window.__afStore?.getState().ttsRefReady === true, undefined, { timeout: 40000 })
  const defaultClip = await win.evaluate(() => window.__afStore.getState().ttsReferenceClip)
  ok(!!defaultClip && fs.existsSync(defaultClip), `기본 참조 파생 클립 생성(${defaultClip ? path.basename(path.dirname(defaultClip)) : 'none'})`)

  // 감정 기쁨/슬픔 확정(서로 다른 구간)
  const happyClip1 = await confirmEmotion(win, 'happy', HAPPY, 0, 7)
  const sadClip = await confirmEmotion(win, 'sad', SAD, 0, 8)
  ok(fs.existsSync(happyClip1), '기쁨 파생 클립 생성')
  ok(fs.existsSync(sadClip), '슬픔 파생 클립 생성')

  // 3개 동시 유지 + 경로 상이
  const dirs3 = refClipDirs()
  ok(dirs3.length === 3, `파생 클립 폴더 3개 동시 유지(실제 ${dirs3.length})`)
  const uniq = new Set([defaultClip, happyClip1, sadClip].map(p => path.dirname(p)))
  ok(uniq.size === 3, '기본/기쁨/슬픔 클립 폴더 경로가 모두 다름')

  // 한 감정 재확정 → 타 감정/기본 불변
  const happyClip2 = await confirmEmotion(win, 'happy', HAPPY, 20, 6)
  ok(fs.existsSync(happyClip2) && happyClip2 !== happyClip1, '기쁨 재확정 → 새 클립 생성(경로 변경)')
  ok(!fs.existsSync(happyClip1), '기쁨 재확정 → 이전 기쁨 클립만 삭제')
  ok(fs.existsSync(sadClip), '기쁨 재확정 시 슬픔 클립 불변(존재)')
  ok(fs.existsSync(defaultClip), '기쁨 재확정 시 기본 클립 불변(존재)')
  ok(refClipDirs().length === 3, '재확정 후에도 폴더 3개(교체만, 증가 없음)')

  // 게이팅/전송(planEmotionRefs, ProcessButton과 동일 로직)
  const plan = (text) => win.evaluate((t) => window.__afPlanEmotionRefs(t), text)
  // 사용된 감정만 effective 전송
  const p1 = await plan('[기쁨] 안녕\n[슬픔] 아쉽네')
  ok(p1.toSend.happy === happyClip2 && p1.toSend.sad === sadClip && p1.blockedId === null,
    '대사에 쓰인 기쁨/슬픔 → 올바른 effective 클립 전송, 차단 없음')
  // 미사용 감정(등록·준비됐지만 대사에 태그 없음) → 비전송·비차단
  const p2 = await plan('안녕하세요. 평범한 문장입니다.')
  ok(Object.keys(p2.toSend).length === 0 && p2.blockedId === null,
    '미사용 등록 감정은 전송·차단 대상 아님(불변식4)')
  // 미등록 사용 감정(놀람) → 기본 폴백(비전송·비차단)
  const p3 = await plan('[놀람] 어라?')
  ok(Object.keys(p3.toSend).length === 0 && p3.blockedId === null, '미등록 사용 감정 → 기본 폴백(비차단)')

  // 미준비 사용 감정 차단: 화남 source만 등록(미확정)
  await win.evaluate((p) => window.__afStore.getState().registerEmotionRef('angry', p), HAPPY)
  const p4 = await plan('[화남] 뭐라고!')
  ok(p4.blockedId === 'angry' && p4.toSend.angry === undefined, '등록+미준비 사용 감정 → 차단·미전송(불변식3)')
  // 화남 삭제 → 해당 clipKey만 정리, 나머지 유지
  await win.evaluate(() => window.__afStore.getState().removeEmotionRef('angry'))
  ok(fs.existsSync(happyClip2) && fs.existsSync(sadClip) && fs.existsSync(defaultClip) && refClipDirs().length === 3,
    '화남 삭제(파생 없던 slot) 후 기존 3클립 불변')

  // 세션 재구성용 source+region 캡처(effective 임시 경로가 아니라 원본+구간)
  const cap = await win.evaluate(() => {
    const s = window.__afStore.getState().ttsEmotionRefState.happy
    return { source: s.source, region: s.region }
  })
  capturedHappySource = cap.source
  capturedHappyRegion = cap.region
  ok(capturedHappySource === HAPPY && capturedHappyRegion.start === 20 && capturedHappyRegion.duration === 6,
    '재현 근거 = source(원본)+region 캡처(effective 임시 경로 아님)')
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION(session1)', e?.message || String(e))
} finally {
  try { await app.close() } catch { /* ignore */ }
}
// 앱 종료 후 refclip 0(will-quit sweep) + effective 임시 클립은 재시작 후 유효하지 않음
ok(refClipDirs().length === 0, '앱 종료 후 파생 클립 폴더 0(will-quit sweep)')

// ── Session 2: 재시작 후 Sources+Regions로 effective 재구성 / reset 정리 ──
app = await launch()
win = await app.firstWindow()
try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, DEF)
  // 저장돼 있던 source+region으로 effective 재구성(다시 트림) — 이전 세션 임시 경로에 의존하지 않음
  const rebuilt = await win.evaluate(async ({ source, region }) => {
    window.__afStore.getState().registerEmotionRef('happy', source)
    const res = await window.api.audio.trimReference(source, region.start, region.duration, 'happy')
    window.__afStore.getState().setEmotionRefState('happy', { clip: res.clip_path, region, ready: true })
    return res.clip_path
  }, { source: capturedHappySource, region: capturedHappyRegion })
  ok(!!rebuilt && fs.existsSync(rebuilt), '재시작 후 source+region으로 effective 클립 재구성')
  const p5 = await win.evaluate((t) => window.__afPlanEmotionRefs(t), '[기쁨] 다시 안녕')
  ok(p5.toSend.happy === rebuilt && p5.blockedId === null, '재구성된 effective가 전송 대상으로 올바름')
  ok(refClipDirs().length === 1, '재구성 후 파생 클립 1개')

  // reset → 파생 클립 정리 + 감정 상태 초기화(실행 중)
  await win.evaluate(() => window.__afStore.getState().reset())
  const t0 = Date.now()
  while (fs.existsSync(rebuilt) && Date.now() - t0 < 10000) await win.waitForTimeout(300)
  ok(!fs.existsSync(rebuilt), 'reset 후 재구성 클립 실제 삭제')
  const emo = await win.evaluate(() => window.__afStore.getState().ttsEmotionRefState)
  ok(Object.keys(emo).length === 0, 'reset 후 감정 상태 전량 초기화')
} catch (e) {
  failed++; console.log('[e2e] EXCEPTION(session2)', e?.message || String(e))
} finally {
  try { await app.close() } catch { /* ignore */ }
}
ok(refClipDirs().length === 0, '최종 종료 후 파생 클립 폴더 0')
ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
cleanupIsolated(ISO)
cleanupSyntheticWav(SRC)  // 이번 실행이 만든 synthetic 소스만 정리(resources/외부 무접촉)
console.log('[e2e] SUMMARY', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
