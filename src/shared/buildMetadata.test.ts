import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUILD_METADATA_FILENAME, CHANNEL_DEVELOPMENT, CHANNEL_RELEASE_CANDIDATE, CHANNEL_STABLE,
  buildDetailLines, buildDetailText, channelForVersion, isBuildDate, isShortCommit,
  resolveBuildInfo, versionLabel,
} from './buildMetadata.ts'
import {
  buildMetadataCandidates, packageJsonCandidates, pickAppVersion,
  readBuildMetadataFile, readPackageVersion,
} from '../main/services/build-metadata.ts'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('채널은 version 접미사에서 유도한다 — 손으로 적지 않는다', () => {
  assert.equal(channelForVersion('1.1.0-rc.1'), CHANNEL_RELEASE_CANDIDATE)
  assert.equal(channelForVersion('1.2.0-dev+abc1234'), CHANNEL_DEVELOPMENT)
  assert.equal(channelForVersion('1.1.0'), CHANNEL_STABLE)
  assert.equal(channelForVersion('1.1.0-beta.2'), null, '모르는 접미사는 지어내지 않는다')
  assert.equal(channelForVersion(''), null)
  assert.equal(channelForVersion(null), null)
})

test('commit·date 는 형식이 맞을 때만 통과한다', () => {
  assert.equal(isShortCommit('4bbb5d0'), true)
  assert.equal(isShortCommit('4BBB5D0'), true)
  assert.equal(isShortCommit('4bbb5d'), false, '7자 미만')
  assert.equal(isShortCommit('zzzzzzz'), false, 'hex 아님')
  assert.equal(isShortCommit(123), false)
  assert.equal(isBuildDate('2026-08-30'), true)
  assert.equal(isBuildDate('2026-02-31'), false, '존재하지 않는 날짜')
  assert.equal(isBuildDate('2026-08-30T10:00:00Z'), false, '시각·타임존은 담지 않는다')
  assert.equal(isBuildDate(''), false)
})

test('metadata 가 없어도 version 만으로 성립한다', () => {
  const info = resolveBuildInfo('1.1.0-rc.1', null)
  assert.equal(info.version, '1.1.0-rc.1')
  assert.equal(info.commit, null)
  assert.equal(info.date, null)
  assert.equal(info.channel, CHANNEL_RELEASE_CANDIDATE, 'channel 은 version 에서 유도된다')
  assert.deepEqual(buildDetailLines(info), ['AudioForge 1.1.0-rc.1', CHANNEL_RELEASE_CANDIDATE])
})

test('형식이 틀린 값은 조용히 고치지 않고 버린다', () => {
  const info = resolveBuildInfo('1.1.0-rc.1', {
    commit: 'not-a-sha', date: '30/08/2026', channel: '   '
  })
  assert.equal(info.commit, null)
  assert.equal(info.date, null)
  assert.equal(info.channel, CHANNEL_RELEASE_CANDIDATE)
})

test('완전한 metadata 는 그대로 쓰인다', () => {
  const info = resolveBuildInfo('1.1.0-rc.1', {
    commit: '4bbb5d0', date: '2026-08-30', channel: CHANNEL_RELEASE_CANDIDATE
  })
  assert.deepEqual(buildDetailLines(info), [
    'AudioForge 1.1.0-rc.1', 'Build 4bbb5d0', '2026-08-30', CHANNEL_RELEASE_CANDIDATE
  ])
  assert.equal(buildDetailText(info).split('\n').length, 4)
})

test('기본 표시는 v + version 뿐 — AudioForge 를 반복하지 않는다', () => {
  const label = versionLabel({ version: '1.1.0-rc.1', commit: '4bbb5d0' })
  assert.equal(label, 'v1.1.0-rc.1', 'rc 에는 커밋을 붙이지 않는다')
  assert.equal(label.includes('AudioForge'), false)
  assert.equal(versionLabel({ version: '1.1.0', commit: '4bbb5d0' }), 'v1.1.0')
})

test('develop 계열만 표시 시점에 short SHA 를 합친다', () => {
  assert.equal(versionLabel({ version: '1.2.0-dev', commit: '693d076' }), 'v1.2.0-dev+693d076')
  assert.equal(versionLabel({ version: '1.2.0-dev', commit: null }), 'v1.2.0-dev',
    '커밋을 모르면 지어내지 않는다')
  assert.equal(versionLabel({ version: '1.2.0-dev+abc1234', commit: '693d076' }),
    'v1.2.0-dev+abc1234', '이미 자기 build metadata 가 있으면 덧붙이지 않는다')
})

test('상세 설명에는 경로가 들어가지 않는다', () => {
  const text = buildDetailText(resolveBuildInfo('1.1.0-rc.1', {
    commit: '4bbb5d0', date: '2026-08-30', channel: CHANNEL_RELEASE_CANDIDATE
  }))
  for (const marker of ['/', '\\', ':\\', 'C:', 'Users']) {
    assert.equal(text.includes(marker), false, `경로 흔적이 새면 안 된다: ${marker}`)
  }
})

