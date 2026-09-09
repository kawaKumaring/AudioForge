// 병합 전 확인 — 초록이 아니면 master 로 올리지 않는다.
//
// 왜 필요한가: 정식 v1.4.0 을 올릴 때 이식성 검사 1건이 실패 상태였고 감정 정의 드리프트 가드는
// 대상 파일이 옮겨간 뒤 줄곧 무력했다. 둘 다 사람이 손으로 챙겨야 했기 때문에 그대로 따라 올라갔다.
// 확인 항목을 한 줄로 묶어 두면 "전량 통과"를 기억이 아니라 실행으로 확인한다.
//
// 실행
//   node scripts/verify.mjs             빠른 확인(앱을 띄우지 않는다 — 타입·단위·빌드·파이썬 스모크)
//   node scripts/verify.mjs --app-ui    위 + 실제 앱 UI 경로(목소리 준비·구간·설정). **GPU 안 씀**
//   node scripts/verify.mjs --app       위 + 합성 1회까지. **GPU 를 쓴다** — 병합 직전에만.
//
// 파이썬은 앱과 같은 규칙으로 찾는다: AUDIOFORGE_PYTHON → externals/env.json → 없으면 그 단계만 건너뛰고
// **건너뛴 사실을 요약에 남긴다**(조용히 통과시키지 않는다).
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WITH_APP = process.argv.includes('--app')
// UI 경로만 확인하는 단계는 합성을 하지 않아 GPU 를 쓰지 않는다 — 평소 확인에 쓸 수 있다.
const WITH_APP_UI = WITH_APP || process.argv.includes('--app-ui')
const results = []

function run(name, cmd, args, opts = {}) {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  const ok = r.status === 0
  results.push({ name, state: ok ? 'PASS' : 'FAIL', sec, detail: ok ? '' : `exit ${r.status}` })
  console.log(`\n[verify] ${ok ? 'PASS' : 'FAIL'} ${name} (${sec}초)\n`)
  return ok
}

function skip(name, why) {
  results.push({ name, state: 'SKIP', sec: '0.0', detail: why })
  console.log(`\n[verify] SKIP ${name} — ${why}\n`)
}

function appPython() {
  if (process.env.AUDIOFORGE_PYTHON && existsSync(process.env.AUDIOFORGE_PYTHON)) return process.env.AUDIOFORGE_PYTHON
  const cfg = path.join(ROOT, 'externals', 'env.json')
  if (!existsSync(cfg)) return null
  try {
    const p = JSON.parse(readFileSync(cfg, 'utf-8')).python
    return typeof p === 'string' && existsSync(p) ? p : null
  } catch { return null }
}

