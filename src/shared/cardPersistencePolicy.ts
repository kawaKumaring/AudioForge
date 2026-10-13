/** 카드 정보 자동 저장과 사용자 입력 저장은 서로 다른 계약이다. */
export const CARD_AUTOSAVE_KEY = 'cardAutoSave'
export const CARD_CONTENT_VERSION = 1
export const CARD_INPUT_FIELDS = ['h3Direction','emotion','symbolReading','instruction','ttsText','prompt','sentText','sent_text'] as const
export function withoutCardInput(settings: Record<string,unknown>): Record<string,unknown> {
  const out={...settings}; for(const k of CARD_INPUT_FIELDS)delete out[k];return out
}
