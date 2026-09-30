'use strict'
// AudioForge 개발툴 MCP — **이 앱에 맞춘 것들**을 한곳에 둔다(서버 server.cjs 는 MCP 규약과 앱 켜고 끄기만).
//
// ★왜 따로 두나 (2026-09-30 지시: "해당 툴에 맞게 사용할 수 있도록 개량을 잘하라")
//   AudioForge 는 소리를 다룬다 — AI 는 소리를 들을 수 없다. 작업이 길다(합성·분리). 개인정보 규칙이 엄격하다(사용자 음성·영상은
//   허락한 것만). 그래서 일반 도구(누르기·읽기)만으로는 "지금 무엇이 울리나 · 다 끝났나 · 만든 소리가 제대로인가"를 알 수 없었다.
//   여기 있는 것: 화면 지도 · 상태 한눈에 보기 · 재생 관찰 · 끝날 때까지 기다리기 · 안전한 검사 재료 · 소리 수치 · 개인정보 가드.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'audio')

// ── 화면 지도 — AI 가 매번 더듬지 않게(ModeSelector.tsx 의 작업 목록 · 주요 testid) ──
// 작업 화면 — button:false 는 왼쪽 목록에 단추가 없는 화면(다른 화면에서 들어간다).
const NO_BUTTON = { 'dialogue-rebuild': '대화 분리 결과에서 "대화 구간 편집" 으로 들어간다', lab: '개발 중인 실험실 — 목록에 단추가 없다' }
const MODES = {
  reader: '낭독', tts: '음성 합성', dub: '노래 변환', music: '음악 분리', conversation: '대화 분리',
  transcribe: '텍스트 추출', split: '트랙 분할', 'dialogue-rebuild': '대화 구간 편집', lab: '실험실',
}
const SCREEN_MAP = [
  '화면 지도(AudioForge):',
  '· 작업 고르기: testid mode-<id> — ' + Object.entries(MODES).filter(([k]) => !NO_BUTTON[k]).map(([k, v]) => `${k}(${v})`).join(' · ') + '. app_mode 로 바꾼다. 단추가 없는 화면: ' + Object.entries(NO_BUTTON).map(([k, v]) => `${k} — ${v}`).join(' · ') + '.',
  '· 설정: testid open-app-options → [일반]·[기능 검사](options-checks — 기능마다 check-run-<id>) · 콘솔 켜기 options-console.',
  '· 낭독(reader): reader-add-text(글 파일 — dialog_queue 먼저) · reader-play(읽기/멈춤) · reader-settings(목소리 · reader-voice-builtin/reader-voice-try) · reader-rate(재생 빠르기) · reader-follow · reader-library · reader-paragraph(문단).',
  '· 음성 합성(tts): add-generation-card → pick-voice-builtin(기본 목소리)/pick-voice-file(파일) → generation-card(card-script 대본 · card-generate 만들기 · card-takes 생성본) → join-bar(join-play 이어 듣기 · join-save · card-rate).',
  '· 상태 한눈에: app_state · 소리: audio_now(무엇이 울리나)·audio_inspect(만든 소리 수치) · 긴 작업: wait_idle · 재료: test_input.',
  '· 끌어 놓기로 받는 곳(낭독 책·카드 목소리·노래 변환·실험실·파일 가져오기)은 ui_drop_files · 파형·구간·카드 순서는 ui_pointer(at 비율·drag) · 단축키는 ui_key · 긴 목록은 ui_scroll · 다시 켜서 남는지는 app_restart.',
  '· 화면 결함 점검: ui_audit(이름 없는 단추·이유 없는 비활성·창 밖·가림·잘린 글·작은 글씨·가로 스크롤) — 창 크기를 바꿔 가며.',
].join('\n')

