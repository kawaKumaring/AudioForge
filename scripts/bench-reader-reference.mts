/**
 * 참조 목소리 낭독 — 덩이 생성 시간 분해·비교 기준(2026-10-03 관리자 지시 '참조 목소리 연속 낭독').
 *
 * 앱과 **같은 덩이 나누기·같은 설정·같은 오프라인 환경**으로 덩이를 차례로 만든다.
 *   --mode process   지금 앱의 길: 덩이마다 `separate.py` 새 프로세스(readerRunConfig 그대로)
 *   --mode resident  상주 실행기(qwen_voice_server)의 참조 목소리 요청 — 모델·참조 준비를 재사용
 * 결과: 덩이마다 걸린 시간 · 만든 소리 길이 · 실시간 배수 · (process) 표준 출력 단계별 시각. 본문·전사는 적지 않는다.
 *
 * 실행(격리 · GPU 사용, 저장소 루트에서): npx esbuild scripts/bench-reader-reference.mts --bundle --platform=node --format=esm --outfile=_local/perf-ref/bench.mjs && node _local/perf-ref/bench.mjs --ref <참조 wav> --out <결과 폴더> [--mode process|resident] [--chunks 6]
 * ★사용자 미디어 금지 — 저장소 fixture 에서 앱 준비로 만든 참조만.
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { splitForReading, START_RAMP_SECONDS } from '../src/shared/readerChunks'
import { readingPlan, DEFAULT_READER_PREFS } from '../src/shared/readerText'
import { readerRunConfig, jsonLines, madeTrack } from '../src/main/services/reader-run'
import { OFFLINE_ENV } from '../src/shared/offlinePolicy'
import { parseWav } from '../src/shared/readerTiming'

const arg = (k: string, d = ''): string => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const ROOT = process.cwd()          // 저장소 루트에서 실행한다
const REF = resolve(arg('ref'))
const OUT = resolve(arg('out', join(ROOT, '_local', 'perf-ref', 'run')))
const MODE = arg('mode', 'process')
const N = Number(arg('chunks', '5'))
mkdirSync(OUT, { recursive: true })

// 관리자 측정과 같은 검사용 글(performance-reference-card-audit.cjs).
const TEXT = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 장면이다. 그는 천천히 문을 열고 어두운 복도를 내다보았다. 잠시 멈춘 그는 창밖을 바라보았다.`).join('\n')
const chunks = splitForReading(TEXT, { breakAt: 0, ramp: START_RAMP_SECONDS }).slice(0, N)
const says = chunks.map((c) => readingPlan(c.text, DEFAULT_READER_PREFS).say)

const env = { ...process.env, ...OFFLINE_ENV, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
const appPython = JSON.parse(readFileSync(join(ROOT, 'externals', 'env.json'), 'utf-8')).python as string

function wavSeconds(p: string): number {
  const w = parseWav(new Uint8Array(readFileSync(p)))
  return w ? w.samples.length / w.sampleRate : 0
}

async function runProcess(i: number): Promise<Record<string, unknown>> {
  const dir = join(OUT, `chunk-${i}`)
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'chunk.json')
  writeFileSync(cfg, JSON.stringify(readerRunConfig(says[i], { kind: 'reference', path: REF }, dir)), 'utf-8')
  const t0 = performance.now()
  const marks: Array<{ t: number; type?: string; stage?: string; percent?: number; tag?: string }> = []
  let buf = ''
  const out: string[] = []
  await new Promise<void>((res, rej) => {
    const p = spawn(appPython, ['-X', 'utf8', join(ROOT, 'python', 'separate.py'), '--config', cfg], { env, cwd: ROOT })
    p.stdout.on('data', (d) => {
      buf += String(d)
      let k
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1); out.push(line)
        try {
          const j = JSON.parse(line)
          // 단계 이름·진행률·메시지 앞머리(장치·단계 표시)만 — 글·전사는 싣지 않는다.
          marks.push({ t: Math.round(performance.now() - t0), type: j.type, stage: j.stage, percent: j.percent, tag: typeof j.message === 'string' ? j.message.slice(0, 18) : undefined })
        } catch { /* JSON 아닌 줄 */ }
      }
    })
    p.stderr.on('data', () => { /* 버린다 */ })
    p.on('error', rej)
    p.on('close', () => res())
  })
  const ms = Math.round(performance.now() - t0)
  const made = madeTrack(jsonLines(out.join('\n')))
  const sec = made && existsSync(made) ? wavSeconds(made) : 0
  if (made && existsSync(made)) copyFileSync(made, join(OUT, `out-${i}.wav`))
  return { i, chars: says[i].length, ms, audioSec: Math.round(sec * 100) / 100, rtf: sec ? Math.round((sec / (ms / 1000)) * 100) / 100 : 0, marks }
}

// ── 상주: 앱처럼 qwen_voice_server 를 한 번 띄우고(파이프 주소·열쇠), 합성 프로세스가 그 실행기에 작업을 맡긴다 ──
let server: ReturnType<typeof spawn> | null = null
const PIPE = { addr: String.raw`\\.\pipe\af-bench-` + process.pid, key: 'bench' + process.pid }
async function startServer(): Promise<void> {
  const py = join(ROOT, 'externals', 'qwen3_tts_venv', 'Scripts', 'python.exe')
  server = spawn(py, ['-X', 'utf8', '-u', join(ROOT, 'python', 'qwen_voice_server.py')], { env: { ...env, AF_QWEN_PIPE_ADDR: PIPE.addr, AF_QWEN_PIPE_KEY: PIPE.key }, stdio: ['pipe', 'pipe', 'ignore'] })
  await new Promise<void>((res) => { let b = ''; server!.stdout!.on('data', (d) => { b += String(d); if (b.includes('"ready": true')) res() }) })
}
async function runResident(i: number): Promise<Record<string, unknown>> {
  if (!server) await startServer()
  Object.assign(env, { AF_QWEN_PIPE_ADDR: PIPE.addr, AF_QWEN_PIPE_KEY: PIPE.key, AUDIOFORGE_QWEN_RESIDENT_BRIDGE: '1' })
  return runProcess(i)
}

const results: Record<string, unknown>[] = []
const gpu = (): string => { try { return execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader').toString().trim() } catch { return '?' } }
const head = { mode: MODE, chunks: says.map((s) => s.length), gpuBefore: gpu(), at: new Date().toISOString() }
console.log(JSON.stringify(head))
for (let i = 0; i < says.length; i++) {
  if (MODE !== 'process' && MODE !== 'resident') throw new Error('--mode process|resident')
  const r = MODE === 'process' ? await runProcess(i) : await runResident(i)
  results.push(r)
  console.log(JSON.stringify({ i: r.i, chars: r.chars, ms: r.ms, audioSec: r.audioSec, rtf: r.rtf }))
}
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ...head, gpuAfter: gpu(), results }, null, 2))
if (server) { server.stdin!.end(); server.kill() }
