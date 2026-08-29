// 참조 라이브러리 IPC 계약 — renderer 와 main 이 공유하는 타입·채널 이름만 담는다.
//
// 규칙: 이 파일의 어떤 응답에도 절대 경로가 없다. renderer 는 논리 ID(referenceId)와
// 안전한 표시명만 다루고, 실제 파일 위치는 main 안에서만 해석된다.
// 원본 경로가 오가는 지점은 import 요청 하나뿐이다(사용자가 방금 고른 파일).

export const REFERENCE_LIBRARY_CHANNELS = {
  list: 'reference-library:list',
  import: 'reference-library:import',
  select: 'reference-library:select',
  remove: 'reference-library:remove',
} as const

/** 목록 상태 — 비어 있는 것과 manifest 가 깨진 것은 다른 사건이다. */
export type ReferenceLibraryStatus = 'ok' | 'corrupt'

export interface ReferenceLibraryItem {
  referenceId: string
  contentSha256: string
  sourceSha256: string
  regionStartMs: number
  regionDurationMs: number
  analysisVersion: number
  /** durable 파일이 실제로 있고 내용 해시가 manifest 와 맞는가. false 면 쓸 수 없다. */
  ready: boolean
  /** 파일이 아예 없는 경우(무결성 실패와 구분해 사용자에게 다르게 안내한다). */
  missing: boolean
  selected: boolean
  /** 전사 상태. 원문은 절대 오지 않는다 — 있음/없음/손상만 온다. */
  transcript: 'present' | 'TRANSCRIPT_MISSING' | 'TRANSCRIPT_CORRUPT' | 'TRANSCRIPT_HASH_MISMATCH' | 'TRANSCRIPT_CONFLICT'
  /** 화면에 보여줄 안전한 이름. 원본 파일명이 아니라 앱이 붙인 번호다. */
  displayName: string
}

export interface ReferenceLibraryListResponse {
  status: ReferenceLibraryStatus
  items: ReferenceLibraryItem[]
}

export interface ReferenceLibraryImportRequest {
  /** 사용자가 방금 고른 원본. 경로가 이 계약에 등장하는 유일한 자리다. */
  filePath: string
  regionStartMs?: number
  regionDurationMs?: number
  /** 확정 전사. 비어 있으면 sidecar 를 만들지 않는다(가짜 전사 저장 금지). */
  transcript?: string
  /** 전사 언어. 모르면 비워 둔다 — 임의 기본값으로 바꾸지 않는다. */
  transcriptLanguage?: string
}

export type ReferenceLibraryImportFailure =
  | 'INVALID_SOURCE' | 'SOURCE_UNREADABLE' | 'ANALYZE_FAILED' | 'SOURCE_NOT_SUITABLE'
  | 'TRIM_FAILED' | 'CLIP_INVALID' | 'MANIFEST_CORRUPT' | 'PROMOTE_FAILED' | 'BUSY'
  | 'TRANSCRIPT_REJECTED'

export type ReferenceLibraryImportResponse =
  | { ok: true; referenceId: string }
  | { ok: false; reason: ReferenceLibraryImportFailure; detail?: string }

export type ReferenceLibrarySelectFailure =
  | 'INVALID_ID' | 'NOT_FOUND' | 'NOT_READY' | 'MANIFEST_CORRUPT'

export type ReferenceLibrarySelectResponse =
  | { ok: true; referenceId: string | null }
  | { ok: false; reason: ReferenceLibrarySelectFailure }

export type ReferenceLibraryRemoveFailure =
  | 'INVALID_ID' | 'NOT_FOUND' | 'NOT_OWNED' | 'MANIFEST_CORRUPT' | 'DELETE_FAILED'
  /** 지금 선택돼 있어 지울 수 없다. 조용한 연쇄 삭제 대신 막고 알린다. */
  | 'REFERENCE_IN_USE'

export type ReferenceLibraryRemoveResponse =
  | { ok: true }
  | {
      ok: false
      reason: ReferenceLibraryRemoveFailure
      /** REFERENCE_IN_USE 일 때, 이 참조를 붙잡고 있는 곳의 개수. 경로·이름은 담지 않는다. */
      usedBy?: number
    }

/** 목록의 표시명 — 결정적 순서에 따른 번호. 원본 파일명을 쓰지 않는다. */
export function referenceDisplayName(index: number): string {
  return `참조 ${index + 1}`
}