// ── 화면 안에서 쓰는 식들 ──
// 재생 관찰 — 소리 요소가 틀기 시작할 때 붙잡는다(낭독 소리 요소는 화면(DOM)에 없다). 새 문서마다(addInitScript) + 지금 문서.
const MEDIA_HOOK = `(() => {
  if (window.__mcpMedia) return true
  window.__mcpMedia = []
  const orig = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () { if (!window.__mcpMedia.includes(this)) window.__mcpMedia.push(this); if (window.__mcpMedia.length > 50) window.__mcpMedia.shift(); return orig.apply(this, arguments) }
  return true
})()`
const MEDIA_NOW = `(() => {
  // ★먼저 풀고 나서 자른다 — 앱 소리 주소는 역슬래시가 %5C 로 들어 있어 자르고 풀면 전체 경로가 남았다(실측).
  const dec = (s) => { try { return decodeURIComponent(String(s).split('?')[0]) } catch { return String(s) } }
  const name = (s) => dec(s).split(/[\\\\/]/).pop()
  // 앱 안의 파일이면 경로도 준다 — audio_inspect 로 길이·크기를 잴 수 있게(재생 요소의 길이는 늦게 알려지거나 비어 있다).
  const local = (s) => { const d = dec(s); const m = /^(?:local-file|file):\\/\\/\\/?(.*)$/i.exec(d); return m ? m[1] : null }
  return (window.__mcpMedia || []).map((el, i) => ({
    i, file: name(el.currentSrc || el.src), path: local(el.currentSrc || el.src), paused: el.paused, ended: el.ended,
    time: Math.round(el.currentTime * 100) / 100, duration: Number.isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : null,
    rate: el.playbackRate, volume: el.volume, error: el.error ? el.error.code : null,
  })).filter((m) => m.file)
})()`
const STATE = `(async () => {
  const a = window.__afStore?.getState?.() || {}
  const c = window.__synthesisCards?.getState?.()
  const r = window.__readerStore?.getState?.()
  const txt = (sel) => (document.querySelector(sel)?.textContent || '').trim().slice(0, 160) || null
  const book = r ? (r.books || []).find((b) => b.id === r.active) : null
  let busy = ''
  try { busy = await window.api.audio.e2eBusyReason('합성') } catch {}
  const playing = (window.__mcpMedia || []).filter((el) => !el.paused && !el.ended).length
  return {
    mode: a.mode || null, status: a.status || null,
    progress: typeof a.progress === 'number' && a.status === 'processing' ? Math.round(a.progress) : null,
    error: a.error ? String(a.error).slice(0, 200) : null, errorCode: a.errorInfo?.code || null,
    busy: busy || null,
    dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.getAttribute('aria-label') || (d.textContent || '').trim().slice(0, 40)),
    alerts: [...document.querySelectorAll('[role=alert]')].map((d) => (d.textContent || '').trim().slice(0, 160)).filter(Boolean).slice(0, 5),
    cards: c ? { count: (c.cards || []).length, job: c.job ? { cardId: c.job.cardId || null } : null,   // 대본 글(job.text)은 싣지 않는다
      takes: (c.cards || []).map((k) => (k.takes || []).length) } : null,
    reader: r ? { books: (r.books || []).length, book: book ? book.name : null, paragraphs: book ? book.paragraphs.length : null,
      position: book ? book.position : null, voice: r.voice || null, voiceKind: r.pick ? r.pick.kind : null, engine: r.pick ? (r.pick.engineId || null) : null,
      playing: document.querySelector('[data-testid="reader-play"]')?.getAttribute('aria-label') === '낭독 멈추기', state: txt('[data-testid="reader-state"]') } : null,
    audioPlaying: playing,
  }
})()`

