// 더빙이 파이썬과 주고받는 파일 — 읽기·고쳐 쓰기·깨진 것 다루기.
//
// 여기서 보는 것
//   · 줄 하나가 이상해도 그 줄만 조용히 사라지지 않는다(대사가 비면 아무도 이유를 모른다)
//   · 고칠 수 있는 것은 한국어뿐 — 원문·시각·낱말 시각은 그대로 남는다
//   · 파일 자체가 깨졌으면 사유와 함께 실패한다(빈 결과로 넘기지 않는다)
//   · 같은 영상은 같은 작업 폴더로 돌아온다(그래야 이어 하기가 성립한다)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DubJobError, applyKoreanEdits, parseLinesFile, parseRenderReport, readLines,
  readRenderReport, saveKoreanEdits, workFolderName, writeTakesFile,
} from './dub-job.ts'

function linesJson(): string {
  return JSON.stringify({
    language: 'ja',
    backend: 'llm',
    lines: [
      { index: 0, start: 1.0, end: 3.0, source: 'こんにちは', korean: '안녕하세요', words: [{ start: 1.0, end: 1.4, word: 'こん' }] },
      { index: 1, start: 4.0, end: 6.0, source: 'さようなら', korean: '' },
    ],
  })
}

test('줄 목록을 읽고 번역이 빈 줄을 따로 알린다', () => {
  const got = parseLinesFile(linesJson(), 'C:/work')
  assert.equal(got.language, 'ja')
  assert.equal(got.lines.length, 2)
  assert.equal(got.lines[0].korean, '안녕하세요')
  assert.deepEqual(got.emptyIndexes, [1])
  assert.equal(got.outDir, 'C:/work')
})

test('줄 하나에 값이 빠져도 그 줄을 버리지 않는다', () => {
  // 대사 하나가 조용히 사라지면 결과 영상에서 그 대목만 비고 아무도 이유를 모른다.
  const got = parseLinesFile(JSON.stringify({
    lines: [{ index: 0, start: 1, end: 2, source: 'a', korean: 'ㄱ' }, { start: 3 }],
  }))
  assert.equal(got.lines.length, 2, '두 줄 다 남는다')
  assert.equal(got.lines[1].index, 1, '번호가 없으면 순서로 채운다')
  assert.equal(got.lines[1].end, 0)
  assert.deepEqual(got.emptyIndexes, [1])
})

test('줄 목록 파일이 깨졌으면 사유와 함께 실패한다', () => {
  assert.throws(() => parseLinesFile('{ 이건 json 이 아니다'), DubJobError)
})

test('줄이 하나도 없어도 빈 결과를 돌려준다(터지지 않는다)', () => {
  const got = parseLinesFile('{}')
  assert.deepEqual(got.lines, [])
  assert.deepEqual(got.emptyIndexes, [])
})

test('고칠 수 있는 것은 한국어뿐 — 원문·시각·낱말 시각은 그대로다', () => {
  const next = JSON.parse(applyKoreanEdits(linesJson(), { 1: '  잘 가요  ' }))
  assert.equal(next.lines[1].korean, '잘 가요', '앞뒤 공백은 다듬는다')
  assert.equal(next.lines[1].source, 'さようなら', '원문은 그대로')
  assert.equal(next.lines[0].korean, '안녕하세요', '건드리지 않은 줄은 그대로')
  assert.equal(next.lines[0].start, 1.0)
  assert.equal(next.lines[0].words[0].word, 'こん', '낱말 시각도 살아 남는다')
  assert.equal(next.language, 'ja', '파일의 다른 값도 그대로')
})

test('고친 뒤 비어 있는 줄 목록이 다시 계산된다', () => {
  const next = JSON.parse(applyKoreanEdits(linesJson(), { 0: '', 1: '잘 가요' }))
  assert.deepEqual(next.empty_indexes, [0], '비운 줄이 새로 잡힌다')
})

test('고쳐 쓴 것이 파일에 남고 바로 읽힌다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-dubjob-'))
  try {
    writeFileSync(join(dir, 'lines.json'), linesJson(), 'utf-8')
    const got = saveKoreanEdits(dir, { 1: '잘 가요' })
    assert.deepEqual(got.emptyIndexes, [])
    assert.equal(readLines(dir).lines[1].korean, '잘 가요')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('앞단 결과가 없으면 무엇을 해야 하는지 말한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-dubjob-'))
  try {
    assert.throws(() => readLines(dir), (e: Error) => /먼저 영상을 넣고/.test(e.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('줄 번호와 소리의 짝을 파이썬이 읽을 형태로 쓴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-dubjob-'))
  try {
    const path = writeTakesFile(dir, { 0: 'C:/a.wav', 1: '', 2: 'C:/c.wav' })
    const body = JSON.parse(readFileSync(path, 'utf-8'))
    assert.deepEqual(Object.keys(body), ['0', '2'], '빈 자리는 담지 않는다')
    assert.equal(body['2'], 'C:/c.wav')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('내보내기 보고서에서 줄마다의 상태를 읽는다', () => {
  const got = parseRenderReport(JSON.stringify({
    video: 'C:/out.mp4',
    srt: 'C:/out.ko.srt',
    summary: {
      total: 3, fit: 1, stretched: 1, over: 1, over_indexes: [2],
      missing_indexes: [], worst_overflow_sec: 1.25, max_ratio_used: 1.3, trimmed: 0,
    },
    lines: [
      { index: 0, status: 'fit', ratio: 1.0, loudness_matched: true },
      { index: 1, status: 'stretched', ratio: 1.18, loudness_matched: true },
      { index: 2, status: 'over', ratio: 1.3, overflow_sec: 1.25, reason: '넘칩니다' },
    ],
  }))
  assert.equal(got.video, 'C:/out.mp4')
  assert.equal(got.summary.over, 1)
  assert.deepEqual(got.summary.overIndexes, [2])
  assert.equal(got.lines[1].ratio, 1.18)
  assert.equal(got.lines[2].reason, '넘칩니다')
  assert.equal(got.lines[0].loudnessMatched, true)
})

test('모르는 상태 글자는 안 맞음으로 본다 — 맞았다고 우기지 않는다', () => {
  const got = parseRenderReport(JSON.stringify({ lines: [{ index: 0, status: '???' }] }))
  assert.equal(got.lines[0].status, 'over')
})

test('내보내기 결과가 없으면 사유와 함께 실패한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-dubjob-'))
  try {
    assert.throws(() => readRenderReport(dir), DubJobError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('같은 영상은 같은 작업 폴더로 돌아온다', () => {
  const a = workFolderName('E:/영상/ヨルシカ - 千鳥.mp4')
  const b = workFolderName('E:/영상/ヨルシカ - 千鳥.mp4')
  assert.equal(a, b, '같은 이름이면 같은 자리 — 그래야 이어 하기가 된다')
})

test('다른 영상은 다른 폴더를 쓴다', () => {
  assert.notEqual(workFolderName('E:/a/클립.mp4'), workFolderName('E:/a/다른클립.mp4'))
})

test('폴더 이름에 위험한 글자를 남기지 않는다', () => {
  const name = workFolderName('E:/x/ヨルシカ - 千鳥（OFFICIAL VIDEO）.mp4')
  assert.ok(!/[\\/:*?"<>|（）]/.test(name), `위험한 글자가 남았다: ${name}`)
  assert.ok(name.length > 0 && name.length <= 40)
})
