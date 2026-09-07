// 대조군 — **앱의 원래 경로를 그대로 재현한다.**
//
// job2_dialogue(사용자가 "가장 흡사하고 깨끗하다"고 판정한 것)의 실행 기록:
//   engine qwen3 · Qwen3-TTS-12Hz-0.6B-Base · 24000Hz
//   reference_conditioning_mode = **safe_xvector** · 변환 단계 없음
//
// safe_xvector 는 참조에서 '누구인가'만 뽑아 새로 만든다. 참조의 음향을 재현하지 않으므로
// 참조에 있던 손상도 따라오지 않는다. 지금 사슬은 여기에 변환을 한 단계 더 얹은 것이다.
//
// 이 시험이 답할 것: **오늘 환경에서도 그때처럼 깨끗하게 나오는가.**
//  · 깨끗하게 나오면 → 환경은 그대로고, 차이는 오직 변환 단계다.
//  · 안 나오면 → 환경 자체가 달라진 것이므로 변환기 논의보다 그쪽이 먼저다.
//
// 대사는 우리 사슬에서 쓰던 중립 151자 그대로 — 변환본과 곧바로 비교하기 위해서다.
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
const RES = 'E:/AI_Project/claudeCodeVsCode/apps/development/AudioForge/resources'
const OUT = path.join(APP, '_local', 'experiments', 'baseline-safexvector')
fs.mkdirSync(OUT, { recursive: true })

const PEOPLE = (process.env.AF_PEOPLE || '쵸단,이오몽').split(',')
// 참조가 감정 음성일 때는 **참조와 다른 대사**를 써야 한다 — 참조 대사가 결과에 섞이는 것을
// 피하려면 두 텍스트가 달라야 한다. AF_TEXT2=1 로 두 번째 대사를 고른다.
const TEXTS = {
  a: [
    '내일 오전 아홉 시부터 정기 점검이 시작됩니다.',
    '점검이 진행되는 동안에는 일부 기능을 사용할 수 없습니다.',
    '작업 중인 내용은 미리 저장해 두시기 바랍니다.',
    '예상 소요 시간은 두 시간이며, 상황에 따라 조금 더 걸릴 수 있습니다.',
    '점검이 끝나면 별도로 안내해 드리겠습니다.',
  ],
  b: [
    '창고 정리는 이번 주 금요일까지 마치기로 했습니다.',
    '박스는 크기별로 나눠서 벽 쪽에 쌓아 두면 됩니다.',
    '깨지는 물건은 따로 표시해 주세요.',
    '옮길 물건이 많으면 미리 알려 주시면 사람을 더 부르겠습니다.',
    '끝나고 나면 목록을 한 번 맞춰 보겠습니다.',
  ],
}
const GEN_TEXT = (process.env.AF_TEXT2 ? TEXTS.b : TEXTS.a).join('\n')

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-base-'))
const PORT = 9700 + (process.pid % 40)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = []
const say = (s) => { console.log(s); log.push(s) }

const child = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
  cwd: APP, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: USER_DATA, AF_E2E_CDP_PORT: String(PORT) },
})
let exited = false
child.on('exit', () => { exited = true })
child.stdout.on('data', () => {}); child.stderr.on('data', () => {})
const kill = () => { if (exited || !child.pid) return; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* */ } }

