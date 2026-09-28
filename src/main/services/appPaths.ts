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
 * ★검사가 자리를 짚었으면 그 아래에 쌓는다. 전에는 검사도 앱 뿌리에 쌓아서
 *   저장소의 결과 폴더에 **검사 산출물과 진짜 결과가 섞여** 있었다(실측 20여 개).
 *   결과 폴더는 '사라지면 안 되는 것' 을 두는 자리다 — 지워도 되는 것이 섞이면
 *   청소할 때 구분이 없다.
 */
export function outputBase(here: string, env: Record<string, string | undefined>): string {
  if (env.AF_E2E === '1' && env.AF_E2E_USER_DATA) return env.AF_E2E_USER_DATA
  return realAppRoot(here)
}
