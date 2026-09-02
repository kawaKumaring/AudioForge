// 공용 Script Plan — TS 거울과 **Python 과의 parity**.
//
// 왜 거울이 테스트 안에 있나
// --------------------------
// 생성 권위는 Python 이다. 앱이 필요한 것은 그 계획을 화면 타입으로 옮기는 매퍼뿐이고,
// 그건 `inputAnalysis.ts` 가 가지고 있다. 그런데 화면이 보여 준 계획과 실제로 생성된 계획이
// 다르면 미리보기는 안내가 아니라 오정보다. 그래서 **같은 구조를 TS 로도 한 번 만들어** 두고
// hash 로 대조한다. 이 빌더의 유일한 소비자가 이 대조라서 여기에 둔다 — production 경로에
// 두 번째 파서를 만들어 두면 언젠가 그것이 진짜처럼 쓰이기 시작한다.
//
// `scriptPlan.parity-hashes.json` 은 Python 권위로 구운 값이다. 한쪽만 고치면 이 파일이
// 깨진다 — 그게 목적이다. (같은 fixture 를 `python/test_script_plan.py` 가 반대로 검사한다.)
//
// 여기서 만들지 않는 것
// ---------------------
// - **생성 묶음(chunks)**: production tokenizer 와 예산 권위가 필요해 Python 만 할 수 있다.
// - **문장 경계**: `text_segmenter` 의 권위다. TS 에서 다시 나누지 않는다.
// - 대사 원문: plan 은 좌표만 들고 다닌다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  PLAN_SCHEMA_VERSION, PLAN_WARNING_CODES, RESERVED_AXES,
  WARN_CONFLICTING_DIRECTIVES, WARN_DIRECTIVE_ONLY_PARAGRAPH, WARN_EMPTY_UTTERANCE,
  WARN_UNCLOSED_TAG, WARN_UNKNOWN_DIRECTIVE, toScriptPlanStructure,
} from './inputAnalysis.ts'
import { PLAN_WARNING_BLOCKS } from './analysisWording.ts'
import type {
  PlanParagraph, PlanSpan, PlanUtterance, PlanEmotionSpan, PlanPause, PlanWarning,
  PlanWarningCode, ScriptPlanStructure,
} from './inputAnalysis.ts'
import {
  TTS_GRAMMAR_ERROR_CODES, TTS_PARSER_VERSION, canonicalJson, normalizeLineEndings,
  parseTtsScript, sha256HexOfString, unclosedTagOffsets,
} from './ttsGrammar.ts'
import type { CanonValue, TtsGrammarError } from './ttsGrammar.ts'

// ── TS 거울 ──────────────────────────────────────────────────────────────────

function cpLength(s: string): number {
  return Array.from(s).length
}

function u16Length(s: string): number {
  return s.length
}

function mapAt(map: number[], i: number): number {
  return i < map.length ? map[i] : map[map.length - 1]
}

interface LineRow extends PlanSpan {
  index: number
  lineIndex: number
  text: string
  chars: number
  blankLinesBefore: number
}

/**
 * 정규화본의 **빈 줄이 아닌 줄** 목록. 좌표는 원문 기준.
 *
 * UTF-16 index 와 code point index 를 따로 센다 — 두 map 은 서로 다른 좌표계로 색인되므로
 * 한쪽 커서로 둘 다 조회하면 비 BMP 문자(이모지 등) 앞뒤에서 좌표가 밀린다.
 */
function lineRows(source: string, port: PlanParserPort): LineRow[] {
  const norm = port.normalize(source)
  const rows: LineRow[] = []
  let blank = 0
  let cpPos = 0
  let u16Pos = 0
  let lineIndex = 0
  for (const line of norm.text.split('\n')) {
    const cpLen = cpLength(line)
    const u16Len = u16Length(line)
    if (line.trim() !== '') {
      rows.push({
        index: rows.length,
        lineIndex,
        text: line,
        sourceStart: mapAt(norm.u16Map, u16Pos),
        sourceEnd: mapAt(norm.u16Map, u16Pos + u16Len),
        textStart: mapAt(norm.cpMap, cpPos),
        textEnd: mapAt(norm.cpMap, cpPos + cpLen),
        chars: cpLen,
        blankLinesBefore: blank,
      })
      blank = 0
    } else {
      blank += 1
    }
    cpPos += cpLen + 1
    u16Pos += u16Len + 1
    lineIndex += 1
  }
  return rows
}

