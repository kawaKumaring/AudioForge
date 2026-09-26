/**
 * 작업 폴더를 **어디에 둘지** 한 곳에서 정한다.
 *
 * ★왜 생겼나 (2026-09-26 사용자 신고: "왜 자꾸 C 드라이브에다 생산시키는건가")
 *   더빙 작업 폴더가 앱 데이터 폴더로 **코드에 박혀 있었다.** 윈도우에서 그 자리는
 *   시스템 드라이브다. 옮길 설정도 없었다.
 *   곡 하나에 약 100MB — 꺼낸 소리 34MB · 갈라낸 보컬 31MB · 반주 31MB · 줄 소리들.
 *   실측으로 이미 535MB 가 쌓여 있었다. 사용자 음원은 다른 드라이브에 있는데
 *   **산출물만 시스템 드라이브에 쌓이는 구조**였다.
 *
 * ★이미 쌓인 것을 옮기지 않는다
 *   535MB 를 옮기다 중간에 실패하면 작업을 잃는다. 대신 **옛 자리도 계속 본다** —
 *   새 작업은 고른 자리에, 옛 작업은 있던 자리에서 그대로 열린다.
 *   옮기고 싶으면 사람이 파일 탐색기로 옮기면 된다(그 뒤에도 규칙이 알아서 찾는다).
 *
 * 이 파일은 **경로를 고르기만** 한다. 폴더를 만들지도, 파일을 옮기지도 않는다.
 */

/** 고른 자리를 쓸 수 없는 이유. 쓸 수 있으면 빈 문자열. */
export function workRootBlockReason(
  chosen: string,
  opts: { exists: (p: string) => boolean; appDir?: string },
): string {
  const p = (chosen || '').trim()
  if (!p) return '폴더를 고르세요.'
  if (!opts.exists(p)) return '그 폴더가 없습니다. 다른 자리를 고르세요.'
  // ★앱 안에 두면 저장소가 산출물로 더러워지고, 앱을 지울 때 작업도 함께 사라진다.
  //   이날 실제로 앱 폴더 안에 모델 캐시 2.4GB 가 쏟아진 일이 있다.
  const app = opts.appDir ? norm(opts.appDir) : ''
  if (app && norm(p).startsWith(app)) {
    return '앱이 설치된 자리에는 둘 수 없습니다 — 앱을 지울 때 작업도 함께 사라집니다.'
  }
  return ''
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 경로를 잇는다. **표기를 고르게 만든다** — 역슬래시와 끝 슬래시를 정리한다.
 *
 * ★섞인 표기를 그대로 두면 같은 자리를 다른 자리로 본다.
 *   그러면 '옛 자리 찾기' 가 어긋나 멀쩡한 작업을 못 찾는다(검사가 이것을 잡았다).
 *   윈도우도 빗금 경로를 그대로 받는다.
 */
const join = (a: string, b: string) =>
  `${a.replace(/\\/g, '/').replace(/\/+$/, '')}/${b}`

/**
 * 이 영상의 작업 폴더가 **실제로 어디 있는가.**
 *
 * 규칙: 고른 자리에 있으면 그것, 없고 옛 자리에 있으면 옛 자리, 둘 다 없으면 고른 자리.
 * ★옛 자리를 먼저 지우지 않는 이유는 위 머리말에 적었다 — 옮기다 잃는 것이 더 나쁘다.
 */
export function resolveWorkDir(args: {
  /** 사용자가 고른 자리(비어 있으면 기본을 쓴다). */
  chosenRoot: string
  /** 앱 기본 자리(지금까지 쓰던 곳). */
  defaultRoot: string
  /** 이 영상의 폴더 이름. */
  folder: string
  exists: (p: string) => boolean
}): { dir: string; root: string; legacy: boolean } {
  const root = (args.chosenRoot || '').trim() || args.defaultRoot
  const here = join(join(root, 'dub'), args.folder)
  if (args.exists(here)) return { dir: here, root, legacy: false }

  const old = join(join(args.defaultRoot, 'dub'), args.folder)
  // 고른 자리와 기본이 같으면 '옛 자리' 라는 개념이 없다.
  if (norm(root) !== norm(args.defaultRoot) && args.exists(old)) {
    return { dir: old, root: args.defaultRoot, legacy: true }
  }
  return { dir: here, root, legacy: false }
}

/** 새 작업이 놓일 자리. 고른 것이 없으면 기본. */
export function workRootOf(chosenRoot: string, defaultRoot: string): string {
  return (chosenRoot || '').trim() || defaultRoot
}

/** 화면에 보일 한 줄. **어디에 쌓이는지 사람이 알아야 한다.** */
export function workRootNotice(root: string, legacy: boolean): string {
  if (legacy) return '이 작업은 예전 자리에서 열었습니다 — 새 작업은 고른 자리에 쌓입니다.'
  return `만든 것이 여기에 쌓입니다: ${root}`
}
