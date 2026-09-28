// 방금 만든 다섯 사람의 대사를 **한 파일로 이어 붙인다** — 듣기 편하도록.
//
// ★왜 (2026-09-28)
//   다섯 개를 따로 열어 들으면 흐름이 끊기고, 사람마다 크기가 다른 것도 알아채기 어렵다.
//   한 줄로 이어 두면 대화처럼 들리고 **크기 차이가 바로 귀에 잡힌다.**
//
// ★크기를 건드리지 않는다. 고르게 맞추면 "원래 이만큼 차이가 난다" 는 사실이 지워진다.
//   사이에 0.6초 쉼만 넣는다.
//
// 실행: node scripts/join-listen-dialogue.mjs
import fs from 'fs'
import path from 'path'
import { OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS, dayFolder } from '../src/shared/outputLayout.ts'

const APP = process.cwd()
const DAY = dayFolder(new Date())
const ROOT = path.join(APP, OUTPUT_ROOT_DIRNAME, FEATURE_FOLDERS.tts, DAY)

/** 방금 만든 것 중 **가장 최근 다섯 개**. 길이가 20초 넘는 것만 — 검사 산출물을 거른다. */
function recentFive() {
  const rows = []
  for (const d of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!/\.wav$/i.test(f)) continue
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      if (st.size < 900 * 1024) continue        // 검사용 짧은 소리는 뺀다
      rows.push({ p, t: st.mtimeMs })
    }
  }
  return rows.sort((a, b) => a.t - b.t).slice(-5)
}

function readWav(file) {
  const buf = fs.readFileSync(file)
  let pos = 12, fmt = null, data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) }
    else if (id === 'data') data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length))
    pos += 8 + size + (size % 2)
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`읽을 수 없는 모양: ${file}`)
  return { fmt, data }
}

const files = recentFive()
if (files.length < 5) { console.error(`쓸 만한 파일이 ${files.length}개뿐입니다.`); process.exit(2) }

const parts = files.map((f) => ({ ...readWav(f.p), path: f.p }))
const rate = parts[0].fmt.rate
const ch = parts[0].fmt.channels
for (const p of parts) {
  if (p.fmt.rate !== rate || p.fmt.channels !== ch) {
    console.error(`모양이 다릅니다 — ${p.path} (${p.fmt.rate}Hz ${p.fmt.channels}ch)`)
    process.exit(2)
  }
}

const GAP = Buffer.alloc(Math.round(rate * 0.6) * ch * 2)   // 0.6초 쉼
const body = Buffer.concat(parts.flatMap((p, i) => (i ? [GAP, p.data] : [p.data])))

const head = Buffer.alloc(44)
head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8)
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20)
head.writeUInt16LE(ch, 22); head.writeUInt32LE(rate, 24)
head.writeUInt32LE(rate * ch * 2, 28); head.writeUInt16LE(ch * 2, 32); head.writeUInt16LE(16, 34)
head.write('data', 36); head.writeUInt32LE(body.length, 40)

const outDir = path.join(ROOT, '_들어보기')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, '다섯사람_대화.wav')
fs.writeFileSync(out, Buffer.concat([head, body]))

const seconds = body.length / (rate * ch * 2)
console.log('이어 붙였다 —', out)
console.log(`  ${parts.length}명 · ${seconds.toFixed(1)}초 · ${(fs.statSync(out).size / 1048576).toFixed(2)}MB · ${rate}Hz ${ch}ch`)
console.log('')
console.log('★크기는 건드리지 않았다 — 사람마다 다른 그대로다. 그 차이를 귀로 확인하려는 것이다.')
for (const [i, p] of parts.entries()) {
  console.log(`  ${String.fromCharCode(65 + i)} ← ${path.basename(path.dirname(p.path))}`)
}
