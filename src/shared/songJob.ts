/**
 * 노래 변환 — **무엇을 보내고 무엇을 받는가.** 판단만 한다(파일도 파이썬도 모른다).
 *
 * ★사슬 자체는 이미 있다(`python/song_chain.py`, 실제 곡으로 완주한 이력).
 *   이 파일은 그 사슬을 화면에 잇기 위한 **계약**만 정한다. 사슬을 다시 만들지 않는다.
 */
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자.
import { sameFileTarget, type PathProbe } from './joinOutputGuard.ts'

/** 원곡·목소리로 고른 파일 하나. */
export interface SongInput {
  path: string
  name: string
  duration: number
}

/** 화면이 보내는 요청. **요청 시점에 굳힌 값**이다. */
export interface SongRequest {
  /** 이 요청의 식별자. 진행·결과·오류를 이것으로 대조한다. */
  clientRequestId: string
  source: SongInput
  voice: SongInput
  /** 주보컬/화음 2차 가르기. 기본 꺼짐 — 켜면 말이 사라지는 곡이 있다(실측). */
  splitLead: boolean
}

/**
 * 결과 계약. **요청 시점의 입력과 실제로 쓴 값을 함께** 들고 온다.
 *
 * ★왜 입력 스냅샷까지 담는가: 결과만 있으면 "무엇으로 만든 소리인가" 를 답할 수 없다.
 *   카드 쪽에서 같은 이유로 데인 자리다(2026-09-27 저장 왕복 결함).
 */
export interface SongResult {
  clientRequestId: string
  /** 요청 시점의 입력 그대로. */
  input: { source: SongInput; voice: SongInput; splitLead: boolean }
  /** 반주 + 바뀐 목소리. **사용자에게 내놓는 것은 이것이다.** */
  mixPath: string
  /**
   * 이 요청의 원곡을 **디코딩할 수 있는 소리**로 꺼낸 것(영상이면 꺼낸 wav).
   * 결과 화면이 원곡과 변환본을 같은 시간 기준으로 견주는 데 쓴다.
   */
  sourceAudioPath: string
  /** 바뀐 보컬만(반주 없음). */
  vocalPath: string
  /** 화음까지 되살린 것. 2차 가르기를 켰을 때만 있다. */
  withHarmonyPath?: string
  /** 참조로 **실제로 쓴 토막**. 원본의 어디를 썼는지까지 남긴다. */
  reference: {
    clipPath: string
    fromPath: string
    startSec: number
    durationSec: number
    /** 원본이 짧아 통째로 썼는가. */
    wholeFile: boolean
  }
  /** 실행 설정 — 되풀이 단계·옥타브 이동·음높이 같은 것. */
  settings: Record<string, unknown>
  workDir: string
}

/**
 * 내부 키 → **사용자에게 보일 이름.**
 *
 * ★`화음없이` 를 그대로 보여 주지 않는다(2026-09-27 지시).
 *   2차 가르기가 기본 꺼짐이라 **화음을 완전히 제거한 것이 아니다.**
 *   반주에 섞인 화음은 그대로 남아 있고, 보컬 트랙 전체가 바뀐 목소리로 갈렸을 뿐이다.
 */
export const RESULT_LABEL = {
  mix: '변환 음원',
  vocal: '변환 보컬만',
  withHarmony: '원래 화음까지',
} as const

/** 화음 표현에 쓰는 설명. 과장하지 않기 위해 한 곳에 둔다. */
export const HARMONY_NOTE =
  '보컬 전체를 바꾼 결과입니다. 화음을 따로 걷어내지 않았습니다.'

/** 파일 이름에서 폴더 이름으로 쓸 수 없는 글자를 걷어낸다. */
export function safeFolderName(name: string, max = 40): string {
  const base = String(name || '').replace(/\.[^.]{1,8}$/, '')
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || '노래').slice(0, max)
}

