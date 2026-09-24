// 합성 전제 조건 목록의 계약 — **그리고 목록이 실제로 쓰이는지**까지 본다.
//
// ★왜(2026-09-24 2차 감사): 판정이 if 로 흩어져 있어서 파이썬을 새로 돌리는 길이
//   하나 늘었을 때 아무도 갱신하지 않았다. 목록을 모으는 것만으로는 부족하다 —
//   모아 두고 부르는 쪽이 옛 if 를 그대로 쓰면 같은 일이 또 생긴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUARDED, blockReason, type RunningState } from './synthesisGate.ts'

test('아무것도 안 돌면 막지 않는다', () => {
  assert.equal(blockReason({}), null)
})

test('도는 것마다 **무엇 때문인지** 말한다', () => {
  assert.match(blockReason({ mainRunner: true })!, /이미 처리 중/)
  assert.match(blockReason({ transcriptPreview: true })!, /참조 전사 미리보기/)
  assert.match(blockReason({ referenceTrim: true })!, /참조 구간 트림/)
  assert.match(blockReason({ samplerPreview: true })!, /미리듣기/)
})

test('시작하려는 일의 이름이 문구에 들어간다', () => {
  assert.match(blockReason({ samplerPreview: true }, '트랙 작업')!, /트랙 작업을 시작할 수 없습니다/)
})

test('여럿이 겹치면 하나만 말한다 — 화면에 사유를 쌓지 않는다', () => {
  const r = blockReason({ mainRunner: true, samplerPreview: true })
  assert.match(r!, /이미 처리 중/)
})

// ★가드가 통째로 사라지는 것을 막는다. 감정 정의 드리프트 가드가 실제로 그렇게 죽었다.
test('감정 미리듣기는 반드시 목록에 있다 — 이것이 빠져서 사고가 났다', () => {
  assert.ok(GUARDED.includes('samplerPreview'),
    '미리듣기를 목록에서 빼면 파이썬 둘이 같은 GPU 를 동시에 문다')
  assert.equal(GUARDED.length, 4, '실행기를 늘렸으면 여기 수도 같이 늘어야 한다')
})

// ★목록을 만들어 두고 **안 쓰면** 아무것도 달라지지 않는다.
test('본체가 이 목록을 실제로 부른다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.resolve(here, '..', 'main', 'ipc', 'audio.ipc.ts'), 'utf-8')
  assert.ok(src.includes('blockReason('), 'audio.ipc 가 공용 판정을 부르지 않는다')
  const calls = (src.match(/blockReason\(/g) || []).length
  assert.ok(calls >= 2, `합성·트랙 두 자리에서 불러야 한다(지금 ${calls}곳)`)
})

// 타입이 실수를 잡는지 — 없는 이름을 쓰면 컴파일이 막힌다.
const _shape: RunningState = {
  mainRunner: false, transcriptPreview: false, referenceTrim: false, samplerPreview: false,
}
void _shape
