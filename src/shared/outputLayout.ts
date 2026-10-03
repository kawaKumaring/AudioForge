/**
 * 만든 것을 **어디에 쌓을지** 한 곳에서 정한다.
 *
 * ★왜 바뀌었나 (2026-09-28 사용자 지시)
 *   예전 규칙은 "원본 옆" 이었다. 그런데 영상을 목소리로 쓰면 화면이 **꺼낸 wav** 를
 *   원본인 양 건네서, 결과가 `C:\…\userData\cardmedia\<지문>\` 에 쌓였다.
 *   사용자는 C 드라이브에 만들라고 한 적이 없다 — **구현이 그렇게 강제했고 몰랐던 것**이다.
 *   그래서 자리를 원본에서 떼어내고, 앱이 **자기 자리에 기능별·날짜별로 모은다.**
 *
 * ★알고 쓰는 맞바꿈
 *   앱 폴더에 쌓이므로 **앱을 지우면 산출물도 함께 사라진다.**
 *   (`workRoot.ts` 가 사용자 선택에 대해 막아 두었던 바로 그 위험이다.)
 *   그래서 자리를 바꿀 수 있어야 한다 — 고른 자리가 있으면 그쪽이 이긴다.
 *
 * 이 파일은 **경로를 고르기만** 한다. 폴더를 만들지도, 파일을 쓰지도 않는다.
 */

/** 모든 산출물이 모이는 폴더 이름. `.gitignore` 에 이미 들어 있다. */
export const OUTPUT_ROOT_DIRNAME = 'AudioForge_output'

/**
 * 기능별 폴더 이름. **사람이 읽고 바로 아는 이름**으로 둔다 —
 * 폴더를 열었을 때 `tts` 보다 `음성합성` 이 낫다.
 */
export const FEATURE_FOLDERS: Record<string, string> = {
  tts: '음성합성',
  music: '음악분리',
  conversation: '대화분리',
  'dialogue-rebuild': '대화분리',
  transcribe: '텍스트추출',
  split: '트랙분할',
  song: '노래변환',
  dub: '더빙',
}

/** 모르는 이름이 와도 폴더를 만들 수 있어야 한다 — 다만 지어내지 않고 그대로 쓴다. */
export function featureFolder(mode: string): string {
  const m = (mode || '').trim()
  if (!m) return '기타'
  return FEATURE_FOLDERS[m] || safeSegment(m) || '기타'
}

/** 폴더 이름으로 쓸 수 없는 글자를 걷어낸다. 경로로 새어 나가지 않게 한다. */
export function safeSegment(raw: string): string {
  const bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']
  let out = ''
  for (const ch of String(raw || '')) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue      // 제어문자는 버린다
    out += bad.includes(ch) ? '_' : ch
  }
  // 윈도우는 이름 끝의 점·공백을 잘라 버린다 — 먼저 정리해 어긋나지 않게 한다.
  return out.replace(/[. ]+$/, '').slice(0, 80)
}

/** `2026-09-28` 모양. 날짜만 — 시각은 마지막 칸이 갖는다. */
export function dayFolder(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/** `14-05-32` 모양. 같은 날 여러 번 돌려도 섞이지 않게 한다. */
export function timeStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`
}

/** 경로를 잇는다. 표기를 고르게 만든다(`workRoot` 와 같은 규칙). */
export function joinPath(a: string, b: string): string {
  return `${String(a).replace(/\\/g, '/').replace(/\/+$/, '')}/${b}`
}

/**
 * 어디에 쌓을 것인가 — **세 갈래뿐이다.**
 *   'app'    : 앱이 도는 자리(기본). 기능별·날짜별로 모인다.
 *   'chosen' : 사용자가 고른 자리. 구조는 'app' 과 같다.
 *   'beside' : 원본 파일 옆(예전 방식). 체크하면 이쪽이다.
 */
export type OutputPlace = 'app' | 'chosen' | 'beside'

export interface OutputPlan {
  /** 모든 산출물이 모이는 뿌리. */
  root: string
  /** 기능 폴더까지. */
  feature: string
  /** 이번 실행이 쓸 폴더(아직 만들지 않았다). */
  dir: string
}

/**
 * 이번 실행이 쓸 폴더를 정한다 — `<뿌리>/<기능>/<날짜>/<시각_이름>`.
 *
 * ★원본 경로를 보지 않는다. 그것이 이 규칙의 요점이다 —
 *   화면이 중간 산출물을 원본인 양 건네도 결과 자리가 흔들리지 않는다.
 *
 * 같은 초에 두 번 시작하면 뒤엣것이 앞엣것을 덮을 수 있으므로,
 * 이미 있으면 짧은 번호를 붙여 새 자리를 찾는다(`exists` 로 물어본다).
 */
export function planOutputDir(args: {
  /** 어디에 쌓을 것인가. */
  place: OutputPlace
  /** 사용자가 고른 자리('chosen' 일 때 쓴다. 비면 앱 자리로 물러난다). */
  chosenRoot: string
  /** 앱이 도는 자리. */
  appRoot: string
  /**
   * **진짜 원본이 있는 폴더**('beside' 일 때 쓴다).
   *
   * ★꺼낸 wav 의 폴더를 여기에 넣으면 안 된다 — 그것이 이번 결함의 원인이었다.
   *   비어 있으면 '원본 옆' 을 쓸 수 없으므로 앱 자리로 물러난다(조용히 C 로 가지 않는다).
   */
  sourceDir: string
  mode: string
  /** 폴더 이름에 쓸 원본 이름(확장자 없이). 비어 있으면 기능 이름만 쓴다. */
  name: string
  at: Date
  exists: (p: string) => boolean
}): OutputPlan {
  const label = safeSegment(args.name) || featureFolder(args.mode)
  const stem = `${timeStamp(args.at)}_${label}`
  const pick = (day: string) => {
    let dir = joinPath(day, stem)
    for (let n = 2; args.exists(dir) && n <= 100; n += 1) dir = joinPath(day, `${stem}_${n}`)
    return dir
  }

  // ★원본 옆 — **예전 모양 그대로 둔다.** 기능·날짜 칸을 끼워 넣지 않는다.
  //   본체가 이전 결과를 찾을 때 `<원본폴더>/AudioForge_output/*/session.json` 을 보기 때문이다.
  //   모양을 바꾸면 멀쩡한 옛 작업을 못 찾는다.
  if (args.place === 'beside' && (args.sourceDir || '').trim()) {
    const root = joinPath(args.sourceDir, OUTPUT_ROOT_DIRNAME)
    return { root, feature: root, dir: pick(root) }
  }

  const base = args.place === 'chosen' && (args.chosenRoot || '').trim()
    ? args.chosenRoot.trim() : args.appRoot
  const root = joinPath(base, OUTPUT_ROOT_DIRNAME)
  const feature = joinPath(root, featureFolder(args.mode))
  return { root, feature, dir: pick(joinPath(feature, dayFolder(args.at))) }
}

/** 화면에 보일 한 줄. **어디에 쌓이는지 사람이 알아야 한다.** */
export function outputRootNotice(place: OutputPlace, root: string): string {
  if (place === 'beside') return '만든 것이 원본 파일 옆에 쌓입니다.'
  if (place === 'chosen') return `만든 것이 여기에 쌓입니다: ${root}`
  return `만든 것이 앱 자리에 쌓입니다: ${root}`
}
