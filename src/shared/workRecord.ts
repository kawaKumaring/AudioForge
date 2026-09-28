/**
 * 작업 기록 하나 = **파일 하나.**
 *
 * ★왜 (2026-09-28 지시)
 * > "셋팅.json 에 저장하는게 아닌 생성한 파일마다 정보를 따로 가지고있어서
 * >  그 파일만 삭제하게 하도록한다"
 *
 *   지금까지는 아홉 갈래의 작업 기록이 `settings.json` **한 장**에 들어 있었다.
 *   그래서 하나를 지우려 해도 파일 전체를 다시 쓰고, 그 파일을 들고 있는 화면이
 *   여덟 개라 **누군가 옛 내용을 도로 써 넣으면 되살아났다.** 실제로 그렇게 됐다.
 *
 *   기록마다 파일이 따로면 지우기는 **그 파일 하나를 지우는 일**이 된다.
 *   남의 기록을 건드릴 길이 아예 없다.
 *
 * 이 파일은 **이름과 자리 규칙만** 갖는다. 실제 읽기·쓰기는 본체가 한다.
 * (규칙을 여기 두면 화면·본체·검사가 같은 답을 본다.)
 */

/** 기록이 사는 폴더 이름 — 앱 데이터 자리 아래. */
export const WORK_DIR_NAME = 'works'

/**
 * 기록의 갈래. **폴더 이름이 되므로** 사람이 읽을 수 있는 짧은 말로 둔다.
 *
 * ★갈래를 늘릴 때는 여기만 고친다. 목록이 한 곳이라 비우기·옮기기가 같이 따라온다.
 */
export const WORK_KINDS = [
  'cards',       // 생성 카드 작업
  'lab',         // 옛 작업실
  'drafts',      // 현재 작업 자동 저장
  'dialogue',    // 대화 구간 교정 (파일별)
  'transcript',  // 전사 교정 (파일별)
] as const
export type WorkKind = (typeof WORK_KINDS)[number]

/** 옛 `settings.json` 열쇠 → 새 갈래. 옮길 때 이 표만 본다. */
export const LEGACY_KEY_OF: Record<WorkKind, string[]> = {
  cards: ['synthesisCards'],
  lab: ['labWorkspace'],
  drafts: ['workDrafts'],
  dialogue: ['dialogueDrafts', 'dialogueEdits'],
  transcript: ['transcriptDrafts', 'transcriptEdits'],
}

export function isWorkKind(v: unknown): v is WorkKind {
  return typeof v === 'string' && (WORK_KINDS as readonly string[]).includes(v)
}

/**
 * 기록의 **열쇠를 파일 이름으로** 바꾼다.
 *
 * ★열쇠에는 원본 경로가 들어간다 — `C:\소리\말.wav\u001f본문` 같은 모양이다.
 *   그대로 파일 이름에 쓸 수 없고, 쓸 수 있게 깎으면 **서로 다른 열쇠가 같은 이름**이
 *   될 수 있다(대소문자만 다르거나, 못 쓰는 글자만 다른 경우).
 *   그래서 **깎은 이름 + 열쇠의 지문**을 함께 쓴다 — 읽기 쉽고 겹치지 않는다.
 */
export function fileNameOf(key: string): string {
  const raw = String(key ?? '')
  const safe = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')   // 경로·제어 글자를 없앤다
    .replace(/[. ]+$/, '')                         // 윈도우는 끝의 점·공백을 버린다
    .slice(-60)                                    // 이름이 길면 경로 상한에 걸린다
    || '_'
  return `${safe}.${fingerprint(raw)}.json`
}

/**
 * 열쇠의 지문 — 짧고 겹치지 않게.
 *
 * ★암호용이 아니다. 같은 폴더 안에서 열쇠를 구분하기만 하면 된다.
 */
export function fingerprint(key: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12)
}

/** 파일 이름이 우리 것인가. 남의 파일을 지우지 않으려고 본다. */
export function isWorkFile(name: string): boolean {
  return /^.+\.[0-9a-z]{1,12}\.json$/i.test(name) && !name.startsWith('.')
}

/** 한 기록이 파일에 담기는 모양. */
export interface WorkRecord<T = unknown> {
  /** 무엇의 기록인가 — 갈래 안에서 이 열쇠가 하나뿐이다. */
  key: string
  /** 마지막으로 손댄 때(밀리초). 목록을 최근 순으로 세울 때 쓴다. */
  updatedAt: number
  /** 기록 본문. 갈래마다 모양이 다르다 — 여기서는 해석하지 않는다. */
  data: T
}

export function makeRecord<T>(key: string, data: T, at: number): WorkRecord<T> {
  return { key: String(key ?? ''), updatedAt: at, data }
}

/** 파일에서 읽은 것이 기록 모양인가. 아니면 null — **빈 기록으로 꾸미지 않는다.** */
export function parseRecord(raw: unknown): WorkRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.key !== 'string' || !r.key) return null
  if (!('data' in r)) return null
  const at = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0
  return { key: r.key, updatedAt: at, data: r.data }
}

/**
 * 옛 `{열쇠 → 기록}` 한 덩어리를 **기록 여럿으로** 가른다.
 *
 * ★옮길 때 내용을 해석하지 않는다. 모양을 바꾸면 무엇이 달라졌는지 알 수 없다.
 */
export function splitLegacyMap(raw: unknown, at: number): WorkRecord[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const box = raw as Record<string, unknown>
  const inner = (box.drafts && typeof box.drafts === 'object' && !Array.isArray(box.drafts))
    ? box.drafts as Record<string, unknown>
    : box
  const out: WorkRecord[] = []
  for (const [key, data] of Object.entries(inner)) {
    if (!key || data === undefined) continue
    if (key === 'version') continue
    const savedAt = (data && typeof data === 'object' && !Array.isArray(data)
      && typeof (data as Record<string, unknown>).updatedAt === 'number')
      ? (data as Record<string, number>).updatedAt : at
    out.push({ key, updatedAt: savedAt, data })
  }
  return out
}

/** 갈래 하나가 통째로 한 기록인 경우(카드 작업실 등)의 열쇠. */
export const SINGLE_KEY = 'current'
