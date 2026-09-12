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
}

/** 제품 기본값 — app.store 의 초기값과 같은 값이다(합성 탭의 현재 값이 아니다). */
export function defaultSettings(referenceConditioningRecommended: string): LabSettings {
  return {
    speed: 1.0, silenceGap: 0.5, pitch: 0.0,
    engine: 'auto', qwenModel: '',
    referenceConditioningMode: referenceConditioningRecommended,
    refTargetSec: 0,
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

export interface ExportReadiness {
  ready: boolean
  /** 순서대로 이어 붙일 파일들. ready 가 아니면 비어 있다. */
  paths: string[]
  /** 막고 있는 자리들 — 몇 번째 줄이 왜 안 되는지. */
  blocking: { index: number; status: LineStatus; text: string }[]
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
    const s = lineStatus(l, vk)
    if (s === 'empty') { skippedEmpty += 1; return }
    if (s === 'ready') {
      const t = adoptedTake(l)
      if (t) { paths.push(t.path); return }
    }
    blocking.push({ index: i, status: s, text: l.text })
  })
  return { ready: blocking.length === 0 && paths.length > 0, paths, blocking, skippedEmpty }
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
