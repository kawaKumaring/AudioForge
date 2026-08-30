import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { BuildMetadataFile } from '../../shared/buildMetadata'

/**
 * `build-metadata.json` 을 찾는 순서. 파일 이름은 **인자로 받는다** — 이 모듈이 값 import 를
 * 하나도 하지 않아야 `node --test` 가 번들러 없이 그대로 돌릴 수 있다(파일 이름 권위는
 * `shared/buildMetadata.ts` 의 `BUILD_METADATA_FILENAME` 하나뿐이고 호출부가 건네준다).
 *
 * 패키징하면 리소스 폴더에, `electron-vite build` 산출물이면 `out/` 에, 개발 중이면 저장소
 * 루트에 있다. 어디에도 없으면 null 이고 화면은 version 만 보여준다 — 지어내지 않는다.
 */
export function buildMetadataCandidates(
  appPath: string,
  resourcesPath: string | null | undefined,
  filename: string
): string[] {
  const out: string[] = []
  if (resourcesPath) out.push(join(resourcesPath, filename))
  out.push(join(appPath, filename))
  out.push(join(appPath, 'out', filename))
  out.push(join(dirname(appPath), filename))
  return out
}

/** 먼저 찾은 읽을 수 있는 후보를 쓴다. 깨진 파일은 없는 것으로 보고 다음으로 넘어간다. */
export function readBuildMetadataFile(paths: string[]): BuildMetadataFile | null {
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as BuildMetadataFile
      }
    } catch {
      // 읽기·파싱 실패는 '없음' 과 같게 다룬다.
    }
  }
  return null
}

/**
 * `package.json` 후보. appPath 에서 위로 몇 단계 올라간다.
 *
 * 패키징하면 appPath 자리에 바로 있지만, `electron out/main/index.js` 로 띄우면 appPath 가
 * `out/main` 이라 거기엔 없다(실측). 그 경우 Electron 은 자기 버전을 돌려주므로 저장소의
 * package.json 을 직접 찾아야 **권위가 하나로** 유지된다.
 */
export function packageJsonCandidates(appPath: string): string[] {
  const out: string[] = []
  let dir = appPath
  for (let i = 0; i < 4; i += 1) {
    out.push(join(dir, 'package.json'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

/** 첫 번째로 읽히는 `package.json` 의 version. 없으면 null — 지어내지 않는다. */
export function readPackageVersion(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim()
      }
    } catch {
      // 읽기·파싱 실패는 다음 후보로.
    }
  }
  return null
}

/**
 * 표시할 version 을 고른다. `app.getVersion()` 이 우선이지만, Electron 이 앱
 * package.json 을 못 찾으면 **자기 런타임 버전**을 돌려준다 — 그건 앱 버전이 아니므로
 * 그때만 package.json 을 직접 읽는다. 권위는 여전히 package.json 하나다.
 */
export function pickAppVersion(
  reported: string | null | undefined,
  electronRuntimeVersion: string | null | undefined,
  packageVersion: string | null
): string | null {
  const r = (reported ?? '').trim()
  if (r && r !== (electronRuntimeVersion ?? '').trim()) return r
  return packageVersion ?? (r || null)
}
