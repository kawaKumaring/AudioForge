// TTS v2 parser PARITY 테스트 (TS, node --test). 권위 fixture(test/fixtures/tts-grammar-conformance-v2.json)를
// 실제로 파싱해 valid/error 동작을 검증한다. Python(python/test_tts_grammar_parity.py)과 동일 fixture·동일 기대.
// ⚠️ 실패 보고는 case id·필드명만(대사 전문 로그 금지). offset 숫자는 fixture에서 '예시'이므로 재계산값과 대조하지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseTtsScript, lineBoundaryType, sha256HexOfString, TTS_PARSER_VERSION, type ParseResult } from './ttsGrammar.ts'
import { resolveEmotionId } from '../renderer/lib/emotions.ts'

const fixturePath = fileURLToPath(new URL('../../test/fixtures/tts-grammar-conformance-v2.json', import.meta.url))
const fx = JSON.parse(readFileSync(fixturePath, 'utf-8'))
const valid: any[] = fx.valid || []
const errors: any[] = fx.error || []

function ok(r: ParseResult) {
  assert.equal(r.ok, true, 'expected parse ok')
  if (!r.ok) throw new Error('unreachable')
  return r.plan
}

// ── SHA256 순수구현 == node crypto (parity 기반 무결성) ──
test('sha256 순수 JS == node crypto', () => {
  for (const s of ['', 'abc', '안녕하세요', '🎉x🎉', 'a'.repeat(200)]) {
    assert.equal(sha256HexOfString(s), createHash('sha256').update(s, 'utf8').digest('hex'), `case=${JSON.stringify(s.slice(0, 8))}`)
  }
})

// ── valid 케이스: segments 비교(emotion_id/spoken_text/line_index/pause seconds) ──
for (const c of valid) {
  if (!Array.isArray(c.segments)) continue
  test(`valid[${c.id}] segments 일치`, () => {
    const plan = ok(parseTtsScript(c.input))
    assert.equal(plan.segments.length, c.segments.length, `id=${c.id} segment 수`)
    for (let i = 0; i < c.segments.length; i++) {
      const exp = c.segments[i]
      const got = plan.segments[i]
      assert.equal(got.emotionId, exp.emotion_id ?? null, `id=${c.id} seg#${i} emotion_id`)
      assert.equal(got.spokenText, exp.spoken_text, `id=${c.id} seg#${i} spoken_text`)
      if (exp.original_line_index != null) assert.equal(got.originalLineIndex, exp.original_line_index, `id=${c.id} seg#${i} line_index`)
      const expPauses = Array.isArray(exp.pauses) ? exp.pauses : []
      const gotExplicit = got.pauses.filter((p) => p.boundaryType === 'explicitPause')
      assert.equal(gotExplicit.length, expPauses.length, `id=${c.id} seg#${i} pause 수`)
      for (let k = 0; k < expPauses.length; k++) {
        assert.equal(gotExplicit[k].pauseMs, Math.round(expPauses[k].seconds * 1000), `id=${c.id} seg#${i} pause ms`)
      }
    }
    if (Array.isArray(c.used_emotion_ids)) {
      assert.deepEqual(plan.summary.usedEmotionIds, c.used_emotion_ids, `id=${c.id} used_emotion_ids`)
    }
    assert.equal(plan.parserVersion, TTS_PARSER_VERSION)
  })
}

// ── valid: pauses_total_seconds 만 단언하는 케이스 ──
test('valid[pause-alias-english-boundary-min] total pause = 50ms', () => {
  const c = valid.find((x) => x.id === 'pause-alias-english-boundary-min')
  const plan = ok(parseTtsScript(c.input))
  assert.equal(plan.summary.totalPauseMs, Math.round(c.pauses_total_seconds * 1000))
})

// ── valid: 경계 우선순위 케이스 ──
test('valid[boundary-priority-line] 줄바꿈+감정변경 → lineSilenceGap only', () => {
  const c = valid.find((x) => x.id === 'boundary-priority-line-silence-gap-emotion-gap')
  const plan = ok(parseTtsScript(c.input))
  assert.equal(lineBoundaryType(plan, 0, 1), 'lineSilenceGap')
})
test('valid[boundary-priority-explicit] explicit pause가 line silence gap 대체', () => {
  const c = valid.find((x) => x.id === 'boundary-priority-explicit-pause-line-silence-ga')
  const plan = ok(parseTtsScript(c.input))
  assert.equal(lineBoundaryType(plan, 0, 1), 'explicitPause')
})

