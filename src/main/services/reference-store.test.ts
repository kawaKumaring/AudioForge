// 참조 라이브러리 영속 저장소 테스트 — 실제 파일시스템(격리된 임시 루트)만 쓴다.
// 합성 WAV 만 사용하고 사용자 미디어·GPU·Electron 은 쓰지 않는다.
//
// 지키는 것:
//   1) 승격은 계약 6단계를 그대로 밟고, 실패하면 durable·manifest 가 그대로다
//   2) 재시작(새 인스턴스)에서 manifest 가 복원된다
//   3) 손상 manifest 를 빈 것으로 조용히 덮지 않는다
//   4) 논리 ID 밖의 입력은 파일시스템에 닿기 전에 거부된다(traversal·링크)
//   5) renderer 로 나가는 목록에 경로가 없다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReferenceStore, type ReferenceStoreContract } from './reference-store.ts'
import {
  buildLibraryEntry, emptyManifest, assertManifestValid, promoteReferenceClip,
  removeManifestRecord, findManifestRecordByClipId, verifyStoredClip, clipFileName,
  runScopedStagingDirName, runJournalFileName, manifestTempFileName,
  MANIFEST_FILE_NAME, REFERENCE_STAGING_DIR_NAME,
} from '../../shared/referenceLibrary.ts'
import { inspectWavContainer, wavSamplesAreFinite } from '../../shared/wavContainer.ts'

const CONTRACT: ReferenceStoreContract = {
  emptyManifest, assertManifestValid, promoteReferenceClip, removeManifestRecord,
  findManifestRecordByClipId, verifyStoredClip, clipFileName,
  runScopedStagingDirName, runJournalFileName, manifestTempFileName,
  manifestFileName: MANIFEST_FILE_NAME,
  stagingDirName: REFERENCE_STAGING_DIR_NAME,
  inspectWavContainer, wavSamplesAreFinite,
}

const SRC_A = 'a'.repeat(64)
const SRC_B = 'b'.repeat(64)
const RUN = 'abcdef0123456789'

/** mono/24k/16bit 정수 PCM — ref-trim 계약이 만드는 형태. */
function pcmWav(frames: number, seed = 1): Uint8Array {
  const dataSize = frames * 2
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  for (let i = 0; i < frames; i++) dv.setInt16(44 + i * 2, ((i * seed) % 1000) - 500, true)
  return b
}

/** IEEE float WAV — 저장소가 받아들이면 안 되는 형태. */
function floatWav(frames: number): Uint8Array {
  const dataSize = frames * 4
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true); dv.setUint32(28, 96000, true); dv.setUint16(32, 4, true); dv.setUint16(34, 32, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  return b
}

function entryFor(sourceSha: string, start = 1, duration = 4): ReturnType<typeof buildLibraryEntry> {
  return buildLibraryEntry({ sourceSha256: sourceSha, region: { start, duration }, transcript: '안녕하세요 반갑습니다' })
}

function freshRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'afreflib-')), 'reference-library')
}

function importOne(root: string, sourceSha = SRC_A, start = 1, frames = 24000, seed = 1) {
  const store = createReferenceStore(CONTRACT, root)
  const entry = entryFor(sourceSha, start)
  return {
    store,
    entry,
    result: store.importClip({ runId: RUN, entry, clipBytes: pcmWav(frames, seed) }),
  }
}

// ── 1) 승격 정상 경로 ───────────────────────────────────────────────────────

test('import: 6단계를 순서대로 밟고 durable 파일과 manifest 를 남긴다', () => {
  const root = freshRoot()
  const { store, entry, result } = importOne(root)

  assert.equal(result.status, 'REFERENCE_PROMOTED')
  assert.deepEqual(result.steps, [
    'CREATE_STAGING_DIR', 'WRITE_STAGING_CLIP', 'VERIFY_STAGING_CLIP',
    'PROMOTE_CLIP', 'WRITE_MANIFEST_TEMP', 'REPLACE_MANIFEST',
  ])
  assert.ok(result.record)
  assert.equal(result.record?.clip_id, entry.defaultCandidateId)

  const clip = join(root, clipFileName(entry.defaultCandidateId))
  assert.ok(existsSync(clip), 'durable 클립이 있다')
  assert.ok(existsSync(join(root, MANIFEST_FILE_NAME)), 'manifest 가 있다')

  const loaded = store.loadManifest()
  assert.equal(loaded.status, 'ok')
  assert.equal(loaded.manifest.records.length, 1)
})

