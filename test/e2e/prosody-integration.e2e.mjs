// 통합 E2E — pitch + 감정 참조 공용 배선을 실제 앱으로 검증.
//  Session 1(실 Qwen 합성): 기본 참조 구간 확정 + 감정(기쁨) 구간 확정 + pitch +1 → [기쁨] 대사 합성.
//    결과 WAV 디코딩·F0·길이·SR·finite·peak / metadata pitch 3필드·emotion_reference_* / session.json에
//    source+region+pitch 저장. 이어서 Part B: 재구성 시 source 부재면 그 감정만 오류·미준비, 다른 감정 보존.
//  Session 2(앱 재시작, 합성 없음): Session 1의 session.json을 **파일에서 읽어** source+region으로 effective를
//    재구성(이전 세션의 임시 경로에 의존하지 않음) — 계약 §1.2/추가정합3(재시작 복원).
// 실행: node test/e2e/prosody-integration.e2e.mjs  (사전 npm run build). Session 1은 실제 합성이라 수 분.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenJobDirs, qwenVenvPids, nvidiaSmiGpu0, requireE2EReference } from './_e2e-helper.mjs'

const WAIT_MS = 350000
const APP = process.cwd()
const SRC = requireE2EReference()   // 명시 AF_E2E_REFERENCE 단일 권위(speaker_b.wav 하드코딩·fallback 없음)
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '_local', 'artifacts', 'diagnostics', 'e2e-shots'); fs.mkdirSync(SHOT, { recursive: true })
const PY = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[e2e]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
// (참조 자산 검증은 requireE2EReference가 처리 — 경로·내용 미출력)
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')

function medianF0(wav) {
  const out = execFileSync(PY, ['-X', 'utf8', '-c',
    `import soundfile as sf,numpy as np,sys
d,sr=sf.read(sys.argv[1]); m=(d if d.ndim==1 else d.mean(axis=1)).astype(np.float64)
fl=int(sr*0.04); hop=int(sr*0.02); lo=int(sr/400); hi=int(sr/70); f0s=[]
for i in range(0,max(0,len(m)-fl),hop):
    fr=m[i:i+fl]
    if np.sqrt(np.mean(fr**2))<0.02: continue
    fr=fr-fr.mean(); ac=np.correlate(fr,fr,'full')[fl-1:]
    if hi<len(ac):
        pk=lo+int(np.argmax(ac[lo:hi]))
        if pk>0: f0s.append(sr/pk)
print('OK', len(m), sr, bool(np.all(np.isfinite(m))), float(np.max(np.abs(m))) if len(m) else 0,
      float(np.median(f0s)) if f0s else 0.0)`, wav], { encoding: 'utf-8' }).trim().split('\n').pop()
  const [, n, sr, finite, peak, f0] = out.split(' ')
  return { n: +n, sr: +sr, finite: finite === 'True', peak: +peak, f0: +f0 }
}

const pageErrors = [], crashes = [], mainOut = []
function launchApp() {
  const a = electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
  return a
}
function attach(a, w) {
  a.process().stdout.on('data', d => mainOut.push(String(d)))
  a.process().stderr.on('data', d => mainOut.push(String(d)))
  w.on('pageerror', e => pageErrors.push(e.message))
  w.on('crash', () => crashes.push('crash'))
}

log('시작 nvidia-smi GPU0(used/free MiB):', nvidiaSmiGpu0() || '측정 실패')
let app = await launchApp()
let win = await app.firstWindow()
attach(app, win)
let sess1OutputDir = null

