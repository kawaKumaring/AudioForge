// 감정 태그 파싱 회귀 — Node 내장 러너(node --test). Python tts_worker._parse_line 동형 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseUsedEmotionIds, ALL_EMOTIONS, planEmotionRefs, type EmotionRefSlotLike,
  insertEmotionTag, insertPauseTag, emotionTagText,
} from './emotions.ts'

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

// ── 감정 태그 삽입(계약 §3 + D-1): caret 삽입 / 인접 교체 / 다중 줄 무손실 ──

test('삽입: 선택 없음 → 정확 caret에 [label] 삽입(대사 무손실)', () => {
  const text = '[기쁨] 안녕하세요. 오늘 날씨가 좋아요.'
  const caret = '[기쁨] 안녕하세요. '.length  // 오늘 앞
  const r = insertEmotionTag(text, caret, caret, 'cheerful')
  assert.equal(r.ok, true)
  assert.equal(r.text, '[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋아요.')
  // caret은 삽입된 '[명랑] ' 뒤
  assert.equal(r.text.slice(0, r.selStart), '[기쁨] 안녕하세요. [명랑] ')
})

test('삽입: caret이 기존 감정 태그 내부/인접 → 교체(중복 방지, 대사 보존)', () => {
  const text = '[기쁨] 안녕'
  // caret을 태그 내부(2)로
  const r = insertEmotionTag(text, 2, 2, 'sad')
  assert.equal(r.ok, true)
  assert.equal(r.text, '[슬픔] 안녕')
})

test('삽입: 무조건 줄 선두 삽입 금지 — caret 위치 유지', () => {
  const text = '안녕 반가워요'
  const caret = '안녕 '.length
  const r = insertEmotionTag(text, caret, caret, 'happy')
  assert.equal(r.text, '안녕 [기쁨] 반가워요')  // 줄 선두가 아니라 caret에
})

test('삽입(다중 줄 선택): 비어있지 않은 각 줄 선두 태그, 대사·인라인 후속 태그·빈 줄 보존', () => {
  const text = '첫째 줄\n\n[슬픔] 둘째 [기쁨] 인라인\n셋째 줄'
  const r = insertEmotionTag(text, 0, text.length, 'cheerful')
  assert.equal(r.ok, true)
  const lines = r.text.split('\n')
  assert.equal(lines[0], '[명랑] 첫째 줄')          // 선두 삽입
  assert.equal(lines[1], '')                         // 빈 줄 보존
  assert.equal(lines[2], '[명랑] 둘째 [기쁨] 인라인') // 선두 교체 + 인라인 후속 태그 보존
  assert.equal(lines[3], '[명랑] 셋째 줄')
})

test('삽입(다중 줄): 사용자 대사 문자 손실 없음(글자 집합 비감소)', () => {
  const text = '가나다\n[슬픔] 라마바'
  const before = text.replace(/\s/g, '')
  const r = insertEmotionTag(text, 0, text.length, 'happy')
  // 원 대사 글자(가나다/라마바)는 모두 남아 있어야 한다
  for (const ch of ['가', '나', '다', '라', '마', '바']) assert.ok(r.text.includes(ch))
  assert.ok(before.length > 0)
})

// ── 쉼 태그 삽입(계약 §4 + D-4) ──

test('쉼 삽입: canonical [쉼 N], 선택 텍스트 무손실(선택 끝에 삽입)', () => {
  const text = '첫 문장. 둘째 문장.'
  const a = '첫 문장.'.length
  const b = '첫 문장. 둘째'.length
  const r = insertPauseTag(text, a, b, 500)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.ok(r.text.includes('[쉼 0.5]'))
  // 선택 텍스트('둘째')가 삭제되지 않음
  assert.ok(r.text.includes('둘째'))
  assert.equal(r.text, '첫 문장. 둘째[쉼 0.5] 문장.')
})

test('쉼 삽입: 정수초는 N.0, 0.05 최소', () => {
  const r1 = insertPauseTag('ab', 1, 1, 1000)
  assert.equal(r1.ok && r1.text, 'a[쉼 1.0]b')
  const r2 = insertPauseTag('ab', 1, 1, 50)
  assert.equal(r2.ok && r2.text, 'a[쉼 0.05]b')
})

test('쉼 삽입: 범위 밖 → INVALID_PAUSE_TAG(조용한 clamp 금지)', () => {
  const r = insertPauseTag('ab', 1, 1, 9000)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.error.code, 'INVALID_PAUSE_TAG')
  assert.equal(r.error.reason, 'range')
})

test('쉼 삽입: 인접 중복 → INVALID_PAUSE_TAG(합산·정규화 금지)', () => {
  const text = 'A [쉼 0.2] B'
  const pos = 'A [쉼 0.2]'.length  // 기존 쉼 바로 뒤
  const r = insertPauseTag(text, pos, pos, 300)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.error.code, 'INVALID_PAUSE_TAG')
  assert.equal(r.error.reason, 'adjacent_duplicate')
})

test('emotionTagText: id → 한글 canonical label', () => {
  assert.equal(emotionTagText('happy'), '[기쁨]')
  assert.equal(emotionTagText('cheerful'), '[명랑]')
})
