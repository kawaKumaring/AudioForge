// 갈래 2 — 감정 연기 참조로 생성. **GPU 2회, 승인 범위 안에서만.**
//
// 승인된 비교 범위(그대로 지킨다):
//   · 같은 화자·같은 참조 문장의 **일반 / 화남** 발화를 각각 참조로 쓴다.
//   · 생성 대사는 두 조건에서 **동일**하고, **참조 문장과는 다른 중립 문장**이다.
//   · 엔진·모드·속도·음높이·프리셋 등 나머지 설정은 동일하다.
//   · **high_quality_icl** 로 돈다. 이 모드는 경계 정렬에 실패하면 조용히 물러서지 않고
//     ICL_BOUNDARY_ALIGNMENT_FAILED 로 실패한다 — fallback 성공을 성공으로 세지 않기 위해서다.
//   · 자동 추천·감정 후처리 없음. 참조 전사와 생성 대사를 섞지 않는다.
//   · 성공할 때까지 반복하지 않는다. 다른 화자·감정으로 넓히지 않는다. **정확히 2회.**
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
const DATA = path.join(APP, '_local', 'datasets', 'emotiontts')
const OUT = path.join(APP, '_local', 'experiments', 'emotion-ref-20260906')
fs.mkdirSync(OUT, { recursive: true })

// 같은 화자(ema)·같은 참조 문장(1번)의 일반 / 화남.
const CONDITIONS = [
  { name: 'N_neutral_ref', wav: path.join(DATA, 'flat', 'ema00001.wav'), script: path.join(DATA, 'ema', 'script', 'ema00001.txt') },
  { name: 'A_angry_ref', wav: path.join(DATA, 'flat', 'ema00201.wav'), script: path.join(DATA, 'ema', 'script', 'ema00201.txt') },
]
// 생성 대사 — 참조 문장과 다르고, 말 자체에 감정이 실리지 않은 문장.
const GEN_TEXT = '오늘 회의는 오후 세 시에 시작합니다.'

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-emoref-'))
const PORT = 9760 + (process.pid % 30)
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
const report = { generation_text: GEN_TEXT, conditions: [], gpu: null }
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

  for (const cond of CONDITIONS) {
    const refText = fs.readFileSync(cond.script, 'utf-8').replace(/^﻿/, '').trim()
    say(`\n=== ${cond.name} ===`)
    say(`  참조 : ${path.basename(cond.wav)}`)
    say(`  참조 전사(ICL 조건) : ${refText}`)
    say(`  생성 대사 : ${GEN_TEXT}`)

    // 참조를 원본으로 연다. 자동 추천을 쓰지 않으므로 구간을 만들지 않고 원본 그대로 쓴다.
    await st(async (p) => {
      const s = window.__afStore
      s.getState().reset()
      s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
      s.getState().setMode('tts')
    }, cond.wav)
    await page.waitForSelector('[data-testid="dialogue-tabs"]', { timeout: 60000 })
    const ready = await wait(async () => (await st(() => window.__afStore.getState().ttsRefReady)) === true, 120000)

    // 설정 고정 — 두 조건에서 동일. 감정 후처리 없음(음높이 0·속도 1.0·말끝 off).
    await st(([text, rt]) => {
      const g = window.__afStore.getState()
      g.setTtsText(text)
      g.setTtsReferencePrompts({ default: { manualText: rt, promptLang: 'ko', mode: 'manual' } })
      g.setTtsReferenceConditioningMode('high_quality_icl')
      window.__afStore.setState({ ttsSpeakerMode: 'single', ttsPitch: 0.0, ttsSpeed: 1.0,
        ttsEngine: 'auto', ttsTailMode: 'off', ttsSpeakerEmotionRefs: {}, ttsEmotionCandidateSelections: {},
        ttsSpeakerEmotionEnabled: {}, ttsEmotionRefState: {} })
    }, [GEN_TEXT, refText])
    await sleep(300)

    const before = await st(() => {
      const s = window.__afStore.getState()
      return { refReady: s.ttsRefReady, rc: s.ttsReferenceConditioningMode, engine: s.ttsEngine,
        text: s.ttsText, pitch: s.ttsPitch, speed: s.ttsSpeed, tail: s.ttsTailMode,
        promptMode: s.ttsReferencePrompts?.default?.mode, refClip: !!s.ttsReferenceClip }
    })
    say(`  설정 : ${JSON.stringify(before)}`)
    if (!ready) { say('  ✗ 참조 준비 실패 — 생성하지 않는다'); report.conditions.push({ ...cond, error: 'REF_NOT_READY', before }); continue }

    const t0 = Date.now()
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /음성 합성 시작|합성 시작/.test(x.textContent || '')); if (b) b.click() })
    const done = await wait(async () => ['done', 'error'].includes(await st(() => window.__afStore.getState().status)), 900000)
    const after = await st(() => {
      const s = window.__afStore.getState()
      return { status: s.status, error: s.error, errorInfo: s.errorInfo, outputDir: s.outputDir,
        tracks: (s.tracks || []).map((t) => t.path) }
    })
    const secs = Math.round((Date.now() - t0) / 1000)
    say(`  결과 : ${after.status} (${secs}초) ${after.error || ''}`)

    let meta = null
    if (after.outputDir) {
      const sess = path.join(after.outputDir, 'session.json')
      if (fs.existsSync(sess)) {
        const s = JSON.parse(fs.readFileSync(sess, 'utf-8'))
        meta = s.metadata || null
      }
      for (const tp of after.tracks) {
        if (fs.existsSync(tp)) fs.copyFileSync(tp, path.join(OUT, `${cond.name}.wav`))
      }
    }
    const key = (m, ...ks) => ks.reduce((o, k) => (o == null ? o : o[k]), m)
    say(`  실행 기록 : 참조=${key(meta, 'effective_reference_path') ? path.basename(String(key(meta, 'effective_reference_path'))) : '?'}`
      + ` · 모드=${key(meta, 'reference_conditioning_mode') ?? '?'}`
      + ` · 장치=${key(meta, 'device') ?? key(meta, 'device_used') ?? '?'}`
      + ` · 종료=${after.status}`)
    report.conditions.push({ name: cond.name, reference: path.basename(cond.wav), reference_text: refText,
      before, after: { status: after.status, error: after.error, seconds: secs },
      metadata: meta, output: fs.existsSync(path.join(OUT, `${cond.name}.wav`)) ? `${cond.name}.wav` : null })
    await sleep(1000)
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
