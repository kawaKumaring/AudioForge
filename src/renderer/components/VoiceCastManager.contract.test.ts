// 배역 세트 화면의 계약 — 소스를 읽어 고정한다.
//
// 렌더 결과만 보면 "배역이 자동 적용되기 시작한 날" 아무 테스트도 깨지지 않는다.
// 그래서 그런 코드가 있는지, 문구가 무엇인지를 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CANDIDATE_LIFECYCLE_LABEL, CANDIDATE_REGISTER_LABEL, SAVE_STATE_LABEL,
  STEM_SOURCE_WARNING, VOICE_CAST_LABEL, candidatePlaybackText, saveFailureText,
} from '../../shared/analysisWording.ts'
import { CANDIDATE_LIFECYCLE } from '../../shared/emotionCandidateRegistry.ts'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const CAST = codeOf(read('./VoiceCastManager.tsx'))
const CAND = codeOf(read('./SpeakerEmotionCandidates.tsx'))
const HOOK = codeOf(read('../hooks/useVoiceCastRegistry.ts'))
const SHELL = codeOf(read('./TTSEditor.tsx'))

test('배역이 하나뿐이어도 자동 적용하지 않는다', () => {
  // 적용은 사용자가 누르는 행위다 — 훅의 applyCast 는 인자를 받아야만 활성화한다.
  assert.ok(HOOK.includes('const applyCast = useCallback((voiceCastId: string)'))
  // 목록 길이나 첫 항목으로 활성화하는 코드가 없어야 한다.
  for (const forbidden of ['casts.casts[0]', 'setActive(casts.casts[0]',
    'length === 1 && setActive', 'activeVoiceCastId ?? casts.casts[0]']) {
    assert.equal(HOOK.includes(forbidden), false, `자동 적용 코드: ${forbidden}`)
  }
  assert.ok(CAST.includes('VOICE_CAST_LABEL.noAutoApply'), '자동 적용 안 함을 화면이 말한다')
  assert.equal(VOICE_CAST_LABEL.noAutoApply, '배역 세트는 직접 선택해야 적용됩니다')
})

test('활성 배역이 없으면 화자 설정이 그려지지 않는다', () => {
  assert.ok(CAST.includes('{active && ('), '적용 전에는 후보 영역이 없다')
  assert.ok(CAST.includes('data-testid="voice-cast-inactive"'))
  assert.equal(VOICE_CAST_LABEL.none, '배역 세트를 먼저 만들고 선택하세요')
  assert.equal(VOICE_CAST_LABEL.notApplied, '이 작업에 적용된 배역 세트가 없습니다')
})

test('활성 배역은 저장되지 않는다 — 작업 세션에만 산다', () => {
  // activeVoiceCastId 를 settings 로 보내는 코드가 없어야 한다.
  assert.equal(/settings\.set\([^)]*active/i.test(HOOK), false)
  assert.ok(HOOK.includes('VOICE_CAST_STORAGE_KEY'))
  assert.ok(HOOK.includes('GLOBAL_ASSET_STORAGE_KEY'))
})

test('여섯 동작이 모두 실제 button 으로 있다', () => {
  for (const key of ['create', 'rename', 'apply', 'unapply', 'remove', 'pick'] as const) {
    assert.ok(VOICE_CAST_LABEL[key].length > 0, key)
  }
  for (const label of ['create', 'rename', 'apply', 'unapply', 'remove'] as const) {
    assert.ok(CAST.includes(`VOICE_CAST_LABEL.${label}`), label)
  }
  // 모든 동작은 button 이고 div onClick 이 아니다.
  assert.equal(/<div[^>]*onClick/.test(CAST), false, 'div 클릭 핸들러가 있다')
  assert.equal(/<div[^>]*onClick/.test(CAND), false, 'div 클릭 핸들러가 있다')
  assert.ok(CAST.includes('type="button"'))
})

test('화자·감정 선택에 label 이 붙는다', () => {
  assert.ok(CAST.includes('htmlFor={pickId}'), '배역 선택에 label')
  assert.ok(CAST.includes('htmlFor={nameId}'), '이름 입력에 label')
  assert.ok(CAND.includes('htmlFor={selectId}'), '감정 선택에 label')
})

