import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { stripSpokenSymbols } from './speechSymbols.ts'

// ★사례는 파이썬 짝(python/test_speech_symbols.py)과 **한 벌**이다 — 두 쪽 규칙이 갈라지면 한쪽이 운다.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { cases } = JSON.parse(readFileSync(path.join(HERE, 'speechSymbols.cases.json'), 'utf-8')) as { cases: [string, string][] }

test('사례가 충분하다 — 사용자가 신고한 기호 뭉치가 모두 들어 있다', () => {
  assert.ok(cases.length >= 30, `${cases.length}`)
  for (const run of ['.............', '/////', '!!!!!', '*******', "'''''", '""""""', '~~~~~', '------', '+++++++', '[[[[ ]]]]]]]', '(((((( ))))))']) {
    assert.ok(cases.some(([i]) => i === run), run)
  }
})

for (const [input, want] of cases) {
  test(`기호 → ${JSON.stringify(input).slice(0, 40)}`, () => {
    assert.equal(stripSpokenSymbols(input), want)
  })
}
