// 감정 샘플러 IPC 계약 — renderer 는 논리 ID 만 다룬다.
//
// 이 계약의 어떤 입력·응답에도 파일 경로·참조 전사·미디어가 없다.
// 재생 주소는 캐시 키로 만든 형식이며 main 이 해석한다(renderer 는 실제 위치를 모른다).

export const SAMPLER_CHANNELS = {
  generate: 'sampler:generate',
  inventory: 'sampler:cache-inventory',
  remove: 'sampler:cache-delete',
  previewUrl: 'sampler:preview-url',
} as const

/** local-file 프로토콜의 캐시 전용 형식. main 만 실제 경로로 바꾼다. */
export const SAMPLER_PREVIEW_URL_PREFIX = 'local-file://sampler/'

export function samplerPreviewUrl(cacheKey: string): string {
  return SAMPLER_PREVIEW_URL_PREFIX + cacheKey
}

export interface SamplerGenerateRequest {
  /** 참조 보관함에서 고른 논리 ID. */
  referenceId: string
  /** 카탈로그 행 id. 자유 감정 문자열을 받지 않는다. */
  rowId: string
}

export type SamplerGenerateFailure =
  | 'NO_REFERENCE_SELECTED' | 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_READY'
  | 'TRANSCRIPT_MISSING' | 'TRANSCRIPT_CORRUPT' | 'TRANSCRIPT_HASH_MISMATCH'
  | 'CAPABILITY_NOT_USABLE' | 'INVALID_ROW' | 'EXPRESSION_FAILED'
  | 'RUN_FAILED' | 'NO_RESULT' | 'CLIP_INVALID' | 'CLIP_SILENT' | 'PUBLISH_FAILED'
  | 'BUSY' | 'CANCELLED' | 'LIMIT_EXCEEDED'

export type SamplerGenerateResponse =
  | { ok: true; rowId: string; cacheKey: string; reused: boolean }
  | { ok: false; rowId: string; reason: SamplerGenerateFailure }

export interface SamplerInventoryResponse {
  /** 캐시에 있는 키 목록(결정적 순서). 경로·크기·시각은 없다. */
  keys: string[]
}

export interface SamplerCacheKeyRequest {
  /** 64자리 소문자 hex. 그 밖의 값은 파일시스템에 닿기 전에 거부된다. */
  cacheKey: string
}

export type SamplerRemoveResponse =
  | { ok: true }
  | { ok: false; reason: 'INVALID_KEY' | 'NOT_FOUND' | 'NOT_OWNED' | 'DELETE_FAILED' }

export type SamplerPreviewUrlResponse =
  | { ok: true; url: string }
  | { ok: false; reason: 'INVALID_KEY' | 'NOT_FOUND' | 'NOT_OWNED' }

/** 사용자에게 보여줄 문구. 코드를 그대로 화면에 흘리지 않는다. */
export const SAMPLER_FAILURE_TEXT: Record<string, string> = {
  NO_REFERENCE_SELECTED: '먼저 참조 목소리를 선택해 주세요.',
  REFERENCE_NOT_FOUND: '선택한 참조를 찾을 수 없습니다.',
  REFERENCE_NOT_READY: '선택한 참조를 확인할 수 없습니다.',
  TRANSCRIPT_MISSING: '참조 전사가 없어 감정 샘플을 만들 수 없습니다. 참조 구간의 전사를 먼저 확정해 주세요.',
  TRANSCRIPT_CORRUPT: '참조 전사를 확인할 수 없습니다.',
  TRANSCRIPT_HASH_MISMATCH: '참조 전사가 참조 음성과 맞지 않습니다.',
  CAPABILITY_NOT_USABLE: '지금 엔진이 이 표현을 만들지 못합니다.',
  INVALID_ROW: '알 수 없는 표현입니다.',
  EXPRESSION_FAILED: '표현을 해석하지 못했습니다.',
  RUN_FAILED: '샘플을 만들지 못했습니다.',
  NO_RESULT: '샘플이 만들어지지 않았습니다.',
  CLIP_INVALID: '만들어진 샘플이 올바르지 않습니다.',
  CLIP_SILENT: '만들어진 샘플에 소리가 없습니다.',
  PUBLISH_FAILED: '샘플을 저장하지 못했습니다.',
  BUSY: '다른 작업이 진행 중이라 지금은 만들 수 없습니다.',
  CANCELLED: '만들기를 멈췄습니다.',
  LIMIT_EXCEEDED: '한 번에 만들 수 있는 개수를 넘었습니다.',
}
