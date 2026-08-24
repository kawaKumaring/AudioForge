import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MANAGED_ROOT_MARKER } from '../ipc/provision-root-helpers.ts'
import { managedRootStatus, selectManagedRoot, verifyManagedRoot, type ManagedRootDeps } from './managed-root-store.ts'

function fixture() {
  const top = mkdtempSync(join(tmpdir(), 'af-root-')), root = join(top, 'managed'), settingsFile = join(top, 'settings.json')
  mkdirSync(root)
  const deps: ManagedRootDeps = { settingsFile, forbiddenRoots: [], platform: process.platform, volumeProbe: () => ({ fixed: true, identity: 'fixed-volume-1' }) }
  return { top, root, settingsFile, deps }
}

test('empty root selection creates marker and a single managedRootRecord authority', () => {
  const f = fixture()
  try {
    const selected = selectManagedRoot(f.root, f.deps)
    assert.ok(selected.record.selectionNonce)
    assert.ok(verifyManagedRoot(f.deps))
    const settings = JSON.parse(readFileSync(f.settingsFile, 'utf8'))
    assert.ok(settings.managedRootRecord)
    assert.equal(settings.managedBaseRoot, undefined)
    assert.equal(settings.managedRoot, undefined)
    const marker = JSON.parse(readFileSync(join(f.root, MANAGED_ROOT_MARKER), 'utf8'))
    assert.equal(marker.rootKind, 'audioforge-managed')
  } finally { rmSync(f.top, { recursive: true, force: true }) }
})

test('marker/volume tamper invalidates status and reselection invalidates approval context', () => {
  const f = fixture()
  try {
    selectManagedRoot(f.root, f.deps)
    const before = managedRootStatus(f.deps).approvalContext
    selectManagedRoot(f.root, f.deps)
    const after = managedRootStatus(f.deps).approvalContext
    assert.notEqual(before, after)
    const markerPath = join(f.root, MANAGED_ROOT_MARKER)
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')); marker.instanceId = 'tampered'; writeFileSync(markerPath, JSON.stringify(marker))
    assert.equal(verifyManagedRoot(f.deps), null)
  } finally { rmSync(f.top, { recursive: true, force: true }) }
})

test('previously-owned marker remains selectable after another root was selected', () => {
  const f = fixture()
  try {
    const other = join(f.top, 'other'); mkdirSync(other)
    const first = selectManagedRoot(f.root, f.deps)
    selectManagedRoot(other, f.deps)
    const again = selectManagedRoot(f.root, f.deps)
    assert.equal(again.record.instanceId, first.record.instanceId)
    assert.notEqual(again.record.selectionNonce, first.record.selectionNonce)
  } finally { rmSync(f.top, { recursive: true, force: true }) }
})

test('forbidden, ComfyUI, non-empty and removable roots fail closed', () => {
  const f = fixture()
  try {
    assert.throws(() => selectManagedRoot(f.root, { ...f.deps, forbiddenRoots: [f.top] }), /FORBIDDEN_ROOT/)
    const comfy = join(f.top, 'ComfyUI_models'); mkdirSync(comfy)
    assert.throws(() => selectManagedRoot(comfy, f.deps), /COMFYUI_ROOT_REJECTED/)
    writeFileSync(join(f.root, 'foreign.txt'), 'x')
    assert.throws(() => selectManagedRoot(f.root, f.deps), /ROOT_NOT_EMPTY_OR_OWNED/)
    const empty = join(f.top, 'removable'); mkdirSync(empty)
    assert.throws(() => selectManagedRoot(empty, { ...f.deps, volumeProbe: () => ({ fixed: false, identity: 'usb' }) }), /REMOVABLE_OR_NETWORK_ROOT/)
  } finally { rmSync(f.top, { recursive: true, force: true }) }
})