// ── error 케이스: 코드/필드 일치(대사 전문 미포함) ──
for (const c of errors) {
  if (c.id === 'parser-parity-mismatch-renderer-sha256-python') continue // 런타임 교차검증 케이스(텍스트 파싱 아님)
  test(`error[${c.id}] → ${c.error.code}`, () => {
    const r = parseTtsScript(c.input)
    assert.equal(r.ok, false, `id=${c.id} 파싱 실패 기대`)
    if (r.ok) return
    const codes = r.errors.map((e) => e.code)
    assert.ok(codes.includes(c.error.code), `id=${c.id} 기대 code=${c.error.code}, 실제=${codes.join(',')}`)
    const match = r.errors.find((e) => e.code === c.error.code)!
    if (c.error.tag != null) assert.equal(match.tag, c.error.tag, `id=${c.id} tag`)
    if (c.error.arg != null) assert.equal(match.arg, c.error.arg, `id=${c.id} arg`)
    if (c.error.reason != null) assert.equal(match.reason, c.error.reason, `id=${c.id} reason`)
    // 오류 payload에 대사 전문 없음(구조상 code/tag/arg/reason/offset 필드만)
    for (const e of r.errors) {
      assert.ok(!('spokenText' in (e as object)) && !('text' in (e as object)), '오류 payload에 대사 전문 없음')
    }
  })
}

// ── 자체 벡터: 이모지(surrogate) dual offset 이원화 ──
test('emoji surrogate: ui(UTF-16) != text(code point) offset', () => {
  // "🎉[기쁨] 안녕" — 🎉 는 UTF-16 2 code unit, code point 1개.
  const plan = ok(parseTtsScript('🎉[기쁨] 안녕'))
  assert.equal(plan.segments.length, 1)
  const seg = plan.segments[0]
  assert.equal(seg.emotionId, 'happy')
  assert.equal(seg.spokenText, '🎉안녕') // 선두 이모지 back-fill + 태그 뒤 공백 제거
  // 세그먼트가 원문 처음(🎉)부터 시작 → text codepoint 0, ui utf16 0
  assert.equal(seg.offset.uiStartUtf16, 0)
  assert.equal(seg.offset.textStartCodepoint, 0)
  // 끝: 원문 "🎉[기쁨] 안녕" = 🎉(cp1/u16 2) [기쁨](cp4/u16 4) space(1/1) 안녕(2/2)
  //   code point 총 = 1+4+1+2 = 8 ; utf16 총 = 2+4+1+2 = 9  → 이원화 확인
  assert.equal(seg.offset.textEndCodepoint, 8)
  assert.equal(seg.offset.uiEndUtf16, 9)
  assert.notEqual(seg.offset.uiEndUtf16, seg.offset.textEndCodepoint)
})

// ── renderer resolver 주입: emotions.ts vocab로 파싱 preview(같은 결과) ──
test('renderer resolver 주입 → 동일 파싱(emotions.ts vocab)', () => {
  const injected = parseTtsScript('[기쁨] 안녕', { resolveEmotion: resolveEmotionId })
  const base = parseTtsScript('[기쁨] 안녕')
  assert.equal(injected.ok, true)
  if (!injected.ok || !base.ok) return
  assert.equal(injected.plan.fullSha256, base.plan.fullSha256) // 렌더러 vocab == 기본표(거울)
  // unknown 태그 → 합성 차단 오류(조용한 default 금지)
  const bad = parseTtsScript('[명란] 오타', { resolveEmotion: resolveEmotionId })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === 'UNKNOWN_TTS_TAG'))
})

// ── 자체 벡터: canonical full hash 결정성 + Python 고정 벡터(TS==Python 증명) ──
// 아래 기대값은 python/tts_grammar.py 로 산출·고정(양쪽 테스트가 동일 리터럴을 검증 → TS==Python transitively).
const PINNED = JSON.parse(readFileSync(fileURLToPath(new URL('./ttsGrammar.parity-hashes.json', import.meta.url)), 'utf-8'))
test('canonical full sha256: 고정 벡터 일치(= Python 동형)', () => {
  for (const [input, expected] of Object.entries(PINNED as Record<string, string>)) {
    const plan = ok(parseTtsScript(input))
    assert.equal(plan.fullSha256, expected, `input=${JSON.stringify(input.slice(0, 16))}`)
    assert.equal(plan.summary.planSha8, expected.slice(0, 8))
    // 결정성: 같은 입력 재파싱 → 같은 해시
    const plan2 = ok(parseTtsScript(input))
    assert.equal(plan2.fullSha256, expected)
  }
})
