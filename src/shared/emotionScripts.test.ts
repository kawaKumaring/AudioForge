// 감정 대사 fixture — TS 로더 검증 + Python 로더와의 parity.
// parity 의 핵심: 같은 JSON 파일 하나를 읽고, 같은 지문 계산 규칙을 쓴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMOTION_SCRIPTS_SCHEMA_VERSION, EMOTION_SCRIPT_KINDS,
  emotionIds, emotionEntry, contextualText, controlledText, controlledBaseText,
  expressionRows, expressionText, fixtureFingerprint, fingerprintPayload,
  canonicalJson,
} from './emotionScripts.ts'

const FIXTURE = fileURLToPath(new URL('../../python/fixtures/emotion-scripts.v2.json', import.meta.url))

test('실제 JSON 파일은 정확히 1개이며 TS 는 그 파일을 읽는다', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8'))
  assert.equal(raw.schema_version, EMOTION_SCRIPTS_SCHEMA_VERSION)
  assert.equal(raw.fixture_fingerprint, fixtureFingerprint())
  assert.equal(raw.emotions.length, 50)
})

test('canonical 50개 / 중복 0', () => {
  const ids = emotionIds()
  assert.equal(ids.length, 50)
  assert.equal(new Set(ids).size, 50)
})

test('contextual 150개 존재 + 완전 중복 0', () => {
  const texts: string[] = []
  for (const id of emotionIds()) {
    for (const k of EMOTION_SCRIPT_KINDS) texts.push(contextualText(id, k))
  }
  assert.equal(texts.length, 150)
  assert.equal(new Set(texts).size, 150)
})

test('controlled 는 태그만 다르고 발화문 원본이 하나다', () => {
  const base = controlledBaseText()
  for (const id of emotionIds()) {
    const t = controlledText(id)
    assert.ok(t.endsWith(base), `${id} controlled 가 공통 발화문으로 끝나지 않는다`)
    assert.ok(t.startsWith('['), `${id} controlled 에 감정 태그가 없다`)
  }
  // 저장된 발화문 해시가 50개 전부 동일해야 한다(태그 제거 축).
  const hashes = new Set(emotionIds().map((id) => emotionEntry(id).controlled.expected_spoken_text_sha256))
  assert.equal(hashes.size, 1)
})

test('지문 계산 규칙이 Python 과 같다 — payload sha256 == 저장된 지문', () => {
  const got = createHash('sha256').update(fingerprintPayload(), 'utf8').digest('hex')
  assert.equal(got, fixtureFingerprint())
})

test('canonicalJson 은 키 정렬·공백 없음(Python sort_keys 와 동일 규칙)', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
})

test('표현 fixture 11행 / row_id 중복 0', () => {
  const rows = expressionRows()
  assert.equal(rows.length, 11)
  assert.equal(new Set(rows.map((r) => r.row_id)).size, 11)
  assert.ok(expressionText('laugh_chuckle').length > 0)
})

test('대사가 있다는 이유로 지원됨으로 승격하지 않는다', () => {
  for (const id of emotionIds()) {
    assert.equal(emotionEntry(id).capability_status_at_authoring, 'unknown')
  }
  for (const r of expressionRows()) assert.equal(r.capability_status_at_authoring, 'unknown')
})

test('알 수 없는 id/kind 는 조용히 넘어가지 않고 던진다', () => {
  assert.throws(() => emotionEntry('__nope__'), /EMOTION_SCRIPTS_UNKNOWN_ID/)
  assert.throws(() => expressionText('__nope__'), /EMOTION_SCRIPTS_UNKNOWN_ROW/)
})

test('TS 문자열 사본 0 — 로더 소스에 대사 리터럴이 없다', () => {
  const src = readFileSync(fileURLToPath(new URL('./emotionScripts.ts', import.meta.url)), 'utf-8')
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')  // 블록·행 주석 제거
  // 한글 대사 리터럴(따옴표 안 한글 3자 이상)이 있으면 사본이 생긴 것이다.
  const m = body.match(/'[^']*[가-힣]{3,}[^']*'/g)
  assert.equal(m, null, `로더에 한글 리터럴이 있다: ${m?.join(' | ')}`)
})

test('fixture 의 capability 값은 런타임 권위가 아니다 — 판정 모듈이 읽지 않는다', () => {
  const targets = ['./emotionSampler.ts', './ttsExpressionCapabilities.ts', './expressiveTimeline.ts']
  for (const rel of targets) {
    const body = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
    assert.ok(!body.includes('capability_status_at_authoring'),
      `${rel} 가 fixture 의 작성시 capability 를 읽는다`)
    assert.ok(!body.includes('emotionScripts'),
      `${rel} 가 대사 fixture 로 지원 여부를 판정할 위험`)
  }
})

test('preview 는 실제 tokenizer 로 잰 production token 이 기록돼 있고 한도 이내다', () => {
  for (const id of emotionIds()) {
    const b = emotionEntry(id).contextual.preview_short
    assert.equal(typeof b.production_tokens, 'number')
    assert.ok(b.production_tokens <= 33, `${id} preview ${b.production_tokens} token > 33`)
  }
})

test('medium 은 2~3문장 / long 은 문단 3개 이상', () => {
  for (const id of emotionIds()) {
    const e = emotionEntry(id)
    const n = e.contextual.validation_medium.sentence_count
    assert.ok(n >= 2 && n <= 3, `${id} medium ${n}문장`)
    assert.ok(e.contextual.continuity_long.paragraph_count >= 3, `${id} long 문단 부족`)
  }
})
