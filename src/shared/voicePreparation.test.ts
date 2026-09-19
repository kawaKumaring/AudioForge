// 목소리 준비의 판정 규칙 — 화면 없이 시험한다.
//
// 이 검사들이 지키는 것은 전부 **실측 결함의 흔적**이다. 지금까지는 앱을 띄우는 검사로만 지켜졌다.
//   · 늦게 온 분석이 그 사이 준비된 목소리를 되돌리지 않는다(2026-09-09)
//   · 추천이 없을 때 '준비 중' 에 갇히지 않는다(2026-09-16 사용자 보고)
//   · 승인은 문구가 아니라 구조화된 코드로만 정한다(참조 대사 섞임 사건)
//   · 형식이 어긋나면 승인하지 않는다(fail-closed)
//   · 확정에 실패해도 쓰고 있던 목소리는 내려가지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTION_CONFIRM, autoConfirmKey, decideAfterAnalysis, decideAfterTrim, decideAutoConfirm,
  hasCommittedRef, validSpan,
  type CommittedRef, type ReferenceAnalysis,
} from './voicePreparation.ts'
import { policyFromAnalysis } from './referencePolicy.ts'

/** 정책 요약은 **중첩 구조**다(required/recommended 각각 min_sec·max_sec). 파이썬이 보내는 모양 그대로. */
function pol(required = { min_sec: 3, max_sec: 10 }, recommended = { min_sec: 5, max_sec: 10 }) {
  return { engine: 'gptsovits', required, recommended, basis: '', recommended_basis: '' }
}

/** 필수 3~10초 · 권장 5~10초 짜리 정책을 실은 분석 뼈대. */
function analysis(over: Partial<ReferenceAnalysis> = {}): ReferenceAnalysis {
  return {
    duration_sec: 30, sample_rate: 24000, channels: 1,
    needs_region: false, too_short: false, valid_whole: true,
    policy: pol() as never,
    ...over,
  }
}
const POL = policyFromAnalysis(analysis())

test('검사 뼈대가 실제 정책 모양을 쓴다 — 틀리면 아래 검사들이 조용히 무의미해진다', () => {
  assert.equal(POL.engine, 'gptsovits')
  assert.deepEqual(POL.required, { min_sec: 3, max_sec: 10 })
  assert.deepEqual(POL.recommended, { min_sec: 5, max_sec: 10 })
})
const committedRegion = (start = 2, duration = 7, clip = 'C:/clip.wav'): CommittedRef =>
  ({ clip, region: { start, duration } })

// ── 사용 중 판정 ──────────────────────────────────────────────────────────────

test('쓰고 있는 목소리 — 클립·구간·원본 전체 중 하나라도 있으면 사용 중이다', () => {
  assert.equal(hasCommittedRef(null), false)
  assert.equal(hasCommittedRef({ clip: '', region: null }), false)
  assert.equal(hasCommittedRef({ clip: 'C:/a.wav', region: null }), true)
  assert.equal(hasCommittedRef({ clip: '', region: { start: 0, duration: 7 } }), true)
  assert.equal(hasCommittedRef({ clip: '', region: null, whole: true }), true, '원본 전체도 준비된 상태다')
})

test('구간 형식이 어긋나면 승인하지 않는다', () => {
  assert.equal(validSpan({ start_sec: 1, end_sec: 8, dur_sec: 7 }), true)
  assert.equal(validSpan(undefined), false)
  assert.equal(validSpan({ start_sec: 1, end_sec: 1, dur_sec: 0 }), false, '길이 0은 구간이 아니다')
  assert.equal(validSpan({ start_sec: 5, end_sec: 2, dur_sec: 3 }), false, '끝이 시작보다 앞일 수 없다')
  assert.equal(validSpan({ start_sec: NaN, end_sec: 8, dur_sec: 7 } as never), false)
})

// ── 분석 결과 판정 ────────────────────────────────────────────────────────────

