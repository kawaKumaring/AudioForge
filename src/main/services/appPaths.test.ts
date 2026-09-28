import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { realAppRoot, outputBase, isInside } from './appPaths.ts'

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

test('★검사도 같은 규칙으로 쌓는다 — 규칙을 확인하는 검사를 눈뜬장님으로 만들지 않는다', () => {
  // 검사만 다른 자리에 쌓게 하면, "기본 자리는 앱 폴더" 를 확인하는 검사가
  // 검사 환경에서 그 규칙을 볼 수 없게 된다(2026-09-28 에 한 번 그렇게 만들었다가 되돌림).
  assert.equal(outputBase(HERE, { AF_E2E: '1', AF_E2E_USER_DATA: 'C:/격리' }), ROOT)
})

test('★"여기에는 두지 마세요" 판정은 검사 중에도 실제 앱 자리를 본다', () => {
  // 결과를 쌓는 뿌리와 "여기에는 두지 마세요" 판정은 **다른 질문**이다.
  // 지금은 둘이 같은 자리를 가리키지만, 물음이 다르므로 함수도 둘로 둔다 —
  // 뿌리 규칙이 바뀌어도 금지 판정은 늘 **앱이 깔린 자리**여야 한다.
  assert.equal(realAppRoot(HERE), ROOT)
  assert.equal(realAppRoot(HERE), outputBase(HERE, {}), '지금은 같은 자리다')
})

test('★옆 폴더를 안이라고 하지 않는다 — 앞부분만 견주면 틀린다', () => {
  assert.equal(isInside('C:/데이터-output', 'C:/데이터'), false,
    '이름이 비슷한 옆 폴더다. 여기서 틀리면 결과가 데이터 폴더로 흘러내린다')
  assert.equal(isInside('C:/데이터x', 'C:/데이터'), false)
  assert.equal(isInside('C:/데이터/안', 'C:/데이터'), true)
  assert.equal(isInside('C:/데이터', 'C:/데이터'), true, '같은 폴더 자신은 안으로 본다')
})

test('구분자와 대소문자에 휘둘리지 않는다', () => {
  // ★역슬래시는 **코드로 만든다.** 글자로 적으면 도구를 거치며 한 겹씩 벗겨진다.
  const BS = String.fromCharCode(92)
  assert.equal(isInside('C:' + BS + '데이터' + BS + '안' + BS + '깊이', 'c:/데이터'), true,
    '윈도우 경로(역슬래시)를 안으로 보지 못한다')
  assert.equal(isInside('C:/데이터/안/', 'C:/데이터/'), true)
  assert.equal(isInside('', 'C:/데이터'), false)
  assert.equal(isInside('C:/데이터', ''), false)
})

test('★출력 자리는 데이터 자리 안이 아니다 — 두 함수를 함께 본다', () => {
  const ud = 'C:/격리/데이터'
  const out = outputBase(HERE, { AF_E2E: '1', AF_E2E_USER_DATA: ud })
  assert.equal(isInside(out, ud), false, `출력이 데이터 자리 안이다: ${out}`)
})
