// 화면 쪽 빚기가 **파이썬과 같은 답을 내는가.**
//
// ★왜 같은 것이 둘 있나
//   손잡이를 움직일 때마다 파이썬을 부르면 화면이 끊긴다. 그래서 화면에도 같은 계산을 둔다.
//
// ★★갈라지면 무엇이 무너지나
//   사람이 **보고 맞춘 모양**과 실제로 **소리에 먹는 모양**이 달라진다.
//   맞췄다고 생각하고 전곡을 뽑았는데 딴 소리가 나오는 것 — 그것이 최악이다.
//   이 화면을 만드는 목적 자체가 "보면서 확실하게 맞추는 것" 이므로,
//   두 구현이 어긋나는 순간 **화면이 거짓말을 한다.**
//
//   본보기는 파이썬이 낸 값이다(`_local/fixture_gen.py` 로 다시 만들 수 있다).
//   파이썬이 원본이고 이쪽이 따라간다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyKnobs, similarity, toSemitones, toHz, NEUTRAL } from './pitchShape.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(readFileSync(
  path.resolve(HERE, '..', '..', 'test', 'fixtures', 'pitch-shape-vectors.json'), 'utf-8'))

type Case = {
  name: string
  knobs: Record<string, number>
  hz: number[]
  semitones: Array<number | null>
  shaped: Array<number | null>
  similarity: number
}
const CASES: Case[] = VECTORS.cases

/** 소수점 끝자리 차이는 봐준다 — 언어가 다르면 마지막 자리가 흔들린다. */
function sameCurve(got: Array<number | null>, want: Array<number | null>, what: string): void {
  assert.equal(got.length, want.length, `${what}: 칸 수가 다르다`)
  got.forEach((g, i) => {
    const w = want[i]
    if (w === null || g === null) {
      assert.equal(g, w, `${what}[${i}]: 소리 있음/없음이 갈린다`)
      return
    }
    assert.ok(Math.abs(g - w) < 1e-6,
      `${what}[${i}]: ${g} vs 파이썬 ${w}`)
  })
}

test('본보기가 비어 있지 않다 — 검사가 눈이 멀지 않았다', () => {
  assert.ok(CASES.length >= 30, `본보기를 ${CASES.length}개밖에 못 읽었다`)
  assert.ok(CASES.some((c) => c.shaped.includes(null)), '쉬는 자리가 있는 본보기가 없다')
  assert.ok(CASES.some((c) => Object.keys(c.knobs).length > 1), '손잡이를 겹쳐 돌린 본보기가 없다')
})

test('Hz ↔ 반음 환산이 파이썬과 같다', () => {
  for (const c of CASES) {
    sameCurve(toSemitones(c.hz), c.semitones, `${c.name} 환산`)
  }
})

test('빚은 곡선이 파이썬과 같다 — 본보기 전부', () => {
  for (const c of CASES) {
    const got = applyKnobs(toSemitones(c.hz), c.knobs as never)
    sameCurve(got, c.shaped, `${c.name} ${JSON.stringify(c.knobs)}`)
  }
})

test('겹침 점수가 파이썬과 같다', () => {
  for (const c of CASES) {
    const got = similarity(toSemitones(c.hz), c.shaped)
    assert.ok(Math.abs(got - c.similarity) < 1e-6,
      `${c.name} ${JSON.stringify(c.knobs)}: ${got} vs 파이썬 ${c.similarity}`)
  }
})

test('되돌리면 제자리다', () => {
  const hz = [110, 220, 440, 0]
  const back = toHz(toSemitones(hz))
  hz.forEach((want, i) => assert.ok(Math.abs(back[i] - want) < 1e-6))
})

test('아무 손잡이도 안 돌리면 그대로다', () => {
  const v = toSemitones([220, 230, 240])
  sameCurve(applyKnobs(v, NEUTRAL), v, '그대로')
  sameCurve(applyKnobs(v), v, '기본값')
})

// ★이 검사에 이빨이 있는지 — 파일을 건드리지 않고 확인한다.
test('한 자리만 어긋나도 잡는다', () => {
  const c = CASES.find((x) => Object.keys(x.knobs).length > 0)!
  const broken = c.shaped.map((v, i) => (i === 0 && v !== null ? v + 0.01 : v))
  assert.throws(() => sameCurve(broken, c.shaped, '일부러 어긋냄'),
    '어긋난 것을 그냥 통과시킨다')
})