/** 사용자가 Enter 로 만든 문단. 파서가 만든 발화와 섞지 않는다. */
function sourceParagraphs(source: string, port: PlanParserPort): PlanParagraph[] {
  return lineRows(source ?? '', port).map((r) => ({
    index: r.index,
    lineIndex: r.lineIndex,
    sourceStart: r.sourceStart,
    sourceEnd: r.sourceEnd,
    textStart: r.textStart,
    textEnd: r.textEnd,
    chars: r.chars,
    blankLinesBefore: r.blankLinesBefore,
  }))
}

interface Unit extends PlanSpan {
  index: number
  lineIndex: number | null
  text: string
  emotionId: string | null
  boundaryKind: string | null
  pauses: { pauseMs: number; boundaryType: string; span: PlanSpan }[]
}

function warning(
  code: PlanWarningCode, lineIndex: number | null,
  sourceStart: number | null, sourceEnd: number | null,
  textStart: number | null, textEnd: number | null,
  reason: string | null = null, tag?: string,
): PlanWarning {
  const w: PlanWarning = { code, lineIndex, sourceStart, sourceEnd, textStart, textEnd, reason }
  if (tag !== undefined) w.tag = tag
  return w
}

/**
 * 구조화 오류를 사전 경고로 옮긴다. 조용히 버리지 않는다.
 *
 * 쉼 인자 오류는 사유로 갈린다 — 인접 중복은 지시 충돌이고, 형식·범위·인자 누락은
 * "해석할 수 없는 표기" 다.
 */
function warningFromParseError(e: TtsGrammarError): PlanWarning {
  let code: PlanWarningCode = WARN_UNKNOWN_DIRECTIVE
  if (e.code === 'EMPTY_EMOTION_SEGMENT') code = WARN_EMPTY_UTTERANCE
  else if (e.code === 'INVALID_PAUSE_TAG' && e.reason === 'adjacent_duplicate') {
    code = WARN_CONFLICTING_DIRECTIVES
  }
  const off = e.uiOffsetUtf16 === undefined ? null : e.uiOffsetUtf16
  return warning(code, null, off, off, null, null, e.reason ?? e.code, e.tag)
}

/**
 * 대본을 **한 번** 해석한다.
 *
 * 파서가 실패하면 막지 않고 원문 줄로 물러난다(분석은 fail-open). 대신 실패 사유를 경고로
 * 남기고 `parserAuthority=false` 로 그 사실을 밝힌다 — 차단은 생성 경로의 일이다.
 */
function parseUnits(source: string, port: PlanParserPort): {
  units: Unit[]; parserAuthority: boolean; warnings: PlanWarning[]
} {
  const warnings: PlanWarning[] = []
  // 닫히지 않은 `[` 는 파서에게 오류가 아니다(리터럴로 지난다). 그래서 따로 물어본다.
  for (const u of port.unclosedTags(source)) {
    warnings.push(warning(
      WARN_UNCLOSED_TAG, u.lineIndex,
      u.uiOffsetUtf16, u.uiOffsetUtf16, u.textOffsetCodepoint, u.textOffsetCodepoint))
  }
  const parsed = port.parse(source)
  if (parsed.ok) {
    const units: Unit[] = parsed.plan.segments.map((s, i) => ({
      index: i,
      lineIndex: s.originalLineIndex,
      text: s.spokenText ?? '',
      emotionId: s.emotionId,
      boundaryKind: s.boundaryType ?? null,
      sourceStart: s.offset.uiStartUtf16,
      sourceEnd: s.offset.uiEndUtf16,
      textStart: s.offset.textStartCodepoint,
      textEnd: s.offset.textEndCodepoint,
      pauses: (s.pauses ?? []).map((b) => ({
        pauseMs: b.pauseMs,
        boundaryType: b.boundaryType,
        span: {
          sourceStart: b.offset.uiStartUtf16,
          sourceEnd: b.offset.uiEndUtf16,
          textStart: b.offset.textStartCodepoint,
          textEnd: b.offset.textEndCodepoint,
        },
      })),
    }))
    return { units, parserAuthority: true, warnings }
  }
  for (const e of parsed.errors) warnings.push(warningFromParseError(e))
  const units: Unit[] = lineRows(source, port).map((r) => ({
    index: r.index,
    lineIndex: r.lineIndex,
    text: r.text,
    emotionId: null,
    boundaryKind: null,
    sourceStart: r.sourceStart,
    sourceEnd: r.sourceEnd,
    textStart: r.textStart,
    textEnd: r.textEnd,
    pauses: [],
  }))
  return { units, parserAuthority: false, warnings }
}

