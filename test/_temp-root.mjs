// 검사도 **C 드라이브로 가지 않는다** — 그리고 **검사가 끝나면 치운다.**
//
// ★왜 (2026-09-28 지시): "가장 중요한건 6번이다. C 드라이브로 가지 않아야한다."
//   검사는 격리 userData·입력물 복사본·분리 중간물을 시스템 임시 폴더에 만들고 있었다.
//   실패한 실행은 정리를 건너뛰므로 **잔해가 계속 쌓였다**(폴더 규칙 문서에 적어 둔 그대로).
//
// ★한 줄로 막는 이유 (실측): `os.tmpdir()` 은 부를 때마다 TEMP/TMP 를 다시 읽고,
//   이 프로세스가 띄우는 Electron·파이썬 자식은 env 를 그대로 물려받는다.
//   그래서 검사 파일마다 정리를 고치지 않아도 이 한 곳이면 전부 따라온다.
//
// ★실행마다 제 폴더(`<테스트 폴더>/임시/r<pid>`, 테스트 폴더 = 본체 저장소 `_local/테스트` — tools/test-root.cjs)를 쓰고 **끝날 때 통째로 지운다** (2026-09-30).
//   자리만 옮겼을 때는 치우지 않는 검사들의 잔해가 하루 수백 개씩 쌓였다(4,812개 · 1.6GB 실측).
//   자식 프로세스는 부모의 폴더를 물려받아 쓰고(`AF_TEST_RUN_DIR`), 지우는 것은 만든 프로세스 하나뿐이다.
//   강제 종료로 못 지운 폴더는 다음 실행이 치운다 — 그 번호의 프로세스가 이미 없을 때만.
//   남겨 보고 싶으면 `AF_KEEP_TEST_TEMP=1` (폴더에 `.keep` 을 두어 다음 실행도 건드리지 않는다).
//
// ★이름을 짧게 둔 이유: 저장소 경로가 이미 79자다. 윈도우 경로 상한(260)까지
//   여유가 얼마 없어 실행 폴더를 `r<pid>` 로 둔다.
// ★2026-10-10 사용자 결정: 검사·개발 도구가 만드는 파일은 모두 테스트 전용 폴더 한 곳으로 — 임시는 그 아래 `임시/`.
//
// 쓰는 자리 — 검사 파일마다 **첫 import**(검사 도구가 불러오는 순간 임시 자리를 정하므로),
// `test/e2e/_e2e-helper.mjs` 맨 위, `scripts/verify.mjs` 맨 위, 단위 검사는 `npm test` 의 `--import` 로.
// 파이썬 검사가 단독으로 돌 때는 `python/_test_temp.py` 가 같은 일을 한다.
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const TR = createRequire(import.meta.url)('../tools/test-root.cjs')
export const TEST_TEMP_BASE = path.join(TR.TEST_ROOT, TR.SUB.temp)

const inherited = process.env.AF_TEST_RUN_DIR
const reuse = !!inherited && path.dirname(inherited) === TEST_TEMP_BASE && fs.existsSync(inherited)

/** 그 번호의 프로세스가 살아 있는가. 윈도우에서도 신호 0 은 있는지만 본다(libuv). */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/** 죽은 실행이 남긴 폴더를 치운다. 산 실행·남겨 두라고 한 폴더는 건드리지 않는다. */
function sweep() {
  let names = []
  try { names = fs.readdirSync(TEST_TEMP_BASE) } catch { return }
  for (const n of names) {
    const m = /^r(\d+)$/.exec(n)
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue
    const p = path.join(TEST_TEMP_BASE, n)
    if (fs.existsSync(path.join(p, '.keep'))) continue
    try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 아직 잡혀 있다 — 다음에 */ }
  }
}

export const TEST_TEMP_ROOT = reuse ? inherited : path.join(TEST_TEMP_BASE, `r${process.pid}`)

if (!reuse) {
  fs.mkdirSync(TEST_TEMP_BASE, { recursive: true })
  sweep()
  // 같은 번호의 옛 폴더가 남아 있으면 그것은 죽은 실행의 것이다(번호는 산 프로세스끼리만 겹치지 않는다).
  try { fs.rmSync(TEST_TEMP_ROOT, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true })
  process.env.AF_TEST_RUN_DIR = TEST_TEMP_ROOT
  if (process.env.AF_KEEP_TEST_TEMP === '1') {
    fs.writeFileSync(path.join(TEST_TEMP_ROOT, '.keep'), '')
    process.on('exit', () => { console.log(`[temp] 검사 임시 폴더를 남겼다: ${TEST_TEMP_ROOT}`) })
  } else {
    // 'exit' 에서는 동기 작업만 된다. 잡힌 파일이 있으면 남기고, 다음 실행의 청소가 치운다.
    process.on('exit', () => { try { fs.rmSync(TEST_TEMP_ROOT, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 다음에 */ } })
  }
}

// 셋 다 바꾼다 — Node 는 TEMP/TMP 를, 파이썬은 TMPDIR 을 먼저 본다.
process.env.TEMP = TEST_TEMP_ROOT
process.env.TMP = TEST_TEMP_ROOT
process.env.TMPDIR = TEST_TEMP_ROOT
