// 참조 등록 오케스트레이션 테스트 — 파이썬은 가짜로 주입하고 저장소는 실제 임시 디렉터리를 쓴다.
// 합성 WAV 만 사용하며 GPU·모델·사용자 미디어는 쓰지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importReference, type ReferenceImportDeps, type PythonPreviewResult } from './reference-import.ts'
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

function pcmWav(frames: number, seed = 1): Uint8Array {
  const dataSize = frames * 2
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  for (let i = 0; i < frames; i++) dv.setInt16(44 + i * 2, ((i * seed) % 900) - 450, true)
  return b
}

function stereo48kWav(frames: number): Uint8Array {
  const dataSize = frames * 4
  const b = new Uint8Array(44 + dataSize)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i) }
  put('RIFF', 0); dv.setUint32(4, 36 + dataSize, true); put('WAVE', 8)
  put('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true)
  dv.setUint32(24, 48000, true); dv.setUint32(28, 192000, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true)
  put('data', 36); dv.setUint32(40, dataSize, true)
  return b
}

interface Harness {
  deps: ReferenceImportDeps
  root: string
  sourcePath: string
  calls: string[]
  tempDirs: string[]
  setTrimOutput(bytes: Uint8Array | null): void
  setAnalyze(result: PythonPreviewResult): void
  setTrim(result: PythonPreviewResult): void
}

function harness(opts: { sourceExt?: string } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'afimport-'))
  const root = join(base, 'reference-library')
  const sourcePath = join(base, `voice${opts.sourceExt ?? '.wav'}`)
  writeFileSync(sourcePath, pcmWav(48000, 3))     // 사용자 '원본'(합성)

  const calls: string[] = []
  const tempDirs: string[] = []
  let analyzeResult: PythonPreviewResult = { status: 'ok', duration_sec: 2, sample_rate: 24000, channels: 1, valid_whole: true }
  let trimResult: PythonPreviewResult = { status: 'ok', clip_path: 'ignored' }
  let trimOutput: Uint8Array | null = pcmWav(24000)

  const store = createReferenceStore(CONTRACT, root)
  let runSeq = 0

  const deps: ReferenceImportDeps = {
    store,
    runAnalyze: async (p) => { calls.push(`analyze:${p === sourcePath}`); return analyzeResult },
    runTrim: async (p, start, dur, outDir) => {
      calls.push(`trim:${p === sourcePath}:${start}:${dur}`)
      if (trimOutput) writeFileSync(join(outDir, 'reference_clip_24k.wav'), trimOutput)
      return trimResult
    },
    isReadableFile: (p) => { try { return statSync(p).isFile() } catch { return false } },
    sha256OfFile: (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return null } },
    readFileBytes: (p) => readFileSync(p),
    makeTempDir: () => { const d = mkdtempSync(join(tmpdir(), 'aftrim-')); tempDirs.push(d); return d },
    removeTempDir: (d) => { try { rmSync(d, { recursive: true, force: true }) } catch { /* noop */ } },
    joinPath: (...parts) => join(...parts),
    buildLibraryEntry,
    makeRunId: () => { runSeq += 1; return runSeq.toString(16).padStart(16, '0') },
  }

  return {
    deps, root, sourcePath, calls, tempDirs,
    setTrimOutput: (b) => { trimOutput = b },
    setAnalyze: (r) => { analyzeResult = r },
    setTrim: (r) => { trimResult = r },
  }
}

function sourceSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ── 정상 경로 ───────────────────────────────────────────────────────────────

test('import: 원본을 읽기만 하고 논리 메타데이터만 돌려준다', async () => {
  const h = harness()
  const before = sourceSha(h.sourcePath)

  const res = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 200, regionDurationMs: 1500, transcript: '안녕하세요' })
  assert.equal(res.ok, true)
  if (!res.ok) return

  assert.match(res.referenceId, /^[0-9a-f]{16}$/)
  assert.match(res.contentSha256, /^[0-9a-f]{64}$/)
  assert.equal(res.sourceSha256, before, '원본 해시가 그대로 기록된다')
  assert.equal(res.regionStartMs, 200)
  assert.equal(res.regionDurationMs, 1500)

  // 응답에 경로 흔적이 없다.
  const blob = Object.values(res).map(String).join('|')
  for (const needle of ['/', '\\', ':', '.wav', h.root]) {
    assert.ok(!blob.includes(needle), `응답에 ${needle} 없음`)
  }
  // 원본은 손대지 않았다.
  assert.ok(existsSync(h.sourcePath))
  assert.equal(sourceSha(h.sourcePath), before)
  // 파생 임시 폴더는 정리됐다.
  for (const d of h.tempDirs) assert.ok(!existsSync(d), '임시 폴더 정리')
})

