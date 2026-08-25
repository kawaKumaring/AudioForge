import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { MANAGED_ROOT_KIND, MANAGED_ROOT_MARKER, MANAGED_ROOT_SCHEMA_VERSION, deriveManagedRoots, opaqueFingerprint, publicRootStatus, type ManagedRootPublicStatus, type ManagedRootRecord } from '../ipc/provision-root-helpers.ts'
import { readSettingsFile, updateSettingsFile } from './settings-store.ts'

interface Marker { schemaVersion: 1; instanceId: string; rootKind: typeof MANAGED_ROOT_KIND; rootFingerprint: string }
export interface VolumeProbe { identity: string; fixed: boolean }
export interface ManagedRootDeps { settingsFile: string; forbiddenRoots: string[]; platform?: NodeJS.Platform; volumeProbe?: (root: string) => VolumeProbe }
export interface VerifiedManagedRoot { record: ManagedRootRecord; secret: string; roots: ReturnType<typeof deriveManagedRoots> }

const clean = (p: string): string => resolve(p).replace(/[\\/]+$/, '')
function eqPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const [aa, bb] = [clean(a), clean(b)]
  return platform === 'win32' ? aa.toLowerCase() === bb.toLowerCase() : aa === bb
}
function within(candidate: string, parent: string, platform: NodeJS.Platform): boolean {
  if (eqPath(candidate, parent, platform)) return true
  const r = relative(parent, candidate)
  return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}
function assertNoReparse(root: string): void {
  let p = root
  while (true) {
    if (lstatSync(p).isSymbolicLink()) throw new Error('REPARSE_POINT_REJECTED')
    const parent = dirname(p); if (parent === p) break; p = parent
  }
}
function defaultVolumeProbe(root: string): VolumeProbe {
  if (process.platform !== 'win32') return { fixed: true, identity: `${process.platform}:${statSync(root).dev}` }
  const drive = parse(root).root.slice(0, 2).toUpperCase()
  if (!/^[A-Z]:$/.test(drive)) throw new Error('NETWORK_ROOT_REJECTED')
  const script = `$d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\";if(-not $d){exit 3};@{DriveType=$d.DriveType;VolumeSerialNumber=$d.VolumeSerialNumber;DeviceID=$d.DeviceID}|ConvertTo-Json -Compress`
  const p = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })) as { DriveType: number; VolumeSerialNumber?: string; DeviceID: string }
  return { fixed: p.DriveType === 3, identity: `${p.DeviceID}:${p.VolumeSerialNumber ?? 'none'}` }
}
function parseRecord(value: unknown): ManagedRootRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>; if (r.schemaVersion !== 1) return null
  for (const k of ['baseRoot','selectionNonce','instanceId','rootFingerprint','volumeIdentity','selectedAt']) if (typeof r[k] !== 'string' || !(r[k] as string)) return null
  return r as unknown as ManagedRootRecord
}
const markerFor = (r: ManagedRootRecord): Marker => ({ schemaVersion: 1, instanceId: r.instanceId, rootKind: MANAGED_ROOT_KIND, rootFingerprint: r.rootFingerprint })
function readMarker(root: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(root, MANAGED_ROOT_MARKER), 'utf8')) as Marker
    return m.schemaVersion === 1 && m.rootKind === MANAGED_ROOT_KIND && typeof m.instanceId === 'string' && typeof m.rootFingerprint === 'string' ? m : null
  } catch { return null }
}
const markerMatches = (m: Marker | null, r: ManagedRootRecord): boolean => !!m && m.instanceId === r.instanceId && m.rootFingerprint === r.rootFingerprint
function writeMarkerAtomic(root: string, marker: Marker): void {
  const target = join(root, MANAGED_ROOT_MARKER), tmp = join(root, `.audioforge-root-${randomUUID()}.tmp`)
  let fd: number | null = null
  try { fd = openSync(tmp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(marker, null, 2), 'utf8'); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tmp, target) }
  finally { if (fd !== null) try { closeSync(fd) } catch {}; try { unlinkSync(tmp) } catch {} }
}
function canonicalAndSafe(selected: string, deps: ManagedRootDeps): { root: string; volume: VolumeProbe } {
  const platform = deps.platform ?? process.platform
  if (!isAbsolute(selected) || /^\\\\/.test(selected)) throw new Error('NETWORK_ROOT_REJECTED')
  const root = realpathSync.native(selected)
  if (eqPath(root, parse(root).root, platform)) throw new Error('DRIVE_ROOT_REJECTED')
  assertNoReparse(root)
  if (/(^|[\\/])ComfyUI([^\\/]*)([\\/]|$)/i.test(root)) throw new Error('COMFYUI_ROOT_REJECTED')
  if (deps.forbiddenRoots.filter(Boolean).some((p) => within(root, p, platform))) throw new Error('FORBIDDEN_ROOT')
  const volume = (deps.volumeProbe ?? defaultVolumeProbe)(root)
  if (!volume.fixed) throw new Error('REMOVABLE_OR_NETWORK_ROOT')
  return { root, volume }
}

