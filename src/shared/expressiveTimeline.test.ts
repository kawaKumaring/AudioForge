// 표현형 운율 v3 계약 테스트 (TS, node --test).
//
// 검증 축:
//   A. v2 불변식 — parseTtsScript 출력/해시가 오늘과 완전히 동일(내용 기반 자동 승격 없음)
//   B. 모드 선택 — 플래그 부재=legacy_v2, 명시 v3 만 v3
//   C. 어휘/lexing — longest-token-first(!? / 점 런), 대괄호 밖 웃음은 리터럴
//   D. 이벤트 계약 — 감정 전이/국소 운율/웃음/쉼/경계 우선순위
//   E. 원문 무손실 round-trip
//   F. parity — 권위 픽스처(test/fixtures/expressive-timeline-v3.json)의 고정 해시/구조 재현
//   G. 드리프트 가드 — ttsGrammar.ts 거울 상수 일치
//   H. 모드 플래그 영속(session/config/metadata 3중 일치)
//
// ⚠️ 실패 보고는 case id·필드명만(대사 전문 로그 금지).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  parseExpressiveTimeline, verifyRoundTrip, reconstructSource, resolveVowelExtend,
  expressiveSha256Hex,
  EXPRESSIVE_CONTRACT_VERSION, EXPRESSIVE_LEGACY_PLAN_VERSION, EXPRESSIVE_MODES,
  EXPRESSIVE_DEFAULT_MODE, EXPRESSIVE_MODE_TO_VERSION, EXPRESSIVE_EVENT_PRIORITY,
  EXPRESSIVE_ERROR_CODES, LOCAL_PROSODY_KINDS, LAUGH_STYLES, LAUGH_POSITIONS,
  EXPRESSIVE_NODE_KINDS, EXPRESSIVE_BOUNDARY_KINDS, PROSODY_SCOPE_KINDS,
  EMOTION_TRANSITION_MODES, VOWEL_EXTEND_DEGRADE_REASONS,
  EXPRESSIVE_EMOTION_LABEL_TO_ID, EXPRESSIVE_PAUSE_NAMES, EXPRESSIVE_WHITESPACE_CHARS,
  DOT_RUN_MAX_COUNT, BANG_RUN_MAX_COUNT, QUESTION_RUN_MAX_COUNT, SHOCK_RUN_MAX_COUNT,
  TILDE_RUN_MAX_COUNT, LAUGH_REPEAT_MAX_COUNT, LOCAL_PROSODY_TAIL_SYLLABLES,
  FIRM_END_STRENGTH, EMOTION_TRANSITION_EXTRA_PAUSE_MS, EMOTION_TRANSITION_IS_CHUNK_BOUNDARY,
  LOCAL_PROSODY_IS_CHUNK_BOUNDARY, SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM,
  SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE, FINAL_TAIL_APPLIES_ONCE_AT_FILE_END,
  EXPRESSIVE_MODE_FIELD, EXPRESSIVE_MODE_CARRIERS, EXPRESSIVE_MODE_CARRIER_PAIRS,
  EXPRESSIVE_MODE_PRESET_MAY_CHANGE,
  resolveExpressiveMode, readExpressiveMode, writeExpressiveMode,
  applyPresetPreservingExpressiveMode, assertExpressiveModeCarriers,
  type ExpressiveMode, type ExpressiveTimeline, type ExpressiveParseResult,
} from './expressiveTimeline.ts'
import {
  parseTtsScript, TTS_PARSER_VERSION, TTS_EMOTION_LABEL_TO_ID, TTS_PAUSE_NAMES, sha256Hex,
} from './ttsGrammar.ts'

const fxPath = fileURLToPath(new URL('../../test/fixtures/expressive-timeline-v3.json', import.meta.url))
const fx = JSON.parse(readFileSync(fxPath, 'utf-8'))
const meta = fx._meta
const vectors: any[] = fx.vectors
const errorCases: any[] = fx.errors
const legacyCorpus: any[] = fx.legacy_no_migration

const pinnedV2 = JSON.parse(readFileSync(
  fileURLToPath(new URL('./ttsGrammar.parity-hashes.json', import.meta.url)), 'utf-8',
)) as Record<string, string>

function okTimeline(r: ExpressiveParseResult, id: string): ExpressiveTimeline {
  assert.equal(r.ok, true, `id=${id} parse ok 기대`)
  if (!r.ok) throw new Error('unreachable')
  return r.timeline
}

// 표현형 토큰을 모두 담은 입력(내용 기반 승격이 없음을 증명하는 데 쓴다).
const ALL_TOKEN_INPUT = '다 끝났다!? 정말...... 그렇구나~ [ㅋㅋ] 마지막.'

// ─────────────────────────────────────────────────────────────────────────────
// A. v2 불변식 — 오늘 합성되는 스크립트의 계획/해시가 바뀌지 않는다
// ─────────────────────────────────────────────────────────────────────────────

test('A1: v2 pinned 벡터 전부 오늘과 동일한 full sha256 (표현형 레이어 추가 후에도)', () => {
  for (const [input, expected] of Object.entries(pinnedV2)) {
    const r = parseTtsScript(input)
    assert.equal(r.ok, true, 'v2 pinned 입력은 성공 파싱')
    if (!r.ok) continue
    assert.equal(r.plan.fullSha256, expected)
    assert.equal(r.plan.parserVersion, 2)
  }
})

test('A2: v2 conformance corpus 전부 고정 해시 재현 (fixture legacy_no_migration)', () => {
  assert.ok(legacyCorpus.length >= 20, 'legacy corpus 최소 크기')
  for (const row of legacyCorpus) {
    const r = parseTtsScript(row.input)
    assert.equal(r.ok, true)
    if (!r.ok) continue
    assert.equal(r.plan.fullSha256, row.v2_full_sha256, 'v2 full sha256 변화 없음')
    assert.equal(r.plan.parserVersion, row.v2_parser_version)
    assert.equal(r.plan.parserVersion, TTS_PARSER_VERSION)
  }
})

test('A3: 표현형 토큰(!? / ...... / ~ / [ㅋㅋ])이 있어도 v2 파서는 그대로 v2 결과', () => {
  // [ㅋㅋ] 는 v2 에서 오늘도 UNKNOWN_TTS_TAG 로 차단된다 → 회귀 없음(오늘과 동일).
  const withLaugh = parseTtsScript(ALL_TOKEN_INPUT)
  assert.equal(withLaugh.ok, false, '[ㅋㅋ] 는 v2 에서 오늘과 동일하게 차단')
  if (!withLaugh.ok) assert.ok(withLaugh.errors.some((e) => e.code === 'UNKNOWN_TTS_TAG'))

  // 웃음 대괄호를 뺀 나머지 표현형 토큰은 v2 에서 리터럴 텍스트로 남는다(오늘과 동일).
  const noLaugh = '다 끝났다!? 정말...... 그렇구나~ 마지막.'
  const r = parseTtsScript(noLaugh)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.plan.parserVersion, 2)
  assert.equal(r.plan.segments.length, 1)
  assert.equal(r.plan.segments[0].spokenText, noLaugh, 'v2 는 문장부호를 텍스트로 그대로 둔다')
})

