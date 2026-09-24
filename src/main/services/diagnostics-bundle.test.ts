// 진단 묶음 — 무엇이 들어가고, 특히 **무엇이 들어가지 않는가**를 실제 파일로 확인한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildDiagnosticsBundle, bundleDirName, recentLogFiles, summarizeShape } from './diagnostics-bundle.ts'

const T0 = new Date(2026, 8, 17, 21, 10, 3)

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'af-diag-'))
  const logDir = join(root, 'logs'); mkdirSync(logDir)
  const target = join(root, 'out'); mkdirSync(target)
  const settingsPath = join(root, 'settings.json')
  return { root, logDir, target, settingsPath, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function everyFileText(dir: string): string {
  let out = ''
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name)
    out += n.isDirectory() ? everyFileText(p) : readFileSync(p, 'utf-8')
  }
  return out
}

test('묶음 폴더 이름은 시각으로 정해진다', () => {
  assert.equal(bundleDirName(T0), 'AudioForge_진단_20260917-211003')
})

test('모양 요약은 값을 한 글자도 내지 않는다', () => {
  const lines = summarizeShape({
    lastDir: 'E:/비밀/폴더', playbackVolume: 0.7, flag: true, nothing: null,
    workDrafts: { 'k1': { ttsText: '비밀 대사 본문', speakerMode: 'multi' }, 'k2': { ttsText: 'x' } },
    list: [1, 2, 3],
  })
  const text = lines.join('\n')
  assert.match(text, /^lastDir: 문자열\(글자 8\)$/m)
  assert.match(text, /^playbackVolume: 숫자$/m)
  assert.match(text, /^flag: 참\/거짓$/m)
  assert.match(text, /^nothing: null$/m)
  assert.match(text, /^workDrafts: 객체\(키 2개\)$/m)
  assert.match(text, /^ {2}k1: 객체\(키 2개\)$/m, '깊이 2 는 키 개수까지')
  assert.ok(!text.includes('ttsText'), '깊이 3 은 접는다 — 대사 키조차 나오지 않는다')
  assert.match(text, /^list: 배열\(항목 3개\)$/m)
  assert.ok(!text.includes('비밀') && !text.includes('0.7') && !text.includes('multi'), '값이 없다')
})

test('최근 N일 로그만 고른다(오늘 포함)', () => {
  const s = scratch()
  try {
    for (const d of ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']) {
      writeFileSync(join(s.logDir, `audioforge-${d}.log`), d, 'utf-8')
    }
    writeFileSync(join(s.logDir, 'stray.log'), 'x', 'utf-8')
    assert.deepEqual(recentLogFiles(s.logDir, T0, 3),
      ['audioforge-2026-09-15.log', 'audioforge-2026-09-16.log', 'audioforge-2026-09-17.log'])
  } finally { s.cleanup() }
})

test('묶음에는 로그 복사본과 요약이 있고, 설정 값·대사는 어디에도 없다', () => {
  const s = scratch()
  try {
    writeFileSync(join(s.logDir, 'audioforge-2026-09-17.log'), '2026-09-17T09:00:00.000+09:00 INFO  [job] start mode=tts file=a.wav\n', 'utf-8')
    writeFileSync(join(s.logDir, 'audioforge-2026-09-10.log'), 'too old\n', 'utf-8')
    const SECRET_TEXT = '이것은_비밀_대사_본문_9f3a'
    const SECRET_DIR = 'E:/비밀폴더/녹음실_7c1'
    writeFileSync(s.settingsPath, JSON.stringify({
      lastDir: SECRET_DIR,
      workDrafts: { 'k': { ttsText: SECRET_TEXT, speakerMode: 'multi' } },
      playbackVolume: 0.7,
    }), 'utf-8')

    const r = buildDiagnosticsBundle({
      targetDir: s.target, logDir: s.logDir, settingsPath: s.settingsPath, now: () => T0,
      runtime: { appVersion: '1.12.0-dev', channel: 'Development', commit: 'abc1234', platform: 'win32', arch: 'x64', electron: '34.2.0', node: '20.18.1', pythonPresent: true },
    })
    assert.equal(r.name, 'AudioForge_진단_20260917-211003')
    assert.ok(existsSync(join(r.dir, 'summary.txt')))
    assert.deepEqual(r.copiedLogs, ['audioforge-2026-09-17.log'], '3일 밖 로그는 들어가지 않는다')
    assert.deepEqual(r.files, ['summary.txt', 'logs/audioforge-2026-09-17.log'])

    const summary = readFileSync(join(r.dir, 'summary.txt'), 'utf-8')
    assert.match(summary, /version: 1\.12\.0-dev \(Development\)/)
    assert.match(summary, /python: 있음/)
    assert.match(summary, /^workDrafts: 객체\(키 1개\)$/m)
    assert.match(summary, /^lastDir: 문자열\(글자 \d+\)$/m)
    assert.match(summary, /logs\/audioforge-2026-09-17\.log \(\d+ 바이트\)/)

    const all = everyFileText(r.dir)
    assert.ok(!all.includes(SECRET_TEXT), '대사 본문이 어디에도 없다')
    assert.ok(!all.includes('비밀폴더'), '설정의 경로 값이 어디에도 없다')
    assert.ok(!all.includes('0.7'), '설정 값이 없다')
    assert.ok(!all.includes(s.settingsPath), '설정 파일의 경로도 적지 않는다')
  } finally { s.cleanup() }
})

