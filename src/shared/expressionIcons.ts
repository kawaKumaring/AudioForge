export const EXPRESSION_ICONS = [
  { id: 'happy', icon: '😊', label: '기쁨', token: '[기쁨]', description: '밝고 기쁜 말투를 다음 대사에 요청합니다.' },
  { id: 'sad', icon: '😢', label: '슬픔', token: '[슬픔]', description: '가라앉고 슬픈 말투를 다음 대사에 요청합니다.' },
  { id: 'angry', icon: '😠', label: '분노', token: '[화남]', description: '화가 난 말투를 요청합니다. 고함이나 발음 보존을 보장하지 않습니다.' },
  { id: 'fearful', icon: '😨', label: '두려움', token: '[공포]', description: '두렵고 긴장한 말투를 요청합니다.' },
  { id: 'disgusted', icon: '😖', label: '혐오·경멸', token: '[경멸]', description: '불쾌하고 못마땅한 말투. 기존 카드 엔진의 경멸 태그로 저장합니다.' },
  { id: 'surprised', icon: '😲', label: '놀람', token: '[놀람]', description: '놀라는 말투를 다음 대사에 요청합니다.' },
  { id: 'calm', icon: '😌', label: '기본 말투', token: '[기본]', description: '감정 강조를 끝내고 기본 말투로 돌아갑니다. H3의 calm 전용 지시는 아직 미연결입니다.' },
  { id: 'whisper', icon: '🤫', label: '속삭임', token: '[속삭임]', description: '작게 속삭이는 말투를 요청합니다. 엔진별 지원이 다릅니다.' },
  { id: 'pause', icon: '⏱', label: '쉼 0.7초', token: '[쉼 0.7]', description: '명시적인 쉼 표시. 실제 처리 방식은 선택한 엔진에 따릅니다.' },
] as const
export type ExpressionIcon = typeof EXPRESSION_ICONS[number]
/** 첫 감정 표시가 앞 대사까지 덮는 기존 문법을 피한다. 원문은 저장한 채 요청본만 만든다. */
export function expressionScript(text: string, initialEmotion = '기본'): string {
  return text.split('\n').map(line => {
    const parts = expressionParts(line), first = parts.find(p => p.cue && p.cue.id !== 'pause')
    const before = first ? line.slice(0, line.indexOf(first.text)).replace(/\[쉼 0\.7\]/g, '') : ''
    if (!first || before.includes('[') || !before.trim()) return line
    return `[${initialEmotion}]${line}`
  }).join('\n')
}
export function expressionIconFault(text: string, emotionSupported: boolean): string {
  return !emotionSupported && expressionParts(text).some(p => p.cue && p.cue.id !== 'pause')
    ? '이 목소리는 감정 연출을 지원하지 않습니다. 감정 표시를 지우거나 지원 목소리를 선택하세요.' : ''
}
export function expressionParts(text: string): { text: string; cue?: ExpressionIcon }[] {
  const result: { text: string; cue?: ExpressionIcon }[] = []
  let at = 0
  for (const match of text.matchAll(/(?<!\\)\[(?:기쁨|슬픔|화남|공포|경멸|놀람|기본|속삭임|쉼 0\.7)\]/g)) {
    if (match.index! > at) result.push({ text: text.slice(at, match.index) })
    result.push({ text: match[0], cue: EXPRESSION_ICONS.find(c => c.token === match[0]) })
    at = match.index! + match[0].length
  }
  if (at < text.length) result.push({ text: text.slice(at) })
  return result
}
