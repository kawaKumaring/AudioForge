// 감정 태그 파싱 회귀 — Node 내장 러너(node --test). Python tts_worker._parse_line 동형 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUsedEmotionIds, ALL_EMOTIONS, planEmotionRefs, type EmotionRefSlotLike } from './emotions.ts'

const slot = (o: Partial<EmotionRefSlotLike>): EmotionRefSlotLike =>
  ({ source: '', clip: '', ready: false, ...o })

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

// ── planEmotionRefs: 계약 §5 4 불변식 ──

test('불변식1: 미등록 사용 감정 → 기본 폴백(전송·차단 안 함)', () => {
  const p = planEmotionRefs('[기쁨] 안녕', {})
  assert.deepEqual(p.toSend, {})
  assert.equal(p.blockedId, null)
})

test('불변식2: 등록+준비된 사용 감정 → effective(파생 클립) 전송', () => {
  const p = planEmotionRefs('[기쁨] 안녕', { happy: slot({ source: 'h.wav', clip: 'hc.wav', ready: true }) })
  assert.deepEqual(p.toSend, { happy: 'hc.wav' })
  assert.equal(p.blockedId, null)
})

test('불변식2: 유효 ≤10초 원본(clip 없음)은 원본이 effective', () => {
  const p = planEmotionRefs('[슬픔] 흑', { sad: slot({ source: 's.wav', clip: '', ready: true }) })
  assert.deepEqual(p.toSend, { sad: 's.wav' })
})

test('불변식3: 등록+미준비 사용 감정 → blockedId 차단, 전송 안 함', () => {
  const p = planEmotionRefs('[기쁨] 안녕', { happy: slot({ source: 'h.wav', clip: '', ready: false, message: '구간 확정' }) })
  assert.deepEqual(p.toSend, {})
  assert.equal(p.blockedId, 'happy')
})

test('불변식4: 미사용 감정은 등록·준비돼도 전송·차단 대상 아님', () => {
  const refState = {
    happy: slot({ source: 'h.wav', clip: 'hc.wav', ready: true }),   // 준비됐지만 대사에 없음
    sad: slot({ source: 's.wav', ready: false }),                    // 미준비지만 대사에 없음
  }
  const p = planEmotionRefs('[놀람] 어라', refState)  // 놀람은 미등록
  assert.deepEqual(p.toSend, {})   // happy 미사용이라 전송 안 함
  assert.equal(p.blockedId, null)  // sad 미사용이라 차단 안 함
})

test('혼합: 준비된 것만 전송, 미준비 사용 감정은 첫 번째가 blockedId', () => {
  const refState = {
    happy: slot({ source: 'h.wav', clip: 'hc.wav', ready: true }),
    sad: slot({ source: 's.wav', ready: false }),
  }
  const p = planEmotionRefs('[기쁨] a\n[슬픔] b', refState)
  assert.deepEqual(p.toSend, { happy: 'hc.wav' })
  assert.equal(p.blockedId, 'sad')
})
