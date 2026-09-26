// 테스트개발 작업실 — **판정 규칙의 단일 소유자**.
//
// 이 작업실이 다루는 것은 하나다: 대본을 쓰고, 문장별로 음성을 만들고, 마음에 드는 것을 골라
// 전체를 완성한다. 그래서 어려운 판정도 딱 두 가지뿐이다.
//   · 이 결과가 **지금 대사·지금 목소리**의 것인가
//   · 전체를 듣거나 내보낼 때 **빠지거나 낡은 자리**가 어디인가
//
// 화면과 저장과 검사가 이 규칙을 각자 다시 쓰면 반드시 갈라진다. 그래서 여기 하나로 둔다.
// **소리를 만드는 일은 이 파일이 하지 않는다** — 기존 합성 경로를 그대로 부른다.

/** 한 번의 생성으로 나온 결과 하나. 재생성은 이것을 덮지 않고 새로 만든다. */
export interface LabTake {
  id: string
  /** 안전한 자리로 옮겨 둔 소리 파일. 임시 정리에 휩쓸리지 않는 곳이다. */
  path: string
  /** **요청 당시의** 대사. 지금 대사와 다르면 '수정 전 대사' 다. */
  text: string
  /** **요청 당시의** 목소리 식별값. 지금과 다르면 '이전 목소리' 다. */
  voiceKey: string
  createdAt: number
  /**
   * 끝났을 때 아직 소리가 남아 있었는가(0~1). 마감 단계가 fade 를 걸기 전에 잰 값이다.
   * 옛 생성본에는 없다(undefined = 재지 않았다 ≠ 정상).
   */
  tailResidual?: number
}

export interface LabLine {
  id: string
  text: string
  takes: LabTake[]
  /** 사용자가 고른 테이크. 처음 성공한 것이 자동으로 여기 들어간다. */
  adoptedTakeId: string | null
}

/**
 * 이 작업실이 쓰는 **생성 설정**. 합성 탭의 값을 실시간으로 물려받지 않는다.
 *
 * ★왜 따로 두는가: 기존 합성 **기능**은 그대로 재사용하지만, 합성 탭에서 속도나 엔진을 바꾼 것이
 *   이 작업실에 조용히 반영되면 "같은 대본인데 결과가 달라졌다" 가 된다. 그래서 설정은 작업실이
 *   소유하고 함께 저장한다. 초기값은 제품 기본값이다(합성 탭의 **현재** 값이 아니다).
 */
export interface LabSettings {
  speed: number
  silenceGap: number
  pitch: number
  engine: string
  qwenModel: string
  referenceConditioningMode: string
  /** 참조 목표 길이(초). 0 = 엔진 권장 상한. */
  refTargetSec: number
  /**
   * 말끝 다듬기. 'auto' 면 끝을 8ms 로 부드럽게 줄이고 뒤에 120ms 여유를 붙인다.
   *
   * ★왜 있어야 하는가: 이 값을 안 보내면 워커가 'off' 로 떨어지고, 그러면 말끝의 권위가
   *   경계 envelope 으로 넘어가 **끝 20ms 를 0 까지 깎으면서 뒤 여유는 0ms** 가 된다
   *   (`audio_finishing.py` BOUNDARY_OFFSET_MS=20, compute_boundary_plan 의 tail_owns_offset).
   *   실측: 발화 도중 끝난 문장의 마지막 20ms 가 off 에서 60.9%, auto 에서 86.5% 남았다.
   *   작업실이 값을 안 보내 'off' 로 돌던 것이 말끝이 잘려 들리던 원인이다.
   */
  tailMode: 'off' | 'auto'
  tailPaddingMs: number
  tailFadeMs: number
}

/** 제품 기본값 — app.store 의 초기값과 같은 값이다(합성 탭의 현재 값이 아니다). */
export function defaultSettings(referenceConditioningRecommended: string): LabSettings {
  return {
    speed: 1.0, silenceGap: 0.5, pitch: 0.0,
    engine: 'auto', qwenModel: '',
    referenceConditioningMode: referenceConditioningRecommended,
    refTargetSec: 0,
    tailMode: 'auto', tailPaddingMs: 120, tailFadeMs: 8,
  }
}

