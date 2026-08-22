import { readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

// Qwen 합성은 output_dir 안에 실행별 임시 폴더 `.qwen-job-*`를 만들고, 정상/오류 경로에서는
// Python finally가 그 폴더를 삭제한다. 그러나 취소(Windows taskkill /T /F)는 finally를 건너뛰므로
// 세그먼트 등 중간 산출물이 그 폴더에 남는다. 이 함수는 자식 종료가 확인된 시점(runner 'done')에
// 부모(Electron)가 해당 output_dir의 `.qwen-job-*` 폴더만 삭제하기 위한 것.
//
// 안전 범위: 오직 지정한 output_dir 바로 아래에서, 이름이 `.qwen-job-`로 시작하는 '디렉터리'만
// 제거한다. synthesized.wav·session.json·다른 작업 결과·다른 파일은 절대 건드리지 않는다.
export function sweepQwenJobDirs(outputDir: string): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(outputDir)
  } catch {
    return removed // output_dir 없음/접근 불가 → 아무것도 안 함
  }
  for (const name of entries) {
    if (!name.startsWith('.qwen-job-')) continue
    const full = join(outputDir, name)
    try {
      if (!statSync(full).isDirectory()) continue // 폴더만 대상(동명 파일 보호)
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // 개별 실패는 무시(다른 프로세스가 사용 중 등) — 다른 항목 정리는 계속
    }
  }
  return removed
}

// 남아 있는 `.qwen-job-*` 폴더 이름 목록(삭제하지 않음). 취소 정리(bounded cleanup)의 완료 판정에 사용 —
// 실제로 0개임을 확인한 뒤에만 '취소 완료'를 확정하기 위한 관측 함수. 안전 범위는 sweepQwenJobDirs와 동일.
export function listQwenJobDirs(outputDir: string): string[] {
  const found: string[] = []
  let entries: string[]
  try { entries = readdirSync(outputDir) } catch { return found }
  for (const name of entries) {
    if (!name.startsWith('.qwen-job-')) continue
    try { if (statSync(join(outputDir, name)).isDirectory()) found.push(name) } catch { /* noop */ }
  }
  return found
}
