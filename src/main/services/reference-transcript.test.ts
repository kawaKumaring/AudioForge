// 참조 전사 sidecar 테스트 — 실제 파일시스템(격리된 임시 루트)만 쓴다.
// 전사 원문은 합성 문자열이고, 오디오·GPU·Electron은 쓰지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTranscriptStore, parseTranscriptSidecar,
  TRANSCRIPT_DIR_NAME, TRANSCRIPT_SCHEMA_VERSION,
} from './reference-transcript.ts'
import { createReferenceStore, type ReferenceStoreContract } from './reference-store.ts'
import {
  buildLibraryEntry, emptyManifest, assertManifestValid, promoteReferenceClip,
  removeManifestRecord, findManifestRecordByClipId, verifyStoredClip, clipFileName,
  runScopedStagingDirName, runJournalFileName, manifestTempFileName,
  normalizeTranscript, sha256HexOfString,
  MANIFEST_FILE_NAME, REFERENCE_STAGING_DIR_NAME,
} from '../../shared/referenceLibrary.ts'
import { inspectWavContainer, wavSamplesAreFinite } from '../../shared/wavContainer.ts'

// 정규화·해시는 reference_library 계약이 단일 권위다. 여기서 다시 만들지 않는다.
const CONTRACT = { normalizeTranscript, sha256HexOfString }
const STORE_CONTRACT: ReferenceStoreContract = {
  emptyManifest, assertManifestValid, promoteReferenceClip, removeManifestRecord,
  findManifestRecordByClipId, verifyStoredClip, clipFileName,
  runScopedStagingDirName, runJournalFileName, manifestTempFileName,
  manifestFileName: MANIFEST_FILE_NAME,
  stagingDirName: REFERENCE_STAGING_DIR_NAME,
  inspectWavContainer, wavSamplesAreFinite,
}

const CLIP = 'a1b2c3d4e5f60718'
const TEXT = '안녕하세요. 오늘 날씨가 좋네요.'
const RUN = 'abcdef0123456789'

function pcmWav(frames = 24000): Uint8Array {
  const dataSize = frames * 2
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  return b
}

function freshRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'aftx-')), 'reference-library')
}

function storeAt(root: string) {
  const transcripts = createTranscriptStore(CONTRACT, root)
  return { transcripts, store: createReferenceStore(STORE_CONTRACT, root, transcripts) }
}

const expectedSha = sha256HexOfString(normalizeTranscript(TEXT))

// ── 스키마 ──────────────────────────────────────────────────────────────────

test('스키마: 허용 필드 외 값과 clipId 불일치를 거부한다', () => {
  const good = { schemaVersion: 1, clipId: CLIP, transcriptSha256: expectedSha, text: TEXT, language: 'ko' }
  assert.ok(parseTranscriptSidecar(good, CLIP))
  assert.equal(parseTranscriptSidecar({ ...good, absolutePath: 'C:/x.wav' }, CLIP), null, '여분 필드 거부')
  assert.equal(parseTranscriptSidecar({ ...good, clipId: 'b'.repeat(16) }, CLIP), null, 'clipId 불일치 거부')
  assert.equal(parseTranscriptSidecar({ ...good, schemaVersion: 2 }, CLIP), null, '버전 불일치 거부')
  assert.equal(parseTranscriptSidecar({ ...good, transcriptSha256: 'zz' }, CLIP), null, '해시 형식 거부')
  assert.equal(parseTranscriptSidecar(null, CLIP), null)
})

test('해시: 계약 함수를 그대로 쓴다(새 정규화 규칙을 만들지 않는다)', () => {
  const t = createTranscriptStore(CONTRACT, freshRoot())
  const sidecar = t.build(CLIP, TEXT, 'ko')
  assert.equal(sidecar.transcriptSha256, expectedSha)
  assert.equal(sidecar.text, TEXT, '원문은 그대로 보관한다')
  assert.equal(sidecar.schemaVersion, TRANSCRIPT_SCHEMA_VERSION)
  // 모르는 언어를 임의 기본값으로 바꾸지 않는다.
  assert.equal(t.build(CLIP, TEXT, '').language, '')
})

// ── 읽기 상태 ───────────────────────────────────────────────────────────────

