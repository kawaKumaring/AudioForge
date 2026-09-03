// 감정 참조 후보 목록의 화면 계약 — 잠정 제안이 정답처럼 보이지 않게 하는 규칙.
//
// 렌더 결과만 보면 "점수가 기본 화면으로 새기 시작한 날" 아무 테스트도 깨지지 않는다.
// 그래서 문구 함수와 컴포넌트 소스를 함께 본다
// (`SpeakerReferenceManager.contract.test.ts` 와 같은 방식).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CANDIDATE_ACTION_LABEL, CANDIDATE_EXCLUSION_LABEL, CANDIDATE_QUALITY_LABEL,
  CANDIDATE_SOURCE_LABEL, PROVISIONAL_THRESHOLD_NOTE, SELECTION_REASON_LABEL,
  candidateBadges, candidateDetailLines, candidateFacts, candidateHeadline,
} from './analysisWording.ts'
import {
  CANDIDATE_EXCLUSIONS, CANDIDATE_QUALITY_STATES, CANDIDATE_SOURCE_KINDS,
  SELECTION_REASONS, USER_CHOICES, candidateSelectable, showRecommendedBadge,
} from './speakerReference.ts'
import type { EmotionCandidate, EmotionCandidateView } from './speakerReference.ts'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const MANAGER = codeOf(read('../renderer/components/EmotionReferenceManager.tsx'))

function cand(over: Partial<EmotionCandidate> = {}): EmotionCandidate {
  return {
    referenceId: 'ref_abc123', fileLabel: '민수_밝게.wav', durationSec: 4.2,
    sourceKind: 'clean_speech', qualityState: 'ok', qualityCodes: [],
    analyzable: true, recommended: true, selected: false, excludedReason: null,
    detail: { score: 0.82, axisScores: { relative_f0: 0.9 } }, ...over,
  }
}

function view(over: Partial<EmotionCandidateView> = {}): EmotionCandidateView {
  return {
    speakerRef: 'spk_0011', emotionId: 'joy', candidateCount: 3,
    insufficientCandidates: false, provisionalThreshold: 0.55,
    thresholdProvisional: true, candidates: [], selection: null, blocked: null, ...over,
  }
}

test('후보 하나뿐이면 제안이라는 말도 쓰지 않는다', () => {
  const one = view({ candidateCount: 1, insufficientCandidates: true })
  assert.equal(showRecommendedBadge(cand(), one), false)
  assert.deepEqual(candidateBadges(cand(), one), [])
  assert.match(candidateHeadline(one), /하나뿐/)
  // "가장 적합"처럼 순위를 확정하는 말이 어디에도 없어야 한다.
  const all = [
    ...Object.values(CANDIDATE_SOURCE_LABEL), ...Object.values(CANDIDATE_QUALITY_LABEL),
    ...Object.values(CANDIDATE_EXCLUSION_LABEL), ...Object.values(SELECTION_REASON_LABEL),
    ...Object.values(CANDIDATE_ACTION_LABEL),
    candidateHeadline(one), candidateHeadline(view()), MANAGER,
  ].join('\n')
  for (const forbidden of ['가장 적합', '최적', '정확도', '감정 일치 완료']) {
    assert.equal(all.includes(forbidden), false, `순위를 확정하는 말: ${forbidden}`)
  }
})

test('여러 후보에서는 자동 제안 배지가 붙는다', () => {
  assert.equal(showRecommendedBadge(cand(), view()), true)
  assert.deepEqual(candidateBadges(cand(), view()), ['자동 제안'])
  assert.deepEqual(candidateBadges(cand({ selected: true }), view()),
    ['자동 제안', '지금 사용'])
})

test('내부 숫자는 상세 정보에만 있다', () => {
  const c = cand()
  const v = view()
  // 기본 줄에는 숫자가 길이뿐이고 점수는 없다.
  const facts = candidateFacts(c).join(' ')
  assert.ok(facts.includes('4.2초'))
  assert.equal(facts.includes('0.82'), false, '기본 화면에 일치도가 나갔다')
  const detail = candidateDetailLines(c, v).join(' ')
  assert.ok(detail.includes('0.82'))
  assert.ok(detail.includes('0.55'), '잠정 기준값이 상세 정보에 있어야 한다')
  assert.equal(detail.includes('relative_f0'), false, '내부 축 이름이 화면에 나갔다')
  assert.ok(detail.includes('억양 높낮이'))
})