test('import: 앱 시작이 아니라 최초 import 때 디렉터리가 생긴다', () => {
  const root = freshRoot()
  createReferenceStore(CONTRACT, root)                       // 생성만으로는
  assert.equal(existsSync(root), false, '폴더를 미리 만들지 않는다')
  importOne(root)
  assert.equal(existsSync(root), true)
})

test('재시작: 새 인스턴스가 manifest 를 복원한다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)

  const reopened = createReferenceStore(CONTRACT, root)      // 앱을 다시 켠 상황
  const records = reopened.listRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].referenceId, entry.defaultCandidateId)
  assert.equal(records[0].present, true)
})

test('신원: 같은 원본·같은 구간이면 같은 참조 ID, 구간이 다르면 다른 ID', () => {
  const root = freshRoot()
  const a = importOne(root, SRC_A, 1)
  const again = entryFor(SRC_A, 1)
  assert.equal(again.defaultCandidateId, a.entry.defaultCandidateId, '같은 원본·구간 → 같은 ID')

  const other = importOne(root, SRC_A, 5)
  assert.notEqual(other.entry.defaultCandidateId, a.entry.defaultCandidateId, '구간이 다르면 다른 ID')
  assert.equal(createReferenceStore(CONTRACT, root).listRecords().length, 2)

  const differentSource = entryFor(SRC_B, 1)
  assert.notEqual(differentSource.defaultCandidateId, a.entry.defaultCandidateId, '원본이 다르면 다른 ID')
})

test('내용 신원: 같은 ID 라도 저장된 바이트가 다르면 clip_sha256 이 다르다', () => {
  const root1 = freshRoot()
  const root2 = freshRoot()
  const r1 = importOne(root1, SRC_A, 1, 24000, 1)
  const r2 = importOne(root2, SRC_A, 1, 24000, 7)   // 같은 길이·이름, 내용만 다름
  assert.equal(r1.result.record?.clip_id, r2.result.record?.clip_id)
  assert.notEqual(r1.result.record?.clip_sha256, r2.result.record?.clip_sha256)
})

// ── 2) 검증 실패 — 아무것도 남기지 않는다 ───────────────────────────────────

