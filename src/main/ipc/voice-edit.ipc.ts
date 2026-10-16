/**
 * 음성 편집 — 본체 통로(2026-10-16).
 *  - voiceedit:save      섞은 결과(WAV 바이트)와 작업(JSON)을 결과 폴더에 쓴다. 자리 규칙은 shared/outputLayout 하나.
 *  - voiceedit:last-get  마지막 작업(자동 저장)을 읽는다 — 앱 데이터 폴더 안.
 *  - voiceedit:last-set  마지막 작업을 쓴다(임시본 → 바꾸기 — 끊겨도 기존 파일이 잘리지 않는다).
 * 화면은 경로를 만들지 않는다. 이름만 보내고 자리는 본체가 정한다.
 */
import { ipcMain, app } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, basename, extname, isAbsolute } from 'node:path'
import { planOutputDir, safeSegment } from '../../shared/outputLayout'
import { sanitizeProject } from '../../shared/voiceEdit/model'
import { appDirPath, readOutputSetting, outputPlace } from './audio.ipc'

const MAX_WAV_BYTES = 2 * 1024 ** 3
const LAST_DIR = 'voiceedit'
const RAW_EXT = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a'])
/** 처리본 이름 표시 — `<원본 이름>_처리_<시각>.wav`. 정리할 때 이 표시로만 고른다. */
export const FX_MARK = '_처리_'

function lastPath (): string { return join(app.getPath('userData'), LAST_DIR, 'last.json') }

function writeAtomic (path: string, data: string | Uint8Array): void {
  const tmp = path + '.part'
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export function registerVoiceEditIpc (): void {
  ipcMain.handle('voiceedit:save', (_e, payload: { name?: unknown; wav?: unknown; project?: unknown }) => {
    try {
      const wav = payload?.wav
      if (!(wav instanceof Uint8Array) || wav.byteLength < 44) return { ok: false, why: '저장할 소리가 없습니다' }
      if (wav.byteLength > MAX_WAV_BYTES) return { ok: false, why: '결과가 너무 큽니다(2GB 초과)' }
      if (String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF') return { ok: false, why: 'WAV 형식이 아닙니다' }
      const name = safeSegment(String(payload?.name ?? '')) || '음성편집'
      const out = readOutputSetting()
      // 원본이 여러 개라 '원본 옆' 은 정할 수 없다 → 고른 자리 또는 앱 자리.
      const plan = planOutputDir({
        place: outputPlace(out.chosen, false), chosenRoot: out.chosen, appRoot: appDirPath(),
        sourceDir: '', mode: 'voiceedit', name, at: new Date(), exists: existsSync,
      })
      if (existsSync(plan.dir)) return { ok: false, why: '결과 폴더를 만들 수 없습니다(같은 이름이 너무 많습니다)' }
      mkdirSync(plan.dir, { recursive: true })
      const wavPath = join(plan.dir, `${name}.wav`)
      writeAtomic(wavPath, wav)
      writeAtomic(join(plan.dir, 'project.json'), JSON.stringify(sanitizeProject(payload?.project), null, 2))
      return { ok: true, path: wavPath, dir: plan.dir }
    } catch (e) {
      return { ok: false, why: '결과를 저장하지 못했습니다: ' + ((e as NodeJS.ErrnoException)?.code ?? '알 수 없음') }
    }
  })

  // 카드 생성본 처리본 — **원본 옆**에 새 이름으로 쓴다(원본은 그대로). 직전 처리본은 이 원본에서 나온 것만 지운다.
  ipcMain.handle('voiceedit:save-beside', (_e, payload: { raw?: unknown; wav?: unknown; previous?: unknown }) => {
    try {
      const raw = String(payload?.raw ?? '')
      const wav = payload?.wav
      if (!isAbsolute(raw) || !RAW_EXT.has(extname(raw).toLowerCase()) || !existsSync(raw) || !statSync(raw).isFile()) return { ok: false, why: '처리할 원본 음성을 찾지 못했습니다' }
      if (!(wav instanceof Uint8Array) || wav.byteLength < 44) return { ok: false, why: '저장할 소리가 없습니다' }
      if (wav.byteLength > MAX_WAV_BYTES) return { ok: false, why: '결과가 너무 큽니다(2GB 초과)' }
      if (String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF') return { ok: false, why: 'WAV 형식이 아닙니다' }
      const dir = dirname(raw)
      const stem = basename(raw, extname(raw)) + FX_MARK
      const d = new Date(), p2 = (n: number): string => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
      let out = join(dir, `${stem}${stamp}.wav`)
      for (let n = 2; existsSync(out); n++) out = join(dir, `${stem}${stamp}-${n}.wav`)
      writeAtomic(out, wav)
      // 직전 처리본 정리 — 같은 폴더, 이 원본 이름 + 표시로 시작하는 wav 만(다른 파일은 절대 지우지 않는다).
      const prev = String(payload?.previous ?? '')
      if (prev && prev !== out && dirname(prev) === dir && basename(prev).startsWith(stem) && extname(prev).toLowerCase() === '.wav') {
        try { unlinkSync(prev) } catch { /* 열려 있거나 이미 없음 — 남아도 원본 옆이라 찾을 수 있다 */ }
      }
      return { ok: true, path: out }
    } catch (e) {
      return { ok: false, why: '처리한 음성을 저장하지 못했습니다: ' + ((e as NodeJS.ErrnoException)?.code ?? '알 수 없음') }
    }
  })

  ipcMain.handle('voiceedit:last-get', () => {
    try {
      const p = lastPath()
      if (!existsSync(p)) return { ok: true, project: null }
      return { ok: true, project: sanitizeProject(JSON.parse(readFileSync(p, 'utf8'))) }
    } catch {
      return { ok: false, why: '마지막 작업을 읽지 못했습니다(손상). 새 작업으로 시작합니다.' }
    }
  })

  ipcMain.handle('voiceedit:last-set', (_e, project: unknown) => {
    try {
      mkdirSync(join(app.getPath('userData'), LAST_DIR), { recursive: true })
      writeAtomic(lastPath(), JSON.stringify(sanitizeProject(project)))
      return { ok: true }
    } catch (e) {
      return { ok: false, why: '작업을 자동 저장하지 못했습니다: ' + ((e as NodeJS.ErrnoException)?.code ?? '알 수 없음') }
    }
  })
}
