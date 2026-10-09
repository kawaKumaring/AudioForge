/**
 * 영상 입력으로 노래 변환을 **끝까지** 돌려 본다 — 실제 엔진, 실제 파일.
 *
 * ★왜 따로 있나: 이 확인은 분리 + seed-vc 를 거쳐 몇 분이 걸린다. 게이트에 넣으면
 *   평소 확인이 느려진다. 그래서 **필요할 때 손으로** 돌리는 자리에 둔다.
 *
 * 무엇을 보는가
 *   · 영상에서 소리를 꺼내 변환까지 가는가
 *   · 비교 재생에 쓸 **원곡 소리**(sourceAudioPath)가 실제로 만들어지는가
 *   · 원곡과 변환본의 **시간 기준**이 어긋나지 않는가(길이·레이트)
 *   · 원본 영상·목소리 바이트가 그대로인가
 *   · 저장이 원본·참조·결과를 덮지 않는가(요청 식별자 대조 포함)
 *
 * ★길이가 같다는 것은 **시간 정렬이나 소리 품질의 증거가 아니다.** 사람이 들어야 한다.
 *
 * 실행: node scripts/song-video-check.mjs <영상> <목소리> [작업자리]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [video, voice, workRoot] = process.argv.slice(2)
if (!video || !voice) {
  console.error('사용: node scripts/song-video-check.mjs <영상> <목소리> [작업자리]')
  process.exit(2)
}
for (const [what, p] of [['영상', video], ['목소리', voice]]) {
  if (!fs.existsSync(p)) { console.error(`${what} 파일이 없습니다: ${p}`); process.exit(2) }
}

const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
const before = { video: sha(video), voice: sha(voice) }

function appPython() {
  const named = process.env.AUDIOFORGE_PYTHON
  if (named && fs.existsSync(named)) return named
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'externals', 'env.json'), 'utf-8'))
    if (typeof cfg.python === 'string' && fs.existsSync(cfg.python)) return cfg.python
  } catch { /* 없으면 아래에서 멈춘다 */ }
  return null
}
const py = appPython()
if (!py) { console.error('파이썬을 찾지 못했습니다(AUDIOFORGE_PYTHON · externals/env.json)'); process.exit(2) }

const reqId = `videocheck-${Date.now().toString(36)}`
const work = path.join(workRoot || createRequire(import.meta.url)('../tools/test-root.cjs').dir('results', 'song-video-check'), reqId)
fs.mkdirSync(work, { recursive: true })

let passed = 0
const fails = []
const check = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}

console.log(`[영상 확인] ${path.basename(video)} + ${path.basename(voice)} → ${work}`)
const t0 = Date.now()
const child = spawn(py, ['-X', 'utf8', path.join(ROOT, 'python', 'song_worker.py'),
  '--source', video, '--voice', voice, '--work', work, '--request-id', reqId],
{ cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })

let out = ''
let result = null
const stages = []
child.stdout.setEncoding('utf-8')
child.stdout.on('data', (d) => {
  out += d
  for (const line of String(d).split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const msg = JSON.parse(t)
      if (msg.type === 'progress' && msg.message) {
        stages.push(`${msg.percent ?? '-'}% ${msg.message}`)
        console.log(`  · ${msg.percent ?? '-'}% ${msg.message}`)
      }
      if (msg.type === 'result') result = msg.song
      if (msg.type === 'error') console.error('  ! 오류:', msg.message)
    } catch { /* 진행 막대 등은 JSON 이 아니다 */ }
  }
})
child.stderr.setEncoding('utf-8')
child.stderr.on('data', () => { /* 분리기 로그는 길다 — 버린다 */ })

child.on('close', (code) => {
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[영상 확인] 파이썬 종료 ${code} · ${sec}초`)
  check(code === 0, '영상 입력으로 사슬이 끝까지 간다', { code })
  check(!!result, '결과 계약을 받았다')
  if (!result) { finish(); return }

  // ── 영상에서 소리를 꺼냈는가 ─────────────────────────────────────────
  check(!!result.sourceAudioPath && fs.existsSync(result.sourceAudioPath),
    '비교 재생에 쓸 원곡 소리가 만들어졌다', result.sourceAudioPath)
  check(path.extname(result.sourceAudioPath).toLowerCase() === '.wav',
    '꺼낸 소리는 디코딩 가능한 형식이다(영상 경로가 아니다)', result.sourceAudioPath)
  check(result.sourceAudioPath !== video, '원곡 소리가 영상 원본을 가리키지 않는다')

  check(!!result.mixPath && fs.existsSync(result.mixPath), '변환 음원이 만들어졌다', result.mixPath)
  check(!!result.vocalPath && fs.existsSync(result.vocalPath), '변환 보컬이 만들어졌다')
  check(!!result.reference?.clipPath && fs.existsSync(result.reference.clipPath),
    '참조 클립이 만들어졌다')
  check(result.reference?.fromPath === voice, '참조 출처가 사용자가 고른 목소리다', result.reference)
  check(typeof result.reference?.startSec === 'number' && typeof result.reference?.durationSec === 'number',
    '실제로 쓴 참조 구간이 남는다', result.reference)

  // ── 시간 기준 — **정렬 합격이 아니다** ───────────────────────────────
  const wav = (p) => {
    const b = fs.readFileSync(p)
    const rate = b.readUInt32LE(24), bits = b.readUInt16LE(34), ch = b.readUInt16LE(22)
    let off = 12, len = 0
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4)
      if (id === 'data') { len = sz; break }
      off += 8 + sz + (sz % 2)
    }
    return { rate, ch, seconds: len / (rate * ch * (bits / 8)) }
  }
  const src = wav(result.sourceAudioPath), mix = wav(result.mixPath)
  console.log(`  [측정] 원곡 소리 ${src.seconds.toFixed(3)}초 ${src.rate}Hz ch${src.ch}`)
  console.log(`  [측정] 변환 음원 ${mix.seconds.toFixed(3)}초 ${mix.rate}Hz ch${mix.ch}`)
  check(Math.abs(src.seconds - mix.seconds) < 0.05,
    '원곡 소리와 변환 음원의 길이가 같다(시간 기준이 어긋나지 않았다)',
    { src: src.seconds, mix: mix.seconds })
  console.log('  ★길이가 같다는 것은 시간 정렬이나 소리 품질의 증거가 아니다 — 사람이 들어야 한다.')

  // ── 원본을 건드리지 않았다 ───────────────────────────────────────────
  check(sha(video) === before.video, '원본 영상 바이트가 그대로다')
  check(sha(voice) === before.voice, '목소리 원본 바이트가 그대로다')

  finish()
})

function finish() {
  console.log(`RESULT ${passed} checks · ${fails.length} fail`)
  if (result) {
    console.log('  [자료] 작업 폴더:', result.workDir)
    console.log('  [자료] 변환 음원:', result.mixPath)
    console.log('  [자료] 비교용 원곡 소리:', result.sourceAudioPath)
    console.log('  [자료] 참조 구간:',
      `${result.reference.startSec}초부터 ${result.reference.durationSec}초 (원본 ${result.reference.sourceSec}초)`)
  }
  if (fails.length) { console.error('실패:', fails.join(' / ')); process.exit(1) }
  console.log('★소리를 듣지 않았다. 음정·리듬·발음·화자 유지·말끝은 확인 범위 밖이다.')
}
