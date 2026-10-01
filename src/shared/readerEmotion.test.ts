// 낭독 감정 규칙 — 대사에만, 단서는 대사 안 → 바로 뒤 서술 → 바로 앞 서술 순(2026-10-01).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { cueEmotion, partEmotions, emotionRuns, runSay } from './readerEmotion.ts'
// @ts-ignore TS5097
import { readingPlan } from './readerText.ts'

const P = { skipHanjaInParens: false }
const emo = (t: string) => {
  const plan = readingPlan(t, P)
  const e = partEmotions(t, plan.parts)
  return plan.parts.map((p, k) => [t.slice(p.from, p.to), e[k]])
}

test('단서 낱말 — 먼저 적힌 감정이 이긴다', () => {
  assert.equal(cueEmotion('그가 버럭 소리를 질렀다.'), 'angry')
  assert.equal(cueEmotion('그녀가 울먹이며 말했다.'), 'sad')
  assert.equal(cueEmotion('그가 속삭였다.'), 'whisper')
  assert.equal(cueEmotion('그가 웃으며 말했다.'), 'happy')
  assert.equal(cueEmotion('그가 소리쳤다.'), 'excited')
  assert.equal(cueEmotion('그는 문을 열었다.'), '')
})

test('★대사에만 싣는다 — 뒤 서술의 단서가 앞 대사에, 서술은 그대로', () => {
  const r = emo('"이게 무슨 짓이야!" 그가 버럭 소리를 질렀다. 방 안이 조용해졌다.')
  assert.deepEqual(r, [['"이게 무슨 짓이야!"', 'angry'], ['그가 버럭 소리를 질렀다.', ''], ['방 안이 조용해졌다.', '']])
})

test('앞 서술의 단서도 본다 — 대사 안의 단서가 가장 먼저', () => {
  assert.deepEqual(emo('그녀가 울먹이며 말했다. "가지 마."').map((x) => x[1]), ['', 'sad'])
  assert.deepEqual(emo('그가 웃으며 말했다. "정말 화가 나네."').map((x) => x[1]), ['', 'angry'], '대사 안의 단서가 앞 서술보다 먼저')
})

test('단서가 없거나, 앞뒤 서술이 길면 감정 없이', () => {
  assert.deepEqual(emo('"어서 와." 그가 말했다.').map((x) => x[1]), ['', ''])
  const long = '그는 오랫동안 창밖을 바라보다가 지난 일을 하나하나 떠올리며 웃음이 나오는 것을 참으려 애썼다.'
  assert.ok(long.length > 50)
  assert.deepEqual(emo(`"그래." ${long}`).map((x) => x[1]), ['', ''])
})

test('★앞 대사에 딸린 서술은 빌려 오지 않는다 · 덩이 경계 너머의 서술도 본다', () => {
  assert.deepEqual(emo('"좋아!" 그가 웃으며 말했다. "쉿, 누가 들어."').map((x) => x[1]), ['happy', '', '', ''],
    '앞 대사의 "웃으며" 를 다음 대사가 빌렸다')
  // 덩이 끝의 대사 — 다음 덩이 처음의 서술이 단서다
  const t = '그는 문을 열었다. "이게 무슨 짓이야!"'
  const plan = readingPlan(t, P)
  assert.deepEqual(partEmotions(t, plan.parts, { after: '그가 버럭 소리를 질렀다. 방이 조용해졌다.' }), ['', 'angry'])
  // 덩이 처음의 대사 — 앞 덩이 끝의 서술이 단서다(그 앞이 대사가 아닐 때)
  const u = '"가지 마." 방이 조용해졌다.'
  assert.deepEqual(partEmotions(u, readingPlan(u, P).parts, { before: '창밖은 어두웠다. 그녀가 울먹이며 말했다.' }), ['sad', ''])
})

test('★감정이 같은 이웃 구절을 한 덩어리로 — 소리 없는 구절은 건너뛴다', () => {
  const t = '"어서!" 그가 소리쳤다. 바람이 불었다.\n***\n"쉿." 그녀가 속삭였다.'
  const plan = readingPlan(t, P)
  const runs = emotionRuns(plan.parts, partEmotions(t, plan.parts))
  assert.deepEqual(runs.map((r) => [t.slice(plan.parts[r.from].from, plan.parts[r.to].to), r.emotion]),
    [['"어서!"', 'excited'], ['그가 소리쳤다. 바람이 불었다.', ''], ['"쉿."', 'whisper'], ['그녀가 속삭였다.', '']])
  // 덩어리마다 보낼 글 — 기호는 빼고(따옴표·별표) 줄바꿈 수는 지킨다. 이어 붙이면 한 덩이로 보낼 글과 같은 말이다.
  assert.deepEqual(runs.map((r) => runSay(t, plan.parts, r)), ['어서!', '그가 소리쳤다. 바람이 불었다.', '쉿.', '그녀가 속삭였다.'])
})
