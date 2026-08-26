// 참조 목소리 보관함 — 표시 로직(순수). React·DOM·IPC 비의존이라 그대로 테스트한다.
//
// 이 파일이 정하는 것: 목록 순서, 표시명, 상태 문구, 버튼 활성 여부.
// 컴포넌트는 여기서 나온 값을 그리기만 한다(표시 판단을 컴포넌트에 흩지 않는다).
//
// ⚠️ 경로는 이 계층에 아예 들어오지 않는다. main 이 논리 메타데이터만 돌려주고,
//    표시명도 원본 파일명이 아니라 앱이 붙인 번호다.
import type { ReferenceLibraryItem, ReferenceLibraryStatus } from '../../shared/referenceLibraryApi'

export const REFERENCE_ASSET_SECTION_TITLE = '참조 목소리 보관함'

export const REFERENCE_ASSET_TEXT = {
  empty: '자주 사용할 참조 목소리를 저장하면 대사를 바꿔도 다시 구간을 분석할 필요가 없습니다.',
  importButton: '현재 참조 구간 저장',
  inUse: '사용 중',
  corrupt: '저장된 참조를 확인할 수 없습니다.',
  missing: '저장 파일이 없습니다.',
  removeBlocked: '현재 사용 중인 참조입니다. 다른 참조를 선택한 뒤 삭제할 수 있습니다.',
  noConfirmedRegion: '먼저 참조 구간을 확정하면 저장할 수 있습니다.',
  busy: '다른 작업이 진행 중이라 지금은 저장할 수 없습니다.',
} as const

/**
 * 실패 사유 코드 → 사용자 문장. 경로·python stderr 는 애초에 여기까지 오지 않으므로
 * 문구만 고르면 된다. 코드를 그대로 화면에 흘리지 않는다.
 */
export const REF_ASSET_FAILURE_TEXT: Record<string, string> = {
  INVALID_SOURCE: '이 파일은 참조로 쓸 수 없습니다.',
  SOURCE_UNREADABLE: '원본 파일을 읽지 못했습니다.',
  ANALYZE_FAILED: '참조 음성을 분석하지 못했습니다.',
  SOURCE_NOT_SUITABLE: '이 음성은 참조 구간으로 쓰기 어렵습니다.',
  TRIM_FAILED: '참조 구간을 만들지 못했습니다.',
  CLIP_INVALID: '만들어진 참조 파일이 올바르지 않습니다.',
  PROMOTE_FAILED: '참조를 저장하지 못했습니다.',
  MANIFEST_CORRUPT: '저장된 참조를 확인할 수 없습니다.',
  BUSY: '다른 작업이 진행 중이라 지금은 저장할 수 없습니다.',
  INVALID_ID: '참조를 찾을 수 없습니다.',
  NOT_FOUND: '참조를 찾을 수 없습니다.',
  NOT_READY: '저장된 참조를 확인할 수 없습니다.',
  NOT_OWNED: '저장된 참조를 확인할 수 없습니다.',
  DELETE_FAILED: '참조를 삭제하지 못했습니다.',
  REFERENCE_IN_USE: '현재 사용 중인 참조입니다. 다른 참조를 선택한 뒤 삭제할 수 있습니다.',
}

export type ReferenceAssetTone = 'neutral' | 'ok' | 'warn' | 'error'

export interface ReferenceAssetRow {
  referenceId: string
  /** 화면에 보이는 이름. 원본 파일명이 아니라 앱이 붙인 번호다. */
  displayName: string
  /** 지금 합성에 쓰이는 참조인가. */
  selected: boolean
  /** 이 참조를 고를 수 있는가(손상·누락이면 불가). */
  selectable: boolean
  /** 지울 수 있는가. 사용 중이면 막는다(조용한 연쇄 삭제 대신 차단). */
  removable: boolean
  /** 삭제가 막힌 이유. 활성이면 null. */
  removeBlockedNotice: string | null
  /** 상태 한 줄. 정상이고 선택되지 않았으면 null. */
  statusLabel: string | null
  tone: ReferenceAssetTone
  /** 진단용 짧은 해시(앞 8자리). 기본 화면에서는 숨긴다. */
  shortHash: string
}