export function verifyManagedRoot(deps: ManagedRootDeps): VerifiedManagedRoot | null {
  const s = readSettingsFile(deps.settingsFile), secret = typeof s.managedRootSecret === 'string' ? s.managedRootSecret : '', record = parseRecord(s.managedRootRecord)
  if (!secret || !record) return null
  try {
    const { root, volume } = canonicalAndSafe(record.baseRoot, deps)
    if (!eqPath(root, record.baseRoot, deps.platform ?? process.platform)) return null
    if (opaqueFingerprint(secret, 'managed-root', root) !== record.rootFingerprint) return null
    if (opaqueFingerprint(secret, 'managed-volume', `${volume.identity}\0${record.instanceId}`) !== record.volumeIdentity) return null
    if (!markerMatches(readMarker(root), record)) return null
    return { record, secret, roots: deriveManagedRoots(root, (deps.platform ?? process.platform) === 'win32' ? 'win32' : 'posix') }
  } catch { return null }
}
export function managedRootStatus(deps: ManagedRootDeps): ManagedRootPublicStatus {
  const v = verifyManagedRoot(deps); return publicRootStatus(v?.secret ?? null, v?.record ?? null)
}
export function selectManagedRoot(selected: string, deps: ManagedRootDeps): VerifiedManagedRoot {
  const prior = verifyManagedRoot(deps), platform = deps.platform ?? process.platform
  const { root, volume } = canonicalAndSafe(selected, deps), entries = readdirSync(root), marker = readMarker(root)
  const s = readSettingsFile(deps.settingsFile), secret = typeof s.managedRootSecret === 'string' && s.managedRootSecret ? s.managedRootSecret : randomUUID()
  const ownedMarker = !!marker && marker.rootFingerprint === opaqueFingerprint(secret, 'managed-root', root)
  if (entries.length && !ownedMarker) throw new Error('ROOT_NOT_EMPTY_OR_OWNED')
  const instanceId = ownedMarker ? marker!.instanceId : (prior && eqPath(prior.record.baseRoot, root, platform) ? prior.record.instanceId : randomUUID())
  const record: ManagedRootRecord = { schemaVersion: MANAGED_ROOT_SCHEMA_VERSION, baseRoot: root, selectionNonce: randomUUID(), instanceId, rootFingerprint: opaqueFingerprint(secret, 'managed-root', root), volumeIdentity: opaqueFingerprint(secret, 'managed-volume', `${volume.identity}\0${instanceId}`), selectedAt: new Date().toISOString() }
  writeMarkerAtomic(root, markerFor(record))
  try {
    updateSettingsFile(deps.settingsFile, (settings) => { settings.managedRootSecret = secret; settings.managedRootRecord = record; delete settings.managedRoot; delete settings.managedBaseRoot })
  } catch (e) {
    try {
      if (markerMatches(readMarker(root), record)) {
        if (marker) writeMarkerAtomic(root, marker)
        else unlinkSync(join(root, MANAGED_ROOT_MARKER))
      }
    } catch { /* settings failure is authoritative; best-effort marker rollback */ }
    throw e
  }
  return { record, secret, roots: deriveManagedRoots(root, platform === 'win32' ? 'win32' : 'posix') }
}