// ── 개인정보 가드 — 사용자 미디어는 사용자가 허락한 것만(전역 정책) ──
// 이 도구가 앱에 넘기는 경로가 **검사용 자리 밖의 미디어 파일**이면 막는다. 허락받았으면 userApproved:true 로 다시 부른다.
const MEDIA_EXT = /\.(wav|mp3|flac|m4a|ogg|opus|aac|wma|aiff?|mp4|mkv|mov|avi|webm|m4v|png|jpe?g|webp|gif|bmp|tiff?)$/i
const ABS = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
function allowedRoots (session) {
  return [FIXTURES, path.join(ROOT, '_local', 'tmp'), session && session.tmp].filter(Boolean).map((p) => path.resolve(p).toLowerCase())
}
function isAllowed (p, session) {
  const full = path.resolve(p).toLowerCase()
  return allowedRoots(session).some((r) => full === r || full.startsWith(r + path.sep))
}
/** 값 안의 모든 문자열을 훑어 막을 경로들을 돌려준다. */
function blockedMediaPaths (value, session) {
  const out = []
  const walk = (v, d) => {
    if (d > 8 || v == null) return
    if (typeof v === 'string') {
      for (const m of v.match(/(?:[A-Za-z]:[\\/]|\\\\)[^"'`<>|\r\n]*?\.(?:wav|mp3|flac|m4a|ogg|opus|aac|wma|aiff?|mp4|mkv|mov|avi|webm|m4v|png|jpe?g|webp|gif|bmp|tiff?)\b/gi) || []) {
        if (!isAllowed(m, session)) out.push(m)
      }
      if (ABS.test(v) && MEDIA_EXT.test(v) && !isAllowed(v, session) && !out.includes(v)) out.push(v)
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, d + 1))
    else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, d + 1))
  }
  walk(value, 0)
  return out
}
function guardMedia (value, session, approved) {
  if (approved === true) return
  const bad = blockedMediaPaths(value, session)
  if (bad.length) {
    throw new Error('사용자 미디어 파일로 보이는 경로가 있어 멈췄습니다 — ' + bad.map((b) => path.basename(b)).join(', ') +
      '. 사용자 음성·영상·이미지는 **사용자가 그 파일·그 작업을 명시적으로 허락했을 때만** 쓴다. 허락을 받았으면 userApproved:true 로 다시 부르고, ' +
      '아니면 test_input(검사용 재료)을 쓴다. 허락 없이 쓰는 자리: test/fixtures/audio · _local/tmp · 이 실행의 임시 폴더.')
  }
}

// ── 소리 수치 — WAV 를 직접 읽는다(PCM 16/24/32 · float32) ──
function readWav (file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV 가 아닙니다(RIFF/WAVE 머리 없음) — 이 도구는 WAV 만 잽니다')
  let p = 12, fmt = null, data = null
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4)
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) }
    else if (id === 'data') data = b.subarray(p + 8, Math.min(b.length, p + 8 + size))
    p += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 안에 fmt/data 가 없습니다')
  const bytes = fmt.bits / 8, frames = Math.floor(data.length / (bytes * fmt.channels))
  const mono = new Float32Array(frames)
  const fmtCode = fmt.format === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.format
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let ch = 0; ch < fmt.channels; ch++) {
      const o = (i * fmt.channels + ch) * bytes
      let v
      if (fmtCode === 3 && fmt.bits === 32) v = data.readFloatLE(o)
      else if (fmt.bits === 16) v = data.readInt16LE(o) / 32768
      else if (fmt.bits === 24) v = data.readIntLE(o, 3) / 8388608
      else if (fmt.bits === 32) v = data.readInt32LE(o) / 2147483648
      else throw new Error('지원하지 않는 비트 수: ' + fmt.bits)
      s += v
    }
    mono[i] = s / fmt.channels
  }
  return { fmt, mono }
}
const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity)
function inspectWav (file) {
  const { fmt, mono } = readWav(file)
  const n = mono.length, sr = fmt.rate
  let peak = 0, sum = 0, clipped = 0
  for (let i = 0; i < n; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; sum += mono[i] * mono[i]; if (a >= 0.999) clipped++ }
  const frame = Math.max(1, Math.round(sr * 0.02)), frames = Math.floor(n / frame)
  const SIL = Math.pow(10, -45 / 20)
  const loud = []
  for (let f = 0; f < frames; f++) { let s = 0; for (let i = f * frame; i < (f + 1) * frame; i++) s += mono[i] * mono[i]; loud.push(Math.sqrt(s / frame) >= SIL) }
  const first = loud.indexOf(true), last = loud.lastIndexOf(true)
  // 가장 긴 조용한 틈(말 사이) — 앞뒤 조용함은 빼고
  let longest = 0, run = 0
  for (let f = Math.max(0, first); f <= last; f++) { if (!loud[f]) { run++; longest = Math.max(longest, run) } else run = 0 }
  return {
    file: path.basename(file), seconds: Math.round((n / sr) * 100) / 100, sampleRate: sr, channels: fmt.channels, bits: fmt.bits,
    peakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sum / Math.max(1, n))), clippedSamples: clipped,
    silentRatio: frames ? Math.round((loud.filter((x) => !x).length / frames) * 100) / 100 : null,
    leadingSilenceSec: first < 0 ? null : Math.round(first * frame / sr * 100) / 100,
    trailingSilenceSec: last < 0 ? null : Math.round((frames - 1 - last) * frame / sr * 100) / 100,
    longestGapSec: Math.round(longest * frame / sr * 100) / 100,
    empty: first < 0,
  }
}

