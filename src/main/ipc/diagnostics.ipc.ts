import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { appLog, LOG_DIR_NAME } from '../services/app-log'
import { buildDiagnosticsBundle } from '../services/diagnostics-bundle'
import { currentBuildInfo } from './app-version.ipc'
import { EXPORT_DIAGNOSTICS_CHANNEL, type ExportDiagnosticsResult } from '../../shared/diagnostics'

/**
 * 진단 묶음 내보내기 — 사용자가 폴더를 고르면 그 안에 `AudioForge_진단_<시각>/` 을 만들고 탐색기로 보여 준다.
 *
 * renderer 에는 묶음 폴더 **이름**과 로그 개수만 돌려준다(경로를 주고받지 않는다).
 * E2E(AF_E2E=1 + AF_E2E_DIAG_DIR)에서는 대화상자 대신 그 폴더를 쓰고 탐색기를 열지 않는다.
 */
export function registerDiagnosticsIpc(getWindow: () => BrowserWindow | null, getPythonPath: () => string): void {
  ipcMain.handle(EXPORT_DIAGNOSTICS_CHANNEL, async (): Promise<ExportDiagnosticsResult> => {
    const e2eDir = process.env.AF_E2E === '1' ? process.env.AF_E2E_DIAG_DIR : undefined
    let targetDir: string | undefined = e2eDir && existsSync(e2eDir) ? e2eDir : undefined
    if (!targetDir) {
      const win = getWindow()
      const picked = win
        ? await dialog.showOpenDialog(win, {
            title: '진단 묶음을 만들 폴더',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: app.getPath('downloads'),
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, reason: 'cancelled' }
      targetDir = picked.filePaths[0]
    }
    try {
      const info = currentBuildInfo()
      const userData = app.getPath('userData')
      appLog()?.info('diagnostics', '진단 묶음 만들기 시작')
      const r = buildDiagnosticsBundle({
        targetDir,
        logDir: join(userData, LOG_DIR_NAME),
        settingsPath: join(userData, 'settings.json'),
        runtime: {
          appVersion: info.version, channel: info.channel ?? undefined, commit: info.commit ?? null, builtAt: info.date ?? null,
          platform: process.platform, arch: process.arch,
          electron: process.versions.electron, node: process.versions.node,
          pythonPresent: existsSync(getPythonPath()),
        },
      })
      appLog()?.info('diagnostics', `진단 묶음 완료 name=${r.name} logs=${r.copiedLogs.length}`)
      if (!e2eDir) shell.showItemInFolder(r.dir)
      return { ok: true, name: r.name, logCount: r.copiedLogs.length }
    } catch (err) {
      const message = (err as Error)?.message || String(err)
      appLog()?.error('diagnostics', `진단 묶음 실패: ${message}`)
      return { ok: false, reason: 'failed', message }
    }
  })
}