test('너무 짧으면 실패로 보고하고 더 보지 않는다', () => {
  const d = decideAfterAnalysis({ analysis: analysis({ too_short: true, duration_sec: 1.2 }), committed: null, autoConfirm: false, plain: false })
  assert.equal(d.patches.length, 1)
  assert.equal(d.patches[0].phase, 'failed')
  assert.ok((d.patches[0].message || '').length > 0, '사유를 비워 두지 않는다')
  assert.equal(d.seed, null)
})

test('원본을 그대로 쓸 수 있으면 준비 완료다', () => {
  const d = decideAfterAnalysis({ analysis: analysis({ valid_whole: true }), committed: null, autoConfirm: false, plain: false })
  assert.deepEqual(d.patches, [{ phase: 'ready', clip: '', message: '', region: null }])
})

test('구간이 필요하고 사용 중인 것이 없으면 — 자동 확정 여부로 단계가 갈린다', () => {
  const a = analysis({ needs_region: true, valid_whole: false, region_required: true, recommend: { ok: true, start_sec: 3, dur_sec: 7 } })
  const manual = decideAfterAnalysis({ analysis: a, committed: null, autoConfirm: false, plain: false })
  assert.equal(manual.patches[0].phase, 'needs_region', '사용자가 눌러야 하면 needs_region')
  assert.ok(manual.patches[0].message?.startsWith(ACTION_CONFIRM), '무엇을 눌러야 하는지 맨 앞에 말한다')

  const auto = decideAfterAnalysis({ analysis: a, committed: null, autoConfirm: true, plain: false })
  assert.equal(auto.patches[0].phase, 'preparing', '자동 확정이 뒤따르면 진행 중이다')
  assert.ok(!auto.patches[0].message?.includes(ACTION_CONFIRM), '누르라고 하지 않는다 — 대신 해 준다')

  assert.deepEqual(auto.seed, { start: 3, dur: 7 }, '추천 구간을 슬라이더에 심는다')
})

test('쉬운 말 화면에서는 같은 사실을 다른 말로 낸다', () => {
  const a = analysis({ needs_region: true, valid_whole: false, recommend: { ok: true, start_sec: 0, dur_sec: 7 } })
  const plain = decideAfterAnalysis({ analysis: a, committed: null, autoConfirm: true, plain: true })
  assert.equal(plain.patches[0].message, '목소리에서 쓸 부분을 고르는 중입니다…')
})

test('★늦게 온 분석이 그 사이 준비된 목소리를 되돌리지 않는다', () => {
  const a = analysis({ needs_region: true, valid_whole: false, recommend: { ok: true, start_sec: 0, dur_sec: 7 } })
  const d = decideAfterAnalysis({ analysis: a, committed: committedRegion(2, 7), autoConfirm: true, plain: false })
  assert.deepEqual(d.patches, [], '사용 중이면 아무것도 보고하지 않는다 — 준비를 내리지 않는다')
  assert.deepEqual(d.seed, { start: 2, dur: 7 }, '슬라이더는 쓰고 있는 구간에서 시작한다')
  assert.deepEqual(d.effective, { start_sec: 2, dur_sec: 7 })
  assert.equal(d.confirmedClip, 'C:/clip.wav', '쓰던 클립을 이어 쓴다')
})

test('엔진이 바뀌어 쓰던 구간이 필수 조건 밖이면 — 사유만 알리고 클립·구간은 그대로 둔다', () => {
  // 새 엔진은 8초 이상을 **필수**로 요구한다. 쓰던 구간은 4초 — 필수 조건 밖이다.
  const a = analysis({ needs_region: true, valid_whole: false, duration_sec: 30,
    policy: pol({ min_sec: 8, max_sec: 10 }, { min_sec: 8, max_sec: 10 }) as never })
  const d = decideAfterAnalysis({ analysis: a, committed: committedRegion(2, 4), autoConfirm: false, plain: false })
  const p = d.patches[0]
  assert.equal(p.phase, 'needs_region')
  assert.equal(p.clip, 'C:/clip.wav', '쓰던 클립을 지우지 않는다')
  assert.deepEqual(p.region, { start: 2, duration: 4 }, '쓰던 구간도 그대로다')
  assert.equal(d.confirmedClip, 'C:/clip.wav')
})

