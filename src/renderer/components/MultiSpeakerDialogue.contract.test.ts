// 여러 명 화면의 계약 — 소스를 읽어 고정한다.
//
// 렌더 결과만 보면 "탭이 원문을 쓰기 시작한 날", "renderer 가 대본을 다시 parse 하기 시작한
// 날", "인물 카드가 VoiceCast 를 자동 저장하기 시작한 날" 아무 테스트도 깨지지 않는다.
// 그래서 그런 코드가 있는지를 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DIALOGUE_TABS, DIALOGUE_TAB_LABEL } from './DialogueTabs.logic.ts'
import { STRUCTURE_BLOCKERS } from '../../shared/dialogueSourcePatcher.ts'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

const TABS = codeOf(read('./DialogueTabs.tsx'))
const MULTI = codeOf(read('./MultiSpeakerDialogue.tsx'))
const HOOK = codeOf(read('../hooks/useDialogueProjection.ts'))
const SHELL = codeOf(read('./TTSEditor.tsx'))

test('탭은 두 개이고 보기 전환일 뿐이다 — 원문 쓰기 0', () => {
  assert.deepEqual([...DIALOGUE_TABS], ['single', 'multi'])
  assert.equal(DIALOGUE_TAB_LABEL.single, '한 명')
  assert.equal(DIALOGUE_TAB_LABEL.multi, '여러 명')
  // 탭 컴포넌트는 상태만 바꾼다. 원문·store·patcher 를 부르지 않는다.
  for (const forbidden of ['setTtsText', 'setText', 'ttsText', 'Patcher', 'createInitial',
    'useAppStore', 'window.api', 'confirm(']) {
    assert.equal(TABS.includes(forbidden), false, `탭이 원문에 손댄다: ${forbidden}`)
  }
  // 셸도 탭 전환에 상태 setter 하나만 잇는다.
  assert.ok(SHELL.includes('<DialogueTabs tab={dialogueTab} onTab={setDialogueTab}'))
})

test('한 명 탭에서는 여러 명 화면을 아예 그리지 않는다 — 기존 화면 불변', () => {
  assert.ok(SHELL.includes("{dialogueTab === 'multi' && ("), '여러 명일 때만 마운트')
  // 기존 편집기 마운트는 조건 없이 그대로 남는다.
  assert.ok(SHELL.includes('<EmotionScriptEditor'))
  // 한 명 편집기는 화자 구조를 지키는 변경만 받는다(SingleScriptGuard.contract.test 가 자세히 본다).
  assert.ok(SHELL.includes('onChange={onSingleEditorChange}'))
})

test('원문 textarea 는 구조화 판정으로 잠기지 않는다', () => {
  // EmotionScriptEditor 의 disabled 는 기존 `disabled`(합성 중) 하나뿐이다.
  const editorBlock = SHELL.slice(SHELL.indexOf('<EmotionScriptEditor'),
    SHELL.indexOf('/>', SHELL.indexOf('<EmotionScriptEditor')))
  assert.ok(editorBlock.includes('disabled={disabled}'))
  for (const forbidden of ['dialogue.', 'editingAllowed', 'patchAllowed', 'verdict']) {
    assert.equal(editorBlock.includes(forbidden), false,
      `원문 편집기가 구조화 판정에 묶였다: ${forbidden}`)
  }
})

