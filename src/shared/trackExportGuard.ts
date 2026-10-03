/**
 * 결과 트랙을 **다른 자리에 저장할 때**의 보호.
 *
 * ★예전에는 고른 폴더에 그냥 덮어썼다(2026-09-27 확인). 결과 폴더나 원본이 있는 폴더를
 *   고르면 **만들어 둔 결과나 원본을 조용히 지웠다.** 성공과 실패가 화면상 같았던 적도 있고,
 *   백업하려다 원본을 잃는 것이 가장 나쁜 쪽이다.
 *
 * 규칙은 셋이다.
 *   1. 보호 대상(원본·결과 트랙) 위에는 **절대** 쓰지 않는다.
 *   2. 이미 다른 파일이 있으면 **덮지 않고 사유를 남긴다** — 사용자가 고르게 한다.
 *   3. 판정 근거는 이름이 아니라 **파일의 정체**다(같은 파일을 다른 경로로 가리킬 수 있다).
 */
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(이 저장소의 관례).
import { sameFileTarget, type PathProbe } from './joinOutputGuard.ts'

export type ExportRefusal = 'GUARDED' | 'EXISTS'

export function refusalText(why: ExportRefusal): string {
  switch (why) {
    case 'GUARDED': return '원본이나 결과 파일 위에는 저장할 수 없습니다'
    case 'EXISTS': return '같은 이름의 파일이 이미 있습니다'
  }
}

/**
 * 이 자리에 저장해도 되는가. 되면 빈 문자열.
 *
 * @param dest    저장할 자리(전체 경로)
 * @param guarded 지켜야 할 파일들(원본·결과 트랙 등)
 * @param exists  그 자리에 파일이 이미 있는가
 */
export function exportFault(dest: string, guarded: string[], exists: boolean,
  probe: PathProbe): ExportRefusal | '' {
  for (const g of guarded) {
    if (g && sameFileTarget(dest, g, probe)) return 'GUARDED'
  }
  if (exists) return 'EXISTS'
  return ''
}