// ── 검사 재료 — 사용자 파일 대신 쓰는 것들(이 실행의 임시 폴더 inputs/) ──
function writeTone (file, seconds = 2, freq = 440, rate = 24000) {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}
function appPython () {
  try { const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'externals', 'env.json'), 'utf8')).python; return p && fs.existsSync(p) ? p : null } catch { return null }
}
function writeText (file, content, encoding = 'utf-8') {
  if (encoding === 'utf-8') return fs.writeFileSync(file, content, 'utf8')
  if (encoding === 'utf-8-bom') return fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]))
  if (encoding === 'utf-16le') return fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]))
  if (encoding === 'cp949') {
    // Node 에는 CP949 로 쓰는 길이 없다 — 앱 파이썬으로 쓴다.
    const py = appPython()
    if (!py) throw new Error('CP949 로 쓰려면 앱 파이썬이 필요합니다(externals/env.json)')
    const r = spawnSync(py, ['-X', 'utf8', '-c', 'import sys; open(sys.argv[1],"wb").write(sys.stdin.read().encode("cp949"))', file],
      { input: content, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    if (r.status !== 0) throw new Error('CP949 로 쓰지 못했습니다: ' + (r.stderr || '').slice(-200))
    return
  }
  throw new Error('encoding = utf-8 | utf-8-bom | utf-16le | cp949')
}
function listFixtures () {
  return fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((n) => /\.(wav|mp3|flac|ogg|json|txt)$/i.test(n)) : []
}

// ── 화면 점검 — 사람이 눈으로 찾던 결함을 수치로(2026-10-01 · MCP 로 개발툴을 확인하며 개선) ──
// 찾는 것: 이름 없는 단추 · 이유 없이 비활성된 단추 · 창 밖으로 삐져나간 요소 · 다른 것에 가려져 누를 수 없는 요소 ·
//          잘려서 못 읽는 글(말줄임인데 전체를 볼 길이 없음) · 너무 작은 글씨(사용자 지시 "UI 크기 적절하게") · 가로 스크롤.
// ★캡처(그림)를 대신한다 — 그림은 대화 밖으로 나가므로 허락 없이 찍지 않는다. 글과 숫자로 본다.
function auditExpr (opts) {
  return `(() => {
  const o = ${JSON.stringify(opts || {})}
  const TINY = o.tinyPx || 11
  const W = innerWidth, H = innerHeight
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 }
  const nm = (el) => ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.value && el.tagName !== 'SELECT' ? el.value : '') || (el.tagName === 'SELECT' ? 'select' : '') || '').replace(/\\s+/g, ' ')
  const who = (el) => el ? (el.dataset && el.dataset.testid ? 'testid:' + el.dataset.testid : el.tagName.toLowerCase() + (nm(el) ? ' "' + nm(el).slice(0, 36) + '"' : '')) : null
  // ★대화창이 떠 있으면 그 안만 본다 — 뒤의 것은 대화창이 가리는 것이 정상이다(처음엔 이것을 '가림' 20~27건으로 셌다).
  // 브라우저 기본 대화창(<dialog open> — 설정·목소리 고르기)도 대화창이다(처음엔 role 만 봐서 놓쳤다).
  const modals = [...document.querySelectorAll('[role=dialog], dialog[open]')].filter(vis)
  const topModal = modals.length ? modals[modals.length - 1] : null
  const root = o.within ? (__mcp.resolve(o.within, null, false, 0) || null) : (topModal || document)
  if (!root) return { error: 'within 대상 없음: ' + o.within }
  const lim = o.limit || 15
  const out = { size: [W, H], scope: o.within ? 'within' : topModal ? ('대화창: ' + (topModal.getAttribute('aria-label') || '이름 없음')) : '화면 전체', noName: [], disabledNoReason: [], offscreen: [], covered: [], clipped: [], tiny: { count: 0, samples: [] }, pageOverflowX: document.documentElement.scrollWidth > W + 1 }
  const inter = [...root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox]')].filter(vis)
  for (const el of inter) {
    if (!nm(el) && !el.closest('label')) out.noName.push(who(el) + (el.querySelector('svg') ? ' (그림만)' : ''))
    if ((el.disabled || el.getAttribute('aria-disabled') === 'true') && !el.getAttribute('title') && !el.closest('[title]')) out.disabledNoReason.push(who(el))
    const r = el.getBoundingClientRect()
    if (r.right > W + 1 || r.left < -1) out.offscreen.push(who(el) + ' x=' + Math.round(r.left) + '~' + Math.round(r.right) + ' (창 폭 ' + W + ')')
    const cx = r.left + Math.min(r.width / 2, 8), cy = r.top + r.height / 2
    // 굴림 칸 밖으로 굴러 나간 것은 '가림' 이 아니다 — 가장 가까운 굴림 칸의 보이는 자리 안일 때만 본다.
    let sp = el.parentElement, inView = true
    while (sp && sp !== document.body) { const st = getComputedStyle(sp); if (/(auto|scroll|hidden)/.test(st.overflowY + st.overflowX)) { const b = sp.getBoundingClientRect(); inView = cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; break } sp = sp.parentElement }
    if (inView && cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const hit = document.elementFromPoint(cx, cy)
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) out.covered.push(who(el) + ' ← 가림: ' + who(hit))
    }
  }
  const all = [...(root === document ? document.body : root).querySelectorAll('*')].filter((el) => el.children.length === 0 || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
  const seenTiny = new Set()
  for (const el of all) {
    if (!vis(el)) continue
    const s = getComputedStyle(el)
    const t = (el.innerText || '').trim()
    if (!t) continue
    const fs = parseFloat(s.fontSize)
    if (fs < TINY) { out.tiny.count++; const k = t.slice(0, 24); if (!seenTiny.has(k) && out.tiny.samples.length < lim) { seenTiny.add(k); out.tiny.samples.push(Math.round(fs * 10) / 10 + 'px ' + (el.dataset.testid ? 'testid:' + el.dataset.testid + ' ' : '') + '"' + k + '"') } }
    const cut = (s.textOverflow === 'ellipsis' || s.overflow === 'hidden' || s.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 1
    if (cut && !el.getAttribute('title') && !el.closest('[title]')) out.clipped.push(who(el) + ' 보임 ' + el.clientWidth + '/' + el.scrollWidth + 'px')
  }
  for (const k of ['noName', 'disabledNoReason', 'offscreen', 'covered', 'clipped']) { const n = out[k].length; out[k] = { count: n, samples: [...new Set(out[k])].slice(0, lim) } }
  out.total = out.noName.count + out.disabledNoReason.count + out.offscreen.count + out.covered.count + out.clipped.count + (out.pageOverflowX ? 1 : 0)
  return out
})()`
}

module.exports = {
  auditExpr, NO_BUTTON, MODES, SCREEN_MAP, MEDIA_HOOK, MEDIA_NOW, STATE, guardMedia, blockedMediaPaths, isAllowed, inspectWav, writeTone, writeText, listFixtures, FIXTURES }