test('읽기: 부재·손상·해시 불일치가 각각 다른 사유로 나온다', () => {
  const root = freshRoot()
  const t = createTranscriptStore(CONTRACT, root)
  assert.deepEqual(t.read(CLIP, expectedSha), { ok: false, reason: 'TRANSCRIPT_MISSING' })

  mkdirSync(join(root, TRANSCRIPT_DIR_NAME), { recursive: true })
  const p = join(root, TRANSCRIPT_DIR_NAME, `${CLIP}.json`)

  writeFileSync(p, 'not json{', 'utf-8')
  assert.deepEqual(t.read(CLIP, expectedSha), { ok: false, reason: 'TRANSCRIPT_CORRUPT' })

  // 파일 안에서 자기모순(해시가 본문과 안 맞음)
  writeFileSync(p, JSON.stringify({
    schemaVersion: 1, clipId: CLIP, transcriptSha256: 'f'.repeat(64), text: TEXT, language: 'ko',
  }), 'utf-8')
  assert.deepEqual(t.read(CLIP, expectedSha), { ok: false, reason: 'TRANSCRIPT_CORRUPT' })

  // 자기 자신과는 맞지만 manifest 가 아는 해시와 다름
  const other = '다른 전사입니다'
  writeFileSync(p, JSON.stringify({
    schemaVersion: 1, clipId: CLIP,
    transcriptSha256: sha256HexOfString(normalizeTranscript(other)), text: other, language: 'ko',
  }), 'utf-8')
  assert.deepEqual(t.read(CLIP, expectedSha), { ok: false, reason: 'TRANSCRIPT_HASH_MISMATCH' })
})

test('상태: statusOf 는 원문 없이 상태만 돌려준다', () => {
  const root = freshRoot()
  const t = createTranscriptStore(CONTRACT, root)
  assert.equal(t.statusOf(CLIP, expectedSha), 'TRANSCRIPT_MISSING')

  const staging = join(root, 'stage')
  t.promote(t.writeStagingSidecar(staging, t.build(CLIP, TEXT, 'ko')), CLIP)
  assert.equal(t.statusOf(CLIP, expectedSha), 'present')
})

// ── 충돌 / 고아 ─────────────────────────────────────────────────────────────

test('충돌: 같은 clipId 에 다른 전사를 조용히 덮지 않는다', () => {
  const root = freshRoot()
  const t = createTranscriptStore(CONTRACT, root)
  t.promote(t.writeStagingSidecar(join(root, 'stage'), t.build(CLIP, TEXT, 'ko')), CLIP)

  assert.equal(t.conflictWith(t.build(CLIP, TEXT, 'ko')), null, '같은 전사는 재사용 가능')
  assert.equal(t.conflictWith(t.build(CLIP, '전혀 다른 문장', 'ko')), 'TRANSCRIPT_CONFLICT')
})

test('고아: manifest 가 모르는 sidecar 만 골라낸다', () => {
  const root = freshRoot()
  const t = createTranscriptStore(CONTRACT, root)
  const other = 'ffffffffffffffff'
  t.promote(t.writeStagingSidecar(join(root, 's1'), t.build(CLIP, TEXT, 'ko')), CLIP)
  t.promote(t.writeStagingSidecar(join(root, 's2'), t.build(other, TEXT, 'ko')), other)

  assert.deepEqual(t.listOrphans([CLIP]), [other])
  assert.deepEqual(t.listOrphans([CLIP, other]), [])
})

// ── 저장소 통합 ─────────────────────────────────────────────────────────────

test('통합: 전사가 있으면 clip 과 함께 승격되고 재시작 후 복원된다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: TEXT })

  const res = store.importClip({
    runId: RUN, entry, clipBytes: pcmWav(),
    transcript: { text: TEXT, language: 'ko' },
  })
  assert.equal(res.status, 'REFERENCE_PROMOTED')
  const id = entry.defaultCandidateId
  assert.ok(existsSync(join(root, TRANSCRIPT_DIR_NAME, `${id}.json`)), 'sidecar 가 durable 에 있다')

  // 앱을 다시 켠 상황 — 새 인스턴스가 실제 ref_text 를 복원한다.
  const { store: reopened } = storeAt(root)
  const got = reopened.resolveTranscript(id)
  assert.equal(got.ok, true)
  if (!got.ok) return
  assert.equal(got.sidecar.text, TEXT)
  assert.equal(got.sidecar.language, 'ko')
  assert.equal(reopened.listRecords()[0].transcript, 'present')
})

