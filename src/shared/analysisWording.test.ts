// 분석 문구 계약 — 기본 화면은 사용자 언어만 쓰고, 없는 숫자를 지어내지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AXIS_NOTE, INSUFFICIENT_TEXT, PLAN_WARNING_HINT, PLAN_WARNING_LABEL, RESERVED_AXIS_LABELS,
  SPLIT_REASON_LABEL, axisRelationLine, canShowWallTime, confidenceLabel, emotionSpanRows,
  formatDuration, formatRange, isForcedSplit, paragraphSummary, planIsApproximate,
  planWarningRows, preparationNote, splitRows, summaryLine, utteranceRows, warningWhere,
} from './analysisWording.ts'
import type {
  AnalysisChunk, AnalysisResult, PlanUtterance, PlanWarning, ScriptPlan,
} from './inputAnalysis.ts'

const chunk = (over: Partial<AnalysisChunk> = {}): AnalysisChunk => ({
  globalIndex: 0, sourceParagraphIndex: 0, segmentIndex: 0, localChunkIndex: 0,
  sourceStart: 0, sourceEnd: 10, sourceOffsetsExact: true, chars: 10, productionTokens: 20,
  combinedPromptTokens: 57, generationTier: 256, fitsBudget: true, boundaryKind: null,
  splitReason: 'end_of_input', estimatedAudioSeconds: { min: 130, max: 155 },
  ...over,
})

const utterance = (over: Partial<PlanUtterance> = {}): PlanUtterance => ({
  index: 0, sourceParagraphIndex: 0, lineIndex: 0, speakerId: null, emotionId: null,
  boundaryKind: null, sourceStart: 0, sourceEnd: 10, textStart: 0, textEnd: 10, chars: 10,
  sourceOffsetsExact: true,
  ...over,
})

/** 계획 층. 화면이 읽는 유일한 출처라서 fixture 도 여기에 둔다. */
const plan = (over: Partial<ScriptPlan> = {}): ScriptPlan => ({
  planSchemaVersion: 1, parserVersion: 2, sourceSha256: 'a', normalizedSha256: 'a',
  parserAuthority: true,
  sourceParagraphs: [{
    index: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 10, textStart: 0, textEnd: 10,
    chars: 10, blankLinesBefore: 0,
  }],
  utterances: [utterance()],
  emotions: [], pauses: [], warnings: [], sentences: [],
  chunks: [chunk()],
  structureSha256: 'deadbeef',
  ...over,
})

const base = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  schemaVersion: 5, requestId: 'r1', sourceSha256: 'a', normalizedSha256: 'a',
  plan: plan(),
  tokenizer: 'production', characterCount: 10, sourceParagraphCount: 1, segmentCount: 1,
  productionTokens: 20, plannedCalls: 1, splitCapProductionTokens: 379,
  estimatedAudioSeconds: { min: 130, max: 155 },
  estimatedWallSeconds: { min: 360, max: 480 },
  preparationSeconds: { min: 57, max: 71 },
  confidence: 'measured', confidenceReason: 'WITHIN_MEASURED_FRAME_RANGE',
  mode: 'high_quality_icl', warnings: [],
  sourceParagraphs: [{ index: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 10, chars: 10, blankLinesBefore: 0 }],
  segments: [{
    index: 0, sourceParagraphIndex: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 10, chars: 10,
    sentenceCount: 1, emotionId: null, boundaryKind: null, productionTokens: 20, plannedCalls: 1,
    autoSplit: false, estimatedAudioSeconds: { min: 130, max: 155 },
    estimatedWallSecondsMarginal: { min: 300, max: 410 },
  }],
  chunks: [chunk()],
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
  assert.equal(line, '예상 음성 2분 10초~2분 35초 · 예상 작업 6분~8분(모델 준비 포함) · 3개 묶음')
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

// ── 인수 결정 반영 (2026-08-31) ────────────────────────────────────────────────
// 1) 신뢰도는 상세 보기에만 둔다 — 장문에서는 거의 늘 '외삽' 이라 요약에서는 잡음이다.
// 2) 작업 시간에는 모델 준비 비용이 들어 있다는 사실을 요약에서 밝힌다.
test('요약에 신뢰도 문구가 새지 않는다', () => {
  for (const c of ['measured', 'extrapolated', 'insufficient_data'] as const) {
    const line = summaryLine(base({ confidence: c }))
    for (const leak of ['실측', '외삽', 'MEASURED', 'EXTRAPOLATED']) {
      assert.equal(line.includes(leak), false, `요약에 신뢰도가 새면 안 된다: ${leak}`)
    }
  }
})