test('import: analyze → trim 순서로 정확히 한 번씩 부른다', async () => {
  const h = harness()
  await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  assert.deepEqual(h.calls, ['analyze:true', 'trim:true:0:1'])
})

test('import: 구간 미지정이면 분석이 권한 구간을 쓴다', async () => {
  const h = harness()
  h.setAnalyze({ status: 'ok', duration_sec: 30, needs_region: true, recommend: { start: 4, duration: 6 } })
  await importReference(h.deps, { filePath: h.sourcePath })
  assert.deepEqual(h.calls, ['analyze:true', 'trim:true:4:6'])
})

test('import: 요청 구간이 원본 길이를 넘으면 잘라 맞춘다', async () => {
  const h = harness()
  h.setAnalyze({ status: 'ok', duration_sec: 3, valid_whole: true })
  await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 2000, regionDurationMs: 9000 })
  assert.deepEqual(h.calls, ['analyze:true', 'trim:true:2:1'])
})

test('신원: 같은 원본·같은 구간은 같은 참조 ID, 구간이 다르면 다른 ID', async () => {
  const h = harness()
  const a = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  const b = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  const c = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 500, regionDurationMs: 1000 })
  assert.ok(a.ok && b.ok && c.ok)
  if (!(a.ok && b.ok && c.ok)) return
  assert.equal(a.referenceId, b.referenceId, '같은 원본·구간 → 같은 ID')
  assert.notEqual(a.referenceId, c.referenceId, '구간이 다르면 다른 ID')
})

