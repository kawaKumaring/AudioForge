// runtimeStatusView 순수 매핑 회귀 — Node 내장 러너(node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeStatusView, type RuntimeStatusReport } from './runtimeStatus.ts'
import { REASON_CODES } from './runtimeContract.ts'

function report(p: Partial<RuntimeStatusReport>): RuntimeStatusReport {
  return { resolved: false, interpreterBasename: null, ownership: null, reasonCode: null, ...p }
}

test('resolved → ready, 버튼 없음, basename·소유권 표기', () => {
  const v = runtimeStatusView(report({ resolved: true, interpreterBasename: 'python.exe', ownership: 'audioforge-managed' }))
  assert.equal(v.tone, 'ready')
  assert.equal(v.canSelectInterpreter, false)
  assert.match(v.detail, /python\.exe/)
  assert.match(v.detail, /전용 런타임/)
})

test('borrowed 소유권 라벨', () => {
  const v = runtimeStatusView(report({ resolved: true, interpreterBasename: 'python', ownership: 'external-borrowed' }))
  assert.equal(v.tone, 'ready')
  assert.match(v.detail, /빌려온 런타임/)
})

test('미해석 + reasonCode null → action, 인터프리터 선택 유도', () => {
  const v = runtimeStatusView(report({ resolved: false, reasonCode: null }))
  assert.equal(v.tone, 'action')
  assert.equal(v.canSelectInterpreter, true)
})

test('INTERPRETER_NOT_FOUND → action + 선택 버튼', () => {
  const v = runtimeStatusView(report({ reasonCode: 'INTERPRETER_NOT_FOUND' }))
  assert.equal(v.tone, 'action')
  assert.equal(v.canSelectInterpreter, true)
})

test('VENV_MISSING → incomplete(설치 필요), 자동 설치 문구 없음', () => {
  const v = runtimeStatusView(report({ reasonCode: 'VENV_MISSING' }))
  assert.equal(v.tone, 'incomplete')
  assert.equal(v.canSelectInterpreter, true)
  assert.doesNotMatch(v.detail, /자동|다운로드/)
})

test('MODEL_MISSING → incomplete', () => {
  assert.equal(runtimeStatusView(report({ reasonCode: 'MODEL_MISSING' })).tone, 'incomplete')
})

test('전체 25개 ReasonCode에 대해 안전한 View 반환(throw 없음, 유효 tone)', () => {
  const tones = new Set(['ready', 'action', 'incomplete'])
  for (const code of REASON_CODES) {
    const v = runtimeStatusView(report({ reasonCode: code }))
    assert.ok(tones.has(v.tone), `tone 유효: ${code} → ${v.tone}`)
    assert.equal(typeof v.title, 'string')
    assert.ok(v.title.length > 0)
    assert.equal(typeof v.detail, 'string')
    assert.ok(v.detail.length > 0)
  }
})
