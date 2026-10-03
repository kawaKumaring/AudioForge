// 낭독 따라가기 — 만든 소리의 쉼으로 구절 시각을 맞추는 규칙(readerTiming). 시계·GPU 없이 본다.
// ★실제 소리로 잰 값(2026-10-01): Supertonic 으로 문장마다 따로 만들어 이은 소리에서 문장 시작 오차 0.00초(5문장).
//   여기서는 모양이 같은 **만든 파형**으로 규칙을 붙든다.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { parseWav, envelope, alignParts, partAt, HOP_SEC } from './readerTiming.ts'

const SR = 16000
/** 말소리(사인파)와 쉼을 이어 붙인 파형. segs: [초, 소리냐]. */
function wave(segs: Array<[number, boolean]>): Float32Array {
  const n = Math.round(segs.reduce((s, [d]) => s + d, 0) * SR)
  const out = new Float32Array(n)
  let at = 0
  for (const [d, loud] of segs) {
    const len = Math.round(d * SR)
    for (let i = 0; i < len; i++) out[at + i] = loud ? 0.5 * Math.sin(2 * Math.PI * 220 * (at + i) / SR) : 0
    at += len
  }
  return out
}
function wav16(samples: Float32Array, sr = SR): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const dv = new DataView(buf)
  const s = (o: number, t: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i)) }
  s(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true)
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); s(36, 'data'); dv.setUint32(40, samples.length * 2, true)
  samples.forEach((v, i) => dv.setInt16(44 + i * 2, Math.round(v * 32767), true))
  return new Uint8Array(buf)
}

test('WAV 를 읽는다 — 16비트 · 길이 · 크기', () => {
  const w = parseWav(wav16(wave([[0.5, true]])))!
  assert.equal(w.sampleRate, SR)
  assert.equal(w.samples.length, SR / 2)
  assert.ok(Math.max(...w.samples) > 0.49)
  assert.equal(parseWav(new Uint8Array([1, 2, 3])), null, '형식이 아니면 null')
})

test('★문장 사이의 쉼에 구절 경계를 맞춘다 — 글자 수로 어림한 자리가 조금 어긋나도', () => {
  // 앞 조용함 0.4 · 문장1 2.0초 · 쉼 0.4 · 문장2 1.0초 · 쉼 0.4 · 문장3 3.0초 · 뒤 조용함 0.3
  const env = envelope({ sampleRate: SR, samples: wave([[0.4, false], [2, true], [0.4, false], [1, true], [0.4, false], [3, true], [0.3, false]]) })
  // 글자 수는 소리 길이와 딱 맞지 않는다(20·14·26 — 비율 0.33/0.23/0.43 · 실제 0.33/0.17/0.5)
  const spans = alignParts(env, [{ weight: 20, strong: true }, { weight: 14, strong: true }, { weight: 26, strong: true }])
  const near = (a: number, b: number) => Math.abs(a - b) <= 2 * HOP_SEC
  assert.ok(near(spans[0][0], 0.4) && near(spans[0][1], 2.4), JSON.stringify(spans))
  assert.ok(near(spans[1][0], 2.8) && near(spans[1][1], 3.8), JSON.stringify(spans))
  assert.ok(near(spans[2][0], 4.2) && near(spans[2][1], 7.2), JSON.stringify(spans))
})

test('쉼이 없는 쉼표는 말소리 시간으로 나눠 채운다 — 순서가 뒤집히지 않는다', () => {
  const env = envelope({ sampleRate: SR, samples: wave([[0.2, false], [4, true], [0.2, false]]) })
  const spans = alignParts(env, [{ weight: 10, strong: false }, { weight: 10, strong: true }])
  assert.ok(Math.abs(spans[0][1] - 2.2) < 0.1, JSON.stringify(spans))
  assert.ok(spans[0][0] <= spans[0][1] && spans[0][1] <= spans[1][0] && spans[1][0] <= spans[1][1])
})

test('낱말 사이의 짧은 끊김(쉼 기준보다 짧음)은 경계로 보지 않는다', () => {
  const env = envelope({ sampleRate: SR, samples: wave([[1, true], [0.05, false], [1, true], [0.4, false], [1, true]]) })
  const spans = alignParts(env, [{ weight: 20, strong: true }, { weight: 10, strong: true }])
  assert.ok(Math.abs(spans[0][1] - 2.05) < 0.03, '0.05초 끊김이 아니라 0.4초 쉼에 맞춘다: ' + JSON.stringify(spans))
})

test('빈 소리 · 구절 없음', () => {
  assert.deepEqual(alignParts(new Float32Array(100), [{ weight: 3, strong: true }]), [[0, 0]])
  assert.deepEqual(alignParts(new Float32Array(100), []), [])
})

test('★재생 시각 → 구절 — 쉼에서는 앞 구절 끝에 머문다(다음 줄로 미리 뛰지 않는다)', () => {
  const spans: Array<[number, number]> = [[0.4, 2.4], [2.8, 3.8]]
  assert.deepEqual(partAt(spans, 0), { part: 0, frac: 0 })
  assert.equal(partAt(spans, 1.4).part, 0)
  assert.ok(Math.abs(partAt(spans, 1.4).frac - 0.5) < 1e-9)
  assert.deepEqual(partAt(spans, 2.6), { part: 0, frac: 1 })
  assert.equal(partAt(spans, 3).part, 1)
  assert.deepEqual(partAt(spans, 9), { part: 1, frac: 1 })
  assert.deepEqual(partAt([], 1), { part: -1, frac: 0 })
})
