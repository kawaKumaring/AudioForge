/**
 * 인물별 받아쓰기를 시간순 발언 목록에 얹는다.
 *
 * 왜 조심하는가(2026-09-27 코드 확인)
 * -----------------------------------
 * 1. 받아쓰기는 화자 트랙에서 돈다. 그 트랙은 **원본과 같은 길이**이고 다른 사람이 말한
 *    자리만 지운 것이라, 나온 시각이 원본 시간축과 같다.
 *    무음 제거(`trimSilence`)를 켜도 받아쓰기는 **자르기 전 파일**을 읽는다
 *    (`separate.py._post_process` 가 `t["path"]` 를 넘기고 `_trimmed.wav` 는 곁에만 둔다).
 * 2. ★그런데 **`.srt` 는 읽기 쉽도록 시각을 다시 매긴다**(`subtitle_cues.build_cues` 가
 *    짧은 자막을 1초까지 늘리고 긴 것을 자르고 간격을 벌린다). 그래서 자막 파일을
 *    그대로 합치면 **말한 시각이 아니다.**
 *    받아쓴 그대로가 남는 곳은 `<트랙>_timestamps.txt` 뿐이다(1초 단위).
 *
 * ★**원문을 버리지 않는다.**
 *   기준값 하나로 멀쩡한 대사를 통째로 숨기지 않는다. 자리가 분명한 줄은 그 발언에 붙이고,
 *   애매한 줄은 **'확인 필요' 로 따로 남겨** 사용자가 원문을 볼 수 있게 한다.
 *   시간을 고쳐 연결이 흐려져도 마찬가지다 — 사라지게 두지 않는다.
 *
 * ★대사는 **최초 분석의 발언 번호**에 붙는다. 그래서 나중에 그 발언을 다른 인물에게
 *   옮겨도 대사는 그 발언을 따라간다. 합치기·재배정 때문에 다시 붙이지 않는다.
 */

export interface Cue {
  start: number
  end: number
  text: string
}

/** `[0:03 → 0:07] 안녕하세요` 한 줄. 파이썬 `_save_transcription` 이 쓰는 모양 그대로다. */
const LINE = /^\[\s*(\d+):(\d{2})\s*(?:→|->|~)\s*(\d+):(\d{2})\s*\]\s*(.*)$/

/** 받아쓴 그대로의 구간 파일을 읽는다. 읽지 못한 줄은 **버리고 세어 둔다**. */
export function parseTimestampLines(text: string): { cues: Cue[]; skipped: number } {
  const cues: Cue[] = []
  let skipped = 0
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = LINE.exec(line)
    if (!m) { skipped += 1; continue }
    const start = Number(m[1]) * 60 + Number(m[2])
    const end = Number(m[3]) * 60 + Number(m[4])
    const body = m[5].trim()
    if (!body || !(end >= start)) { skipped += 1; continue }
    cues.push({ start, end, text: body })
  }
  return { cues, skipped }
}

/** 시각이 1초 단위로 적혀 있으므로 그만큼은 봐 준다. */
export const TIME_TOLERANCE_SEC = 1.0
/**
 * 이 줄이 **확실히** 그 발언의 것이라고 볼 겹침 비율.
 *
 * ★판단이지 실측이 아니다. 넘지 못한 줄을 **버리지 않고** '확인 필요' 로 남기므로,
 *   이 값이 조금 틀려도 글이 사라지지 않는다.
 */
export const SURE_OVERLAP_RATIO = 0.5

export interface CueLink {
  /** 붙인 발언 번호. 어디에도 못 붙였으면 -1. */
  index: number
  cue: Cue
  /** 자리가 분명한가. 아니면 '확인 필요'. */
  sure: boolean
}

export interface LinkResult {
  /** 발언 번호 → 확정된 대사. */
  text: Record<number, string>
  /** 발언 번호 → 확인이 필요한 대사(확정과 **섞지 않는다**). */
  unsure: Record<number, string>
  /** 어디에도 붙지 못한 줄 — 원문을 그대로 들고 있는다. */
  orphans: Cue[]
}

