// 분할 마커(split marker) 검증 단일 권위 — C2-P0.3.
// renderer(SplitEditor / ProcessButton)와 main(audio.ipc)이 이 모듈 하나만 본다.
// python/split_markers.py 가 같은 규칙 + 같은 reasonCode 문자열을 미러한다(파싱 parity 테스트로 고정).
//
// ⚠️ 순수 모듈이다: React / Electron / node:fs import 금지. 부수효과 없음.
// ⚠️ 조용한 복구 금지: clamp / sort / dedupe 하지 않는다. 잘못된 입력은 구조화 오류로 REJECT 한다.
//    (진입 시점의 UI 편의 정렬은 SplitEditor 쪽 관심사이고, 검증기 자체는 절대 고치지 않는다.)
// ⚠️ 오류 payload에는 marker index / reasonCode / 숫자값만 담는다.
//    파일 경로·파일명·지문 문자열·미디어 내용은 절대 넣지 않는다(미디어 정책).

/** 트랙 하나의 최소 길이(초). 이보다 짧은 구간이 생기면 REJECT — ffmpeg 0초 트랙 방지. */
export const MIN_TRACK_SECONDS = 1.0

/** 분할 지점 최대 개수. 넘으면 REJECT(개별 마커 오류를 쏟아내지 않고 목록 단위로 1건). */
export const MAX_MARKER_COUNT = 200

/** 트랙 길이 비교용 부동소수 허용오차(초). 10.2-9.2 = 0.9999999999999996 같은 이진오차 오검출 방지. */
export const TRACK_LENGTH_EPSILON = 1e-9

/** 목록 단위(특정 마커가 아닌) 오류의 index 값. */
export const LIST_LEVEL_INDEX = -1

// reasonCode 집합(문자열 prefix 추론 금지 — renderer/main/Python 공용 권위 집합).
// 이 배열의 순서·철자는 python/split_markers.py SPLIT_MARKER_REASON_CODES 와 정확히 같아야 한다.
export const SPLIT_MARKER_REASON_CODES = [
  'MARKER_NOT_FINITE',      // number가 아니거나 NaN/Infinity
  'MARKER_NOT_POSITIVE',    // 0초 이하(0 정확히 포함 — 첫 트랙 시작은 마커가 아니다)
  'MARKER_BEYOND_DURATION', // 오디오 길이 이상(길이 정확히 포함 — ffmpeg 음수 -t 유발)
  'MARKER_NOT_INCREASING',  // 앞 마커보다 작음(정렬은 검증기가 대신 해주지 않는다)
  'MARKER_DUPLICATE',       // 앞 마커와 값이 같음(0초 트랙 유발)
  'TRACK_TOO_SHORT',        // 인접 경계 간 구간이 최소 트랙 길이 미만
  'MARKER_COUNT_EXCEEDED',  // 마커 개수가 최대치 초과
  'FINGERPRINT_MISMATCH',   // 마커가 만들어진 파일 지문과 처리 대상 파일 지문이 다름
  'DURATION_INVALID',       // 길이가 유한 양수가 아님(ffprobe 실패 등) → 범위 검증 불가
] as const

export type SplitMarkerReasonCode = typeof SPLIT_MARKER_REASON_CODES[number]

/** 구조화 오류. 숫자와 코드만 — 경로/파일명/지문 문자열은 담지 않는다. */
export interface SplitMarkerError {
  /** 0-based 마커 index. 목록 단위 오류는 LIST_LEVEL_INDEX(-1). */
  index: number
  reasonCode: SplitMarkerReasonCode
  /** 위반한 실제 값(초 / 개수 / 트랙 길이). 유한 숫자일 때만 존재. */
  value?: number
  /** 위반 기준값(오디오 길이 / 앞 마커 시각 / 최소 트랙 길이 / 최대 개수). */
  limit?: number
}

export interface ValidateMarkersOptions {
  /** 오디오 전체 길이(초). 마커가 1개 이상이면 유한 양수여야 한다. */
  durationSeconds: number
  /** 마커가 만들어질 때 기록해 둔 파일 지문(호출자가 공급 — 이 모듈은 해시를 계산하지 않는다). */
  fingerprint?: string | null
  /** 지금 처리하려는 파일의 지문. */
  expectedFingerprint?: string | null
  /** 기본 MIN_TRACK_SECONDS. 유한 양수만 반영된다. */
  minTrackSeconds?: number
  /** 기본 MAX_MARKER_COUNT. 유한 양의 정수만 반영된다. */
  maxMarkerCount?: number
}

