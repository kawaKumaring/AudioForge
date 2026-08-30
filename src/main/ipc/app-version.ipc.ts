import { app, ipcMain } from 'electron'
import {
  BUILD_METADATA_FILENAME, resolveBuildInfo, type AppBuildInfo,
} from '../../shared/buildMetadata'
import {
  buildMetadataCandidates, packageJsonCandidates, pickAppVersion,
  readBuildMetadataFile, readPackageVersion,
} from '../services/build-metadata'

export const APP_VERSION_CHANNEL = 'app:get-build-info'

/** 화면과 run bundle 이 함께 쓰는 값. version 권위는 `app.getVersion()` 하나다. */
export function currentBuildInfo(): AppBuildInfo {
  const appPath = app.getAppPath()
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const file = readBuildMetadataFile(
    buildMetadataCandidates(appPath, resources, BUILD_METADATA_FILENAME))
  const version = pickAppVersion(
    app.getVersion(), process.versions.electron,
    readPackageVersion(packageJsonCandidates(appPath)))
  return resolveBuildInfo(version ?? app.getVersion(), file)
}

/** read-only 최소 API — 인자를 받지 않고 수치·문자열만 돌려준다(경로를 노출하지 않는다). */
export function registerAppVersionIpc(): void {
  ipcMain.handle(APP_VERSION_CHANNEL, () => currentBuildInfo())
}
