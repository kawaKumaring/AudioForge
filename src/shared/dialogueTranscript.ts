/**
 * 인물별 받아쓰기를 시간순 발언 목록에 얹는다 — **시간축이 같을 때만.**
 *
 * 왜 그냥 합치면 안 되는가(2026-09-27 코드 확인)
 * ---------------------------------------------
 * 1. 받아쓰기는 화자 트랙에서 돈다. 그 트랙은 **원본과 같은 길이**이고 다른 사람이 말한
 *    자리만 지운 것이라, 나온 시각이 원본 시간축과 같다.
 *    무음 제거(`trimSilence`)를 켜도 받아쓰기는 **자르기 전 파일**을 읽는다
 *    (`separate.py._post_process` 가 `t["path"]` 를 넘기고 `_trimmed.wav` 는 곁에만 둔다).
 * 2. ★그런데 **`.srt` 는 읽기 쉽도록 시각을 다시 매긴다**(`subtitle_cues.build_cues` 가
 *    짧은 자막을 1초까지 늘리고 긴 것을 자르고 간격을 벌린다). 그래서 자막 파일을
 *    그대로 합치면 **말한 시각이 아니다.**
 *    받아쓴 그대로가 남는 곳은 `<트랙>_timestamps.txt` 뿐이다(1초 단위).
 * 3. 그래도 믿고 넘어가지 않는다 — 줄이 그 화자의 구간 안에 실제로 들어가는지 **재고**,
 *    적게 맞으면 합치지 않고 사유를 말한다.
 *
 * ★겹친 발언을 지우거나 한 사람에게 몰지 않는다. 각 화자의 받아쓰기는 **그 화자의 구간**
 *   에만 붙는다. 두 사람이 동시에 말한 자리는 양쪽 줄에 각자의 말이 남는다.
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
 * 몇 줄이 제자리에 들어가야 '시간축이 같다' 고 볼 것인가.
 *
 * ★이 값은 **판단**이지 실측이 아니다. 우리 자료로 잰 적이 없다.
 *   낮게 잡으면 어긋난 대본을 붙이고, 높게 잡으면 멀쩡한 대본을 버린다.
 */
export const TIMELINE_MATCH_MIN = 0.6

/** 마지막 줄이 마지막 발언보다 이만큼 앞에서 끝나면 시간이 당겨진 것으로 본다. */
export const SPAN_SLACK_SEC = 2.0
export const SPAN_SLACK_RATIO = 0.15

export interface TimelineVerdict {
  ok: boolean
  matched: number
  total: number
  /** ok 가 아니면 왜인지. 화면이 그대로 보여 준다. */
  reason: string
}

/**
 * 이 받아쓰기를 이 화자의 구간에 얹어도 되는가 — **재서** 정한다.
 *
 * 무음 제거로 시간이 당겨진 결과라면 줄들이 앞쪽에 몰려 구간 밖으로 나가므로 여기서 걸린다.
 */
export function checkTimeline(cues: Cue[], segments: { start: number; end: number }[],
  durationSec: number): TimelineVerdict {
  const total = cues.length
  if (!total) return { ok: false, matched: 0, total: 0, reason: '받아쓴 내용이 없습니다.' }
  if (!segments.length) return { ok: false, matched: 0, total, reason: '이 인물의 구간이 없습니다.' }
  const over = cues.filter((c) => c.end > durationSec + TIME_TOLERANCE_SEC).length
  if (over > 0) {
    return { ok: false, matched: 0, total, reason: `원본 길이를 넘는 줄이 ${over}개 있습니다.` }
  }
  // ★시간이 **앞으로 당겨졌는가**. 이 대본은 그 인물의 트랙에서 나온 것이므로,
  //   마지막 줄이 그 인물의 마지막 구간 근처여야 한다. 한참 앞에서 끝났다면 무음을
  //   걷어낸 파일 등 **다른 시간축**의 결과다. (뒷말을 못 알아들은 경우까지 막지 않도록
  //   15%+2초는 봐 준다.)
  const lastSeg = Math.max(...segments.map((s) => s.end))
  const lastCue = Math.max(...cues.map((c) => c.end))
  const slack = Math.max(SPAN_SLACK_SEC, lastSeg * SPAN_SLACK_RATIO)
  if (lastCue < lastSeg - slack) {
    return {
      ok: false, matched: 0, total,
      reason: `받아쓴 대본이 ${Math.round(lastCue)}초에서 끝납니다(마지막 발언은 ${Math.round(lastSeg)}초). `
        + '시간이 당겨진 결과로 보입니다.',
    }
  }
  let matched = 0
  for (const c of cues) {
    const mid = (c.start + c.end) / 2
    const hit = segments.some((s) => mid >= s.start - TIME_TOLERANCE_SEC && mid <= s.end + TIME_TOLERANCE_SEC)
    if (hit) matched += 1
  }
  if (matched / total < TIMELINE_MATCH_MIN) {
    return {
      ok: false, matched, total,
      reason: `받아쓴 시각이 구간과 맞지 않습니다(${matched}/${total}). 시간이 바뀐 결과로 보입니다.`,
    }
  }
  return { ok: true, matched, total, reason: '' }
}

/**
 * 줄을 구간에 붙인다 — **겹친 시간이 가장 긴 구간** 하나에만.
 *
 * 어디에도 붙지 않는 줄은 버리지 않고 세어 돌려준다(조용히 사라지지 않게).
 */
export function assignCues(cues: Cue[], segments: { index: number; start: number; end: number }[]):
  { text: Record<number, string>; unplaced: number } {
  const text: Record<number, string> = {}
  let unplaced = 0
  for (const c of cues) {
    let best = -1
    let bestOverlap = 0
    for (const s of segments) {
      const overlap = Math.min(c.end, s.end + TIME_TOLERANCE_SEC) - Math.max(c.start, s.start - TIME_TOLERANCE_SEC)
      if (overlap > bestOverlap) { bestOverlap = overlap; best = s.index }
    }
    if (best < 0) { unplaced += 1; continue }
    text[best] = text[best] ? `${text[best]} ${c.text}` : c.text
  }
  return { text, unplaced }
}

/** 받아쓴 그대로가 남는 파일 이름 — `.srt` 가 아니다(위 설명 참고). */
export const rawTimestampFile = (trackName: string): string => `${trackName}_timestamps.txt`