test('통합: 전사가 없으면 sidecar 를 만들지 않고 상태로 드러낸다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: '' })

  const res = store.importClip({ runId: RUN, entry, clipBytes: pcmWav(), transcript: null })
  assert.equal(res.status, 'REFERENCE_PROMOTED', '전사가 없어도 등록 자체는 된다')
  const id = entry.defaultCandidateId
  assert.ok(!existsSync(join(root, TRANSCRIPT_DIR_NAME, `${id}.json`)), '빈 전사를 가짜로 저장하지 않는다')
  assert.equal(store.listRecords()[0].transcript, 'TRANSCRIPT_MISSING')
  assert.deepEqual(store.resolveTranscript(id), { ok: false, reason: 'TRANSCRIPT_MISSING' })
})

test('통합: 같은 clipId 에 다른 전사를 넣으려 하면 승격 자체를 막는다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: TEXT })
  store.importClip({ runId: RUN, entry, clipBytes: pcmWav(), transcript: { text: TEXT, language: 'ko' } })

  const before = readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8')
  const conflict = store.importClip({
    runId: RUN, entry, clipBytes: pcmWav(),
    transcript: { text: '다른 문장으로 바꿔치기', language: 'ko' },
  })
  assert.equal(conflict.status, 'REFERENCE_PROMOTE_FAILED')
  assert.equal(conflict.transcriptCode, 'TRANSCRIPT_CONFLICT')
  assert.deepEqual(conflict.steps, [], '승격 단계에 들어가지도 않는다')
  assert.equal(readFileSync(join(root, MANIFEST_FILE_NAME), 'utf-8'), before, 'manifest 불변')
  // 기존 전사는 그대로다.
  const got = store.resolveTranscript(entry.defaultCandidateId)
  assert.ok(got.ok && got.sidecar.text === TEXT)
})

test('통합: 삭제하면 clip 과 sidecar 가 함께 사라진다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: TEXT })
  store.importClip({ runId: RUN, entry, clipBytes: pcmWav(), transcript: { text: TEXT, language: 'ko' } })
  const id = entry.defaultCandidateId

  assert.deepEqual(store.removeClip(id), { ok: true })
  assert.ok(!existsSync(join(root, clipFileName(id))), 'clip 삭제')
  assert.ok(!existsSync(join(root, TRANSCRIPT_DIR_NAME, `${id}.json`)), 'sidecar 도 함께 삭제')
  assert.equal(store.listRecords().length, 0)
})

test('통합: sidecar 가 사라지면 자동 대체 없이 사유만 남는다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: TEXT })
  store.importClip({ runId: RUN, entry, clipBytes: pcmWav(), transcript: { text: TEXT, language: 'ko' } })
  const id = entry.defaultCandidateId

  rmSync(join(root, TRANSCRIPT_DIR_NAME, `${id}.json`))
  assert.deepEqual(store.resolveTranscript(id), { ok: false, reason: 'TRANSCRIPT_MISSING' })
  assert.equal(store.listRecords()[0].transcript, 'TRANSCRIPT_MISSING')
  // 클립 자체는 여전히 멀쩡하다 — 전사만 없는 상태로 드러난다(강등·대체 없음).
  assert.equal(store.resolveClipFile(id).ok, true)
})

test('유출 방지: 목록 값에 전사 원문이 없다', () => {
  const root = freshRoot()
  const { store } = storeAt(root)
  const entry = buildLibraryEntry({ sourceSha256: 'a'.repeat(64), region: { start: 1, duration: 4 }, transcript: TEXT })
  store.importClip({ runId: RUN, entry, clipBytes: pcmWav(), transcript: { text: TEXT, language: 'ko' } })

  const values = store.listRecords().flatMap((r) => Object.values(r).map((v) => String(v))).join('|')
  assert.ok(!values.includes(TEXT), '목록에 전사 원문이 없다')
  assert.ok(!values.includes('안녕'), '일부 문구도 새지 않는다')
})