test('검증 실패: float WAV 는 승격되지 않고 durable·manifest 가 그대로다', () => {
  const root = freshRoot()
  importOne(root)                                   // 먼저 정상 항목 하나
  const before = readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8')
  const beforeFiles = readdirSync(root).sort()

  const store = createReferenceStore(CONTRACT, root)
  const bad = entryFor(SRC_B, 2)
  const res = store.importClip({ runId: RUN, entry: bad, clipBytes: floatWav(1000) })

  assert.equal(res.status, 'REFERENCE_PROMOTE_FAILED')
  assert.equal(res.failedStep, 'VERIFY_STAGING_CLIP')
  assert.equal(res.errorCode, 'CLIP_VERIFICATION_FAILED')
  assert.equal(res.wavCode, 'WAV_ENCODING_UNSUPPORTED', '왜 실패했는지 사유가 남는다')
  assert.equal(res.record, null)

  assert.equal(readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8'), before, 'manifest 불변')
  assert.ok(!existsSync(join(root, clipFileName(bad.defaultCandidateId))), '실패한 클립은 durable 에 없다')
  // staging 잔여물은 남을 수 있으나 durable 목록은 그대로여야 한다.
  const durableAfter = readdirSync(root).filter((n) => n.endsWith('.wav')).sort()
  assert.deepEqual(durableAfter, beforeFiles.filter((n) => n.endsWith('.wav')).sort())
})

test('검증 실패: 기대 규격과 다르면 승격되지 않는다', () => {
  const root = freshRoot()
  const store = createReferenceStore(CONTRACT, root)
  const entry = entryFor(SRC_A, 1)
  const res = store.importClip({
    runId: RUN, entry, clipBytes: pcmWav(24000),
    expected: { sample_rate: 48000, channel_count: 1, duration_ms: 1000 },   // 실제는 24000Hz
  })
  assert.equal(res.status, 'REFERENCE_PROMOTE_FAILED')
  assert.equal(res.failedStep, 'VERIFY_STAGING_CLIP')
  assert.ok(!existsSync(join(root, MANIFEST_FILE_NAME)), 'manifest 를 만들지도 않는다')
})

// ── 3) 손상 manifest — 조용히 초기화하지 않는다 ─────────────────────────────

test('손상 manifest: 빈 것으로 덮지 않고 corrupt 로 격리한다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)
  writeFileSync(join(root, MANIFEST_FILE_NAME), '{ this is not json', 'utf-8')

  const store = createReferenceStore(CONTRACT, root)
  const loaded = store.loadManifest()
  assert.equal(loaded.status, 'corrupt')
  assert.equal(loaded.code, 'MANIFEST_NOT_JSON')
  assert.deepEqual(store.listRecords(), [], '손상 상태에서 목록을 지어내지 않는다')

  // 쓰기 경로는 전부 막힌다 — 덮어쓰면 기존 기록이 사라진다.
  const res = store.importClip({ runId: RUN, entry: entryFor(SRC_B, 3), clipBytes: pcmWav(1000) })
  assert.equal(res.status, 'REFERENCE_PROMOTE_FAILED')
  assert.deepEqual(store.removeClip(entry.defaultCandidateId), { ok: false, reason: 'MANIFEST_CORRUPT' })
  assert.equal(readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8'), '{ this is not json', '손상 파일도 건드리지 않는다')
})

test('손상 manifest: 스키마 위반도 corrupt 로 잡는다', () => {
  const root = freshRoot()
  importOne(root)
  writeFileSync(join(root, MANIFEST_FILE_NAME),
    JSON.stringify({ manifest_version: 1, records: [{ clip_id: 'x', absolute_path: 'C:/secret.wav' }] }), 'utf-8')
  const loaded = createReferenceStore(CONTRACT, root).loadManifest()
  assert.equal(loaded.status, 'corrupt')
  assert.equal(loaded.code, 'MANIFEST_INVALID')
})

// ── 4) 파일 누락 / 체크섬 ───────────────────────────────────────────────────

test('파일 누락: 목록이 present=false 로 드러내고 해석은 실패한다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)
  rmSync(join(root, clipFileName(entry.defaultCandidateId)))

  const store = createReferenceStore(CONTRACT, root)
  assert.equal(store.listRecords()[0].present, false)
  assert.deepEqual(store.resolveClipFile(entry.defaultCandidateId), { ok: false, reason: 'NOT_OWNED' })
})

test('체크섬 불일치: 내용이 바뀐 클립은 해석을 거부한다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)
  writeFileSync(join(root, clipFileName(entry.defaultCandidateId)), pcmWav(24000, 99))

  const res = createReferenceStore(CONTRACT, root).resolveClipFile(entry.defaultCandidateId)
  assert.deepEqual(res, { ok: false, reason: 'CHECKSUM_MISMATCH' })
})

test('해석 성공: main 내부에서만 경로를 얻는다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)
  const res = createReferenceStore(CONTRACT, root).resolveClipFile(entry.defaultCandidateId)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.filePath, join(root, clipFileName(entry.defaultCandidateId)))
  assert.match(res.clipSha256, /^[0-9a-f]{64}$/)
})

// ── 5) 삭제 안전 ────────────────────────────────────────────────────────────