test('renderer 는 대본을 다시 parse 하지 않는다 — 계획이 준 것만 쓴다', () => {
  for (const src of [HOOK, MULTI]) {
    for (const forbidden of ['parseTtsScript', 'parse_tts_script', 'tts_grammar',
      'ttsText.split(', 'text.split(\'\\n\')', 'parseUsedEmotionIds']) {
      assert.equal(src.includes(forbidden), false, forbidden)
    }
  }
  assert.ok(HOOK.includes('groupUtteranceRows(text, plan.utterances)'), '발화는 계획에서 온다(행 묶기는 패처 소유)')
  assert.ok(HOOK.includes('plan?.speakers'), '화자는 계획에서 온다')
  // 좌표는 계획 발화 그대로 패처의 행 묶기로 넘어간다 — 훅 안에 화자 표기 정규식이 없어야 한다.
  assert.equal(HOOK.includes('SPEAKER_DIRECTIVE_AT_START'), false, '훅은 좌표를 스스로 계산하지 않는다')
  assert.equal(/\[\\s\*\(\?:화자\|speaker\)/.test(HOOK), false, '훅 안에 화자 표기 정규식 없음')
})

test('원문 쓰기는 전부 source patcher 명령을 거친다', () => {
  for (const cmd of ['changeSpeaker', 'changeBaseEmotion', 'insertUtteranceAfter',
    'deleteUtterance', 'moveUtterance', 'createInitialDialogue', 'replaceUtteranceBody']) {
    assert.ok(HOOK.includes(cmd), cmd)
  }
  // 훅 밖(컴포넌트)에서 원문을 직접 조립하지 않는다.
  for (const forbidden of ['setText(', 'text.slice(', '[화자 ']) {
    assert.equal(MULTI.includes(forbidden), false, `컴포넌트가 원문을 만든다: ${forbidden}`)
  }
  // 범용 직렬화기 없음.
  for (const forbidden of ['serialize', 'toScript', 'planToText', 'renderScript']) {
    assert.equal(HOOK.includes(forbidden), false, forbidden)
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
})

test('좌표 의존 명령은 patchAllowed 게이트를 지난다', () => {
  // 훅의 명령들이 guard() 를 먼저 부른다.
  const cmds = ['const setSpeaker = useCallback', 'const setBaseEmotion = useCallback',
    'const insertAfter = useCallback', 'const remove = useCallback', 'const move = useCallback']
  for (const c of cmds) {
    const i = HOOK.indexOf(c)
    assert.ok(i > 0, c)
    const body = HOOK.slice(i, HOOK.indexOf('}, [', i))
    assert.ok(body.includes('guard()'), `${c} 가 게이트를 지나지 않는다`)
  }
  // 화면은 좌표 의존 버튼만 patchAllowed 로 잠근다.
  assert.ok(MULTI.includes("disabled={disabled || !p.patchAllowed}"))
  // 본문 textarea 는 patchAllowed 로 잠그지 않는다 — 입력은 계속 받는다.
  const bodyBlock = MULTI.slice(MULTI.indexOf('data-testid="dialogue-body"'),
    MULTI.indexOf('/>', MULTI.indexOf('data-testid="dialogue-body"')))
  assert.equal(bodyBlock.includes('patchAllowed'), false, '입력이 계획 상태에 잠긴다')
  assert.ok(bodyBlock.includes('disabled={disabled}'))
})

test('본문 draft 는 붙잡은 SHA 로 반영하고 낡으면 resync 한다', () => {
  assert.ok(HOOK.includes('commitDecision(d.capturedSha, textSha'))
  assert.ok(HOOK.includes("decision === 'resync'"))
  // 원문은 같고 계획만 늦으면 초안을 버리지 않고 보류한다(늦은 분석이 사용자 글을 되돌리지 않는다).
  assert.ok(HOOK.includes("return 'deferred' as const"), '보류 경로')
  assert.ok(HOOK.includes('pendingCommit'), '보류 표시')
  assert.ok(HOOK.includes('TRANSIENT_BLOCKERS as readonly string[]'), '일시적 차단에만 보류')
  // 행은 계획과 SHA 가 맞는 원문 스냅샷 위에서만 그린다(낡은 좌표를 새 원문에 대지 않는다).
  assert.ok(HOOK.includes('toViews(projectionText, result)'), '스냅샷 projection')
  assert.ok(HOOK.includes('sliceOf(projectionText, v)'), '스냅샷 slice')
  assert.ok(HOOK.includes('capturedSha: d.capturedSha, currentSha: textSha'))
  // 화면은 blur / Ctrl+Enter 에 한 번 반영한다 — 글자마다 반영하지 않는다.
  assert.ok(MULTI.includes('onBlur={() => p.commitDraft(i)}'))
  assert.ok(MULTI.includes('onChange={(e) => p.updateDraft(i, e.target.value)}'))
  // 늦게 온 분석 결과가 원문을 건드릴 통로: 훅은 result 를 읽기만 한다.
  const resultWrites = HOOK.match(/setText\(/g) ?? []
  assert.equal(resultWrites.length, 1, 'setText 호출은 apply() 한 곳뿐이어야 한다')
})

test('표현 불가 대본은 이유를 말하고 원문 편집기를 남긴다', () => {
  assert.ok(MULTI.includes('if (!p.editingAllowed)'))
  assert.ok(MULTI.includes('data-testid="multi-dialogue-source-only"'))
  assert.ok(MULTI.includes('아래 대본 직접 입력은 그대로 사용할 수 있습니다'))
  // 여덟 가지 사유마다 사용자 문구가 있다.
  const start = MULTI.indexOf('STRUCTURE_BLOCKER_LABEL')
  const block = MULTI.slice(start, MULTI.indexOf('}', start))
  for (const b of STRUCTURE_BLOCKERS) assert.ok(block.includes(b), b)
})

test('빈 대본은 빈 인물 카드 2개만 보여 주고 쓰지 않는다', () => {
  assert.ok(MULTI.includes("p.verdict.mode === 'initial' && p.speakers.length === 0"))
  assert.ok(MULTI.includes('p.ensurePendingSpeakers(2)'))
  // pending 카드는 훅의 로컬 상태다 — settings/VoiceCast/store 에 가지 않는다.
  for (const forbidden of ['useVoiceCastRegistry', 'settings.set', 'VOICE_CAST_STORAGE_KEY',
    'createVoiceCast', 'registerCastCandidate', 'useAppStore']) {
    assert.equal(HOOK.includes(forbidden), false, forbidden)
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
  // 첫 대화는 initialCreationAllowed 일 때 createInitial 로만 만든다.
  assert.ok(HOOK.includes('if (!verdict.initialCreationAllowed)'))
})

test('대사가 남은 인물은 확인 없이 지우지 않는다', () => {
  assert.ok(HOOK.includes("'SPEAKER_HAS_UTTERANCES'"))
  assert.ok(MULTI.includes('disabled={disabled || !removable.ok}'))
  // 삭제 버튼은 pending 카드만 실제로 지운다 — 원문의 인물은 발화를 먼저 없애야 한다.
  assert.ok(MULTI.includes('if (s.pending) p.removePendingSpeaker(s.speakerId)'))
})

test('화자 표기가 없는 대사는 빈 칸이 아니라 기본 인물로 보이고, 등록되지 않는다', () => {
  assert.ok(MULTI.includes('<option value="">기본 인물</option>'), '행 인물 칸의 기본 인물')
  assert.ok(MULTI.includes('data-testid="default-speaker-note"'), '기본 인물 안내 한 줄')
  assert.ok(MULTI.includes('한 명 탭과 같은 기본 목소리'), '기본 목소리 안내')
  // 기본 인물 선택은 null 로 전달되고, 훅은 null 을 검증 없이 패처로 넘긴다(패처가 [화자 기본] 을 쓴다).
  assert.ok(MULTI.includes("p.setSpeaker(i, e.target.value === '' ? null : e.target.value)"))
  assert.ok(HOOK.includes('setSpeaker: (index: number, label: string | null)'))
  // 기본 인물은 인물 카드·목소리 store·저장소 어디에도 등록하지 않는다.
  for (const forbidden of ["speakerId: 'default'", "label: '기본 인물'", 'registerSpeakerRef(\'\'', 'registerSpeakerRef("")']) {
    assert.equal(MULTI.includes(forbidden), false, forbidden)
    assert.equal(HOOK.includes(forbidden), false, forbidden)
  }
})

test('인물 이름은 원문에 쓰기 전에 검증되고 문구가 있다', () => {
  assert.ok(MULTI.includes('validateSpeakerLabel(label)'))
  assert.ok(MULTI.includes('data-testid="speaker-name-problem"'))
  for (const p of ['SPEAKER_LABEL_EMPTY', 'SPEAKER_LABEL_HAS_WHITESPACE',
    'SPEAKER_LABEL_FORBIDDEN_CHAR', 'SPEAKER_LABEL_RESERVED_DEFAULT']) {
    assert.ok(MULTI.includes(p), p)
  }
})

test('인물 카드에서 목소리 지정이 보이고 같은 store 를 쓴다', () => {
  assert.ok(MULTI.includes("'목소리 지정'"))
  assert.ok(MULTI.includes('referenceDecisionText(voice.decision)'), '판정 문구는 공용 함수')
  // 셸은 기존 store 콜백을 그대로 잇는다 — 새 저장소 없음.
  assert.ok(SHELL.includes('if (src) registerSpeakerRef(id, src, label)'))
  assert.ok(SHELL.includes('onRemoveVoice={(id) => removeSpeakerRef(id)}'))
  assert.ok(SHELL.includes('renderRegionEditor={renderSpeakerRegion}'), '구간 편집기 재사용')
  // 배역 세트 개념을 여러 명 화면에 노출하지 않는다.
  for (const forbidden of ['배역 세트', 'VoiceCast', 'castName']) {
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
})

test('카드의 목소리 표시는 실제 생성과 같다 — 감정별 덮어쓰기와 같은 파일 공유를 숨기지 않는다', () => {
  // 판정 표의 (화자, 감정) 칸이 더 이상 빈 표가 아니다 — store 의 ttsSpeakerEmotionRefs 에서 온다.
  assert.equal(SHELL.includes('speakerEmotionReady: {} as Record<string, boolean>'), false, '빈 표')
  const i = SHELL.indexOf('speakerEmotionReady:')
  assert.ok(SHELL.slice(i, i + 200).includes('ttsSpeakerEmotionRefs'), '전용 참조가 판정에 들어간다')
  // 카드 상태에 공유·덮어쓰기 정보가 실린다.
  assert.ok(SHELL.includes('emotionOverrides: emotionOverridesOf(speakerId)'))
  assert.ok(SHELL.includes('sharedWith: row.sharedWith'))
  assert.ok(MULTI.includes('data-testid="speaker-voice-shared"'))
  assert.ok(MULTI.includes('data-testid="speaker-voice-emotion-override"'))
  assert.ok(MULTI.includes('같은 목소리로 만들어집니다'))
  assert.ok(MULTI.includes('이 감정에서는 다른 목소리 사용'))
  // 표시 교정일 뿐이다 — 생성 경로(ProcessButton 이 보내는 config)는 건드리지 않는다.
  const PB = codeOf(read('./ProcessButton.tsx'))
  assert.ok(PB.includes('const effective = slot?.ready ? (slot.clip || slot.source) : \'\''), '기본 목소리 전송 규칙 불변')
  assert.ok(PB.includes('ttsSpeakerEmotionRefs'), '전용 참조 전송 불변')
})

test('감정은 두 단계다 — 기본 선택과 원문 조각 편집', () => {
  assert.ok(MULTI.includes('p.setBaseEmotion(i,'))
  assert.ok(MULTI.includes('대사 중간에 감정 바꾸기'))
  assert.ok(MULTI.includes('p.commitDraft(i, { advanced: true })'))
  // 기본 편집에서 중간 태그가 있으면 사용자에게 알린다.
  assert.ok(MULTI.includes('r.hasMidEmotionTags && !adv'))
})

test('순서 이동은 patcher 판정이 허용할 때만 활성이고 이유를 보여 준다', () => {
  assert.ok(MULTI.includes('p.moveAllowed(i, -1)') && MULTI.includes('p.moveAllowed(i, 1)'))
  assert.ok(MULTI.includes('disabled={disabled || !up.allowed}'))
  for (const code of ['NOT_ADJACENT', 'SPEAKER_INHERITED', 'CONTENT_BETWEEN', 'FOLLOWER_INHERITS']) {
    assert.ok(MULTI.includes(code), code)
  }
})

test('모든 동작은 button 이고 선택에는 label 이 있다', () => {
  assert.equal(/<div[^>]*onClick/.test(MULTI), false)
  assert.equal(/<span[^>]*onClick/.test(MULTI), false)
  for (const id of ['speakerSelectId', 'emotionSelectId']) {
    assert.ok(MULTI.includes(`htmlFor={${id}}`), id)
  }
  for (const id of ['dlg-new-speaker', 'dlg-new-emotion']) {
    assert.ok(MULTI.includes(`htmlFor="${id}"`), id)
  }
  assert.ok(MULTI.includes('flexWrap:'))
  assert.equal(MULTI.includes('overflowX'), false)
})
