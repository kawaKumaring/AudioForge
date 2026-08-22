// 세션 복원 + capability + 지문 IPC 비합성 E2E — 실제 앱을 띄우되 Qwen/ffmpeg를 전혀 실행하지 않는다.
// 검증: (1) store.restoreSession이 TTS mode·pitch·source+region·전사·metadata를 복원하고 source 소실
//        감정만 재지정 필요로 표시, (2) audio:pitch-preflight가 PitchCapability 계약을 반환(mock),
//        (3) audio:fingerprint-reference가 statSync 기반 지문(path|size|mtime)을 반환.
// 실행: node test/e2e/session-restore.e2e.mjs   (사전: npm run build)
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
let failed = 0
const ok = (c, m) => { console.log(c ? '[e2e] PASS' : '[e2e] FAIL', m); if (!c) failed++ }

// synthetic 지문 대상 — 의미 없는 몇 바이트 파일(실제 오디오 아님). fingerprint는 statSync만 쓴다.
const fpDir = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(fpDir, { recursive: true })
const fpFile = path.join(fpDir, 'synthetic.bin')
fs.writeFileSync(fpFile, Buffer.from('not-audio-just-bytes'))

const app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1' } })
const win = await app.firstWindow()
try {
  await win.waitForLoadState('domcontentloaded')

  // (1) store 복원 — synthetic 세션(파일/합성 없이 순수 상태 주입)
  const r = await win.evaluate(async (args) => {
    const store = window.__afStore
    store.getState().reset()
    const session = {
      mode: 'tts', source: 'C:/in/voice.wav',
      metadata: { reference_region: { start: 0, duration: 4 }, requested_engine: 'qwen3' },
      refLiveness: { default: true, happy: true, sad: false },
      options: {
        ttsText: '복원된 대사', ttsPitch: 1.5, ttsEngine: 'qwen3', ttsReferenceOverride: '',
        ttsEmotionRefSources: { happy: 'C:/ref/happy.wav', sad: 'C:/gone/sad.wav' },
        ttsEmotionRefRegions: { happy: { start: 1, duration: 5 } },
        ttsEmotionRefs: { happy: 'C:/ref/happy.wav' },
        ttsReferencePrompts: { default: { manual_text: '기본', mode: 'manual' }, happy: { manual_text: 'h', mode: 'manual' } },
      },
      tracks: [{ name: 'tts', label: 'tts', path: 'C:/out/tts.wav' }],
    }
    store.getState().restoreSession('C:/out', session)
    const st = store.getState()
    // (2) capability + (3) fingerprint IPC (둘 다 ffmpeg/Qwen 미실행)
    const pitchCap = await window.api.audio.pitchPreflight()
    const fp = await window.api.audio.fingerprintReference(args.fpFile)
    const fpMissing = await window.api.audio.fingerprintReference('Z:/definitely/missing.bin')
    return {
      mode: st.mode, pitch: st.ttsPitch, engine: st.ttsEngine, text: st.ttsText,
      refClip: st.ttsReferenceClip, refReady: st.ttsRefReady, refRegion: st.ttsReferenceRegion,
      happyReady: st.ttsEmotionRefState.happy?.ready, sadMsg: st.ttsEmotionRefState.sad?.message,
      promptDefault: st.ttsReferencePrompts.default, promptSad: st.ttsReferencePrompts.sad,
      mdEngine: st.resultMetadata?.requested_engine, status: st.status,
      pitchCap, fp, fpMissing,
    }
  }, { fpFile })

  // (1) 복원 단언
  ok(r.mode === 'tts', 'mode=tts 복원')
  ok(r.pitch === 1.5, `pitch 복원(1.5) → ${r.pitch}`)
  ok(r.engine === 'qwen3', 'engine 복원')
  ok(r.text === '복원된 대사', 'text 복원')
  ok(r.refClip === '', '기본 파생 클립은 비움(§4 stale 방지)')
  ok(r.refReady === true, '기본 원본 직접 사용+살아있음 → 준비됨')
  ok(r.refRegion && r.refRegion.duration === 4, 'metadata reference_region 복원')
  ok(r.happyReady === true, '살아있는 감정(happy) 준비됨')
  ok(r.sadMsg === '원본 다시 지정 필요', 'source 소실 감정(sad)만 재지정 필요 표시')
  ok(r.promptDefault && r.promptDefault.manualText === '기본', 'default 전사 복원(snake→camel)')
  ok(r.promptSad === undefined, 'source 소실 감정 전사는 폐기(stale 방지)')
  ok(r.mdEngine === 'qwen3', 'resultMetadata 복원')
  ok(r.status === 'done', 'status=done')

  // (2) pitch capability 계약(mock — 미probe 기본값)
  ok(r.pitchCap && typeof r.pitchCap.supported === 'boolean', 'PitchCapability.supported boolean')
  ok(['rubberband', 'none', 'unknown'].includes(r.pitchCap.method), `PitchCapability.method 유효 → ${r.pitchCap.method}`)
  ok(r.pitchCap.probed === false, 'mock 단계 → probed:false')

  // (3) fingerprint(statSync)
  ok(typeof r.fp === 'string' && r.fp.split('|').length === 3, `지문 형식 path|size|mtime → ${r.fp.split('|').length}필드`)
  ok(r.fp.includes('|20|'), '지문 size=20바이트 반영')
  ok(r.fpMissing === '', '없는 파일 → 빈 지문')
} finally {
  await app.close()
  try { fs.rmSync(fpDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(failed === 0 ? '[e2e] ALL PASS' : `[e2e] ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
