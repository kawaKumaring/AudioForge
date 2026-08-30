// 분석 문구 계약 — 기본 화면은 사용자 언어만 쓰고, 없는 숫자를 지어내지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INSUFFICIENT_TEXT, SPLIT_REASON_LABEL, canShowWallTime, confidenceLabel, formatDuration,
  formatRange, isForcedSplit, paragraphSummary, splitRows, summaryLine,
} from './analysisWording.ts'
import type { AnalysisResult } from './inputAnalysis.ts'

const base = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  schemaVersion: 3, requestId: 'r1', sourceSha256: 'a', normalizedSha256: 'a',
  tokenizer: 'production', characterCount: 10, sourceParagraphCount: 1, segmentCount: 1,
  productionTokens: 20, plannedCalls: 1, splitCapProductionTokens: 379,
  estimatedAudioSeconds: { min: 130, max: 155 },
  estimatedWallSeconds: { min: 360, max: 480 },
  confidence: 'measured', confidenceReason: 'WITHIN_MEASURED_FRAME_RANGE',
  mode: 'high_quality_icl', warnings: [],
  sourceParagraphs: [{ index: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 10, chars: 10, blankLinesBefore: 0 }],
  segments: [{
    index: 0, sourceParagraphIndex: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 10, chars: 10,
    sentenceCount: 1, emotionId: null, boundaryKind: null, productionTokens: 20, plannedCalls: 1,
    autoSplit: false, estimatedAudioSeconds: { min: 130, max: 155 },
    estimatedWallSeconds: { min: 360, max: 480 },
  }],
  chunks: [{
    globalIndex: 0, sourceParagraphIndex: 0, segmentIndex: 0, localChunkIndex: 0,
    sourceStart: 0, sourceEnd: 10, sourceOffsetsExact: true, chars: 10, productionTokens: 20,
    combinedPromptTokens: 57, generationTier: 256, fitsBudget: true, boundaryKind: null,
    splitReason: 'end_of_input', estimatedAudioSeconds: { min: 130, max: 155 },
  }],
  ...over,
})

test('길이는 분·초로 읽힌다', () => {
  assert.equal(formatDuration(0), '0초')
  assert.equal(formatDuration(59), '59초')
  assert.equal(formatDuration(60), '1분')
  assert.equal(formatDuration(130), '2분 10초')
})

test('반올림 뒤 같아지면 범위를 한 값으로 말한다', () => {
  assert.equal(formatRange({ min: 130, max: 155 }), '2분 10초~2분 35초')
  assert.equal(formatRange({ min: 130, max: 130.4 }), '2분 10초')
  assert.equal(formatRange(null), null)
})

test('기본 요약은 사용자 언어만 쓴다', () => {
  const line = summaryLine(base({ plannedCalls: 3 }))
  assert.equal(line, '예상 음성 2분 10초~2분 35초 · 예상 작업 6분~8분 · 3개 묶음')
  for (const jargon of ['token', 'chunk', 'tier', 'segment']) {
    assert.equal(line.includes(jargon), false, `기본 화면에 내부 용어가 새면 안 된다: ${jargon}`)
  }
})

test('근사 tokenizer 에서는 시간 숫자를 만들지 않는다', () => {
  const r = base({ tokenizer: 'approximate', estimatedWallSeconds: null })
  assert.equal(canShowWallTime(r), false)
  const line = summaryLine(r)
  assert.equal(line.includes(INSUFFICIENT_TEXT), true)
  assert.equal(/\d+분/.test(line.split('예상 작업')[1] ?? ''), false,
    '근사 토큰으로 시간을 지어내면 안 된다')
  // 음성 길이는 토큰 계산과 별개로 낼 수 있으므로 그대로 보인다.
  assert.equal(line.includes('예상 음성'), true)
})

test('자료 부족이면 시간을 숫자로 말하지 않는다', () => {
  const r = base({ confidence: 'insufficient_data', estimatedWallSeconds: null })
  assert.equal(canShowWallTime(r), false)
  assert.equal(summaryLine(r).includes(INSUFFICIENT_TEXT), true)
})

test('문단 요약은 문단 축으로만 합산한다', () => {
  const r = base({
    sourceParagraphCount: 1, segmentCount: 2, plannedCalls: 2,
    segments: [
      { ...base().segments[0], index: 0, plannedCalls: 1 },
      { ...base().segments[0], index: 1, plannedCalls: 1, autoSplit: true },
    ],
  })
  const s = paragraphSummary(r, 0)
  assert.equal(s.calls, 2, '한 문단 안의 두 구간을 합쳐 센다')
  assert.equal(s.autoSplit, true)
  assert.equal(s.audio, '4분 20초~5분 10초')
})

test('없는 문단을 물으면 숫자를 만들지 않는다', () => {
  const s = paragraphSummary(base(), 9)
  assert.equal(s.calls, 0)
  assert.equal(s.audio, null)
})

test('분할 목록은 실제로 일어난 분할만 담는다', () => {
  assert.deepEqual(splitRows(base()), [], '묶음이 하나면 분할이 없다')
  const two = base({
    plannedCalls: 2,
    chunks: [
      { ...base().chunks[0], globalIndex: 0, splitReason: 'sentence_end' },
      { ...base().chunks[0], globalIndex: 1, splitReason: 'end_of_input' },
    ],
  })
  const rows = splitRows(two)
  assert.equal(rows.length, 1, '마지막 묶음의 대사 끝은 분할이 아니다')
  assert.equal(rows[0].label, '완결 문장 경계')
  assert.equal(rows[0].forced, false)
})

test('최후 분할만 경고다', () => {
  assert.equal(isForcedSplit('forced_character'), true)
  for (const r of ['user_paragraph', 'sentence_end', 'clause', 'end_of_input'] as const) {
    assert.equal(isForcedSplit(r), false)
  }
  assert.equal(SPLIT_REASON_LABEL.forced_character, '최후 분할')
  assert.equal(SPLIT_REASON_LABEL.user_paragraph, '사용자 문단 경계')
  assert.equal(SPLIT_REASON_LABEL.clause, '보조 분할')
})

test('신뢰도 문구는 상세 보기 전용이고 자료 부족을 감추지 않는다', () => {
  assert.equal(confidenceLabel(base()), '실측 범위 안')
  assert.equal(confidenceLabel(base({ confidence: 'extrapolated' })), '실측 범위 밖 — 외삽')
  assert.equal(confidenceLabel(base({ tokenizer: 'approximate' })).includes('표시하지 않습니다'), true)
  assert.equal(confidenceLabel(null), '')
})

test('결과가 없으면 빈 문자열이지 0 이 아니다', () => {
  assert.equal(summaryLine(null), '')
  assert.equal(canShowWallTime(null), false)
  assert.deepEqual(splitRows(null), [])
})
