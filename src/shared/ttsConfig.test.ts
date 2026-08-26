// TTS config 직렬화 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/ttsConfig.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTtsConfig, buildReferencePrompts, deriveRefMode, pruneStaleReferencePrompts, normalizePitchCapability, parseGenerationSummary, finiteNumber, sampleRateOrNull, framesOrNull } from './ttsConfig.ts'
import { TTS_PARSER_VERSION } from './ttsGrammar.ts'

test('parseGenerationSummary: 정상 다중 chunk', () => {
  const g = parseGenerationSummary({
    generation_limit: 256, generated_iterations: 180, termination_reason: 'completed_before_limit',
    generation_chunks: [
      { original_segment_index: 0, chunk_index: 0, chunk_count: 2, production_tokens: 30, generation_limit: 247, generated_iterations: 90, termination_reason: 'completed_before_limit', emotion_id: 'happy' },
      { original_segment_index: 0, chunk_index: 1, chunk_count: 2, production_tokens: 20, generation_limit: 218, generated_iterations: 60, termination_reason: 'completed_before_limit' },
    ],
  })
  assert.equal(g.limit, 256); assert.equal(g.iters, 180); assert.equal(g.termination, 'completed_before_limit')
  assert.equal(g.chunks.length, 2)
  assert.equal(g.chunks[0].emotion_id, 'happy'); assert.equal(g.chunks[1].emotion_id, null)
})

test('parseGenerationSummary: null/누락 → null(구 session)', () => {
  assert.equal(parseGenerationSummary(null), null)
  assert.equal(parseGenerationSummary({}), null)
  assert.equal(parseGenerationSummary({ actual_engine: 'qwen3' }), null)
})

test('parseGenerationSummary: 잘못된 타입/비정상 chunk는 무시(crash 없음)', () => {
  const g = parseGenerationSummary({
    generation_limit: 'x', generated_iterations: NaN, termination_reason: 'weird',
    generation_chunks: [
      null, 42, 'nope',
      { chunk_index: 0 },                                            // 필수 index 누락 → 무시
      { original_segment_index: 0, chunk_index: 0, chunk_count: 1, termination_reason: 'bad' }, // 사유 불량 → 무시
      { original_segment_index: 1, chunk_index: 0, chunk_count: 1, production_tokens: 'x', generation_limit: null, generated_iterations: 5, termination_reason: 'completed_before_limit' }, // 정상(1개)
    ],
  })
  assert.equal(g.limit, null); assert.equal(g.iters, null); assert.equal(g.termination, null)
  assert.equal(g.chunks.length, 1)
  assert.equal(g.chunks[0].production_tokens, null); assert.equal(g.chunks[0].generated_iterations, 5)
})

test('parseGenerationSummary: frames/output_sample_rate 전달(가산)', () => {
  const g = parseGenerationSummary({
    generation_chunks: [
      { original_segment_index: 0, chunk_index: 0, chunk_count: 1, generated_iterations: 90, generation_limit: 247, termination_reason: 'completed_before_limit', frames: 48000, output_sample_rate: 24000 },
    ],
  })
  assert.ok(g)
  assert.equal(g.chunks[0].frames, 48000)
  assert.equal(g.chunks[0].output_sample_rate, 24000)
  // 행 하나로 길이(초)가 계산된다 — 상위 dict 와 join 하지 않아도 된다.
  assert.equal(g.chunks[0].frames! / g.chunks[0].output_sample_rate!, 2)
})

test('parseGenerationSummary: 구 session(새 필드 없음) → null, 절대 0 아님', () => {
  const g = parseGenerationSummary({
    generation_chunks: [
      { original_segment_index: 0, chunk_index: 0, chunk_count: 1, generated_iterations: 90, generation_limit: 247, termination_reason: 'completed_before_limit' },
    ],
  })
  assert.ok(g)
  assert.equal(g.chunks[0].frames, null)
  assert.equal(g.chunks[0].output_sample_rate, null)
  assert.notEqual(g.chunks[0].frames, 0)
  assert.notEqual(g.chunks[0].output_sample_rate, 0)
})

test('parseGenerationSummary: 이상 frames/sample rate 는 거절돼 null(crash 없음)', () => {
  const base = { original_segment_index: 0, chunk_index: 0, chunk_count: 1, termination_reason: 'completed_before_limit' }
  const g = parseGenerationSummary({
    generation_chunks: [
      { ...base, frames: -1, output_sample_rate: 0 },
      { ...base, chunk_index: 1, frames: NaN, output_sample_rate: Infinity },
      { ...base, chunk_index: 2, frames: '48000', output_sample_rate: -24000 },
    ],
  })
  assert.ok(g)
  assert.equal(g.chunks.length, 3)
  for (const c of g.chunks) {
    assert.equal(c.frames, null); assert.equal(c.output_sample_rate, null)
  }
})

