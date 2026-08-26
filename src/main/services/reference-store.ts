// 참조 라이브러리 영속 저장소 — 계약(shared/referenceLibrary)이 정한 규칙을 실제 파일시스템에 옮긴다.
//
// 이 파일이 하는 일은 '효과(effects)' 뿐이다. 승격 순서·manifest 스키마·고아 판정 같은 규칙은
// 전부 계약이 갖고 있고 여기서 다시 쓰지 않는다. 규칙을 두 벌 두면 반드시 어긋난다.
//
// ⚠️ 값 import 를 하지 않는다(타입만 가져온다). 이 파일은 Electron 없이 node --test 가 직접
//    로드하는데, 프로젝트 모듈을 확장자 없는 specifier 로 런타임 import 하면 그 로드가 깨진다.
//    python-runner.ts 가 이미 같은 이유로 run-settlement 를 type-only 로만 가져온다.
//    계약 함수는 소유자(ipc 계층)가 넣어 준다. node: 내장 모듈은 확장자 문제가 없어 직접 쓴다.
//
// 레이아웃은 계약이 정한 그대로다(새 이름을 만들지 않는다):
//   <root>/manifest.json                      manifest(원자적 교체 대상)
//   <root>/<clipId>.wav                       영속 자산
//   <root>/staging/run-<runId>/               이 실행 전용 staging(같은 볼륨)
//   <root>/staging/run-<runId>.journal.json   이 run 이 만든 clipId 목록
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  ClipVerificationExpectation, ClipVerificationResult, PromotionEffects, PromotionRequest,
  PromotionResult, ReferenceLibraryEntry, ReferenceManifest, ReferenceManifestRecord,
} from '../../shared/referenceLibrary'
import type { WavFormatFacts, WavInspection, WavValidationCode } from '../../shared/wavContainer'

/** 계약에서 주입받는 순수 함수들. 이 목록 밖의 규칙을 이 파일이 새로 만들지 않는다. */
export interface ReferenceStoreContract {
  emptyManifest: () => ReferenceManifest
  assertManifestValid: (manifest: ReferenceManifest) => ReferenceManifest
  promoteReferenceClip: (effects: PromotionEffects, request: PromotionRequest) => PromotionResult
  removeManifestRecord: (
    manifest: ReferenceManifest, clipId: string,
  ) => { manifest: ReferenceManifest; plan: { clipId: string; fileNames: string[] } }
  findManifestRecordByClipId: (m: ReferenceManifest, clipId: string) => ReferenceManifestRecord | null
  verifyStoredClip: (record: ReferenceManifestRecord, actualClipSha256: string) => ReferenceManifestRecord
  clipFileName: (clipId: string) => string
  runScopedStagingDirName: (runId: string) => string
  runJournalFileName: (runId: string) => string
  manifestTempFileName: (runId: string) => string
  manifestFileName: string
  stagingDirName: string
  inspectWavContainer: (bytes: Uint8Array) => WavInspection
  wavSamplesAreFinite: (facts: WavFormatFacts) => boolean
}

export type ManifestLoadStatus = 'ok' | 'missing' | 'corrupt'

export interface ManifestLoad {
  status: ManifestLoadStatus
  manifest: ReferenceManifest
  /** corrupt 일 때만 채운다. 진단 코드이며 경로·원문을 담지 않는다. */
  code?: 'MANIFEST_UNREADABLE' | 'MANIFEST_NOT_JSON' | 'MANIFEST_INVALID'
}

export interface ImportClipRequest {
  runId: string
  /** 계약으로 만든 라이브러리 항목(지문·해시 포함). 이 파일은 내용을 해석하지 않는다. */
  entry: ReferenceLibraryEntry
  /** staging 에 기록할 클립 바이트(ref-trim 결과물의 내용). */
  clipBytes: Uint8Array
  expected?: ClipVerificationExpectation
  clipId?: string
}

export interface ImportClipResult {
  status: PromotionResult['status']
  steps: PromotionResult['steps']
  record: ReferenceManifestRecord | null
  failedStep?: PromotionResult['failedStep']
  errorCode?: PromotionResult['errorCode']
  /** 검증 단계에서 걸렸을 때의 사유. 경로·바이트를 담지 않는다. */
  wavCode?: WavValidationCode
}

export type RemoveReason =
  | 'INVALID_ID' | 'NOT_FOUND' | 'NOT_OWNED' | 'MANIFEST_CORRUPT' | 'DELETE_FAILED'

export type RemoveResult = { ok: true } | { ok: false; reason: RemoveReason }

export type ResolveResult =
  | { ok: true; filePath: string; clipSha256: string }
  | { ok: false; reason: 'INVALID_ID' | 'NOT_FOUND' | 'NOT_OWNED' | 'CHECKSUM_MISMATCH' | 'MANIFEST_CORRUPT' }

/** renderer 로 나가도 되는 논리 메타데이터. 경로는 없다. */
export interface ReferenceRecordView {
  referenceId: string
  contentSha256: string
  sourceSha256: string
  regionStartMs: number
  regionDurationMs: number
  analysisVersion: number
  /** 파일이 실제로 남아 있는가(재시작 후 누락 감지). */
  present: boolean
}

