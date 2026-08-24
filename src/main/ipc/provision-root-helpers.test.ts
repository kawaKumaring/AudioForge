import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalFingerprint,
  deriveManagedRoots,
  opaqueFingerprint,
  publicRootStatus,
  type ManagedRootRecord,
} from './provision-root-helpers.ts'

test('managed base root에서 runtime/models/cache를 고정 파생', () => {
  assert.deepEqual(deriveManagedRoots('D:\\AudioForgeData\\'), {
    runtimeRoot: 'D:\\AudioForgeData\\runtime',
    modelRoot: 'D:\\AudioForgeData\\models',
    cacheRoot: 'D:\\AudioForgeData\\cache',
  })
})

test('public status는 전체 경로를 포함하지 않고 label/token/opaque fingerprint만 반환', () => {
  const record: ManagedRootRecord = {
    baseRoot: 'D:\\secret\\AudioForgeData',
    token: 'root-token',
    rootFingerprint: opaqueFingerprint('secret', 'root', 'D:\\secret\\AudioForgeData'),
    volumeIdentity: opaqueFingerprint('secret', 'volume', 'D:'),
    selectedAt: '2026-08-25T00:00:00.000Z',
  }
  const status = publicRootStatus(record)
  assert.equal(status.configured, true)
  assert.equal(status.displayLabel, '사용자 선택 관리형 위치')
  assert.equal(status.token, 'root-token')
  assert.ok(!JSON.stringify(status).includes('D:\\secret'))
  assert.match(status.rootFingerprint!, /^[0-9a-f]{64}$/)
  assert.match(status.volumeIdentity!, /^[0-9a-f]{64}$/)
})

test('root 미선택은 명시적인 비준비 상태', () => {
  assert.deepEqual(publicRootStatus(null), {
    configured: false,
    displayLabel: '관리형 설치 위치를 선택하지 않음',
    token: null,
    rootFingerprint: null,
    volumeIdentity: null,
  })
})

test('approval fingerprint는 profile/plan/root/volume 네 축 모두에 결합', () => {
  const base = { profile: 'minimal-qwen', planFingerprint: 'p1', rootFingerprint: 'r1', volumeIdentity: 'v1' }
  const a = approvalFingerprint(base)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, approvalFingerprint({ ...base, profile: 'other' }))
  assert.notEqual(a, approvalFingerprint({ ...base, planFingerprint: 'p2' }))
  assert.notEqual(a, approvalFingerprint({ ...base, rootFingerprint: 'r2' }))
  assert.notEqual(a, approvalFingerprint({ ...base, volumeIdentity: 'v2' }))
  assert.equal(a, approvalFingerprint(base), '동일 입력은 결정적이어야 한다')
})
