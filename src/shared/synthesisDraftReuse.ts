// 대본을 명시적으로 이어 쓴다. 원문과 기존 생성본은 이 단계에서 수정하지 않는다.
export function sentenceDraftText(lines: readonly { text: string }[]): string {
  return lines.filter((line) => line.text.trim()).map((line) => line.text).join('\n\n')
}

/** 배역 편집에 붙일 때 이전 화자가 새 대사로 이어지지 않도록 기본 화자로 시작한다. */
export function appendDraftText(current: string, incoming: string, resetSpeaker = false): string {
  if (!incoming.trim()) return current
  const addition = resetSpeaker ? '[화자 기본]\n' + incoming : incoming
  return current.trim() ? current + '\n\n' + addition : addition
}
