// 실제 분할 **저장**을 확인한다 — 화면이 정한 경계·이름·고른 조각이
// 저장된 **파일의 개수·이름·길이**와 맞는가.
//
// ★지금까지 확인한 적 없던 자리다. 화면 검사(`split-editing.component.mjs`)는
//   조각 목록까지만 보고, 실제 저장은 파이썬(`separate.py --mode split`)이 한다.
//   그 사이가 비어 있었다.
//
// 자동 분할(마커 없음)과 수동 경계 분할을 **따로** 확인하고 따로 보고한다 —
// 자동은 조각 수를 ffmpeg 이 정하므로 기대값을 미리 못 박을 수 없다.
//
// GPU 를 쓰지 않는다. 합성 음원만 쓴다(사용자 파일을 열지 않는다).
// 실행: node scripts/split-save-check.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PY = JSON.parse(readFileSync(path.join(ROOT, 'externals/env.json'), 'utf-8')).python
const SCRIPT = path.join(ROOT, 'python', 'separate.py')
const WORK = path.join(os.tmpdir(), `af-split-save-${Date.now()}`)
const SR = 24000

let checks = 0
const pass = (s) => { checks++; console.log('PASS', s) }
const near = (a, b, tol) => Math.abs(a - b) <= tol

/** 합성 음원. segments = [{sec, amp}] — amp 0 이면 무음. */
function makeWav(file, segments) {
  const total = segments.reduce((n, s) => n + Math.round(s.sec * SR), 0)
  const buf = Buffer.alloc(44 + total * 2)
  buf.write('RIFF'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(total * 2, 40)
  let n = 0
  for (const s of segments) {
    const len = Math.round(s.sec * SR)
    for (let i = 0; i < len; i++, n++) {
      buf.writeInt16LE(s.amp ? Math.round(Math.sin(n * 0.05) * s.amp) : 0, 44 + n * 2)
    }
  }
  writeFileSync(file, buf)
  return total / SR
}

// 앱(PythonRunner)과 **같은 방식**으로 띄운다 — 다른 조건에서 재면 다른 것을 재게 된다.
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: PY_ENV, ...opts, windowsHide: true })
    p.stdout.setEncoding('utf-8'); p.stderr.setEncoding('utf-8')
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

/** separate.py 를 분할 모드로 돌리고 result 메시지를 돌려준다. */
async function runSplit(name, input, options) {
  const outDir = path.join(WORK, name)
  mkdirSync(outDir, { recursive: true })
  const cfg = path.join(WORK, `${name}.json`)
  writeFileSync(cfg, JSON.stringify({
    mode: 'split', input, output: outDir, runToken: `chk-${name}`,
    splitPoints: '', splitLabels: '', splitSelected: null, ...options,
  }, null, 2), 'utf-8')
  const t0 = Date.now()
  const r = await run(PY, ['-X', 'utf8', '-u', SCRIPT, '--config', cfg], { cwd: path.join(ROOT, 'python') })
  const msgs = r.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const error = msgs.find((m) => m.type === 'error')
  if (error) throw new Error(`${name}: ${error.code || ''} ${error.message} ${r.err.slice(-300)}`)
  const result = msgs.find((m) => m.type === 'result')
  if (!result) throw new Error(`${name}: result 가 없다 (exit ${r.code}) ${r.err.slice(-400)}`)
  return { outDir, result, seconds: (Date.now() - t0) / 1000, notes: msgs.filter((m) => m.type === 'progress') }
}

let ffprobe = null
async function probe(file) {
  const r = await run(ffprobe, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return parseFloat((r.out || '').trim())
}

/** 저장된 wav 를 이름순으로. 확인 대상은 **실제 폴더 내용**이다. */
const savedWavs = (dir) => readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort()

/** WAV 의 data 덩어리를 찾는다(ffmpeg 이 LIST 를 끼워 넣을 수 있어 44 를 가정하지 않는다). */
function pcmOf(file) {
  const b = readFileSync(file)
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'data') return b.subarray(off + 8, Math.min(off + 8 + size, b.length))
    off += 8 + size + (size % 2)
  }
  throw new Error(`${path.basename(file)}: data 덩어리를 찾지 못했다`)
}

/**
 * 조각의 **소리 크기**를 앞·중간·뒤로 나눠 잰다.
 *
 * ★길이가 맞는 것은 경계가 맞는다는 증거가 아니다 — 같은 길이를 엉뚱한 자리에서
 *   떠 와도 길이는 같다. 원본을 구간마다 다른 크기로 만들어 두고, 조각의 소리가
 *   **그 구간의 크기 하나로만** 채워졌는지 본다(이웃이 섞이면 여기서 걸린다).
 */
function levels(file) {
  const d = pcmOf(file)
  const n = Math.floor(d.length / 2)
  const peak = (from, to) => {
    let m = 0
    for (let i = from; i < to; i++) m = Math.max(m, Math.abs(d.readInt16LE(i * 2)))
    return m
  }
  return { head: peak(0, Math.floor(n * 0.1)), mid: peak(Math.floor(n * 0.45), Math.floor(n * 0.55)), tail: peak(Math.floor(n * 0.9), n) }
}