/**
 * 설정 → 합성 워커에 보낼 옵션. **작업실이 보내는 값의 단 하나의 출처다.**
 *
 * ★여기에 둔 이유: 화면 파일 안에 있을 때 `ttsTailMode` 가 통째로 빠져 있었고, 빠졌다는 사실을
 *   아무 검사도 잡지 못했다. 워커는 값이 없으면 조용히 'off' 로 떨어진다(`separate.py`
 *   `config.get("ttsTailMode", "off")`) — 소리만 달라지고 오류는 안 난다. 그래서 옵션 구성도
 *   판정 규칙과 같은 자리에 두고 검사로 막는다.
 */
export function synthesisOptions(
  text: string, s: LabSettings,
  ref: { clip: string; region: { start: number; duration: number } | null },
) {
  return {
    ttsText: text,
    ttsSpeed: s.speed, ttsSilenceGap: s.silenceGap, ttsPitch: s.pitch,
    ttsEngine: s.engine, ttsQwenModel: s.qwenModel,
    ttsReferenceOverride: ref.clip, ttsReferenceRegion: ref.region,
    ttsReferenceConditioningMode: s.referenceConditioningMode,
    ttsTailMode: s.tailMode, ttsTailPaddingMs: s.tailPaddingMs, ttsTailFadeMs: s.tailFadeMs,
    ttsSpeakerMode: 'single' as const,
  }
}

/** 작업실이 스스로 준비한 목소리 상태. 합성 탭의 참조 슬롯과 **다른 자리**다. */
export interface LabRefState {
  clip: string
  region: { start: number; duration: number } | null
  ready: boolean
  phase: string
  message: string
  reqId: string
}

export function emptyRef(): LabRefState {
  return { clip: '', region: null, ready: false, phase: 'idle', message: '', reqId: '' }
}

export interface LabDoc {
  /** 지금 쓰는 목소리. 파일 경로가 곧 식별값이다(첫 시제품은 한 목소리만 쓴다). */
  voicePath: string
  voiceLabel: string
  lines: LabLine[]
  /** 작업실 소유 생성 설정. 저장본에 없으면 제품 기본값으로 채운다. */
  settings: LabSettings
  updatedAt: number
}

/** 목소리 식별값. 지금은 경로 하나지만, 판정이 이 함수 하나만 보게 해 둔다. */
export function voiceKeyOf(voicePath: string): string {
  return (voicePath || '').trim()
}

export function emptyDoc(referenceConditioningRecommended = 'auto'): LabDoc {
  return {
    voicePath: '', voiceLabel: '', lines: [newLine('')],
    settings: defaultSettings(referenceConditioningRecommended), updatedAt: Date.now(),
  }
}

let seq = 0
export function newId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

export function newLine(text: string): LabLine {
  return { id: newId('ln'), text, takes: [], adoptedTakeId: null }
}

export function adoptedTake(line: LabLine): LabTake | null {
  if (!line.adoptedTakeId) return null
  return line.takes.find((t) => t.id === line.adoptedTakeId) || null
}

/** 이 테이크가 지금 대사와 같은가. 다르면 '수정 전 대사'. */
export function takeMatchesText(take: LabTake, line: LabLine): boolean {
  return take.text === line.text
}

/** 이 테이크가 지금 목소리로 만든 것인가. 다르면 '이전 목소리'. */
export function takeMatchesVoice(take: LabTake, voiceKey: string): boolean {
  return take.voiceKey === voiceKey
}

export type LineStatus =
  | 'empty'        // 대사가 비어 있다 — 만들 것이 없다
  | 'none'         // 아직 만든 적이 없다
  | 'stale_text'   // 채택한 결과가 수정 전 대사의 것이다
  | 'stale_voice'  // 채택한 결과가 이전 목소리의 것이다
  | 'ready'        // 지금 대사·지금 목소리의 결과가 채택돼 있다

/**
 * 이 줄의 상태. **전체 듣기·내보내기·변경분 생성이 모두 이 판정 하나를 쓴다.**
 * 낡은 결과를 최신인 것처럼 다루지 않기 위해서다.
 */
