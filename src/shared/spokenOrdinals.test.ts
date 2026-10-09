import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { spokenOrdinals, ordinalWord, findOrdinals, ORDINAL_RULE } from './spokenOrdinals.ts'
// @ts-ignore TS5097
import { readingPlan } from './readerText.ts'
// @ts-ignore TS5097
import { runSay } from './readerEmotion.ts'

// ★사례는 파이썬 짝(python/test_spoken_ordinals.py)과 **한 벌**이다.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { cases } = JSON.parse(readFileSync(path.join(HERE, 'spokenOrdinals.cases.json'), 'utf-8')) as { cases: [string, string][] }

test('규칙 이름이 기록에 쓰는 값과 같다', () => { assert.equal(ORDINAL_RULE, 'ordinal-ko-v1') })

test('1~99 전부 읽기가 있고 범위 밖은 없다 · 20 은 스무, 21 은 스물한', () => {
  for (let n = 1; n <= 99; n++) assert.ok(ordinalWord(n), String(n))
  assert.equal(ordinalWord(0), null); assert.equal(ordinalWord(100), null)
  assert.equal(ordinalWord(1), '첫'); assert.equal(ordinalWord(11), '열한'); assert.equal(ordinalWord(20), '스무'); assert.equal(ordinalWord(21), '스물한')
})

for (const [input, want] of cases) {
  test(`서수 → ${JSON.stringify(input).slice(0, 40)}`, () => { assert.equal(spokenOrdinals(input).text, want) })
}

test('바꾼 자리는 원문 좌표로 — 원문을 잘라 보면 바뀌기 전 글', () => {
  const t = '앞 1번째와 21번째'
  for (const c of findOrdinals(t)) assert.equal(t.slice(c.start, c.end), c.original)
})

test('낭독: 끄면 그대로, 켜면 구절의 소리 글만 바뀌고 원문 자리(from/to)는 같다', () => {
  const text = '그는 7번째 장면을 봤다. 다음은 2~7번째다.'
  const off = readingPlan(text, { skipHanjaInParens: false })
  const on = readingPlan(text, { skipHanjaInParens: false, ordinals: true })
  assert.ok(off.say.includes('7번째') && off.ordinalChanges === 0)
  assert.ok(on.say.includes('일곱 번째') && on.say.includes('2에서 7번째'), on.say)   // 범위의 일부만 바꾸지 않는다
  assert.equal(on.ordinalChanges, 1)
  assert.deepEqual(on.parts.map((p: { from: number; to: number }) => [p.from, p.to]), off.parts.map((p: { from: number; to: number }) => [p.from, p.to]))
})

test('낭독: 구절로 잘린 뒤에도 경계는 덩이 전체에서 — "1.7번째" 의 7 을 바꾸지 않는다', () => {
  const on = readingPlan('값은 1.7번째 칸이다.', { skipHanjaInParens: false, ordinals: true })
  assert.ok(!on.say.includes('일곱'), on.say)
  assert.equal(on.ordinalChanges, 0)
})

test('감정 덩어리 글도 같은 소리 글(구절 번호로 묶으므로 좌표가 밀리지 않는다)', () => {
  const text = '7번째 장면. 그리고 9번째.'
  const plan = readingPlan(text, { skipHanjaInParens: false, ordinals: true })
  const said = runSay(text, plan.parts, { from: 0, to: plan.parts.length - 1, emotion: '' })
  assert.equal(said, plan.say)
})

// ── 낭독 덩이 경계(2026-10-09 관리자 검수) — 판정은 문서 좌표로, 덩이를 어떻게 나눠도 같다 ──
// @ts-ignore TS5097
import { splitForReading, START_RAMP_SECONDS } from './readerChunks.ts'
// @ts-ignore TS5097
import { ORDINAL_CONTEXT } from './spokenOrdinals.ts'

test('덩이가 "1." 뒤에서 갈려도 "7번째" 는 바꾸지 않는다(앞 문맥을 함께 본다)', () => {
  const doc = '값은 1.7번째 칸이다.'
  const at = doc.indexOf('7번째')
  const plan = readingPlan(doc.slice(at), { skipHanjaInParens: false, ordinals: true, before: doc.slice(0, at) })
  assert.equal(plan.ordinalChanges, 0, plan.say)
  // 문맥 없이 덩이만 보면 바꿔 버린다 — 이 검사가 무엇을 막는지 함께 보인다.
  assert.equal(readingPlan(doc.slice(at), { skipHanjaInParens: false, ordinals: true }).ordinalChanges, 1)
})

test('읽기 시작 자리·덩이 크기가 달라도 문서의 같은 자리는 같은 판정(덩이마다 앞 64글자만 본다)', () => {
  const lines: string[] = []
  for (let k = 0; k < 40; k++) lines.push(k % 3 === 0 ? `그는 ${k % 9 + 1}번째 장면을 봤다.` : k % 3 === 1 ? `값은 1.${k % 9 + 1}번째 칸이다.` : `범위는 2~${k % 9 + 1}번째다.`)
  const doc = lines.join(' ')
  const whole = new Set(findOrdinals(doc).map((c: { start: number }) => c.start))
  const layouts = [
    splitForReading(doc),
    splitForReading(doc, { ramp: START_RAMP_SECONDS }),
    splitForReading(doc, { breakAt: doc.indexOf('7번째'), ramp: START_RAMP_SECONDS }),
    splitForReading(doc, { target: 1, min: 0, max: 1 }),          // 문장마다 덩이
  ]
  for (const chunks of layouts) {
    const got = new Set<number>()
    for (const c of chunks) {
      const before = doc.slice(Math.max(0, c.start - ORDINAL_CONTEXT), c.start)
      for (const ch of findOrdinals(c.text, before)) got.add(c.start + ch.start)
    }
    assert.deepEqual([...got].sort((a, b) => a - b), [...whole].sort((a, b) => a - b))
  }
})
