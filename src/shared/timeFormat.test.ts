// 화면 표기의 **자리올림**을 지킨다.
//
// ★2026-09-24 2차 감사: 같은 계산이 네 곳에 따로 있었고 넷 다 같은 방식으로 틀렸다.
//   분을 먼저 확정한 뒤 나머지를 반올림해 자리올림이 분으로 전파되지 않았다.
//   **경계값 검사가 한 곳에도 없어서** 오래 남았다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMinSec } from './timeFormat.ts'

test('자리올림이 분으로 전파된다', () => {
  // 실측으로 틀렸던 값들 — 각각 0:60.0 / 1:60.0 으로 보였다.
  assert.equal(formatMinSec(59.96), '1:00.0')
  assert.equal(formatMinSec(119.97), '2:00.0')
  assert.equal(formatMinSec(59.95), '1:00.0', '정확히 경계인 값')
})

test('0 채움이 반올림 뒤 값을 따른다', () => {
  // 더빙 쪽은 반올림 전 값으로 판정해 0:010.0 을 냈다.
  assert.equal(formatMinSec(9.96), '0:10.0')
  assert.equal(formatMinSec(9.94), '0:09.9')
})

test('평범한 값은 그대로다', () => {
  assert.equal(formatMinSec(0), '0:00.0')
  assert.equal(formatMinSec(5.5), '0:05.5')
  assert.equal(formatMinSec(65.5), '1:05.5')
  assert.equal(formatMinSec(59.94), '0:59.9')
  assert.equal(formatMinSec(600), '10:00.0')
})

test('음수와 이상한 값은 0으로 본다', () => {
  assert.equal(formatMinSec(-1), '0:00.0')
  assert.equal(formatMinSec(Number.NaN), '0:00.0')
  assert.equal(formatMinSec(Number.POSITIVE_INFINITY), '0:00.0')
})

// ★넓은 정규식 가드는 쓰지 않는다 — 처음에 써 봤더니 정수 초를 쓰는 멀쩡한 자리 일곱 곳을
//   함께 잡았다. **잘못 잡는 가드는 결국 꺼진다.** 대신 실제로 화면에 쓰이는 함수들을
//   **경계값으로 직접 눌러 본다** — 누가 다시 제 공식을 짜 넣으면 여기서 걸린다.
test('화면에 쓰이는 표기 함수들이 경계에서 옳다', async () => {
  const { dubTimeLabel } = await import('./dubbing.ts')
  const { fmtDuration } = await import('./splitPieces.ts')
  for (const fn of [dubTimeLabel, fmtDuration]) {
    assert.equal(fn(59.96), '1:00.0', fn.name)
    assert.equal(fn(119.97), '2:00.0', fn.name)
    assert.equal(fn(9.96), '0:10.0', fn.name)
    assert.equal(fn(65.5), '1:05.5', fn.name)
    assert.equal(fn(0), '0:00.0', fn.name)
  }
})