test('기준값이 잠정치라는 사실이 화면에 늘 적힌다', () => {
  for (const excluded of [null, ...CANDIDATE_EXCLUSIONS]) {
    const lines = candidateDetailLines(cand({ excludedReason: excluded }), view())
    assert.ok(lines.includes(PROVISIONAL_THRESHOLD_NOTE), String(excluded))
  }
  assert.match(PROVISIONAL_THRESHOLD_NOTE, /잠정/)
  // 컴포넌트도 이 문구를 기본 화면에 그린다.
  assert.ok(MANAGER.includes('PROVISIONAL_THRESHOLD_NOTE'))
})

test('음악에서 분리한 목소리는 출처 경고와 제외 사유를 함께 말한다', () => {
  const stem = cand({
    sourceKind: 'separated_stem', recommended: false,
    excludedReason: 'SEPARATED_STEM_NOT_RECOMMENDED',
  })
  assert.equal(candidateFacts(stem).includes('음악에서 분리한 목소리'), true)
  const detail = candidateDetailLines(stem, view()).join(' ')
  assert.ok(detail.includes('자동 추천 제외'))
  assert.ok(detail.includes('반주 잔향'))
  // 추천에서만 빠진다 — 사용자가 고르는 것은 막지 않는다.
  assert.equal(candidateSelectable(stem), true)
  assert.equal(showRecommendedBadge(stem, view()), false)
})

test('품질이 부적합한 후보만 고를 수 없다', () => {
  assert.equal(candidateSelectable(cand({ qualityState: 'invalid' })), false)
  for (const state of CANDIDATE_QUALITY_STATES) {
    if (state === 'invalid') continue
    assert.equal(candidateSelectable(cand({ qualityState: state })), true, state)
  }
})

test('모든 enum 값에 사용자 문구가 있다', () => {
  for (const k of CANDIDATE_SOURCE_KINDS) {
    assert.ok(CANDIDATE_SOURCE_LABEL[k]?.length, k)
    assert.equal(/[a-z_]{4,}/.test(CANDIDATE_SOURCE_LABEL[k]), false, k)
  }
  for (const k of CANDIDATE_QUALITY_STATES) assert.ok(CANDIDATE_QUALITY_LABEL[k]?.length, k)
  for (const k of CANDIDATE_EXCLUSIONS) assert.ok(CANDIDATE_EXCLUSION_LABEL[k]?.length, k)
  for (const k of SELECTION_REASONS) assert.ok(SELECTION_REASON_LABEL[k]?.length, k)
})

test('사용자가 할 수 있는 여섯 가지가 모두 화면에 있다', () => {
  // 추천 청취 / 다른 후보 청취 / 추천 그대로 / 다른 후보로 / 기본으로 / 감정 참조 안 씀.
  for (const key of ['preview', 'keep', 'choose', 'speakerDefault', 'noEmotionRef'] as const) {
    assert.ok(CANDIDATE_ACTION_LABEL[key].length, key)
    assert.ok(MANAGER.includes(`CANDIDATE_ACTION_LABEL.${key}`), key)
  }
  // 기본으로 돌아가기와 감정 참조 안 쓰기는 서로 다른 토큰을 보낸다.
  assert.equal(USER_CHOICES.length, 2)
  assert.ok(MANAGER.includes('USER_CHOICE_SPEAKER_DEFAULT'))
  assert.ok(MANAGER.includes('USER_CHOICE_NO_EMOTION_REF'))
})

test('화면은 점수를 다시 계산하지 않는다', () => {
  // 순위는 Python 이 정한다. 계산이 두 벌 있으면 화면과 생성이 다른 답을 낼 수 있다.
  for (const forbidden of ['compareProfiles', 'similarity(', 'Math.log2', 'semitone']) {
    assert.equal(MANAGER.includes(forbidden), false, `점수 계산이 화면으로 왔다: ${forbidden}`)
  }
  assert.ok(MANAGER.includes('candidateBadges'), '배지는 공용 문구 함수에서 온다')
})

test('폴더 경로가 화면으로 나가지 않는다', () => {
  // 후보는 파일 이름만 보여 준다.
  assert.ok(MANAGER.includes('c.fileLabel'))
  for (const forbidden of ['c.path', 'candidate.path', 'sourcePath}']) {
    assert.equal(MANAGER.includes(forbidden), false, forbidden)
  }
})

test('막힌 화자는 후보를 고를 단계가 아니라고 말한다', () => {
  const blocked = view({ blocked: 'SPEAKER_NOT_REGISTERED', candidateCount: 0 })
  assert.equal(candidateHeadline(blocked), '목소리를 지정하지 않았습니다')
})

test('후보가 없으면 없다고 말한다 — 빈 목록을 그리지 않는다', () => {
  assert.match(candidateHeadline(view({ candidateCount: 0 })), /등록된 목소리가 없습니다/)
})