async function main() {
  mkdirSync(WORK, { recursive: true })
  // 앱이 쓰는 것과 **같은 찾기 규칙**으로 ffmpeg 자리를 얻는다(내 규칙을 따로 만들지 않는다).
  const pyDir = path.join(ROOT, 'python')
  const ff = await run(PY, ['-X', 'utf8', '-c',
    `import sys; sys.path.insert(0, r'${pyDir}')\nfrom audio_utils import find_ffmpeg\nprint(find_ffmpeg() or '')`],
  { cwd: pyDir })
  const ffmpeg = (ff.out || '').trim()
  if (!ffmpeg) throw new Error('ffmpeg 을 찾지 못했다 — 이 확인은 ffmpeg 이 있어야 한다')
  ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg))

  // ══ 1. 수동 경계 분할 — 전부 저장 ═══════════════════════════════════
  // ★구간마다 **다른 크기**로 만든다 — 그래야 잘린 자리가 맞는지 소리로 확인할 수 있다.
  const src = path.join(WORK, 'manual.wav')
  const AMP = [3000, 12000, 7000]
  const srcLen = makeWav(src, [
    { sec: 3, amp: AMP[0] }, { sec: 4, amp: AMP[1] }, { sec: 5, amp: AMP[2] },
  ])
  const before = statSync(src)
  const labels = ['첫 곡', '둘째 곡', '셋째 곡']
  const want = [
    { file: '01_첫 곡.wav', start: 0, end: 3, amp: AMP[0] },
    { file: '02_둘째 곡.wav', start: 3, end: 7, amp: AMP[1] },
    { file: '03_셋째 곡.wav', start: 7, end: 12, amp: AMP[2] },
  ]
  const a = await runSplit('manual-all', src, {
    splitPoints: '3,7', splitLabels: labels.join('|'),
  })
  const gotA = savedWavs(a.outDir)
  if (gotA.length !== 3) throw new Error(`개수가 다르다: ${gotA.length}개 ${JSON.stringify(gotA)}`)
  pass(`수동 경계 2개 → 저장 파일 3개 (${a.seconds.toFixed(1)}초)`)
  if (JSON.stringify(gotA) !== JSON.stringify(want.map((w) => w.file))) {
    throw new Error(`이름이 다르다\n  화면: ${JSON.stringify(want.map((w) => w.file))}\n  저장: ${JSON.stringify(gotA)}`)
  }
  pass('★트랙 이름이 화면이 정한 그대로다(번호 + 사용자가 친 이름)')

  const durA = []
  for (const w of want) {
    const d = await probe(path.join(a.outDir, w.file))
    durA.push(d)
    const wantSec = w.end - w.start
    if (!near(d, wantSec, 0.05)) throw new Error(`${w.file} 길이가 다르다: 기대 ${wantSec}s, 실제 ${d}s`)
  }
  console.log(`  길이 기대 [3, 4, 5] · 실제 [${durA.map((d) => d.toFixed(3)).join(', ')}]`)
  const sumA = durA.reduce((x, y) => x + y, 0)
  if (!near(sumA, srcLen, 0.06)) throw new Error(`조각 합이 원본과 다르다: ${sumA} vs ${srcLen}`)
  pass(`★경계가 길이로 맞는다 — 합계 ${sumA.toFixed(3)}s = 원본 ${srcLen.toFixed(3)}s (소리를 잃지 않았다)`)

  // ★소리로 경계를 확인한다 — 길이만 맞고 **엉뚱한 자리**를 떠 왔을 수 있다.
  const lv = []
  for (const w of want) {
    const L = levels(path.join(a.outDir, w.file))
    lv.push(L)
    for (const [where, v] of Object.entries(L)) {
      if (Math.abs(v - w.amp) > w.amp * 0.08) {
        throw new Error(`${w.file} 의 ${where} 소리가 그 구간의 것이 아니다: ${v} (기대 ${w.amp})`)
      }
    }
  }
  console.log(`  구간 소리 기대 [${AMP.join(', ')}] · 조각 가운데 실측 [${lv.map((L) => L.mid).join(', ')}]`)
  pass('★조각의 앞·가운데·뒤가 모두 그 구간의 소리다 — 경계가 **자리**로도 맞는다')

  // 곁에 남는 기록도 같은 값인가.
  for (const w of want) {
    const m = JSON.parse(readFileSync(path.join(a.outDir, w.file.replace(/\.wav$/, '.json')), 'utf-8'))
    if (!near(m.start_time, w.start, 0.001) || !near(m.end_time, w.end, 0.001)) {
      throw new Error(`${w.file} 기록의 경계가 다르다: ${m.start_time}~${m.end_time}`)
    }
  }
  const tl = readFileSync(path.join(a.outDir, '_tracklist.txt'), 'utf-8').trim().split('\n')
  if (tl.length !== 3 || !labels.every((l, i) => tl[i].includes(l))) {
    throw new Error(`트랙 목록이 다르다: ${JSON.stringify(tl)}`)
  }
  pass('곁 기록(.json · _tracklist.txt)도 같은 경계·이름을 적는다')

  const after = statSync(src)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('원본 파일이 바뀌었다')
  }
  pass('원본 파일은 그대로다(크기·시각 불변)')

  // ══ 2. 수동 경계 분할 — 고른 조각만 ══════════════════════════════════
  const b = await runSplit('manual-pick', src, {
    splitPoints: '3,7', splitLabels: labels.join('|'), splitSelected: [0, 2],
  })
  const gotB = savedWavs(b.outDir)
  if (JSON.stringify(gotB) !== JSON.stringify(['01_첫 곡.wav', '03_셋째 곡.wav'])) {
    throw new Error(`고른 조각만 저장되지 않았다: ${JSON.stringify(gotB)}`)
  }
  pass('★고른 조각(1·3번)만 저장되고 **번호가 밀리지 않는다**(03 이 02 가 되지 않음)')
  const dB = [await probe(path.join(b.outDir, gotB[0])), await probe(path.join(b.outDir, gotB[1]))]
  if (!near(dB[0], 3, 0.05) || !near(dB[1], 5, 0.05)) {
    throw new Error(`고른 조각 길이가 다르다: ${JSON.stringify(dB)}`)
  }
  console.log(`  길이 기대 [3, 5] · 실제 [${dB.map((d) => d.toFixed(3)).join(', ')}]`)
  const lvB = [levels(path.join(b.outDir, gotB[0])).mid, levels(path.join(b.outDir, gotB[1])).mid]
  if (Math.abs(lvB[0] - AMP[0]) > AMP[0] * 0.08 || Math.abs(lvB[1] - AMP[2]) > AMP[2] * 0.08) {
    throw new Error(`고른 조각이 다른 자리를 떠 왔다: ${JSON.stringify(lvB)} (기대 ${AMP[0]}, ${AMP[2]})`)
  }
  pass('★빼놓은 2번 자리만큼 소리가 빠지고, 남긴 조각은 **제자리 소리**다')

  // ══ 3. 자동 분할 — 마커 없음(ffmpeg 무음 감지) ═══════════════════════
  //   ★수동과 **다른 경로**다. 조각 수·경계를 ffmpeg 이 정하므로 미리 못 박지 않는다.
  const auto = path.join(WORK, 'auto.wav')
  const autoLen = makeWav(auto, [
    { sec: 12, amp: 8000 }, { sec: 3, amp: 0 },
    { sec: 12, amp: 8000 }, { sec: 3, amp: 0 },
    { sec: 12, amp: 8000 },
  ])
  const c = await runSplit('auto', auto, {})
  const gotC = savedWavs(c.outDir)
  if (gotC.length < 2) throw new Error(`자동 분할이 나누지 못했다: ${JSON.stringify(gotC)}`)
  if (!gotC.every((f) => /^track_\d\d\.wav$/.test(f))) {
    throw new Error(`자동 분할 이름 규칙이 다르다: ${JSON.stringify(gotC)}`)
  }
  pass(`★자동 분할은 **이름을 스스로 붙인다** — ${JSON.stringify(gotC)}`)
  const durC = []
  for (const f of gotC) durC.push(await probe(path.join(c.outDir, f)))
  const sumC = durC.reduce((x, y) => x + y, 0)
  console.log(`  자동: 조각 ${gotC.length}개 · 길이 [${durC.map((d) => d.toFixed(3)).join(', ')}] · 합계 ${sumC.toFixed(3)}s / 원본 ${autoLen.toFixed(3)}s`)
  if (!near(sumC, autoLen, 0.1)) throw new Error(`자동 분할이 소리를 잃었다: ${sumC} vs ${autoLen}`)
  pass('★자동 분할도 소리를 잃지 않는다(조각 합 = 원본 길이)')
  const said = c.notes.map((m) => m.message || '').join(' | ')
  if (!/마커가 없어 자동 무음 분할/.test(said)) throw new Error(`자동 경로임을 말하지 않았다: ${said}`)
  pass('자동 경로로 갔다는 사실을 진행 메시지로 말한다')

  console.log(JSON.stringify({
    passed: checks,
    manual: { pieces: gotA.length, durations: durA.map((d) => +d.toFixed(3)) },
    manualPicked: { pieces: gotB.length, durations: dB.map((d) => +d.toFixed(3)) },
    auto: { pieces: gotC.length, durations: durC.map((d) => +d.toFixed(3)) },
  }))
}

main()
  .then(() => { rmSync(WORK, { recursive: true, force: true }) })
  .catch((e) => {
    console.error('FAIL', e?.message || e)
    console.error(`  남긴 작업 폴더: ${WORK}`)
    process.exitCode = 1
  })