export type ValidateMarkersResult =
  | {
      ok: true
      /** 입력 그대로(정렬/중복제거/clamp 없음). */
      markers: number[]
      /** 마커 기반 분할 시 생기는 트랙 수. autoSilenceSplit이면 null(무음 감지가 정한다). */
      trackCount: number | null
      /** true = 마커 0개 → 배치 무음 자동 분할 경로. */
      autoSilenceSplit: boolean
    }
  | { ok: false; errors: SplitMarkerError[] }

function normalizeFingerprint(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/**
 * 지문 비교 헬퍼. 지문 값 자체는 호출자가 공급한다(여기서 파일 해시를 계산하지 않는다).
 * - 둘 다 없음 → true(지문 추적을 쓰지 않는 호출자)
 * - 한쪽만 있음 → false(마커에는 지문이 있는데 대상 파일에는 없음 = 신뢰 불가)
 * - 둘 다 있음 → 문자열 완전 일치일 때만 true
 */
export function fingerprintMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeFingerprint(a)
  const nb = normalizeFingerprint(b)
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  return na === nb
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 분할 마커 검증. 통과하면 입력 그대로 돌려주고, 아니면 구조화 오류 목록을 돌려준다.
 * 절대 고쳐서 돌려주지 않는다(no silent repair).
 *
 * 단계: 빈 목록 → 개수 → 지문 → 길이 → 마커별(유한/양수/범위/순서/중복) → 트랙 길이.
 * 앞 단계에서 걸리면 뒤 단계는 돌리지 않는다(정렬 안 된 값으로 계산한 트랙 길이는 무의미).
 */
export function validateMarkers(
  markers: readonly unknown[],
  opts: ValidateMarkersOptions
): ValidateMarkersResult {
  if (!Array.isArray(markers)) throw new TypeError('validateMarkers: markers must be an array')

  const minTrack = isFiniteNumber(opts.minTrackSeconds) && opts.minTrackSeconds > 0
    ? opts.minTrackSeconds
    : MIN_TRACK_SECONDS
  const maxCount = isFiniteNumber(opts.maxMarkerCount) && opts.maxMarkerCount > 0
    ? Math.floor(opts.maxMarkerCount)
    : MAX_MARKER_COUNT

  // 1) 마커 0개 = 정상. 배치가 ffmpeg 무음 자동 분할로 간다(조용한 fallthrough가 아니라 명시 신호).
  if (markers.length === 0) {
    return { ok: true, markers: [], trackCount: null, autoSilenceSplit: true }
  }

  // 2) 개수 초과 — 목록 단위 1건만.
  if (markers.length > maxCount) {
    return {
      ok: false,
      errors: [{ index: LIST_LEVEL_INDEX, reasonCode: 'MARKER_COUNT_EXCEEDED', value: markers.length, limit: maxCount }],
    }
  }

  // 3) 지문 불일치 — 다른 파일 기준 마커이므로 좌표 검증 자체가 무의미. 즉시 반환.
  if (!fingerprintMatches(opts.fingerprint, opts.expectedFingerprint)) {
    return { ok: false, errors: [{ index: LIST_LEVEL_INDEX, reasonCode: 'FINGERPRINT_MISMATCH' }] }
  }

  // 4) 길이가 유한 양수가 아니면 범위 검증이 불가능하다 → 조용히 통과시키지 않는다.
  const duration = opts.durationSeconds
  if (!isFiniteNumber(duration) || duration <= 0) {
    const err: SplitMarkerError = { index: LIST_LEVEL_INDEX, reasonCode: 'DURATION_INVALID' }
    if (isFiniteNumber(duration)) err.value = duration
    return { ok: false, errors: [err] }
  }

  // 5) 마커별 검증. 한 마커가 여러 규칙을 어기면 규칙마다 1건씩 보고한다.
  const errors: SplitMarkerError[] = []
  const accepted: number[] = []
  let prev: number | null = null

  for (let i = 0; i < markers.length; i++) {
    const raw = markers[i]
    if (!isFiniteNumber(raw)) {
      // NaN/Infinity/문자열/boolean — 강제 변환하지 않는다. prev도 갱신하지 않는다.
      errors.push({ index: i, reasonCode: 'MARKER_NOT_FINITE' })
      continue
    }
    let bad = false
    if (raw <= 0) {
      errors.push({ index: i, reasonCode: 'MARKER_NOT_POSITIVE', value: raw, limit: 0 })
      bad = true
    }
    if (raw >= duration) {
      errors.push({ index: i, reasonCode: 'MARKER_BEYOND_DURATION', value: raw, limit: duration })
      bad = true
    }
    if (prev !== null) {
      if (raw === prev) {
        errors.push({ index: i, reasonCode: 'MARKER_DUPLICATE', value: raw, limit: prev })
        bad = true
      } else if (raw < prev) {
        // 비인접 중복([10,20,10])도 필연적으로 이 규칙에 걸린다.
        errors.push({ index: i, reasonCode: 'MARKER_NOT_INCREASING', value: raw, limit: prev })
        bad = true
      }
    }
    prev = raw
    if (!bad) accepted.push(raw)
  }

  if (errors.length > 0) return { ok: false, errors }

  // 6) 트랙 길이. 여기 도달했으면 accepted는 (0, duration) 안의 강한 증가 수열이다.
  const boundaries = [0, ...accepted, duration]
  for (let j = 0; j < boundaries.length - 1; j++) {
    const len = boundaries[j + 1] - boundaries[j]
    if (len < minTrack - TRACK_LENGTH_EPSILON) {
      // 구간 j의 책임 마커: 구간을 닫는 마커(마지막 구간은 그 구간을 여는 마지막 마커).
      errors.push({
        index: Math.min(j, accepted.length - 1),
        reasonCode: 'TRACK_TOO_SHORT',
        value: len,
        limit: minTrack,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, markers: accepted.slice(), trackCount: accepted.length + 1, autoSilenceSplit: false }
}

function fmtNum(v: number | undefined): string {
  if (!isFiniteNumber(v)) return '?'
  return String(Math.round(v * 1000) / 1000)
}

/**
 * 사용자 표시 문구(한국어). 숫자와 순번만 쓴다 — 경로/파일명 노출 없음.
 * 마커 순번은 1-based(사용자가 보는 "N번째 분할 지점").
 */
export function formatSplitMarkerError(err: SplitMarkerError): string {
  const nth = err.index >= 0 ? `${err.index + 1}번째 분할 지점` : '분할 지점'
  switch (err.reasonCode) {
    case 'MARKER_NOT_FINITE':
      return `${nth}의 시간 값이 올바른 숫자가 아닙니다.`
    case 'MARKER_NOT_POSITIVE':
      return `${nth}(${fmtNum(err.value)}초)이 0초 이하입니다. 0초보다 뒤여야 합니다.`
    case 'MARKER_BEYOND_DURATION':
      return `${nth}(${fmtNum(err.value)}초)이 오디오 길이(${fmtNum(err.limit)}초)를 벗어났습니다.`
    case 'MARKER_NOT_INCREASING':
      return `${nth}(${fmtNum(err.value)}초)이 앞 지점(${fmtNum(err.limit)}초)보다 앞섭니다. 시간 순서대로여야 합니다.`
    case 'MARKER_DUPLICATE':
      return `${nth}(${fmtNum(err.value)}초)이 앞 지점과 같은 시각입니다.`
    case 'TRACK_TOO_SHORT':
      return `${nth} 부근 트랙이 ${fmtNum(err.value)}초로 최소 ${fmtNum(err.limit)}초보다 짧습니다.`
    case 'MARKER_COUNT_EXCEEDED':
      return `분할 지점이 ${fmtNum(err.value)}개로 최대 ${fmtNum(err.limit)}개를 넘었습니다.`
    case 'FINGERPRINT_MISMATCH':
      return '분할 지점이 다른 파일 기준으로 만들어졌습니다. 지점을 다시 지정하세요.'
    case 'DURATION_INVALID':
      return '오디오 길이를 확인할 수 없어 분할 지점을 검증할 수 없습니다.'
    default:
      return '분할 지점을 확인할 수 없습니다.'
  }
}

/** 마커 0개일 때 UI에 노출하는 고정 문구(배치가 무음 자동 분할로 감을 알린다). */
export const AUTO_SILENCE_SPLIT_NOTICE = '마커가 없어 자동 무음 분할을 사용합니다.'