test('telemetry 검증기: NaN/Infinity/음수/0 rate 거절, 0 frames 는 유효', () => {
  assert.equal(finiteNumber(NaN), null); assert.equal(finiteNumber(Infinity), null)
  assert.equal(finiteNumber(-Infinity), null); assert.equal(finiteNumber('1'), null)
  assert.equal(finiteNumber(0), 0)
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '24000']) {
    assert.equal(sampleRateOrNull(bad), null)
  }
  assert.equal(sampleRateOrNull(24000), 24000)
  for (const bad of [-1, NaN, Infinity, null, undefined, '0']) assert.equal(framesOrNull(bad), null)
  assert.equal(framesOrNull(0), 0); assert.equal(framesOrNull(48000), 48000)
})

test('parseGenerationSummary: generation_chunks 비배열 → chunks 빈 배열', () => {
  const g = parseGenerationSummary({ generation_limit: 256, generation_chunks: { not: 'array' } })
  assert.ok(g); assert.equal(g.chunks.length, 0); assert.equal(g.limit, 256)
})

test('ttsEmotionRefs가 config에 전달된다 (전달 경로 끊김 회귀)', () => {
  const refs = { happy: 'C:/ref/happy.wav', sad: 'C:/ref/sad.wav' }
  const c = buildTtsConfig({ ttsEmotionRefs: refs })
  assert.deepEqual(c.ttsEmotionRefs, refs)
})

test('I1: ttsParsedPlanSha256/ttsParserVersion 전달(parity 배선) + 기본값', () => {
  const c = buildTtsConfig({ ttsParsedPlanSha256: 'a'.repeat(64), ttsParserVersion: 2 })
  assert.equal(c.ttsParsedPlanSha256, 'a'.repeat(64))
  assert.equal(c.ttsParserVersion, 2)
  const d = buildTtsConfig({})  // 미제공 → sha ''(parity 미강제), version 기본 2
  assert.equal(d.ttsParsedPlanSha256, '')
  assert.equal(d.ttsParserVersion, 2)
})

test('ttsSilenceGap=0 이 0.5로 변질되지 않는다 (|| → ?? 회귀)', () => {
  const c = buildTtsConfig({ ttsSilenceGap: 0 })
  assert.equal(c.ttsSilenceGap, 0)
})

test('ttsSpeed=0 도 ??로 보존된다', () => {
  const c = buildTtsConfig({ ttsSpeed: 0 })
  assert.equal(c.ttsSpeed, 0)
})

test('미지정(undefined) 필드에는 기본값이 적용된다', () => {
  const c = buildTtsConfig(undefined)
  assert.equal(c.ttsText, '')
  assert.equal(c.ttsSpeed, 1.0)
  assert.equal(c.ttsSilenceGap, 0.5)
  assert.deepEqual(c.ttsEmotionRefs, {})
  assert.equal(c.ttsEngine, 'auto')
  assert.equal(c.ttsReferenceOverride, '')  // 파생 참조 미확정 → 빈 값(원본 참조 경로)
})

test('지정한 값은 그대로 통과한다', () => {
  const c = buildTtsConfig({
    ttsText: '안녕하세요', ttsSpeed: 1.2, ttsSilenceGap: 0.3,
    ttsEmotionRefs: { neutral: 'n.wav' }, ttsEngine: 'gptsovits'
  })
  assert.equal(c.ttsText, '안녕하세요')
  assert.equal(c.ttsSpeed, 1.2)
  assert.equal(c.ttsSilenceGap, 0.3)
  assert.deepEqual(c.ttsEmotionRefs, { neutral: 'n.wav' })
  assert.equal(c.ttsEngine, 'gptsovits')
})

test('직렬화 형태에 17개 TTS 키가 모두 존재한다 (필드 누락 방지; I1 parity 2 + I3 tail/emotion 5 추가)', () => {
  const c = buildTtsConfig({})
  assert.deepEqual(
    Object.keys(c).sort(),
    ['ttsEmotionBoundaryMode', 'ttsEmotionBoundaryPauseMs', 'ttsEmotionRefRegions', 'ttsEmotionRefSources',
      'ttsEmotionRefs', 'ttsEngine', 'ttsParsedPlanSha256', 'ttsParserVersion', 'ttsPitch',
      'ttsReferenceOverride', 'ttsReferencePrompts', 'ttsSilenceGap', 'ttsSpeed',
      'ttsTailFadeMs', 'ttsTailMode', 'ttsTailPaddingMs', 'ttsText']
  )
})