test('후보 수 문구가 0·1·복수에서 정확하다', async () => {
  const { candidateCountText } = await import('./SpeakerEmotionCandidates.logic.ts')
  assert.equal(candidateCountText(0), '이 인물에게 등록된 목소리가 없습니다')
  assert.equal(candidateCountText(1), '이 인물의 참조가 하나뿐입니다 — 비교할 후보가 없습니다')
  assert.equal(candidateCountText(2), '후보 2개')
  assert.equal(candidateCountText(7), '후보 7개')
  // 하나뿐일 때 추천·최적·정확도 표현이 없다.
  for (const n of [0, 1]) {
    for (const forbidden of ['자동 제안', '최적', '가장 적합', '정확도']) {
      assert.equal(candidateCountText(n).includes(forbidden), false, `${n}: ${forbidden}`)
    }
  }
})

test('추천 배지는 후보가 둘 이상이고 추천 대상일 때만 붙는다', () => {
  assert.ok(CAND.includes('rows.length > 1 && r.autoRecommendable'),
    '하나뿐일 때 자동 제안이 붙으면 안 된다')
  assert.ok(CAND.includes('자동 제안'))
  assert.ok(CAND.includes('지금 사용'))
})

test('음악 분리 음원 경고 문구가 정확하다', () => {
  assert.equal(STEM_SOURCE_WARNING, '음악 분리 음원 — 잔향이 포함될 수 있음')
  assert.ok(CAND.includes('STEM_SOURCE_WARNING'))
  assert.ok(CAND.includes("r.sourceKind === 'separated_stem'"))
})

test('수명 상태마다 서로 다른 문구가 있다', () => {
  for (const state of CANDIDATE_LIFECYCLE) {
    assert.ok(CANDIDATE_LIFECYCLE_LABEL[state]?.length, state)
  }
  // SHA 변경·파일 없음·검증 전이 서로 다른 말이다.
  const changed = CANDIDATE_LIFECYCLE_LABEL.changed
  const expired = CANDIDATE_LIFECYCLE_LABEL.expired
  const unverified = CANDIDATE_LIFECYCLE_LABEL.unverified
  assert.equal(new Set([changed, expired, unverified]).size, 3)
  assert.match(changed, /내용이 바뀌/)
  assert.match(expired, /찾을 수 없/)
  assert.match(unverified, /확인/)
  assert.ok(CAND.includes('CANDIDATE_LIFECYCLE_LABEL'))
})

test('등록 해제를 파일 삭제라고 부르지 않는다', () => {
  assert.equal(CANDIDATE_REGISTER_LABEL.unregister, '후보에서 빼기')
  assert.match(CANDIDATE_REGISTER_LABEL.unregisterNote, /원본 파일은 그대로/)
  const all = [
    ...Object.values(CANDIDATE_REGISTER_LABEL), ...Object.values(VOICE_CAST_LABEL), CAND,
  ].join('\n')
  for (const forbidden of ['파일 삭제', '파일을 삭제', '원본 삭제']) {
    assert.equal(all.includes(forbidden), false, forbidden)
  }
})

test('저장 상태 세 가지를 구분하고 실패 시 보존 사실을 말한다', () => {
  assert.equal(SAVE_STATE_LABEL.saving, '저장 중')
  assert.equal(SAVE_STATE_LABEL.saved, '저장됨')
  assert.equal(SAVE_STATE_LABEL.failed, '저장 실패')
  const text = saveFailureText(null)
  assert.match(text, /그대로 남아 있습니다/)
  assert.match(text, /다시 시도/)
  assert.match(saveFailureText('SETTINGS_CORRUPT:JSON_PARSE_FAILED'), /덮어쓰지 않았습니다/)
  assert.ok(CAST.includes('SAVE_STATE_LABEL[saveState]'))
  assert.ok(CAST.includes('saveFailureText'))
})

test('저장 성공 뒤에만 저장됨이 된다', () => {
  // ok===false 를 실패로 보고, 실패 시 durable 값으로 되돌린다.
  assert.ok(HOOK.includes("r.ok === false"))
  assert.ok(HOOK.includes("setSaveState('failed')"))
  assert.ok(HOOK.includes('durable.current.casts'), '실패하면 화면을 durable 로 되돌린다')
  const savedIdx = HOOK.indexOf("setSaveState('saved')")
  const durableIdx = HOOK.indexOf('durable.current = { casts: nextCasts')
  assert.ok(durableIdx > 0 && savedIdx > durableIdx,
    'durable 갱신보다 먼저 저장됨으로 표시하면 안 된다')
})

