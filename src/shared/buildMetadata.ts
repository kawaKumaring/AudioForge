/**
 * build metadata — 화면 표시와 run bundle 기록이 **같은 권위**를 보게 하는 단일 계약.
 *
 * 권위는 둘로 나뉘고 각자 하나뿐이다.
 *   version                package.json → Electron `app.getVersion()`
 *   commit / date / channel  build 시 생성한 `build-metadata.json`
 *
 * 개발 환경에는 생성 파일이 없을 수 있다. 그때는 **아는 것만** 보여준다 —
 * 없는 값을 지어내지 않고 화면도 깨지지 않는다.
 *
 * 여기에는 사용자 절대경로나 빌드 머신 경로를 담지 않는다.
 */

/** 생성 파일(`build-metadata.json`)의 형태. 모든 필드가 없을 수 있다. */
export interface BuildMetadataFile {
  version?: string | null
  commit?: string | null
  date?: string | null
  channel?: string | null
}

/** renderer 로 건너가는 read-only 정보. version 만은 항상 있다. */
export interface AppBuildInfo {
  version: string
  commit: string | null
  date: string | null
  channel: string | null
}

export const BUILD_METADATA_FILENAME = 'build-metadata.json'

export const CHANNEL_RELEASE_CANDIDATE = 'Release Candidate'
export const CHANNEL_DEVELOPMENT = 'Development'
export const CHANNEL_STABLE = 'Stable'

/** semver pre-release 표기에서 채널을 **유도**한다. 별도 상수로 손으로 적지 않는다. */
export function channelForVersion(version: string | null | undefined): string | null {
  const v = (version ?? '').trim()
  if (!v) return null
  if (/-rc(\.|$|-)/i.test(v)) return CHANNEL_RELEASE_CANDIDATE
  if (/-dev(\.|\+|$|-)/i.test(v)) return CHANNEL_DEVELOPMENT
  if (v.includes('-')) return null // 아는 접미사가 아니면 지어내지 않는다
  return CHANNEL_STABLE
}

/** git short SHA 로 쓸 수 있는 값인가. 7~40 자리 hex 만 통과한다. */
export function isShortCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())
}

/** `YYYY-MM-DD` 만 통과한다. 시각·타임존은 담지 않는다(재현 좌표로 날짜면 충분하다). */
export function isBuildDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const s = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * 생성 파일과 실행 중 version 을 합쳐 화면·기록이 함께 쓸 정보를 만든다.
 * 잘못된 값은 조용히 고치지 않고 **버린다**(null = 모른다).
 */
export function resolveBuildInfo(
  version: string,
  file: BuildMetadataFile | null | undefined
): AppBuildInfo {
  const raw = file ?? {}
  const commit = isShortCommit(raw.commit) ? raw.commit.trim().toLowerCase() : null
  const date = isBuildDate(raw.date) ? raw.date.trim() : null
  const channel =
    typeof raw.channel === 'string' && raw.channel.trim()
      ? raw.channel.trim()
      : channelForVersion(version)
  return { version, commit, date, channel }
}

/** 화면에 늘 보이는 한 줄. `AudioForge` 를 반복하지 않는다. */
export function versionLabel(info: Pick<AppBuildInfo, 'version'>): string {
  return `v${info.version}`
}

/**
 * hover·focus 에서 읽히는 상세 설명. 아는 항목만 줄로 나열한다.
 * 스크린리더가 읽을 문자열이기도 하므로 여기가 곧 `aria-label` 이다.
 */
export function buildDetailLines(info: AppBuildInfo): string[] {
  const lines = [`AudioForge ${info.version}`]
  if (info.commit) lines.push(`Build ${info.commit}`)
  if (info.date) lines.push(info.date)
  if (info.channel) lines.push(info.channel)
  return lines
}

export function buildDetailText(info: AppBuildInfo): string {
  return buildDetailLines(info).join('\n')
}
