// `settings.json` 원자 저장 — 실패했을 때 무엇이 남는가를 실제 파일로 확인한다.
//
// 여기서 보는 것
//   · 키 하나 갱신이 다른 키(pythonPath 등)를 보존한다
//   · Windows 에서 **기존 대상이 있는** rename 교체가 실제로 성립한다
//   · 실패는 성공으로 보고되지 않고, 기존 파일 바이트가 그대로 남는다
//   · JSON 이 깨진 파일을 덮어쓰지 않는다(복구할 원본을 남긴다)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readSettingsFile, setSettingsKey } from './settings-store.ts'

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'af-settings-'))
  return { dir, file: join(dir, 'settings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('없는 파일은 absent 다 — 손상과 구분한다', () => {
  const s = scratch()
  try {
    assert.deepEqual(readSettingsFile(s.file), { kind: 'absent' })
  } finally { s.cleanup() }
})

test('첫 저장은 파일을 만든다', () => {
  const s = scratch()
  try {
    assert.deepEqual(setSettingsKey(s.file, 'pythonPath', 'C:/py/python.exe'), { ok: true })
    const got = readSettingsFile(s.file)
    assert.equal(got.kind, 'ok')
    assert.equal((got as { settings: Record<string, unknown> }).settings.pythonPath,
      'C:/py/python.exe')
  } finally { s.cleanup() }
})

test('키 하나 갱신이 다른 키를 보존한다 — renderer 가 전체 사본을 되쓰지 않는다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'pythonPath', 'C:/py/python.exe')
    setSettingsKey(s.file, 'emotionCandidateRegistry', { schemaVersion: 1, records: [] })
    const got = readSettingsFile(s.file) as { kind: 'ok'; settings: Record<string, unknown> }
    assert.equal(got.settings.pythonPath, 'C:/py/python.exe', 'pythonPath 가 되돌아갔다')
    assert.deepEqual(got.settings.emotionCandidateRegistry, { schemaVersion: 1, records: [] })
    // 반대 순서로 갱신해도 서로를 지우지 않는다.
    setSettingsKey(s.file, 'pythonPath', 'D:/other/python.exe')
    const again = readSettingsFile(s.file) as { kind: 'ok'; settings: Record<string, unknown> }
    assert.equal(again.settings.pythonPath, 'D:/other/python.exe')
    assert.ok(again.settings.emotionCandidateRegistry)
  } finally { s.cleanup() }
})

test('기존 대상이 있는 교체가 성립한다 — Windows rename 이 실제로 대체한다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'k', 'first')
    const before = readFileSync(s.file, 'utf-8')
    assert.deepEqual(setSettingsKey(s.file, 'k', 'second'), { ok: true },
      'destination 이 이미 있을 때 rename 이 실패하면 여기서 드러난다')
    const after = readFileSync(s.file, 'utf-8')
    assert.notEqual(before, after)
    assert.equal((readSettingsFile(s.file) as { settings: Record<string, unknown> })
      .settings.k, 'second')
    // 임시본이 남지 않는다.
    assert.deepEqual(readdirSync(s.dir), ['settings.json'])
  } finally { s.cleanup() }
})

test('값 삭제는 그 키만 지운다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'pythonPath', 'C:/py/python.exe')
    setSettingsKey(s.file, 'gone', 1)
    assert.deepEqual(setSettingsKey(s.file, 'gone', undefined), { ok: true })
    const got = readSettingsFile(s.file) as { kind: 'ok'; settings: Record<string, unknown> }
    assert.equal('gone' in got.settings, false)
    assert.equal(got.settings.pythonPath, 'C:/py/python.exe')
    // 없는 키를 지우는 것도 성공이다.
    assert.deepEqual(setSettingsKey(s.file, 'never', undefined), { ok: true })
  } finally { s.cleanup() }
})

test('깨진 JSON 은 덮어쓰지 않는다 — 복구할 원본을 남긴다', () => {
  const s = scratch()
  try {
    const broken = '{ "pythonPath": "C:/py/python.exe"'   // 닫히지 않은 JSON
    writeFileSync(s.file, broken, 'utf-8')
    const res = setSettingsKey(s.file, 'emotionCandidateRegistry', { schemaVersion: 1 })
    assert.equal(res.ok, false)
    assert.match((res as { code: string }).code, /^SETTINGS_CORRUPT:JSON_PARSE_FAILED$/)
    assert.equal((res as { preserved: boolean }).preserved, true)
    // 바이트가 그대로다 — 다른 키를 빈 값으로 저장하지도 않았다.
    assert.equal(readFileSync(s.file, 'utf-8'), broken)
    assert.deepEqual(readdirSync(s.dir), ['settings.json'])
  } finally { s.cleanup() }
})

test('객체가 아닌 JSON 도 손상으로 본다', () => {
  const s = scratch()
  try {
    writeFileSync(s.file, '[1,2,3]', 'utf-8')
    const got = readSettingsFile(s.file)
    assert.equal(got.kind, 'corrupt')
    assert.equal((got as { reason: string }).reason, 'NOT_AN_OBJECT')
    const res = setSettingsKey(s.file, 'k', 1)
    assert.equal(res.ok, false)
    assert.equal(readFileSync(s.file, 'utf-8'), '[1,2,3]')
  } finally { s.cleanup() }
})

test('교체 실패는 성공으로 보고되지 않고 기존 바이트가 남는다', () => {
  const s = scratch()
  try {
    setSettingsKey(s.file, 'k', 'keep')
    const before = readFileSync(s.file, 'utf-8')
    // 임시본 경로를 **폴더**로 막아 둔다 → openSync('w') 가 실패한다.
    mkdirSync(join(s.dir, `.settings.${process.pid}.tmp`), { recursive: true })
    const res = setSettingsKey(s.file, 'k', 'changed')
    assert.equal(res.ok, false, '실패를 삼키고 성공으로 표시하면 안 된다')
    assert.match((res as { code: string }).code, /^SETTINGS_WRITE_FAILED:/)
    assert.equal((res as { preserved: boolean }).preserved, true)
    assert.equal(readFileSync(s.file, 'utf-8'), before, '기존 settings 가 훼손됐다')
  } finally { s.cleanup() }
})

test('저장 실패는 값이 반영되지 않았다는 뜻이다', () => {
  const s = scratch()
  try {
    writeFileSync(s.file, 'not json', 'utf-8')
    assert.equal(setSettingsKey(s.file, 'k', 'v').ok, false)
    // 성공한 뒤에만 persisted 로 표시해야 한다 — 여기서는 읽어도 값이 없다.
    assert.equal(readSettingsFile(s.file).kind, 'corrupt')
  } finally { s.cleanup() }
})