test('I3: tail/emotion 경계 기본값 = backward-compat(off/현행) + 계약 추가4 수치', () => {
  const c = buildTtsConfig({})
  assert.equal(c.ttsTailMode, 'off')            // 부재 = 현행 동작 보존(정정8), new=auto는 스토어가 명시 전달
  assert.equal(c.ttsTailPaddingMs, 120)
  assert.equal(c.ttsTailFadeMs, 8)
  assert.equal(c.ttsEmotionBoundaryMode, 'pause')
  assert.equal(c.ttsEmotionBoundaryPauseMs, 200)
})

test('I3: 지정한 tail/emotion 경계 값은 그대로 통과(auto 포함)', () => {
  const c = buildTtsConfig({
    ttsTailMode: 'auto', ttsTailPaddingMs: 90, ttsTailFadeMs: 12,
    ttsEmotionBoundaryMode: 'immediate', ttsEmotionBoundaryPauseMs: 350
  })
  assert.equal(c.ttsTailMode, 'auto')
  assert.equal(c.ttsTailPaddingMs, 90)
  assert.equal(c.ttsTailFadeMs, 12)
  assert.equal(c.ttsEmotionBoundaryMode, 'immediate')
  assert.equal(c.ttsEmotionBoundaryPauseMs, 350)
})

test('pitch/emotion source·region 기본값 — ttsPitch=0.0, 나머지 {} (계약 §1)', () => {
  const c = buildTtsConfig({})
  assert.equal(c.ttsPitch, 0.0)
  assert.deepEqual(c.ttsEmotionRefSources, {})
  assert.deepEqual(c.ttsEmotionRefRegions, {})
})

test('ttsPitch=0 이 ??로 보존된다 (|| 변질 방지)', () => {
  assert.equal(buildTtsConfig({ ttsPitch: 0 }).ttsPitch, 0)
  assert.equal(buildTtsConfig({ ttsPitch: -1.5 }).ttsPitch, -1.5)
})

test('buildReferencePrompts: 수동 전사문은 snake_case로 전달(trim)', () => {
  const out = buildReferencePrompts({ default: { manualText: '  안녕하세요  ', promptLang: 'ko' } })
  assert.deepEqual(out.default, { manual_text: '안녕하세요', prompt_lang: 'ko', mode: 'manual' })
})

test('buildReferencePrompts: 순수 auto(수동 없음·언어 없음)는 제외 — 빈 수동을 성공으로 오인 안 함', () => {
  const out = buildReferencePrompts({ default: { manualText: '   ', mode: 'auto' } })
  assert.deepEqual(out, {})
})

test('buildReferencePrompts: ref_free는 manual_text 빈 채로 전달', () => {
  const out = buildReferencePrompts({ happy: { mode: 'ref_free' } })
  assert.deepEqual(out.happy, { manual_text: '', prompt_lang: '', mode: 'ref_free' })
})

test('buildReferencePrompts: auto+언어만 지정도 전달(언어 override)', () => {
  const out = buildReferencePrompts({ default: { promptLang: 'ja', mode: 'auto' } })
  assert.deepEqual(out.default, { manual_text: '', prompt_lang: 'ja', mode: 'auto' })
})

test('buildTtsConfig가 ttsReferencePrompts를 직렬화해 포함', () => {
  const c = buildTtsConfig({ ttsReferencePrompts: { default: { manualText: 'hi' } } })
  assert.deepEqual(c.ttsReferencePrompts.default, { manual_text: 'hi', prompt_lang: '', mode: 'manual' })
})

test('buildReferencePrompts: autoText 등 UI 캐시 필드는 전달에서 제외', () => {
  const out = buildReferencePrompts({ default: { manualText: 'x', autoText: '자동결과', autoStatus: 'ok', autoLang: 'ko' } })
  assert.deepEqual(Object.keys(out.default).sort(), ['manual_text', 'mode', 'prompt_lang'])
})

test('자동 미리보기만(autoText만, 수동 편집 없음) → override 미전달', () => {
  // 자동 전사 결과가 autoText에만 있고 manualText는 비어 있으면 순수 auto → 전달 제외
  const out = buildReferencePrompts({ default: { autoText: '자동전사결과', autoStatus: 'ok', autoLang: 'ko', mode: 'auto' } })
  assert.deepEqual(out, {})
})

