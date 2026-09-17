// 앱 로그 파일 — 실제 파일에 눌러 확인한다.
//
// 여기서 보는 것
//   · 날짜별 파일 하나, 줄 머리 시각으로 기록 경계를 찾을 수 있다(여러 줄은 들여쓴다)
//   · 오래된 파일만 지우고 규칙에 맞지 않는 파일은 건드리지 않는다
//   · 20MB 상한을 넘으면 한 줄 남기고 멈춘다 — 디스크를 채우지 않는다
//   · console.warn/error 를 비추되 console.log 는 비추지 않는다
//   · 잡히지 않은 예외를 monitor 로 본다(기본 동작을 바꾸지 않는다)
//   · 쓰기 실패가 예외로 튀지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

import {
  createAppLog, fileLabel, formatLogLine, listLogFiles, logFileDate, logFileName, mirrorConsole,
  watchUncaught, appLog, setAppLog,
} from './app-log.ts'

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'af-log-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const T0 = new Date(2026, 8, 17, 21, 10, 3, 123)   // 2026-09-17 21:10:03.123 현지

test('파일 이름은 현지 날짜 하나로 정해진다', () => {
  assert.equal(logFileName(T0), 'audioforge-2026-09-17.log')
  assert.equal(logFileDate('audioforge-2026-09-17.log')?.getDate(), 17)
  assert.equal(logFileDate('other-2026-09-17.log'), null, '규칙 밖 파일은 우리 것이 아니다')
  assert.equal(logFileDate('audioforge-2026-13-40.log'), null, '말이 안 되는 날짜는 거른다')
})

test('기록 한 건은 줄 머리 시각으로 시작하고, 여러 줄은 4칸 들여 쓴다', () => {
  const line = formatLogLine(T0, 'ERROR', 'job', 'first\r\nsecond\nthird')
  const rows = line.split('\n')
  assert.match(rows[0], /^2026-09-17T21:10:03\.123[+-]\d{2}:\d{2} ERROR \[job\] first$/)
  assert.equal(rows[1], '    second')
  assert.equal(rows[2], '    third')
  assert.equal(rows[3], '', '마지막은 줄바꿈으로 끝난다')
  assert.ok(!line.includes('\r'), 'CR 은 남기지 않는다')
})

test('쓰면 그 날짜 파일에 붙고, 날이 바뀌면 새 파일로 간다', () => {
  const s = scratch()
  try {
    let t = T0
    const log = createAppLog({ dir: s.dir, now: () => t })
    log.info('boot', '시작')
    log.error('job', '실패 하나')
    t = new Date(2026, 8, 18, 0, 0, 1)
    log.warn('job', '다음 날')
    assert.deepEqual(listLogFiles(s.dir), ['audioforge-2026-09-17.log', 'audioforge-2026-09-18.log'])
    const d1 = readFileSync(join(s.dir, 'audioforge-2026-09-17.log'), 'utf-8')
    assert.match(d1, /INFO {2}\[boot\] 시작\n/)
    assert.match(d1, /ERROR \[job\] 실패 하나\n/)
    assert.equal(d1.split('\n').filter(Boolean).length, 2)
  } finally { s.cleanup() }
})

test('오래된 로그만 지운다 — 남의 파일과 최근 파일은 그대로', () => {
  const s = scratch()
  try {
    writeFileSync(join(s.dir, 'audioforge-2026-09-01.log'), 'old', 'utf-8')      // 16일 전
    writeFileSync(join(s.dir, 'audioforge-2026-09-03.log'), 'edge', 'utf-8')     // 14일 전 = 경계, 남긴다
    writeFileSync(join(s.dir, 'audioforge-2026-09-16.log'), 'recent', 'utf-8')
    writeFileSync(join(s.dir, 'notes.txt'), 'mine', 'utf-8')
    writeFileSync(join(s.dir, 'other-2026-01-01.log'), 'theirs', 'utf-8')
    const log = createAppLog({ dir: s.dir, now: () => T0, keepDays: 14 })
    const names = readdirSync(s.dir).sort()
    assert.ok(!names.includes('audioforge-2026-09-01.log'), '16일 전 파일은 지워진다')
    assert.ok(names.includes('audioforge-2026-09-03.log'), '경계 날짜는 남긴다')
    assert.ok(names.includes('audioforge-2026-09-16.log'))
    assert.ok(names.includes('notes.txt') && names.includes('other-2026-01-01.log'), '규칙 밖 파일은 건드리지 않는다')
    assert.deepEqual(log.prune(), [], '두 번째 정리는 지울 것이 없다')
  } finally { s.cleanup() }
})

