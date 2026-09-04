// 여러 명 화면의 계약 — 소스를 읽어 고정한다.
//
// 렌더 결과만 보면 "탭이 원문을 쓰기 시작한 날", "renderer 가 대본을 다시 parse 하기 시작한
// 날", "카드가 목소리 자산을 지우기 시작한 날" 아무 테스트도 깨지지 않는다. 그래서 그런 코드가
// 있는지를 본다. 기본 단위는 **인물의 한 발화 카드**다(인물·목소리·감정·대사가 한 카드 안에).
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

test('탭은 두 개이고 생성 방식 전환일 뿐이다 — 원문 쓰기 0', () => {
  assert.deepEqual([...DIALOGUE_TABS], ['single', 'multi'])
  assert.equal(DIALOGUE_TAB_LABEL.single, '한 명')
  assert.equal(DIALOGUE_TAB_LABEL.multi, '여러 명')
  for (const forbidden of ['setTtsText', 'setText', 'ttsText', 'Patcher', 'createInitial',
    'useAppStore', 'window.api', 'confirm(']) {
    assert.equal(TABS.includes(forbidden), false, `탭이 원문에 손댄다: ${forbidden}`)
  }
  assert.ok(SHELL.includes('<DialogueTabs tab={dialogueTab} onTab={setDialogueTab}'))
})

test('한 명 탭에서는 여러 명 화면을 아예 그리지 않는다 — 기존 화면 불변', () => {
  assert.ok(SHELL.includes("{dialogueTab === 'multi' && "), '여러 명일 때만 마운트')
  assert.ok(SHELL.includes('<EmotionScriptEditor'))
  assert.ok(SHELL.includes('onChange={onSingleEditorChange}'))
})

test('원문 textarea 는 구조화 판정으로 잠기지 않는다', () => {
  // 타입 참조(<EmotionScriptEditorHandle>)가 아니라 JSX mount 를 잡는다.
  const mountAt = SHELL.indexOf('<EmotionScriptEditor\n')
  assert.ok(mountAt > 0)
  const editorBlock = SHELL.slice(mountAt, SHELL.indexOf('/>', mountAt))
  assert.ok(editorBlock.includes('disabled={disabled}'))
  for (const forbidden of ['dialogue.', 'editingAllowed', 'patchAllowed', 'verdict']) {
    assert.equal(editorBlock.includes(forbidden), false, `원문 편집기가 구조화 판정에 묶였다: ${forbidden}`)
  }
})

test('renderer 는 대본을 다시 parse 하지 않는다 — 계획이 준 것만 쓴다', () => {
  for (const src of [HOOK, MULTI]) {
    for (const forbidden of ['parseTtsScript', 'parse_tts_script', 'tts_grammar',
      'ttsText.split(', 'text.split(\'\\n\')', 'parseUsedEmotionIds']) {
      assert.equal(src.includes(forbidden), false, forbidden)
    }
  }
  assert.ok(HOOK.includes('groupUtteranceRows(text, plan.utterances)'), '발화는 계획에서 온다')
  assert.ok(HOOK.includes('plan?.speakers'), '화자는 계획에서 온다')
  assert.equal(HOOK.includes('SPEAKER_DIRECTIVE_AT_START'), false)
})