test('수정하여 사용(autoText를 manualText로 복사) → manual override 전달', () => {
  const out = buildReferencePrompts({ default: { manualText: '자동전사결과', mode: 'auto' } })
  assert.deepEqual(out.default, { manual_text: '자동전사결과', prompt_lang: '', mode: 'manual' })
})

test('ref_free는 manualText가 남아 있어도 manual_text를 비워 전달(ref_free 우선)', () => {
  const out = buildReferencePrompts({ default: { manualText: '남은 수동문', mode: 'ref_free', promptLang: 'ko' } })
  assert.deepEqual(out.default, { manual_text: '', prompt_lang: 'ko', mode: 'ref_free' })
})

test('deriveRefMode: 우선순위 ref_free > manual > auto', () => {
  assert.equal(deriveRefMode({ mode: 'ref_free', manualText: '남음' }), 'ref_free')
  assert.equal(deriveRefMode({ manualText: '수동문' }), 'manual')
  assert.equal(deriveRefMode({ manualText: '' }), 'auto')
  assert.equal(deriveRefMode({}), 'auto')
})

test('deriveRefMode: 수동문을 완전히 비우면 auto로 복귀', () => {
  assert.equal(deriveRefMode({ manualText: '내용', mode: 'manual' }), 'manual')
  // 공백만 남겨도 auto로 복귀(ref_free가 아닐 때)
  assert.equal(deriveRefMode({ manualText: '   ', mode: 'manual' }), 'auto')
  assert.equal(deriveRefMode({ manualText: '', mode: 'manual' }), 'auto')
})

// ── pruneStaleReferencePrompts (§4 합성 경계 stale 전사 방지) ──
test('prune: 지문 맵 없으면 검사 생략(전부 보존)', () => {
  const p = { default: { manualText: 'x' }, happy: { manualText: 'y' } }
  assert.deepEqual(pruneStaleReferencePrompts(p, undefined), p)
})

test('prune: 살아있는 source 없는 id(orphan)는 폐기', () => {
  const p = { default: { manualText: 'd' }, happy: { manualText: 'h' } }
  // happy source가 사라짐 → 지문 맵에 default만
  const out = pruneStaleReferencePrompts(p, { default: 'p|1|2' })
  assert.ok(out.default)
  assert.equal(out.happy, undefined)
})

test('prune: 지문 불일치(원본 교체/내용 변경)는 stale로 폐기', () => {
  const p = { happy: { manualText: 'A전사', sourceFingerprint: 'A.wav|10|100' } }
  // 현재 happy source 지문이 B로 바뀜
  const out = pruneStaleReferencePrompts(p, { happy: 'B.wav|20|200' })
  assert.equal(out.happy, undefined)
})

test('prune: 지문 일치면 보존', () => {
  const p = { happy: { manualText: 'A전사', sourceFingerprint: 'A.wav|10|100' } }
  const out = pruneStaleReferencePrompts(p, { happy: 'A.wav|10|100' })
  assert.deepEqual(out.happy, p.happy)
})

test('prune: 지문 미기록 + 살아있는 source는 보존(과도 폐기 방지)', () => {
  const p = { happy: { manualText: 'h' } }  // sourceFingerprint 없음
  const out = pruneStaleReferencePrompts(p, { happy: 'X|1|2' })
  assert.deepEqual(out.happy, p.happy)
})

// ── normalizePitchCapability (§6 pitch capability 계약) ──
test('pitch capability: probe 미수행(null) → unknown·probed:false', () => {
  const c = normalizePitchCapability(null)
  assert.deepEqual(c, { supported: false, method: 'unknown', probed: false, reason: 'probe 미수행' })
  assert.equal(normalizePitchCapability(undefined).probed, false)
  assert.equal(normalizePitchCapability({}).method, 'unknown')  // available 미지정도 unknown
})

test('pitch capability: rubberband 지원 → supported·probed:true', () => {
  const c = normalizePitchCapability({ available: true, reason: 'rubberband' })
  assert.deepEqual(c, { supported: true, method: 'rubberband', probed: true, reason: 'rubberband' })
})

test('pitch capability: rubberband 미지원 → none·probed:true', () => {
  const c = normalizePitchCapability({ available: false, reason: 'rubberband-unsupported' })
  assert.equal(c.supported, false)
  assert.equal(c.method, 'none')
  assert.equal(c.probed, true)
})

