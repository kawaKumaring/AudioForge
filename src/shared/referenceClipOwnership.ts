import { TTS_EMOTION_LABEL_TO_ID } from './ttsGrammar.ts'

const emotionKeys = new Set(Object.values(TTS_EMOTION_LABEL_TO_ID))

/**
 * 키 없는 audio:release-reference-clip 요청은 공용 파일 작업의 새 파일·리셋을 뜻한다.
 * default/감정/화자만 해당 작업 소유다. lab/dub 및 모르는 슬롯은 보존한다.
 * 개별 슬롯 해제는 명시 키로, 앱 종료의 전체 정리는 별도 sweep으로 처리한다.
 */
export function fileWorkspaceClipKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => key === 'default' || key.startsWith('spk:') || emotionKeys.has(key))
}