test('후보 경로는 리소스 → app → out → 상위 순서다', () => {
  const paths = buildMetadataCandidates(join('APP'), 'RES', BUILD_METADATA_FILENAME)
  assert.deepEqual(paths, [
    join('RES', BUILD_METADATA_FILENAME),
    join('APP', BUILD_METADATA_FILENAME),
    join('APP', 'out', BUILD_METADATA_FILENAME),
    join('.', BUILD_METADATA_FILENAME)
  ])
  assert.equal(buildMetadataCandidates('APP', null, BUILD_METADATA_FILENAME).length, 3,
    '리소스 경로가 없으면 3개')
})

test('없는 파일과 깨진 파일은 모두 없음으로 다룬다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-bm-'))
  try {
    assert.equal(readBuildMetadataFile([join(dir, 'nope.json')]), null)
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ this is not json', 'utf-8')
    assert.equal(readBuildMetadataFile([broken]), null)
    const arr = join(dir, 'arr.json')
    writeFileSync(arr, '[1,2,3]', 'utf-8')
    assert.equal(readBuildMetadataFile([arr]), null, '배열은 metadata 가 아니다')
    const good = join(dir, BUILD_METADATA_FILENAME)
    writeFileSync(good, JSON.stringify({ commit: '4bbb5d0' }), 'utf-8')
    assert.deepEqual(readBuildMetadataFile([broken, good]), { commit: '4bbb5d0' },
      '깨진 후보를 건너뛰고 다음을 쓴다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('package.json version 이 단일 권위다 — 화면 문자열을 따로 두지 않는다', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
  assert.equal(pkg.version, '1.3.0', '정식 릴리스 버전')
  assert.equal(channelForVersion(pkg.version), CHANNEL_STABLE,
    'channel 은 version 접미사에서만 나온다 — 접미사가 없으면 Stable')
  assert.equal(versionLabel({ version: pkg.version, commit: null }), `v${pkg.version}`)
  // 정식 릴리스에는 -rc 도 short SHA 도 붙지 않는다. 커밋이 있어도 표시가 그대로여야 한다.
  assert.equal(versionLabel({ version: pkg.version, commit: 'abc1234' }), `v${pkg.version}`,
    '정식 표시에 +<short-sha> 를 붙이면 안 된다')
  assert.equal(pkg.version.includes('-'), false, '정식 버전에 접미사가 남아 있으면 안 된다')
  // renderer 소스에 버전 문자열이 하드코딩돼 있지 않은지 본다.
  const label = readFileSync(
    join(repoRoot, 'src', 'renderer', 'components', 'AppVersionLabel.tsx'), 'utf-8')
  assert.equal(/\d+\.\d+\.\d+/.test(label), false, 'renderer 에 버전을 하드코딩하면 권위가 둘이 된다')
  assert.equal(label.includes('getBuildInfo'), true)
})

test('lockfile 의 자기 version 이 package.json 과 같다', () => {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf-8'))
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
})

test('생성기는 package.json 과 같은 version·channel 을 낸다', () => {
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'generate-build-metadata.mjs')], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe']
  })
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
  const meta = JSON.parse(
    readFileSync(join(repoRoot, BUILD_METADATA_FILENAME), 'utf-8'))
  assert.equal(meta.version, pkg.version, 'UI 와 run bundle 이 볼 version 이 어긋난다')
  assert.equal(meta.channel, channelForVersion(pkg.version))
  assert.equal(isBuildDate(meta.date), true)
  assert.ok(meta.commit === null || isShortCommit(meta.commit),
    'commit 은 short SHA 이거나 모른다(null)여야 한다')
  const blob = JSON.stringify(meta)
  assert.equal(blob.includes(repoRoot), false, '빌드 머신 경로가 새면 안 된다')
})

test('Electron 런타임 버전이 앱 버전으로 새지 않는다', () => {
  // 정상: Electron 이 앱 package.json 을 찾아 준 경우
  assert.equal(pickAppVersion('1.1.0-rc.1', '34.2.0', '1.1.0-rc.1'), '1.1.0-rc.1')
  // 실측된 개발 실행: appPath 가 out/main 이라 Electron 이 자기 버전을 돌려준다
  assert.equal(pickAppVersion('34.2.0', '34.2.0', '1.1.0-rc.1'), '1.1.0-rc.1')
  // package.json 도 못 읽으면 아는 값이라도 돌려준다(화면이 비지 않는다)
  assert.equal(pickAppVersion('34.2.0', '34.2.0', null), '34.2.0')
  assert.equal(pickAppVersion('', '34.2.0', null), null)
})

test('package.json 후보는 appPath 에서 위로 올라간다', () => {
  const paths = packageJsonCandidates(join('R', 'out', 'main'))
  assert.equal(paths[0], join('R', 'out', 'main', 'package.json'))
  assert.ok(paths.includes(join('R', 'out', 'package.json')))
  assert.ok(paths.includes(join('R', 'package.json')))
  assert.equal(readPackageVersion([join(repoRoot, 'package.json')]),
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version)
  assert.equal(readPackageVersion([join(repoRoot, 'no-such-package.json')]), null)
})
