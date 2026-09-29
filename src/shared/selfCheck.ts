/**
 * 기능 검사 — **기능별로 눌러 그 기능만** 확인한다.
 *
 * ★지시 (2026-09-30): "검사 기능을 각각 분리해서 따로 검사할 수 있게, 설정에서 기능 검사 탭을 따로 만든 뒤
 *   각 기능별 검사 버튼을 만든 후 사용자가 눌러 봤을 때 검사를 진행한 뒤 문제가 없을 때 색상, 문제가 있을 시
 *   붉은색의 아이콘." 전체를 한 번에 돌리는 단추는 두지 않는다 — 안 되는 기능만 누른다.
 * ★개발용 검사(test/)와 다르다. 이것은 **이 PC 에서 그 기능이 지금 실제로 도는가**를 본다.
 *   사용자 파일을 쓰지 않는다 — 앱 안 검사 자리에서 하고 끝나면 지운다.
 */

export type CheckId = 'python' | 'ffmpeg' | 'models' | 'reader-builtin' | 'reader-reference' | 'settings' | 'log'

export interface CheckInfo {
  id: CheckId
  /** 기능 이름 — 쉬운 말로. */
  label: string
  /** 무엇을 해 보는가. */
  what: string
  /** 오래 걸리는가(GPU 를 쓰는 등). 화면이 미리 말한다. */
  slow?: string
}

export const CHECKS: readonly CheckInfo[] = [
  { id: 'python', label: '파이썬', what: '앱이 쓰는 파이썬이 있고 실행되는지' },
  { id: 'ffmpeg', label: 'ffmpeg', what: '소리·영상을 읽고 바꾸는 도구가 실행되는지' },
  { id: 'models', label: '모델 파일', what: '기본 목소리와 참조 목소리 모델 파일이 빠짐없이 있는지(불러오지는 않음)' },
  { id: 'reader-builtin', label: '낭독 · 기본 목소리', what: '기본 목소리로 한 문장을 실제로 만들어 보는지' },
  { id: 'reader-reference', label: '낭독 · 참조 목소리', what: '기본 목소리로 만든 말소리를 참조로 한 문장을 만들어 보는지', slow: 'GPU · 1분 안팎' },
  { id: 'settings', label: '설정 저장·읽기', what: '설정 파일에 써 보고 다시 읽히는지' },
  { id: 'log', label: '동작 기록', what: '기록이 파일과 콘솔에 남는지' },
] as const

export interface CheckResult {
  id: CheckId
  ok: boolean
  /** 한 줄 — 통과면 무엇을 확인했는지, 실패면 왜인지. 경로·글 내용은 넣지 않는다. */
  reason: string
  ms: number
  /** ISO 시각. */
  at: string
}

export function checkInfo(id: string): CheckInfo | undefined {
  return CHECKS.find((c) => c.id === id)
}

/** 한 결과를 기록 한 줄로. */
export function resultLine(r: CheckResult): string {
  const c = checkInfo(r.id)
  return `${c?.label ?? r.id} ${r.ok ? '통과' : '실패'} (${(r.ms / 1000).toFixed(1)}s) — ${r.reason}`
}

/**
 * **문제 보고용 복사** — 검사 결과와 최근 동작 기록을 한 번에.
 * ★사용자는 이것 하나만 붙여 넣으면 된다. 돌리지 않은 검사는 "안 돌림" 이라고 적는다 —
 *   빠진 것을 통과로 읽지 않게.
 */
export function formatReport(results: readonly CheckResult[], lines: readonly string[], head: string): string {
  const byId = new Map(results.map((r) => [r.id, r]))
  const out = [head, '', '[기능 검사]']
  for (const c of CHECKS) {
    const r = byId.get(c.id)
    out.push(r ? `${r.ok ? '●' : '✕'} ${resultLine(r)} · ${r.at.slice(11, 19)}` : `○ ${c.label} 안 돌림`)
  }
  out.push('', `[최근 동작 기록 ${lines.length}건]`, ...lines)
  return out.join('\n')
}
