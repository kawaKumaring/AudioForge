// 본체 규칙 두 가지를 글자로 지킨다 (2026-10-16 점검에서 나온 것).
//
// 1) 파이썬 스크립트 자리는 python-runner 의 findPythonScript 한 곳에서만 정한다.
//    예전에는 일곱 곳이 따로 찾았고, 넷은 '모듈 기준 세 칸 위'(묶인 본체에선 저장소 바깥) 다음
//    process.cwd() 에 기대어, 실행 폴더가 앱 폴더가 아니면 그 기능만 실패했다.
// 2) 참조 선택 저장 실패를 성공으로 보고하지 않는다.
//    예전에는 저장 실패를 삼키고 ok:true 를 돌려줘, 다시 열면 선택이 사라졌고 원인 기록도 없었다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const MAIN = join(process.cwd(), 'src', 'main')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

test('파이썬 스크립트 자리를 따로 찾는 코드가 본체에 없다', () => {
  const bad: string[] = []
  for (const f of sources(MAIN)) {
    const rel = relative(MAIN, f).replace(/\\/g, '/')
    if (rel === 'services/python-runner.ts') continue
    const src = readFileSync(f, 'utf8')
    if (/process\.cwd\(\)\s*,\s*'python'/.test(src)) bad.push(`${rel}: process.cwd() 기준`)
    if (/'\.\.'\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'python'/.test(src)) bad.push(`${rel}: 모듈 기준 세 칸 위`)
    if (/__dirname\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'python'/.test(src)) bad.push(`${rel}: __dirname 기준 직접 조립`)
  }
  assert.deepEqual(bad, [], '스크립트 자리는 findPythonScript/getScriptPath 로만 찾는다')
})

test('참조 선택 저장은 성공 여부를 돌려주고, 실패면 SAVE_FAILED 로 답한다', () => {
  const index = readFileSync(join(MAIN, 'index.ts'), 'utf8')
  assert.match(index, /function writeSelectedReferenceId\(referenceId: string \| null\): boolean/)
  const ipc = readFileSync(join(MAIN, 'ipc', 'reference-library.ipc.ts'), 'utf8')
  const calls = ipc.match(/deps\.writeSelectedId\(/g) ?? []
  const checked = ipc.match(/if \(!deps\.writeSelectedId\([^)]*\)\) return \{ ok: false, reason: 'SAVE_FAILED' \}/g) ?? []
  assert.ok(calls.length >= 2, '선택·해제 두 곳이 있어야 한다')
  assert.equal(checked.length, calls.length, '저장 결과를 확인하지 않는 호출이 있다')
})