test('원본 전체를 쓰던 상태인데 새 정책이 구간을 필수로 요구하면 사유를 알린다', () => {
  const a = analysis({ needs_region: true, valid_whole: false, region_required: true })
  const d = decideAfterAnalysis({ analysis: a, committed: { clip: '', region: null, whole: true }, autoConfirm: false, plain: false })
  assert.equal(d.patches.length, 1)
  assert.equal(d.patches[0].phase, 'needs_region')
  assert.equal(d.patches[0].clip, '', '원본 전체였으므로 지울 클립이 없다')
})

test('품질 오류는 사유를 모아 실패로 보고한다 — 사유가 없으면 기본 문구', () => {
  const withErr = decideAfterAnalysis({
    analysis: analysis({ valid_whole: false, errors: [{ code: 'X', message: '잡음 과다' }, { code: 'Y', message: '무음 과다' }] }),
    committed: null, autoConfirm: false, plain: false })
  assert.equal(withErr.patches[0].message, '잡음 과다 / 무음 과다')
  const noErr = decideAfterAnalysis({ analysis: analysis({ valid_whole: false }), committed: null, autoConfirm: false, plain: false })
  assert.equal(noErr.patches[0].message, '참조 음성 품질 오류')
  assert.equal(noErr.patches[0].phase, 'failed')
})

// ── 트림 응답 판정 ────────────────────────────────────────────────────────────

const okMetrics = (over: Record<string, unknown> = {}) => ({
  ready: true, blocking: [], effective_region: { start_sec: 2, end_sec: 9, dur_sec: 7 }, ...over,
})

