// provision-helpers 순수 헬퍼 계약 — node --test, 새 의존성 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_OPTIONAL,
  pickProvisionPython,
  parseProvisionEnvelope,
  envelopeReasonCode,
} from './provision-helpers.ts'

// ── pickProvisionPython: 명시 주입만 인정, 우선순위 env > provisionPythonPath > pythonPath ──
test('env AUDIOFORGE_PROVISION_PYTHON이 최우선', () => {
  const r = pickProvisionPython(
    { AUDIOFORGE_PROVISION_PYTHON: 'C:/py/env.exe' },
    { provisionPythonPath: 'C:/py/prov.exe', pythonPath: 'C:/py/interp.exe' },
  )
  assert.equal(r, 'C:/py/env.exe')
})

test('env 없으면 provisionPythonPath, 그다음 pythonPath', () => {
  assert.equal(pickProvisionPython({}, { provisionPythonPath: 'C:/py/prov.exe', pythonPath: 'C:/py/interp.exe' }), 'C:/py/prov.exe')
  assert.equal(pickProvisionPython({}, { pythonPath: 'C:/py/interp.exe' }), 'C:/py/interp.exe')
})

test('명시 주입원이 하나도 없으면 null(자동 채택 금지)', () => {
  assert.equal(pickProvisionPython({}, {}), null)
  assert.equal(pickProvisionPython({ AUDIOFORGE_PROVISION_PYTHON: '' }, { pythonPath: '' }), null)
})

// ── parseProvisionEnvelope: 마지막 envelope 라인만, 비-JSON/경고는 무시 ──
test('provision-result envelope을 파싱', () => {
  const out = 'some warning line\n{"type":"provision-result","ok":true,"result":{"schemaVersion":1}}\n'
  const r = parseProvisionEnvelope(out)
  assert.ok(r)
  assert.equal(r!.ok, true)
  assert.deepEqual(r!.result, { schemaVersion: 1 })
})

test('provision-error envelope을 파싱', () => {
  const out = '{"type":"provision-error","ok":false,"error":{"code":"APPLY_DISABLED","message":"x"}}'
  const r = parseProvisionEnvelope(out)
  assert.ok(r)
  assert.equal(r!.ok, false)
  assert.equal(r!.error?.code, 'APPLY_DISABLED')
})

test('envelope이 없으면 null', () => {
  assert.equal(parseProvisionEnvelope('그냥 로그\n[warn] blah'), null)
  assert.equal(parseProvisionEnvelope('{"type":"progress","percent":10}'), null)  // 다른 type은 봉투 아님
})

test('여러 라인 중 마지막 봉투를 취한다', () => {
  const out = '{"type":"provision-result","ok":true,"result":{"n":1}}\n{"type":"provision-result","ok":true,"result":{"n":2}}'
  const r = parseProvisionEnvelope(out)
  assert.deepEqual(r!.result, { n: 2 })
})

// ── envelopeReasonCode: 계약 코드만, 미상은 APPLY_DISABLED ──
test('계약 ReasonCode는 그대로, 비계약/미상은 APPLY_DISABLED', () => {
  assert.equal(envelopeReasonCode({ code: 'BOOTSTRAP_PYTHON_UNRESOLVED' }), 'BOOTSTRAP_PYTHON_UNRESOLVED')
  assert.equal(envelopeReasonCode({ code: 'not-a-code' }), 'APPLY_DISABLED')
  assert.equal(envelopeReasonCode(undefined), 'APPLY_DISABLED')
  assert.equal(envelopeReasonCode({}), 'APPLY_DISABLED')
})

test('ALL_OPTIONAL은 비어 있다 — Python cli가 wildcard를 fail-closed로 거부하므로', () => {
  assert.deepEqual([...ALL_OPTIONAL], [])
  // '*'를 보내면 provision_cli가 UNRESOLVED_COMPONENT로 계획 전체를 거부한다(회귀 가드).
  assert.ok(!(ALL_OPTIONAL as readonly string[]).includes('*'))
})
