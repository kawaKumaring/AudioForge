import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const activeWrites = new Set<string>()

export function readSettingsFile(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

/** 같은 디렉터리 temp를 fsync한 뒤 atomic replace한다. 기존 키를 보존한다. */
export function updateSettingsFile(file: string, update: (current: Record<string, unknown>) => void): Record<string, unknown> {
  if (activeWrites.has(file)) throw new Error('SETTINGS_WRITE_IN_PROGRESS')
  activeWrites.add(file)
  const tmp = join(dirname(file), `.settings-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    const current = readSettingsFile(file)
    update(current)
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(current, null, 2), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
    return current
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
    try { unlinkSync(tmp) } catch { /* own temp absent after promote */ }
    activeWrites.delete(file)
  }
}
