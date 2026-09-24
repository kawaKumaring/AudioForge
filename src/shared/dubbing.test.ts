// 더빙 화면이 사람에게 하는 말 — 상태 글자와 '무엇을 했는가'.
//
// 여기서 보는 것
//   · 할 일이 없었다는 것도 결과다. 그 경우에도 화면이 말을 한다(2026-09-20 신고: 멈춘 줄 알았다)
//   · 다음에 할 일을 **순서대로** 말한다 — 번역이 비면 소리를 못 만들고, 소리가 없으면 자리를 못 맞춘다
//   · 상태 글자는 기획서의 셋(맞음 / 늘여서 맞춤 / 안 맞음)을 벗어나지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DUB_STAGES,
  dubFrontSummary,
  dubNextAction,
  dubStatusColor,
  dubStatusLabel,
  dubTimeLabel,
  dubCancellable,
  dubCancelRoute,
  dubCancelText,
} from './dubbing.ts'

test('할 일이 없었으면 그렇다고 말하고 다음에 할 일을 알려 준다', () => {
  // ★이 검사가 있는 이유: 네 단계가 다 끝난 뒤 '이어서 하기' 를 누르면 즉시 끝나는데,
  //   화면이 아무 말도 안 해서 멈춘 것처럼 보였다.
  const msg = dubFrontSummary([], [...DUB_STAGES])
  assert.match(msg, /이미 끝나/)
  assert.match(msg, /목소리/, '다음에 무엇을 할지 말해야 한다')
})

test('아무것도 끝나지 않았으면 빈 결과라고 말한다', () => {
  assert.match(dubFrontSummary([], []), /아직/)
})

test('실제로 돈 단계를 이름으로 말한다', () => {
  const msg = dubFrontSummary(['transcribe', 'translate'], [])
  assert.match(msg, /알아듣기/)
  assert.match(msg, /번역/)
})

test('이어서 했을 때 건너뛴 단계도 함께 말한다', () => {
  const msg = dubFrontSummary(['translate'], ['audio', 'separate', 'transcribe'])
  assert.match(msg, /번역/)
  assert.match(msg, /지난 결과를 쓴 단계/)
  assert.match(msg, /보컬 갈라내기/)
})

test('다음에 할 일을 순서대로 말한다 — 번역이 먼저다', () => {
  assert.match(dubNextAction({ lines: 10, empty: 2, missing: 10, over: 3 }), /번역이 비어/)
  assert.match(dubNextAction({ lines: 10, empty: 0, missing: 4, over: 3 }), /소리를 만들지 않은/)
  assert.match(dubNextAction({ lines: 10, empty: 0, missing: 0, over: 3 }), /안 맞는 줄/)
  assert.match(dubNextAction({ lines: 10, empty: 0, missing: 0, over: 0 }), /영상을 만들 수 있습니다/)
})

test('줄이 없으면 영상부터 넣으라고 말한다', () => {
  assert.match(dubNextAction({ lines: 0, empty: 0, missing: 0, over: 0 }), /영상을 넣고/)
})

test('상태 글자는 기획서의 셋을 벗어나지 않는다', () => {
  assert.equal(dubStatusLabel('fit'), '맞음')
  assert.match(dubStatusLabel('stretched', { ratio: 1.18 }), /늘여서 맞춤 \(1\.18배\)/)
  assert.match(dubStatusLabel('over', { overflowSec: 1.25 }), /안 맞음 \(1\.3초 넘침\)/)
  assert.equal(dubStatusLabel('pending'), '아직 안 만듦')
})

test('상태마다 다른 색을 준다 — 눈으로 갈라져야 한다', () => {
  const seen = new Set(['fit', 'stretched', 'over', 'pending'].map((s) => dubStatusColor(s as never)))
  assert.equal(seen.size, 4)
})

