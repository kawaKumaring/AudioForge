// 작업별 입력·결과와 합성 대본 재사용 UX 회귀. 실제 Electron, 모델·GPU·음성 생성 없음.
// 실행: npm run build 후 node test/e2e/ux-workflow.e2e.mjs
// 모델 IPC만 메인에서 대체한다. 화면 이동·파일 선택·대본 재사용은 실제 사용자 단추로 한다.
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { isolatedUserData, cleanupUserData, makeSyntheticWav } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) {
  console.error('빌드 필요: npm run build')
  process.exit(2)
}
const UD = isolatedUserData()
const SRC = makeSyntheticWav(path.join(UD, 'ux-source.wav'), 8)
const VOICE = makeSyntheticWav(path.join(UD, 'ux-voice.wav'), 8, 24000, 240)
const SHOTS = path.resolve(process.env.AF_E2E_SHOT_DIR || path.join(os.tmpdir(), `audioforge-ux-shots-${Date.now()}`))
fs.mkdirSync(SHOTS, { recursive: true })
const fingerprint = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const sourceBefore = [fingerprint(SRC), fingerprint(VOICE)]
const modes = ['music', 'conversation', 'transcribe', 'split', 'tts', 'dub']
let failed = 0, passed = 0, app = null, win = null
const errors = [], crashes = []
const ok = (value, label) => {
  if (value) passed++; else failed++
  console.log('[ux]', value ? 'PASS' : 'FAIL', label)
}
const settle = async () => {
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
const go = async mode => {
  await win.getByTestId(`mode-${mode}`).click()
  await win.waitForFunction(m => window.__afStore.getState().mode === m, mode)
  await settle()
  if (mode === 'tts' && await win.getByTestId('open-legacy-synthesis').count()) await win.getByTestId('open-legacy-synthesis').click()
}
const capture = async name => {
  // 진입 애니메이션 도중의 투명한 결과를 완성 화면으로 남기지 않는다. 무한 상태 표시는 기다리지 않는다.
  await win.evaluate(() => Promise.all(document.getAnimations()
    .filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
  await win.getByTestId('workspace-content').evaluate(el => { el.scrollTop = 0 })
  return win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
const geometry = async () => win.evaluate(() => {
  const box = id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right }
  }
  const content = document.querySelector('[data-testid="workspace-content"]')
  return { sidebar: box('workspace-sidebar'), shell: box('workspace-shell'), content: box('workspace-content'),
    viewport: innerWidth, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    contentOverflow: content ? content.scrollWidth - content.clientWidth : null }
})

try {
  console.log('[ux] Electron 시작')
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, timeout: 30000,
    env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD,
      AF_E2E_SELECT_FILE: SRC, AUDIOFORGE_NO_WARMUP: '1', HF_HUB_OFFLINE: '1' } })
  console.log('[ux] Electron 연결 완료')
  app.process().stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d) })
  win = await app.firstWindow({ timeout: 30000 })
  win.setDefaultTimeout(10000)
  console.log('[ux] 창 준비')
  // 작업자·모델을 띄울 IPC는 창에서 파일을 고르기 전에 모두 대체한다.
  await app.evaluate(({ ipcMain }, source) => {
    globalThis.__uxCalls = { process: 0, reference: 0, trim: 0 }
    const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    const policy = { engine: 'qwen3', required: { min_sec: 1, max_sec: null },
      recommended: { min_sec: 3, max_sec: 5 }, basis: 'UI 검사', recommended_basis: 'UI 검사' }
    replace('audio:get-file-info', (_e, p) => {
      if (globalThis.__uxFailMetadata) { globalThis.__uxFailMetadata = false; throw new Error('UI 검사: 읽을 수 없는 파일') }
      return { path: p, name: p.split(/[/\\]/).pop(), duration: 8, sampleRate: 24000, channels: 1, format: 'wav' }
    })
    replace('audio:analyze-reference', () => {
      globalThis.__uxCalls.reference++
      return { duration_sec: 8, sample_rate: 24000, channels: 1, needs_region: true,
        too_short: false, valid_whole: false, policy,
        recommend: { ok: true, start_sec: 0, dur_sec: 5 }, peaks: { peaks: [0, 0.1, 0], duration_sec: 8 } }
    })
    replace('audio:trim-reference', (_e, p) => {
      globalThis.__uxCalls.trim++
      return { clip_path: p, policy, metrics: { blocking: [], ready: true,
        effective_region: { start_sec: 0, end_sec: 5, dur_sec: 5 } } }
    })
    replace('audio:transcribe-reference', () => ({ text: '화면 검사를 위한 참조입니다.', language: 'ko' }))
    replace('audio:qwen-preflight', () => ({ available: false, reason: 'UI 검사: 모델 미실행' }))
    replace('audio:pitch-preflight', () => ({ available: false, reason: 'UI 검사: 모델 미실행' }))
    replace('audio:process', () => { globalThis.__uxCalls.process++; throw new Error('UX 검사는 음성을 생성하지 않습니다') })
    replace('audio:process-track', () => { throw new Error('UX 검사는 트랙을 처리하지 않습니다') })
    replace('analysis:analyze', (_e, req) => ({ ok: false, requestId: req?.requestId || '',
      code: 'WORKER_UNAVAILABLE', reason: 'UI 검사: 분석 작업자 미실행' }))
    replace('analysis:prewarm', () => ({ ready: false }))
    replace('analysis:cancel', () => ({ cancelled: true }))
    replace('audio:find-session', () => null)
    globalThis.__uxSource = source
  }, SRC)
  win.on('pageerror', e => errors.push(e.message))
  win.on('crash', () => crashes.push('crash'))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.__afStore && !!window.__labStore, undefined, { timeout: 15000 })
  ok(await app.evaluate(({ app }) => app.getPath('userData')) === UD, '실제 사용자 설정과 분리된 검사 폴더')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850))
  await settle()

  // 파일이 없어도 대본부터 작성할 수 있고 준비 중이라고 거짓 표시하지 않는다.
  await go('tts')
  await win.getByTestId('synthesis-tab-advanced').click()
  ok(await win.getByRole('button', { name: '참조 목소리 파일 바꾸기', exact: true }).isVisible(), '원본 없이 합성 목소리 선택 가능')
  ok((await win.getByTestId('run-hint').textContent()).includes('목소리 미선택'), '입력 없는 상태에서 필요한 다음 행동 안내')
  await win.getByTestId('synthesis-tab-basic').click()
  await go('music')

  // 파일이 없어도 여섯 작업의 진입점과 작업 공간은 같은 자리에 남는다.
  const baseline = await geometry()
  for (const mode of modes) {
    await go(mode)
    const g = await geometry()
    ok(await win.getByTestId('workspace-sidebar').isVisible(), `${mode}: 파일 없이도 작업 목록 표시`)
    ok(g.sidebar && Math.abs(g.sidebar.x - baseline.sidebar.x) < 2
      && Math.abs(g.sidebar.width - baseline.sidebar.width) < 2, `${mode}: 사이드바 위치·폭 유지`)
    ok(g.content && Math.abs(g.content.width - baseline.content.width) < 2, `${mode}: 작업 공간 폭 유지`)
    ok(g.overflow <= 1 && g.contentOverflow <= 1, `${mode}: 가로 넘침 없음`)
  }
  ok((await win.getByTestId('mode-dub').textContent()).includes('노래 변환')
    && (await win.getByTestId('mode-dub').textContent()).includes('개발 중'), '노래 변환의 개발 상태 표시')
  ok(await win.getByTestId('mode-lab').count() === 0, '별도 빈 테스트개발 진입점 미노출')
  await go('music')
  await capture('01-source-empty')
  await win.getByTestId('source-open').click()
  await win.waitForFunction(p => window.__afStore.getState().fileInfo?.path === p, SRC)
  ok((await win.getByTestId('source-card').textContent()).includes('ux-source.wav'), '파일 선택 결과가 원본 카드에 표시')

  // 파형은 실제 local-file 읽기·디코드를 검사한다. 모델 IPC 대체와 별개다.
  const waveReady = async () => win.waitForFunction(() => document.querySelector('[data-testid="source-waveform"]')?.dataset.state === 'ready')
  await waveReady()
  ok((await win.getByTestId('source-waveform').textContent()).includes('0:08'), '실제 원본 길이로 파형 디코드 완료')
  await win.getByTestId('waveform-play').click()
  await win.getByRole('button', { name: '원본 일시정지', exact: true }).waitFor()
  await win.getByTestId('waveform-play').click()
  for (const mode of ['tts', 'music', 'tts', 'conversation', 'music']) { await go(mode); if (mode !== 'tts') await waveReady() }
  ok(await win.evaluate(p => window.__afStore.getState().fileInfo?.path === p, SRC), '합성 첫 진입·왕복 뒤 선택 원본 유지')
  ok(await win.getByTestId('waveform-play').isEnabled(), '합성 왕복 뒤 파형·재생 준비 유지')
  // 정확히 이 테스트가 만든 격리 파일 하나만 잠시 옮겼다가 되돌린다.
  await go('tts')
  const moved = SRC + '.away'
  fs.renameSync(SRC, moved)
  await go('music')
  await win.getByTestId('waveform-error').waitFor()
  ok(await win.getByTestId('waveform-play').isDisabled(), '파일이 사라지면 원인·복구 안내와 재생 잠금')
  ok(!(await win.getByTestId('source-waveform').textContent()).includes('감지된 무음 없음'), '로드 실패를 무음 파일로 오인하지 않음')
  await capture('07-missing-source')
  fs.renameSync(moved, SRC)
  await win.getByTestId('waveform-retry').click()
  await waveReady()
  ok(await win.getByTestId('waveform-play').isEnabled(), '파일 복귀 후 다시 읽기로 정상 복구')

  // 한 모드 결과가 다른 모드에 붙지 않고, 돌아오면 다시 볼 수 있다.
  await win.evaluate(p => {
    const s = window.__afStore.getState()
    s.setProcessing()
    s.setResult([{ name: 'vocals', label: 'UX 결과 보존 확인', path: p }], p.replace(/[/\\][^/\\]+$/, ''))
  }, SRC)
  await win.getByText('UX 결과 보존 확인', { exact: true }).waitFor()
  await app.evaluate(() => { globalThis.__uxFailMetadata = true })
  await win.evaluate(p => window.api.audio.e2eSetSelectFile(p), VOICE)
  await win.getByTestId('source-change').click()
  await win.getByTestId('source-error').waitFor()
  ok(await win.evaluate(p => {
    const s = window.__afStore.getState()
    return s.fileInfo?.path === p && s.status === 'done' && s.resultMode === 'music'
      && s.tracks?.[0]?.label === 'UX 결과 보존 확인'
  }, SRC), '파일 변경 실패 뒤 이전 원본·완료 결과 보존')
  for (const mode of ['conversation', 'transcribe', 'split', 'tts', 'dub']) {
    await go(mode)
    ok(await win.getByText('UX 결과 보존 확인', { exact: true }).count() === 0, `${mode}: 다른 작업 결과 미노출`)
    const wantsSource = ['conversation', 'transcribe', 'split'].includes(mode)
    ok((await win.getByTestId('source-card').count() > 0) === wantsSource, `${mode}: 실제 입력에 맞는 원본 카드`)
  }
  await go('music')
  ok(await win.getByText('UX 결과 보존 확인', { exact: true }).isVisible(), '원래 작업으로 돌아오면 결과 보존')
  await capture('02-source-results')

  await go('tts')
  await win.getByTestId('synthesis-tab-basic').click()
  ok((await win.getByTestId('synthesis-tab-basic').textContent()).includes('문장별 제작'), '문장별 제작 이름으로 작업 방식 안내')
  ok((await win.getByTestId('synthesis-tab-advanced').textContent()).includes('대본·배역 편집'), '대본·배역 편집 이름으로 작업 방식 안내')
  await win.getByTestId('synthesis-tab-basic').focus()
  await win.keyboard.press('ArrowRight')
  ok(await win.getByTestId('synthesis-tab-advanced').getAttribute('aria-selected') === 'true'
    && await win.evaluate(() => document.activeElement?.id === 'synthesis-tab-advanced'), '방향키로 합성 탭 선택과 포커스 이동')
  ok(await win.getByRole('tabpanel').getAttribute('aria-labelledby') === 'synthesis-tab-advanced', '선택한 합성 탭과 작업 패널 연결')
  await win.keyboard.press('Home')
  ok(await win.getByTestId('synthesis-tab-basic').getAttribute('aria-selected') === 'true', 'Home 키로 문장별 제작 복귀')
  await win.waitForFunction(() => window.__labStore.getState().loaded)
  ok(await win.evaluate(() => !window.__labStore.getState().doc.voicePath), '원본을 불러왔어도 별도 목소리를 조용히 덮지 않음')
  await win.getByTestId('lab-use-source-voice').click()
  await win.waitForFunction(p => window.__labStore.getState().doc.voicePath === p, SRC)
  ok((await win.getByTestId('lab-voice-label').textContent()).includes('ux-source.wav'), '현재 원본 사용 클릭이 실제 목소리에 반영')
  await win.evaluate(p => window.api.audio.e2eSetSelectFile(p), VOICE)
  await win.getByTestId('lab-pick-voice').click()
  await win.waitForFunction(p => window.__labStore.getState().doc.voicePath === p, VOICE)
  ok(await win.evaluate(p => window.__afStore.getState().fileInfo?.path === p, SRC), '별도 목소리 선택이 처리할 원본을 바꾸지 않음')

  const line = win.getByTestId('lab-line-input').first()
  await line.fill('문장별 작업에 남겨 둔 대사입니다.')
  // 이미 존재하는 합성본을 두어 대본 재사용이 결과까지 버리지 않는지 확인한다.
  await win.evaluate(p => {
    const s = window.__labStore.getState(), l = s.doc.lines[0]
    s.addTake(l.id, { id: 'ux-kept-take', path: p, text: l.text, voiceKey: s.doc.voicePath, createdAt: 1 })
  }, VOICE)
  await win.evaluate(() => window.__afStore.setState({ ttsText: '배역 편집에 먼저 쓴 대사입니다.', ttsSpeakerMode: 'single' }))
  await win.getByTestId('synthesis-tab-advanced').click()
  ok(await win.getByTestId('source-card').count() === 0
    && await win.getByRole('button', { name: '참조 목소리 파일 바꾸기', exact: true }).count() === 1, '참조 선택은 목소리 단계 한 곳에만 표시')
  ok(await win.getByTestId('tts-settings-toggle').getAttribute('aria-expanded') === 'false', '설정 패널 기본 닫힘')
  ok((await win.getByTestId('run-hint').textContent()).includes('대본'),
    '음악 결과가 남아 있어도 합성 완료로 잘못 안내하지 않음')
  await win.getByTestId('tts-reuse-draft-toggle').click()
  await win.getByTestId('tts-append-sentence-script').click()
  const advancedText = await win.evaluate(() => window.__afStore.getState().ttsText)
  ok(advancedText.startsWith('배역 편집에 먼저 쓴 대사입니다.') && advancedText.includes('문장별 작업에 남겨 둔 대사입니다.'),
    '문장별 대본을 기존 배역 대본 뒤에 추가하며 기존 글 보존')
  await win.getByTestId('tts-reuse-draft-toggle').click()
  await capture('03-script-editor')
  await win.getByTestId('dialogue-right').click()
  ok(await win.getByTestId('dialogue-right').getAttribute('aria-pressed') === 'true', '배역 두 선택지와 현재 선택이 동시에 표시')
  ok(await win.evaluate(() => window.__afStore.getState().ttsText) === advancedText, '여러 명으로 전환해도 대본 원문 보존')
  await capture('08-multiple-speakers')
  await win.getByTestId('dialogue-left').click()
  ok(await win.evaluate(() => window.__afStore.getState().ttsText) === advancedText, '한 명으로 돌아와도 원문 보존')
  await win.getByTestId('tts-settings-toggle').click()
  await win.getByTestId('tts-delivery-settings').locator('summary').click()
  ok(await win.getByRole('region', { name: '말하는 느낌', exact: true }).isVisible(), '말투 조정을 펼치면 기존 표현 설정에 접근')
  await capture('10-settings-open')
  await win.getByTestId('tts-delivery-settings').locator('summary').click()
  await win.getByTestId('tts-settings-toggle').click()
  await win.getByTestId('run-section').scrollIntoViewIfNeeded()
  await win.screenshot({ path: path.join(SHOTS, '09-synthesis-actions.png') })
  await win.getByTestId('synthesis-tab-basic').click()
  ok(await win.evaluate(p => window.__labStore.getState().doc.voicePath === p, VOICE), '왕복 뒤 따로 고른 목소리 유지')
  await win.getByTestId('lab-reuse-draft-toggle').click()
  await win.getByTestId('lab-append-advanced-script').click()
  const sentences = await win.evaluate(() => window.__labStore.getState().doc.lines)
  ok(sentences[0].text === '문장별 작업에 남겨 둔 대사입니다.' && sentences[0].takes.some(t => t.id === 'ux-kept-take'),
    '대본 재사용 후 기존 문장과 생성본 보존')
  ok(sentences.some(l => l.text === advancedText), '배역 없는 대본을 원문 그대로 새 문장에 추가')
  await win.evaluate(() => window.__afStore.setState({ ttsSpeakerMode: 'multi' }))
  ok(await win.getByTestId('lab-append-advanced-script').isDisabled(), '여러 배역 대본을 한 목소리 문장으로 조용히 변환하지 않음')
  await win.evaluate(() => window.__afStore.setState({ ttsSpeakerMode: 'single' }))
  await win.getByTestId('lab-reuse-draft-toggle').click()
  await capture('04-sentence-workspace')

  // 취소 정리·남은 작업자 상태에서는 입력과 이동을 막고 현재 상태를 보여 준다.
  for (const pending of ['processing', 'cancelling', 'childAlive']) {
    await win.evaluate(p => window.__afStore.setState({ status: p === 'childAlive' ? 'error' : p,
      errorInfo: p === 'childAlive' ? { code: 'CANCEL_FAILED', message: 'UI 검사: 작업 종료 대기', childAlive: true } : null }), pending)
    await settle()
    const disabledModes = await Promise.all(modes.map(mode => win.getByTestId(`mode-${mode}`).isDisabled()))
    ok(disabledModes.every(Boolean) && await win.getByTestId('synthesis-tab-advanced').isDisabled()
      && await win.getByTestId('lab-pick-voice').isDisabled(), `${pending}: 작업·합성방식·목소리 변경 잠금`)
    ok(await win.getByTestId('workspace-activity').isVisible(), `${pending}: 작업 상태를 머리말에 표시`)
  }
  await win.evaluate(() => window.__afStore.setState({ status: 'processing', errorInfo: null }))
  await settle()
  await capture('06-work-activity')
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await settle()
  ok(await win.evaluate(() => [...document.querySelectorAll('.workspace-activity > span')]
    .every(el => getComputedStyle(el).animationName === 'none')), '동작 줄이기 설정에서 작업 상태 애니메이션 정지')
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await win.evaluate(() => window.__afStore.setState({ status: 'done', errorInfo: null }))
  await settle()

  // Python planner가 생성한 고정 fixture로 여러 배역 화면도 검사한다(모델은 실행하지 않음).
  const camel = v => Array.isArray(v) ? v.map(camel) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k.replace(/_([a-z])/g, (_,c) => c.toUpperCase()), camel(x)])) : v
  const fixture = camel(JSON.parse(fs.readFileSync(path.join(APP, 'src/shared/fixtures/dialogue-planner-spans.json'), 'utf8')).three_speakers)
  await app.evaluate(({ ipcMain }, f) => {
    ipcMain.removeHandler('analysis:analyze')
    ipcMain.handle('analysis:analyze', (_e, req) => {
      if (req.text !== f.source) return { ok: false, requestId: req.requestId, code: 'WORKER_UNAVAILABLE', reason: 'UI fixture 외 분석 미실행' }
      const plan = { planSchemaVersion: 1, parserVersion: 2, ...f, normalizedSha256: f.sourceSha256, sourceParagraphs: [], emotions: [], sentences: [], chunks: [], structureSha256: f.sourceSha256 }
      return { ok: true, requestId: req.requestId, result: { schemaVersion: 6, requestId: req.requestId,
        sourceSha256: f.sourceSha256, normalizedSha256: f.sourceSha256, plan, tokenizer: 'production',
        characterCount: f.source.length, sourceParagraphCount: 3, segmentCount: 3, productionTokens: 20,
        plannedCalls: 3, splitCapProductionTokens: 379, estimatedAudioSeconds: { min: 2, max: 5 },
        estimatedWallSeconds: null, preparationSeconds: null, confidence: 'insufficient_data', confidenceReason: 'fixture',
        mode: 'qwen3', warnings: [], sourceParagraphs: [], segments: [], chunks: [] } }
    })
  }, fixture)
  await go('tts')
  await win.getByTestId('synthesis-tab-advanced').click()
  await win.getByTestId('dialogue-left').click()
  await win.locator('textarea').first().fill(fixture.source)
  await win.getByTestId('dialogue-right').click()
  await win.getByTestId('dialogue-row').nth(2).waitFor({ state: 'visible' })
  ok(await win.getByTestId('dialogue-row').count() === 3, '권위 있는 planner fixture의 세 대사 표시')
  ok(await win.getByTestId('dialogue-body').first().inputValue() === '안녕', '배역 카드의 대사 좌표 보존')
  const compact = win.getByTestId('compact-voice-wave')
  await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="compact-voice-wave"]')].filter(el => el.dataset.state === 'ready').length === 2)
  ok(await compact.count() === 2, '참조를 가진 인물의 대사에만 실제 파형 표시')
  ok(await compact.first().evaluate(el => el.getBoundingClientRect().height) <= 40, '인물 파형 높이 40px 이하')
  await compact.first().getByTestId('compact-voice-play').click()
  await win.waitForFunction(() => document.querySelector('[data-testid="compact-voice-play"]')?.textContent?.trim() === 'Ⅱ')
  await compact.nth(1).getByTestId('compact-voice-play').click()
  await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="compact-voice-play"]')].filter(el => el.textContent?.trim() === 'Ⅱ').length === 1)
  ok((await compact.first().getByTestId('compact-voice-play').textContent()).trim() === '▶', '다른 인물 파형 재생 시 이전 파형 정지')
  await compact.nth(1).getByTestId('compact-voice-play').click()
  await capture('11-cast-editor')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 720))
  await settle()
  const cg = await geometry()
  ok(cg.overflow <= 1 && cg.contentOverflow <= 1, '인물 파형 800px 창 가로 넘침 없음')
  await capture('12-cast-narrow')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850))
  await win.evaluate(text => window.__afStore.setState({ ttsText: text, ttsSpeakerMode: 'single' }), advancedText)

  // 최소 창 폭에서도 사이드바가 밀리거나 본문이 가로로 잘리지 않는다.
  for (const width of [860, 800]) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 720), width)
    for (const mode of ['music', 'tts', 'dub']) {
      await go(mode)
      if (mode === 'tts') { await win.getByTestId('synthesis-tab-basic').click(); await settle() }
      const g = await geometry()
      ok(g.viewport === width && g.overflow <= 1 && g.contentOverflow <= 1
        && g.sidebar.right <= g.content.x + 1, `${mode}: ${width}px 창에서도 겹침·가로 넘침 없음`)
      if (mode !== 'music') await capture(`05-narrow-${width}-${mode}`)
      if (mode === 'tts') {
        await win.getByTestId('synthesis-tab-advanced').click()
        await settle()
        const advanced = await geometry()
        ok(advanced.overflow <= 1 && advanced.contentOverflow <= 1, `대본·배역 편집: ${width}px 가로 넘침 없음`)
        await capture(`05-narrow-${width}-advanced`)
      }
    }
  }
  ok(await app.evaluate(() => globalThis.__uxCalls.process) === 0, '전체 검사에서 생성 실행 0회')
  ok(errors.length === 0, `페이지 예외 0건${errors.length ? ': ' + errors[0] : ''}`)
  ok(crashes.length === 0, '렌더러 종료 0건')
  ok(fingerprint(SRC) === sourceBefore[0] && fingerprint(VOICE) === sourceBefore[1], '입력 파일 바이트 보존')
} catch (e) {
  failed++
  console.error('[ux] FAIL', e?.stack || String(e)); console.error('page errors', errors)
  if (win) await capture('failure').catch(() => {})
} finally {
  if (app) await app.close().catch(() => {})
  if (!failed) cleanupUserData(UD)
  else console.log('[ux] 실패 진단용 격리 데이터:', UD)
}
console.log(`[ux] 통과 ${passed} · 실패 ${failed}. 모델·GPU·음성 생성 없음.`)
console.log('[ux] 화면:', SHOTS)
process.exitCode = failed ? 1 : 0
