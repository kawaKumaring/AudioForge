// 이번 실행에서 **이미 되살리기를 시도한 작업**(원본 열쇠)의 기록.
//
// ★왜 화면 밖에 두는가(2026-09-17 실측): 고급 화면은 일반 탭을 다녀오면 **다시 마운트**된다.
//   되살리기 기록이 화면 인스턴스의 ref 에 있으면 그때마다 처음 보는 작업인 줄 알고 **또 되살린다** —
//   사용자는 파일을 바꾼 적이 없는데 "이전 작업을 되살렸습니다" 가 다시 뜨고, 그 사이에 한 일이
//   저장본으로 덮일 수 있다. 같은 실행 안에서 같은 파일은 **한 번만** 되살린다.
//   파일을 새로 고르면(setFile) 상태가 비워지므로 그때는 다시 되살려야 한다 — 열쇠에서 지운다.
//
// store 와 hook 이 둘 다 이 모듈을 본다(store 가 hook 을 import 하면 순환이 생긴다).
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자.
import { workKeyOf } from '../../shared/workDraft.ts'

const restoredThisRun = new Set<string>()

export function hasRestoredThisRun(sourcePath: string): boolean {
  const key = workKeyOf(sourcePath)
  return !!key && restoredThisRun.has(key)
}
export function markRestoredThisRun(sourcePath: string): void {
  const key = workKeyOf(sourcePath)
  if (key) restoredThisRun.add(key)
}
/** 파일을 새로 골랐다 — 그 작업은 다음에 열릴 때 다시 되살려야 한다. */
export function forgetRestoredThisRun(sourcePath: string): void {
  const key = workKeyOf(sourcePath)
  if (key) restoredThisRun.delete(key)
}