/** 연속한 발화가 같은 감정을 유지하는 **구간**. 발화마다 한 줄씩 늘어놓지 않는다. */
function emotionSpans(utterances: PlanUtterance[]): PlanEmotionSpan[] {
  const spans: PlanEmotionSpan[] = []
  for (const u of utterances) {
    if (u.emotionId == null) continue
    const prev = spans.length > 0 ? spans[spans.length - 1] : null
    if (prev != null && prev.emotionId === u.emotionId && prev.utteranceEnd === u.index - 1) {
      prev.utteranceEnd = u.index
      prev.sourceEnd = u.sourceEnd
      prev.textEnd = u.textEnd
      continue
    }
    spans.push({
      index: spans.length,
      emotionId: u.emotionId,
      intensity: null,
      utteranceStart: u.index,
      utteranceEnd: u.index,
      sourceStart: u.sourceStart,
      sourceEnd: u.sourceEnd,
      textStart: u.textStart,
      textEnd: u.textEnd,
    })
  }
  return spans
}

function pauseRows(units: Unit[]): PlanPause[] {
  const rows: PlanPause[] = []
  for (const u of units) {
    for (const b of u.pauses) {
      if (b.boundaryType !== 'explicitPause') continue
      rows.push({
        index: rows.length,
        utteranceIndex: u.index,
        pauseMs: b.pauseMs,
        boundaryType: b.boundaryType,
        ...b.span,
      })
    }
  }
  return rows
}

/**
 * 문단 전체가 지시뿐이다 — 말이 하나도 없다.
 *
 * `[쉼 1.0]` 만 있는 문단이 그렇다. 파서는 이것을 오류로 보지 않으므로(쉼은 유효한 지시다)
 * 알려 주지 않으면 사용자는 그 문단이 소리를 내지 않는 것을 모른다.
 *
 * 쉼만 있는 줄은 발화 자체가 만들어지지 않고 쉼이 다음 발화에 붙는다. 그래서 "발화가 있는데
 * 비었다" 가 아니라 **문단에 말이 하나도 없다** 로 판정한다. 파서를 못 써서 원문 줄로 물러난
 * 경우에는 모든 줄이 발화가 되므로 이 경고가 헛되게 울리지 않는다.
 */
function directiveOnlyParagraphs(
  paragraphs: PlanParagraph[], utterances: PlanUtterance[]
): PlanWarning[] {
  const spoken = new Set<number>()
  for (const u of utterances) {
    if (u.sourceParagraphIndex != null && u.chars > 0) spoken.add(u.sourceParagraphIndex)
  }
  const out: PlanWarning[] = []
  for (const p of paragraphs) {
    if (spoken.has(p.index)) continue
    out.push(warning(
      WARN_DIRECTIVE_ONLY_PARAGRAPH, p.lineIndex,
      p.sourceStart, p.sourceEnd, p.textStart, p.textEnd))
  }
  return out
}