test('승인 — 실제로 잘려 나간 구간을 저장한다(요청 구간이 아니다)', () => {
  const d = decideAfterTrim({ clip_path: 'C:/out.wav', metrics: okMetrics({ requested_region: { start_sec: 1, end_sec: 8, dur_sec: 7 } }) },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(d.kind, 'ready')
  if (d.kind === 'ready') {
    assert.equal(d.clip, 'C:/out.wav')
    assert.deepEqual(d.region, { start: 2, duration: 7 }, '자동 스냅된 실제 구간을 쓴다')
  }
})

test('★승인은 구조화된 코드로만 정한다 — ready 와 blocking 이 어긋나면 거부', () => {
  const contradiction = decideAfterTrim({ clip_path: 'C:/out.wav', metrics: okMetrics({ ready: true, blocking: ['REGION_TOO_SHORT'] }) },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(contradiction.kind, 'failed', 'ready=true 인데 차단 코드가 있으면 승인하지 않는다')

  const missing = decideAfterTrim({ clip_path: 'C:/out.wav', metrics: { effective_region: { start_sec: 2, end_sec: 9, dur_sec: 7 } } },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(missing.kind, 'failed', 'blocking 이 아예 없으면 승인하지 않는다')
  if (missing.kind === 'failed') assert.equal(missing.patch.phase, 'failed')

  const badSpan = decideAfterTrim({ clip_path: 'C:/out.wav', metrics: okMetrics({ effective_region: { start_sec: 5, end_sec: 2, dur_sec: 3 } }) },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(badSpan.kind, 'failed', '구간 형식이 어긋나면 승인하지 않는다')
})

test('차단 코드가 있으면 그 사유로, 구간을 다시 고르면 되는 일인지도 코드가 정한다', () => {
  const d = decideAfterTrim({ clip_path: '', metrics: { ready: false, blocking: ['REGION_TOO_SHORT'], effective_region: { start_sec: 2, end_sec: 9, dur_sec: 7 } } },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(d.kind, 'failed')
  if (d.kind === 'failed') {
    assert.equal(d.patch.phase, 'needs_region', '다시 고르면 되는 일이다')
    assert.ok((d.patch.message || '').length > 0)
  }
})

test('구조화 차단 응답(status=failed)은 코드를 사람 말로 바꿔 전한다', () => {
  const d = decideAfterTrim({ status: 'failed', code: 'REFERENCE_REGION_BLOCKED', blocking: ['REGION_TOO_SHORT'] },
    { hasCommitted: false, policy: POL, plain: false })
  assert.equal(d.kind, 'failed')
  if (d.kind === 'failed') assert.ok(!(d.patch.message || '').includes('REGION_TOO_SHORT'), '내부 코드를 화면에 내지 않는다')
})

test('★확정에 실패해도 쓰고 있던 목소리는 내려가지 않는다', () => {
  const failedResp = decideAfterTrim({ status: 'failed', error_message: '무음이 너무 많습니다' },
    { hasCommitted: true, policy: POL, plain: false })
  assert.equal(failedResp.kind, 'kept')
  if (failedResp.kind === 'kept') assert.ok(failedResp.message.includes('이전에 확정한 구간을 그대로 사용합니다'))
})

test('형식 불일치 문구는 화면 종류에 따라 다르다', () => {
  const expert = decideAfterTrim({ clip_path: 'x', metrics: {} }, { hasCommitted: false, policy: POL, plain: false })
  const plain = decideAfterTrim({ clip_path: 'x', metrics: {} }, { hasCommitted: false, policy: POL, plain: true })
  assert.equal(expert.kind, 'failed'); assert.equal(plain.kind, 'failed')
  if (expert.kind === 'failed' && plain.kind === 'failed') {
    assert.ok(expert.patch.message?.includes('형식 불일치'))
    assert.ok(!plain.patch.message?.includes('형식 불일치'), '쉬운 말 화면에는 내부 용어를 내지 않는다')
  }
})

// ── 자동 확정 ─────────────────────────────────────────────────────────────────

test('분석 전에는 끝났다고 하지 않는다 — 드라이버가 다음 사람으로 넘어가면 안 된다', () => {
  assert.deepEqual(decideAutoConfirm({ autoConfirm: true, hasCommitted: false, analyzeError: false, analysis: null, policy: POL }),
    { kind: 'wait' })
})

test('이미 쓰고 있거나 분석이 실패했으면 끝난 것으로 알린다', () => {
  assert.deepEqual(decideAutoConfirm({ autoConfirm: true, hasCommitted: true, analyzeError: false, analysis: null, policy: POL }), { kind: 'settle' })
  assert.deepEqual(decideAutoConfirm({ autoConfirm: true, hasCommitted: false, analyzeError: true, analysis: null, policy: POL }), { kind: 'settle' })
})

test('구간이 필요 없으면 확정할 것이 없다', () => {
  assert.deepEqual(decideAutoConfirm({ autoConfirm: true, hasCommitted: false, analyzeError: false, analysis: analysis(), policy: POL }), { kind: 'settle' })
})

test('★추천이 없으면 임의로 고르지 않되, 준비 중으로 남겨 두지도 않는다', () => {
  const d = decideAutoConfirm({ autoConfirm: true, hasCommitted: false, analyzeError: false,
    analysis: analysis({ needs_region: true, valid_whole: false, recommend: { ok: false, start_sec: 0, dur_sec: 0 } }), policy: POL })
  assert.equal(d.kind, 'needs-region')
  if (d.kind === 'needs-region') {
    assert.equal(d.patch.phase, 'needs_region')
    assert.equal(d.patch.message, ACTION_CONFIRM, '무엇을 해야 하는지 말한다')
  }
})

test('추천이 있으면 그 구간으로 한 번 확정한다 — 길이는 정책 범위로 맞춘다', () => {
  const d = decideAutoConfirm({ autoConfirm: true, hasCommitted: false, analyzeError: false,
    analysis: analysis({ needs_region: true, valid_whole: false, recommend: { ok: true, start_sec: 4, dur_sec: 99 } }), policy: POL })
  assert.equal(d.kind, 'confirm')
  if (d.kind === 'confirm') {
    assert.equal(d.start, 4)
    assert.ok(d.dur <= 10, `정책 상한(10초) 안으로 맞춘다 — 실제 ${d.dur}`)
  }
})

test('자동 확정 열쇠는 분석마다 달라지고, 이름·경로의 공백으로 겹치지 않는다', () => {
  assert.notEqual(autoConfirmKey('spk:A', 'C:/a.wav', 0), autoConfirmKey('spk:A', 'C:/a.wav', 1))
  assert.notEqual(autoConfirmKey('spk:사람 A', 'b', 0), autoConfirmKey('spk:사람', 'A b', 0))
})