// ── 앱을 띄우지 않는 확인 ────────────────────────────────────────────────
run('타입 검사(renderer)', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.web.json'])
run('타입 검사(main/shared)', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json'])
run('단위·계약 테스트', 'node', ['--test', 'src/**/*.test.ts'])
run('모델 이용 조건', 'node', [path.join('scripts', 'check-model-licenses.mjs')])
run('빌드', 'npx', ['electron-vite', 'build'])

const py = appPython()
if (py) {
  run('파이썬 스모크(--quick)', py, ['-X', 'utf8', path.join('python', 'smoke_test.py'), '--quick'],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
  run('파이썬 모델 판 계약', py, ['-X', 'utf8', path.join('python', 'test_qwen_model_variants.py')],
    { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
  // 파이썬 시험 전량(실측 ~172초). 예전에는 스모크와 계약 한둘만 돌려서, 시험 110개 중 27개가
  // import 단계에서 죽어 있는 것도 그중 하나가 사흘째 계약 불일치로 실패하는 것도 보이지 않았다.
  // 파이썬 경로는 argv 가 아니라 환경변수로 넘긴다 — 이 run() 은 Windows 에서 shell:true 라
  // 공백이 든 경로(Program Files 아래의 node.exe 같은 것)가 두 토큰으로 쪼개진다(실측 즉시 exit 1).
  run('파이썬 시험 전량', 'node', [path.join('scripts', 'python-tests.mjs')],
    { env: { ...process.env, AUDIOFORGE_PYTHON: py } })
} else {
  skip('파이썬 스모크(--quick)', 'AUDIOFORGE_PYTHON·externals/env.json 에서 파이썬을 찾지 못했다')
  skip('파이썬 모델 판 계약', '같은 이유')
  skip('파이썬 시험 전량', '같은 이유')
}

// ── 실제 앱 핵심 경로(옵션) ──────────────────────────────────────────────
// 단위·계약 1,346건이 통과하는 상태에서 실제 앱 검사 4건이 실패한 적이 있다(2026-09-08).
// 모양 검사는 동작을 보증하지 않으므로, 병합 판단에는 이 단계를 함께 본다.
if (WITH_APP_UI) {
  run('실제 앱 · UI 경로(GPU 없음)', 'node', [path.join('test', 'e2e', 'tts-convenience-dev.e2e.mjs')])
  // 복원 중 목소리 선택 변경 — 늦은 결과가 새 선택을 덮지 않는가(클립 파일·합성에 갈 참조까지).
  // 화면·main 두 층이 겹치는 자리라 단위 검사로는 잡히지 않는다. GPU·음성 생성 없음.
  run('실제 앱 · 복원 중 선택 변경(GPU 없음)', 'node', [path.join('test', 'e2e', 'restore-race-dev.e2e.mjs')])
  // 재생 음량이 사용자가 정한 값으로 유지되는가 — 조절·적용·보관·다시 켜기까지.
  // 값이 요소에 실제로 걸리는지는 앱에서만 보인다(단위 검사는 소유자까지만 말한다). GPU 없음.
  run('실제 앱 · 재생 음량 유지(GPU 없음)', 'node', [path.join('test', 'e2e', 'playback-volume.e2e.mjs')])
} else {
  skip('실제 앱 · UI 경로', '--app-ui 를 주면 함께 확인한다(GPU 안 씀)')
  skip('실제 앱 · 복원 중 선택 변경', '같은 이유')
  skip('실제 앱 · 재생 음량 유지', '같은 이유')
}
if (WITH_APP) {
  // ★ 이름을 사실대로 적는다. `synthesize.e2e.mjs` 는 합성을 **시작한 뒤 취소**한다 —
  //   소리를 만들지 않는다. 예전에 이 단계를 '합성 1회' 로 적어 두었더니 4.9초에 통과했고,
  //   나는 그것을 합성 검증으로 읽었다. 모양만 맞는 검사가 통과로 세어지는 바로 그 종류다.
  run('실제 앱 · 합성 시작·취소 수명주기(GPU)', 'node', [path.join('test', 'e2e', 'synthesize.e2e.mjs')])
  // 소리가 실제로 나오는지는 완주 검사가 답한다. 참조 자산과 검증용 파이썬을 명시해야 돌고,
  // 주지 않으면 **통과처럼 종료**하므로(prerequisite skip) 여기서 저장소 fixture 와 앱 파이썬을 준다.
  const fixture = path.join(ROOT, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav')
  if (py && existsSync(fixture)) {
    run('실제 앱 · 합성 완주 + 결과물 검사(GPU)', 'node',
      [path.join('test', 'e2e', 'synthesize-complete.e2e.mjs')],
      { env: { ...process.env, AF_E2E_REFERENCE: fixture, AF_E2E_PYTHON: py } })
    // 합성이 도는 동안 설정을 만지면 참조 분석이 거절돼 오류가 튀어나왔다(2026-09-08 실사용 보고).
    // 화면과 워커가 겹치는 자리라 단위 검사로는 잡히지 않는다 — 실제로 합성을 돌리며 만져 본다.
    run('실제 앱 · 합성 중 설정 변경(GPU)', 'node',
      [path.join('test', 'e2e', 'analyze-during-synthesis.e2e.mjs')],
      { env: { ...process.env, AF_E2E_REFERENCE: fixture } })
  } else {
    skip('실제 앱 · 합성 완주', py ? 'fixture 없음' : '검증용 파이썬을 찾지 못했다')
    skip('실제 앱 · 합성 중 설정 변경', '같은 이유')
  }
} else {
  skip('실제 앱 · 합성 시작·취소', '--app 을 주면 함께 확인한다(GPU 를 쓴다 — 병합 직전에만)')
  skip('실제 앱 · 합성 완주', '같은 이유')
  skip('실제 앱 · 합성 중 설정 변경', '같은 이유')
}

// ── 요약 ─────────────────────────────────────────────────────────────────
const fail = results.filter((r) => r.state === 'FAIL')
const skipped = results.filter((r) => r.state === 'SKIP')
console.log('─'.repeat(64))
for (const r of results) console.log(`  ${r.state.padEnd(4)} ${r.name.padEnd(26)} ${r.sec.padStart(6)}초  ${r.detail}`)
console.log('─'.repeat(64))
console.log(`  통과 ${results.length - fail.length - skipped.length} · 실패 ${fail.length} · 건너뜀 ${skipped.length}`)
if (fail.length) {
  console.log('\n  ❌ 병합하지 않는다. 위 실패를 먼저 해결한다.')
} else if (skipped.length) {
  console.log('\n  ⚠️  통과했지만 건너뛴 항목이 있다 — 무엇을 확인하지 않았는지 위 목록으로 확인한다.')
} else {
  console.log('\n  ✅ 확인 항목 전부 통과.')
}
process.exit(fail.length ? 1 : 0)