/** 대본 → plan 구조. 생성 묶음은 Python 권위이므로 여기 없다. */
function buildScriptStructure(raw: string, port: PlanParserPort): ScriptPlanStructure {
  const source = raw ?? ''
  const paragraphs = sourceParagraphs(source, port)
  const lineToPara = new Map<number, number>()
  for (const p of paragraphs) if (p.lineIndex != null) lineToPara.set(p.lineIndex, p.index)

  const { units, parserAuthority, warnings } = parseUnits(source, port)
  const utterances: PlanUtterance[] = units.map((u) => ({
    index: u.index,
    sourceParagraphIndex: u.lineIndex == null
      ? null
      : (lineToPara.has(u.lineIndex) ? (lineToPara.get(u.lineIndex) as number) : null),
    lineIndex: u.lineIndex,
    speakerId: null,
    emotionId: u.emotionId,
    boundaryKind: u.boundaryKind,
    sourceStart: u.sourceStart,
    sourceEnd: u.sourceEnd,
    textStart: u.textStart,
    textEnd: u.textEnd,
    chars: cpLength(u.text),
    // 파서가 준 좌표는 정확하다. 원문 줄로 물러난 경우만 근사다.
    sourceOffsetsExact: parserAuthority,
  }))

  const all = [...warnings, ...directiveOnlyParagraphs(paragraphs, utterances)]
  all.sort((a, b) => {
    const ka = a.sourceStart == null ? -1 : a.sourceStart
    const kb = b.sourceStart == null ? -1 : b.sourceStart
    if (ka !== kb) return ka - kb
    return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0)
  })

  const structure: ScriptPlanStructure = {
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    parserVersion: port.parserVersion,
    sourceSha256: port.sha256OfString(source),
    normalizedSha256: port.sha256OfString(port.normalize(source).text),
    parserAuthority,
    sourceParagraphs: paragraphs,
    utterances,
    emotions: emotionSpans(utterances),
    pauses: pauseRows(units),
    warnings: all,
    structureSha256: '',
  }
  structure.structureSha256 = scriptPlanStructureSha256(structure, port)
  return structure
}

/**
 * Python `script_plan.structure_sha256` 과 **같은 값**이어야 한다.
 *
 * 해시 입력에 대사 원문을 넣지 않는다 — 원문 신원은 `sourceSha256` 이 이미 들고 있다.
 * 키 이름은 Python 쪽(snake_case)을 그대로 쓴다. 직렬화가 두 곳에서 달라지면 parity 가
 * 아니라 우연이 된다.
 */
function scriptPlanStructureSha256(
  s: ScriptPlanStructure, port: PlanParserPort
): string {
  const canon: CanonValue = {
    plan_schema_version: s.planSchemaVersion,
    parser_version: s.parserVersion,
    source_sha256: s.sourceSha256,
    normalized_sha256: s.normalizedSha256,
    parser_authority: s.parserAuthority,
    source_paragraphs: s.sourceParagraphs.map((p) => ({
      index: p.index,
      line_index: p.lineIndex,
      source_start: p.sourceStart,
      source_end: p.sourceEnd,
      text_start: p.textStart,
      text_end: p.textEnd,
      chars: p.chars,
      blank_lines_before: p.blankLinesBefore,
    })),
    utterances: s.utterances.map((u) => ({
      index: u.index,
      source_paragraph_index: u.sourceParagraphIndex,
      line_index: u.lineIndex,
      speaker_id: u.speakerId,
      emotion_id: u.emotionId,
      boundary_kind: u.boundaryKind,
      source_start: u.sourceStart,
      source_end: u.sourceEnd,
      text_start: u.textStart,
      text_end: u.textEnd,
      chars: u.chars,
      source_offsets_exact: u.sourceOffsetsExact,
    })),
    emotions: s.emotions.map((e) => ({
      index: e.index,
      emotion_id: e.emotionId,
      intensity: e.intensity,
      utterance_start: e.utteranceStart,
      utterance_end: e.utteranceEnd,
      source_start: e.sourceStart,
      source_end: e.sourceEnd,
      text_start: e.textStart,
      text_end: e.textEnd,
    })),
    pauses: s.pauses.map((p) => ({
      index: p.index,
      utterance_index: p.utteranceIndex,
      pause_ms: p.pauseMs,
      boundary_type: p.boundaryType,
      source_start: p.sourceStart,
      source_end: p.sourceEnd,
      text_start: p.textStart,
      text_end: p.textEnd,
    })),
    warnings: s.warnings.map((w) => ({
      code: w.code,
      line_index: w.lineIndex,
      source_start: w.sourceStart,
      source_end: w.sourceEnd,
      text_start: w.textStart,
      text_end: w.textEnd,
      reason: w.reason,
      tag: w.tag === undefined ? null : w.tag,
    })),
    reserved_axes: [...RESERVED_AXES],
  }
  return port.sha256OfString(port.canonicalJson(canon))
}

