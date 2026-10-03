// 결과 폴더 **밖으로 나가지 않는다** — 받아쓴 파일을 읽는 통로의 경계.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transcriptFault } from './transcriptPath.ts'

const DIR = process.platform === 'win32' ? 'C:\\out\\run1' : '/out/run1'

test('그 폴더 바로 아래의 받아쓴 파일은 읽는다', () => {
  assert.equal(transcriptFault(DIR, 'speaker_a_timestamps.txt'), '')
})

test('★상위 폴더로 올라가지 못한다', () => {
  assert.equal(transcriptFault(DIR, '..'), 'NAME_TRAVERSAL')
  assert.equal(transcriptFault(DIR, '../secret.txt'), 'NAME_HAS_PATH')
  assert.equal(transcriptFault(DIR, '..\\secret.txt'), 'NAME_HAS_PATH')
})

test('★경로를 끼워 넣지 못한다', () => {
  assert.equal(transcriptFault(DIR, 'sub/a.txt'), 'NAME_HAS_PATH')
  assert.equal(transcriptFault(DIR, 'sub\\a.txt'), 'NAME_HAS_PATH')
  assert.equal(transcriptFault(DIR, process.platform === 'win32' ? 'C:\\x.txt' : '/etc/x.txt'), 'NAME_HAS_PATH')
})

test('글자 파일만 읽는다 — 음원·영상은 이 통로로 나가지 않는다', () => {
  assert.equal(transcriptFault(DIR, 'speaker_a.wav'), 'NAME_NOT_TEXT')
  assert.equal(transcriptFault(DIR, 'speaker_a.srt'), 'NAME_NOT_TEXT')
})

test('빈 값·상대 폴더는 거절한다', () => {
  assert.equal(transcriptFault('', 'a.txt'), 'DIR_NOT_ABSOLUTE')
  assert.equal(transcriptFault('out', 'a.txt'), 'DIR_NOT_ABSOLUTE')
  assert.equal(transcriptFault(DIR, ''), 'NAME_EMPTY')
})