export function lineStatus(line: LabLine, voiceKey: string): LineStatus {
  if (!line.text.trim()) return 'empty'
  const t = adoptedTake(line)
  if (!t) return 'none'
  if (!takeMatchesText(t, line)) return 'stale_text'
  if (!takeMatchesVoice(t, voiceKey)) return 'stale_voice'
  return 'ready'
}

export function lineStatusText(s: LineStatus): string {
  switch (s) {
    case 'empty': return '대사 없음'
    case 'none': return '아직 안 만듦'
    case 'stale_text': return '수정 전 대사의 결과'
    case 'stale_voice': return '이전 목소리의 결과'
    case 'ready': return '준비됨'
  }
}

/**
 * **말끝이 잘렸다고 볼 기준.** 이 값 이상이면 끝났을 때 소리가 살아 있었다고 본다.
 *
 * ★근거(2026-09-16 실측 4회): 끊긴 1회는 0.087, 정상 3회는 0.000 / 0.002 / 0.007.
 *   그 사이를 0.03 으로 잡았다. **표본 4회짜리 첫 기준이지 확정값이 아니다.**
 *   바꿀 때는 새로 측정한 값과 함께 바꾼다 — 화면이 조용해지도록 올리지 않는다.
 */
/**
 * 합성 결과 알림에서 **끝났을 때 남아 있던 소리**를 꺼낸다.
 *
 * ★2026-09-24: 여기가 **없는 자리를 읽고 있었다.**
 *   파이썬은 `emit("result", tracks=..., outputDir=..., metadata=meta)` 로
 *   metadata 를 **tracks 의 형제**로 보내는데, 화면은 `tracks[0].metadata` 라는
 *   **트랙 안쪽**을 읽었다. 트랙에는 그런 열쇠가 아예 없다.
 *   그래서 값이 늘 undefined → `takeTailCut()` 늘 false →
 *   **'끝 잘림 의심' 꼬리표가 한 번도 뜬 적이 없다.**
 *   받는 인자가 any 라 타입검사도 잡지 못했다. 그래서 순수 함수로 빼서 검사로 못 박는다.
 *
 * 작업실은 한 문장씩 합성하므로 실행 단위 metadata 가 곧 그 트랙의 값이다.
 * 숫자가 아니면 undefined — **모르는 것을 0으로 읽지 않는다**(0은 '아주 좋음'이다).
 */