// ── parity 와 계약 ───────────────────────────────────────────────────────────

// 파서 창구의 구현은 하나뿐이다 — 여기서 엮는다.
const PORT: PlanParserPort = {
  parserVersion: TTS_PARSER_VERSION,
  parse: (raw) => parseTtsScript(raw),
  normalize: (raw) => normalizeLineEndings(raw),
  unclosedTags: (raw) => unclosedTagOffsets(raw),
  sha256OfString: (s) => sha256HexOfString(s),
  canonicalJson: (v) => canonicalJson(v),
}

const build = (raw: string) => buildScriptStructure(raw, PORT)

const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)


const PINNED: Record<string, string> = JSON.parse(readFileSync(
  fileURLToPath(new URL('./scriptPlan.parity-hashes.json', import.meta.url)), 'utf-8'))

test('Python 이 구운 plan hash 를 TS 가 그대로 낸다', () => {
  const cases = Object.entries(PINNED)
  assert.ok(cases.length >= 30, `fixture 가 너무 작다: ${cases.length}`)
  const bad: string[] = []
  for (const [input, sha] of cases) {
    const got = build(input).structureSha256
    // 대본 원문을 실패 메시지에 넣지 않는다 — 길이와 hash 만으로 어느 case 인지 안다.
    if (got !== sha) bad.push(`len=${input.length} pinned=${sha.slice(0, 8)} got=${got.slice(0, 8)}`)
  }
  assert.deepEqual(bad, [], `TS 와 Python 의 plan 이 갈라졌다:\n${bad.join('\n')}`)
})

test('plan schema version 과 예약 축이 Python 과 같은 이름이다', () => {
  assert.equal(PLAN_SCHEMA_VERSION, 1)
  assert.deepEqual([...RESERVED_AXES],
    ['speakers', 'prosody', 'actions', 'ambience', 'music', 'spatial'])
  assert.deepEqual([...PLAN_WARNING_CODES], [
    'UNCLOSED_TAG', 'UNKNOWN_DIRECTIVE', 'EMPTY_UTTERANCE',
    'CONFLICTING_DIRECTIVES', 'DIRECTIVE_ONLY_PARAGRAPH',
  ])
})

test('문단 · 발화 · 감정 구간은 서로 다른 축이다', () => {
  // 한 문단 안에서 감정이 두 번 바뀌면 발화는 늘지만 문단은 하나다.
  const s = build('[기쁨] 첫 문장. [슬픔] 둘째 문장.')
  assert.equal(s.sourceParagraphs.length, 1, '문단은 Enter 경계로만 늘어난다')
  assert.equal(s.utterances.length, 2, '감정 태그가 발화를 나눈다')
  assert.equal(s.emotions.length, 2)
  assert.deepEqual(s.utterances.map((u) => u.sourceParagraphIndex), [0, 0],
    '두 발화가 같은 문단을 가리킨다')
})

test('같은 감정이 이어지면 구간 하나로 합친다', () => {
  const s = build('[기쁨] 첫 줄.' + LF + '[기쁨] 둘째 줄.')
  assert.equal(s.utterances.length, 2)
  assert.equal(s.emotions.length, 1, '발화마다 한 줄씩 늘어놓지 않는다')
  assert.equal(s.emotions[0].utteranceStart, 0)
  assert.equal(s.emotions[0].utteranceEnd, 1)
  assert.equal(s.emotions[0].intensity, null, '세기는 v1.2.0 문법에 없다')
})

