/**
 * 음성 편집 — 본체 통로(2026-10-16).
 *  - voiceedit:save      섞은 결과(WAV 바이트)와 작업(JSON)을 결과 폴더에 쓴다. 자리 규칙은 shared/outputLayout 하나.
 *  - voiceedit:last-get  마지막 작업(자동 저장)을 읽는다 — 앱 데이터 폴더 안.
 *  - voiceedit:last-set  마지막 작업을 쓴다(임시본 → 바꾸기 — 끊겨도 기존 파일이 잘리지 않는다).
 * 화면은 경로를 만들지 않는다. 이름만 보내고 자리는 본체가 정한다.
 */
import { ipcMain, app } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { planOutputDir, safeSegment } from '../../shared/outputLayout'
import { sanitizeProject } from '../../shared/voiceEdit/model'
import { appDirPath, readOutputSetting, outputPlace } from './audio.ipc'

const MAX_WAV_BYTES = 2 * 1024 ** 3
const LAST_DIR = 'voiceedit'

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
