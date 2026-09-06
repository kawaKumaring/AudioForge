// 사슬의 마지막 고리 — **참조에서 감정도 오는가.**
//
// 목소리 변환으로 "그 인물이 화내는 목소리"를 만들었고 사용자가 확인했다(화남·인물 둘 다).
// 이제 그것을 **참조**로 넣고 **참조에 없던 새 장문 대사**를 생성한다.
//   조건 N : 럭끼의 평소 목소리 2.60초
//   조건 A : 같은 인물의 화난 목소리 2.60초 (seed-vc 변환본)
// 대사·엔진·속도·음높이·프리셋 전부 동일. 참조만 다르다.
//
// 참조 억양이 반영되는 high_quality_icl 로 돈다. 이 모드는 경계를 확정하지 못하면
// 조용히 안전 모드로 물러나지 않고 ICL_BOUNDARY_ALIGNMENT_FAILED 로 실패한다 —
// 다른 방식으로 물러난 결과를 성공으로 세지 않기 위해서다.
// 참조 전사는 앱의 자동 전사에 맡긴다(내가 참조 내용을 알 필요가 없고, 알아서도 안 된다).
import { spawn, execFileSync } from 'child_process'
import { chromium } from 'playwright'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = process.cwd()
const EXP = path.join(APP, '_local', 'experiments', 'seedvc-20260906')
const OUT = path.join(APP, '_local', 'experiments', 'tts-emotion-ref-20260907c')
fs.mkdirSync(OUT, { recursive: true })

// 3차 — **변수를 하나만 남긴다.** 대사는 1차에서 성공했던 151자 중립문으로 되돌리고,
// 참조 길이도 성공했던 2.60초로 통일한다. 다른 것은 참조의 성격뿐이다.
//   N 원본중립 : 1차에서 **성공**한 조건. 대조군.
//   V 변환중립 : 같은 소리를 seed-vc 로 한 번 통과시킨 것(감정 없음, 22050Hz).
//   A 변환화남 : 1차에서 **실패**한 조건.
// V 가 성공하면 원인은 감정이고, V 가 실패하면 원인은 변환 산출물 자체다.
const CONDITIONS = [
  { name: 'N_원본중립', wav: path.join(EXP, 'clean_src', '럭끼_평소_2p6s.wav') },
  { name: 'V_변환중립', wav: path.join(EXP, 'clean_src', '럭끼_중립_변환본_2p6s.wav') },
  { name: 'A_변환화남', wav: path.join(EXP, 'compare_clean', '럭끼.wav') },
]
// 대사 두 벌. AF_TEXT=angry 로 바꿀 수 있다. 기본은 **1차에서 성공했던 151자 중립문** —
// 지금 가리려는 것은 감정 표현이 아니라 **어느 참조가 발행 가드를 통과하는가**이기 때문이다.
const TEXTS = {
  neutral: [
    '내일 오전 아홉 시부터 정기 점검이 시작됩니다.',
    '점검이 진행되는 동안에는 일부 기능을 사용할 수 없습니다.',
    '작업 중인 내용은 미리 저장해 두시기 바랍니다.',
    '예상 소요 시간은 두 시간이며, 상황에 따라 조금 더 걸릴 수 있습니다.',
    '점검이 끝나면 별도로 안내해 드리겠습니다.',
  ],
  // 주제: 바람핀 상대에게 퍼붓는 욕설. 위협조. 감정 차이를 귀로 잡기 쉽게 하려는 용도.
  angry: [
    '야. 너 지금 나한테 뭐라고 했냐?',
    '시발, 내가 진짜 모를 줄 알았지.',
    '좆같네. 몇 번을 믿어줬는데 너 나한테 이러냐.',
    '그년이랑 언제부터야. 말해봐. 어? 왜 말을 못 해.',
    '내가 병신같이 굴었지. 늦는다고 할 때마다 그런가보다 했으니까.',
    '죽고싶냐 진짜. 지금 그 표정은 뭔데.',
    '웃어? 지금 웃음이 나와?',
    '꺼져. 다시는 내 앞에 얼씬거리지 마라.',
    '너 같은 쓰레기한테 쓴 시간이 아까워서 미치겠어.',
  ],
}
const GEN_TEXT = (TEXTS[process.env.AF_TEXT || 'neutral'] || TEXTS.neutral).join('\n')