test('원문 쓰기는 전부 source patcher 명령을 거친다 — 카드 본문은 content 하나로 반영', () => {
  for (const cmd of ['changeSpeaker', 'insertUtteranceAfter', 'deleteUtterance', 'moveUtterance',
    'createInitialDialogue', 'replaceUtteranceContent']) {
    assert.ok(HOOK.includes(cmd), cmd)
  }
  for (const forbidden of ['setText(', 'text.slice(', '[화자 ']) {
    assert.equal(MULTI.includes(forbidden), false, `컴포넌트가 원문을 만든다: ${forbidden}`)
  }
  for (const forbidden of ['serialize', 'toScript', 'planToText', 'renderScript']) {
    assert.equal(HOOK.includes(forbidden), false, forbidden)
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
  const resultWrites = HOOK.match(/setText\(/g) ?? []
  assert.equal(resultWrites.length, 1, 'setText 호출은 apply() 한 곳뿐')
})

test('발화 카드 하나에 인물·목소리·감정·대사가 함께 있다', () => {
  const i = MULTI.indexOf('function UtteranceCard(')
  assert.ok(i > 0)
  const cardSrc = MULTI.slice(i, MULTI.indexOf('function StarterCard('))
  assert.ok(cardSrc.includes('data-testid="dialogue-row"'))
  assert.ok(cardSrc.includes('<option value="">기본 인물</option>'), '누가 — 인물 select(기본 인물 포함)')
  assert.ok(cardSrc.includes('data-testid="card-voice"') && cardSrc.includes('voiceStatusShort(voice)'), '어떤 목소리 — 상태와 설정 진입')
  assert.ok(cardSrc.includes('data-testid="emotion-add"') && cardSrc.includes('+ 감정'), '어느 위치에서 어떤 감정 — + 감정')
  assert.ok(cardSrc.includes('data-testid="dialogue-body"'), '무엇을 — 대사')
  assert.ok(cardSrc.includes('aria-label="위로"') && cardSrc.includes('aria-label="아래로"') && cardSrc.includes('>삭제</button>'))
  // 대화칸은 카드에 하나. 두 번째 textarea(원문 조각 복제)·기본 감정 dropdown 은 없다.
  assert.equal((cardSrc.match(/<textarea/g) ?? []).length, 1, '카드의 textarea 는 하나')
  for (const forbidden of ['AdvancedSliceEditor', 'dialogue-advanced', '대사 중간에 감정 바꾸기', 'setBaseEmotion(', 'dlg-emotion-', 'hasMidEmotionTags']) {
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
  // 위쪽 인물 카드 영역은 없다 — 요약 한 줄만.
  assert.equal(MULTI.includes('data-testid="multi-speakers"'), false)
  assert.equal(MULTI.includes('data-testid="speaker-card"'), false)
  assert.ok(MULTI.includes('data-testid="multi-summary"'))
  assert.ok(MULTI.includes('모두 준비됨'))
})

test('+ 감정: caret 위치에 기존 문법 태그를 넣는다 — IME·caret 기억·네이티브 undo', () => {
  assert.ok(MULTI.includes('insertTagAtCaret(value, caret, tag)'), '순수 함수로 위치·문자열 계산')
  assert.ok(MULTI.includes("document.execCommand('insertText', false, res.inserted)"), '네이티브 undo 가 사는 삽입')
  assert.ok(MULTI.includes('if (!ok) p.updateDraft(i, res.text)'), '실패 시 draft 로')
  assert.ok(MULTI.includes('onCompositionStart={() => { composing.current = true }}'), 'IME 조합 중 삽입 보류')
  assert.ok(MULTI.includes('queuedTag.current = tag'), '조합 뒤 실행')
  assert.ok(MULTI.includes('const lastCaret = useRef<number | null>(null)'), '마지막 유효 caret 기억')
  assert.ok(MULTI.includes('data-testid="emotion-picker"'))
  assert.ok(MULTI.includes("props.emotions.filter((e) => e.id !== 'default')"), '기본 감정은 태그가 아니다')
  // 태그를 지우는 것은 일반 편집 — 보호 규칙이 컴포넌트에 없다.
  assert.equal(MULTI.includes('MID_EMOTION_WOULD_BE_LOST'), false)
})

test('목소리 설정은 선택한 인물 한 명의 패널만 연다 — 파형도 한 명만', () => {
  assert.ok(MULTI.includes('const [voiceSpeaker, setVoiceSpeaker] = useState<string | null>(null)'))
  assert.ok(MULTI.includes('function SpeakerVoicePanel('))
  assert.equal((MULTI.match(/renderRegionEditor\?\.\(/g) ?? []).length, 1, '구간 편집기는 패널 한 곳에서만')
  assert.equal(SHELL.includes('<SpeakerReferenceManager'), false, '고급 설정의 중복 편집기 없음 — 같은 clipKey 를 두 편집기가 갖지 않는다')
  assert.ok(MULTI.includes('data-testid="voice-panel"') && MULTI.includes('data-testid="voice-panel-close"'))
  for (const id of ['speaker-voice-decision', 'speaker-voice-shared', 'speaker-emotion-voice-toggle',
    'speaker-voice-emotion-override', 'speaker-voice-emotion-off']) {
    assert.ok(MULTI.includes(`data-testid="${id}"`), id)
  }
  assert.ok(MULTI.includes("'목소리 지정'") && MULTI.includes("'목소리 바꾸기'") && MULTI.includes('목소리 해제'))
  // 셸은 기존 store 콜백을 그대로 잇는다 — 새 저장소 없음.
  assert.ok(SHELL.includes('if (src) registerSpeakerRef(id, src, label)'))
  assert.ok(SHELL.includes('onRemoveVoice={(id) => removeSpeakerRef(id)}'))
  assert.ok(SHELL.includes('renderRegionEditor={renderSpeakerRegion}'))
})

test('좌표 의존 명령은 patchAllowed 게이트를 지나고, 대사 입력은 잠기지 않는다', () => {
  for (const c of ['const setSpeaker = useCallback', 'const insertAfter = useCallback', 'const remove = useCallback', 'const move = useCallback']) {
    const i = HOOK.indexOf(c)
    assert.ok(i > 0, c)
    assert.ok(HOOK.slice(i, HOOK.indexOf('}, [', i)).includes('guard()'), c)
  }
  assert.ok(MULTI.includes('disabled={disabled || !p.patchAllowed}'))
  const bodyBlock = MULTI.slice(MULTI.indexOf('data-testid="dialogue-body"'), MULTI.indexOf('/>', MULTI.indexOf('data-testid="dialogue-body"')))
  assert.equal(bodyBlock.includes('patchAllowed'), false, '입력이 계획 상태에 잠긴다')
  assert.ok(bodyBlock.includes('onBlur={() => { rememberCaret(); p.commitDraft(i) }}'))
  assert.ok(HOOK.includes("return 'deferred' as const") && HOOK.includes('toViews(projectionText, result)'))
})

test('표현 불가 대본은 이유를 말하고 원문 편집기를 남긴다', () => {
  assert.ok(MULTI.includes('if (!p.editingAllowed)'))
  assert.ok(MULTI.includes('data-testid="multi-dialogue-source-only"'))
  const start = MULTI.indexOf('STRUCTURE_BLOCKER_LABEL')
  const block = MULTI.slice(start, MULTI.indexOf('}', start))
  for (const b of STRUCTURE_BLOCKERS) assert.ok(block.includes(b), b)
})

test('인물 생성과 재사용 — 빈 대본 시작 카드 1개, 새 인물 만들기, 삭제는 자산을 지우지 않는다', () => {
  assert.ok(MULTI.includes("p.verdict.mode === 'initial' && p.speakers.length === 0"))
  assert.ok(MULTI.includes('p.ensurePendingSpeakers(1)'), '시작 카드는 1번 인물 하나')
  assert.ok(MULTI.includes('function StarterCard(') && MULTI.includes('data-testid="starter-card"'))
  assert.ok(MULTI.includes('<option value="__new__">새 인물 만들기…</option>'))
  assert.ok(MULTI.includes('p.addPendingSpeaker()'))
  for (const forbidden of ['useVoiceCastRegistry', 'settings.set', 'VOICE_CAST_STORAGE_KEY', 'createVoiceCast',
    'registerCastCandidate', 'useAppStore', 'deleteVoiceCast', 'unregisterCandidate']) {
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
  // 발화 삭제 버튼은 원문 명령(p.remove)만 부른다.
  assert.ok(MULTI.includes('onClick={() => p.remove(i)}'))
  assert.equal(/onClick=\{\(\) => p\.remove\(i\)\}[^\n]*onRemoveVoice/.test(MULTI), false)
  assert.ok(HOOK.includes('if (!verdict.initialCreationAllowed)'))
  assert.ok(MULTI.includes('validateSpeakerLabel(label)') && MULTI.includes('data-testid="speaker-name-problem"'))
})

test('화면 용어 — 내부 용어를 내지 않는다', () => {
  const visible = MULTI.split('\n').filter((l) => /[가-힣]/.test(l) && !l.includes('data-testid') && !l.includes('import'))
  for (const forbidden of ['VoiceCast', '배역 세트', 'source patcher', 'parser', 'SHA', 'routing snapshot', 'speaker_id', 'reference_id']) {
    assert.equal(visible.some((l) => l.includes(forbidden)), false, forbidden)
  }
  for (const word of ['인물', '목소리', '감정', '대사', '준비됨']) assert.ok(MULTI.includes(word), word)
})

test('생성 계약의 거울 — 카드 표시(목소리 상태)와 전송 규칙', () => {
  const PB = codeOf(read('./ProcessButton.tsx'))
  assert.ok(PB.includes('const effective = slot?.ready ? (slot.clip || slot.source) : \'\''), '기본 목소리 전송 규칙 불변')
  assert.ok(PB.includes('ttsSpeakerEmotionRefs: gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled)'), '감정별 참조는 켠 인물만')
  assert.ok(PB.includes('ttsSpeakerMode'), '생성 방식 전송')
  // 화면 판정 표는 공용 함수(readinessFromSlots)로, 전송과 같은 게이트를 지난 참조만 넣는다.
  const i = SHELL.indexOf('const speakerReadiness = readinessFromSlots({')
  assert.ok(i > 0, '판정 표는 공용 함수')
  assert.ok(SHELL.slice(i, i + 400).includes('speakerEmotionRefs: gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled)'), '화면 판정 = 전송 게이트')
  assert.ok(SHELL.includes('sharedWith: row.sharedWith'), '같은 파일 공유 사실을 숨기지 않는다')
})

test('여러 명 화면은 카드만 기본으로 보이고, 원문 직접 편집은 접혀 있으며 둘을 동시에 고치지 않는다', () => {
  assert.ok(SHELL.includes("const showRawEditor = dialogueTab === 'single' || directEditOpen || !dialogue.editingAllowed"))
  assert.ok(SHELL.includes("{dialogueTab === 'multi' && !directEditOpen && ("), '직접 편집이 열리면 카드 숨김')
  assert.ok(SHELL.includes('{showRawEditor && (<>'), '원문 편집기는 조건부')
  assert.ok(SHELL.includes('data-testid="direct-edit"') && SHELL.includes('고급 · 대본 표기 직접 편집'))
  assert.equal(SHELL.includes('confirm('), false, '자동 변환·확인창 없음')
})