try {
  // ── Session 1: 실 Qwen 합성(pitch +1 + [기쁨] 감정) + Part B ──
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 30000 })  // 참조 분석 완료(지속시간 하드코딩 대신 의미 기반 — AF_E2E_REFERENCE 길이 무관)

  const setup = await win.evaluate(async (p) => {
    const s = window.__afStore
    const base = await window.api.audio.trimReference(p, 6.0, 7.0, 'default')
    s.getState().setTtsRefState({ clip: base.clip_path, region: { start: 6.0, duration: 7.0 }, ready: true, message: '' })
    s.getState().registerEmotionRef('happy', p)
    const emo = await window.api.audio.trimReference(p, 20.0, 7.0, 'happy')
    s.getState().setEmotionRefState('happy', { clip: emo.clip_path, region: { start: 20.0, duration: 7.0 }, ready: true, message: '' })
    s.setState({ ttsText: '[기쁨] 안녕하세요. 오늘 정말 반갑습니다.', ttsPitch: 1.0 })
    return { base: base.clip_path, emo: emo.clip_path }
  }, REF)
  ok(!!setup.base && fs.existsSync(setup.base), `기본 참조 파생 클립 생성(${path.basename(path.dirname(setup.base))})`)
  ok(!!setup.emo && fs.existsSync(setup.emo), `감정(기쁨) 파생 클립 생성(${path.basename(path.dirname(setup.emo))})`)

  await win.getByText('음성 합성 시작', { exact: false }).click({ timeout: 8000 })
  await win.waitForFunction(() => window.__afStore?.getState().status === 'processing', undefined, { timeout: 8000 })
  ok(true, '합성 시작(pitch +1 + [기쁨] 감정 참조)')

  const deadline = Date.now() + WAIT_MS
  let settled = false, snap = null
  const msgs = []
  while (Date.now() < deadline) {
    snap = await win.evaluate(() => { const s = window.__afStore.getState(); return { status: s.status, progress: s.progress, msg: s.progressMessage, err: s.error } })
    if (snap.msg && msgs[msgs.length - 1] !== snap.msg) msgs.push(snap.msg)
    if (['done', 'error'].includes(snap.status)) { settled = true; break }
    await win.waitForTimeout(500)
  }
  log('progress 이력:', msgs)
  log('device 메시지:', msgs.find(m => /장치/.test(m)) || '(미포착)')
  log('최종 store 스냅샷:', snap)
  if (!settled) log('미정착 — nvidia-smi:', nvidiaSmiGpu0() || '측정실패', '| 마지막 progress:', snap?.msg)
  ok(snap?.status === 'done', `합성 완료(status=done, error=${snap?.err || '없음'})`)

  const st = await win.evaluate(() => ({ outputDir: window.__afStore.getState().outputDir, tracks: window.__afStore.getState().tracks, meta: window.__afStore.getState().resultMetadata }))
  sess1OutputDir = st.outputDir
  const wav = (st.tracks && st.tracks[0] && st.tracks[0].path) || (st.outputDir && path.join(st.outputDir, 'synthesized.wav'))
  ok(!!wav && fs.existsSync(wav), `synthesized.wav 존재(${wav})`)
  if (wav && fs.existsSync(wav)) {
    const m = medianF0(wav)
    ok(m.n > 0 && m.sr === 24000, `디코딩 OK(frames=${m.n}, sr=${m.sr})`)
    ok(m.finite, `finite=${m.finite}`)
    ok(m.peak > 0 && m.peak <= 1.0, `무음 아님·클리핑 없음(peak=${m.peak.toFixed(4)})`)
    log(`결과 medianF0=${m.f0.toFixed(1)}Hz (pitch +1 반영)`)
    try { fs.copyFileSync(wav, path.join(SHOT, 'prosody_pitch+1_emotion.wav')) } catch { /* ignore */ }
  }
  ok(st.meta?.pitch_postprocessed === true && Math.abs((st.meta?.pitch_semitones ?? 0) - 1.0) < 1e-6 && st.meta?.pitch_method === 'rubberband',
    `metadata pitch(semitones=${st.meta?.pitch_semitones}, method=${st.meta?.pitch_method}, post=${st.meta?.pitch_postprocessed})`)
  const names = st.meta?.emotion_reference_source_names || {}
  const regions = st.meta?.emotion_reference_regions || {}
  ok(names.happy === path.basename(REF), `metadata emotion source basename(happy=${names.happy})`)
  ok(regions.happy && Math.abs(regions.happy.start - 20.0) < 1e-6, `metadata emotion region(happy start=${regions.happy?.start})`)
  const sess = st.outputDir && path.join(st.outputDir, 'session.json')
  if (sess && fs.existsSync(sess)) {
    const j = JSON.parse(fs.readFileSync(sess, 'utf-8'))
    const opt = j.options || {}
    ok(Math.abs((opt.ttsPitch ?? 0) - 1.0) < 1e-6, `session ttsPitch 저장(${opt.ttsPitch})`)
    ok(opt.ttsEmotionRefSources?.happy === REF, `session ttsEmotionRefSources 원본경로 저장(basename=${opt.ttsEmotionRefSources?.happy ? path.basename(opt.ttsEmotionRefSources.happy) : 'none'})`)
    ok(opt.ttsEmotionRefRegions?.happy?.start === 20.0, `session ttsEmotionRefRegions 저장(start=${opt.ttsEmotionRefRegions?.happy?.start})`)
  } else { ok(false, 'session.json 존재') }
  await win.screenshot({ path: path.join(SHOT, 'prosody_result.png') })
  ok(pageErrors.length === 0 && crashes.length === 0, '완료까지 pageerror/crash 0')

  // Part B: 재구성 source 부재 → 그 감정만 오류·미준비, 다른 감정 보존
  const partB = await win.evaluate(async (p) => {
    const s = window.__afStore
    const missing = p + '.NOEXIST_.wav'
    s.getState().registerEmotionRef('sad', missing)
    let trimErr = null
    try { await window.api.audio.trimReference(missing, 3.0, 5.0, 'sad') } catch (e) { trimErr = String(e?.message || e) }
    if (trimErr) s.getState().setEmotionRefState('sad', { ready: false, message: '원본 파일을 다시 지정하세요' })
    const st2 = s.getState()
    return { trimErr, sadReady: st2.ttsEmotionRefState.sad?.ready, happyReady: st2.ttsEmotionRefState.happy?.ready, happyClip: st2.ttsEmotionRefState.happy?.clip }
  }, REF)
  ok(!!partB.trimErr, `없는 source 재트림은 오류(silent 성공 아님)`)
  ok(partB.sadReady === false, '실패한 감정(sad)만 미준비 처리')
  ok(partB.happyReady === true && !!partB.happyClip, '다른 정상 감정(happy) 상태 보존(silent 폴백 없음)')

  await app.close()

  // ── Session 2: 앱 재시작 → session.json을 '파일에서 읽어' source+region으로 effective 재구성 ──
  // Session 1이 실패해 session.json이 없으면(sess1OutputDir null) 재구성 검증 불가 → 명시적 실패로 남기고 스킵.
  if (!sess1OutputDir || !fs.existsSync(path.join(sess1OutputDir, 'session.json'))) {
    ok(false, 'Session 2 스킵 — Session 1 합성 실패로 session.json 없음(재구성 검증 불가)')
    throw new Error('Session 1 실패로 Session 2 진행 불가')
  }
  ok(refClipDirs().length === 0, '앱 종료 후 파생 클립 폴더 0(effective 임시 경로는 재시작 후 무효)')
  app = await launchApp()
  win = await app.firstWindow()
  attach(app, win)
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.getByText('이 구간으로 확정').waitFor({ timeout: 30000 })  // 참조 분석 완료(지속시간 하드코딩 대신 의미 기반 — AF_E2E_REFERENCE 길이 무관)

  // 완전 재현 근거는 session.json의 source+region(effective 임시 경로 아님)
  const sjPath = path.join(sess1OutputDir, 'session.json')
  ok(fs.existsSync(sjPath), `재시작 후 이전 session.json 발견(${path.basename(path.dirname(sjPath))})`)
  const sj = JSON.parse(fs.readFileSync(sjPath, 'utf-8'))
  const src = sj.options?.ttsEmotionRefSources?.happy
  const reg = sj.options?.ttsEmotionRefRegions?.happy
  ok(!!src && fs.existsSync(src), `session의 source 파일 존재(재현 가능): ${src ? path.basename(src) : 'none'}`)

  const rebuilt = await win.evaluate(async ({ source, region }) => {
    const s = window.__afStore
    s.getState().registerEmotionRef('happy', source)
    const res = await window.api.audio.trimReference(source, region.start, region.duration, 'happy')
    s.getState().setEmotionRefState('happy', { clip: res.clip_path, region, ready: true })
    const plan = window.__afPlanEmotionRefs('[기쁨] 다시 안녕하세요.')
    return { clip: res.clip_path, planHappy: plan.toSend.happy, blockedId: plan.blockedId }
  }, { source: src, region: reg })
  ok(!!rebuilt.clip && fs.existsSync(rebuilt.clip), '재시작 후 session.json의 source+region으로 effective 재구성')
  ok(rebuilt.planHappy === rebuilt.clip && rebuilt.blockedId === null, '재구성된 effective가 전송 대상으로 올바름')
} catch (e) {
  failed++; log('EXCEPTION', e?.message || String(e))
  try { await win.screenshot({ path: path.join(SHOT, 'prosody_FAIL.png') }) } catch { /* ignore */ }
} finally {
  try { await app.close() } catch { /* ignore */ }
  const pids = qwenVenvPids()
  ok(pids.length === 0, `종료 후 Qwen venv 자식 0(잔존=${pids.join(',') || '없음'})`)
  ok(qwenJobDirs(OUT_BASE).length === 0, `종료 후 .qwen-job-* 0`)
  ok(refClipDirs().length === 0, `종료 후 refclip 임시폴더 0`)
  ok(snapshotTree(RES_DIR) === resBefore, 'resources/ 원본 불변')
  cleanupIsolated(ISO)
  fs.writeFileSync(path.join(SHOT, 'prosody_log.txt'), logLines.join('\n') + '\n\n--- main ---\n' + mainOut.join(''), 'utf-8')
}
log('SUMMARY', JSON.stringify({ failed, pageErrors: pageErrors.length, crashes: crashes.length }))
process.exit(failed === 0 ? 0 : 1)
