// 인물별 목소리 화면의 계약 — 소스를 읽어 고정한다.
//
// 렌더 결과만 보면 "내부 경로가 화면에 새기 시작한 날" 아무 테스트도 깨지지 않는다.
// 그래서 그런 코드가 있는지를 본다(`InputAnalysisPanel.contract.test.ts` 와 같은 방식).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `.tsx` 는 node 가 타입만 벗겨 낼 수 없다(JSX 미지원) — 그래서 문구는 공용 모듈에 있고
// 여기서는 그것을 가져온다. 컴포넌트 자체는 소스로만 검사한다.
import {
  EMOTION_MATCH_LABEL, MODEL_EMOTION_CONTROL_NOTE, emotionMatchDetailLines,
  emotionMatchText, referenceDecisionText,
} from '../../shared/analysisWording.ts'
import {
  EMOTION_MATCH_STATES, REFERENCE_SOURCES, SPEAKER_REFERENCE_FAILURES,
  emotionReferenceChosen,
} from '../../shared/speakerReference.ts'
import type { EmotionMatchView } from '../../shared/speakerReference.ts'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const MANAGER = codeOf(read('./SpeakerReferenceManager.tsx'))
const EDITOR = codeOf(read('./TTSEditor.tsx'))

test('화면에 내부 경로를 쓰지 않는다', () => {
  // 사용자가 자기가 고른 파일을 알아볼 수 있어야 하므로 **파일 이름만** 보여 준다.
  assert.ok(MANAGER.includes('fileName'), '파일 이름 칸이 있어야 한다')
  for (const forbidden of ['slot.source}', 'r.source}', '{path}', 'clipPath']) {
    assert.equal(MANAGER.includes(forbidden), false, `경로가 화면으로 나간다: ${forbidden}`)
  }
  // 폴더를 떼는 곳은 셸(TTSEditor) 한 곳이다.
  assert.ok(/fileName:\s*\(slot\?\.source \|\| ''\)\.split/.test(EDITOR),
    '파일 이름만 남기는 자리가 있어야 한다')
})

test('표시 이름과 내부 id 를 혼동하지 않는다', () => {
  // 화면 문자열은 label, 등록·해제·조회 키는 speakerId 다.
  assert.ok(MANAGER.includes('{r.label}'), '화면에 보이는 것은 표시 이름이다')
  assert.ok(MANAGER.includes('props.onRemove(r.speakerId)'), '해제는 내부 id 로 한다')
  assert.ok(MANAGER.includes('props.onRegister(row.speakerId'), '등록도 내부 id 로 한다')
  assert.equal(MANAGER.includes('onRemove(r.label'), false)
  assert.equal(MANAGER.includes('onRegister(row.label'), false)
})

test('어느 목소리가 쓰일지는 공용 판정이 정한다 — 화면이 규칙을 다시 쓰지 않는다', () => {
  assert.ok(EDITOR.includes('resolveReferenceDecision'), '판정은 공용 함수가 한다')
  // 화면에서 우선순위를 다시 구현하면 생성과 갈라진다.
  assert.equal(/speakerRefState\[[^\]]+\]\s*\?\s*.*:\s*.*emotionRefState/.test(EDITOR), false,
    '폴백 규칙을 화면에서 다시 쓰면 안 된다')
})

test('인물 목록과 발화 수는 계획이 센 값이다', () => {
  assert.ok(EDITOR.includes('planSpeakerRows'), '인물 목록은 계획에서 온다')
  assert.ok(EDITOR.includes('defaultSpeakerUtteranceCount'), '기본 화자 발화 수도 마찬가지다')
  assert.equal(/plan\s*\.\s*utterances\s*\.\s*filter/.test(EDITOR), false,
    '발화를 화면에서 다시 세면 안 된다')
})

test('중복 사용을 막지 않고 알려 준다', () => {
  assert.ok(MANAGER.includes('sharedWith'), '같은 파일을 쓰는 화자를 표시한다')
  assert.ok(EDITOR.includes('sharedReferenceGroups'), '묶는 판정도 공용 함수다')
  // 중복을 막는 코드가 있으면 안 된다(사용자의 선택이다).
  assert.equal(/duplicate.*disabled|disabled.*duplicate/i.test(MANAGER), false)
})

test('모든 판정 값에 사용자 문구가 있다', () => {
  const seen = new Set<string>()
  for (const source of REFERENCE_SOURCES) {
    const t = referenceDecisionText({ ok: true, source })
    assert.ok(t.length > 0 && !t.includes('_'), `내부 값이 화면에 새면 안 된다: ${source}`)
    seen.add(t)
  }
  for (const code of SPEAKER_REFERENCE_FAILURES) {
    const t = referenceDecisionText({ ok: false, code })
    assert.ok(t.length > 0 && !t.includes('_'), `내부 코드가 화면에 새면 안 된다: ${code}`)
    seen.add(t)
  }
  assert.equal(seen.size, REFERENCE_SOURCES.length + SPEAKER_REFERENCE_FAILURES.length,
    '서로 다른 상황이 같은 문구로 보이면 안 된다')
})

