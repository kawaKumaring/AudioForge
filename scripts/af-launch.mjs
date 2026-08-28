#!/usr/bin/env node
/**
 * AudioForge 실행 런처 — run.bat 이 부르는 유일한 진입점.
 *
 *   환경 점검 → (누락 시) 설치 → 재점검 → 앱 실행
 *
 * 이 파일이 스스로 판단하는 것은 딱 하나, **앱 전용 파이썬이 있는가** 뿐이다.
 * 그 외의 모든 판정(무엇이 설치됐는지, 검증을 통과했는지, 어디에 연결됐는지)은
 * python/app_runtime.py 에 물어본다. 같은 규칙을 두 언어로 두 번 쓰면 반드시
 * 어긋나기 때문에, 규칙의 소유자는 파이썬 쪽 하나로 둔다.
 *
 * 파이썬이 아직 없을 때만 여기서 내려받는다(닭과 달걀). 그 외에는 위임한다.
 *
 * 사용법:
 *   node scripts/af-launch.mjs            점검 → 필요 시 설치 → 앱 실행
 *   node scripts/af-launch.mjs --check    점검만 (종료코드 0=정상, 1=미비)
 *   node scripts/af-launch.mjs --install  설치까지만 (앱 실행 안 함)
 *   node scripts/af-launch.mjs --plan     설치 계획만 출력
 *   node scripts/af-launch.mjs --yes      설치 동의를 비대화식으로 승인
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SPEC_PATH = join(REPO, 'python', 'runtime_spec.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const MODE = has('--check') ? 'check'
  : has('--plan') ? 'plan'
    : has('--install') ? 'install'
      : 'launch'

function log(msg) { process.stdout.write(msg + '\n') }
function bar() { log('-'.repeat(68)) }

function runtimeRoot() {
  const override = process.env.AUDIOFORGE_RUNTIME_ROOT
  return override ? resolve(override) : join(REPO, 'externals')
}

function readSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf-8'))
}

function appPythonPath(spec) {
  const dir = join(runtimeRoot(), ...spec.interpreter.install_dir.split('/'))
  return join(dir, 'python.exe')
}

/** 실행 가능한지 실제로 물어본다. 파일이 있다는 사실만으로 믿지 않는다. */
function pythonWorks(exe) {
  if (!existsSync(exe)) return false
  const r = spawnSync(exe, ['-c', 'import sys;print(sys.version_info[0],sys.version_info[1])'],
    { encoding: 'utf-8', timeout: 30000 })
  if (r.status !== 0 || !r.stdout) return false
  const [maj, min] = r.stdout.trim().split(/\s+/).map(Number)
  return maj === 3 && min >= 9
}

// ── 앱 전용 파이썬 부트스트랩 (여기서만 내려받는다) ─────────────────────

function sha256File(path) {
  const h = createHash('sha256')
  h.update(readFileSync(path))
  return h.digest('hex')
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  const chunks = []
  let got = 0
  let lastPct = -1
  for await (const chunk of res.body) {
    chunks.push(chunk)
    got += chunk.length
    if (total) {
      const pct = Math.floor((got / total) * 100)
      if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`  ${pct}% `) }
    }
  }
  process.stdout.write('\n')
  writeFileSync(dest, Buffer.concat(chunks))
  return got
}

async function ensureAppPython(spec) {
  const exe = appPythonPath(spec)
  if (pythonWorks(exe)) return exe

  const i = spec.interpreter
  const targetDir = dirname(exe)
  const staging = join(runtimeRoot(), '.staging', `python-${i.release_tag}-${process.pid}`)

  bar()
  log('앱 전용 파이썬이 없습니다. 지금 준비합니다.')
  log(`  CPython ${i.python_version} (python-build-standalone ${i.release_tag})`)
  log(`  내려받기 : ${(i.download_bytes / 1048576).toFixed(1)} MiB`)
  log(`  설치 위치: ${targetDir}`)
  log('  영향 범위: 이 폴더만. PATH·레지스트리·시스템 파이썬을 바꾸지 않습니다.')
  log(`  라이선스 : ${i.license}`)
  bar()

  // 설치 위치가 이미 차 있으면 내려받기 전에 멈춘다.
  // (중단된 설치의 잔해일 수 있고, 그것을 우리가 판단해 지울 일은 아니다.)
  if (existsSync(targetDir)) {
    throw new Error(
      `설치 위치에 이미 무언가 있습니다: ${targetDir}\n` +
      '  실행 가능한 파이썬은 아니었습니다(중단된 설치의 잔해일 수 있습니다).\n' +
      '  내용을 확인한 뒤 그 폴더를 직접 지우고 다시 실행하세요. 여기서는 손대지 않습니다.')
  }

  mkdirSync(staging, { recursive: true })
  try {
    const tarball = join(staging, i.asset)
    log('내려받는 중...')
    const bytes = await download(i.url, tarball)

    const digest = sha256File(tarball)
    if (digest !== i.sha256) {
      throw new Error(
        `내려받은 파일의 sha256 이 명세와 다릅니다.\n  기대: ${i.sha256}\n  실제: ${digest}\n` +
        '  네트워크 문제이거나 자산이 교체되었습니다. 설치를 중단합니다.')
    }
    log(`sha256 확인: ${digest} (${(bytes / 1048576).toFixed(1)} MiB)`)

    // install_only 배포물은 최상위에 python/ 하나만 들어 있다.
    const tar = spawnSync('tar', ['-xzf', i.asset], { cwd: staging, stdio: 'inherit' })
    if (tar.status !== 0) throw new Error(`압축 해제 실패 (tar 종료코드 ${tar.status})`)

    const extracted = join(staging, 'python')
    if (!existsSync(join(extracted, 'python.exe'))) {
      throw new Error(`압축 해제 결과에 python.exe 가 없습니다: ${extracted}`)
    }

    // 검증이 끝난 뒤에만 최종 위치로 옮긴다.
    mkdirSync(dirname(targetDir), { recursive: true })
    renameSync(extracted, targetDir)
  } finally {
    // 우리가 방금 만든 이 한 폴더만 치운다. 실패했을 때도 찌꺼기를 남기지 않는다.
    // 비게 된 .staging 껍데기도 함께(비어 있을 때만) 정리한다.
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* 남아도 무해 */ }
    try { rmSync(dirname(staging)) } catch { /* 비어 있지 않으면 그대로 둔다 */ }
  }

  if (!pythonWorks(exe)) throw new Error(`설치했지만 실행되지 않습니다: ${exe}`)
  log(`앱 전용 파이썬 준비 완료: ${exe}`)
  return exe
}

