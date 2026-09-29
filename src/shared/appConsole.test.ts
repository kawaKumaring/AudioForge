import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { parseConsolePopup, uiTag, uiLevel } from './appConsole.ts'

test('켜 둔 값만 켠다 — 모르는 값은 닫힌 채로', () => {
  assert.equal(parseConsolePopup(true), true)
  for (const v of [false, 'true', 1, null, undefined, {}]) assert.equal(parseConsolePopup(v), false, String(v))
})

test('화면의 꼬리표는 ui: 로 시작하고 영문·숫자·빼기만 남는다', () => {
  assert.equal(uiTag('reader'), 'ui:reader')
  assert.equal(uiTag('re ader!/<x>'), 'ui:readerx')
  assert.equal(uiTag(''), 'ui:screen')
  assert.equal(uiTag('a'.repeat(40)).length, 'ui:'.length + 24)
})

test('수준은 셋뿐 — 모르는 값은 INFO', () => {
  assert.equal(uiLevel('WARN'), 'WARN')
  assert.equal(uiLevel('ERROR'), 'ERROR')
  assert.equal(uiLevel('FATAL'), 'INFO')
})
