import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097
import { stripIpcErrorPrefix } from './ipcErrorText.ts'

test('IPC 영어 앞머리를 떼고 본체 사유만 남긴다', () => {
  assert.equal(stripIpcErrorPrefix("Error invoking remote method 'audio:process': Error: SPEAKER_NOT_REGISTERED 참조 목소리가 없습니다"),
    'SPEAKER_NOT_REGISTERED 참조 목소리가 없습니다')
  assert.equal(stripIpcErrorPrefix('이미 한국어 사유'), '이미 한국어 사유')
  assert.equal(stripIpcErrorPrefix(undefined), '')
})