test('시각을 분:초로 쓴다', () => {
  assert.equal(dubTimeLabel(0), '0:00.0')
  assert.equal(dubTimeLabel(19.53), '0:19.5')
  assert.equal(dubTimeLabel(125.4), '2:05.4')
  assert.equal(dubTimeLabel(-3), '0:00.0', '음수는 0 으로 본다')
})

// ── 멈추기 ───────────────────────────────────────────────────────────────
//
// ★더빙에는 멈출 수단이 아예 없었다(2026-09-25). 앞단은 영상 길이만큼 도는 가장
//   긴 구간이고 GPU 를 문다 — 잘못 눌렀으면 끝날 때까지 기다리거나 앱을 죽여야 했다.

test('멈출 수 있는 일과 없는 일을 가른다', () => {
  assert.equal(dubCancellable('front'), true)
  assert.equal(dubCancellable('render'), true)
  assert.equal(dubCancellable('synth'), true)
  // 목소리 준비는 짧고 중간에 끊으면 반쯤 준비된 상태가 남는다 — 일반 탭과 같은 선례.
  assert.equal(dubCancellable('voice'), false)
  assert.equal(dubCancellable(''), false)
})

// ★통로를 잘못 고르면 **단추는 눌리는데 아무것도 멈추지 않는다.**
//   앞단·내보내기는 더빙이 제 실행기를 따로 돌리고, 줄 소리는 공용 실행기를 탄다.
test('일마다 멈추는 통로가 다르다', () => {
  assert.equal(dubCancelRoute('front'), 'dub')
  assert.equal(dubCancelRoute('render'), 'dub')
  assert.equal(dubCancelRoute('synth'), 'shared', '줄 소리는 공용 실행기를 탄다')
  assert.equal(dubCancelRoute('voice'), null)
  assert.equal(dubCancelRoute(''), null)
})

test('멈출 수 있다고 한 일에는 반드시 통로가 있다', () => {
  for (const w of ['', 'front', 'voice', 'synth', 'render'] as const) {
    assert.equal(dubCancellable(w), dubCancelRoute(w) !== null,
      `${w}: 멈출 수 있다면서 통로가 없다(또는 그 반대)`)
  }
})

// ★'멈췄습니다' 로 뭉개지 않는다 — 확인 못 한 것을 확인한 척하면, 사용자가 다음
//   작업을 시작했다가 파이썬 둘이 같은 GPU 를 문다.
test('종료를 확인하지 못했으면 그렇다고 말한다', () => {
  const sure = dubCancelText({ accepted: true, treeKillConfirmed: true })
  const unsure = dubCancelText({ accepted: true, treeKillConfirmed: false })
  assert.notEqual(sure, unsure, '확인한 것과 못 한 것이 같은 말을 한다')
  assert.match(unsure, /확인하지 못했/)
  assert.match(sure, /그대로 있습니다/, '멈춰도 만든 것은 남는다고 말해야 한다')
})

test('멈출 것이 없으면 그렇게 말한다 — 실패로 적지 않는다', () => {
  assert.match(dubCancelText({ accepted: false, reason: 'NO_ACTIVE_JOB' }), /이미 끝났습니다/)
  assert.match(dubCancelText({ accepted: false, reason: 'ALREADY_CANCELLING' }), /이미 멈추는 중/)
})

// ★목록만 만들고 화면이 안 쓰면 아무것도 달라지지 않는다.
test('화면이 이 판정을 실제로 쓴다', () => {
  const src = readFileSync(new URL('../renderer/components/DubWorkspace.tsx', import.meta.url), 'utf-8')
  assert.ok(src.includes('dubCancelRoute('), '화면이 통로 판정을 쓰지 않는다')
  assert.ok(src.includes('dubCancellable('), '화면이 멈출 수 있는지 판정을 쓰지 않는다')
  assert.ok(src.includes('data-testid="dub-cancel"'), '멈추기 단추가 없다')
  // 한 줄만 멈추면 다음 줄로 넘어가 다시 GPU 를 문다.
  assert.ok(src.includes('stopSynth'), '줄 소리 반복을 멈추는 자리가 없다')
})
