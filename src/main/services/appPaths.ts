/**
 * 앱의 **자리**를 정하는 한 곳.
 *
 * ★왜 모았나 (2026-09-28)
 *   같은 계산(`join(__dirname, '..', '..')`)이 `audio.ipc` 와 `options.ipc` 두 곳에
 *   따로 있었다. 한쪽만 고치면 **설정 화면이 말하는 자리와 실제로 쌓이는 자리가
 *   갈린다** — 사용자는 화면을 믿는데 파일은 다른 곳에 있다.
 *
 * 두 가지는 **다른 질문**이라 함수도 둘이다.
 *   · `realAppRoot()`  — 앱이 실제로 깔린 자리. "여기에는 결과를 두지 마세요" 판정용.
 *   · `outputBase()`   — 결과를 쌓을 자리의 뿌리. 검사는 자기 격리 자리로 간다.
 */
import { join } from 'path'

/** 앱이 실제로 깔린 자리. **검사 여부와 무관하다.** */
export function realAppRoot(here: string): string {
  return join(here, '..', '..')
}

/**
 * 결과를 쌓을 뿌리.
 *
 * ★검사도 **똑같이** 앱 자리에 쌓는다.
 *
 *   2026-09-28 에 "검사 산출물이 결과 폴더를 어지럽힌다" 를 고치려고 검사만
 *   다른 자리에 쌓게 해 봤다. **틀린 수였다** — 그러면 `output-location` 검사가
 *   확인하려던 바로 그 규칙("기본 자리는 앱 폴더")을 검사 환경에서 확인할 수 없다.
 *   자리 문제가 이 프로젝트에서 가장 중요한 항목인데, 그것을 지키는 검사를
 *   눈뜬장님으로 만드는 셈이다.
 *
 *   어지럽히는 문제는 **치우는 쪽**에서 푼다 — `test/e2e/_e2e-helper.mjs` 가
 *   검사 중에 생긴 결과 폴더를 끝나고 지운다.
 */
export function outputBase(here: string, _env?: Record<string, string | undefined>): string {
  return realAppRoot(here)
}

/** 경로 비교용 정규화 — 구분자·대소문자·끝 구분자를 없앤다. */
function norm(p: string): string {
  return (p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * `child` 가 `parent` **안**에 있는가.
 *
 * ★앞부분만 견주면 안 된다 (2026-09-28 실측으로 찾음)
 *   `.../데이터` 와 `.../데이터-output` 은 앞부분이 같다. 그냥 `startsWith` 로 보면
 *   **옆 폴더를 안에 있다고 판정한다.** 그러면 원본 자리 판정이 무너지고 결과가
 *   엉뚱한 데로 흘러내린다 — 그것이 이번에 신고된 결함의 뿌리와 같은 모양이다.
 *   구분자까지 붙여서 견줘야 '안' 이다. 같은 폴더 자신도 '안' 으로 본다.
 */
export function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  if (!c || !p) return false
  return c === p || c.startsWith(p + '/')
}
