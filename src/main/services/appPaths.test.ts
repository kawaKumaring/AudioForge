import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { realAppRoot, outputBase } from './appPaths.ts'

const HERE = join('E:', '앱', 'out', 'main')
const ROOT = join('E:', '앱')

test('앱이 깔린 자리는 out/main 에서 두 칸 위다', () => {
  assert.equal(realAppRoot(HERE), ROOT)
})

test('보통 실행은 앱 자리에 쌓는다', () => {
  assert.equal(outputBase(HERE, {}), ROOT)
  assert.equal(outputBase(HERE, { AF_E2E: '1' }), ROOT, '격리 자리를 주지 않았으면 앱 자리다')
  assert.equal(outputBase(HERE, { AF_E2E_USER_DATA: 'C:/격리' }), ROOT,
    'AF_E2E 없이 격리 변수만 있는 것은 검사가 아니다')
})

test('★검사가 자리를 짚으면 그 아래에 쌓는다 — 결과 폴더를 어지럽히지 않는다', () => {
  assert.equal(outputBase(HERE, { AF_E2E: '1', AF_E2E_USER_DATA: 'C:/격리' }), 'C:/격리')
})

test('★"여기에는 두지 마세요" 판정은 검사 중에도 실제 앱 자리를 본다', () => {
  // 검사 중이라고 앱 폴더에 결과를 두도록 열어 주면, 앱을 지울 때 함께 사라진다.
  assert.equal(realAppRoot(HERE), ROOT)
  assert.notEqual(outputBase(HERE, { AF_E2E: '1', AF_E2E_USER_DATA: 'C:/격리' }), realAppRoot(HERE),
    '두 자리가 같으면 갈라 둔 뜻이 없다')
})
