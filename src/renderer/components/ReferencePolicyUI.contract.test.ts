// 화면·IPC 가 참조 길이 조건을 엔진 정책 요약(shared/referencePolicy) 에서만 읽는지 — 소스 계약.
// 화면에 엔진과 다른 길이 조건이 표시되거나, 화면이 허용한 구간을 생성 직전에 다른 상수가 거부하는 일이 없어야 한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const R = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8').replace(/\u0000/g, '')
const PANEL = R('src/renderer/components/ReferenceRegionPanel.tsx')
const SHELL = R('src/renderer/components/TTSEditor.tsx')
const MULTI = R('src/renderer/components/MultiSpeakerDialogue.tsx')
const STORE = R('src/renderer/stores/app.store.ts')
const PRELOAD = R('src/preload/index.ts')
const MAIN = R('src/main/ipc/audio.ipc.ts')
const REGISTRY = R('src/shared/emotionCandidateRegistry.ts')
const CAST = R('src/renderer/hooks/useVoiceCastRegistry.ts')
const codeLines = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))

test('패널: 길이 숫자 상수·문구가 없다 — 모두 정책 요약에서 파생', () => {
  const code = codeLines(PANEL).join('\n')
  assert.equal(/const MIN_SEC|const MAX_SEC/.test(code), false)
  assert.equal(/3~10/.test(code), false)
  assert.equal(/10초를 초과|3초 미만|허용 3~10초/.test(code), false)
  assert.equal(/BLOCK_MESSAGE\[/.test(code), false, '차단 문구 표는 shared/blockMessage 로')
  for (const fn of ['policyFromAnalysis(', 'regionSliderBounds(', 'clampDuration(', 'judgeLength(', 'lengthConditionText(',
    'regionNeedText(', 'tooShortText(', 'outsideRecommendedText(', 'committedMismatchText(', 'blockMessage(']) {
    assert.ok(PANEL.includes(fn), fn)
  }
  assert.ok(PANEL.includes('min={sliderBounds.min} max={sliderBounds.max}'), '슬라이더 범위 = 정책(필수 없으면 원본 전체)')
})

test('패널: 분석·확정이 선택 엔진을 워커에 넘기고, 엔진이 바뀌면 다시 판정한다', () => {
  // 목표 길이(고급 설정)도 같은 요청에 실린다 — 값이 바뀌면 추천이 달라지므로 다시 물어야 한다.
  assert.ok(PANEL.includes("analyzeReference(path, clipKey, { ttsEngine, regionTargetSec: ttsRefTargetSec })"))
  assert.ok(PANEL.includes("trimReference(path, startSec, durSec, clipKey, { ttsEngine })"))
  assert.ok(PANEL.includes('}, [path, clipKey, say, ttsEngine, ttsRefTargetSec, setTtsReferencePolicy])'),
    '재분석 의존성에 엔진과 목표 길이')
  assert.ok(PANEL.includes('setTtsReferencePolicy(pol)'), '정책 요약을 store 에 발행')
})

test('패널: 엔진 전환 시 사용 중 구간은 지우지 않고(clip·region 유지) 필수 조건 밖일 때만 준비를 내리며 사유·수정을 안내', () => {
  const hits = PANEL.match(/committedMismatchText\(pol, committed\.region\.duration\)/g) ?? []
  assert.equal(hits.length, 2, '구간 추천 분기·원본 전체 분기 모두')
  // 2026-09-09: 보고가 ready 대신 단계를 싣는다. 엔진 전환의 길이 불일치는 '사용자 차례'다.
  assert.ok(PANEL.includes("phase: 'needs_region', clip: committed.clip, region: committed.region,"), '클립·구간 보존')
  assert.ok(PANEL.includes("j === 'blocked_short' || j === 'blocked_long'"), '필수 밖만 차단(권장 밖은 경고)')
  assert.ok(PANEL.includes('data-testid="region-outside-recommended"'), '권장 밖 길이 안내(막지 않음)')
  assert.ok(PANEL.includes('data-testid="region-need" data-required='), '필수/권장 구간 안내 구분')
  // 원본 전체가 유효한 상태에서 사용 중 구간이 있으면 원본 전체로 조용히 되돌리지 않는다.
  // 2026-09-09: 분석 결과가 도착한 **그때의** 사용 중 상태를 본다(요청을 시작한 시점 값이 아니라).
  // 그 사이 준비가 끝났으면 낡은 값으로 되돌리지 않는다.
  assert.ok(PANEL.includes("const committedThen = hasCommittedNow()"), '결과 도착 시점에 다시 읽는다')
  assert.ok(PANEL.includes("if (committedThen && cNow?.region) {"), '되돌리기 판정도 그 값으로')
})

test('카드: 실제로 모델에 가는 구간을 표시한다(원본 전체 / N초부터 M초)', () => {
  assert.ok(MULTI.includes("import { regionText, type RefPhase } from '../../shared/referencePolicy'"))
  assert.ok(MULTI.includes('return `준비됨 · ${regionText(voice.region)}`'))
  assert.ok(MULTI.includes('region?: { start: number; duration: number } | null'))
  assert.ok(SHELL.includes('region: slot?.region ?? null,'), '인물 행에 구간')
  assert.ok((SHELL.match(/region: (row|slot)\.region \?\? null/g) ?? []).length === 2, '카드 상태 두 경로 모두 구간 전달')
})

test('store·IPC: 정책 요약 슬롯, trim 도 extra(엔진) 를 워커 설정에 얹는다', () => {
  assert.ok(STORE.includes('ttsReferencePolicy: ReferencePolicySummary | null'))
  assert.ok(STORE.includes('setTtsReferencePolicy: (p) => set({ ttsReferencePolicy: p }),'))
  assert.ok(PRELOAD.includes("trimReference: (filePath: string, startSec: number, durSec: number, clipKey?: string, extra?: Record<string, unknown>) =>"))
  assert.ok(MAIN.includes("regionStart: startSec, regionDur: durSec, ...(extra ?? {}),"))
})

test('자산 수명 판정: 길이 경계를 정책에서 받는다(기본값만 예전 3~10)', () => {
  assert.ok(REGISTRY.includes('bounds: LifecycleBounds = { minSec: CANDIDATE_MIN_SEC, maxSec: CANDIDATE_MAX_SEC }'))
  assert.ok(REGISTRY.includes('record.sourceDurationSec > bounds.maxSec'))
  assert.ok(REGISTRY.includes('record.sourceDurationSec < bounds.minSec'))
  assert.ok(CAST.includes('lifecycleBoundsFromPolicy(useAppStore.getState().ttsReferencePolicy)'))
})