/**
 * 줄을 발언에 붙인다 — **겹친 시간이 가장 긴 발언** 하나에만.
 *
 * 겹침이 충분하면 확정, 모자라면 확인 필요, 아예 없으면 남겨 둔다.
 * ★겹쳐 말한 자리도 각자의 줄에 각자의 말이 남는다. 지우거나 한쪽으로 몰지 않는다.
 */
export function linkCues(cues: Cue[], segments: { index: number; start: number; end: number }[]): LinkResult {
  const text: Record<number, string> = {}
  const unsure: Record<number, string> = {}
  const orphans: Cue[] = []
  for (const c of cues) {
    let best = -1
    let bestOverlap = 0
    for (const s of segments) {
      const overlap = Math.min(c.end, s.end + TIME_TOLERANCE_SEC) - Math.max(c.start, s.start - TIME_TOLERANCE_SEC)
      if (overlap > bestOverlap) { bestOverlap = overlap; best = s.index }
    }
    if (best < 0) { orphans.push(c); continue }
    const span = Math.max(0.001, c.end - c.start)
    const bucket = bestOverlap / span >= SURE_OVERLAP_RATIO ? text : unsure
    bucket[best] = bucket[best] ? `${bucket[best]} ${c.text}` : c.text
  }
  return { text, unsure, orphans }
}

export interface TimelineNote {
  /** 이 인물의 받아쓰기를 **믿을 만한가**. 아니어도 글은 버리지 않는다. */
  trusted: boolean
  sure: number
  total: number
  /** 믿기 어려우면 왜인지. 화면이 짧은 상태로 보여 준다. */
  reason: string
}

/** 마지막 줄이 마지막 발언보다 이만큼 앞에서 끝나면 시간이 당겨진 것으로 본다. */
export const SPAN_SLACK_SEC = 2.0
export const SPAN_SLACK_RATIO = 0.15

/**
 * 이 인물의 받아쓰기가 **같은 시간축인지** 재서 알려 준다.
 *
 * ★판정 결과로 글을 숨기지 않는다. 화면이 '확인 필요' 라고 말하는 근거일 뿐이다.
 */
export function timelineNote(cues: Cue[], link: LinkResult,
  segments: { start: number; end: number }[], durationSec: number): TimelineNote {
  const total = cues.length
  const sure = Object.keys(link.text).length
  if (!total) return { trusted: false, sure: 0, total: 0, reason: '받아쓴 내용이 없습니다.' }
  if (!segments.length) return { trusted: false, sure, total, reason: '이 인물의 발언이 없습니다.' }
  const over = cues.filter((c) => c.end > durationSec + TIME_TOLERANCE_SEC).length
  if (over > 0) {
    return { trusted: false, sure, total, reason: `원본 길이를 넘는 줄 ${over}개` }
  }
  // 시간이 **앞으로 당겨졌는가**. 이 대본은 그 인물의 트랙에서 나온 것이므로,
  // 마지막 줄이 그 인물의 마지막 발언 근처여야 한다.
  const lastSeg = Math.max(...segments.map((s) => s.end))
  const lastCue = Math.max(...cues.map((c) => c.end))
  const slack = Math.max(SPAN_SLACK_SEC, lastSeg * SPAN_SLACK_RATIO)
  if (lastCue < lastSeg - slack) {
    return {
      trusted: false, sure, total,
      reason: `대본이 ${Math.round(lastCue)}초에서 끝납니다(마지막 발언 ${Math.round(lastSeg)}초) — 시간이 당겨진 듯합니다`,
    }
  }
  if (link.orphans.length || Object.keys(link.unsure).length) {
    return {
      trusted: true, sure, total,
      reason: `확인이 필요한 줄 ${link.orphans.length + Object.keys(link.unsure).length}개`,
    }
  }
  return { trusted: true, sure, total, reason: '' }
}

/** 받아쓴 그대로가 남는 파일 이름 — `.srt` 가 아니다(위 설명 참고). */
export const rawTimestampFile = (trackName: string): string => `${trackName}_timestamps.txt`
