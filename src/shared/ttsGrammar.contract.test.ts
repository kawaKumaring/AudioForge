// 문법 fixture '계약/shape' 테스트 (S1). ⚠️ 실제 TS parser parity 통과가 아니다(그건 Agent A 구현 단계).
// 여기서는 권위 fixture가 계약 shape를 지키는지만 검증한다: parser_version=2, case id 유일,
// valid/error 구조, dual offset 필드 선언, integer pause_ms 정책, full sha256 / sha8 형식 구분,
// error code가 shared 계약 집합에 포함, escape/unknown/empty/pause/boundary-priority case 존재.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TTS_PARSER_VERSION, TTS_GRAMMAR_ERROR_CODES } from './ttsGrammar.ts'

const fixturePath = fileURLToPath(new URL('../../test/fixtures/tts-grammar-conformance-v2.json', import.meta.url))
const fx = JSON.parse(readFileSync(fixturePath, 'utf-8'))
const meta = fx._meta || {}
const valid = fx.valid || []
const errors = fx.error || []
const allIds = [...valid, ...errors].map((c: { id?: string }) => c.id)
const names = [...valid, ...errors].map((c: { name?: string }) => String(c.name || '')).join(' | ')

test('parser_version = 2 (shared 상수와 일치)', () => {
  assert.equal(meta.parser_version, 2)
  assert.equal(meta.schema_version, 2)
  assert.equal(TTS_PARSER_VERSION, 2)
})

test('case id 유일(중복 금지)', () => {
  assert.ok(allIds.length > 0)
  assert.ok(allIds.every((id) => typeof id === 'string' && id.length > 0), 'every case has string id')
  assert.equal(new Set(allIds).size, allIds.length, 'ids unique')
})

test('valid/error 케이스 구조', () => {
  assert.ok(valid.length >= 8 && errors.length >= 5)
  for (const c of valid) assert.ok('input' in c, 'valid case has input')
  for (const c of errors) assert.ok(c.error && typeof c.error.code === 'string', 'error case has error.code')
})

test('dual offset 필드가 계약에 선언됨', () => {
  const off = meta.offset_fields || []
  for (const f of ['ui_start_utf16', 'ui_end_utf16', 'text_start_codepoint', 'text_end_codepoint']) {
    assert.ok(off.includes(f), `offset_fields includes ${f}`)
  }
})

test('pause_ms integer 정책 + hash 입력에 int 명시', () => {
  assert.equal(meta.pause_ms_integer, true)
  assert.ok((meta.hash_inputs || []).some((h: string) => h.includes('pause_ms')))
})

test('full sha256 / sha8 형식 구분(hash 입력 계약)', () => {
  const hi = meta.hash_inputs || []
  assert.ok(hi.includes('spoken_text_full_sha256'), 'hash includes full spoken_text sha256')
  assert.ok(hi.includes('spoken_text_utf8_byte_length'), 'hash includes utf8 byte length')
  // metadata 표시는 sha8만(계약 문서). 여기선 full-vs-sha8 구분이 계약에 존재함을 확인.
})

test('error code가 shared 계약 집합에 포함', () => {
  const shared = new Set(TTS_GRAMMAR_ERROR_CODES as readonly string[])
  for (const c of errors) assert.ok(shared.has(c.error.code), `${c.error.code} in shared set`)
  for (const code of (meta.error_codes || [])) assert.ok(shared.has(code), `_meta ${code} in shared set`)
})

test('필수 케이스 존재: escape/unknown/empty/pause/boundary-priority', () => {
  assert.match(names, /escape/i)
  assert.ok(errors.some((c: { error: { code: string } }) => c.error.code === 'UNKNOWN_TTS_TAG'))
  assert.ok(errors.some((c: { error: { code: string } }) => c.error.code === 'EMPTY_EMOTION_SEGMENT'))
  assert.ok(errors.some((c: { error: { code: string } }) => c.error.code === 'INVALID_PAUSE_TAG'))
  assert.match(names, /boundary priority|경계 우선순위/i)
})
