import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSettingsFile, updateSettingsFile } from './settings-store.ts'

test('atomic settings update preserves unrelated fields and leaves no temp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-settings-'))
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ keep: 1, nested: { a: true } }))
    updateSettingsFile(file, (s) => { s.changed = 2 })
    assert.deepEqual(readSettingsFile(file), { keep: 1, nested: { a: true }, changed: 2 })
    assert.deepEqual(readdirSync(dir), ['settings.json'])
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('same-process concurrent/reentrant writer fails without corrupting existing settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-settings-race-'))
  try {
    const file = join(dir, 'settings.json'); writeFileSync(file, JSON.stringify({ keep: 1 }))
    assert.throws(() => updateSettingsFile(file, () => { updateSettingsFile(file, (s) => { s.bad = true }) }), /SETTINGS_WRITE_IN_PROGRESS/)
    assert.deepEqual(readSettingsFile(file), { keep: 1 })
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