test('상한을 넘으면 한 줄 남기고 그 날은 멈춘다', () => {
  const s = scratch()
  try {
    const log = createAppLog({ dir: s.dir, now: () => T0, maxBytesPerFile: 400 })
    for (let i = 0; i < 50; i++) log.info('fill', 'x'.repeat(40))
    const text = readFileSync(log.currentFile(), 'utf-8')
    const size = Buffer.byteLength(text)
    assert.ok(size < 400 + 200, `상한 근처에서 멈춘다(실측 ${size})`)
    assert.match(text, /WARN {2}\[log\] 이 파일이 0MB 를 넘어 오늘은 더 기록하지 않는다\./)
    const rows = text.trim().split('\n')
    assert.match(rows[rows.length - 1], /더 기록하지 않는다/, '마지막 줄이 안내다 — 그 뒤로는 없다')
  } finally { s.cleanup() }
})

test('console.warn/error 는 비추고 console.log 는 비추지 않는다 — 원래 출력은 유지된다', () => {
  const s = scratch()
  try {
    const log = createAppLog({ dir: s.dir, now: () => T0 })
    const seen: string[] = []
    const fake = {
      warn: (...a: unknown[]) => { seen.push('W:' + a.join(' ')) },
      error: (...a: unknown[]) => { seen.push('E:' + a.join(' ')) },
      log: (...a: unknown[]) => { seen.push('L:' + a.join(' ')) },
    }
    const restore = mirrorConsole(log, fake)
    fake.warn('경고', 1)
    fake.error('오류 %s', 'x')
    fake.log('그냥')
    restore()
    fake.error('복구 뒤')
    assert.deepEqual(seen, ['W:경고 1', 'E:오류 %s x', 'L:그냥', 'E:복구 뒤'], '원래 출력은 전부 그대로')
    const text = readFileSync(log.currentFile(), 'utf-8')
    assert.match(text, /WARN {2}\[console\] 경고 1\n/)
    assert.match(text, /ERROR \[console\] 오류 x\n/, 'util.format 으로 채운다')
    assert.ok(!text.includes('그냥'), 'console.log 는 파일에 가지 않는다')
    assert.ok(!text.includes('복구 뒤'), '되돌린 뒤에는 비추지 않는다')
  } finally { s.cleanup() }
})

test('잡히지 않은 예외를 monitor 로 기록한다 — 리스너를 떼면 멈춘다', () => {
  const s = scratch()
  try {
    const log = createAppLog({ dir: s.dir, now: () => T0 })
    const proc = new EventEmitter() as unknown as NodeJS.Process
    const detach = watchUncaught(log, proc)
    proc.emit('uncaughtExceptionMonitor', new Error('터졌다'), 'uncaughtException')
    detach()
    proc.emit('uncaughtExceptionMonitor', new Error('안 보임'), 'uncaughtException')
    const text = readFileSync(log.currentFile(), 'utf-8')
    assert.match(text, /ERROR \[uncaught\] uncaughtException: Error: 터졌다\n {4}\s*at /, '스택이 들여쓴 뒷줄로 남는다')
    assert.ok(!text.includes('안 보임'))
  } finally { s.cleanup() }
})

test('쓸 수 없는 자리라도 예외를 던지지 않는다', () => {
  const s = scratch()
  try {
    const blocked = join(s.dir, 'a-file-not-a-dir')
    writeFileSync(blocked, 'x', 'utf-8')
    const log = createAppLog({ dir: join(blocked, 'logs'), now: () => T0 })
    assert.doesNotThrow(() => log.error('x', 'y'))
    assert.equal(existsSync(join(blocked, 'logs')), false)
  } finally { s.cleanup() }
})

test('fileLabel 은 이름만 남긴다 — 폴더를 적지 않는다', () => {
  assert.equal(fileLabel('E:/비밀/폴더/녹음.wav'), '녹음.wav')
  assert.equal(fileLabel('C:\\Users\\x\\a.mp3'), 'a.mp3')
  assert.equal(fileLabel(''), '(없음)')
  assert.equal(fileLabel(null), '(없음)')
})

test('전역 하나 — 넣기 전엔 null, 호출부는 ?. 로 부른다', () => {
  setAppLog(null)
  assert.equal(appLog(), null)
  const s = scratch()
  try {
    const log = createAppLog({ dir: s.dir, now: () => T0 })
    setAppLog(log)
    assert.equal(appLog(), log)
  } finally { setAppLog(null); s.cleanup() }
})
