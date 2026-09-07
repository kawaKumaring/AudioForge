// python/test_*.py 를 전부 돌린다. 파일마다 별도 프로세스로 — 한 파일이 남긴 전역 상태가
// 다음 파일의 판정을 바꾸지 않게 하기 위해서다(Qwen 시험들이 전역 격리 클래스를 쓰는 이유와 같다).
//
// 왜 게이트에 넣는가(2026-09-08): 이 저장소의 파이썬 시험 110개 중 27개가 import 단계에서
// 죽어 있었고(앱 파이썬은 ._pth 때문에 스크립트 폴더를 sys.path 에 넣지 않는다), 그중 하나는
// 사흘 전 정책 변경으로 계약이 어긋난 채 실패하고 있었다. 아무도 몰랐던 이유는 단순하다 —
// **전체를 돌리는 자리가 없었다.** 실측 172초. 병합 판단에 그만한 값은 한다.
//
// 사용: node scripts/python-tests.mjs [--python <path>]
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PER_FILE_TIMEOUT_MS = 300000

function appPython() {
  const i = process.argv.indexOf('--python')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (process.env.AUDIOFORGE_PYTHON && existsSync(process.env.AUDIOFORGE_PYTHON)) {
    return process.env.AUDIOFORGE_PYTHON
  }
  const cfg = path.join(ROOT, 'externals', 'env.json')
  if (existsSync(cfg)) {
    try {
      const p = JSON.parse(readFileSync(cfg, 'utf-8')).python
      if (p && existsSync(p)) return p
    } catch { /* 형식이 깨졌으면 없는 것으로 본다 */ }
  }
  return null
}

const py = appPython()
if (!py) {
  console.error('파이썬을 찾지 못했다(AUDIOFORGE_PYTHON · externals/env.json).')
  process.exit(2)
}

const files = readdirSync(path.join(ROOT, 'python'))
  .filter((f) => f.startsWith('test_') && f.endsWith('.py'))
  .sort()

let passed = 0
let failedFiles = []
let total = 0
const t0 = Date.now()
for (const f of files) {
  const r = spawnSync(py, ['-X', 'utf8', path.join('python', f)], {
    cwd: ROOT, encoding: 'utf-8', timeout: PER_FILE_TIMEOUT_MS,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const ran = /Ran (\d+) tests?/.exec(out)
  total += ran ? Number(ran[1]) : 0
  // unittest 는 결과를 stderr 로 낸다. 'OK' 한 줄이 곧 전원 통과다.
  if (r.status === 0 && /^OK/m.test(out)) {
    passed++
  } else {
    const why = r.error ? String(r.error.message)
      : (/^(FAILED.*|.*Error.*)$/m.exec(out)?.[0] || `exit=${r.status}`)
    failedFiles.push({ f, ran: ran ? ran[1] : '0', why: why.slice(0, 160) })
  }
}
const secs = Math.round((Date.now() - t0) / 1000)
for (const x of failedFiles) console.log(`  실패 ${x.f} (${x.ran}건) — ${x.why}`)
console.log(`파이썬 시험 ${total}건 · 파일 ${passed}/${files.length} 통과 · ${secs}초`)
process.exit(failedFiles.length === 0 ? 0 : 1)