// AF_ONLY 로 한 조건만 돌린다(진단용 — GPU 를 필요 이상으로 쓰지 않는다).
const ONLY = process.env.AF_ONLY
const RUN = ONLY ? CONDITIONS.filter((c) => c.name === ONLY) : CONDITIONS

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
const report = { generation_text: GEN_TEXT, speaker: '럭끼', conditions: [] }
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

  for (const cond of RUN) {
    say(`\n=== ${cond.name} — 참조 ${path.basename(cond.wav)} ===`)
    await st(async (p) => {
      const s = window.__afStore
      s.getState().reset()
      s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
      s.getState().setMode('tts')
    }, cond.wav)
    await sleep(1500)

    // 새 UX 는 올린 파일 전체를 자동으로 참조로 준비한다(구간 확정 단계가 없다).
    const ready = await wait(async () => (await st(() => window.__afStore.getState().ttsRefReady)) === true, 180000)
    say(`  참조 준비 ${ready ? 'OK' : '실패'}`)

    await setSource(GEN_TEXT)
    // 참조 전사는 비워 둔다 = 앱의 자동 전사(Whisper) -> ICL. 감정 후처리·자동추천은 끈다.
    await st(() => {
      const g = window.__afStore.getState()
      g.setTtsReferencePrompts({})
      g.setTtsReferenceConditioningMode('high_quality_icl')
      window.__afStore.setState({ ttsSpeakerMode: 'single', ttsPitch: 0.0, ttsSpeed: 1.0,
        ttsEngine: 'auto', ttsTailMode: 'off', ttsSpeakerEmotionRefs: {},
        ttsEmotionCandidateSelections: {}, ttsSpeakerEmotionEnabled: {} })
    })
    await sleep(400)

    const before = await st(() => {
      const s = window.__afStore.getState()
      return { refReady: s.ttsRefReady, mode: s.ttsReferenceConditioningMode, engine: s.ttsEngine,
        textLen: (s.ttsText || '').length, pitch: s.ttsPitch, speed: s.ttsSpeed,
        tail: s.ttsTailMode, refClip: !!s.ttsReferenceClip }
    })
    say(`  설정 ${JSON.stringify(before)}`)
    if (!ready) { report.conditions.push({ name: cond.name, error: 'REF_NOT_READY', before }); continue }

    const t0 = Date.now()
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /음성 합성 시작|합성 시작/.test(x.textContent || ''))
      if (b) b.click()
    })
    await wait(async () => ['done', 'error'].includes(await st(() => window.__afStore.getState().status)), 1800000)
    const after = await st(() => {
      const s = window.__afStore.getState()
      return { status: s.status, error: s.error, errorInfo: s.errorInfo,
        outputDir: s.outputDir, tracks: (s.tracks || []).map((t) => t.path) }
    })
    const secs = Math.round((Date.now() - t0) / 1000)
    say(`  결과 ${after.status} (${secs}초) ${after.error || ''}`)

    let meta = null
    if (after.outputDir) {
      const sess = path.join(after.outputDir, 'session.json')
      if (fs.existsSync(sess)) meta = (JSON.parse(fs.readFileSync(sess, 'utf-8')).metadata) || null
      for (const tp of after.tracks) if (fs.existsSync(tp)) fs.copyFileSync(tp, path.join(OUT, `${cond.name}.wav`))
    }
    const k = (o, key) => (o && o[key] !== undefined ? o[key] : '?')
    say(`  실행기록 모드요청=${k(meta, 'reference_conditioning_mode_requested')}`
      + ` 실제=${k(meta, 'reference_conditioning_mode_effective')}`
      + ` 전사출처=${k(meta, 'reference_prompt_source')}`
      + ` 강등=${k(meta, 'reference_prompt_degraded')}`)
    report.conditions.push({ name: cond.name, reference: path.basename(cond.wav), before,
      after: { status: after.status, error: after.error, seconds: secs }, metadata: meta,
      output: fs.existsSync(path.join(OUT, `${cond.name}.wav`)) ? `${cond.name}.wav` : null })
    await sleep(1500)
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
