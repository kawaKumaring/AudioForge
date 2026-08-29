// local-file:// 프로토콜 핸들러 신뢰성 E2E (합성 WAV, GPU·실합성 없음).
// 계약: 렌더러가 미디어 로드를 '포기'하면 그 요청의 상류 파일 읽기가 정확히 해제되어야 한다.
//   A) 포기 50건 × 2라운드 — 원본 파일에 열린 핸들이 남지 않고(외부 rename 성공), 커널 핸들이 선형 증가하지 않는다.
//      2라운드 증분이 ~0이어야 '진짜 누수'와 '할당자 보유(RSS 잔류)'가 구분된다.
//   B) 직렬 90건 완주 — 실패 0, 핸들 증가 0, 잠긴 파일 0 (기존 정상 경로 회귀 가드).
//   C) 동작 동등성 — 헤더(Content-Length 부재 유지)/바이트/없는 파일 오류 형태/탐색/특수문자 경로.
// 버스트용과 컨트롤용 파일 풀은 완전히 분리한다. 같은 경로를 재사용하면 Chromium 미디어 캐시가
// 컨트롤 로드를 대신 처리해 '핸들러에 아예 도달하지 않는' 상태를 성공으로 오판하게 된다.
// 실행: npm run build 후  node test/e2e/local-file-protocol.e2e.mjs
import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

const BURST = Number(process.env.AF_E2E_BURST || 50)      // 라운드당 포기 로드 수
const SERIAL = Number(process.env.AF_E2E_SERIAL || 90)    // 직렬 완주 컨트롤 수
const BURST_MB = 25   // 포기 시점에 읽기가 '진행 중'이어야 핸들 점유가 관측된다(8MB에서는 이미 완독됨)
const CTRL_MB = 1

let failed = 0
const log = (...a) => console.log('[local-file-proto]', ...a)
const ok = (c, m) => { log(c ? 'PASS' : 'FAIL', m); if (!c) failed++ }

// ── 합성 WAV: 1초 사인 타일을 반복 복사해 채운다(대용량 생성 시간 단축, PCM16 디코드 가능 유지) ──
function makeWav(dest, bytes, sampleRate = 24000, freq = 180) {
  const dataSize = Math.max(2, (bytes - 44) & ~1)
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  const tileSamples = Math.min(dataSize / 2, sampleRate)
  const tile = Buffer.alloc(tileSamples * 2)
  const amp = Math.round(0.06 * 32767), w = (2 * Math.PI * freq) / sampleRate
  for (let i = 0; i < tileSamples; i++) tile.writeInt16LE(Math.round(amp * Math.sin(w * i)), i * 2)
  for (let off = 44; off < 44 + dataSize; off += tile.length) {
    tile.copy(buf, off, 0, Math.min(tile.length, 44 + dataSize - off))
  }
  fs.writeFileSync(dest, buf)
  return dest
}

// ── 외부(테스트 프로세스)에서의 파일 잠금 검사 = 이 e2e의 1차 신호 ──
// rename 이 실패하면 FILE_SHARE_DELETE 없이 열린 핸들이 남아있다는 뜻. 앱 내부 계측에 의존하지 않는다.
function lockedCount(files) {
  let n = 0
  for (const f of files) {
    const mv = f + '.mv'
    try { fs.renameSync(f, mv) } catch { n++; continue }
    try { fs.renameSync(mv, f) } catch { /* 되돌리기 실패 — 격리 폴더 통째 삭제로 정리됨 */ }
  }
  return n
}

// main 프로세스 커널 핸들 수. 관측 불가(비-Windows 등)면 null — 추정하지 않고 SKIP 으로 보고한다.
function handleCount(pid) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).HandleCount`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    const n = Number(String(out).trim())
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
const MEDIA = path.join(ISO, 'media')
const UDD = path.join(ISO, 'udd')
fs.mkdirSync(MEDIA, { recursive: true })
fs.mkdirSync(UDD, { recursive: true })

// 풀 분리: burst(라운드1/2) · control(직렬) · misc(동등성) 어느 것도 서로 경로를 공유하지 않는다.
const burst1 = [], burst2 = [], ctrl = [], misc = []
for (let i = 0; i < BURST; i++) burst1.push(makeWav(path.join(MEDIA, `b1_${i}.wav`), BURST_MB * 1024 * 1024, 24000, 110 + i))
for (let i = 0; i < BURST; i++) burst2.push(makeWav(path.join(MEDIA, `b2_${i}.wav`), BURST_MB * 1024 * 1024, 24000, 210 + i))
for (let i = 0; i < SERIAL; i++) ctrl.push(makeWav(path.join(MEDIA, `c_${i}.wav`), CTRL_MB * 1024 * 1024, 24000, 90 + i))
const SPECIAL = ['plain', 'a b & c#d,e(1)', '한글 이름', 'pct%20lit', "quote'and[]"]
for (const nm of SPECIAL) misc.push(makeWav(path.join(MEDIA, `${nm}.wav`), 512 * 1024, 24000, 300))
const HDR_FILE = makeWav(path.join(MEDIA, 'hdr.wav'), 2 * 1024 * 1024, 24000, 320)
const SEEK_FILE = makeWav(path.join(MEDIA, 'seek.wav'), 2 * 1024 * 1024, 24000, 330)
const SANITY_FILE = makeWav(path.join(MEDIA, 'sanity.wav'), 512 * 1024, 24000, 340)
const MISSING_FILE = path.join(MEDIA, 'does-not-exist.wav')
log(`합성 WAV: burst ${BURST}×2 @${BURST_MB}MB, control ${SERIAL}@${CTRL_MB}MB, misc ${misc.length + 3}`)

const env = { ...process.env, AF_E2E: '1' }
delete env.ELECTRON_RUN_AS_NODE   // 상속되면 Electron이 순수 node로 떠서 앱이 뜨지 않는다

const urlOf = (p) => 'local-file://' + encodeURIComponent(p)
const pageErrors = []
const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${UDD}`], cwd: APP, env })
const win = await app.firstWindow()
win.on('pageerror', e => pageErrors.push(e.message))