test('원문 좌표가 실제 대본의 그 자리를 가리킨다', () => {
  // 발화의 구간은 **자기 지시를 포함**한다(파서 계약). 화면에서 발화를 누르면 그 발화를
  // 만든 `[기쁨]` 까지 같이 선택돼야 하기 때문이다 — 지시만 남기고 지울 수는 없다.
  const src = '[기쁨] 안녕하세요.'
  const s = build(src)
  const u = s.utterances[0]
  assert.equal(src.slice(u.sourceStart, u.sourceEnd), src)
  assert.ok(src.slice(u.sourceStart, u.sourceEnd).endsWith('안녕하세요.'))
  assert.equal(u.sourceOffsetsExact, true)
  // 둘째 발화는 첫 발화 뒤에서 시작한다(구간이 겹치지 않는다).
  const two = build('[기쁨] 첫 문장. [슬픔] 둘째 문장.')
  assert.ok(two.utterances[1].sourceStart >= two.utterances[0].sourceEnd)
})

test('줄 끝 표기가 계획의 뜻을 바꾸지 않는다 — 좌표와 신원만 움직인다', () => {
  const lf = build('[기쁨] 첫 줄.' + LF + '[슬픔] 둘째 줄.')
  const crlf = build('[기쁨] 첫 줄.' + CR + LF + '[슬픔] 둘째 줄.')
  const cr = build('[기쁨] 첫 줄.' + CR + '[슬픔] 둘째 줄.')
  // 파서가 본 문자열은 셋이 같다 — 정규화는 파서 입구 한 곳에서만 일어난다.
  assert.equal(lf.normalizedSha256, crlf.normalizedSha256)
  assert.equal(lf.normalizedSha256, cr.normalizedSha256)
  // 원문 신원은 입력 그대로여야 한다(정규화본으로 바꿔 적지 않는다).
  assert.notEqual(lf.sourceSha256, crlf.sourceSha256)
  // 뜻(발화 수·감정·경계·쉼·경고)은 같다.
  const meaning = (x: typeof lf) => JSON.stringify({
    u: x.utterances.map((u) => [u.lineIndex, u.emotionId, u.boundaryKind, u.chars]),
    e: x.emotions.map((e) => [e.emotionId, e.utteranceStart, e.utteranceEnd]),
    p: x.pauses.map((p) => p.pauseMs),
    w: x.warnings.map((w) => w.code),
  })
  assert.equal(meaning(lf), meaning(crlf))
  assert.equal(meaning(lf), meaning(cr))
  // 좌표는 **원문** 기준이므로 CRLF 쪽 둘째 발화는 한 칸 뒤에 있고, 단독 CR 은 길이가
  // 같아 제자리다.
  assert.equal(crlf.utterances[1].sourceStart, lf.utterances[1].sourceStart + 1)
  assert.equal(cr.utterances[1].sourceStart, lf.utterances[1].sourceStart)
  // 구조 hash 는 원문 신원과 원문 좌표를 **포함한다**. 그래서 줄 끝만 달라도 값이 달라지고,
  // 그것이 맞다 — parity 가 좌표 어긋남까지 잡아야 하기 때문이다. 줄 끝에 무관한 신원이
  // 필요하면 `normalizedSha256` 을, 뜻만 비교하려면 위의 meaning 을 본다.
  assert.notEqual(lf.structureSha256, crlf.structureSha256)
  assert.notEqual(lf.structureSha256, cr.structureSha256)
})

test('비 BMP 문자 뒤의 문단 좌표가 밀리지 않는다', () => {
  // 이모지는 UTF-16 두 칸, code point 한 칸이다. 두 좌표계를 한 커서로 세면 여기서 어긋난다.
  const src = '\u{1F389} 첫 줄.' + LF + '둘째 줄.'
  const s = build(src)
  assert.equal(s.sourceParagraphs.length, 2)
  const p = s.sourceParagraphs[1]
  assert.equal(src.slice(p.sourceStart, p.sourceEnd), '둘째 줄.', 'UTF-16 좌표')
  assert.equal(Array.from(src).slice(p.textStart, p.textEnd).join(''), '둘째 줄.', 'code point 좌표')
  assert.notEqual(p.sourceStart, p.textStart, '두 좌표계가 실제로 다른 입력이다')
})

