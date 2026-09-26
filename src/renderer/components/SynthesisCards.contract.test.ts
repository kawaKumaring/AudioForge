// 생성 카드가 **실제로 이어져 있는가.**
//
// ★관리자 지시(2026-09-26)의 네 가지를 화면 코드에서 지킨다.
//   1. 카드별 준비·생성을 실제 경로로 부른다(전역 목소리·전역 설정을 바꿔 흉내 내지 않는다).
//   2. 늦은 응답이 바뀐 카드나 다른 카드에 반영되지 않는다.
//   3. 미지원 설정을 조용히 무시하거나 적용된 것처럼 표시하지 않는다.
//   4. 다시 생성해도 이전 생성본을 지우지 않는다.
//
// ★가드는 **계약**에 맨다 — 단추 글자·자리·색이 아니다.
//   이 저장소는 글자에 맨 가드가 멀쩡한 코드를 실패로 몬 일이 네 번 있다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]) => readFileSync(path.join(HERE, ...p), 'utf-8')

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
function codeOf(raw: string): string {
  return raw.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
}

const SCREEN = read('SynthesisCardWorkspace.tsx')
const RUNNER = read('..', 'lib', 'cardSynthesis.ts')
const STORE = read('..', 'stores', 'synthesisCards.store.ts')

export function connectionFaults(screen: string, runner: string, store: string): string[] {
  const s = codeOf(screen), r = codeOf(runner), st = codeOf(store)
  const bad: string[] = []

  // 1. 실제 경로를 부른다.
  if (!s.includes('prepareCardReference(')) bad.push('카드별 목소리 준비를 부르지 않는다')
  if (!s.includes('startCardGeneration(')) bad.push('카드별 생성을 부르지 않는다')
  if (!r.includes('window.api.audio.process(')) bad.push('생성이 엔진에 닿지 않는다')

  // ★전역 설정을 바꿔 카드별 동작을 흉내 내지 않는다 — 값은 요청에 실어 보낸다.
  if (r.includes('setSynthesisTab(') || r.includes('useAppStore.setState(')) {
    bad.push('전역 상태를 바꿔 카드별 동작을 흉내 낸다')
  }

  // 2. 늦은 응답을 버린다.
  if (!r.includes('reqId')) bad.push('요청 식별자가 없다 — 늦은 응답을 가려내지 못한다')
  if (!st.includes('reqId')) bad.push('준비 상태에 요청 식별자가 없다')

  // 3. 미지원 설정을 화면이 말한다.
  if (!s.includes('cardApplied(')) bad.push('엔진이 못 받는 설정을 가려내지 않는다')
  if (!s.includes('notes.map(')) bad.push('못 보낸 설정을 화면에 띄우지 않는다')

  // 4. 생성본을 지우지 않는다. **더하기만** 한다.
  if (!/addTake:\s*\(id,\s*take\)\s*=>[\s\S]{0,260}takes:\s*\[\.\.\.c\.takes,\s*take\]/.test(st)) {
    bad.push('생성본을 더하는 자리가 없다 — 다시 만들면 이전 것이 사라질 수 있다')
  }
  // 채택은 사용자가 정한다. 생성 쪽이 adoptedId 를 건드리면 임의 교체가 된다.
  if (/addTake[\s\S]{0,260}adoptedId/.test(st)) bad.push('생성이 채택을 임의로 바꾼다')
  // ★'파일 어디에든 adoptedId 가 있으면 실패' 는 너무 무디다 — 저장본을 되살리는 코드는
  //   당연히 채택을 복원한다. 계약은 **생성 결과를 받는 자리**가 채택을 바꾸지 않는 것이다.
  const accept = r.slice(r.indexOf('function acceptCardResult'))
  if (accept && accept.slice(0, 1200).includes('adoptedId')) {
    bad.push('생성 결과를 받는 자리가 채택을 바꾼다')
  }

  return bad
}

test('생성 카드가 준비·생성·보존 계약을 지킨다', () => {
  assert.deepEqual(connectionFaults(SCREEN, RUNNER, STORE), [])
})

// ★이빨 확인 — 실제 파일을 건드리지 않는다. 글자 조각으로만 본다.
test('연결 전 모습이었다면 검사가 운다', () => {
  const bad = connectionFaults('<button disabled>생성</button>', 'const x = 1', 'const y = 2')
  assert.ok(bad.length >= 6, `연결 안 된 모습을 통과시킨다: ${JSON.stringify(bad)}`)
})

test('생성이 채택을 덮으면 운다', () => {
  const st = STORE.replace('addTake: (id, take) => set(s => ({',
    'addTake: (id, take) => set(s => ({ adoptedId: take.id,')
  assert.ok(connectionFaults(SCREEN, RUNNER, st).some((b) => b.includes('채택')),
    '재생성이 채택을 갈아 끼워도 통과시킨다')
})

test('못 보낸 설정을 안 띄우면 운다', () => {
  const s = SCREEN.split('notes.map(').join('void 0 && [].map(')
  assert.ok(connectionFaults(s, RUNNER, STORE).some((b) => b.includes('못 보낸 설정')),
    '조용히 무시해도 통과시킨다')
})

test('주석만으로는 통과하지 못한다', () => {
  const fake = [
    '// prepareCardReference( startCardGeneration( cardApplied( notes.map(',
    '// window.api.audio.process( reqId',
  ].join('\n')
  assert.ok(connectionFaults(fake, fake, fake).length >= 6, '주석을 코드로 착각한다')
})