// ── 파이썬에 위임 ────────────────────────────────────────────────────────

function probe(python) {
  const r = spawnSync(python, ['-X', 'utf8', join(REPO, 'python', 'app_runtime.py'), '--json'],
    { encoding: 'utf-8', timeout: 120000 })
  if (!r.stdout) {
    return { ok: false, reason: 'PROBE_FAILED', error: (r.stderr || '').slice(-1500) }
  }
  const line = r.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
  if (!line) return { ok: false, reason: 'PROBE_FAILED', error: r.stdout.slice(-1500) }
  const parsed = JSON.parse(line)
  return parsed.gptsovits
}

function installer(python, args) {
  return spawnSync(python,
    ['-X', 'utf8', '-u', join(REPO, 'python', 'app_env_installer.py'), ...args],
    { stdio: 'inherit' }).status
}

function npmRun(args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return spawnSync(npm, args, {
    cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32'
  }).status
}

function launchApp() {
  // 앱 의존성은 **실제로 띄우기 직전에만** 확인한다. --check/--plan 같은 진단 명령이
  // 수백 MB짜리 npm install 을 끌고 오면 진단이 아니라 사건이 된다.
  if (!existsSync(join(REPO, 'node_modules'))) {
    log('\nnpm 의존성이 없습니다. 먼저 설치합니다 (첫 실행).')
    const rc = npmRun(['install'])
    if (rc !== 0) {
      failure('npm install 이 실패했습니다.', '  위 오류를 고친 뒤 run.bat 을 다시 실행하세요.')
      return rc === null ? 1 : rc
    }
  }
  log('\n환경 정상 — 앱을 시작합니다.\n')
  const status = npmRun(['run', 'dev'])
  return status === null ? 1 : status
}

function failure(reason, extra) {
  bar()
  log('앱을 시작하지 않았습니다.')
  bar()
  log(`원인 : ${reason}`)
  if (extra) log(extra)
  log('')
  log('재개 방법:')
  log('  1) run.bat 을 다시 실행하면 이 지점부터 다시 시도합니다.')
  log('  2) 계획만 보기   : node scripts/af-launch.mjs --plan')
  log('  3) 설치만 다시   : node scripts/af-launch.mjs --install')
  log('  4) 상세 진단     : node scripts/af-launch.mjs --check')
  log('')
  log('이미 정상인 다른 환경(Qwen 등)의 연결은 그대로입니다.')
  bar()
}

async function main() {
  let spec
  try {
    spec = readSpec()
  } catch (e) {
    failure(`설치 명세를 읽을 수 없습니다: ${SPEC_PATH}`, `  ${e.message}`)
    return 2
  }

  let python
  try {
    python = await ensureAppPython(spec)
  } catch (e) {
    failure('앱 전용 파이썬을 준비하지 못했습니다.', `  ${e.message}`)
    return 2
  }

  if (MODE === 'plan') return installer(python, ['plan'])

  let p = probe(python)
  if (MODE === 'check') {
    log(`GPT-SoVITS 환경: ${p.ok ? '정상' : '미비 (' + p.reason + ')'}`)
    if (!p.ok) {
      installer(python, ['status'])
    } else {
      log(`  python: ${p.python}`)
      log(`  repo  : ${p.repo}`)
    }
    return p.ok ? 0 : 1
  }

  if (!p.ok) {
    bar()
    log(`환경 점검: 미비 — ${p.reason}`)
    bar()
    const args = ['install']
    if (has('--yes')) args.push('--yes')
    const rc = installer(python, args)
    if (rc !== 0) {
      const why = rc === 3 ? '사용자가 설치를 취소했습니다.'
        : rc === 2 ? '설치 전제 조건이 갖춰지지 않았습니다(위 계획의 [!] 항목).'
          : '설치 또는 검증이 실패했습니다.'
      failure(why, null)
      return rc
    }
    p = probe(python)
    if (!p.ok) {
      failure(`설치는 끝났지만 재점검을 통과하지 못했습니다: ${p.reason}`, null)
      return 1
    }
  } else {
    log(`환경 점검: 정상 (재설치 없음) — ${p.python}`)
  }

  if (MODE === 'install') {
    log('설치·검증·연결 완료. (--install 이므로 앱은 시작하지 않습니다.)')
    return 0
  }
  return launchApp()
}

main().then((code) => process.exit(code)).catch((e) => {
  failure('예기치 못한 오류', `  ${e && e.stack ? e.stack : e}`)
  process.exit(2)
})
