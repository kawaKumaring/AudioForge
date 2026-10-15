'use strict'
// 음성 처리 엔진 — 개발툴 MCP 로 실제 앱(화면 오디오 엔진)에서 확인한다. 합성 신호만 쓴다(사용자 음성 없음).
// 확인: 저장 렌더의 길이·시간 맞춤(지연 보정), 리미터 상한, 노이즈 제거, 치찰음 줄이기, 리버브 꼬리, 실시간 연결의 미터.
const assert = require('node:assert/strict')
const { McpClient } = require('../../tools/mcp/client.cjs')

const PROBE = `(async () => {
  const fx = window.__afVoiceFx
  if (!fx) return { error: 'no __afVoiceFx' }
  const SR = 48000, sec = 2
  const mk = (fn) => { const b = new AudioBuffer({ numberOfChannels: 1, length: SR * sec, sampleRate: SR }); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = fn(i, i / SR); return b }
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 * 2 - 1 }
  const peak = (b) => { let m = 0; for (let c = 0; c < b.numberOfChannels; c++) for (const v of b.getChannelData(c)) m = Math.max(m, Math.abs(v)); return m }
  const rms = (d, a, z) => { let s = 0; for (let i = a; i < z; i++) s += d[i] * d[i]; return Math.sqrt(s / (z - a)) }
  const off = { denoise: { on: false }, highpass: { on: false }, eq: { on: false }, compressor: { on: false }, deesser: { on: false }, reverb: { on: false }, limiter: { on: false } }
  const out = {}
  // 1) 모두 끔 → 원래 소리와 같아야 한다(시간 맞춤 포함)
  const click = mk((i) => (i === 24000 ? 0.5 : 0))
  let r = await fx.renderVoiceFx(click, off)
  const d0 = r.buffer.getChannelData(0); out.bypassClickAt = d0.indexOf(Math.max(...d0)); out.bypassLen = r.buffer.length
  // 2) 리미터만 → 클릭 자리가 그대로(지연 보정), 1.5 크기 사인은 상한 아래로
  r = await fx.renderVoiceFx(click, { ...off, limiter: { on: true, ceilingDb: -1 } })
  const d1 = r.buffer.getChannelData(0); let at = 0; for (let i = 0; i < d1.length; i++) if (Math.abs(d1[i]) > Math.abs(d1[at])) at = i; out.limiterClickAt = at
  r = await fx.renderVoiceFx(mk((i, t) => 1.5 * Math.sin(2 * Math.PI * 440 * t)), { ...off, limiter: { on: true, ceilingDb: -1 } })
  out.limiterPeakDb = 20 * Math.log10(peak(r.buffer)); out.limiterTruePeakDb = r.info.truePeakDb
  // 3) 노이즈 제거 → 잡음만 있는 소리가 줄어든다
  const noise = mk(() => rnd() * 0.05)
  r = await fx.renderVoiceFx(noise, { ...off, denoise: { on: true } })
  out.denoiseDb = 20 * Math.log10(rms(r.buffer.getChannelData(0), SR * 0.5, SR * 2) / rms(noise.getChannelData(0), SR * 0.5, SR * 2))
  // 4) 치찰음 줄이기 → 8kHz 가 큰 소리에서 줄어든다
  const ess = mk((i, t) => 0.3 * Math.sin(2 * Math.PI * 8000 * t))
  r = await fx.renderVoiceFx(ess, { ...off, deesser: { on: true, freqHz: 6000, thresholdDb: -30, rangeDb: 10 } })
  out.deessDb = 20 * Math.log10(rms(r.buffer.getChannelData(0), SR, SR * 2) / rms(ess.getChannelData(0), SR, SR * 2))
  // 5) 리버브 → 소리가 끝난 뒤에도 꼬리가 남는다, 길이는 decay 만큼 늘어난다
  const burst = mk((i, t) => (t < 0.5 ? 0.3 * Math.sin(2 * Math.PI * 300 * t) : 0))
  r = await fx.renderVoiceFx(burst, { ...off, reverb: { on: true, mix: 0.3, decaySec: 0.8 } })
  out.reverbLen = r.buffer.length; out.reverbTailRms = rms(r.buffer.getChannelData(0), Math.round(SR * 0.6), Math.round(SR * 0.9))
  // 6) 저음 자르기 → 40Hz 가 크게 줄고 1kHz 는 그대로
  const lowHum = mk((i, t) => 0.3 * Math.sin(2 * Math.PI * 40 * t)), mid = mk((i, t) => 0.3 * Math.sin(2 * Math.PI * 1000 * t))
  const hp = { ...off, highpass: { on: true, freqHz: 80 } }
  out.hp40Db = 20 * Math.log10(rms((await fx.renderVoiceFx(lowHum, hp)).buffer.getChannelData(0), SR, SR * 2) / rms(lowHum.getChannelData(0), SR, SR * 2))
  out.hp1kDb = 20 * Math.log10(rms((await fx.renderVoiceFx(mid, hp)).buffer.getChannelData(0), SR, SR * 2) / rms(mid.getChannelData(0), SR, SR * 2))
  // 7) 같은 설정을 두 번 렌더하면 같은 결과(결정적)
  const all = { denoise: { on: true }, highpass: { on: true, freqHz: 80 }, compressor: { on: true }, deesser: { on: true }, reverb: { on: true, mix: 0.03 }, limiter: { on: true } }
  const a = await fx.renderVoiceFx(burst, all), b = await fx.renderVoiceFx(burst, all)
  let diff = 0; const da = a.buffer.getChannelData(0), db = b.buffer.getChannelData(0); for (let i = 0; i < da.length; i++) diff = Math.max(diff, Math.abs(da[i] - db[i]))
  out.repeatMaxDiff = diff
  // 8) 실시간 연결 — 소리를 흘리는 동안 미터가 오고, 값을 바꾸면 바로 반영된다(연결을 다시 만들지 않는다)
  const ctx = new AudioContext({ sampleRate: SR })
  const chain = await fx.createVoiceFxChain(ctx, { ...off, compressor: { on: true, thresholdDb: -20, ratio: 4 } })
  const seen = []
  chain.onMeter((w, db) => seen.push([w, db]))
  const osc = ctx.createOscillator(); osc.frequency.value = 300
  const amp = ctx.createGain(); amp.gain.value = 0.9
  const sink = ctx.createGain(); sink.gain.value = 0                    // 스피커로는 내보내지 않는다
  osc.connect(amp).connect(chain.input); chain.output.connect(sink).connect(ctx.destination)
  osc.start(); await ctx.resume()
  await new Promise((r) => setTimeout(r, 400))
  const before = seen.filter((x) => x[0] === 'compressor').map((x) => x[1])
  chain.set({ ...off, compressor: { on: true, thresholdDb: -6, ratio: 4 } })
  await new Promise((r) => setTimeout(r, 400))
  const after = seen.filter((x) => x[0] === 'compressor').map((x) => x[1])
  out.rtState = ctx.state; out.rtMeters = before.length; out.rtBefore = before.at(-1); out.rtAfter = after.at(-1)
  osc.stop(); chain.dispose(); await ctx.close()
  return out
})()`