export function tailResidualOf(payload: unknown): number | undefined {
  const meta = (payload as { metadata?: Record<string, unknown> } | null)?.metadata
  const raw = meta?.tail_residual_ratio
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

// ★이 값은 파이썬 쪽 tail_retry.CUT_RATIO 와 **같아야 한다**(2026-09-24).
//   말이 다르면 화면은 "잘렸다" 는데 합성 쪽은 다시 만들지 않는 일이 생긴다.
//   언어가 달라 한 곳에 둘 수 없어 양쪽에 서로를 가리키는 말을 적고 검사로 붙잡는다.
export const TAIL_RESIDUAL_CUT = 0.03

/**
 * 이 생성본은 **끝이 잘렸을 수 있는가.**
 *
 * 되살릴 수는 없다 — 모델이 마지막 음절이 울리는 중에 스스로 끝낸 것이고, 생성 상한 도달도
 * 우리 쪽 절단도 아니라 오류로 드러나지 않는다. 그래서 **알아보기만 한다**: 표시해 두면
 * 일일이 들어 보지 않고 곧바로 '추가 생성' 을 누를 수 있다.
 *
 * 잰 적이 없으면(옛 생성본) false — 모르는 것을 잘렸다고 말하지 않는다.
 */
export function takeTailCut(take: LabTake): boolean {
  return isTailCut(take.tailResidual)
}

/**
 * 잰 값 하나로 판정한다 — 회차 꾸러미가 없는 자리(더빙 화면)도 **같은 기준**을 쓰게.
 *
 * ★더빙은 회차를 쌓지 않고 바로 쓴다. 그래서 LabTake 모양을 억지로 지어내 넘기는
 *   대신 숫자를 받는 문을 연다 — 지어낸 모양은 타입을 눌러 감추게 된다.
 * 재지 못했으면 false. **모르는 것을 잘렸다고 말하지 않는다.**
 */
export function isTailCut(residual: number | undefined): boolean {
  return typeof residual === 'number' && Number.isFinite(residual) && residual >= TAIL_RESIDUAL_CUT
}

/** 테이크 하나에 붙일 꼬리표(없으면 빈 문자열). */
export function takeBadge(take: LabTake, line: LabLine, voiceKey: string): string {
  if (!takeMatchesText(take, line)) return '수정 전 대사'
  if (!takeMatchesVoice(take, voiceKey)) return '이전 목소리'
  return ''
}

/** 왜 다시 만들어야 하는지 — 짧은 말로. 단추를 누르기 **전에** 보여 준다. */
export function redoReason(s: LineStatus): string {
  switch (s) {
    case 'none': return '아직 음성 없음'
    case 'stale_text': return '대사 바뀜'
    case 'stale_voice': return '목소리 바뀜'
    default: return ''
  }
}

/**
 * 만들 대상 문장을 **번호와 이유**로 늘어놓는다 — "필요한 문장 생성" 이 무엇을 할지
 * 누르기 전에 알 수 있어야 한다.
 */
export function redoTargets(doc: LabDoc): { number: number; reason: string }[] {
  const vk = voiceKeyOf(doc.voicePath)
  const out: { number: number; reason: string }[] = []
  doc.lines.forEach((l, i) => {
    const r = redoReason(lineStatus(l, vk))
    if (r) out.push({ number: i + 1, reason: r })
  })
  return out
}

/**
 * 새로 만들었지만 **아직 고르지 않은** 생성본이 있는가.
 *
 * ★이전 결과를 보존하는 원칙 때문에 새 생성본은 사용 중인 음성을 자동으로 밀어내지 않는다.
 *   그러면 사용자 눈에는 "눌렀는데 아무 일도 없다" 로 보인다 — 그래서 이 사실을 표시한다.
 */
export function hasUnusedTake(line: LabLine, voiceKey: string): boolean {
  const cur = adoptedTake(line)
  if (!cur) return line.takes.length > 0
  // ★'고르지 않은 다른 생성본' 이 아니라 **고른 것보다 나중에 만든 것**이 있는가다.
  //   예전 생성본을 남겨 둔 것은 알릴 일이 아니다 — 사용자가 이미 그 중에서 골랐다.
  return line.takes.some((t) => t.id !== cur.id && t.createdAt > cur.createdAt
    && takeMatchesText(t, line) && takeMatchesVoice(t, voiceKey))
}

/** 다시 만들어야 하는 줄들 — 대사가 있는데 준비되지 않은 것 전부. */
export function linesNeedingWork(doc: LabDoc): LabLine[] {
  const vk = voiceKeyOf(doc.voicePath)
  return doc.lines.filter((l) => {
    const s = lineStatus(l, vk)
    return s === 'none' || s === 'stale_text' || s === 'stale_voice'
  })
}

/**
 * 내보내기를 막는 **구체적인 이유**. 사용자가 다음에 무엇을 해야 하는지가 셋 다 다르다.
 *   need_generate   — 이 문장으로 만든 것이 하나도 없다 → 만들어야 한다
 *   need_pick       — 지금 대사·목소리에 맞는 생성본이 **있는데 고르지 않았다** → 고르면 된다
 *   need_regenerate — 생성본은 있지만 지금 대사·목소리의 것이 하나도 없다 → 다시 만들어야 한다
 */
export type ExportBlock = 'need_generate' | 'need_pick' | 'need_regenerate'

/** 이 문장이 내보내기를 막는가, 막는다면 왜인가. 막지 않으면 null. */
export function exportBlockReason(line: LabLine, voiceKey: string): ExportBlock | null {
  if (!line.text.trim()) return null                    // 빈 줄은 만들 것이 없다
  const cur = adoptedTake(line)
  if (cur && takeMatchesText(cur, line) && takeMatchesVoice(cur, voiceKey)) return null
  // ★고르기만 하면 되는 경우를 '다시 만들어야 한다' 로 뭉뚱그리지 않는다.
  if (line.takes.some((t) => takeMatchesText(t, line) && takeMatchesVoice(t, voiceKey))) return 'need_pick'
  return line.takes.length > 0 ? 'need_regenerate' : 'need_generate'
}

/** 몇 번째 문장이 왜 막는지 — 사용자가 그대로 읽고 행동할 수 있는 한 문장. */
export function exportBlockText(index: number, b: ExportBlock): string {
  const n = index + 1
  switch (b) {
    case 'need_generate': return `${n}번 문장의 음성을 생성하세요.`
    case 'need_pick': return `${n}번 문장에서 사용할 음성을 선택하세요.`
    case 'need_regenerate': return `${n}번 문장이 변경됐습니다. 음성을 다시 생성하세요.`
  }
}

/**
 * 이 알림이 '내보낼 수 없다' 는 말인가 — **문제가 풀리면 지워야 하는 종류**인지 가린다.
 *
 * ★해소된 뒤에도 남아 있으면 아래 상태의 '전부 준비됨' 과 서로 다른 말을 하게 된다.
 *   어느 경로로 떴든 지워져야 하므로, 누가 띄웠는지가 아니라 **무슨 말인지**로 가린다.
 */
export function isExportBlockNotice(text: string | null | undefined): boolean {
  if (!text) return false
  return /문장의 음성을 생성하세요|사용할 음성을 선택하세요|음성을 다시 생성하세요|만든 문장이 없습니다/
    .test(text)
}

export interface ExportReadiness {
  ready: boolean
  /** 순서대로 이어 붙일 파일들. ready 가 아니면 비어 있다. */
  paths: string[]
  /** 막고 있는 자리들 — 몇 번째 줄이 왜 안 되는지. */
  blocking: { index: number; status: LineStatus; block: ExportBlock; text: string }[]
  /** 대사가 비어 건너뛴 줄 수(막는 것이 아니다). */
  skippedEmpty: number
}

/**
 * 전체 듣기·내보내기가 쓸 목록.
 *
 * ★**빠진 문장을 조용히 빼지 않는다.** 준비되지 않은 자리가 하나라도 있으면 ready=false 이고
 *   어디가 왜 막는지 그대로 돌려준다. 옛 결과를 최신인 것처럼 내보내지 않는다.
 *   대사가 비어 있는 줄만 조용히 건너뛴다(만들 것이 없으므로) — 그 수도 함께 알린다.
 */
export function exportReadiness(doc: LabDoc): ExportReadiness {
  const vk = voiceKeyOf(doc.voicePath)
  const paths: string[] = []
  const blocking: ExportReadiness['blocking'] = []
  let skippedEmpty = 0
  doc.lines.forEach((l, i) => {
    if (!l.text.trim()) { skippedEmpty += 1; return }
    const b = exportBlockReason(l, vk)
    if (!b) {
      // 막지 않는다 = 지금 대사·목소리의 생성본이 **사용자가 고른 그대로** 있다.
      // 최신이라는 이유로 다른 것을 집지 않는다.
      const t = adoptedTake(l)
      if (t) { paths.push(t.path); return }
    }
    blocking.push({ index: i, status: lineStatus(l, vk), block: b || 'need_generate', text: l.text })
  })
  // ★막는 자리가 하나라도 있으면 **부분 목록을 내주지 않는다.** 내주면 어느 호출자든
  //   '있는 것만' 이어 붙일 수 있게 되고, 그것이 곧 빠진 문장을 조용히 빼는 길이다.
  const ready = blocking.length === 0 && paths.length > 0
  return { ready, paths: ready ? paths : [], blocking, skippedEmpty }
}

/**
 * 늦게 도착한 결과를 받아들일지 판정한다.
 *
 * ★생성 도중에 대사를 고쳤을 수 있다. 그때 늦게 온 결과를 **현재 대사의 최신 결과로 표시하면
 *   거짓말이 된다.** 그래서 요청 당시의 대사·목소리를 결과에 붙여 두고, 지금과 같을 때만
 *   자동 채택한다. 다르면 **버리지 않고** 테이크로 남기되 꼬리표가 붙는다.
 */
export function shouldAutoAdopt(line: LabLine, take: LabTake, voiceKey: string): boolean {
  if (!takeMatchesText(take, line)) return false
  if (!takeMatchesVoice(take, voiceKey)) return false
  // 이미 사용자가 고른 것이 있으면 새 테이크가 그것을 밀어내지 않는다.
  const cur = adoptedTake(line)
  if (cur) return false
  return true
}

/** 저장 열쇠 — 기존 작업 저장과 섞이지 않게 **따로** 쓴다. */
export const LAB_STORAGE_KEY = 'labWorkspace'

/** 저장본에서 문서를 되살린다. 모양이 어긋나면 지어내지 않고 null. */
export function parseSettings(raw: unknown, referenceConditioningRecommended = 'auto'): LabSettings {
  const d = defaultSettings(referenceConditioningRecommended)
  if (!raw || typeof raw !== 'object') return d
  const o = raw as Record<string, unknown>
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
  const str = (v: unknown, fb: string) => (typeof v === 'string' ? v : fb)
  return {
    speed: num(o.speed, d.speed),
    silenceGap: num(o.silenceGap, d.silenceGap),
    pitch: num(o.pitch, d.pitch),
    engine: str(o.engine, d.engine),
    qwenModel: str(o.qwenModel, d.qwenModel),
    referenceConditioningMode: str(o.referenceConditioningMode, d.referenceConditioningMode),
    refTargetSec: num(o.refTargetSec, d.refTargetSec),
    // 저장본에 값이 없으면 기본값('auto')으로 올린다. 합성 탭은 필드 부재를 '사용자가 예전에
    // off 를 고른 세션'으로 보고 off 로 강등하지만, 작업실엔 이 설정이 **애초에 없었다** —
    // 부재는 사용자의 선택이 아니라 우리가 안 보낸 결함이므로 강등하지 않는다.
    tailMode: o.tailMode === 'off' || o.tailMode === 'auto' ? o.tailMode : d.tailMode,
    tailPaddingMs: num(o.tailPaddingMs, d.tailPaddingMs),
    tailFadeMs: num(o.tailFadeMs, d.tailFadeMs),
  }
}

export function parseDoc(raw: unknown, referenceConditioningRecommended = 'auto'): LabDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.lines)) return null
  const lines: LabLine[] = []
  for (const l of o.lines) {
    if (!l || typeof l !== 'object') return null
    const ln = l as Record<string, unknown>
    if (typeof ln.id !== 'string' || typeof ln.text !== 'string') return null
    const takes: LabTake[] = []
    for (const t of Array.isArray(ln.takes) ? ln.takes : []) {
      const tk = t as Record<string, unknown>
      if (!tk || typeof tk.id !== 'string' || typeof tk.path !== 'string') continue
      takes.push({
        id: tk.id, path: tk.path,
        text: typeof tk.text === 'string' ? tk.text : '',
        voiceKey: typeof tk.voiceKey === 'string' ? tk.voiceKey : '',
        createdAt: typeof tk.createdAt === 'number' ? tk.createdAt : 0,
        // 옛 생성본엔 없다. 없으면 없는 채로 둔다 — 0 으로 채우면 '정상' 이라고 거짓말하게 된다.
        ...(typeof tk.tailResidual === 'number' && Number.isFinite(tk.tailResidual)
          ? { tailResidual: tk.tailResidual } : {}),
      })
    }
    const adopted = typeof ln.adoptedTakeId === 'string' ? ln.adoptedTakeId : null
    lines.push({
      id: ln.id, text: ln.text, takes,
      adoptedTakeId: adopted && takes.some((t) => t.id === adopted) ? adopted : null,
    })
  }
  return {
    voicePath: typeof o.voicePath === 'string' ? o.voicePath : '',
    voiceLabel: typeof o.voiceLabel === 'string' ? o.voiceLabel : '',
    lines: lines.length ? lines : [newLine('')],
    settings: parseSettings(o.settings, referenceConditioningRecommended),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
}