try {
  await win.waitForLoadState('domcontentloaded')
  const mainPid = await app.evaluate(() => process.pid)
  const hcAvailable = handleCount(mainPid) !== null
  if (!hcAvailable) log('관측 불가: main 프로세스 HandleCount — 핸들 관련 단언은 SKIP(추정하지 않음)')

  // 완전히 로드될 때까지 기다리는 직렬 로드. 끝나면 src를 비워 요소를 즉시 해제한다.
  const loadFully = (u, ms = 20000) => win.evaluate(({ uu, ms: m }) => new Promise((res) => {
    const a = new Audio(); let done = false
    const fin = (v) => { if (!done) { done = true; try { a.removeAttribute('src'); a.load() } catch { /* noop */ }; res(v) } }
    a.addEventListener('canplaythrough', () => fin('OK'), { once: true })
    a.addEventListener('error', () => fin('ERR code=' + (a.error && a.error.code) + ' net=' + a.networkState), { once: true })
    setTimeout(() => fin('TIMEOUT net=' + a.networkState + ' ready=' + a.readyState), m)
    a.preload = 'auto'; a.src = uu; a.load()
  }), { uu: u, ms })

  // 동시 시작 → 짧게 유지 → 전부 포기(src 제거 + load()로 취소). GC 타이밍에 의존하지 않는다.
  const abandonBurst = (urls) => win.evaluate(async (us) => {
    const held = []
    for (const u of us) { const a = new Audio(); a.preload = 'auto'; a.src = u; a.load(); held.push(a) }
    await new Promise(r => setTimeout(r, 900))
    for (const a of held) { a.removeAttribute('src'); a.src = ''; try { a.load() } catch { /* noop */ } }
    held.length = 0
  }, urls)

  const settle = async () => {
    await win.waitForTimeout(2500)
    await app.evaluate(async () => { if (globalThis.gc) globalThis.gc(); await new Promise(r => setTimeout(r, 1500)) })
  }

  ok(await loadFully(urlOf(SANITY_FILE)) === 'OK', 'sanity: local-file:// 단일 로드 성공')

  // ── C) 동작 동등성 (수정 전후 불변이어야 하는 것들) ──
  const hdr = await win.evaluate(async (u) => {
    const r = await fetch(u)
    const buf = await r.arrayBuffer()
    return { status: r.status, bytes: buf.byteLength, ct: r.headers.get('content-type'), cl: r.headers.get('content-length') }
  }, urlOf(HDR_FILE))
  ok(hdr.status === 200, `헤더: status 200 (=${hdr.status})`)
  ok(hdr.bytes === fs.statSync(HDR_FILE).size, `본문 바이트 정확 일치 (=${hdr.bytes}B)`)
  ok(hdr.ct === 'audio/wav', `Content-Type 보존 (=${hdr.ct})`)
  ok(hdr.cl === null, `Content-Length 부재 유지(기존 동작 그대로, 이번 범위 아님) (=${String(hdr.cl)})`)

  const missFetch = await win.evaluate(u => fetch(u).then(r => 'resp:' + r.status, e => 'REJECT:' + (e && e.name)), urlOf(MISSING_FILE))
  const missMedia = await win.evaluate(u => new Promise(res => {
    const a = new Audio(); let d = false
    const f = v => { if (!d) { d = true; res(v) } }
    a.addEventListener('loadedmetadata', () => f('OK'), { once: true })
    a.addEventListener('error', () => f('code=' + (a.error && a.error.code) + ' net=' + a.networkState), { once: true })
    setTimeout(() => f('TIMEOUT'), 6000)
    a.preload = 'auto'; a.src = u; a.load()
  }), urlOf(MISSING_FILE))
  ok(missFetch === 'REJECT:TypeError', `없는 파일: fetch는 TypeError 거부 (=${missFetch})`)
  ok(missMedia === 'code=4 net=3', `없는 파일: media는 code=4/net=3 (=${missMedia})`)

  const seek = await win.evaluate(u => new Promise(res => {
    const a = new Audio(); let d = false
    const f = v => { if (!d) { d = true; try { a.removeAttribute('src'); a.load() } catch { /* noop */ }; res(v) } }
    a.addEventListener('canplaythrough', () => { a.currentTime = 20; setTimeout(() => f({ t: a.currentTime, ready: a.readyState }), 800) }, { once: true })
    a.addEventListener('error', () => f({ err: a.error && a.error.code }), { once: true })
    setTimeout(() => f({ timeout: true }), 12000)
    a.preload = 'auto'; a.src = u; a.load()
  }), urlOf(SEEK_FILE))
  ok(Math.abs((seek.t ?? -1) - 20) < 1 && seek.ready >= 3, `탐색(seek) 동작 (=${JSON.stringify(seek)})`)

  const specialResults = []
  for (const f of misc) specialResults.push(await loadFully(urlOf(f), 8000))
  ok(specialResults.every(r => r === 'OK'), `특수문자 경로 ${misc.length}종 로드 (=${specialResults.join(',')})`)

  // ── A) 포기 버스트 2라운드 ──
  const h0 = handleCount(mainPid)
  const r1Files = burst1
  await abandonBurst(r1Files.map(urlOf))
  await settle()
  const h1 = handleCount(mainPid)
  const locked1 = lockedCount(r1Files)
  const per1 = hcAvailable ? (h1 - h0) / BURST : null
  log(`라운드1: 포기 ${BURST}건 · HandleCount ${h0}→${h1} (건당 ${per1 === null ? 'n/a' : per1.toFixed(2)}) · 잠긴 파일 ${locked1}/${BURST}`)
  ok(locked1 === 0, `라운드1: 포기된 요청이 파일 핸들을 남기지 않음 (잠김 ${locked1}/${BURST})`)
  if (hcAvailable) ok(per1 <= 1.0, `라운드1: 커널 핸들 증가 건당 ≤1.0 (=${per1.toFixed(2)})`)
  else log('SKIP 라운드1 커널 핸들 단언 — HandleCount 관측 불가')

  await abandonBurst(burst2.map(urlOf))
  await settle()
  const h2 = handleCount(mainPid)
  const locked2 = lockedCount(burst2)
  const delta2 = hcAvailable ? h2 - h1 : null
  log(`라운드2: 포기 ${BURST}건 · HandleCount ${h1}→${h2} (증분 ${delta2 === null ? 'n/a' : delta2}) · 잠긴 파일 ${locked2}/${BURST}`)
  ok(locked2 === 0, `라운드2: 포기된 요청이 파일 핸들을 남기지 않음 (잠김 ${locked2}/${BURST})`)
  // 2라운드 증분이 ~0 이어야 1라운드 RSS/핸들 증가가 '할당자 보유'였음이 확정된다(선형 증가면 누수).
  if (hcAvailable) ok(delta2 <= 10, `라운드2: 커널 핸들 증분 ≈0 (누수 아님 확증) (=${delta2})`)
  else log('SKIP 라운드2 커널 핸들 단언 — HandleCount 관측 불가')

  // ── B) 직렬 90건 완주 (기존 정상 경로 회귀 가드) ──
  const hb0 = handleCount(mainPid)
  let serialFail = 0
  const firstFails = []
  for (let i = 0; i < SERIAL; i++) {
    const r = await loadFully(urlOf(ctrl[i]))
    if (r !== 'OK') { serialFail++; if (firstFails.length < 3) firstFails.push(`#${i}=${r}`) }
  }
  await app.evaluate(async () => { if (globalThis.gc) globalThis.gc(); await new Promise(r => setTimeout(r, 1200)) })
  const hb1 = handleCount(mainPid)
  const lockedCtrl = lockedCount(ctrl)
  log(`직렬: ${SERIAL}건 완주 · 실패 ${serialFail}${firstFails.length ? ' (' + firstFails.join(', ') + ')' : ''} · HandleCount ${hb0}→${hb1} · 잠긴 파일 ${lockedCtrl}/${SERIAL}`)
  ok(serialFail === 0, `직렬 ${SERIAL}건 전부 성공 (실패 ${serialFail})`)
  ok(lockedCtrl === 0, `직렬 완주는 파일 핸들을 남기지 않음 (잠김 ${lockedCtrl}/${SERIAL})`)
  if (hcAvailable) ok(hb1 - hb0 <= 5, `직렬 완주는 커널 핸들을 늘리지 않음 (=${hb1 - hb0})`)
  else log('SKIP 직렬 커널 핸들 단언 — HandleCount 관측 불가')

  ok(pageErrors.length === 0, `pageerror 0 (=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0] : ''})`)
} catch (e) {
  failed++; log('EXCEPTION', e && (e.stack || e.message))
} finally {
  await app.close().catch(() => {})
  // 이번 실행이 만든 격리 폴더만 삭제(prefix + tmpdir 가드)
  if (path.basename(ISO).startsWith('audioforge_e2e_') && path.dirname(ISO) === os.tmpdir()) {
    try { fs.rmSync(ISO, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
