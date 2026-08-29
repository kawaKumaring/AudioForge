// ExpressionControls 순수 로직 테스트 (C 소유). node:test + assert.
// 순수 로직 모듈(.logic.ts, React/JSX 비의존)에서 EXPLICIT '.ts' 확장자로 import한다(레포 규약).
// → node --test가 로더 없이 type-strip해 바로 실행 가능(node_modules 불필요).
// 검증 대상: 프리셋 값 표, 프리셋 라벨, 활성 컨트롤 판정(capability 게이팅), 접힘 요약 문자열.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPRESSION_PRESETS,
  EXPRESSION_PRESET_IDS,
  getPresetValues,
  presetLabel,
  activeControlKeys,
  summarizeExpression,
} from './ExpressionControls.logic.ts'
import type { ExpressionCapabilities } from '../types/ttsExpression.ts'

const CAP_SUPPORTED_ONLY: ExpressionCapabilities = {
  pitch: true, speed: true, sentenceGap: true,
  emotionTransitionGap: false, tailTrim: false, tailPadding: false,
}

test('프리셋 4종: 자연스럽게/차분하게/밝게/무겁게', () => {
  assert.deepEqual(EXPRESSION_PRESETS.map(p => p.label), ['자연스럽게', '차분하게', '밝게', '무겁게'])
  assert.deepEqual([...EXPRESSION_PRESET_IDS], ['original', 'calm_low', 'bright_light', 'heavy_slow'])
})

test('프리셋 4종은 서로 다른 결과를 낸다(중복 항목 금지)', () => {
  const seen = new Set(EXPRESSION_PRESETS.map(p => JSON.stringify(p.values)))
  assert.equal(seen.size, EXPRESSION_PRESETS.length)
})

test('getPresetValues: 알려진 id는 값, 미상은 null', () => {
  assert.deepEqual(getPresetValues('original'), { pitchSemitones: 0, speed: 1.0, sentenceGapMs: 500 })
  assert.deepEqual(getPresetValues('bright_light'), { pitchSemitones: 1, speed: 1.05, sentenceGapMs: 400 })
  assert.deepEqual(getPresetValues('heavy_slow'), { pitchSemitones: -1, speed: 0.9, sentenceGapMs: 700 })
  assert.equal(getPresetValues('nope'), null)
})

test('프리셋 pitch는 보수적(±1 이내 — 유사도 보호)', () => {
  for (const p of EXPRESSION_PRESETS) {
    assert.ok(Math.abs(p.values.pitchSemitones) <= 1, `${p.id} pitch ${p.values.pitchSemitones} <= 1`)
  }
})

test('presetLabel: 미상 id → 사용자 지정', () => {
  assert.equal(presetLabel('heavy_slow'), '무겁게')
  assert.equal(presetLabel('custom-xyz'), '사용자 지정')
})

test('activeControlKeys: 지원 축만 활성(미구현 축은 제외 = 가짜 슬라이더 방지)', () => {
  assert.deepEqual(activeControlKeys(CAP_SUPPORTED_ONLY), ['pitch', 'speed', 'sentenceGap'])
  // 미구현 축이 모두 false면 절대 목록에 없다.
  const keys = activeControlKeys(CAP_SUPPORTED_ONLY)
  assert.ok(!keys.includes('emotionTransitionGap'))
  assert.ok(!keys.includes('tailTrim'))
  assert.ok(!keys.includes('tailPadding'))
})

test('activeControlKeys: capability=true일 때만 후처리 축 노출', () => {
  const all: ExpressionCapabilities = {
    pitch: true, speed: true, sentenceGap: true,
    emotionTransitionGap: true, tailTrim: true, tailPadding: true,
  }
  assert.deepEqual(activeControlKeys(all), ['pitch', 'speed', 'sentenceGap', 'emotionTransitionGap', 'tailTrim', 'tailPadding'])
})

test('summarizeExpression: 기본값은 생략, 라벨 + 기본값', () => {
  const s = summarizeExpression('original', { pitchSemitones: 0, speed: 1.0, sentenceGapMs: 500 }, CAP_SUPPORTED_ONLY)
  assert.equal(s, '자연스럽게 · 기본값')
})

test('summarizeExpression: 비기본값은 표기(음높이/속도/문장 간격)', () => {
  const s = summarizeExpression('bright_light', { pitchSemitones: 1, speed: 1.05, sentenceGapMs: 400 }, CAP_SUPPORTED_ONLY)
  assert.equal(s, '밝게 · 음높이 +1.0반음 · 속도 1.05x · 문장 간격 0.4초')
})

test('summarizeExpression: capability=false 축은 요약에서 억제', () => {
  const capNoPitch: ExpressionCapabilities = { ...CAP_SUPPORTED_ONLY, pitch: false }
  const s = summarizeExpression('calm_low', { pitchSemitones: -1, speed: 0.95, sentenceGapMs: 650 }, capNoPitch)
  // pitch 억제 → 음높이 항목 없음
  assert.ok(!s.includes('음높이'))
  assert.ok(s.includes('속도 0.95x'))
  assert.ok(s.includes('문장 간격 0.65초'))
})

test('음수 pitch 표기(+ 없음)', () => {
  const s = summarizeExpression('calm_low', { pitchSemitones: -1, speed: 1.0, sentenceGapMs: 500 }, CAP_SUPPORTED_ONLY)
  assert.equal(s, '차분하게 · 음높이 -1.0반음')
})
