// qwenVenvPids 순수 함수 단위테스트(GPU·실프로세스 없음). 공용 마감 K2-보완.
// 실행: node --test test/e2e/_e2e-helper.qwenpids.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCimProcJson, filterWorktreeQwenPids, normPathForMatch } from './_e2e-helper.mjs'

const WT = 'E:/AI_Project/claudeCodeVsCode/_af_worktrees/integration'
const bridge = WT + '/python/qwen_bridge.py'
// 현재 worktree Qwen bridge(백슬래시·대소문자 혼재) — 포함되어야 함
const ours = {
  ProcessId: 111,
  ExecutablePath: WT.replace(/\//g, '\\') + '\\externals\\qwen3_tts_venv\\Scripts\\python.exe',
  CommandLine: '"' + WT.replace(/\//g, '\\') + '\\externals\\qwen3_tts_venv\\Scripts\\PYTHON.exe" -X utf8 -u "' + WT.replace(/\//g, '\\') + '\\python\\QWEN_BRIDGE.py"'
}
// 같은 venv지만 '다른 checkout'의 bridge — 제외되어야 함
const otherCheckout = {
  ProcessId: 222,
  ExecutablePath: 'E:\\AI_Project\\claudeCodeVsCode\\apps\\development\\AudioForge\\externals\\qwen3_tts_venv\\Scripts\\python.exe',
  CommandLine: '"E:\\AI_Project\\claudeCodeVsCode\\apps\\development\\AudioForge\\externals\\qwen3_tts_venv\\Scripts\\python.exe" -X utf8 -u "E:\\AI_Project\\claudeCodeVsCode\\apps\\development\\AudioForge\\python\\qwen_bridge.py"'
}
const comfy = { ProcessId: 333, ExecutablePath: 'E:\\AI\\ComfyUI\\python_embeded\\python.exe', CommandLine: '.\\python_embeded\\python.exe -s ComfyUI\\main.py' }
const plainPy = { ProcessId: 444, ExecutablePath: 'C:\\Python312\\python.exe', CommandLine: 'python foo.py' }

test('parseCimProcJson: 단일 객체 → 배열화', () => {
  assert.deepEqual(parseCimProcJson('{"ProcessId":7}'), [{ ProcessId: 7 }])
})
test('parseCimProcJson: 배열 그대로', () => {
  assert.equal(parseCimProcJson('[{"ProcessId":1},{"ProcessId":2}]').length, 2)
})
test('parseCimProcJson: 빈 출력·null → []', () => {
  assert.deepEqual(parseCimProcJson(''), [])
  assert.deepEqual(parseCimProcJson('   '), [])
  assert.deepEqual(parseCimProcJson('null'), [])
})
test('parseCimProcJson: 잘못된 JSON → throw(조용한 [] 금지)', () => {
  assert.throws(() => parseCimProcJson('this is not json'), /CIM JSON 파싱 실패/)
})

test('filterWorktreeQwenPids: 현재 worktree bridge만 포함(대소문자·slash 무시)', () => {
  const pids = filterWorktreeQwenPids([ours, otherCheckout, comfy, plainPy], [bridge])
  assert.deepEqual(pids, [111])
})
test('filterWorktreeQwenPids: 다른 checkout의 같은 venv Qwen은 제외', () => {
  const pids = filterWorktreeQwenPids([otherCheckout], [bridge])
  assert.deepEqual(pids, [])
})
test('filterWorktreeQwenPids: ComfyUI·일반 python 제외', () => {
  assert.deepEqual(filterWorktreeQwenPids([comfy, plainPy], [bridge]), [])
})
test('filterWorktreeQwenPids: 후보 경로가 백슬래시·대문자여도 일치', () => {
  const cand = WT.replace(/\//g, '\\').toUpperCase() + '\\PYTHON\\QWEN_BRIDGE.PY'
  assert.deepEqual(filterWorktreeQwenPids([ours], [cand]), [111])
})
test('filterWorktreeQwenPids: 빈 후보 → []', () => {
  assert.deepEqual(filterWorktreeQwenPids([ours], []), [])
  assert.deepEqual(filterWorktreeQwenPids([ours], ['']), [])
})
test('filterWorktreeQwenPids: qwen venv 아니면(브리지 경로만 우연 포함) 제외', () => {
  const fake = { ProcessId: 555, ExecutablePath: 'C:\\Python312\\python.exe', CommandLine: 'python -u ' + bridge }
  assert.deepEqual(filterWorktreeQwenPids([fake], [bridge]), [])  // qwen3_tts_venv 조건 불충족
})
test('normPathForMatch: slash·대소문자 정규화', () => {
  assert.equal(normPathForMatch('E:\\A\\B'), 'e:/a/b')
  assert.equal(normPathForMatch(null), '')
})