export interface ReferenceStore {
  readonly rootDir: string
  loadManifest(): ManifestLoad
  listRecords(): ReferenceRecordView[]
  importClip(request: ImportClipRequest): ImportClipResult
  removeClip(clipId: string): RemoveResult
  /** main 내부 전용 — 절대 경로를 돌려주므로 preload 로 내보내지 않는다. */
  resolveClipFile(clipId: string): ResolveResult
  /** 이 run 이 남긴 staging·journal·manifest temp 를 정리한다. */
  sweepRunScoped(runId: string): number
}

const CLIP_ID_RE = /^[0-9a-f]{16}$/

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 디렉터리 fsync 까지는 하지 않되, 파일 내용은 교체 전에 디스크로 밀어 둔다. */
function writeFileDurable(path: string, data: string | Uint8Array): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, data as never)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * path 가 root 의 '직접 자식'인 실제 일반 파일인가.
 * 심볼릭 링크·junction·reparse 는 realpath 가 root 밖을 가리킬 수 있으므로 lstat 으로 먼저 거른다.
 */
function isOwnedRegularFile(root: string, path: string): boolean {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return false
    const realRoot = realpathSync(root)
    const real = realpathSync(path)
    return dirname(real) === realRoot
  } catch {
    return false
  }
}

export function createReferenceStore(
  contract: ReferenceStoreContract,
  rootDir: string,
): ReferenceStore {
  const root = resolve(rootDir)
  const manifestPath = (): string => join(root, contract.manifestFileName)
  const stagingRoot = (): string => join(root, contract.stagingDirName)

  // 디렉터리는 앱 시작이 아니라 실제로 쓸 때만 만든다(빈 폴더를 미리 만들지 않는다).
  const ensureRoot = (): void => { mkdirSync(root, { recursive: true }) }

  const load = (): ManifestLoad => {
    const p = manifestPath()
    if (!existsSync(p)) return { status: 'missing', manifest: contract.emptyManifest() }
    let raw: string
    try {
      raw = readFileSync(p, 'utf-8')
    } catch {
      return { status: 'corrupt', manifest: contract.emptyManifest(), code: 'MANIFEST_UNREADABLE' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'corrupt', manifest: contract.emptyManifest(), code: 'MANIFEST_NOT_JSON' }
    }
    try {
      // 계약이 스키마·경로 혼입까지 검사한다. 실패를 빈 manifest 로 덮지 않는다.
      return { status: 'ok', manifest: contract.assertManifestValid(parsed as ReferenceManifest) }
    } catch {
      return { status: 'corrupt', manifest: contract.emptyManifest(), code: 'MANIFEST_INVALID' }
    }
  }

  return {
    rootDir: root,

    loadManifest: load,

    listRecords(): ReferenceRecordView[] {
      const loaded = load()
      if (loaded.status === 'corrupt') return []
      return loaded.manifest.records.map((r) => ({
        referenceId: r.clip_id,
        contentSha256: r.clip_sha256,
        sourceSha256: r.source_sha256,
        regionStartMs: r.region_start_ms,
        regionDurationMs: r.region_duration_ms,
        analysisVersion: r.analysis_version,
        present: isOwnedRegularFile(root, join(root, contract.clipFileName(r.clip_id))),
      }))
    },

    importClip(request: ImportClipRequest): ImportClipResult {
      const loaded = load()
      if (loaded.status === 'corrupt') {
        // 손상 manifest 위에 새 레코드를 얹지 않는다 — 덮어쓰면 기존 기록이 사라진다.
        return {
          status: 'REFERENCE_PROMOTE_FAILED',
          steps: [],
          record: null,
          errorCode: 'INVALID_FINGERPRINT_INPUT',
        }
      }
      ensureRoot()

      let wavCode: WavValidationCode | undefined

      const effects: PromotionEffects = {
        createStagingDir: (runId) => {
          const dir = join(stagingRoot(), contract.runScopedStagingDirName(runId))
          mkdirSync(dir, { recursive: true })
          return dir
        },
        writeStagingClip: (stagingDir, fileName) => {
          const staged = join(stagingDir, fileName)
          writeFileDurable(staged, request.clipBytes)
          return staged
        },
        verifyStagingClip: (stagedPath): ClipVerificationResult => {
          let bytes: Uint8Array
          try {
            bytes = readFileSync(stagedPath)
          } catch {
            wavCode = 'INVALID_WAV_CONTAINER'
            return { decodable: false, all_samples_finite: false, sample_rate: 0, channel_count: 0, duration_ms: 0, clip_sha256: '' }
          }
          const seen = contract.inspectWavContainer(bytes)
          if (!seen.ok) {
            wavCode = seen.code
            return { decodable: false, all_samples_finite: false, sample_rate: 0, channel_count: 0, duration_ms: 0, clip_sha256: '' }
          }
          return {
            decodable: true,
            all_samples_finite: contract.wavSamplesAreFinite(seen.facts),
            sample_rate: seen.facts.sampleRate,
            channel_count: seen.facts.channelCount,
            duration_ms: seen.facts.durationMs,
            clip_sha256: sha256OfBytes(bytes),
          }
        },
        promoteClip: (stagedPath, durableFileName) => {
          const durable = join(root, durableFileName)
          renameSync(stagedPath, durable)   // 같은 볼륨 — 원자적
          return durable
        },
        writeManifestTemp: (manifest, tempName) => {
          const temp = join(root, tempName)   // final 과 같은 디렉터리여야 교체가 원자적이다
          writeFileDurable(temp, JSON.stringify(manifest, null, 2))
          return temp
        },
        replaceManifest: (tempPath) => {
          renameSync(tempPath, manifestPath())
        },
      }

      const result = contract.promoteReferenceClip(effects, {
        runId: request.runId,
        entry: request.entry,
        durableDir: root,
        manifest: loaded.manifest,
        expected: request.expected,
        clipId: request.clipId,
      })

      return {
        status: result.status,
        steps: result.steps,
        record: result.record,
        failedStep: result.failedStep,
        errorCode: result.errorCode,
        wavCode,
      }
    },

    removeClip(clipId: string): RemoveResult {
      const id = String(clipId ?? '').trim().toLowerCase()
      if (!CLIP_ID_RE.test(id)) return { ok: false, reason: 'INVALID_ID' }   // 검사 전 파일 접근 금지

      const loaded = load()
      if (loaded.status === 'corrupt') return { ok: false, reason: 'MANIFEST_CORRUPT' }
      if (!contract.findManifestRecordByClipId(loaded.manifest, id)) return { ok: false, reason: 'NOT_FOUND' }

      const target = join(root, contract.clipFileName(id))
      // 파일이 남아 있다면 우리 것이어야 한다. 링크·다른 위치는 손대지 않는다.
      const present = existsSync(target)
      if (present && !isOwnedRegularFile(root, target)) return { ok: false, reason: 'NOT_OWNED' }

      let next: ReferenceManifest
      try {
        next = contract.removeManifestRecord(loaded.manifest, id).manifest
      } catch {
        return { ok: false, reason: 'NOT_FOUND' }
      }

      // manifest 를 먼저 정합하게 만든다. 파일 삭제가 실패해도 매달린 레코드는 남지 않는다.
      try {
        const temp = join(root, `${contract.manifestFileName}.remove.tmp`)
        writeFileDurable(temp, JSON.stringify(next, null, 2))
        renameSync(temp, manifestPath())
      } catch {
        return { ok: false, reason: 'DELETE_FAILED' }
      }
      if (present) {
        try {
          unlinkSync(target)
        } catch {
          return { ok: false, reason: 'DELETE_FAILED' }
        }
      }
      return { ok: true }
    },

    resolveClipFile(clipId: string): ResolveResult {
      const id = String(clipId ?? '').trim().toLowerCase()
      if (!CLIP_ID_RE.test(id)) return { ok: false, reason: 'INVALID_ID' }

      const loaded = load()
      if (loaded.status === 'corrupt') return { ok: false, reason: 'MANIFEST_CORRUPT' }
      const record = contract.findManifestRecordByClipId(loaded.manifest, id)
      if (!record) return { ok: false, reason: 'NOT_FOUND' }

      const filePath = join(root, contract.clipFileName(id))
      if (!isOwnedRegularFile(root, filePath)) return { ok: false, reason: 'NOT_OWNED' }

      let actual: string
      try {
        actual = sha256OfBytes(readFileSync(filePath))
      } catch {
        return { ok: false, reason: 'NOT_FOUND' }
      }
      try {
        contract.verifyStoredClip(record, actual)   // 계약이 불일치를 판정한다
      } catch {
        return { ok: false, reason: 'CHECKSUM_MISMATCH' }
      }
      return { ok: true, filePath, clipSha256: actual }
    },

    sweepRunScoped(runId: string): number {
      let removed = 0
      const dir = stagingRoot()
      const scoped = contract.runScopedStagingDirName(runId)
      const journal = contract.runJournalFileName(runId)
      const temp = contract.manifestTempFileName(runId)

      for (const [base, name] of [[dir, scoped], [dir, journal], [root, temp]] as const) {
        const p = join(base, name)
        try {
          if (!existsSync(p)) continue
          const st = lstatSync(p)
          if (st.isSymbolicLink()) continue          // 링크는 따라가지 않는다
          rmSync(p, { recursive: st.isDirectory(), force: false })
          removed += 1
        } catch {
          // 개별 실패는 무시(사용 중 파일 등). 다른 항목 정리를 막지 않는다.
        }
      }
      // 이 run 이 남긴 것만 지운다 — 다른 run 의 staging 은 건드리지 않는다.
      try {
        if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: false })
      } catch {
        // 비어 있지 않으면 그대로 둔다
      }
      return removed
    },
  }
}
