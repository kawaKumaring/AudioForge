// TTS config 직렬화 회귀 테스트 — Node 내장 러너(node --test), 새 의존성 0.
// 실행: npm test  (또는 node --test src/shared/ttsConfig.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTtsConfig, buildReferencePrompts, deriveRefMode, pruneStaleReferencePrompts, normalizePitchCapability } from './ttsConfig.ts'

test('ttsEmotionRefs가 config에 전달된다 (전달 경로 끊김 회귀)', () => {
  const refs = { happy: 'C:/ref/happy.wav', sad: 'C:/ref/sad.wav' }
  const c = buildTtsConfig({ ttsEmotionRefs: refs })
  assert.deepEqual(c.ttsEmotionRefs, refs)
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

test('직렬화 형태에 10개 TTS 키가 모두 존재한다 (필드 누락 방지)', () => {
  const c = buildTtsConfig({})
  assert.deepEqual(
    Object.keys(c).sort(),
    ['ttsEmotionRefRegions', 'ttsEmotionRefSources', 'ttsEmotionRefs', 'ttsEngine', 'ttsPitch',
      'ttsReferenceOverride', 'ttsReferencePrompts', 'ttsSilenceGap', 'ttsSpeed', 'ttsText']
  )
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