test('닫히지 않은 태그는 오류가 아니라 경고다', () => {
  const s = build('[기쁨 안녕하세요 반갑습니다')
  assert.equal(s.parserAuthority, true, '파서는 리터럴로 지나간다 — 막지 않는다')
  assert.deepEqual(s.warnings.map((w) => w.code), ['UNCLOSED_TAG'])
  assert.equal(s.warnings[0].sourceStart, 0)
})

test('해석할 수 없는 표기 · 빈 발화 · 지시 충돌을 각각 다른 코드로 말한다', () => {
  assert.deepEqual(build('[없는감정] 안녕').warnings.map((w) => w.code), ['UNKNOWN_DIRECTIVE'])
  assert.deepEqual(build('[기쁨]').warnings.map((w) => w.code), ['EMPTY_UTTERANCE'])
  assert.deepEqual(build('안녕. [쉼 1.0][쉼 1.0] 또 안녕.').warnings.map((w) => w.code),
    ['CONFLICTING_DIRECTIVES'])
  // 형식이 틀린 쉼 인자는 충돌이 아니라 "해석 못 함" 이다. 사유를 지우지 않는다.
  const bad = build('[쉼 abc] 안녕').warnings
  assert.deepEqual(bad.map((w) => w.code), ['UNKNOWN_DIRECTIVE'])
  assert.equal(bad[0].reason, 'format')
})

test('말이 하나도 없는 문단을 알려 준다', () => {
  const s = build('[쉼 1.0]' + LF + '[기쁨] 안녕.')
  assert.deepEqual(s.warnings.map((w) => w.code), ['DIRECTIVE_ONLY_PARAGRAPH'])
  assert.equal(s.warnings[0].lineIndex, 0)
})

test('정상 대본에는 경고가 하나도 없다 — 헛되게 울리지 않는다', () => {
  for (const t of [
    '[기쁨] 안녕하세요.',
    '[기쁨] 첫 문장. [쉼 0.5] 둘째 문장.',
    '첫 문단.' + LF + LF + '둘째 문단.',
    '[기쁨] 은 감정 태그입니다.',
  ]) {
    assert.deepEqual(build(t).warnings, [], `헛경고: len=${t.length}`)
  }
})

test('구조화 오류가 나도 계획은 나온다(fail-open) — 근사임을 밝힌다', () => {
  const s = build('[없는감정] 안녕' + LF + '둘째 줄.')
  assert.equal(s.parserAuthority, false)
  assert.equal(s.utterances.length, 2, '원문 줄로 물러난다')
  assert.ok(s.utterances.every((u) => u.sourceOffsetsExact === false), '근사를 정확하다고 말하지 않는다')
})

test('아직 없는 축은 비어 있고, 발화의 화자는 null 이다', () => {
  const s = build('[기쁨] 안녕하세요.')
  assert.deepEqual(s.utterances.map((u) => u.speakerId), [null])
  // 구조 타입에는 예약 축이 없다 — Python 응답에만 빈 배열로 있고, 화면이 지어내지 않는다.
  for (const axis of RESERVED_AXES) {
    assert.equal((s as unknown as Record<string, unknown>)[axis], undefined,
      `${axis} 를 TS 구조에 만들어 두면 화면이 그것을 채우려 한다`)
  }
})

test('plan 에 대사 원문이 들어가지 않는다', () => {
  const secret = '이것은 대사 원문입니다'
  const blob = JSON.stringify(build('[기쁨] ' + secret))
  assert.equal(blob.includes(secret), false, 'plan 은 좌표만 들고 다닌다')
})