test('설정 파일이 없거나 손상돼도 묶음은 만들어지고 그 사실을 적는다', () => {
  const s = scratch()
  try {
    const r1 = buildDiagnosticsBundle({
      targetDir: s.target, logDir: s.logDir, settingsPath: s.settingsPath, now: () => T0,
      runtime: { appVersion: '1.12.0-dev', platform: 'win32', arch: 'x64' },
    })
    assert.match(readFileSync(join(r1.dir, 'summary.txt'), 'utf-8'), /설정 파일: 없음/)
    assert.match(readFileSync(join(r1.dir, 'summary.txt'), 'utf-8'), /\[로그\] 최근 3일, 0개/)

    writeFileSync(s.settingsPath, '{ 깨진 json', 'utf-8')
    const r2 = buildDiagnosticsBundle({
      targetDir: s.target, logDir: s.logDir, settingsPath: s.settingsPath, now: () => new Date(2026, 8, 17, 21, 10, 4),
      runtime: { appVersion: '1.12.0-dev', platform: 'win32', arch: 'x64' },
    })
    assert.match(readFileSync(join(r2.dir, 'summary.txt'), 'utf-8'), /설정 파일: JSON 손상 \(\d+ 바이트\)/)
  } finally { s.cleanup() }
})

test('같은 초에 두 번은 덮어쓰지 않고 실패한다', () => {
  const s = scratch()
  try {
    const input = {
      targetDir: s.target, logDir: s.logDir, settingsPath: s.settingsPath, now: () => T0,
      runtime: { appVersion: '1.12.0-dev', platform: 'win32', arch: 'x64' },
    }
    buildDiagnosticsBundle(input)
    assert.throws(() => buildDiagnosticsBundle(input), (e: { code?: string }) => e.code === 'BUNDLE_EXISTS')
  } finally { s.cleanup() }
})

// ★이 검사가 없어서 결함이 통과했다(2026-09-24 2차 감사).
//   기존 검사가 심는 비밀은 전부 **설정 값**이고, 로그 본문에는 안전한 줄만 넣었다.
//   그래서 "로그를 한 글자도 안 보고 그대로 복사한다" 는 사실이 한 번도 드러나지 않았다.
//   실제 로그에는 Electron 이 스스로 찍은 `Command failed: … <사용자 음원 절대 경로>` 가 들어온다.
test('로그 본문에 절대 경로가 있어도 묶음에는 남지 않는다 — 폴더만 지우고 이름은 남긴다', () => {
  const s = scratch()
  const BS = String.fromCharCode(92)
  try {
    const line = (...parts: string[]) => parts.join(BS)
    const secretDrive = line('E:', '비밀작업', '2026', '면담_원본.wav')
    const secretUnc = BS + line('', '사내서버', '공유녹음', '면담2.wav')
    writeFileSync(join(s.logDir, "audioforge-2026-09-17.log"), [
      "2026-09-17T09:00:00.000+09:00 INFO  [job] start mode=tts file=a.wav",
      `2026-09-17T09:00:01.000+09:00 ERROR [console] Command failed: ${secretDrive}`,
      `2026-09-17T09:00:02.000+09:00 ERROR [uncaught] Error: ENOENT ${secretUnc}`,
      "2026-09-17T09:00:03.000+09:00 ERROR [console] did-fail-load url=file:///E:/비밀앱/index.html",
      "",
    ].join('\n'), 'utf-8')

    const r = buildDiagnosticsBundle({
      targetDir: s.target, logDir: s.logDir, settingsPath: s.settingsPath, now: () => T0,
      runtime: { appVersion: '1.12.0-dev', platform: 'win32', arch: 'x64' },
    })
    const all = everyFileText(r.dir)
    assert.ok(!all.includes('비밀작업'), '로그의 폴더 경로가 묶음에 남았다')
    assert.ok(!all.includes('사내서버'), 'UNC 서버 이름이 묶음에 남았다')
    assert.ok(!all.includes('공유녹음'), 'UNC 공유 이름이 묶음에 남았다')
    assert.ok(!all.includes('비밀앱'), 'file:// 경로가 묶음에 남았다')
    // 진단 가치를 죽이지 않았는지 — 무엇이 실패했는지는 남아야 한다.
    assert.ok(all.includes('면담_원본.wav'), '파일 이름까지 지우면 진단이 안 된다')
    assert.ok(all.includes('Command failed'), '오류 종류가 사라졌다')
  } finally { s.cleanup() }
})
