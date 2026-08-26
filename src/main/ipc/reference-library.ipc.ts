// 참조 라이브러리 IPC — 논리 ID 만 오가는 얇은 계층.
//
// 이 파일은 규칙을 갖지 않는다. 저장소 규칙은 reference-store 가, 등록 순서는 reference-import 가,
// 승격·manifest 계약은 shared/referenceLibrary 가 갖는다. 여기서는 요청을 검증해 넘기고
// 응답에서 경로를 걷어내는 일만 한다.
//
// 의존은 전부 주입받는다(audio.ipc 를 import 하지 않는다 — 순환 의존을 만들지 않기 위해서다).
// 파이썬 실행기는 audio.ipc 가 자기 pythonPath·runPreview 로 만든 adapter 를 넘겨 준다.
import { ipcMain } from 'electron'
import { importReference, type PythonPreviewResult } from '../services/reference-import'
import type { ReferenceStore } from '../services/reference-store'
import type { ReferenceLibraryEntry } from '../../shared/referenceLibrary'
import {
  REFERENCE_LIBRARY_CHANNELS, referenceDisplayName,
  type ReferenceLibraryImportRequest, type ReferenceLibraryImportResponse,
  type ReferenceLibraryItem, type ReferenceLibraryListResponse,
  type ReferenceLibraryRemoveResponse, type ReferenceLibrarySelectResponse,
} from '../../shared/referenceLibraryApi'

/** audio.ipc 가 넘겨주는 파이썬 실행 adapter — 기존 runPreview 의미를 그대로 쓴다. */
export interface ReferencePreviewAdapter {
  runAnalyze: (filePath: string) => Promise<PythonPreviewResult>
  runTrim: (filePath: string, startSec: number, durationSec: number, outDir: string) => Promise<PythonPreviewResult>
  /** 합성·전사 등이 돌고 있어 지금 파이썬을 쓸 수 없으면 사유 문자열, 가능하면 null. */
  busyReason: () => string | null
}

export interface ReferenceLibraryIpcDeps {
  store: ReferenceStore
  preview: ReferencePreviewAdapter
  /** 선택 상태는 논리 ID 로만 저장한다(경로 저장 금지). */
  readSelectedId: () => string | null
  writeSelectedId: (referenceId: string | null) => void
  isReadableFile: (filePath: string) => boolean
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
}

const CLIP_ID_RE = /^[0-9a-f]{16}$/

function normalizeId(raw: unknown): string | null {
  const v = String(raw ?? '').trim().toLowerCase()
  return CLIP_ID_RE.test(v) ? v : null
}