let browser = null
const report = { text: GEN_TEXT, mode: process.env.AF_MODE || 'safe_xvector', results: [] }
try {
  for (let i = 0; i < 480 && !exited; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch { /* */ }
    await sleep(500)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) {
      if (await p.evaluate(() => !!window.api).catch(() => false)) { page = p; break }
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('NO_PAGE')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.api?.audio?.process, null, { timeout: 60000 })
  const st = (fn, a) => page.evaluate(fn, a)
  const wait = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(400) } return false }
  const RAW = '[data-af-tts-editor] textarea'
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)

  const setSource = async (t) => {
    let opened = false
    if ((await count(RAW)) === 0 && (await count('[data-testid="direct-edit-toggle"]')) > 0) {
      await page.click('[data-testid="direct-edit-toggle"]'); await sleep(200); opened = true
    }
    await page.evaluate(([sel, v]) => {
      const ta = document.querySelector(sel)
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, v)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }, [RAW, t])
    await sleep(800)
    if (opened && (await count('[data-testid="direct-edit"][data-open="true"]')) > 0) {
      await page.click('[data-testid="direct-edit-toggle"]'); await sleep(200)
    }
  }

  for (const person of PEOPLE) {
    // 이름에 '/' 가 있으면 경로로 직접 쓴다 — 깨끗한 구간을 지정해 비교하기 위해서다.
    const ref = person.includes('/') ? person : `${RES}/${person}/vocals.wav`
    const tag = person.includes('/') ? path.basename(person, '.wav') : person
    say(`\n=== ${person} — 참조 ${person}/vocals.wav · safe_xvector · 변환 없음 ===`)
    await st(async (p) => {
      const s = window.__afStore
      s.getState().reset()
      s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
      s.getState().setMode('tts')
    }, ref)
    await sleep(1500)
    const ready = await wait(async () => (await st(() => window.__afStore.getState().ttsRefReady)) === true, 180000)
    say(`  참조 준비 ${ready ? 'OK' : '실패'}`)
    if (!ready) { report.results.push({ person: tag, error: 'REF_NOT_READY' }); continue }

    await setSource(GEN_TEXT)
    // job2_dialogue 와 같은 설정으로 맞춘다.
    // 말끝 페이드는 master 와 갈린 항목이라 단독으로 끌 수 있게 했다.
    // process.env 는 브라우저 안에서 못 읽으므로 값으로 넘긴다.
    await st(([tailOff, mode]) => {
      const g = window.__afStore.getState()
      g.setTtsReferencePrompts({})
      g.setTtsReferenceConditioningMode(mode)
      window.__afStore.setState({ ttsSpeakerMode: 'single', ttsPitch: 0.0, ttsSpeed: 1.0,
        ttsSilenceGap: 0.5, ttsEngine: 'auto', ttsSpeakerEmotionRefs: {},
        ...(tailOff ? { ttsTailMode: 'off' } : {}),
        ttsEmotionCandidateSelections: {}, ttsSpeakerEmotionEnabled: {} })
    }, [process.env.AF_TAIL === 'off', process.env.AF_MODE || 'safe_xvector'])
    await sleep(400)
    const before = await st(() => {
      const s = window.__afStore.getState()
      return { mode: s.ttsReferenceConditioningMode, engine: s.ttsEngine, textLen: (s.ttsText || '').length,
        pitch: s.ttsPitch, speed: s.ttsSpeed, gap: s.ttsSilenceGap }
    })
    say(`  설정 ${JSON.stringify(before)}`)

    const t0 = Date.now()
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /음성 합성 시작|합성 시작/.test(x.textContent || ''))
      if (b) b.click()
    })
    await wait(async () => ['done', 'error'].includes(await st(() => window.__afStore.getState().status)), 1800000)
    const after = await st(() => {
      const s = window.__afStore.getState()
      return { status: s.status, error: s.error, outputDir: s.outputDir, tracks: (s.tracks || []).map((t) => t.path) }
    })
    const secs = Math.round((Date.now() - t0) / 1000)
    say(`  결과 ${after.status} (${secs}초) ${after.error || ''}`)
    let meta = null
    if (after.outputDir) {
      const sess = path.join(after.outputDir, 'session.json')
      if (fs.existsSync(sess)) meta = (JSON.parse(fs.readFileSync(sess, 'utf-8')).metadata) || null
      for (const tp of after.tracks) if (fs.existsSync(tp)) fs.copyFileSync(tp, path.join(OUT, `${tag}.wav`))
    }
    const k = (o, key) => (o && o[key] !== undefined ? o[key] : '?')
    say(`  실행기록 모드=${k(meta, 'reference_conditioning_mode_effective')}`
      + ` 엔진=${k(meta, 'actual_engine')} 모델=${String(k(meta, 'model_name')).split('/').pop()}`
      + ` 출력 ${k(meta, 'output_sample_rate')}Hz`)
    report.results.push({ person: tag, before, status: after.status, seconds: secs, metadata: meta })
    await sleep(1200)
  }
} catch (e) {
  say(`FATAL ${e?.stack || e}`)
  report.fatal = String(e?.message || e)
} finally {
  try { await browser?.close() } catch { /* */ }
  kill()
  for (let i = 0; i < 40 && !exited; i++) await sleep(250)
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* */ }
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(report, null, 2), 'utf-8')
  fs.writeFileSync(path.join(OUT, 'run.log'), log.join('\n'), 'utf-8')
  console.log(`\n기록: ${path.join(OUT, 'run.json')}`)
}