test('요약이 작업 시간에 모델 준비가 포함됨을 밝힌다', () => {
  assert.equal(summaryLine(base()).includes('모델 준비 포함'), true)
  // 시간을 못 내는 상태에서는 붙이지 않는다 — 없는 숫자를 설명할 이유가 없다.
  const none = summaryLine(base({ tokenizer: 'approximate', estimatedWallSeconds: null }))
  assert.equal(none.includes('모델 준비 포함'), false)
  assert.equal(none.includes(INSUFFICIENT_TEXT), true)
})

test('상세 보기가 준비 시간을 수치로 밝힌다', () => {
  const note = preparationNote(base())
  assert.equal(typeof note === 'string' && note.includes('57초~1분 11초'), true, String(note))
  assert.equal(preparationNote(base({ preparationSeconds: null })), null)
  assert.equal(preparationNote(base({ tokenizer: 'approximate', estimatedWallSeconds: null })), null)
})

test('문단 줄의 작업 시간 합이 전체 작업 시간을 넘지 않는다', () => {
  // 문단마다 고정 준비 비용을 다시 세면 이 관계가 깨진다 — 화면의 숫자가 서로 어긋난다.
  const seg = (i: number, marginal: { min: number; max: number }) => ({
    index: i, sourceParagraphIndex: i, lineIndex: i, sourceStart: 0, sourceEnd: 10, chars: 10,
    sentenceCount: 1, emotionId: null, boundaryKind: null, productionTokens: 20, plannedCalls: 1,
    autoSplit: false, estimatedAudioSeconds: { min: 1, max: 2 },
    estimatedWallSecondsMarginal: marginal,
  })
  const r = base({
    sourceParagraphCount: 3, segmentCount: 3, plannedCalls: 3,
    estimatedWallSeconds: { min: 360, max: 480 },
    sourceParagraphs: [0, 1, 2].map((i) => ({
      index: i, lineIndex: i, sourceStart: 0, sourceEnd: 10, chars: 10, blankLinesBefore: 0,
    })),
    segments: [seg(0, { min: 9, max: 11 }), seg(1, { min: 4, max: 7 }), seg(2, { min: 4, max: 7 })],
  })
  let sum = 0
  for (const i of [0, 1, 2]) {
    const p = paragraphSummary(r, i)
    assert.equal(typeof p.wall === 'string', true, `문단 ${i} 시간이 있어야 한다`)
    sum += r.segments[i].estimatedWallSecondsMarginal.max
  }
  assert.equal(sum <= r.estimatedWallSeconds.max, true,
    `문단 합 ${sum} 이 전체 ${r.estimatedWallSeconds.max} 를 넘으면 안 된다`)
})

// -- 공용 계획을 읽는 문구 -----------------------------------------------------

const warn = (over: Partial<PlanWarning>): PlanWarning => ({
  code: 'UNCLOSED_TAG', lineIndex: null, sourceStart: null, sourceEnd: null,
  textStart: null, textEnd: null, reason: null, ...over,
})

test('세 축을 같은 이름으로 부르지 않는다', () => {
  // 문단 1 · 발화 2 · 묶음 3 — 한 문단에서 감정이 바뀌고 발화가 더 쪼개진 모습.
  const r = base({
    plan: plan({
      sourceParagraphs: [{
        index: 0, lineIndex: 0, sourceStart: 0, sourceEnd: 30, textStart: 0, textEnd: 30,
        chars: 30, blankLinesBefore: 0,
      }],
      utterances: [
        utterance({ index: 0, emotionId: 'happy', sourceEnd: 15, textEnd: 15 }),
        utterance({
          index: 1, emotionId: 'sad', sourceStart: 15, sourceEnd: 30,
          textStart: 15, textEnd: 30,
        }),
      ],
      chunks: [
        chunk({ globalIndex: 0, segmentIndex: 0 }),
        chunk({ globalIndex: 1, segmentIndex: 1 }),
        chunk({ globalIndex: 2, segmentIndex: 1 }),
      ],
    }),
  })
  assert.equal(axisRelationLine(r), '문단 1 · 발화 2 · 생성 묶음 3')
  assert.ok(AXIS_NOTE.includes('Enter'), '무엇이 문단인지 문구가 말해야 한다')
})