export function registerReferenceLibraryIpc(deps: ReferenceLibraryIpcDeps): void {
  /** 목록을 만든다. 무결성까지 확인해 ready 를 정하고, 표시명은 결정적 순서로 붙인다. */
  const buildList = (): ReferenceLibraryListResponse => {
    const loaded = deps.store.loadManifest()
    if (loaded.status === 'corrupt') return { status: 'corrupt', items: [] }

    const selected = deps.readSelectedId()
    // 결정적 순서 — manifest 기록 순서에 기대지 않는다.
    const records = [...deps.store.listRecords()].sort((a, b) => a.referenceId.localeCompare(b.referenceId))
    const items: ReferenceLibraryItem[] = records.map((r, index) => {
      const resolved = deps.store.resolveClipFile(r.referenceId)
      return {
        referenceId: r.referenceId,
        contentSha256: r.contentSha256,
        sourceSha256: r.sourceSha256,
        regionStartMs: r.regionStartMs,
        regionDurationMs: r.regionDurationMs,
        analysisVersion: r.analysisVersion,
        ready: resolved.ok,                       // 파일 존재 + 해시 일치까지 통과해야 ready
        missing: !r.present,
        selected: selected === r.referenceId,
        transcript: r.transcript,
        displayName: referenceDisplayName(index),
      }
    })
    return { status: 'ok', items }
  }

  ipcMain.handle(REFERENCE_LIBRARY_CHANNELS.list, (): ReferenceLibraryListResponse => buildList())

  ipcMain.handle(
    REFERENCE_LIBRARY_CHANNELS.import,
    async (_event, request: ReferenceLibraryImportRequest): Promise<ReferenceLibraryImportResponse> => {
      const busy = deps.preview.busyReason()
      if (busy) return { ok: false, reason: 'BUSY', detail: busy }

      const outcome = await importReference(
        {
          store: deps.store,
          runAnalyze: deps.preview.runAnalyze,
          runTrim: deps.preview.runTrim,
          isReadableFile: deps.isReadableFile,
          sha256OfFile: deps.sha256OfFile,
          readFileBytes: deps.readFileBytes,
          makeTempDir: deps.makeTempDir,
          removeTempDir: deps.removeTempDir,
          joinPath: deps.joinPath,
          buildLibraryEntry: deps.buildLibraryEntry,
          makeRunId: deps.makeRunId,
        },
        {
          filePath: String(request?.filePath ?? ''),
          regionStartMs: request?.regionStartMs,
          regionDurationMs: request?.regionDurationMs,
          transcript: request?.transcript,
          transcriptLanguage: request?.transcriptLanguage,
        },
      )

      if (!outcome.ok) {
        // 사유 코드만 내보낸다 — 경로·python stderr 는 여기까지 오지도 않는다.
        return { ok: false, reason: outcome.reason, detail: outcome.wavCode ?? outcome.failedStep }
      }
      return { ok: true, referenceId: outcome.referenceId }
    },
  )

  ipcMain.handle(
    REFERENCE_LIBRARY_CHANNELS.select,
    (_event, referenceId: unknown): ReferenceLibrarySelectResponse => {
      if (referenceId === null) {                 // 선택 해제는 허용
        deps.writeSelectedId(null)
        return { ok: true, referenceId: null }
      }
      const id = normalizeId(referenceId)
      if (!id) return { ok: false, reason: 'INVALID_ID' }

      const loaded = deps.store.loadManifest()
      if (loaded.status === 'corrupt') return { ok: false, reason: 'MANIFEST_CORRUPT' }

      // 존재와 무결성을 main 이 다시 확인한다 — 목록이 낡았을 수 있다.
      const resolved = deps.store.resolveClipFile(id)
      if (!resolved.ok) {
        // 못 쓰는 참조를 조용히 다른 것으로 바꾸지 않는다. 사유를 알리고 선택은 그대로 둔다.
        return { ok: false, reason: resolved.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'NOT_READY' }
      }
      deps.writeSelectedId(id)
      return { ok: true, referenceId: id }
    },
  )

  ipcMain.handle(
    REFERENCE_LIBRARY_CHANNELS.remove,
    (_event, referenceId: unknown): ReferenceLibraryRemoveResponse => {
      const id = normalizeId(referenceId)
      if (!id) return { ok: false, reason: 'INVALID_ID' }

      // 사용 중이면 막는다. 지금 '사용 중'의 근거는 선택 상태 하나뿐이며,
      // 없는 관계(sampler 캐시·감정 매핑)를 있는 척 만들지 않는다. 관계가 생기면 여기에 더한다.
      const usedBy = deps.readSelectedId() === id ? 1 : 0
      if (usedBy > 0) return { ok: false, reason: 'REFERENCE_IN_USE', usedBy }

      const res = deps.store.removeClip(id)
      if (!res.ok) return { ok: false, reason: res.reason }
      return { ok: true }
    },
  )
}

/**
 * main 내부 전용 해석기 — sampler 생성 경로가 referenceId 로 실제 파일과 내용 해시를 얻는다.
 * preload 로 내보내지 않는다(renderer 는 경로를 볼 수 없어야 한다).
 */
export function createSamplerReferenceResolver(store: ReferenceStore, readSelectedId: () => string | null) {
  return {
    resolveSelected(): { ok: true; filePath: string; contentSha256: string } | { ok: false; reason: string } {
      const id = readSelectedId()
      if (!id) return { ok: false, reason: 'NO_REFERENCE_SELECTED' }
      const resolved = store.resolveClipFile(id)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      return { ok: true, filePath: resolved.filePath, contentSha256: resolved.clipSha256 }
    },
  }
}
