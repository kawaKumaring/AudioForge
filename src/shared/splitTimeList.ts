/**
 * 시간 목록 붙여넣기 — **무엇을 받아들이고 무엇을 거절하는가.**
 *
 * ★왜 화면 밖으로 꺼냈나 (2026-09-27)
 *   이 규칙이 `SplitEditor.tsx` 안에 있어 **검사할 수 없었고**, 그래서 아래 셋이 묻혀 있었다.
 *     · 정규식에 맞지 않는 줄을 **조용히 버렸다**(`if (match)` 뿐)
 *     · 같은 시각이 두 번 와도, 파일 길이를 넘겨도 그냥 받았다
 *     · 첫 시각이 0 이 아니면 **그 앞 구간이 사라졌다** — 첫 항목을 이름으로만 쓰고
 *       경계에서 빼기 때문이다
 *
 * ★이 파일이 정한 것
 *   · **한 줄이라도 잘못되면 아무것도 적용하지 않는다.** 부분 적용은 사용자가
 *     무엇이 들어갔는지 알 수 없게 만든다. 기존 편집은 그대로 둔다.
 *   · 첫 시각이 0 보다 크면 **0 부터 그 시각까지를 첫 트랙으로 남긴다.** 버리지 않는다.
 *   · 오류에는 **줄 번호**를 단다. 화면이 그 줄을 집어 줄 수 있게.
 *
 * 소리도 파일도 건드리지 않는다.
 */

/** 한 줄에서 읽어 낸 것. */
export interface TimeListEntry {
  /** 1부터 세는 줄 번호(사람이 읽는 번호). */
  line: number
  seconds: number
  label: string
}

export interface TimeListIssue {
  /** 1부터 세는 줄 번호. 줄과 무관한 문제는 0. */
  line: number
  /** 화면에 그대로 띄울 한 줄. */
  message: string
  code: 'bad_line' | 'duplicate' | 'out_of_range' | 'negative' | 'empty' | 'too_many'
}

export interface TimeListResult {
  ok: boolean
  /** 적용할 경계(초). **첫 트랙의 시작 0 은 들어 있지 않다.** */
  marks: { seconds: number; label: string }[]
  /** 첫 트랙 이름. */
  firstLabel: string
  issues: TimeListIssue[]
}

/** 한 번에 받을 수 있는 줄 수. 넘으면 거절한다(실수로 문서를 통째로 붙이는 일이 있다). */
export const MAX_LINES = 500

const TIME_LINE = /^\[?\s*(\d{1,3}):(\d{2})(?::(\d{2}))?\s*\]?\s*[-–—.)]?\s*(.*)$/

/** 사람이 읽을 시간 표기. 오류 문구에 쓴다. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(h ? m : m).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/**
 * 붙여넣은 글을 읽는다. **하나라도 잘못되면 `ok:false` 이고 `marks` 는 비어 있다.**
 *
 * @param text 사용자가 붙여넣은 글 전체
 * @param durationSeconds 원본 길이(초). 0 이면 범위 검사를 하지 않는다(아직 모를 때).
 */
export function parseTimeList(text: string, durationSeconds = 0): TimeListResult {
  const empty: TimeListResult = { ok: false, marks: [], firstLabel: '', issues: [] }
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  const issues: TimeListIssue[] = []
  const entries: TimeListEntry[] = []

  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const no = i + 1
    if (!line.trim()) continue                 // 빈 줄은 그냥 넘어간다(오류가 아니다)
    seen++
    if (seen > MAX_LINES) {
      issues.push({ line: no, code: 'too_many', message: `${no}행: 줄이 너무 많습니다(최대 ${MAX_LINES}줄)` })
      break
    }
    const m = line.match(TIME_LINE)
    if (!m) {
      // ★예전에는 여기서 **조용히 버렸다.**
      issues.push({ line: no, code: 'bad_line', message: `${no}행: 시간을 읽을 수 없습니다` })
      continue
    }
    const hasHour = !!m[3]
    const h = hasHour ? parseInt(m[1], 10) : 0
    const mi = hasHour ? parseInt(m[2], 10) : parseInt(m[1], 10)
    const se = hasHour ? parseInt(m[3], 10) : parseInt(m[2], 10)
    if (se > 59 || (hasHour && mi > 59)) {
      issues.push({ line: no, code: 'bad_line', message: `${no}행: 시간 표기가 올바르지 않습니다` })
      continue
    }
    const seconds = h * 3600 + mi * 60 + se
    if (seconds < 0) {
      issues.push({ line: no, code: 'negative', message: `${no}행: 시간이 0보다 작습니다` })
      continue
    }
    if (durationSeconds > 0 && seconds >= durationSeconds) {
      issues.push({
        line: no, code: 'out_of_range',
        message: `${no}행: 시간 범위 초과(원본 ${clockOf(durationSeconds)})`,
      })
      continue
    }
    entries.push({ line: no, seconds, label: (m[4] || '').trim() })
  }

  if (!entries.length && !issues.length) {
    return { ...empty, issues: [{ line: 0, code: 'empty', message: '읽을 수 있는 시간이 없습니다' }] }
  }

  // 같은 시각이 두 번 — 어느 쪽을 쓸지 우리가 고르지 않는다.
  const byTime = new Map<number, number>()
  for (const e of entries) {
    const first = byTime.get(e.seconds)
    if (first !== undefined) {
      issues.push({
        line: e.line, code: 'duplicate',
        message: `${e.line}행: ${clockOf(e.seconds)} 이(가) ${first}행과 겹칩니다`,
      })
    } else {
      byTime.set(e.seconds, e.line)
    }
  }

  // ★하나라도 잘못되면 **아무것도 적용하지 않는다.**
  if (issues.length) return { ok: false, marks: [], firstLabel: '', issues }

  const sorted = [...entries].sort((a, b) => a.seconds - b.seconds)

  // ★첫 시각이 0 보다 크면 **앞 구간을 버리지 않는다.**
  //   0 부터 그 시각까지가 첫 트랙이고, 첫 줄의 이름은 **그 다음 트랙**의 이름이다.
  if (sorted[0].seconds > 0) {
    return {
      ok: true,
      firstLabel: '',                                  // 화면이 기본 이름을 채운다
      marks: sorted.map((e) => ({ seconds: e.seconds, label: e.label })),
      issues: [],
    }
  }

  // 첫 시각이 0 이면 그 줄은 **첫 트랙의 이름**이고 경계가 아니다(예전 규칙 그대로).
  return {
    ok: true,
    firstLabel: sorted[0].label,
    marks: sorted.slice(1).map((e) => ({ seconds: e.seconds, label: e.label })),
    issues: [],
  }
}

/** 오류 목록을 한 줄로 간추린다. 화면이 입력창 아래에 그대로 띄운다. */
export function issuesSummary(issues: TimeListIssue[]): string {
  if (!issues.length) return ''
  const first = issues[0].message
  return issues.length > 1 ? `${first} (외 ${issues.length - 1}건)` : first
}