test('파일 선택은 셸이 주입한다 — 컴포넌트가 파일 I/O 를 하지 않는다', () => {
  for (const forbidden of ['window.api', 'ipcRenderer', 'selectFile(']) {
    assert.equal(MANAGER.includes(forbidden), false, `컴포넌트가 직접 부른다: ${forbidden}`)
  }
  assert.ok(MANAGER.includes('props.requestSource()'))
})

test('구간 편집기는 감정과 같은 것을 쓴다 — clipKey 만 화자용으로 분리한다', () => {
  assert.ok(EDITOR.includes("clipKey={'spk:' + speakerId}"),
    '새 패널을 만들지 않고 기존 ReferenceRegionPanel 을 쓴다')
})

// ── 감정 참조 선택 (PHASE E2) ───────────────────────────────────────────────

const matchView = (over: Partial<EmotionMatchView> = {}): EmotionMatchView => ({
  state: 'reference_matched', selectionMethod: 'profile_match', score: 0.82,
  minScore: 0.55, runnerUpScore: 0.61, candidatesConsidered: 3,
  axisScores: { relative_f0: 0.9, rhythm: 0.4 }, ...over,
})

test('고른 것을 적용했다고 말하지 않는다', () => {
  // 이 단계에서 일어난 일은 참조 선택까지다. "적용 완료" 는 들리지 않는 변화를 약속한다.
  const everything = [
    ...Object.values(EMOTION_MATCH_LABEL),
    ...emotionMatchDetailLines(matchView()),
    MANAGER,
  ].join('\n')
  for (const forbidden of ['적용 완료', '음률 적용', '감정 적용됨', '감정이 적용']) {
    assert.equal(everything.includes(forbidden), false, `과장된 문구: ${forbidden}`)
  }
})

test('선택 결과마다 사용자 문구가 있다', () => {
  for (const state of EMOTION_MATCH_STATES) {
    const text = emotionMatchText(matchView({ state }))
    if (state === 'unsupported') {
      assert.equal(text, '', '쓰이지 않는 축을 화면에 그리지 않는다')
      continue
    }
    assert.ok(text.length > 0, `문구가 없다: ${state}`)
    assert.equal(/[a-z_]{4,}/.test(text), false, `내부 코드가 화면에 나간다: ${text}`)
  }
  assert.equal(emotionMatchText(matchView({ state: 'reference_matched' })),
    '감정에 맞는 참조 선택')
  for (const short of ['insufficient_candidates', 'no_reliable_candidate', 'no_target_profile'] as const) {
    assert.equal(emotionMatchText(matchView({ state: short })), '감정 참조 자료 부족')
  }
})

test('내부 점수는 기본 화면이 아니라 상세 정보에만 있다', () => {
  const view = matchView()
  // 기본 한 줄에는 숫자가 없다.
  assert.equal(/\d/.test(emotionMatchText(view)), false, '기본 화면에 숫자가 나갔다')
  const detail = emotionMatchDetailLines(view).join(' ')
  assert.ok(detail.includes('0.82'), '상세 정보에 일치도가 있어야 한다')
  assert.ok(detail.includes('0.61'), '상세 정보에 다음 후보 점수가 있어야 한다')
  // 축 이름도 내부 표기가 아니라 사용자 말로 나간다.
  assert.equal(detail.includes('relative_f0'), false, '내부 축 이름이 화면에 나간다')
  assert.ok(detail.includes('억양 높낮이'))
  // 컴포넌트는 점수를 기본 줄이 아니라 <details> 안에만 그린다.
  assert.ok(/<details[^>]*speaker-emotion-detail/.test(MANAGER)
    || MANAGER.includes('speaker-emotion-detail'), '상세 정보 영역이 있어야 한다')
  assert.ok(MANAGER.includes('emotionMatchDetailLines'), '상세 줄은 공용 함수에서 온다')
})

test('모델 한계는 상태와 무관하게 상세 정보에 늘 적는다', () => {
  for (const state of EMOTION_MATCH_STATES) {
    const lines = emotionMatchDetailLines(matchView({ state }))
    assert.ok(lines.includes(MODEL_EMOTION_CONTROL_NOTE),
      `모델 한계가 빠졌다: ${state}`)
  }
  assert.equal(MODEL_EMOTION_CONTROL_NOTE, '현재 모델은 감정 곡선 직접 제어를 지원하지 않음')
})

test('참조를 골랐다고 인정하는 상태는 하나뿐이다', () => {
  for (const state of EMOTION_MATCH_STATES) {
    assert.equal(emotionReferenceChosen(matchView({ state })),
      state === 'reference_matched', `상태 판정이 틀렸다: ${state}`)
  }
  assert.equal(emotionReferenceChosen(null), false)
})

test('감정 축이 없으면 아무것도 그리지 않는다', () => {
  assert.equal(emotionMatchText(null), '')
  assert.deepEqual(emotionMatchDetailLines(undefined), [])
  assert.ok(MANAGER.includes("emotionMatchText(r.emotion) !== ''"),
    '감정 축이 없는 작업에 빈 칸을 만들지 않는다')
})
