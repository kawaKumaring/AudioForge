// 응답 신원 검증과 재요청 상한 계약.
//
// SHA 검증을 "환경 때문에" 건너뛰지 않는다 — renderer 가 SHA 를 못 구하면 main 이 이미 한
// 대조에 의존하고, 그 사슬은 requestId 가 잇는다. 신원 없는 결과는 어느 경우에도 쓰지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyResponseIdentity, type AnalysisResponse } from './inputAnalysis.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const success = (requestId: string, sha: string): AnalysisResponse => ({
  ok: true, requestId,
  result: { sourceSha256: sha } as never,
})

test('requestId 가 다르면 어떤 경우에도 받지 않는다', () => {
  assert.equal(verifyResponseIdentity(success('r2', SHA_A), 'r1', SHA_A), false)
  assert.equal(verifyResponseIdentity(success('r2', SHA_A), 'r1', null), false)
})

test('SHA 를 구할 수 있으면 대조한다', () => {
  assert.equal(verifyResponseIdentity(success('r1', SHA_A), 'r1', SHA_A), true)
  assert.equal(verifyResponseIdentity(success('r1', SHA_B), 'r1', SHA_A), false)
})

test('SHA 를 못 구해도 검증이 사라지지 않는다 — main 의 대조에 의존한다', () => {
  assert.equal(verifyResponseIdentity(success('r1', SHA_A), 'r1', null), true)
  // 신원(응답 SHA) 자체가 없으면 main 이 대조했다고 볼 수 없으므로 받지 않는다.
  assert.equal(verifyResponseIdentity(success('r1', ''), 'r1', null), false)
  assert.equal(verifyResponseIdentity(success('r1', ''), 'r1', SHA_A), false)
})

test('실패 응답은 결과로 쓰지 않는다', () => {
  const fail: AnalysisResponse = { ok: false, requestId: 'r1', code: 'WORKER_TIMEOUT' }
  assert.equal(verifyResponseIdentity(fail, 'r1', SHA_A), false)
  assert.equal(verifyResponseIdentity(fail, 'r1', null), false)
})

test('main 이 SHA 권위라는 사실이 코드에 남아 있다', () => {
  const ipc = readFileSync(
    fileURLToPath(new URL('../main/ipc/analysis.ipc.ts', import.meta.url)), 'utf-8')
  assert.equal(ipc.includes('sha256Hex(text)'), true,
    'main 이 자기 본문으로 SHA 를 다시 계산해 대조해야 renderer 가 그것에 기댈 수 있다')
  assert.equal(ipc.includes('SOURCE_SHA_MISMATCH'), true)
})

test('renderer 에 동기 SHA 구현을 새로 두지 않았다', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../renderer/hooks/useInputAnalysis.ts', import.meta.url)), 'utf-8')
  assert.equal(hook.includes('crypto.subtle.digest'), true, '있는 웹 표준을 쓴다')
  for (const homegrown of ['0x5a827999', 'function sha1', 'rotl', 'K = [']) {
    assert.equal(hook.includes(homegrown), false, `해시를 손으로 구현하면 안 된다: ${homegrown}`)
  }
  assert.equal(hook.includes('verifyResponseIdentity'), true, '공용 판정을 쓴다')
})

test('추월·취소 재요청에 유한 상한이 있다', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../renderer/hooks/useInputAnalysis.ts', import.meta.url)), 'utf-8')
  assert.equal(hook.includes('MAX_SUPERSEDED_RETRIES'), true)
  assert.equal(hook.includes('attempt < MAX_SUPERSEDED_RETRIES'), true,
    '무한 재요청은 취소가 반복되면 루프가 된다')
  assert.equal(hook.includes('send(attempt + 1)'), true, '시도 횟수가 실제로 늘어야 한다')
})