test('재생 상태를 텍스트로 알린다', () => {
  assert.equal(candidatePlaybackText(false, 'a.wav'), '')
  assert.equal(candidatePlaybackText(true, 'a.wav'), '재생 중: a.wav')
  assert.ok(CAND.includes('data-testid="candidate-playing"'))
  assert.ok(CAND.includes('role="status"'))
})

test('저장 상태는 polite 로만 알린다', () => {
  assert.ok(CAST.includes('aria-live="polite"'))
  assert.equal(CAST.includes('aria-live="assertive"'), false)
})

test('전체 경로를 화면에 쓰지 않는다', () => {
  // 파일 이름만 뽑아 쓴다.
  assert.ok(CAND.includes("r.sourcePath.split(/[\\\\/]/).pop()"))
  for (const forbidden of ['{r.sourcePath}', 'sourcePath}</span>']) {
    assert.equal(CAND.includes(forbidden), false, forbidden)
  }
})

test('가로 스크롤을 만들지 않는다', () => {
  // 줄바꿈과 최소폭 0 을 쓰고 고정 폭을 두지 않는다.
  for (const src of [CAST, CAND]) {
    assert.ok(src.includes('flexWrap: '), '줄바꿈이 없으면 좁은 화면에서 밀린다')
    assert.ok(src.includes('minWidth: 0'))
    assert.equal(/width: '?\d{3,}/.test(src), false, '고정 폭이 있다')
    assert.equal(src.includes('overflowX'), false)
  }
})

test('대본을 다시 해석하지 않고 화자 목록을 받는다', () => {
  assert.ok(CAST.includes('speakers: readonly'), '화자는 props 로 온다')
  for (const forbidden of ['parse_tts_script', 'parseTtsScript', 'ttsText.split']) {
    assert.equal(CAST.includes(forbidden), false, forbidden)
    assert.equal(CAND.includes(forbidden), false, forbidden)
  }
  // 셸은 계획이 만든 화자 행을 넘긴다.
  assert.ok(SHELL.includes('speakers={speakerUiRows.map('))
})

test('감정을 앱이 자동 분류하지 않는다', () => {
  // 등록은 호출부가 준 emotionId 를 그대로 쓴다.
  assert.ok(HOOK.includes('candidateId: makeCandidateId(assetId, speakerId, emotionId'))
  for (const forbidden of ['detectEmotion', 'guessEmotion', 'classifyEmotion',
    'inferEmotion']) {
    assert.equal(HOOK.includes(forbidden), false, forbidden)
  }
})

test('분석은 기존 경로를 쓰고 모델을 올리지 않는다', () => {
  assert.ok(HOOK.includes('window.api.audio.fingerprintReference'))
  assert.ok(HOOK.includes('window.api.audio.analyzeReference'))
  for (const forbidden of ['qwen', 'synthesize', 'process(', 'gpu']) {
    assert.equal(HOOK.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  }
  assert.match(CANDIDATE_REGISTER_LABEL.analyzingNote, /모델을 올리지 않습니다/)
})

test('생성에는 고른 하나씩만 나간다', () => {
  // 셸이 활성 배역에서 (화자, 감정) → 경로 표를 만들어 store 에 넣는다.
  assert.ok(SHELL.includes('setSpeakerEmotionRefs(\n      toSpeakerEmotionRefs(')
    || SHELL.includes('toSpeakerEmotionRefs(reg, active.selections'))
  // 활성 배역이 없으면 빈 표다 — 기존 계약 그대로.
  assert.ok(SHELL.includes('setSpeakerEmotionRefs({})'))
  // 후보·자산 목록을 config 로 보내는 코드가 없다.
  for (const forbidden of ['ttsVoiceCasts', 'ttsReferenceAssets', 'ttsEmotionCandidates:']) {
    assert.equal(SHELL.includes(forbidden), false, forbidden)
  }
})

test('후보 파일 I/O 는 셸이 한다 — 컴포넌트는 하지 않는다', () => {
  for (const src of [CAST, CAND]) {
    for (const forbidden of ['window.api', 'ipcRenderer', 'selectFile(']) {
      assert.equal(src.includes(forbidden), false, forbidden)
    }
  }
  assert.ok(SHELL.includes('window.api.audio.selectFile(true)'), '여러 파일 선택은 셸이 연다')
})
