// 참조 등록(import) 오케스트레이션 — 사용자 원본에서 영속 자산까지의 순서를 여기서 고정한다.
//
// 순서: 원본 검증 → source SHA-256 → ref-analyze → 구간 확정 → ref-trim → staged WAV 검증
//       → clip SHA-256 → durable promote → manifest 원자적 교체
// 어느 단계에서 실패하든 durable clips 와 manifest 는 그대로다(승격은 계약이 순서를 강제한다).
//
// 원본 파일은 읽기만 한다. 삭제·이동·수정하지 않는다.
// 절대 경로·Python stderr·미디어 내용은 결과에 담지 않는다 — 호출부(IPC)가 그대로 renderer 에
// 넘겨도 새어 나갈 것이 없어야 한다.
//
// ⚠️ 값 import 를 하지 않는다(타입만). node --test 가 이 파일을 직접 로드하기 때문이다.
//    계약 함수·러너·파일 접근은 전부 주입받는다.
import type { ReferenceLibraryEntry } from '../../shared/referenceLibrary'
import type { WavValidationCode } from '../../shared/wavContainer'
import type { ImportClipResult, ReferenceStore } from './reference-store'

/** ref-analyze / ref-trim 이 돌려주는 최소 표면(preview-transcribe 의 PreviewResult 호환). */
export interface PythonPreviewResult {
  status?: string
  error_message?: string
  [key: string]: unknown
}

export interface ReferenceImportDeps {
  store: ReferenceStore
  /** separate.py ref-analyze. 원본을 읽기만 한다. */
  runAnalyze: (filePath: string) => Promise<PythonPreviewResult>
  /** separate.py ref-trim → outDir/reference_clip_24k.wav */
  runTrim: (filePath: string, startSec: number, durationSec: number, outDir: string) => Promise<PythonPreviewResult>
  /** 원본 파일이 읽을 수 있는 '일반 파일'인가(링크·디렉터리·부재는 false). */
  isReadableFile: (filePath: string) => boolean
  /** 원본 내용 SHA-256(스트리밍). 실패 시 null. */
  sha256OfFile: (filePath: string) => string | null
  readFileBytes: (filePath: string) => Uint8Array
  makeTempDir: () => string
  removeTempDir: (dir: string) => void
  joinPath: (...parts: string[]) => string
  buildLibraryEntry: (input: {
    sourceSha256: string
    region: { start: number; duration: number }
    transcript: string
  }) => ReferenceLibraryEntry
  makeRunId: () => string
  /** 허용 확장자(소문자, 점 포함). 미지정이면 기본 목록을 쓴다. */
  allowedExtensions?: readonly string[]
}

export interface ReferenceImportRequest {
  /** 사용자가 고른 원본. **이 값이 들어오는 유일한 지점이다.** */
  filePath: string
  /** 확정 구간. 미지정이면 분석이 권한 구간, 그것도 없으면 앞에서부터 기본 길이. */
  regionStartMs?: number
  regionDurationMs?: number
  /** 참조 전사문. 지문 입력이므로 비어 있어도 결정적으로 처리된다. */
  transcript?: string
  /** 전사 언어(사용자가 고른 프롬프트 언어). 모르면 빈 문자열 — 임의 기본값으로 바꾸지 않는다. */
  transcriptLanguage?: string
}

export type ReferenceImportFailure =
  | 'INVALID_SOURCE'        // 경로가 비었거나 일반 파일이 아니거나 허용 확장자가 아님
  | 'SOURCE_UNREADABLE'     // 읽기/해시 실패(취소·권한·삭제 등)
  | 'ANALYZE_FAILED'        // ref-analyze 가 실패로 마감
  | 'SOURCE_NOT_SUITABLE'   // 분석은 됐으나 참조로 쓸 수 없는 오디오
  | 'TRIM_FAILED'           // ref-trim 이 실패했거나 산출물이 없음
  | 'CLIP_INVALID'          // staged WAV 가 규격을 벗어남
  | 'MANIFEST_CORRUPT'      // manifest 가 손상돼 쓰기를 막았음
  | 'PROMOTE_FAILED'        // 승격 중 실패(파일·manifest 는 불변)
  | 'TRANSCRIPT_REJECTED'   // 전사 sidecar 충돌·손상(기존 전사를 덮지 않았다)