test('buildTtsConfig: 지문 맵 지정 시 stale/ orphan 전사는 Python 전달에서 제외', () => {
  const c = buildTtsConfig(
    { ttsReferencePrompts: {
        default: { manualText: '기본' },
        happy: { manualText: 'A전사', sourceFingerprint: 'A|1|1' },  // 교체됨 → stale
        sad: { manualText: '삭제됨' },                               // orphan(지문 맵에 없음)
    } },
    { default: 'main|9|9', happy: 'B|2|2' }
  )
  assert.ok(c.ttsReferencePrompts.default)          // 기본은 살아있음 → 보존
  assert.equal(c.ttsReferencePrompts.happy, undefined)  // stale 폐기
  assert.equal(c.ttsReferencePrompts.sad, undefined)    // orphan 폐기
})

// ── 공용 마감 I1 보강: parser_version 드리프트 가드(주석 아닌 실제 단언) ──
// buildTtsConfig의 하드코딩 폴백(?? 2)이 ttsGrammar의 권위 상수와 어긋나면 실패한다.
// 옵션에 ttsParserVersion을 주지 않아 폴백 경로를 강제로 탄다(드리프트 지점).
test('drift guard: buildTtsConfig 폴백 ttsParserVersion === TTS_PARSER_VERSION(단일 권위)', () => {
  assert.equal(buildTtsConfig().ttsParserVersion, TTS_PARSER_VERSION)
  assert.equal(buildTtsConfig({}).ttsParserVersion, TTS_PARSER_VERSION)
})

// ── 공용 마감 I1 보강: parity 입력 바이트 동일성(config가 원문·sha를 조용히 정규화하지 않음) ──
// renderer가 hash한 원문과 Python이 parse하는 원문이 정확히 같은 문자열이어야 한다.
// trim/CRLF→LF/앞뒤 공백 제거/Unicode 정규화가 config 계층에서 끼어들면 안 된다.
// 대사 전문은 단언에 쓰되 로그로 출력하지 않는다(assert 실패 메시지에 라벨만).
const BYTE_IDENTITY_INPUTS: Array<[string, string]> = [
  ['crlf', '[기쁨] 첫째 줄.\r\n[슬픔] 둘째 줄.'],
  ['blank-line', '[기쁨] 첫째.\n\n[슬픔] 둘째.'],
  ['leading-trailing-ws', '  [기쁨] 안녕하세요.  '],
  ['escape-tag', '\[기쁨] 안녕'],
  ['multilingual', '[happy] Hello 안녕 こんにちは'],
]
test('parity 바이트 동일성: buildTtsConfig가 ttsText를 무변형 통과(CRLF/빈줄/공백/escape/다국어)', () => {
  for (const [label, raw] of BYTE_IDENTITY_INPUTS) {
    const c = buildTtsConfig({ ttsText: raw })
    assert.equal(c.ttsText, raw, `label=${label} ttsText 변형됨`)
    assert.equal(c.ttsText.length, raw.length, `label=${label} 길이 변형됨`)
    // config 파일 직렬화(IPC 경로 모델) 왕복도 바이트 동일
    const round = JSON.parse(JSON.stringify(c)).ttsText
    assert.equal(round, raw, `label=${label} JSON 왕복 변형됨`)
  }
})
test('parity 바이트 동일성: buildTtsConfig가 ttsParsedPlanSha256을 무변형 통과', () => {
  const sha = 'dee7ad1ddad94297eb11d8fa7134aab96e27bb04864d69e4fbbfa9a27f129896'
  const c = buildTtsConfig({ ttsText: '[기쁨] 첫째 줄.\r\n[슬픔] 둘째 줄.', ttsParsedPlanSha256: sha })
  assert.equal(c.ttsParsedPlanSha256, sha)
  assert.equal(JSON.parse(JSON.stringify(c)).ttsParsedPlanSha256, sha)
})

// ── I5-c: 끝 여백(padding)과 페이드(fade) 값이 서로 바뀌어 전송되지 않음(스왑 금지) ──
test('buildTtsConfig: tailPadding/tailFade 값 스왑 없음(서로 다른 키로 정확 전송)', () => {
  const c = buildTtsConfig({ ttsTailMode: 'auto', ttsTailPaddingMs: 90, ttsTailFadeMs: 15 })
  assert.equal(c.ttsTailPaddingMs, 90, '끝 여백은 padding 키로')
  assert.equal(c.ttsTailFadeMs, 15, '페이드는 fade 키로')
  // 스왑됐다면 padding=15/fade=90이 됐을 것 — 명시적으로 부정.
  assert.notEqual(c.ttsTailPaddingMs, 15)
  assert.notEqual(c.ttsTailFadeMs, 90)
  // 기본값도 스왑 없음: padding 120, fade 8.
  const d = buildTtsConfig({ ttsTailMode: 'auto' })
  assert.equal(d.ttsTailPaddingMs, 120)
  assert.equal(d.ttsTailFadeMs, 8)
})