;(async () => {
  const c = new McpClient()
  await c.start()
  let count = 0
  const ok = (v, label) => { assert.ok(v, label); count++; console.log('PASS', label) }
  try {
    const s = await c.call('app_start', {})
    if (s.isError) throw new Error(s.text)
    await c.call('ui_wait', { code: '!!window.__afVoiceFx', timeoutMs: 20000 })
    const r = await c.call('js_eval', { code: PROBE })
    const m = r.json?.result ?? r.json
    console.log(JSON.stringify(m))
    assert.ok(m && !m.error, '엔진을 불러오지 못함: ' + r.text.slice(0, 300))
    ok(m.bypassLen === 96000 && m.bypassClickAt === 24000, '모두 끄면 길이·시간이 그대로')
    ok(m.limiterClickAt === 24000, '리미터 지연을 보정해 시간이 맞는다')
    ok(m.limiterPeakDb <= -1 + 1e-3 && m.limiterTruePeakDb <= -1 + 1e-3, '리미터: 실제 최대치가 −1dBTP 이하')
    ok(m.denoiseDb < -6, `노이즈 제거: 잡음이 6dB 넘게 줄었다(${m.denoiseDb.toFixed(1)}dB)`)
    ok(m.deessDb < -5, `치찰음 줄이기: 8kHz 가 5dB 넘게 줄었다(${m.deessDb.toFixed(1)}dB)`)
    ok(m.reverbLen === 96000 + 38400 && m.reverbTailRms > 1e-3, '리버브: 꼬리가 남고 길이가 늘었다')
    ok(m.hp40Db < -10 && Math.abs(m.hp1kDb) < 0.5, `저음 자르기: 40Hz ${m.hp40Db.toFixed(1)}dB, 1kHz ${m.hp1kDb.toFixed(2)}dB`)
    ok(m.repeatMaxDiff === 0, '같은 설정 두 번 렌더 = 같은 결과')
    ok(m.rtState === 'running' && m.rtMeters > 3, `실시간: 소리가 흐르고 미터가 온다(${m.rtMeters}번)`)
    ok(m.rtBefore > 8 && m.rtAfter < m.rtBefore - 5, `실시간: 문턱을 바꾸면 바로 덜 줄인다(${m.rtBefore?.toFixed(1)}→${m.rtAfter?.toFixed(1)}dB)`)
    const errs = await c.call('errors', {})
    console.log('errors:', errs.text.slice(0, 300))
    console.log('RESULT', count, 'checks, 0 fail')
  } finally {
    await c.call('app_stop', {}).catch(() => {})
    await c.close()
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
