/**
 * 이어 듣기 응답을 **지금 재생해도 되는가.**
 *
 * ★왜 필요한가 (2026-09-27 검수 2항 [P2])
 *   `runJoin` 은 요청 시작 때 계획을 만들고, 응답이 오면 화면이 살아 있는지만 봤다.
 *   준비 중에 채택·순서·간격을 바꿔도 **먼저 보낸 요청의 소리가 그대로 울렸다.**
 *   재현: A 채택으로 시작 → 계획을 B 로 바꿈 → A 응답이 오자 A 의 미리듣기가 재생됐다.
 *
 * ★요청 세대와 계획 지문을 **둘 다** 본다.
 *   세대만 보면 같은 계획을 두 번 눌렀을 때 멀쩡한 응답을 버린다.
 *   지문만 보면 계획을 바꿨다가 되돌린 사이에 온 응답을 최신으로 착각한다.
 *
 * ★저장은 다른 규칙이다.
 *   사용자가 누른 순간의 계획을 저장한다 — 그것이 그때 화면에서 약속한 결과다.
 *   그래서 이 파일은 **미리듣기에만** 쓴다.
 */

export interface PreviewStamp {
  /** 요청 세대. 새 요청을 보낼 때마다 하나씩 오른다. */
  gen: number
  /** 그때 계획의 지문(`joinPlanKey`). */
  key: string
}

export type PreviewStale = '' | 'gone' | 'newer' | 'changed'

/**
 * 이 응답이 낡았는가. 낡지 않았으면 빈 문자열.
 *   `gone`    — 화면이 사라졌다.
 *   `newer`   — 그 사이 새 요청이 시작됐다(이 응답은 지난 것).
 *   `changed` — 계획이 바뀌었다(채택·순서·간격·처리 옵션).
 */
export function previewStale(req: PreviewStamp, now: PreviewStamp & { alive: boolean }): PreviewStale {
  if (!now.alive) return 'gone'
  if (req.gen !== now.gen) return 'newer'
  if (req.key !== now.key) return 'changed'
  return ''
}

/**
 * 사용자에게 할 말. **조용히 있어야 하는 경우는 빈 문자열**이다.
 * 새 요청이 이미 돌고 있으면 그 요청이 말한다 — 두 번 말하면 화면이 시끄럽다.
 */
export function previewStaleText(stale: PreviewStale): string {
  if (stale === 'changed') return '카드가 바뀌어 이전 이어 듣기를 쓰지 않았습니다. 다시 들어 보세요.'
  return ''
}

/** 울리고 있는 소리가 지금 계획과 다른가 — 다르면 멈춘다. */
export function playbackStale(playingKey: string, currentKey: string): boolean {
  return !!playingKey && playingKey !== currentKey
}
