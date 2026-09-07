// 모델 조건 게이트 계약 — 검사기가 무엇을 실패시키고 무엇을 알리기만 하는지 고정한다.
//
// 이 검사가 없으면 게이트가 조용히 무력해질 수 있다(감정 정의 드리프트 가드가 실제로 그렇게 됐다:
// 대상 파일이 옮겨간 뒤 id 를 하나도 못 찾은 채 계속 실패만 하고 있었다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { auditLicenses, referencedModels } from '../../scripts/check-model-licenses.mjs'

const INVENTORY = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../model-licenses.json', import.meta.url)), 'utf-8'))

const ref = (pairs: [string, string][]) => new Map(pairs)

test('인벤토리에 없는 모델은 실패다 — 무엇을 싣는지 모르는 상태를 통과시키지 않는다', () => {
  const r = auditLicenses({ distribution: { commercial: false }, models: [] },
    ref([['facebook/some-new-model', 'python/x.py']]))
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /인벤토리에 없는 모델/)
})

test('조건 미확인 모델 — 기본 경로면 실패, 선택 경로면 알림', () => {
  const inv = (dflt: boolean) => ({
    distribution: { commercial: false },
    models: [{ id: 'x/y', license: 'UNVERIFIED', non_commercial: null, default_path: dflt }],
  })
  const onDefault = auditLicenses(inv(true), ref([['x/y', 'a.py']]))
  assert.equal(onDefault.errors.length, 1)
  assert.match(onDefault.errors[0], /기본 경로/)
  const optional = auditLicenses(inv(false), ref([['x/y', 'a.py']]))
  assert.equal(optional.errors.length, 0)
  assert.equal(optional.notices.some((n) => /조건 미확인/.test(n)), true)
})

test('상업 배포를 선언하면 비상업 조건 모델이 실패로 바뀐다', () => {
  const models = [{ id: 'n/nc', license: 'CC-BY-NC-4.0', non_commercial: true, default_path: true }]
  const nonCommercial = auditLicenses({ distribution: { commercial: false }, models }, ref([['n/nc', 'a.py']]))
  assert.equal(nonCommercial.errors.length, 0, '비상업 배포 상태에서는 사실만 알린다')
  assert.equal(nonCommercial.notices.some((n) => /비상업 조건/.test(n)), true)
  const commercial = auditLicenses({ distribution: { commercial: true }, models }, ref([['n/nc', 'a.py']]))
  assert.equal(commercial.errors.length, 1)
  assert.match(commercial.errors[0], /상업 배포 선언/)
})

test('주석 줄은 모델 id 로 읽지 않는다 — 실측 오탐(Qwen/GPU) 회귀 가드', () => {
  const found = referencedModels(['fake.py'], () => [
    '# pitch 후처리 — Qwen/GPU/모델 로딩 없음.',
    '// openai/whisper-large 는 주석이다',
    'model = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"',
  ].join('\n'))
  assert.deepEqual([...found.keys()], ['Qwen/Qwen3-TTS-12Hz-0.6B-Base'])
})

test('whisper 는 코드에서 짧은 이름으로만 쓰이므로 별칭으로 잡는다', () => {
  const found = referencedModels(['fake.ts'], () => "const m = 'large-v3-turbo'")
  assert.equal(found.has('whisper/large-v3-turbo'), true)
})

test('지금 저장소의 인벤토리는 실패 0 이어야 한다', () => {
  const declared = new Set((INVENTORY.models as { id: string }[]).map((m) => m.id))
  // 기본 경로 모델은 조건이 확인돼 있어야 한다.
  for (const m of INVENTORY.models as { id: string; license: string; default_path: boolean }[]) {
    if (!m.default_path) continue
    assert.notEqual(m.license, 'UNVERIFIED', `${m.id}: 기본 경로 모델의 조건이 미확인이다`)
    assert.ok(m.license && m.license.trim(), `${m.id}: license 가 비어 있다`)
  }
  assert.ok(declared.has('Qwen/Qwen3-TTS-12Hz-0.6B-Base'), '핵심 합성 엔진이 인벤토리에 있어야 한다')
  assert.equal(typeof INVENTORY.distribution?.commercial, 'boolean', '배포 성격을 명시해야 한다')
})