test('hash 는 구조가 바뀔 때만 바뀐다', () => {
  const a = build('[기쁨] 안녕하세요.')
  const b = build('[기쁨] 안녕하세요.')
  assert.equal(a.structureSha256, b.structureSha256, '같은 입력은 같은 계획')
  assert.equal(scriptPlanStructureSha256(a, PORT), a.structureSha256, '자기 hash 를 재현한다')
  assert.notEqual(build('[슬픔] 안녕하세요.').structureSha256, a.structureSha256)
})

test('매퍼는 버전이 다른 payload 를 받지 않는다', () => {
  assert.equal(toScriptPlanStructure(null), null)
  assert.equal(toScriptPlanStructure({ plan_schema_version: 99 }), null,
    '모르는 스키마를 추측해서 읽지 않는다')
  const ok = toScriptPlanStructure({
    plan_schema_version: 1, parser_version: 2, source_sha256: 'a', normalized_sha256: 'b',
    parser_authority: true, source_paragraphs: [], utterances: [], emotions: [], pauses: [],
    warnings: [{ code: 'UNCLOSED_TAG', source_start: 3 }, { code: '무슨코드', source_start: 1 }],
    structure_sha256: 'c',
  })
  assert.ok(ok)
  assert.deepEqual(ok.warnings.map((w) => w.code), ['UNCLOSED_TAG'],
    '문구를 붙일 수 없는 코드는 버린다')
})

test('파서 오류에서 온 진단은 전부 차단으로 표시된다', () => {
  // 미리보기는 새로 막지 않는다. 그래서 "차단" 표는 파서 계약의 거울이어야 한다 —
  // 파서 오류를 진단으로 옮긴 코드가 하나라도 `경고` 로 표시되면 사용자는 고칠 것을
  // 고치지 않고 합성이 막히는 이유를 알 수 없다.
  const fromErrors = new Set<string>()
  for (const code of TTS_GRAMMAR_ERROR_CODES) {
    for (const reason of ['format', 'range', 'missing_arg', 'adjacent_duplicate', undefined]) {
      const w = warningFromParseError({ code, reason } as TtsGrammarError)
      fromErrors.add(w.code)
    }
  }
  for (const code of fromErrors) {
    assert.equal(PLAN_WARNING_BLOCKS[code as keyof typeof PLAN_WARNING_BLOCKS], true,
      `${code} 는 파서 오류에서 나오므로 차단으로 표시돼야 한다`)
  }
  // 파서가 정상 통과한 뒤 붙는 두 진단은 그 집합에 없다(그래서 비차단이다).
  assert.equal(fromErrors.has(WARN_UNCLOSED_TAG), false)
  assert.equal(fromErrors.has(WARN_DIRECTIVE_ONLY_PARAGRAPH), false)
  assert.equal(PLAN_WARNING_BLOCKS[WARN_UNCLOSED_TAG], false)
  assert.equal(PLAN_WARNING_BLOCKS[WARN_DIRECTIVE_ONLY_PARAGRAPH], false)
})

test('차단으로 표시되는 대본은 실제로 파서가 거부한다', () => {
  // 표시와 실제가 어긋나지 않는지 대본으로 확인한다(fixture 와 같은 입력들).
  for (const [text, blocks] of [
    ['[없는감정] 안녕', true],
    ['[기쁨]', true],
    ['안녕. [쉼 1.0][쉼 1.0] 또 안녕.', true],
    ['[기쁨 안녕', false],
    ['[쉼 1.0]' + LF + '[기쁨] 안녕.', false],
  ] as [string, boolean][]) {
    const rows = build(text).warnings
    assert.ok(rows.length > 0, `진단이 있어야 한다: len=${text.length}`)
    const marked = rows.some((w) => PLAN_WARNING_BLOCKS[w.code])
    assert.equal(marked, blocks, `차단 표시가 어긋난다: len=${text.length}`)
    // 파서가 거부하는가 — 합성 시작이 막히는 실제 조건이다.
    assert.equal(parseTtsScript(text).ok === false, blocks,
      `표시와 파서 판정이 어긋난다: len=${text.length}`)
  }
})
