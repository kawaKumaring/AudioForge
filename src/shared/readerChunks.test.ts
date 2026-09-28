import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  splitForReading, chunkAt, charAt, totalSeconds,
  CHARS_PER_SECOND, MIN_SECONDS, MAX_SECONDS,
// @ts-ignore TS5097
} from './readerChunks.ts'

const sentence = (n: number) => '어두운 복도를 천천히 걸어 나갔다. '.repeat(n)

test('빈 글은 덩이가 없다', () => {
  assert.deepEqual(splitForReading(''), [])
  assert.deepEqual(splitForReading('   \n\n  '), [])
})

test('★원문 자리를 그대로 들고 다닌다 — 본문에 표시하려면 필요하다', () => {
  const text = '앞머리. ' + sentence(30)
  for (const c of splitForReading(text)) {
    assert.equal(text.slice(c.start, c.end), c.text,
      `원문 자리가 어긋났다: ${c.start}~${c.end}`)
  }
})

test('★덩이를 이으면 원문이 된다 — 글을 잃지 않는다', () => {
  const text = sentence(40)
  const got = splitForReading(text)
  assert.equal(got.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    text.replace(/\s+/g, ' ').trim(), '글이 사라지거나 겹쳤다')
})

test('★자리가 앞으로만 간다 — 겹치거나 되돌아가지 않는다', () => {
  const got = splitForReading(sentence(50))
  for (let i = 1; i < got.length; i++) {
    assert.ok(got[i].start >= got[i - 1].end,
      `덩이가 겹친다: ${got[i - 1].end} → ${got[i].start}`)
  }
})

test('★잘게 쪼개지 않는다 — 한 번 부를 때마다 1.8초를 버린다', () => {
  const got = splitForReading(sentence(60))
  assert.ok(got.length >= 2, '나뉘지 않았다')
  // 마지막 덩이는 남은 것이라 짧을 수 있다. 나머지는 최소치를 넘어야 한다.
  for (const c of got.slice(0, -1)) {
    assert.ok(c.seconds >= MIN_SECONDS * 0.9,
      `너무 짧다(${c.seconds}초) — 이 크기면 만드는 속도가 읽는 속도를 못 따라간다`)
  }
})

test('★너무 크게 잡지도 않는다 — 첫 소리가 늦고 멈출 때 버리는 것이 크다', () => {
  for (const c of splitForReading(sentence(80))) {
    assert.ok(c.seconds <= MAX_SECONDS * 1.05, `너무 길다: ${c.seconds}초`)
  }
})

test('★문장 한가운데를 자르지 않는다', () => {
  for (const c of splitForReading(sentence(40))) {
    assert.ok(/[.!?…"”’'」』)\]]$/.test(c.text) || c.text.length > 0,
      `문장 중간에서 끊겼다: …${c.text.slice(-20)}`)
    assert.ok(!c.text.startsWith('다.'), '문장 꼬리만 담긴 덩이가 생겼다')
  }
})

test('★문장 부호 뒤 따옴표를 떼어 놓지 않는다', () => {
  const text = '"괜찮아." ' + sentence(20) + '"정말?" ' + sentence(20)
  const got = splitForReading(text)
  for (const c of got) {
    assert.notEqual(c.text.trim(), '"', '따옴표 하나만 읽는 덩이가 생겼다')
    assert.notEqual(c.text.trim(), '”')
  }
})

test('★한 문장이 최대치를 넘으면 그대로 둔다 — 가운데를 자르는 것보다 낫다', () => {
  const huge = '그' + '리고 또 '.repeat(300) + '끝났다.'
  const got = splitForReading(huge)
  assert.equal(got.length, 1, '긴 문장을 갈랐다')
  assert.ok(got[0].seconds > MAX_SECONDS, '이 검사가 큰 문장을 다루고 있지 않다')
  assert.equal(got[0].text, huge.trim())
})

test('줄바꿈에서도 나눈다 — 소설의 문단 경계다', () => {
  const text = sentence(15) + '\n\n' + sentence(15)
  const got = splitForReading(text)
  assert.ok(got.length >= 2)
  assert.ok(!got[0].text.includes('\n\n'), '문단 경계를 넘어 한 덩이로 묶였다')
})

test('짧은 글 하나는 덩이 하나', () => {
  const got = splitForReading('그는 문을 열었다.')
  assert.equal(got.length, 1)
  assert.equal(got[0].start, 0)
  assert.equal(got[0].text, '그는 문을 열었다.')
})

test('걸리는 시간은 글자 수에 비례한다', () => {
  const got = splitForReading(sentence(30))
  for (const c of got) {
    assert.ok(Math.abs(c.seconds - c.text.length / CHARS_PER_SECOND) < 0.2, String(c.seconds))
  }
  assert.ok(totalSeconds(got) > 0)
})

test('자리 ↔ 덩이를 서로 찾는다', () => {
  const text = sentence(40)
  const got = splitForReading(text)
  assert.equal(chunkAt(got, 0), 0)
  assert.equal(chunkAt(got, got[1].start), 1, '두 번째 덩이를 못 찾는다')
  assert.equal(charAt(got, 1), got[1].start)
  // 끝을 넘어가면 마지막 덩이로 본다 — 없다고 하지 않는다.
  assert.equal(chunkAt(got, text.length + 100), got.length - 1)
  assert.equal(chunkAt([], 0), -1)
  assert.equal(charAt([], 0), 0)
})

test('★목표 크기를 바꾸면 따라 바뀐다 — 화면이 조절할 수 있다', () => {
  const text = sentence(60)
  const small = splitForReading(text, { target: 8, min: 5, max: 12 })
  const big = splitForReading(text, { target: 30, min: 20, max: 50 })
  assert.ok(small.length > big.length, `작게 잡았는데 덩이가 더 적다: ${small.length} vs ${big.length}`)
})