export type ReferenceImportOutcome =
  | {
      ok: true
      referenceId: string
      contentSha256: string
      sourceSha256: string
      regionStartMs: number
      regionDurationMs: number
    }
  | {
      ok: false
      reason: ReferenceImportFailure
      /** CLIP_INVALID 일 때만. 어느 규격에서 걸렸는지. */
      wavCode?: WavValidationCode
      /** PROMOTE_FAILED 일 때만. 계약이 알려준 실패 단계. */
      failedStep?: ImportClipResult['failedStep']
      /** TRANSCRIPT_REJECTED 일 때만. 전사 원문은 담지 않는다. */
      transcriptCode?: ImportClipResult['transcriptCode']
    }

const DEFAULT_EXTENSIONS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus'] as const
/** 구간을 못 정했을 때의 기본 길이(초). 계약의 MIN/MAX 사이 값. */
const FALLBACK_REGION_SEC = 5
const TRIM_OUTPUT_NAME = 'reference_clip_24k.wav'

function lowerExt(filePath: string): string {
  const at = filePath.lastIndexOf('.')
  return at < 0 ? '' : filePath.slice(at).toLowerCase()
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function failed(result: PythonPreviewResult | null | undefined): boolean {
  return !result || result.status === 'failed' || result.status === 'error'
}

/**
 * 분석 결과에서 확정 구간(초)을 정한다. 요청이 있으면 그것을 쓰고, 없으면 분석이 권한 구간,
 * 그것도 없으면 앞에서부터 기본 길이 — 어느 경우에도 원본 길이를 넘지 않는다.
 */
function decideRegion(
  request: ReferenceImportRequest,
  analyze: PythonPreviewResult,
): { start: number; duration: number } {
  const totalSec = num(analyze.duration_sec) ?? 0
  const reqStart = num(request.regionStartMs)
  const reqDur = num(request.regionDurationMs)
  if (reqStart !== null && reqDur !== null && reqDur > 0) {
    const start = Math.max(0, reqStart / 1000)
    const duration = Math.max(0, reqDur / 1000)
    return totalSec > 0
      ? { start: Math.min(start, totalSec), duration: Math.min(duration, Math.max(0, totalSec - start)) }
      : { start, duration }
  }
  const rec = analyze.recommend as { start?: unknown; duration?: unknown } | undefined
  const recStart = num(rec?.start)
  const recDur = num(rec?.duration)
  if (recStart !== null && recDur !== null && recDur > 0) return { start: recStart, duration: recDur }

  const duration = totalSec > 0 ? Math.min(FALLBACK_REGION_SEC, totalSec) : FALLBACK_REGION_SEC
  return { start: 0, duration }
}

/**
 * 원본 하나를 영속 참조 자산으로 등록한다. 성공하면 논리 메타데이터만 돌려준다.
 * 실패는 예외가 아니라 구조화된 사유로 나온다(조용한 성공 금지).
 */
export async function importReference(
  deps: ReferenceImportDeps,
  request: ReferenceImportRequest,
): Promise<ReferenceImportOutcome> {
  const filePath = String(request?.filePath ?? '').trim()
  if (!filePath) return { ok: false, reason: 'INVALID_SOURCE' }

  const allowed = deps.allowedExtensions ?? DEFAULT_EXTENSIONS
  if (!allowed.includes(lowerExt(filePath))) return { ok: false, reason: 'INVALID_SOURCE' }
  if (!deps.isReadableFile(filePath)) return { ok: false, reason: 'INVALID_SOURCE' }

  // manifest 가 손상됐다면 아무것도 시작하지 않는다 — 파이썬을 돌려 봐야 어차피 쓸 수 없다.
  if (deps.store.loadManifest().status === 'corrupt') return { ok: false, reason: 'MANIFEST_CORRUPT' }

  const sourceSha256 = deps.sha256OfFile(filePath)
  if (!sourceSha256) return { ok: false, reason: 'SOURCE_UNREADABLE' }

  const analyze = await deps.runAnalyze(filePath)
  if (failed(analyze)) return { ok: false, reason: 'ANALYZE_FAILED' }
  // 분석이 '이 파일은 참조로 쓸 수 없다'고 말하면 구간을 자를 이유가 없다.
  if (analyze.valid_whole === false && analyze.needs_region !== true) {
    return { ok: false, reason: 'SOURCE_NOT_SUITABLE' }
  }
  if (analyze.too_short === true) return { ok: false, reason: 'SOURCE_NOT_SUITABLE' }

  const region = decideRegion(request, analyze)
  if (!(region.duration > 0)) return { ok: false, reason: 'SOURCE_NOT_SUITABLE' }

  const tempDir = deps.makeTempDir()
  try {
    const trim = await deps.runTrim(filePath, region.start, region.duration, tempDir)
    if (failed(trim)) return { ok: false, reason: 'TRIM_FAILED' }

    // 파이썬이 알려준 산출물 경로가 있어도 이름 규약으로 다시 만든다(경로를 그대로 신뢰하지 않는다).
    const stagedPath = deps.joinPath(tempDir, TRIM_OUTPUT_NAME)
    let clipBytes: Uint8Array
    try {
      clipBytes = deps.readFileBytes(stagedPath)
    } catch {
      return { ok: false, reason: 'TRIM_FAILED' }
    }
    if (clipBytes.byteLength === 0) return { ok: false, reason: 'TRIM_FAILED' }

    const entry = deps.buildLibraryEntry({
      sourceSha256,
      region,
      transcript: String(request.transcript ?? ''),
    })

    const promoted = deps.store.importClip({
      runId: deps.makeRunId(),
      entry,
      clipBytes,
      // 규격 기대치는 ref-trim 계약이 보장하는 값(mono·24kHz)만 건다. 길이는 트리밍 반올림이
      // 있을 수 있어 걸지 않는다 — 대신 컨테이너 검증이 프레임 정합성을 본다.
      expected: { sample_rate: 24000, channel_count: 1 },
      // 확정 전사가 있을 때만 sidecar 를 만든다. 빈 전사를 가짜로 저장하지 않는다.
      transcript: String(request.transcript ?? '').trim() === ''
        ? null
        : { text: String(request.transcript), language: String(request.transcriptLanguage ?? '') },
    })

    if (promoted.status !== 'REFERENCE_PROMOTED' || !promoted.record) {
      if (promoted.transcriptCode) {
        return { ok: false, reason: 'TRANSCRIPT_REJECTED', transcriptCode: promoted.transcriptCode }
      }
      if (promoted.wavCode) return { ok: false, reason: 'CLIP_INVALID', wavCode: promoted.wavCode }
      if (promoted.errorCode === 'INVALID_FINGERPRINT_INPUT' && promoted.steps.length === 0) {
        return { ok: false, reason: 'MANIFEST_CORRUPT' }
      }
      return { ok: false, reason: 'PROMOTE_FAILED', failedStep: promoted.failedStep }
    }

    return {
      ok: true,
      referenceId: promoted.record.clip_id,
      contentSha256: promoted.record.clip_sha256,
      sourceSha256: promoted.record.source_sha256,
      regionStartMs: promoted.record.region_start_ms,
      regionDurationMs: promoted.record.region_duration_ms,
    }
  } finally {
    // 파생 임시물은 성공·실패와 무관하게 정리한다. 원본은 건드리지 않는다.
    deps.removeTempDir(tempDir)
  }
}
