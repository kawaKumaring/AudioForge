// build 시 build-metadata.json 을 만든다. version 은 package.json 이 권위이고
// commit·date·channel 은 여기서 확정한다. git 이 없거나 실패해도 build 를 막지 않는다.
//
// 절대경로·빌드 머신 정보는 담지 않는다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

function shortCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null
  } catch {
    return null // git 이 없거나 저장소가 아니다 — 모른다고 남긴다
  }
}

function channelForVersion(version) {
  const v = String(version ?? '').trim()
  if (!v) return null
  if (/-rc(\.|$|-)/i.test(v)) return 'Release Candidate'
  if (/-dev(\.|\+|$|-)/i.test(v)) return 'Development'
  if (v.includes('-')) return null
  return 'Stable'
}

const meta = {
  version: pkg.version ?? null,
  commit: shortCommit(),
  date: new Date().toISOString().slice(0, 10),
  channel: channelForVersion(pkg.version),
  generatedBy: 'scripts/generate-build-metadata.mjs'
}

for (const dest of [root, join(root, 'out')]) {
  try {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'build-metadata.json'),
      JSON.stringify(meta, null, 2) + '\n', 'utf-8')
  } catch {
    // 기록 실패가 build 를 막지 않는다. 없으면 앱이 version 만 보여준다.
  }
}

console.log(
  `build-metadata: ${meta.version} / ${meta.commit ?? 'commit 미확인'} / ${meta.date} / ${meta.channel ?? 'channel 미확인'}`
)