/**
 * 이 실행의 작업 폴더 이름.
 *
 * ★같은 곡을 **연속으로** 돌려도 부딪히지 않아야 한다(2026-09-27 지시 1).
 *   시각만 붙이면 같은 초에 두 번 누를 때 같은 이름이 나온다. 그래서 요청 식별자의
 *   앞 토막을 함께 붙인다 — 요청마다 다르고, 나중에 기록과 맞춰 볼 수도 있다.
 */
export function songWorkFolderName(sourceName: string, stamp: string, reqId: string): string {
  const tail = String(reqId || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 6) || 'run'
  return `${safeFolderName(sourceName)}_${stamp}_${tail}`
}

/** 이 요청을 보낼 수 있는가. 보낼 수 있으면 빈 문자열. */
export function songRequestFault(req: {
  source: SongInput | null; voice: SongInput | null
}): string {
  if (!req.source?.path) return '원곡을 고르세요'
  if (!req.voice?.path) return '목소리를 고르세요'
  if (sameByPath(req.source.path, req.voice.path)) {
    return '원곡과 목소리가 같은 파일입니다. 다른 파일을 고르세요.'
  }
  return ''
}

const sameByPath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * 최종 내보내기 자리가 **덮으면 안 되는 파일**인가. 쓸 수 있으면 빈 문자열.
 *
 * ★원곡·참조 음원·생성 결과 어느 것도 덮지 않는다(2026-09-27 지시 5).
 *   이름이 달라도 같은 파일이면 막는다 — 대소문자·구분자·상대 경로·하드링크.
 *   판정 자체는 `joinOutputGuard` 의 것을 그대로 쓴다(규칙을 두 벌로 만들지 않는다).
 */
export function songExportFault(
  output: string,
  guarded: { label: string; path: string }[],
  probe: PathProbe,
): string {
  const out = String(output || '').trim()
  if (!out) return '저장할 자리를 알 수 없습니다'
  for (const item of guarded) {
    const p = String(item?.path || '').trim()
    if (!p) continue
    if (sameFileTarget(out, p, probe)) {
      return `${item.label} 파일 위에 저장할 수 없습니다. 다른 이름을 고르세요.`
    }
  }
  return ''
}

/** 결과가 들고 있는, 덮으면 안 되는 파일들. 화면이 이것을 그대로 넘긴다. */
export function guardedFilesOf(r: SongResult): { label: string; path: string }[] {
  const list = [
    { label: '원곡', path: r.input.source.path },
    // ★영상에서 꺼낸 비교용 원곡 소리. 이것을 덮으면 **원곡/변환본 비교 재생이 깨진다**
    //   (2026-09-27 지시 3). 사용자가 고른 원본과 다른 파일이므로 따로 적어야 한다.
    { label: '비교용 원곡 소리', path: r.sourceAudioPath },
    { label: '목소리', path: r.input.voice.path },
    { label: '참조 클립', path: r.reference.clipPath },
    { label: RESULT_LABEL.mix, path: r.mixPath },
    { label: RESULT_LABEL.vocal, path: r.vocalPath },
  ]
  if (r.withHarmonyPath) list.push({ label: RESULT_LABEL.withHarmony, path: r.withHarmonyPath })
  return list.filter((x) => !!x.path)
}

/** 진행 보고 한 줄. 파이썬이 보내는 것을 그대로 옮긴 모양이다. */
export interface SongProgress {
  clientRequestId?: string
  percent?: number
  message?: string
}

/**
 * 이 진행·결과가 **내가 기다리는 요청의 것인가.** 아니면 사유를 돌려준다.
 * (카드 쪽 `cardEventFault` 와 같은 계약 — 늦게 온 응답이 화면을 흔들지 않게 한다.)
 */
export function songEventFault(event: unknown, reqId: string): string {
  if (!reqId) return '기다리는 요청이 없습니다'
  const got = (event as { clientRequestId?: unknown } | null | undefined)?.clientRequestId
  if (typeof got !== 'string' || !got) return '이 화면의 요청이 아닙니다(식별자 없음)'
  if (got !== reqId) return '이미 지난 요청의 응답입니다'
  return ''
}
