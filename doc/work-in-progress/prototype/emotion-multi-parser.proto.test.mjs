// ⚠️ PROTOTYPE / TEST-ONLY. 의존성 설치 없이 실행: `node --test doc/work-in-progress/prototype/`
// 다중 감정 문법(§6) + 쉼 태그(§3) + 색상 범위 오프셋(§7)의 PURE 파서 회귀.
// 기존 emotions.test.ts 스타일(node:test + assert/strict)과 동형.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEmotionSegments, parseUsedEmotionIdsV2 } from './emotion-multi-parser.proto.mjs'

const emo = (segs) => segs.filter(s => s.kind === 'emotion').map(s => [s.emotionId, s.text.trim()])
const pauses = (segs) => segs.filter(s => s.kind === 'pause')

// ── 하위 호환: 기존 parseUsedEmotionIds 계약을 그대로 재현해야 한다 ──
test('하위호환: 한글 label, 본문 있는 줄만', () => {
  assert.deepEqual([...parseUsedEmotionIdsV2('[기쁨] 드디어 완성!\n[슬픔] 아쉽네요.')].sort(), ['happy', 'sad'])
})
test('하위호환: 영어 id 태그', () => {
  assert.deepEqual([...parseUsedEmotionIdsV2('[happy] hi\n[whisper] shh')].sort(), ['happy', 'whisper'])
})
test('하위호환: 알 수 없는 태그 → default → 제외', () => {
  assert.deepEqual([...parseUsedEmotionIdsV2('[없는감정] 텍스트\n[기쁨] 좋아')], ['happy'])
})
test('하위호환: [기본]/default 는 게이팅 대상 아님', () => {
  assert.equal(parseUsedEmotionIdsV2('[기본] 평범하게\n일반 문장').size, 0)
})
test('하위호환: 태그만 있고 본문 없는 줄은 사용 아님', () => {
  assert.deepEqual([...parseUsedEmotionIdsV2('[기쁨]\n[슬픔] 본문 있음')], ['sad'])
})
test('하위호환: 태그 없는 일반 대사 → 빈 집합', () => {
  assert.equal(parseUsedEmotionIdsV2('안녕하세요.\n오늘 좋은 날이에요.').size, 0)
})
test('하위호환: 중복 태그는 1회', () => {
  assert.deepEqual([...parseUsedEmotionIdsV2('[기쁨] a\n[기쁨] b\n[기쁨] c')], ['happy'])
})
test('하위호환: 빈/undefined 안전', () => {
  assert.equal(parseUsedEmotionIdsV2('').size, 0)
  assert.equal(parseUsedEmotionIdsV2(undefined).size, 0)
})

// ── §6 다중 감정(한 줄에 여러 태그) ──
test('§6 한 줄 2감정 → 2개 emotion 세그먼트', () => {
  const segs = parseEmotionSegments('[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋네요.')
  assert.deepEqual(emo(segs), [['happy', '안녕하세요.'], ['cheerful', '오늘 날씨가 좋네요.']])
  assert.deepEqual([...parseUsedEmotionIdsV2('[기쁨] 안녕하세요. [명랑] 오늘 날씨가 좋네요.')].sort(), ['cheerful', 'happy'])
})
test('§6 줄 앞 무태그 텍스트는 default, 이후 태그부터 전환', () => {
  const segs = parseEmotionSegments('안녕 [기쁨] 반가워')
  assert.deepEqual(emo(segs), [['default', '안녕'], ['happy', '반가워']])
})
test('§6 감정 스코프는 줄 안에서만(line-local) — 다음 줄은 default로 리셋', () => {
  const segs = parseEmotionSegments('[기쁨] 첫 줄\n두 번째 줄')
  assert.deepEqual(emo(segs), [['happy', '첫 줄'], ['default', '두 번째 줄']])
})

// ── §3 쉼 태그(정확한 커서 위치) ──
test('§3 쉼 태그는 정확한 위치에 삽입되고 감정을 바꾸지 않는다', () => {
  const segs = parseEmotionSegments('[기쁨] 안녕[쉼]하세요')
  assert.deepEqual(emo(segs), [['happy', '안녕'], ['happy', '하세요']])
  const p = pauses(segs)
  assert.equal(p.length, 1)
  assert.equal(p[0].durationSec, 0.5)
})
test('§3 쉼 초 지정: [쉼=1.2] 와 [쉼 0.8]', () => {
  assert.equal(pauses(parseEmotionSegments('가[쉼=1.2]나'))[0].durationSec, 1.2)
  assert.equal(pauses(parseEmotionSegments('가[쉼 0.8]나'))[0].durationSec, 0.8)
  assert.equal(pauses(parseEmotionSegments('가[pause]나'))[0].durationSec, 0.5)
})

// ── §7 색상 범위 오프셋(태그부터 다음 태그까지) ──
test('§7 emotion 세그먼트는 원본 오프셋(textStart/textEnd)을 갖는다', () => {
  const s = '[기쁨] 안녕하세요. [명랑] 좋네요.'
  const segs = parseEmotionSegments(s).filter(x => x.kind === 'emotion')
  // 오프셋으로 잘라내면 원문 조각과 일치해야 한다.
  for (const seg of segs) assert.equal(s.slice(seg.textStart, seg.textEnd), seg.text)
  // 첫 범위는 happy, 두 번째는 cheerful
  assert.equal(segs[0].emotionId, 'happy')
  assert.equal(segs[1].emotionId, 'cheerful')
  // 멀티라인 오프셋도 원문과 일치
  const s2 = '가나\n[슬픔] 다라'
  for (const seg of parseEmotionSegments(s2).filter(x => x.kind === 'emotion'))
    assert.equal(s2.slice(seg.textStart, seg.textEnd), seg.text)
})

// ── §8 상태 구분: 알 수 없는/깨진 태그 표시용 tagKnown 플래그 ──
test('§8 알 수 없는 태그는 tagKnown=false 로 구분(→default 귀결이지만 UI가 구분 가능)', () => {
  const segs = parseEmotionSegments('[없는감정] 텍스트').filter(s => s.kind === 'emotion')
  assert.equal(segs[0].emotionId, 'default')
  assert.equal(segs[0].tagKnown, false)
})
test('§8 닫히지 않은 대괄호는 리터럴 텍스트로 남는다(태그 아님)', () => {
  const segs = parseEmotionSegments('[기쁨 안녕 하세요').filter(s => s.kind === 'emotion')
  assert.deepEqual(emo(segs), [['default', '[기쁨 안녕 하세요']])
})

// ── 복합 시나리오 ──
test('복합: 다감정 + 쉼 + 무태그 리드 + 멀티라인', () => {
  const s = '먼저 [기쁨] 반가워[쉼=0.3] 정말 [명랑] 좋은 하루!\n[슬픔] 그리고 이별.'
  const segs = parseEmotionSegments(s)
  assert.deepEqual(emo(segs), [
    ['default', '먼저'],
    ['happy', '반가워'],
    ['happy', '정말'],
    ['cheerful', '좋은 하루!'],
    ['sad', '그리고 이별.'],
  ])
  assert.equal(pauses(segs).length, 1)
  assert.deepEqual([...parseUsedEmotionIdsV2(s)].sort(), ['cheerful', 'happy', 'sad'])
})
