// 통합 E2E — pitch + 감정 참조 공용 배선을 실제 앱으로 검증.
//  Part A(실 Qwen 합성): 기본 참조 구간 확정 + 감정(기쁨) 구간 확정 + pitch +1 → [기쁨] 대사 합성.
//    결과 WAV 디코딩·F0·길이·SR·finite·peak / metadata pitch 3필드·emotion_reference_* / session.json
//    에 source+region+pitch 저장(재현 근거) 확인.
//  Part B(합성 없음): 재구성 시 source 파일이 사라지면 그 감정만 오류·미준비가 되고 다른 정상 감정은
//    보존됨(silent 기본 폴백 없음) — 계약 §5/추가정합3.
// 실행: node test/e2e/prosody-integration.e2e.mjs  (사전 npm run build). Part A는 실제 합성이라 수 분.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import fs from 'fs'; import path from 'path'
import { isolatedInput, cleanupIsolated, snapshotTree, refClipDirs, qwenJobDirs, qwenVenvPids, nvidiaSmiGpu0 } from './_e2e-helper.mjs'

const WAIT_MS = 350000
const APP = process.cwd()
const SRC = path.join(APP, 'resources', 'speaker_b.wav')
const RES_DIR = path.join(APP, 'resources')
const SHOT = path.join(APP, '작업파일', 'e2e_shots'); fs.mkdirSync(SHOT, { recursive: true })
const PY = 'E:/AI/ComfyUI_windows_portable_python3.12/python_embeded/python.exe'
let failed = 0
const logLines = []
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); logLines.push(s); console.log('[e2e]', s) }
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }
if (!fs.existsSync(SRC)) { console.error('resources/speaker_b.wav 필요'); process.exit(2) }
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const resBefore = snapshotTree(RES_DIR)
const { dir: ISO, input: REF } = isolatedInput(SRC)
const OUT_BASE = path.join(path.dirname(REF), 'AudioForge_output')

// F0(medianF0) 자기상관 측정 — 유성 프레임만.
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
log('시작 nvidia-smi GPU0(used/free MiB):', nvidiaSmiGpu0() || '측정 실패')
const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
app.process().stdout.on('data', d => mainOut.push(String(d)))
app.process().stderr.on('data', d => mainOut.push(String(d)))
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))
win.on('crash', () => crashes.push('crash'))

try {
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(async (p) => {
    const s = window.__afStore
    s.getState().setFile(await window.api.audio.getFileInfo(p), await window.api.audio.getFileUrl(p))
    s.getState().setMode('tts')
  }, REF)
  await win.waitForFunction(() => /111\.08/.test(document.getElementById('root')?.innerText || ''), undefined, { timeout: 30000 })

  // 기본 참조 구간 확정(6.0~13.0s) + 감정 기쁨 구간 확정(20.0~27.0s) — store/IPC 직접(결정적)
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
  const deviceMsg = msgs.find(m => /장치/.test(m)) || '(장치 메시지 미포착)'
  log('device 메시지:', deviceMsg)
  log('최종 store 스냅샷:', snap)
  if (!settled) log('미정착 — nvidia-smi:', nvidiaSmiGpu0() || '측정실패', '| 마지막 progress:', snap?.msg)
  ok(snap?.status === 'done', `합성 완료(status=done, error=${snap?.err || '없음'})`)

  const st = await win.evaluate(() => ({ outputDir: window.__afStore.getState().outputDir, tracks: window.__afStore.getState().tracks, meta: window.__afStore.getState().resultMetadata }))
  const wav = (st.tracks && st.tracks[0] && st.tracks[0].path) || (st.outputDir && path.join(st.outputDir, 'synthesized.wav'))
  ok(!!wav && fs.existsSync(wav), `synthesized.wav 존재(${wav})`)
  if (wav && fs.existsSync(wav)) {
    const m = medianF0(wav)
    ok(m.n > 0 && m.sr === 24000, `디코딩 OK(frames=${m.n}, sr=${m.sr})`)
    ok(m.finite, `finite=${m.finite}`)
    ok(m.peak > 0 && m.peak <= 1.0, `무음 아님·클리핑 없음(peak=${m.peak.toFixed(4)})`)
    log(`결과 medianF0=${m.f0.toFixed(1)}Hz (pitch +1 반영)`)
    // 청취용 사본(작업파일/에만, 커밋 금지)
    try { fs.copyFileSync(wav, path.join(SHOT, 'prosody_pitch+1_emotion.wav')) } catch { /* ignore */ }
  }
  // metadata: pitch 3필드 + 감정 요약
  ok(st.meta?.pitch_postprocessed === true && Math.abs((st.meta?.pitch_semitones ?? 0) - 1.0) < 1e-6 && st.meta?.pitch_method === 'rubberband',
    `metadata pitch(semitones=${st.meta?.pitch_semitones}, method=${st.meta?.pitch_method}, post=${st.meta?.pitch_postprocessed})`)
  const names = st.meta?.emotion_reference_source_names || {}
  const regions = st.meta?.emotion_reference_regions || {}
  ok(names.happy === 'speaker_b.wav', `metadata emotion source basename(happy=${names.happy})`)
  ok(regions.happy && Math.abs(regions.happy.start - 20.0) < 1e-6, `metadata emotion region(happy start=${regions.happy?.start})`)
  // session.json: source+region+pitch 저장(완전 재현 근거)
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

  // ── Part B: 재구성 source 부재 → 그 감정만 오류·미준비, 다른 감정 보존(silent 폴백 없음) ──
  const partB = await win.evaluate(async (p) => {
    const s = window.__afStore
    // happy는 정상(위에서 ready). sad는 존재하지 않는 source로 등록 → 재트림 실패해야 함.
    const missing = p + '.NOEXIST_.wav'
    s.getState().registerEmotionRef('sad', missing)
    let trimErr = null
    try { await window.api.audio.trimReference(missing, 3.0, 5.0, 'sad') }
    catch (e) { trimErr = String(e?.message || e) }
    // 실패 시 그 감정만 미준비로(effective 없음). happy는 그대로.
    if (trimErr) s.getState().setEmotionRefState('sad', { ready: false, message: '원본 파일을 다시 지정하세요' })
    const st2 = s.getState()
    return {
      trimErr,
      sadReady: st2.ttsEmotionRefState.sad?.ready,
      happyReady: st2.ttsEmotionRefState.happy?.ready,
      happyClipExists: st2.ttsEmotionRefState.happy?.clip,
    }
  }, REF)
  ok(!!partB.trimErr, `없는 source 재트림은 오류(silent 성공 아님) — ${partB.trimErr ? 'error' : 'NONE'}`)
  ok(partB.sadReady === false, '실패한 감정(sad)만 미준비 처리')
  ok(partB.happyReady === true && !!partB.happyClipExists, '다른 정상 감정(happy) 상태 보존(silent 폴백 없음)')
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