test('A4: 표현형 파서를 legacy 모드로 돌려도 v2 해시는 영향을 받지 않는다(레이어 독립)', () => {
  for (const row of legacyCorpus) {
    const before = parseTtsScript(row.input)
    parseExpressiveTimeline(row.input) // 기본 legacy_v2
    parseExpressiveTimeline(row.input, { mode: 'expressive_v3' })
    const after = parseTtsScript(row.input)
    assert.equal(before.ok, true)
    assert.equal(after.ok, true)
    if (!before.ok || !after.ok) continue
    assert.equal(after.plan.fullSha256, row.v2_full_sha256)
    assert.equal(before.plan.fullSha256, after.plan.fullSha256)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 모드 선택 — 내용이 아니라 호출자가 고른다
// ─────────────────────────────────────────────────────────────────────────────

test('B1: 플래그 부재 → legacy_v2 (표현형 토큰 전부 포함한 입력에서도)', () => {
  const r = parseExpressiveTimeline(ALL_TOKEN_INPUT)
  // [ㅋㅋ] 는 legacy 에서 UNKNOWN → 실패지만 mode/effectiveVersion 은 그대로 노출된다.
  assert.equal(r.mode, 'legacy_v2')
  assert.equal(r.effectiveVersion, 2)
  assert.equal(EXPRESSIVE_DEFAULT_MODE, 'legacy_v2')

  const noLaugh = '다 끝났다!? 정말...... 그렇구나~ 마지막.'
  const t = okTimeline(parseExpressiveTimeline(noLaugh), 'B1')
  assert.equal(t.mode, 'legacy_v2')
  assert.equal(t.effectiveVersion, 2)
  assert.equal(t.expressiveEnabled, false)
  assert.equal(t.hasExpressiveEvents, false)
  assert.equal(t.localProsody.length, 0, 'legacy 는 운율 이벤트를 만들지 않는다')
  assert.equal(t.laughs.length, 0, 'legacy 는 웃음 이벤트를 만들지 않는다')
  assert.equal(t.plainText, noLaugh, 'legacy 는 문장부호를 텍스트로 그대로 둔다')
})

test('B2: 명시 expressive_v3 → v3', () => {
  const t = okTimeline(parseExpressiveTimeline(ALL_TOKEN_INPUT, { mode: 'expressive_v3' }), 'B2')
  assert.equal(t.mode, 'expressive_v3')
  assert.equal(t.effectiveVersion, 3)
  assert.equal(t.expressiveEnabled, true)
  assert.ok(t.localProsody.length > 0)
  assert.ok(t.laughs.length > 0)
})

test('B3: v2 세션 복원 후 재파싱 → v3 자동 전환 없음(버전·해시 유지)', () => {
  const session: Record<string, unknown> = { ttsText: ALL_TOKEN_INPUT } // 플래그 없음(레거시 세션)
  const restored = JSON.parse(JSON.stringify(session)) as Record<string, unknown>
  const res = readExpressiveMode(restored)
  assert.equal(res.mode, 'legacy_v2')
  assert.equal(res.source, 'absent')
  const r = parseExpressiveTimeline(String(restored.ttsText), { mode: res.mode })
  assert.equal(r.effectiveVersion, 2)
  // v2 해시도 그대로
  for (const row of legacyCorpus.slice(0, 5)) {
    const p = parseTtsScript(row.input)
    assert.equal(p.ok, true)
    if (p.ok) assert.equal(p.plan.fullSha256, row.v2_full_sha256)
  }
})

test('B4: 모드↔버전 표는 계약 그대로(2|3)', () => {
  assert.deepEqual([...EXPRESSIVE_MODES], ['legacy_v2', 'expressive_v3'])
  assert.equal(EXPRESSIVE_MODE_TO_VERSION.legacy_v2, 2)
  assert.equal(EXPRESSIVE_MODE_TO_VERSION.expressive_v3, 3)
  assert.equal(EXPRESSIVE_CONTRACT_VERSION, 3)
  assert.equal(EXPRESSIVE_LEGACY_PLAN_VERSION, 2)
})

// ─────────────────────────────────────────────────────────────────────────────
// C. lexing — longest-token-first
// ─────────────────────────────────────────────────────────────────────────────

test('C1: "!?" 는 하나의 shock_rise 토큰(절대 !+? 로 쪼개지지 않음)', () => {
  for (const src of ['뭐라고!?', '뭐라고?!']) {
    const t = okTimeline(parseExpressiveTimeline(src, { mode: 'expressive_v3' }), 'C1')
    assert.equal(t.localProsody.length, 1, `${src}: 토큰 1개`)
    assert.equal(t.localProsody[0].kind, 'shock_rise')
    assert.equal(t.localProsody[0].rawCount, 2)
    assert.equal(t.localProsody[0].rawToken.length, 2)
  }
})

test('C2: "......" 는 하나의 dot-run 토큰(...+... 아님)', () => {
  const t = okTimeline(parseExpressiveTimeline('글쎄......', { mode: 'expressive_v3' }), 'C2')
  assert.equal(t.localProsody.length, 1)
  assert.equal(t.localProsody[0].kind, 'fade_end')
  assert.equal(t.localProsody[0].rawCount, 6)
  assert.equal(t.localProsody[0].capped, false)
})

test('C3: 웃음 규칙이 일반 감정 태그 규칙보다 먼저 적용된다', () => {
  // 감정 vocab 에 'ㅋㅋ' 가 있어도 웃음이 이긴다(더 구체적인 규칙).
  const resolver = (n: string): string | null => (n === 'ㅋㅋ' ? 'happy' : (TTS_EMOTION_LABEL_TO_ID[n] ?? null))
  const t = okTimeline(parseExpressiveTimeline('[ㅋㅋ]', { mode: 'expressive_v3', resolveEmotion: resolver }), 'C3')
  assert.equal(t.laughs.length, 1)
  assert.equal(t.emotionTransitions.length, 0)
  assert.equal(t.laughs[0].style, 'chuckle')
})

test('C4: 대괄호 밖 "ㅋㅋㅋㅋ" 는 리터럴 텍스트(v3 에서도)', () => {
  const src = '웃겨 ㅋㅋㅋㅋ 진짜'
  for (const mode of EXPRESSIVE_MODES) {
    const t = okTimeline(parseExpressiveTimeline(src, { mode }), 'C4')
    assert.equal(t.laughs.length, 0, `${mode}: 웃음 이벤트 없음`)
    assert.equal(t.plainText, src, `${mode}: 원문 그대로 텍스트`)
  }
})

test('C5: 잘못/모호한 입력은 구조화 오류(조용한 추측 금지)', () => {
  const amb = parseExpressiveTimeline('[ㅋㅎ]', { mode: 'expressive_v3' })
  assert.equal(amb.ok, false)
  if (!amb.ok) assert.equal(amb.errors[0].code, 'AMBIGUOUS_LAUGH_TOKEN')

  const mod = parseExpressiveTimeline('[기쁨|살짝] 안녕', { mode: 'expressive_v3' })
  assert.equal(mod.ok, false)
  if (!mod.ok) assert.equal(mod.errors[0].code, 'INVALID_EMOTION_MODIFIER')

  const unk = parseExpressiveTimeline('[명란] 오타', { mode: 'expressive_v3' })
  assert.equal(unk.ok, false)
  if (!unk.ok) assert.equal(unk.errors[0].code, 'UNKNOWN_EXPRESSIVE_TAG')

  // 오류 payload 에 대사 전문 없음
  for (const r of [amb, mod, unk]) {
    if (r.ok) continue
    for (const e of r.errors) {
      assert.ok(!('spokenText' in (e as object)) && !('text' in (e as object)))
    }
  }
})

test('C6: control-tag 아닌 대괄호는 v2 와 똑같이 리터럴화', () => {
  for (const src of ['[기쁨 안녕하세요]', '[]', '[미종료 태그']) {
    for (const mode of EXPRESSIVE_MODES) {
      const t = okTimeline(parseExpressiveTimeline(src, { mode }), 'C6')
      assert.equal(t.emotionTransitions.length, 0)
      assert.equal(t.explicitPauses.length, 0)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 이벤트 계약
// ─────────────────────────────────────────────────────────────────────────────

test('D1: 감정 태그 = 전이 지점(기본 blend, pause 0, chunk 경계 아님)', () => {
  const t = okTimeline(parseExpressiveTimeline('[기쁨] 안녕 [슬픔] 잘가', { mode: 'expressive_v3' }), 'D1')
  assert.equal(t.emotionTransitions.length, 2)
  for (const e of t.emotionTransitions) {
    assert.equal(e.transitionMode, 'blend')
    assert.equal(e.explicitMode, false)
    assert.equal(e.extraPauseMs, 0)
    assert.equal(e.extraPauseMs, EMOTION_TRANSITION_EXTRA_PAUSE_MS)
    assert.equal(e.isChunkBoundary, false)
    assert.equal(e.isChunkBoundary, EMOTION_TRANSITION_IS_CHUNK_BOUNDARY)
    assert.ok(e.transitionDurationHint > 0, 'blend 는 전이 시간이 있다')
  }
  // 감정 전이는 경계를 만들지 않는다 → 문장 gap 과 합산될 수 없다
  assert.ok(!t.boundaries.some((b) => (b.kind as string) === 'emotionTransition'))
  assert.equal(SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM, false)
})

test('D2: immediate 는 명시 요청일 때만', () => {
  const blend = okTimeline(parseExpressiveTimeline('[기쁨] 안녕', { mode: 'expressive_v3' }), 'D2')
  assert.equal(blend.emotionTransitions[0].transitionMode, 'blend')

  const imm = okTimeline(parseExpressiveTimeline('[기쁨|즉시] 안녕', { mode: 'expressive_v3' }), 'D2')
  assert.equal(imm.emotionTransitions[0].transitionMode, 'immediate')
  assert.equal(imm.emotionTransitions[0].explicitMode, true)
  assert.equal(imm.emotionTransitions[0].transitionDurationHint, 0)
  assert.equal(imm.emotionTransitions[0].extraPauseMs, 0, 'immediate 여도 무음은 만들지 않는다')

  const immEn = okTimeline(parseExpressiveTimeline('[happy|immediate] hi', { mode: 'expressive_v3' }), 'D2')
  assert.equal(immEn.emotionTransitions[0].transitionMode, 'immediate')
})

test('D3: 감정 태그 offset(dual)이 태그 시작 지점을 가리킨다', () => {
  const t = okTimeline(parseExpressiveTimeline('\u{1F389}[기쁨] 안녕', { mode: 'expressive_v3' }), 'D3')
  const e = t.emotionTransitions[0]
  assert.equal(e.sourceOffset.codepoint, 1, '🎉 다음 = code point 1')
  assert.equal(e.sourceOffset.utf16, 2, '🎉 는 UTF-16 2 code unit')
  assert.notEqual(e.sourceOffset.utf16, e.sourceOffset.codepoint)
})

test('D4: 홑점(.)은 중립 종결 — "..." 나 "!" 보다 뚜렷하게 약하다', () => {
  const one = okTimeline(parseExpressiveTimeline('안녕하세요.', { mode: 'expressive_v3' }), 'D4').localProsody[0]
  const three = okTimeline(parseExpressiveTimeline('안녕하세요...', { mode: 'expressive_v3' }), 'D4').localProsody[0]
  const bang = okTimeline(parseExpressiveTimeline('안녕하세요!', { mode: 'expressive_v3' }), 'D4').localProsody[0]
  assert.equal(one.kind, 'firm_end')
  assert.equal(one.strength, FIRM_END_STRENGTH)
  assert.ok(one.strength < three.strength, `. (${one.strength}) < ... (${three.strength})`)
  assert.ok(one.strength < bang.strength, `. (${one.strength}) < ! (${bang.strength})`)
  assert.ok(one.durationHint < three.durationHint)
  assert.notEqual(one.kind, 'emphasis', '홑점은 emphasis 가 아니다')
})

test('D5: 점 런 개수 스케일 + 상한(텍스트는 그대로)', () => {
  const cases: Array<[string, number, boolean]> = [
    ['글쎄.', 1, false], ['글쎄..', 2, false], ['글쎄...', 3, false],
    ['글쎄......', DOT_RUN_MAX_COUNT, false], ['글쎄..........', 10, true],
  ]
  let prev = -1
  for (const [src, rawCount, capped] of cases) {
    const e = okTimeline(parseExpressiveTimeline(src, { mode: 'expressive_v3' }), 'D5').localProsody[0]
    assert.equal(e.rawCount, rawCount)
    assert.equal(e.capped, capped)
    assert.equal(e.effectiveCount, Math.min(rawCount, DOT_RUN_MAX_COUNT))
    assert.equal(e.rawToken, src.slice(2), '텍스트(rawToken)는 원문 그대로 — 잘라내지 않는다')
    if (rawCount > 1) { assert.ok(e.strength >= prev, '길수록 약해지지 않는다'); prev = e.strength }
  }
  // 상한을 넘겨도 효과는 max 와 같다
  const max = okTimeline(parseExpressiveTimeline('글쎄......', { mode: 'expressive_v3' }), 'D5').localProsody[0]
  const over = okTimeline(parseExpressiveTimeline('글쎄..........', { mode: 'expressive_v3' }), 'D5').localProsody[0]
  assert.equal(over.strength, max.strength)
  assert.equal(over.durationHint, max.durationHint)
  assert.equal(over.rawToken.length, 10, '원문 점 개수 보존')
})

test('D6: ! 는 문장 후반부 강조, ? 는 마지막 어절만 상승', () => {
  const bang = okTimeline(parseExpressiveTimeline('오늘 날씨 좋다!', { mode: 'expressive_v3' }), 'D6').localProsody[0]
  assert.equal(bang.kind, 'emphasis')
  assert.equal(bang.scopeKind, 'latter_half')
  assert.ok(bang.scopeRange.startCodepoint > bang.hostRange.startCodepoint, '문장 전체가 아니다')

  const q = okTimeline(parseExpressiveTimeline('오늘 날씨 좋다?', { mode: 'expressive_v3' }), 'D6').localProsody[0]
  assert.equal(q.kind, 'question_rise')
  assert.equal(q.scopeKind, 'final_word')
  assert.equal(q.scopeRange.endCodepoint - q.scopeRange.startCodepoint, 2, '마지막 어절 "좋다"만')
})

test('D7: 국소 운율은 마지막 몇 음절 범위이며 chunk 경계가 아니다', () => {
  const t = okTimeline(parseExpressiveTimeline('안녕하세요 반갑습니다.', { mode: 'expressive_v3' }), 'D7')
  const e = t.localProsody[0]
  assert.equal(e.scopeKind, 'final_syllables')
  assert.equal(e.scopeRange.endCodepoint - e.scopeRange.startCodepoint, LOCAL_PROSODY_TAIL_SYLLABLES)
  assert.equal(e.isChunkBoundary, false)
  assert.equal(e.isChunkBoundary, LOCAL_PROSODY_IS_CHUNK_BOUNDARY)
  assert.equal(e.extraPauseMs, 0)
  // 문장부호는 문장 분할자가 아니다 → 경계는 finalTail 하나뿐
  assert.deepEqual(t.boundaries.map((b) => b.kind), ['finalTail'])
})

test('D8: 감정 태그는 국소 운율의 host 를 끊지 않는다', () => {
  const t = okTimeline(parseExpressiveTimeline('안녕[기쁨]하세요.', { mode: 'expressive_v3' }), 'D8')
  const e = t.localProsody[0]
  assert.equal(e.hostRange.startCodepoint, 0, '감정 태그 이전 텍스트까지 host 에 포함')
})

test('D9: ~ 는 최종 모음을 늘이고, 확정 불가면 degraded (자음/전체 늘이기 금지)', () => {
  const ok1 = okTimeline(parseExpressiveTimeline('그래도~', { mode: 'expressive_v3' }), 'D9').localProsody[0]
  assert.equal(ok1.kind, 'vowel_extend')
  assert.equal(ok1.scopeKind, 'final_vowel')
  assert.equal(ok1.vowelExtend?.supported, true)
  assert.equal(ok1.vowelExtend?.targetVowel, 'ㅗ')

  const cons = okTimeline(parseExpressiveTimeline('안녕~', { mode: 'expressive_v3' }), 'D9').localProsody[0]
  assert.equal(cons.vowelExtend?.supported, false)
  assert.equal(cons.vowelExtend?.degradedReason, 'final_consonant')
  assert.equal(cons.vowelExtend?.targetVowel, null)

  const han = okTimeline(parseExpressiveTimeline('你好~', { mode: 'expressive_v3' }), 'D9').localProsody[0]
  assert.equal(han.vowelExtend?.degradedReason, 'unsupported_script')

  const none = okTimeline(parseExpressiveTimeline('~시작', { mode: 'expressive_v3' }), 'D9').localProsody[0]
  assert.equal(none.vowelExtend?.degradedReason, 'no_preceding_text')

  const en = okTimeline(parseExpressiveTimeline('hello~', { mode: 'expressive_v3' }), 'D9').localProsody[0]
  assert.equal(en.vowelExtend?.supported, true)
  assert.equal(en.vowelExtend?.targetVowel, 'o')

  // degraded 는 경고 진단으로도 표면화된다(조용한 폴백 금지)
  const t = okTimeline(parseExpressiveTimeline('안녕~', { mode: 'expressive_v3' }), 'D9')
  assert.ok(t.diagnostics.some((d) => d.code === 'UNSUPPORTED_VOWEL_EXTEND' && d.severity === 'warning'))
  assert.equal(t.summary.degradedVowelExtendCount, 1)
})

test('D10: 웃음 style/반복/상한/위치', () => {
  const styles: Array<[string, string, number]> = [
    ['[ㅋ]', 'chuckle', 1], ['[ㅋㅋ]', 'chuckle', 2], ['[ㅋㅋㅋㅋ]', 'chuckle', 4],
    ['[ㅎ]', 'breathy', 1], ['[ㅎㅎㅎㅎ]', 'breathy', 4],
    ['[헤헤]', 'bashful', 2], ['[헤헷]', 'bashful', 2],
    ['[호호]', 'open', 2], ['[호홋]', 'open', 2],
    ['[히히]', 'high_giggle', 2], ['[히히히]', 'high_giggle', 3],
  ]
  for (const [src, style, repeat] of styles) {
    const t = okTimeline(parseExpressiveTimeline(src, { mode: 'expressive_v3' }), 'D10')
    assert.equal(t.laughs.length, 1, src)
    assert.equal(t.laughs[0].style, style, src)
    assert.equal(t.laughs[0].rawRepeatCount, repeat, src)
    assert.equal(t.laughs[0].isChunkBoundary, false)
  }
  // 길수록 밝고/강하다
  const l2 = okTimeline(parseExpressiveTimeline('[ㅋㅋ]', { mode: 'expressive_v3' }), 'D10').laughs[0]
  const l4 = okTimeline(parseExpressiveTimeline('[ㅋㅋㅋㅋ]', { mode: 'expressive_v3' }), 'D10').laughs[0]
  assert.ok(l4.intensity > l2.intensity)
  assert.ok(l4.brightness > l2.brightness)
  assert.ok(l4.durationHint > l2.durationHint)
  // 반복 상한
  const long = okTimeline(parseExpressiveTimeline('[' + 'ㅋ'.repeat(12) + ']', { mode: 'expressive_v3' }), 'D10').laughs[0]
  assert.equal(long.rawRepeatCount, 12)
  assert.equal(long.effectiveRepeatCount, LAUGH_REPEAT_MAX_COUNT)
  assert.equal(long.capped, true)
  assert.equal(long.rawToken, '[' + 'ㅋ'.repeat(12) + ']', '원문 보존')
  // 위치
  assert.equal(okTimeline(parseExpressiveTimeline('안녕 [ㅋㅋ] 반가워', { mode: 'expressive_v3' }), 'D10').laughs[0].position, 'inline')
  assert.equal(okTimeline(parseExpressiveTimeline('그래 [ㅋㅋ]', { mode: 'expressive_v3' }), 'D10').laughs[0].position, 'trailing')
  assert.equal(okTimeline(parseExpressiveTimeline('[ㅋㅋ] 그래', { mode: 'expressive_v3' }), 'D10').laughs[0].position, 'leading')
  assert.equal(okTimeline(parseExpressiveTimeline('[ㅋㅋ]', { mode: 'expressive_v3' }), 'D10').laughs[0].position, 'standalone')
})

test('D11: 경계 우선순위 — 명시 쉼이 문장 gap 을 대체(합산 아님), final tail 은 1회', () => {
  const t = okTimeline(parseExpressiveTimeline('첫 줄.[쉼 0.8]\n둘째 줄.', { mode: 'expressive_v3' }), 'D11')
  const nonTail = t.boundaries.filter((b) => b.kind !== 'finalTail')
  assert.equal(nonTail.length, 1, '경계는 하나로 합쳐진다(합산 아님)')
  assert.equal(nonTail[0].kind, 'explicitPause')
  assert.deepEqual(nonTail[0].suppressed, ['sentenceGap'])
  assert.equal(nonTail[0].pauseMs, 800)
  assert.equal(SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE, true)

  const tails = t.boundaries.filter((b) => b.kind === 'finalTail')
  assert.equal(tails.length, 1, 'final tail 정확히 1회')
  assert.equal(t.boundaries[t.boundaries.length - 1].kind, 'finalTail', '맨 끝에서')
  assert.equal(FINAL_TAIL_APPLIES_ONCE_AT_FILE_END, true)

  // 명시 쉼이 없는 줄바꿈은 sentenceGap
  const t2 = okTimeline(parseExpressiveTimeline('첫 줄.\n둘째 줄.', { mode: 'expressive_v3' }), 'D11')
  assert.deepEqual(t2.boundaries.map((b) => b.kind), ['sentenceGap', 'finalTail'])
  assert.equal(t2.boundaries[0].pauseMs, null, 'sentenceGap 길이는 런타임 config 소관')
})

test('D12: 우선순위 목록이 계약 그대로', () => {
  assert.deepEqual([...EXPRESSIVE_EVENT_PRIORITY], [
    'emotionTransition', 'localProsody', 'nonverbalLaugh', 'explicitPause', 'sentenceGap', 'finalTail',
  ])
  assert.deepEqual([...EXPRESSIVE_EVENT_PRIORITY], meta.event_priority)
})

// ─────────────────────────────────────────────────────────────────────────────
// E. 원문 무손실 round-trip
// ─────────────────────────────────────────────────────────────────────────────

test('E1: 모든 픽스처 벡터가 원문을 무손실 복원한다', () => {
  for (const v of vectors) {
    const t = okTimeline(parseExpressiveTimeline(v.input, { mode: v.mode as ExpressiveMode }), v.id)
    const rt = verifyRoundTrip(v.input, t)
    assert.equal(rt.ok, true, `id=${v.id} round-trip`)
    assert.equal(rt.contiguous, true, `id=${v.id} range 연속성`)
    assert.equal(reconstructSource(t), v.input, `id=${v.id} 복원 일치`)
  }
})

test('E2: 발화 텍스트 + 이벤트가 원문 전체를 설명한다(누락 없음)', () => {
  const src = '[기쁨] 안녕하세요!? [쉼 0.5] 반가워요... [ㅋㅋ]\n[슬픔] 잘가~'
  const t = okTimeline(parseExpressiveTimeline(src, { mode: 'expressive_v3' }), 'E2')
  // 노드 kind 별 원문 조각을 모두 합치면 원문
  let sum = ''
  for (const nd of t.nodes) sum += nd.rawToken
  assert.equal(sum, src)
  // 모든 이벤트가 노드를 통해 원문 구간에 대응된다
  const covered = new Set<number>()
  for (const nd of t.nodes) for (let i = nd.range.startCodepoint; i < nd.range.endCodepoint; i++) covered.add(i)
  assert.equal(covered.size, Array.from(src).length, '원문 code point 전부가 어떤 노드엔가 속한다')
})

test('E3: v3 verbatimText 는 제어 태그만 뺀 발화(운율 토큰 포함), plainText 는 운율 토큰까지 제거', () => {
  const t = okTimeline(parseExpressiveTimeline('안녕하세요!', { mode: 'expressive_v3' }), 'E3')
  assert.equal(t.verbatimText, '안녕하세요!')
  assert.equal(t.plainText, '안녕하세요')
})

test('E4: v2 발화 텍스트와 표현형 verbatimText 가 (공백 제외) 일치 — 레이어 간 텍스트 누락 없음', () => {
  const noWs = (x: string): string => {
    let o = ''
    for (const ch of x) if (EXPRESSIVE_WHITESPACE_CHARS.indexOf(ch) < 0) o += ch
    return o
  }
  for (const row of legacyCorpus) {
    const v2 = parseTtsScript(row.input)
    assert.equal(v2.ok, true)
    if (!v2.ok) continue
    const v2Text = noWs(v2.plan.segments.map((sg) => sg.spokenText).join(''))
    for (const mode of EXPRESSIVE_MODES) {
      const t = okTimeline(parseExpressiveTimeline(row.input, { mode }), 'E4')
      assert.equal(noWs(t.verbatimText), v2Text, `mode=${mode} 텍스트 보존`)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// F. parity — 권위 픽스처 재현(= Python 동형)
// ─────────────────────────────────────────────────────────────────────────────

for (const v of vectors) {
  test(`F[${v.id}] 고정 full sha256 + 구조 재현 (mode=${v.mode})`, () => {
    const r = parseExpressiveTimeline(v.input, { mode: v.mode as ExpressiveMode })
    const t = okTimeline(r, v.id)
    assert.equal(t.fullSha256, v.full_sha256, `id=${v.id} full sha256`)
    assert.equal(t.summary.sha8, v.sha8, `id=${v.id} sha8`)
    assert.equal(t.summary.sha8, v.full_sha256.slice(0, 8))

    const exp = v.expect
    assert.equal(t.summary.mode, exp.summary.mode)
    assert.equal(t.summary.effectiveVersion, exp.summary.effective_version)
    assert.equal(t.summary.nodeCount, exp.summary.node_count)
    assert.equal(t.summary.lineCount, exp.summary.line_count)
    assert.equal(t.summary.emotionTransitionCount, exp.summary.emotion_transition_count)
    assert.equal(t.summary.localProsodyCount, exp.summary.local_prosody_count)
    assert.equal(t.summary.laughCount, exp.summary.laugh_count)
    assert.equal(t.summary.explicitPauseCount, exp.summary.explicit_pause_count)
    assert.equal(t.summary.totalExplicitPauseMs, exp.summary.total_explicit_pause_ms)
    assert.deepEqual(t.summary.usedEmotionIds, exp.summary.used_emotion_ids)
    assert.equal(t.summary.degradedVowelExtendCount, exp.summary.degraded_vowel_extend_count)
    assert.equal(t.summary.cappedTokenCount, exp.summary.capped_token_count)
    assert.equal(t.expressiveEnabled, exp.expressive_enabled)
    assert.equal(t.hasExpressiveEvents, exp.has_expressive_events)
    assert.equal(t.plainText, exp.plain_text)
    assert.equal(t.verbatimText, exp.verbatim_text)

    assert.equal(t.emotionTransitions.length, exp.emotion_transitions.length)
    for (let i = 0; i < exp.emotion_transitions.length; i++) {
      const g = t.emotionTransitions[i]
      const e = exp.emotion_transitions[i]
      assert.equal(g.targetEmotion, e.target_emotion)
      assert.equal(g.transitionMode, e.transition_mode)
      assert.equal(g.transitionStrength, e.transition_strength)
      assert.equal(g.transitionDurationHint, e.transition_duration_hint)
      assert.equal(g.extraPauseMs, e.extra_pause_ms)
      assert.equal(g.isChunkBoundary, e.is_chunk_boundary)
      assert.equal(g.explicitMode, e.explicit_mode)
      assert.equal(g.sourceOffset.utf16, e.source_offset.utf16)
      assert.equal(g.sourceOffset.codepoint, e.source_offset.codepoint)
    }

    assert.equal(t.localProsody.length, exp.local_prosody.length)
    for (let i = 0; i < exp.local_prosody.length; i++) {
      const g = t.localProsody[i]
      const e = exp.local_prosody[i]
      assert.equal(g.kind, e.kind)
      assert.equal(g.rawCount, e.raw_count)
      assert.equal(g.effectiveCount, e.effective_count)
      assert.equal(g.capped, e.capped)
      assert.equal(g.strength, e.strength)
      assert.equal(g.durationHint, e.duration_hint)
      assert.equal(g.scopeKind, e.scope_kind)
      assert.equal(g.scopeRange.startCodepoint, e.scope_range.start_codepoint)
      assert.equal(g.scopeRange.endCodepoint, e.scope_range.end_codepoint)
      assert.equal(g.scopeRange.startUtf16, e.scope_range.start_utf16)
      assert.equal(g.scopeRange.endUtf16, e.scope_range.end_utf16)
      assert.equal(g.hostRange.startCodepoint, e.host_range.start_codepoint)
      assert.equal(g.hostRange.endCodepoint, e.host_range.end_codepoint)
      assert.equal(g.isChunkBoundary, e.is_chunk_boundary)
      assert.equal(g.extraPauseMs, e.extra_pause_ms)
      assert.equal(g.rawToken, e.raw_token)
      if (e.vowel_extend == null) assert.equal(g.vowelExtend, null)
      else {
        assert.equal(g.vowelExtend?.supported, e.vowel_extend.supported)
        assert.equal(g.vowelExtend?.targetVowel, e.vowel_extend.target_vowel)
        assert.equal(g.vowelExtend?.degradedReason, e.vowel_extend.degraded_reason)
      }
    }

    assert.equal(t.laughs.length, exp.laughs.length)
    for (let i = 0; i < exp.laughs.length; i++) {
      const g = t.laughs[i]
      const e = exp.laughs[i]
      assert.equal(g.style, e.style)
      assert.equal(g.intensity, e.intensity)
      assert.equal(g.brightness, e.brightness)
      assert.equal(g.durationHint, e.duration_hint)
      assert.equal(g.position, e.position)
      assert.equal(g.rawRepeatCount, e.raw_repeat_count)
      assert.equal(g.effectiveRepeatCount, e.effective_repeat_count)
      assert.equal(g.capped, e.capped)
      assert.equal(g.isChunkBoundary, e.is_chunk_boundary)
      assert.equal(g.rawToken, e.raw_token)
    }

    assert.deepEqual(t.explicitPauses.map((p) => p.pauseMs), exp.explicit_pauses.map((p: any) => p.pause_ms))
    assert.deepEqual(
      t.boundaries.map((b) => ({ kind: b.kind, candidates: b.candidates, suppressed: b.suppressed, pause_ms: b.pauseMs })),
      exp.boundaries.map((b: any) => ({ kind: b.kind, candidates: b.candidates, suppressed: b.suppressed, pause_ms: b.pause_ms })),
    )
    assert.deepEqual(
      t.diagnostics.map((d) => ({ code: d.code, severity: d.severity, reason: d.reason ?? null })),
      exp.diagnostics.map((d: any) => ({ code: d.code, severity: d.severity, reason: d.reason ?? null })),
    )

    // 결정성
    const t2 = okTimeline(parseExpressiveTimeline(v.input, { mode: v.mode as ExpressiveMode }), v.id)
    assert.equal(t2.fullSha256, v.full_sha256)
  })
}

test('F-errors: 픽스처 오류 벡터의 코드/버전 재현', () => {
  for (const c of errorCases) {
    const r = parseExpressiveTimeline(c.input, { mode: c.mode as ExpressiveMode })
    assert.equal(r.ok, false, `id=${c.id} 실패 기대`)
    if (r.ok) continue
    assert.deepEqual(r.errors.map((e) => e.code), c.codes, `id=${c.id} codes`)
    assert.ok(r.errors.some((e) => e.code === c.code), `id=${c.id} 기대 code`)
    assert.equal(r.effectiveVersion, c.effective_version, `id=${c.id} effectiveVersion`)
    assert.equal(r.mode, c.mode)
  }
})

test('F-meta: 픽스처 _meta 의 enum/상수 집합이 TS 계약과 일치', () => {
  assert.equal(meta.contract_version, EXPRESSIVE_CONTRACT_VERSION)
  assert.equal(meta.legacy_plan_version, EXPRESSIVE_LEGACY_PLAN_VERSION)
  assert.deepEqual(meta.modes, [...EXPRESSIVE_MODES])
  assert.equal(meta.default_mode, EXPRESSIVE_DEFAULT_MODE)
  assert.deepEqual(meta.mode_to_version, EXPRESSIVE_MODE_TO_VERSION)
  assert.equal(meta.mode_field, EXPRESSIVE_MODE_FIELD)
  assert.deepEqual(meta.mode_carriers, [...EXPRESSIVE_MODE_CARRIERS])
  assert.deepEqual(meta.mode_carrier_pairs, [...EXPRESSIVE_MODE_CARRIER_PAIRS])
  assert.deepEqual(meta.node_kinds, [...EXPRESSIVE_NODE_KINDS])
  assert.deepEqual(meta.local_prosody_kinds, [...LOCAL_PROSODY_KINDS])
  assert.deepEqual(meta.prosody_scope_kinds, [...PROSODY_SCOPE_KINDS])
  assert.deepEqual(meta.laugh_styles, [...LAUGH_STYLES])
  assert.deepEqual(meta.laugh_positions, [...LAUGH_POSITIONS])
  assert.deepEqual(meta.emotion_transition_modes, [...EMOTION_TRANSITION_MODES])
  assert.deepEqual(meta.boundary_kinds, [...EXPRESSIVE_BOUNDARY_KINDS])
  assert.deepEqual(meta.vowel_extend_degrade_reasons, [...VOWEL_EXTEND_DEGRADE_REASONS])
  assert.deepEqual(meta.error_codes, [...EXPRESSIVE_ERROR_CODES])
  assert.deepEqual(meta.counts.dot_run, [1, DOT_RUN_MAX_COUNT])
  assert.deepEqual(meta.counts.bang_run, [1, BANG_RUN_MAX_COUNT])
  assert.deepEqual(meta.counts.question_run, [1, QUESTION_RUN_MAX_COUNT])
  assert.deepEqual(meta.counts.shock_run, [2, SHOCK_RUN_MAX_COUNT])
  assert.deepEqual(meta.counts.tilde_run, [1, TILDE_RUN_MAX_COUNT])
  assert.deepEqual(meta.counts.laugh_repeat, [1, LAUGH_REPEAT_MAX_COUNT])
  assert.equal(meta.counts.local_prosody_tail_syllables, LOCAL_PROSODY_TAIL_SYLLABLES)
  assert.equal(meta.invariants.expressive_mode_preset_may_change, EXPRESSIVE_MODE_PRESET_MAY_CHANGE)
})

// ─────────────────────────────────────────────────────────────────────────────
// G. 드리프트 가드 — ttsGrammar.ts 거울
// ─────────────────────────────────────────────────────────────────────────────

test('G1: 감정표 거울이 ttsGrammar 원본과 완전 일치', () => {
  assert.deepEqual(
    Object.entries(EXPRESSIVE_EMOTION_LABEL_TO_ID).sort(),
    Object.entries(TTS_EMOTION_LABEL_TO_ID).sort(),
  )
})

test('G2: 쉼 이름 거울 일치', () => {
  assert.deepEqual([...EXPRESSIVE_PAUSE_NAMES].sort(), [...TTS_PAUSE_NAMES].sort())
})

test('G3: legacy plan 버전 상수가 ttsGrammar.TTS_PARSER_VERSION 과 일치', () => {
  assert.equal(EXPRESSIVE_LEGACY_PLAN_VERSION, TTS_PARSER_VERSION)
})

test('G4: sha256 거울이 ttsGrammar / node crypto 와 동일', () => {
  for (const s of ['', 'abc', '안녕하세요', '🎉x🎉', 'a'.repeat(200)]) {
    const b = new TextEncoder().encode(s)
    const mine = expressiveSha256Hex(b)
    assert.equal(mine, sha256Hex(b), `ttsGrammar 일치 case=${JSON.stringify(s.slice(0, 8))}`)
    assert.equal(mine, createHash('sha256').update(s, 'utf8').digest('hex'), 'node crypto 일치')
  }
})

test('G5: resolveVowelExtend 단위 동작', () => {
  assert.deepEqual(resolveVowelExtend('가'), { supported: true, targetVowel: 'ㅏ', degradedReason: null })
  assert.deepEqual(resolveVowelExtend('강'), { supported: false, targetVowel: null, degradedReason: 'final_consonant' })
  assert.deepEqual(resolveVowelExtend('a'), { supported: true, targetVowel: 'a', degradedReason: null })
  assert.deepEqual(resolveVowelExtend('b'), { supported: false, targetVowel: null, degradedReason: 'final_consonant' })
  assert.deepEqual(resolveVowelExtend('い'), { supported: true, targetVowel: 'i', degradedReason: null })
  assert.deepEqual(resolveVowelExtend('好'), { supported: false, targetVowel: null, degradedReason: 'unsupported_script' })
  assert.deepEqual(resolveVowelExtend('1'), { supported: false, targetVowel: null, degradedReason: 'no_preceding_vowel' })
})

// ─────────────────────────────────────────────────────────────────────────────
// H. 모드 플래그 영속(session / config / metadata 3중 일치)
// ─────────────────────────────────────────────────────────────────────────────

test('H1: 필드 이름/타입이 세 캐리어에서 동일', () => {
  assert.equal(EXPRESSIVE_MODE_FIELD, 'ttsExpressiveMode')
  assert.deepEqual([...EXPRESSIVE_MODE_CARRIERS], ['session', 'config', 'metadata'])
  const session = writeExpressiveMode({} as Record<string, unknown>, 'expressive_v3')
  const config = writeExpressiveMode({} as Record<string, unknown>, 'expressive_v3')
  const metadata = writeExpressiveMode({} as Record<string, unknown>, 'expressive_v3')
  for (const c of [session, config, metadata]) {
    assert.ok(Object.prototype.hasOwnProperty.call(c, EXPRESSIVE_MODE_FIELD))
    assert.equal(typeof c[EXPRESSIVE_MODE_FIELD], 'string')
  }
})

test('H2: 필드 부재 → legacy_v2 (기본값을 세 곳에서 각자 정하지 않는다)', () => {
  for (const carrier of [undefined, null, {}, { other: 1 }]) {
    const r = readExpressiveMode(carrier as Record<string, unknown> | null | undefined)
    assert.equal(r.mode, 'legacy_v2')
    assert.equal(r.source, 'absent')
    assert.equal(r.valid, true)
    assert.equal(r.errorCode, null)
  }
})

test('H3: 계약 밖 값은 조용히 기본값으로 넘어가지 않고 구조화 오류', () => {
  for (const bad of ['', 'v3', 'expressive', true, false, 3, {}, []]) {
    const r = resolveExpressiveMode(bad)
    assert.equal(r.valid, false, `${JSON.stringify(bad)} 는 invalid`)
    assert.equal(r.source, 'invalid')
    assert.equal(r.errorCode, 'EXPRESSIVE_MODE_INVALID')
    assert.equal(r.mode, 'legacy_v2', '안전한 폴백 값은 legacy(우발적 v3 승격 금지)')
  }
  for (const good of ['legacy_v2', 'expressive_v3']) {
    const r = resolveExpressiveMode(good)
    assert.equal(r.valid, true)
    assert.equal(r.source, 'explicit')
    assert.equal(r.mode, good)
  }
})

test('H4: session-shaped 객체 쓰기→JSON 왕복→읽기 시 같은 모드', () => {
  for (const mode of EXPRESSIVE_MODES) {
    const session = writeExpressiveMode({ ttsText: '안녕', ttsSpeed: 1 } as Record<string, unknown>, mode)
    const restored = JSON.parse(JSON.stringify(session)) as Record<string, unknown>
    const r = readExpressiveMode(restored)
    assert.equal(r.mode, mode)
    assert.equal(r.source, 'explicit')
    assert.equal(r.valid, true)
    // reset/retry 시뮬레이션: 다른 필드를 갈아끼워도 플래그는 유지
    const retried = { ...restored, ttsText: '다시', ttsSpeed: 1.2 }
    assert.equal(readExpressiveMode(retried).mode, mode)
  }
})

test('H5: preset 은 플래그를 조용히 바꾸지 못한다', () => {
  assert.equal(EXPRESSIVE_MODE_PRESET_MAY_CHANGE, false)
  const base = writeExpressiveMode({ ttsSpeed: 1 } as Record<string, unknown>, 'expressive_v3')
  const preset: Record<string, unknown> = { ttsSpeed: 1.4, [EXPRESSIVE_MODE_FIELD]: 'legacy_v2' }
  const merged = applyPresetPreservingExpressiveMode(base, preset)
  assert.equal(merged[EXPRESSIVE_MODE_FIELD], 'expressive_v3', 'preset 이 덮어쓰지 못한다')
  assert.equal(merged.ttsSpeed, 1.4, '다른 값은 preset 이 적용된다')
  // 원래 없던 경우 → preset 이 새로 심지도 못한다
  const base2: Record<string, unknown> = { ttsSpeed: 1 }
  const merged2 = applyPresetPreservingExpressiveMode(base2, preset)
  assert.equal(Object.prototype.hasOwnProperty.call(merged2, EXPRESSIVE_MODE_FIELD), false)
  assert.equal(readExpressiveMode(merged2).mode, 'legacy_v2')
})

test('H6: 세 캐리어 일치 검증 — 각 쌍의 불일치를 개별로 잡아낸다', () => {
  const v3 = writeExpressiveMode({} as Record<string, unknown>, 'expressive_v3')
  const v2 = writeExpressiveMode({} as Record<string, unknown>, 'legacy_v2')

  const okAll = assertExpressiveModeCarriers(v3, v3, v3)
  assert.equal(okAll.ok, true)
  assert.equal(okAll.mode, 'expressive_v3')
  assert.deepEqual(okAll.mismatches, [])
  assert.equal(okAll.errorCode, null)

  const okAbsent = assertExpressiveModeCarriers({}, {}, {})
  assert.equal(okAbsent.ok, true)
  assert.equal(okAbsent.mode, 'legacy_v2')

  // session != config (그리고 session != metadata 도 함께 어긋난다)
  const m1 = assertExpressiveModeCarriers(v3, v2, v2)
  assert.equal(m1.ok, false)
  assert.equal(m1.errorCode, 'EXPRESSIVE_MODE_CARRIER_MISMATCH')
  assert.deepEqual(m1.mismatches.map((x) => x.pair).sort(), ['session_vs_config', 'session_vs_metadata'])

  // config != metadata 만
  const m2 = assertExpressiveModeCarriers(v3, v3, v2)
  assert.equal(m2.ok, false)
  assert.deepEqual(m2.mismatches.map((x) => x.pair).sort(), ['config_vs_metadata', 'session_vs_metadata'])

  // 정확히 config_vs_metadata 한 쌍만 어긋나게 만들 수는 없다(3자 관계) — 대신 쌍별 검출을 확인
  const m3 = assertExpressiveModeCarriers(v2, v3, v2)
  assert.deepEqual(m3.mismatches.map((x) => x.pair).sort(), ['config_vs_metadata', 'session_vs_config'])
  assert.deepEqual([...EXPRESSIVE_MODE_CARRIER_PAIRS].sort(), ['config_vs_metadata', 'session_vs_config', 'session_vs_metadata'])

  // invalid 가 우선
  const bad = assertExpressiveModeCarriers({ [EXPRESSIVE_MODE_FIELD]: 'v3' }, v3, v3)
  assert.equal(bad.ok, false)
  assert.equal(bad.errorCode, 'EXPRESSIVE_MODE_INVALID')
  assert.deepEqual(bad.invalidCarriers, ['session'])
  assert.equal(bad.mode, null)
})

test('H7: 활성 모드가 파싱 결과에 렌더러가 읽을 수 있는 형태로 실린다', () => {
  const r = parseExpressiveTimeline('안녕하세요.', { mode: 'expressive_v3' })
  assert.equal(r.mode, 'expressive_v3')
  assert.equal(r.effectiveVersion, 3)
  if (!r.ok) throw new Error('unreachable')
  assert.equal(r.timeline.mode, 'expressive_v3')
  assert.equal(r.timeline.expressiveEnabled, true)
  assert.equal(r.timeline.summary.mode, 'expressive_v3')
  assert.equal(r.timeline.summary.effectiveVersion, 3)
  // 실패 결과에도 모드가 실린다(UI 가 "표현 문법 v3 적용 중" 을 계속 보여줄 수 있다)
  const bad = parseExpressiveTimeline('[명란] 오타', { mode: 'expressive_v3' })
  assert.equal(bad.ok, false)
  assert.equal(bad.mode, 'expressive_v3')
  assert.equal(bad.effectiveVersion, 3)
})
