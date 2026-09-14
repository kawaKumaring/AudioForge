// 테스트개발 작업실이 쓰는 **두 가지**만 여기 둔다.
//
//   1) 만들어진 소리를 **안전한 자리로 옮긴다**. 합성 결과는 작업 폴더에 생기는데, 그 자리는
//      다시 처리하거나 정리할 때 사라질 수 있다. 테이크는 사용자가 나중에 고르는 것이므로
//      사라지면 안 된다 → `userData/lab-takes/` 로 복사해 둔다.
//   2) 채택한 테이크들을 **순서대로 이어 붙여 하나로 내보낸다**.
//
// 소리를 만드는 일은 여기서 하지 않는다 — 기존 합성 경로를 그대로 쓴다.
// 사용자 원본·기존 결과·목소리 구성은 건드리지 않는다(읽기와 복사만 한다).
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { basename, join } from 'path'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'fs'

/** 테이크 보관소. 임시 정리 대상이 아닌 자리다. */
function takesDir(): string {
  const d = join(app.getPath('userData'), 'lab-takes')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

interface WavParts { channels: number; sampleRate: number; bitsPerSample: number; data: Buffer }

/**
 * WAV 한 개를 머리와 소리 몸통으로 가른다.
 *
 * 왜 직접 읽는가: 이어 붙일 파일들은 **모두 같은 합성 경로에서 나온 것**이라 형식이 같다.
 * 형식이 같으면 몸통을 이어 붙이고 머리만 다시 쓰면 된다 — 새 꾸러미를 들이지 않는다.
 * 형식이 다르면 **조용히 맞추지 않고 실패한다**(소리를 몰래 바꾸지 않는다).
 */
function readWav(path: string): WavParts {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`WAV 형식이 아닙니다: ${basename(path)}`)
  }
  let pos = 12
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let data: Buffer | null = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    pos = body + size + (size % 2)      // 홀수 크기 덩어리는 한 바이트 채움이 붙는다
  }
  if (!fmt || !data) throw new Error(`WAV 안에서 형식·소리를 찾지 못했습니다: ${basename(path)}`)
  return { ...fmt, data }
}

function writeWav(path: string, p: WavParts): void {
  const byteRate = p.sampleRate * p.channels * (p.bitsPerSample / 8)
  const blockAlign = p.channels * (p.bitsPerSample / 8)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + p.data.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)                    // PCM
  head.writeUInt16LE(p.channels, 22)
  head.writeUInt32LE(p.sampleRate, 24)
  head.writeUInt32LE(byteRate, 28)
  head.writeUInt16LE(blockAlign, 32)
  head.writeUInt16LE(p.bitsPerSample, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(p.data.length, 40)
  writeFileSync(path, Buffer.concat([head, p.data]))
}

export function registerLabIpc(mainWindow: BrowserWindow): void {
  /** 만들어진 소리를 보관소로 옮긴다. 원본은 그대로 둔다(복사). */
  ipcMain.handle('lab:keep-take', async (_e, srcPath: string, takeId: string) => {
    if (typeof srcPath !== 'string' || !existsSync(srcPath)) {
      return { ok: false, reason: '만들어진 소리 파일을 찾지 못했습니다' }
    }
    const dest = join(takesDir(), `${takeId}.wav`)
    copyFileSync(srcPath, dest)
    return { ok: true, path: dest }
  })

  /** 보관소에서 쓰지 않는 테이크를 지운다. **목록에 있는 것만 남기고** 나머지를 정리한다. */
  ipcMain.handle('lab:prune-takes', async (_e, keepIds: string[]) => {
    const keep = new Set((Array.isArray(keepIds) ? keepIds : []).map(String))
    const dir = takesDir()
    let removed = 0
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue
      if (keep.has(f.slice(0, -4))) continue
      try { unlinkSync(join(dir, f)); removed += 1 } catch { /* 지우지 못해도 진행한다 */ }
    }
    return { ok: true, removed }
  })

  /**
   * 채택한 테이크들을 **순서대로** 이어 붙여 하나로 저장한다.
   * 형식이 서로 다르면 맞추지 않고 실패한다 — 소리를 몰래 바꾸지 않는다.
   */
  ipcMain.handle('lab:export', async (_e, paths: string[], suggestedName?: string) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string')
    if (list.length === 0) return { ok: false, reason: '내보낼 결과가 없습니다' }
    const missing = list.filter((p) => !existsSync(p))
    if (missing.length) {
      return { ok: false, reason: `결과 파일이 없습니다(${missing.length}개). 다시 만들어 주세요.` }
    }
    let head: WavParts | null = null
    const bodies: Buffer[] = []
    for (const p of list) {
      const w = readWav(p)
      if (!head) head = w
      else if (w.channels !== head.channels || w.sampleRate !== head.sampleRate
               || w.bitsPerSample !== head.bitsPerSample) {
        return {
          ok: false,
          reason: `결과들의 소리 형식이 서로 다릅니다(${basename(p)}). 형식을 임의로 맞추지 않았습니다.`,
        }
      }
      bodies.push(w.data)
    }
    // 저장 위치. 검사에서만 대화상자를 건너뛴다(기존 AF_E2E 통로와 같은 방식).
    let target: string | null = null
    if (process.env.AF_E2E === '1' && process.env.AF_E2E_EXPORT_PATH) {
      target = process.env.AF_E2E_EXPORT_PATH
    } else {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '전체 음성 내보내기',
        defaultPath: (suggestedName || 'lab-script') + '.wav',
        filters: [{ name: 'WAV', extensions: ['wav'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      target = res.filePath
    }
    writeWav(target, { ...(head as WavParts), data: Buffer.concat(bodies) })
    const size = statSync(target).size
    return { ok: true, path: target, parts: list.length, bytes: size }
  })
}