test('remove: 논리 ID 밖의 입력은 파일시스템에 닿기 전에 거부된다', () => {
  const root = freshRoot()
  importOne(root)
  const outside = join(root, '..', 'victim.txt')
  writeFileSync(outside, 'keep me', 'utf-8')

  const store = createReferenceStore(CONTRACT, root)
  for (const bad of ['../victim.txt', '..\\victim.txt', 'a/../../victim', '', '   ', 'ZZZZ',
                     'a'.repeat(17), 'a'.repeat(15), 'g'.repeat(16), '../' + 'a'.repeat(13)]) {
    assert.deepEqual(store.removeClip(bad), { ok: false, reason: 'INVALID_ID' }, bad)
  }
  // 대문자 hex 는 형식으로는 유효하다(계약이 소문자로 정규화한다) → 없는 id 로 처리된다.
  assert.deepEqual(store.removeClip('A'.repeat(16)), { ok: false, reason: 'NOT_FOUND' })
  assert.equal(readFileSync(outside, 'utf-8'), 'keep me', '바깥 파일은 그대로다')
  assert.equal(store.listRecords().length, 1, 'manifest 도 그대로다')
})

test('remove: 정상 삭제는 레코드와 파일을 함께 없앤다', () => {
  const root = freshRoot()
  const { entry } = importOne(root)
  const store = createReferenceStore(CONTRACT, root)

  assert.deepEqual(store.removeClip(entry.defaultCandidateId), { ok: true })
  assert.equal(store.listRecords().length, 0)
  assert.ok(!existsSync(join(root, clipFileName(entry.defaultCandidateId))))
  assert.equal(store.loadManifest().status, 'ok', 'manifest 는 정합 상태로 남는다')

  assert.deepEqual(store.removeClip(entry.defaultCandidateId), { ok: false, reason: 'NOT_FOUND' })
})

test('remove: 심볼릭 링크로 바꿔치기한 자산은 삭제하지 않는다', (t) => {
  const root = freshRoot()
  const { entry } = importOne(root)
  const target = join(root, clipFileName(entry.defaultCandidateId))
  const outside = join(root, '..', 'outside-real.wav')
  writeFileSync(outside, pcmWav(100))
  unlinkSync(target)
  try {
    symlinkSync(outside, target, 'file')
  } catch {
    t.skip('이 환경에서는 심볼릭 링크를 만들 수 없다(권한)')
    return
  }
  const store = createReferenceStore(CONTRACT, root)
  assert.deepEqual(store.removeClip(entry.defaultCandidateId), { ok: false, reason: 'NOT_OWNED' })
  assert.ok(existsSync(outside), '링크가 가리키던 바깥 파일은 살아 있다')
  assert.deepEqual(store.resolveClipFile(entry.defaultCandidateId), { ok: false, reason: 'NOT_OWNED' })
})

// ── 6) 정리 / 유출 방지 ─────────────────────────────────────────────────────

test('sweep: 이 run 이 남긴 staging 만 정리한다', () => {
  const root = freshRoot()
  importOne(root)
  const stagingDir = join(root, REFERENCE_STAGING_DIR_NAME)
  const mine = join(stagingDir, runScopedStagingDirName(RUN))
  const other = join(stagingDir, runScopedStagingDirName('99998888aaaabbbb'))
  mkdirSync(mine, { recursive: true }); mkdirSync(other, { recursive: true })
  writeFileSync(join(mine, 'x.wav'), pcmWav(10))
  writeFileSync(join(other, 'y.wav'), pcmWav(10))

  createReferenceStore(CONTRACT, root).sweepRunScoped(RUN)
  assert.ok(!existsSync(mine), '내 run 의 staging 은 정리된다')
  assert.ok(existsSync(other), '다른 run 의 staging 은 건드리지 않는다')
})

test('유출 방지: 목록·manifest 어디에도 경로가 없다', () => {
  const root = freshRoot()
  importOne(root)
  const store = createReferenceStore(CONTRACT, root)

  // 필드 '값'만 본다 — JSON 구분자 ':' 를 경로로 오판하지 않기 위해서다.
  const values = store.listRecords().flatMap((r) => Object.values(r).map((v) => String(v))).join('|')
  for (const needle of [root, 'reference-library', '.wav', '/', '\\', ':']) {
    assert.ok(!values.includes(needle), `목록 값에 ${needle} 이 없다`)
  }
  const manifestJson = readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8')
  for (const needle of [root, '.wav', 'C:', 'file:']) {
    assert.ok(!manifestJson.includes(needle), `manifest 에 ${needle} 이 없다`)
  }
})
