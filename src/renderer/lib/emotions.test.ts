// 감정 태그 파싱 회귀 — Node 내장 러너(node --test). Python tts_worker._parse_line 동형 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsedEmotionIds, ALL_EMOTIONS } from './emotions.ts'

test('한글 label 태그 → emotionId (본문 있는 줄만)', () => {
  const used = parseUsedEmotionIds('[기쁨] 드디어 완성!\n[슬픔] 아쉽네요.')
  assert.deepEqual([...used].sort(), ['happy', 'sad'])
})

test('영어 id 태그도 인식', () => {
  const used = parseUsedEmotionIds('[happy] hi\n[whisper] shh')
  assert.deepEqual([...used].sort(), ['happy', 'whisper'])
})

test('알 수 없는 태그는 default로 귀결 → 결과에서 제외', () => {
  const used = parseUsedEmotionIds('[없는감정] 텍스트\n[기쁨] 좋아')
  assert.deepEqual([...used], ['happy'])
})

test("'기본'([기본]/default) 태그는 감정 게이팅 대상이 아님(제외)", () => {
  const used = parseUsedEmotionIds('[기본] 평범하게\n일반 문장')
  assert.equal(used.size, 0)
})

test('태그만 있고 본문이 없는 줄은 사용으로 세지 않음 (Python 정규식 (.+) 동형)', () => {
  // '[기쁨]'만 있고 뒤 본문이 없으면 _parse_line 매칭 실패 → default 문장 취급.
  const used = parseUsedEmotionIds('[기쁨]\n[슬픔] 본문 있음')
  assert.deepEqual([...used], ['sad'])
})

test('태그 없는 일반 대사만 → 빈 집합', () => {
  const used = parseUsedEmotionIds('안녕하세요.\n오늘 좋은 날이에요.')
  assert.equal(used.size, 0)
})

test('중복 태그는 집합으로 1회', () => {
  const used = parseUsedEmotionIds('[기쁨] a\n[기쁨] b\n[기쁨] c')
  assert.deepEqual([...used], ['happy'])
})

test('빈/undefined 입력 안전', () => {
  assert.equal(parseUsedEmotionIds('').size, 0)
  assert.equal(parseUsedEmotionIds(undefined as unknown as string).size, 0)
})

test('ALL_EMOTIONS의 id는 유일(중복 없음)', () => {
  const ids = ALL_EMOTIONS.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length)
})