test('발화 줄은 계획의 묶음을 세지, 스스로 나누지 않는다', () => {
  const r = base({
    plan: plan({
      utterances: [
        utterance({ index: 0, emotionId: 'happy' }),
        utterance({ index: 1, emotionId: null, sourceOffsetsExact: false }),
      ],
      chunks: [
        chunk({ globalIndex: 0, segmentIndex: 0 }),
        chunk({ globalIndex: 1, segmentIndex: 0 }),
        chunk({ globalIndex: 2, segmentIndex: 1 }),
      ],
    }),
  })
  const rows = utteranceRows(r, 0)
  assert.deepEqual(rows.map((u) => u.calls), [2, 1])
  assert.deepEqual(rows.map((u) => u.autoSplit), [true, false])
  assert.deepEqual(rows.map((u) => u.approximate), [false, true],
    '근사를 정확하다고 말하지 않는다')
  assert.deepEqual(utteranceRows(r, 9), [], '없는 문단에 행을 만들지 않는다')
})

test('감정 구간은 이어지는 구간으로 말한다', () => {
  const r = base({
    plan: plan({
      emotions: [
        {
          index: 0, emotionId: 'happy', intensity: null, utteranceStart: 0, utteranceEnd: 1,
          sourceStart: 0, sourceEnd: 20, textStart: 0, textEnd: 20,
        },
        {
          index: 1, emotionId: 'sad', intensity: null, utteranceStart: 2, utteranceEnd: 2,
          sourceStart: 20, sourceEnd: 30, textStart: 20, textEnd: 30,
        },
      ],
    }),
  })
  const rows = emotionSpanRows(r)
  assert.deepEqual(rows.map((e) => e.utteranceLabel), ['발화 1~2', '발화 3'])
  assert.deepEqual(rows.map((e) => e.emotionId), ['happy', 'sad'])
})

test('경고는 사용자 언어와 위치로 말한다 — 내부 코드를 화면에 쓰지 않는다', () => {
  const r = base({
    plan: plan({
      warnings: [
        warn({ code: 'UNCLOSED_TAG', lineIndex: 2, sourceStart: 30, sourceEnd: 30 }),
        warn({ code: 'UNKNOWN_DIRECTIVE', sourceStart: 5, reason: 'format', tag: '쉼' }),
      ],
    }),
  })
  const rows = planWarningRows(r)
  assert.deepEqual(rows.map((w) => w.label), ['닫히지 않은 표기', '알 수 없는 표기'])
  assert.deepEqual(rows.map((w) => w.where), ['3번째 줄', '6번째 글자'])
  assert.equal(rows[1].tag, '쉼')
  for (const w of rows) {
    assert.ok(w.hint.length > 0, '무슨 일이 일어나는지 한 마디는 있어야 한다')
    assert.equal(w.label.includes('_'), false, '내부 enum 이 화면에 새면 안 된다')
  }
  assert.deepEqual(planWarningRows(base()), [], '경고가 없으면 행도 없다')
})

test('경고 위치는 줄을 알면 줄로, 모르면 글자로 말한다', () => {
  assert.equal(warningWhere(warn({ lineIndex: 0 })), '1번째 줄')
  assert.equal(warningWhere(warn({ sourceStart: 0 })), '1번째 글자')
  assert.equal(warningWhere(warn({})), '위치 불명', '모르는 위치를 지어내지 않는다')
})

test('모든 경고 코드에 문구가 있다 — 코드가 그대로 노출되지 않는다', () => {
  const codes = Object.keys(PLAN_WARNING_LABEL) as (keyof typeof PLAN_WARNING_LABEL)[]
  assert.equal(codes.length, 5)
  for (const code of codes) {
    assert.ok(PLAN_WARNING_LABEL[code].length > 0, code)
    assert.ok(PLAN_WARNING_HINT[code].length > 0, code)
  }
})

test('파서가 물러났으면 근사임을 화면이 말한다', () => {
  assert.equal(planIsApproximate(base()), false)
  assert.equal(planIsApproximate(base({ plan: plan({ parserAuthority: false }) })), true)
})

test('앞으로 들어올 축은 이름만 있고 값이 없다', () => {
  assert.deepEqual(RESERVED_AXIS_LABELS.map((a) => a.axis),
    ['speakers', 'prosody', 'actions', 'ambience', 'music', 'spatial'])
  for (const a of RESERVED_AXIS_LABELS) {
    assert.ok(a.label.length > 0)
    assert.equal(/[a-z]/.test(a.label), false, '화면 문구는 한국어다')
  }
})
