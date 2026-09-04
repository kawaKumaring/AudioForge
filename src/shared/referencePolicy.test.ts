import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  policyFromAnalysis, LEGACY_POLICY_FALLBACK, regionSliderBounds, clampDuration, judgeLength,
  lengthConditionText, regionNeedText, tooShortText, blockMessage, regionText, lifecycleBoundsFromPolicy,
  regionThresholdSec, fmtRange, SLIDER_STEP_SEC, committedMismatchText, outsideRecommendedText,
} from './referencePolicy.ts'

const GPT = policyFromAnalysis({ policy: {
  engine: 'gptsovits', required: { min_sec: 3, max_sec: 10 }, recommended: { min_sec: null, max_sec: null },
  basis: 'vendor', recommended_basis: '' } })
const QWEN = policyFromAnalysis({ policy: {
  engine: 'qwen3', required: { min_sec: null, max_sec: null }, recommended: { min_sec: 3, max_sec: 10 },
  basis: 'no vendor limit', recommended_basis: 'verified 6.5~7.5s' } })

test('policy 가 없는(구 워커) 응답은 예전 표시(GPT-SoVITS 필수 3~10초)로 폴백한다', () => {
  assert.deepEqual(policyFromAnalysis({ duration_sec: 12 }), LEGACY_POLICY_FALLBACK)
  assert.deepEqual(policyFromAnalysis(null), LEGACY_POLICY_FALLBACK)
  assert.equal(policyFromAnalysis({ policy: { engine: 'qwen3', required: {}, recommended: {} } }).required.max_sec, null)
})

test('슬라이더 범위: 필수 한계가 있으면 그것, 없으면 step 한 칸 ~ 원본 전체', () => {
  assert.deepEqual(regionSliderBounds(GPT, 58.3), { min: 3, max: 10 })
  assert.deepEqual(regionSliderBounds(QWEN, 58.334), { min: SLIDER_STEP_SEC, max: 58.3 })
  assert.equal(clampDuration(GPT, 58.3, 14), 10)
  assert.equal(clampDuration(QWEN, 58.3, 14), 14)
  assert.equal(clampDuration(QWEN, 58.3, 0), SLIDER_STEP_SEC)
})

test('구간 추천 기준: 필수 상한 → 그것, 없으면 권장 상한', () => {
  assert.equal(regionThresholdSec(GPT), 10)
  assert.equal(regionThresholdSec(QWEN), 10)
})

test('길이 판정: GPT 는 필수 밖이면 차단, Qwen 은 권장 밖이면 경고만', () => {
  assert.equal(judgeLength(GPT, 2.9), 'blocked_short')
  assert.equal(judgeLength(GPT, 10.1), 'blocked_long')
  assert.equal(judgeLength(GPT, 7), 'ok')
  assert.equal(judgeLength(QWEN, 2.9), 'outside_recommended')
  assert.equal(judgeLength(QWEN, 14), 'outside_recommended')
  assert.equal(judgeLength(QWEN, 7), 'ok')
})

test('문구는 정책 숫자에서 나온다 — 화면 코드에 3/10 을 다시 적지 않는다', () => {
  assert.equal(fmtRange(GPT.required), '3~10초')
  assert.equal(lengthConditionText(GPT), '필수 3~10초')
  assert.equal(lengthConditionText(QWEN), '권장 3~10초(검증 범위) · 길이 필수 조건 없음')
  assert.ok(regionNeedText(GPT, 58.3, true).includes('그대로 쓸 수 없습니다') && regionNeedText(GPT, 58.3, true).includes('3~10초'))
  const q = regionNeedText(QWEN, 58.3, false)
  assert.ok(q.includes('권장 길이(3~10초)') && q.includes('검증되지 않았습니다') && !q.includes('쓸 수 없습니다'))
  assert.ok(tooShortText(GPT, 2.5).includes('3초 이상'))
  assert.ok(outsideRecommendedText(QWEN, 14).includes('검증된 범위(3~10초)'))
  assert.ok(committedMismatchText(GPT, 14).includes('필수 조건(3~10초)') && committedMismatchText(GPT, 14).includes('다시 확정'))
  assert.equal(blockMessage('REGION_TOO_LONG', GPT), '구간이 너무 깁니다(10초 이하).')
  assert.equal(blockMessage('REGION_SNAP_RANGE_UNSATISFIABLE', GPT), '3~10초 안에 들어가는 안전한 구간을 만들 수 없습니다.')
  assert.equal(blockMessage('REGION_NEAR_SILENT', QWEN), '거의 무음입니다.')
  assert.equal(blockMessage('SOMETHING_NEW', QWEN), 'SOMETHING_NEW')
})

test('카드 표시: 실제 사용 구간 / 원본 전체', () => {
  assert.equal(regionText({ start: 26.48, duration: 6.57 }), '26.5초부터 6.6초')
  assert.equal(regionText(null), '원본 전체')
})

test('자산 수명 경계: GPT 3~10 / Qwen 0~권장 상한 / 정책 모름 → 예전 경계', () => {
  assert.deepEqual(lifecycleBoundsFromPolicy(GPT), { minSec: 3, maxSec: 10 })
  assert.deepEqual(lifecycleBoundsFromPolicy(QWEN), { minSec: 0, maxSec: 10 })
  assert.deepEqual(lifecycleBoundsFromPolicy(null), { minSec: 3, maxSec: 10 })
})