test('신원: 이름·크기가 같아도 내용이 다르면 다른 source SHA 다', async () => {
  const h1 = harness()
  const h2 = harness()
  writeFileSync(h2.sourcePath, pcmWav(48000, 9))   // 같은 길이, 다른 내용
  const a = await importReference(h1.deps, { filePath: h1.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  const b = await importReference(h2.deps, { filePath: h2.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  assert.ok(a.ok && b.ok)
  if (!(a.ok && b.ok)) return
  assert.equal(statSync(h1.sourcePath).size, statSync(h2.sourcePath).size)
  assert.notEqual(a.sourceSha256, b.sourceSha256)
  assert.notEqual(a.referenceId, b.referenceId)
})

// ── 입력 거부 ───────────────────────────────────────────────────────────────

test('거부: 빈 경로·허용 밖 확장자·일반 파일이 아닌 대상', async () => {
  const h = harness()
  for (const bad of ['', '   ']) {
    assert.deepEqual(await importReference(h.deps, { filePath: bad }), { ok: false, reason: 'INVALID_SOURCE' })
  }
  const txt = h.sourcePath.replace(/\.wav$/, '.txt')
  writeFileSync(txt, 'not audio')
  assert.deepEqual(await importReference(h.deps, { filePath: txt }), { ok: false, reason: 'INVALID_SOURCE' })

  const dir = mkdtempSync(join(tmpdir(), 'afdir-'))
  const dirAsWav = join(dir, 'x.wav')
  mkdirSync(dirAsWav)
  assert.deepEqual(await importReference(h.deps, { filePath: dirAsWav }), { ok: false, reason: 'INVALID_SOURCE' })
  assert.deepEqual(h.calls, [], '거부된 입력으로는 파이썬을 부르지 않는다')
})

test('거부: 원본 해시를 못 구하면 SOURCE_UNREADABLE', async () => {
  const h = harness()
  h.deps.sha256OfFile = () => null
  assert.deepEqual(await importReference(h.deps, { filePath: h.sourcePath }), { ok: false, reason: 'SOURCE_UNREADABLE' })
  assert.deepEqual(h.calls, [])
})

// ── 파이썬 단계 실패 ────────────────────────────────────────────────────────

test('실패: analyze 실패는 trim 으로 넘어가지 않는다', async () => {
  const h = harness()
  h.setAnalyze({ status: 'failed', error_message: 'C:/secret/path.wav 를 열 수 없음' })
  const res = await importReference(h.deps, { filePath: h.sourcePath })
  assert.deepEqual(res, { ok: false, reason: 'ANALYZE_FAILED' })
  assert.deepEqual(h.calls, ['analyze:true'], 'trim 은 부르지 않는다')
  assert.ok(!JSON.stringify(res).includes('secret'), 'python 오류 원문이 새지 않는다')
})

test('실패: 참조로 쓸 수 없는 원본은 자르지 않는다', async () => {
  const h = harness()
  h.setAnalyze({ status: 'ok', duration_sec: 0.5, valid_whole: false, too_short: true })
  assert.deepEqual(await importReference(h.deps, { filePath: h.sourcePath }), { ok: false, reason: 'SOURCE_NOT_SUITABLE' })
  assert.deepEqual(h.calls, ['analyze:true'])
})

test('실패: trim 실패·산출물 없음·빈 산출물', async () => {
  for (const setup of ['failed', 'missing', 'empty'] as const) {
    const h = harness()
    if (setup === 'failed') h.setTrim({ status: 'failed' })
    if (setup === 'missing') h.setTrimOutput(null)
    if (setup === 'empty') h.setTrimOutput(new Uint8Array(0))
    const res = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
    assert.deepEqual(res, { ok: false, reason: 'TRIM_FAILED' }, setup)
    assert.ok(!existsSync(join(h.root, MANIFEST_FILE_NAME)), `${setup}: manifest 를 만들지 않는다`)
  }
})

// ── 클립 검증 실패 ──────────────────────────────────────────────────────────

test('실패: 규격 밖 클립은 CLIP_INVALID 로 사유까지 알린다', async () => {
  const h = harness()
  h.setTrimOutput(stereo48kWav(4800))     // mono/24k 가 아니다
  const res = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.reason, 'PROMOTE_FAILED', '규격 불일치는 검증 단계에서 걸린다')
  assert.equal(res.failedStep, 'VERIFY_STAGING_CLIP')
  assert.ok(!existsSync(join(h.root, MANIFEST_FILE_NAME)))
})

test('실패: 깨진 컨테이너는 wavCode 와 함께 거부된다', async () => {
  const h = harness()
  h.setTrimOutput(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
  const res = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.reason, 'CLIP_INVALID')
  assert.equal(res.wavCode, 'INVALID_WAV_CONTAINER')
})

// ── manifest 손상 ───────────────────────────────────────────────────────────

test('손상 manifest: 파이썬을 부르기도 전에 막는다', async () => {
  const h = harness()
  await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  writeFileSync(join(h.root, MANIFEST_FILE_NAME), 'broken{', 'utf-8')
  h.calls.length = 0

  const res = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 500, regionDurationMs: 1000 })
  assert.deepEqual(res, { ok: false, reason: 'MANIFEST_CORRUPT' })
  assert.deepEqual(h.calls, [], '손상 상태에서는 분석조차 시작하지 않는다')
  assert.equal(readFileSync(join(h.root, MANIFEST_FILE_NAME), 'utf-8'), 'broken{', '손상 파일을 덮지 않는다')
})

// ── 실패 후 불변 ────────────────────────────────────────────────────────────

test('실패 후 불변: durable 클립 목록과 manifest 가 그대로다', async () => {
  const h = harness()
  const good = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 0, regionDurationMs: 1000 })
  assert.ok(good.ok)
  const manifestBefore = readFileSync(join(h.root, MANIFEST_FILE_NAME), 'utf-8')
  const wavsBefore = readdirSync(h.root).filter((n) => n.endsWith('.wav')).sort()

  h.setTrimOutput(new Uint8Array([0, 1, 2]))
  const bad = await importReference(h.deps, { filePath: h.sourcePath, regionStartMs: 1000, regionDurationMs: 1000 })
  assert.equal(bad.ok, false)

  assert.equal(readFileSync(join(h.root, MANIFEST_FILE_NAME), 'utf-8'), manifestBefore)
  assert.deepEqual(readdirSync(h.root).filter((n) => n.endsWith('.wav')).sort(), wavsBefore)
})