/** manifest 손상 여부까지 포함한 화면 상태. */
export interface ReferenceAssetView {
  status: ReferenceLibraryStatus
  rows: ReferenceAssetRow[]
  /** 목록이 비었는가(손상은 '비어 있음'이 아니다). */
  isEmpty: boolean
  /** 손상 안내를 띄워야 하는가. */
  showCorruptNotice: boolean
}

function toneOf(item: ReferenceLibraryItem): ReferenceAssetTone {
  if (item.missing) return 'error'
  if (!item.ready) return 'warn'
  if (item.selected) return 'ok'
  return 'neutral'
}

function statusOf(item: ReferenceLibraryItem): string | null {
  if (item.missing) return REFERENCE_ASSET_TEXT.missing
  if (!item.ready) return REFERENCE_ASSET_TEXT.corrupt
  if (item.selected) return REFERENCE_ASSET_TEXT.inUse
  return null
}

/**
 * 목록을 화면용으로 바꾼다. 순서는 referenceId 사전순으로 고정한다 —
 * 재시작이나 manifest 기록 순서에 따라 번호가 흔들리면 "참조 2"가 다른 것을 가리키게 된다.
 */
export function buildReferenceAssetView(
  status: ReferenceLibraryStatus,
  items: readonly ReferenceLibraryItem[],
): ReferenceAssetView {
  if (status === 'corrupt') {
    return { status, rows: [], isEmpty: false, showCorruptNotice: true }
  }
  const sorted = [...items].sort((a, b) => a.referenceId.localeCompare(b.referenceId))
  const rows = sorted.map((item, index) => {
    const selectable = item.ready && !item.missing
    return {
      referenceId: item.referenceId,
      displayName: item.displayName || `참조 ${index + 1}`,
      selected: item.selected,
      selectable,
      removable: !item.selected,
      removeBlockedNotice: item.selected ? REFERENCE_ASSET_TEXT.removeBlocked : null,
      statusLabel: statusOf(item),
      tone: toneOf(item),
      shortHash: (item.contentSha256 || '').slice(0, 8),
    }
  })
  return { status, rows, isEmpty: rows.length === 0, showCorruptNotice: false }
}

export interface ImportAvailability {
  /** ReferenceRegionPanel 에서 구간이 확정됐는가. */
  hasConfirmedRegion: boolean
  /** 합성·분석 등이 진행 중인가. */
  busy: boolean
  /** manifest 손상 등으로 쓰기가 막혔는가. */
  status: ReferenceLibraryStatus
  /** 등록 요청이 진행 중인가. */
  importing: boolean
}

export interface ImportDecision {
  enabled: boolean
  /** 비활성 사유. 회색 처리로 끝내지 않고 문장으로 함께 보여준다. 활성이면 null. */
  notice: string | null
}

/** 등록 버튼 활성 여부와 그 이유. 이유 없는 비활성 버튼을 만들지 않는다. */
export function decideImportAvailability(input: ImportAvailability): ImportDecision {
  if (input.status === 'corrupt') return { enabled: false, notice: REFERENCE_ASSET_TEXT.corrupt }
  if (!input.hasConfirmedRegion) return { enabled: false, notice: REFERENCE_ASSET_TEXT.noConfirmedRegion }
  if (input.busy || input.importing) return { enabled: false, notice: REFERENCE_ASSET_TEXT.busy }
  return { enabled: true, notice: null }
}

/** 접힘 상태에서 보여줄 한 줄 요약. 손상과 '비어 있음'을 구분한다. */
export function summarizeReferenceAssets(view: ReferenceAssetView): string {
  if (view.showCorruptNotice) return REFERENCE_ASSET_TEXT.corrupt
  if (view.isEmpty) return '저장된 참조 없음'
  const usable = view.rows.filter((r) => r.selectable).length
  const attention = view.rows.length - usable
  const selected = view.rows.some((r) => r.selected) ? ' · 사용 중 1' : ''
  return attention > 0
    ? `저장됨 ${view.rows.length} · 확인 필요 ${attention}${selected}`
    : `저장됨 ${view.rows.length}${selected}`
}
