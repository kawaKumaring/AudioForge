/**
 * 낭독 작업 하나를 돌리는 **판단들** — Electron 없이 검사할 수 있게 떼어 둔다.
 *
 * ★2026-09-30 사용자 신고: "기본음성 참조 목소리 둘 다 안 된다", "붉은색으로 경로가 빠르게
 *   보였다 사라진다". 재현으로 찾은 세 가지가 여기 규칙이 됐다.
 *   1) 둘이 동시에 돌면 같은 자리·같은 이름에 쓰다가 하나가 죽었다 → **줄**(`createLane`)과 제 폴더
 *   2) 참조 목소리인데 입력 칸을 비워 보내 곧바로 거절당했다 → `readerRunConfig`
 *   3) 실패하면 실행 명령줄("Command failed: E:\…")이 화면에 떴다 → `failureReason`
 */
// ★확장자를 붙인다 — `node --test` 가 이 파일을 곧바로 읽는다(dub-job 과 같은 관례).
// @ts-ignore TS5097
import { scrubPathsForLog } from './log-scrub.ts'

export interface ReaderRunVoice {
  kind: 'builtin' | 'reference'
  path: string
  engineId?: string
}

/**
 * 차례대로 하나씩 — 앞 작업이 끝나야 다음이 시작한다. 앞의 실패는 다음을 막지 않는다.
 */
export function createLane(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job)
    tail = next.catch(() => { /* 다음 차례는 앞의 실패와 무관하다 */ })
    return next
  }
}

/** 파이썬이 내보낸 JSON 줄들. JSON 이 아닌 줄은 버린다. */
export function jsonLines(stdout: unknown): Array<Record<string, unknown>> {
  return String(stdout ?? '').split(/\r?\n/).map((l) => {
    try { return JSON.parse(l) as unknown } catch { return null }
  }).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o))
}

/** 파이썬이 **스스로 말한 사유** — 마지막 오류 한 줄. 없으면 빈 글. */
export function pythonReason(lines: Array<Record<string, unknown>>): string {
  const errs = lines.filter((o) => o.type === 'error' && typeof o.message === 'string')
  return errs.length ? String(errs[errs.length - 1].message) : ''
}

/** 만들어진 소리 파일 — 마지막으로 보고한 트랙. */
export function madeTrack(lines: Array<Record<string, unknown>>): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].tracks
    if (Array.isArray(t) && t.length && typeof (t[0] as { path?: unknown })?.path === 'string') {
      return (t[0] as { path: string }).path
    }
  }
  return ''
}

/**
 * 사용자에게 보일 실패 사유 한 줄.
 *
 * ★순서: 멈춤(시간 초과) → 파이썬이 말한 사유 → 우리가 던진 문구 → 일반 문구.
 * ★실행 명령줄은 **절대 보이지 않는다** — 사유가 아니고, 폴더 경로가 드러난다.
 * ★남은 경로는 파일 이름만 남긴다(파이썬 사유에도 경로가 들어 있을 수 있다 — WinError 32 가 그랬다).
 */
export function failureReason(err: unknown): string {
  const e = (err ?? {}) as { stdout?: unknown; killed?: boolean; message?: unknown }
  if (e.killed) return '너무 오래 걸려 멈췄습니다'
  const fromPython = pythonReason(jsonLines(e.stdout))
  const own = typeof e.message === 'string' && !/^Command failed/.test(e.message) ? e.message : ''
  return scrubPathsForLog(fromPython || own || '이 부분을 소리로 만들지 못했습니다')
}

/**
 * 파이썬에 넘길 설정.
 *
 * ★참조 목소리는 **그 파일이 입력**이다. 비우면 "입력 파일과 출력 경로가 필요합니다" 로 곧바로
 *   거절당한다. 기본 목소리는 참조가 없으므로 비운다(파이썬이 그때만 비움을 허락한다).
 */
export function readerRunConfig(body: string, v: ReaderRunVoice, runDir: string): Record<string, unknown> {
  return {
    mode: 'tts',
    input: v.kind === 'reference' ? v.path : '',
    output: runDir, ttsText: body,
    ttsEngine: v.kind === 'builtin' ? (v.engineId || 'piper') : undefined,
    ttsBuiltinModel: v.kind === 'builtin' ? v.path : undefined,
    ttsReferenceOverride: v.kind === 'reference' ? v.path : '',
    ttsSpeed: 1.0, ttsSilenceGap: 0.35, ttsPitch: 0.0,
    ttsTailMode: 'auto', ttsTailPaddingMs: 120, ttsTailFadeMs: 8,
    ttsSpeakerMode: 'single',
  }
}
