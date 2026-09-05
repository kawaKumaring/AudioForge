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
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)) }

test('탭은 두 개, 합성 화면 전체를 전환한다(합성 메뉴 아래 전체 폭 한 곳) — 원문 쓰기 0', () => {
  assert.deepEqual([...DIALOGUE_TABS], ['single', 'multi'])
  assert.equal(DIALOGUE_TAB_LABEL.single, '한 명')
  assert.equal(DIALOGUE_TAB_LABEL.multi, '여러 명')
  for (const forbidden of ['setTtsText', 'setText', 'ttsText', 'Patcher', 'createInitial',
    'useAppStore', 'window.api', 'confirm(']) {
    assert.equal(TABS.includes(forbidden), false, `탭이 원문에 손댄다: ${forbidden}`)
  }
  assert.ok(TABS.includes('aria-label="생성 방식"') && TABS.includes("width: '100%'"), '전체 폭 탭')
  assert.equal((SHELL.match(/<DialogueTabs tab=\{dialogueTab\} onTab=\{setDialogueTab\}/g) ?? []).length, 1, '탭은 한 곳에만(대사 옆 중복 없음)')
  const top = between(SHELL, "<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>", '<TtsVoiceSection')
  assert.ok(top.includes('<DialogueTabs'), '탭이 목소리 영역 위(합성 메뉴 바로 아래)에 있다')
})

test('한 명: 목소리 섹션 + 대사 한 칸. 여러 명: 단일용 목소리 영역 없음, 카드 목록, 공통 생성 옵션 한 번', () => {
  assert.ok(SHELL.includes("{dialogueTab === 'single' && (\n      <TtsVoiceSection"), '목소리 섹션은 한 명 전용')
  assert.ok(SHELL.includes('data-testid="default-voice-driver"'), '여러 명은 기본 목소리 준비만 숨겨서 돈다(첫 인물이 이어받는 원천)')
  const driver = between(SHELL, 'data-testid="default-voice-driver"', '</div>')
  assert.ok(driver.includes('open={false}') && driver.includes('autoConfirm'), '도구는 그리지 않고 준비만')
  assert.ok(SHELL.includes("aria-label={dialogueTab === 'multi' ? '인물과 대사' : '대사'}"), '여러 명은 단일 번호 체계를 끌고 오지 않는다')
  assert.ok(SHELL.includes("{dialogueTab === 'multi' ? 1 : 2}") && SHELL.includes("flowNumber={dialogueTab === 'multi' ? 2 : 3}"))
  // 참조 방식은 고급 설정 안 한 곳에만 있다 — 기본 화면의 별도 영역(공통 생성 옵션·목소리 섹션 안)은 없앴다.
  assert.equal(SHELL.includes('data-testid="common-options"'), false, '기본 화면에 별도 참조 방식 영역이 없다')
  assert.ok(SHELL.includes('data-testid="ref-mode-advanced"'), '고급 설정 안으로 통합')
  assert.equal((SHELL.match(/\{refModeControl\}/g) ?? []).length, 1, '편집 위치는 하나뿐이다')
  assert.ok(SHELL.includes("{dialogueTab === 'multi' && !directEditOpen && ("), '여러 명일 때만 카드 마운트')
  assert.ok(SHELL.includes('<EmotionScriptEditor'))
  assert.ok(SHELL.includes('onChange={onSingleEditorChange}'))
  // 상단 공용 감정 팔레트는 한 명 전용 — 여러 명은 카드의 + 감정만.
  const palette = between(SHELL, '감정 태그 삽입', '{/* 여러 명 — 원문 위의 projection')
  assert.ok(SHELL.slice(SHELL.indexOf('감정 태그 삽입') - 400, SHELL.indexOf('감정 태그 삽입')).includes("{dialogueTab === 'single' && ("), '팔레트는 한 명 전용')
  assert.ok(palette.length > 0)
})

test('원문 textarea 는 구조화 판정으로 잠기지 않는다', () => {
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
})

test('원문 쓰기는 전부 source patcher 명령을 거친다 — 카드 본문은 content 하나로 반영, 빈 카드·설정 창은 원문을 쓰지 않는다', () => {
  for (const cmd of ['changeSpeaker', 'insertUtteranceAfter', 'deleteUtterance', 'moveUtterance',
    'createInitialDialogue', 'replaceUtteranceContent']) {
    assert.ok(HOOK.includes(cmd), cmd)
  }
  for (const forbidden of ['setText(', 'text.slice(', '[화자 ']) {
    assert.equal(MULTI.includes(forbidden), false, `컴포넌트가 원문을 만든다: ${forbidden}`)
  }
  assert.equal((HOOK.match(/setText\(/g) ?? []).length, 1, 'setText 호출은 apply() 한 곳뿐')
  // 새 대사의 반영 경로는 하나(빈 대본이면 createInitial, 아니면 insertAfter). 빈 대사는 반영하지 않는다.
  const commit = between(MULTI, 'const commitNewLine = ', '  const openAdd')
  assert.ok(commit.includes("if (!line.trim()) return null") && commit.includes('p.createInitial([{ speakerLabel: label, line }])') && commit.includes('p.insertAfter(rowsBefore - 1, label, line, null)') && commit.includes('setGhost({ label, line, rowsBefore'))
  // 설정 창은 카드만 만든다 — 원문 명령 호출 없음.
  const sheet = between(MULTI, 'function AddDialogueSheet(', '\nfunction SpeakerVoicePanel(')
  for (const forbidden of ['createInitial', 'insertAfter', 'commitNewLine', 'setText']) assert.equal(sheet.includes(forbidden), false, forbidden)
})

test('발화 카드 하나에 인물·목소리·감정·대사가 함께 있고, 목소리 상세는 누른 카드 안에 하나만 펼친다', () => {
  const cardSrc = between(MULTI, 'function UtteranceCard(', 'function PendingUtteranceCard(')
  assert.ok(cardSrc.includes('data-testid="dialogue-row"'))
  assert.ok(cardSrc.includes('<option value="">기본 인물</option>'), '누가 — 인물 select(기본 인물 포함)')
  assert.ok(cardSrc.includes('data-testid="card-voice"') && cardSrc.includes('voiceStatusShort(voice)'), '어떤 목소리 — 짧은 상태와 상세 진입')
  assert.ok(cardSrc.includes('{props.voiceDetailOpen && props.renderVoiceDetail()}'), '목소리 상세는 카드 안')
  assert.ok(cardSrc.includes('<EmotionAdd') && MULTI.includes('data-testid="emotion-add"') && MULTI.includes('+ 감정·쉼') && MULTI.includes('`[쉼 ${sec}]`'), '어느 위치에서 어떤 감정·쉼 — 같은 커서 삽입')
  assert.ok(cardSrc.includes('data-testid="dialogue-body"'), '무엇을 — 대사')
  assert.ok(cardSrc.includes('aria-label="위로"') && cardSrc.includes('aria-label="아래로"') && cardSrc.includes('>삭제</button>'))
  assert.equal((cardSrc.match(/<textarea/g) ?? []).length, 1, '카드의 textarea 는 하나')
  for (const forbidden of ['AdvancedSliceEditor', 'dialogue-advanced', '대사 중간에 감정 바꾸기', 'setBaseEmotion(', 'dlg-emotion-', 'hasMidEmotionTags', '대화 추가</button>']) {
    assert.equal(cardSrc.includes(forbidden), false, forbidden)
  }
  // 한 번에 하나: 상세는 (인물, 카드) 한 쌍만 연다. 위쪽 별도 패널·인물 카드 영역은 없다.
  assert.ok(MULTI.includes('const [voiceOpen, setVoiceOpen] = useState<{ speakerId: string; cardKey: string } | null>(null)'))
  assert.equal((MULTI.match(/renderRegionEditor\?\.\(/g) ?? []).length, 1, '구간 편집기는 상세 한 곳에서만')
  assert.equal(MULTI.includes('data-testid="multi-speakers"'), false)
  assert.equal(MULTI.includes('data-testid="speaker-card"'), false)
  assert.ok(MULTI.includes('data-testid="multi-summary"') && MULTI.includes('모두 준비됨'))
  // 상세 안: 구간 수정은 필요할 때만 펼친다. 같은 인물의 다른 대사에도 적용된다는 짧은 안내.
  const panel = between(MULTI, 'function SpeakerVoicePanel(', '\n}\n')
  assert.ok(panel.includes('const [regionOpen, setRegionOpen] = useState(!!props.initialRegionOpen)') && panel.includes('renderRegionEditor?.(voiceId, regionOpen)'))
  assert.ok(panel.includes('data-testid="voice-region-toggle"') && panel.includes('data-testid="speaker-voice-applies-all"'))
  assert.ok(panel.includes("'목소리 지정'") && panel.includes("'목소리 바꾸기'") && panel.includes('목소리 해제'))
  for (const id of ['voice-panel', 'voice-panel-close', 'speaker-voice-decision', 'speaker-voice-shared', 'speaker-emotion-voice-toggle',
    'speaker-voice-emotion-override', 'speaker-voice-emotion-off', 'emotion-voice-toggle', 'emotion-voice-editor']) {
    assert.ok(MULTI.includes(`data-testid="${id}"`), id)
  }
})

test('카드 기본 화면의 목소리 상태는 짧은 문구 셋', () => {
  const fn = between(MULTI, 'export function voiceStatusShort(', '\n}\n')
  assert.ok(fn.includes("'목소리 선택 필요'") && fn.includes("'구간 선택 필요'") && fn.includes("'목소리 확인 중'") && fn.includes('`준비됨 · ${regionText(voice.region)}`'))
})

test('+ 감정: caret 위치에 기존 문법 태그를 넣는다 — IME·caret 기억·네이티브 undo', () => {
  assert.ok(MULTI.includes('insertTagAtCaret(value, caret, tag)'), '순수 함수로 위치·문자열 계산')
  assert.ok(MULTI.includes("document.execCommand('insertText', false, res.inserted)"), '네이티브 undo 가 사는 삽입')
  assert.ok(MULTI.includes('if (!ok) onDraft(res.text)'), '실패 시 draft 로')
  assert.ok(MULTI.includes("const onCompositionStart = () => { composing.current = true }"), 'IME 조합 중 삽입 보류')
  assert.ok(MULTI.includes('queuedTag.current = tag'), '조합 뒤 실행')
  assert.ok(MULTI.includes('const lastCaret = useRef<number | null>(null)'), '마지막 유효 caret 기억')
  assert.ok(MULTI.includes('data-testid="emotion-picker"'))
  assert.ok(MULTI.includes("props.emotions.filter((e) => e.id !== 'default')"), '기본 감정은 태그가 아니다')
  assert.equal(MULTI.includes('MID_EMOTION_WOULD_BE_LOST'), false)
})

test('셸은 기존 store 콜백을 그대로 잇는다 — 새 저장소 없음, 이름 변경은 슬롯 이동', () => {
  assert.ok(SHELL.includes('registerSpeakerRef(id, src, label)') && SHELL.includes('if (!src) return'))
  assert.ok(SHELL.includes('onRemoveVoice={(id) => removeSpeakerRef(id)}'))
  assert.ok(SHELL.includes('onSpeakerIdChanged={(from, to) => moveSpeakerRef(from, to)}'))
  assert.ok(SHELL.includes('renderRegionEditor={renderSpeakerRegion}') && SHELL.includes('const renderSpeakerRegion = (speakerId: string, open = true, autoConfirm = false)'))
  assert.ok(SHELL.includes('open={open}') && SHELL.includes('plainStatus={!open}'), '카드 안 구간 편집기는 접힘/펼침')
  assert.equal(SHELL.includes('<SpeakerReferenceManager'), false, '고급 설정의 중복 편집기 없음')
})

test('좌표 의존 명령은 patchAllowed 게이트를 지나고, 대사 입력은 잠기지 않는다', () => {
  for (const c of ['const setSpeaker = useCallback', 'const insertAfter = useCallback', 'const remove = useCallback', 'const move = useCallback']) {
    const i = HOOK.indexOf(c)
    assert.ok(i > 0, c)
    assert.ok(HOOK.slice(i, HOOK.indexOf('}, [', i)).includes('guard()'), c)
  }
  assert.ok(MULTI.includes('disabled={disabled || !p.patchAllowed}'))
  const bodyAt = MULTI.indexOf('<textarea ref={caret.taRef} data-testid="dialogue-body"')
  const bodyBlock = MULTI.slice(bodyAt, MULTI.indexOf('/>', bodyAt))
  assert.equal(bodyBlock.includes('patchAllowed'), false, '입력이 계획 상태에 잠긴다')
  assert.ok(bodyBlock.includes('onBlur={() => { caret.rememberCaret(); p.commitDraft(i) }}'))
  assert.ok(HOOK.includes("return 'deferred' as const") && HOOK.includes('toViews(projectionText, result)'))
})

test('표현 불가 대본은 이유를 말하고 원문 편집기를 남긴다', () => {
  assert.ok(MULTI.includes('if (!p.editingAllowed)'))
  assert.ok(MULTI.includes('data-testid="multi-dialogue-source-only"'))
  const start = MULTI.indexOf('STRUCTURE_BLOCKER_LABEL')
  const block = MULTI.slice(start, MULTI.indexOf('}', start))
  for (const b of STRUCTURE_BLOCKERS) assert.ok(block.includes(b), b)
})

test('대화 추가는 하나의 동작 — 버튼 하나 → 설정 창(기존 인물/새 인물) → 카드 생성·포커스. 취소 = 무변경. 시작 카드는 첫 대사를 바로 반영', () => {
  assert.ok(MULTI.includes("p.verdict.mode === 'initial' && p.speakers.length === 0"))
  assert.ok(MULTI.includes('p.ensurePendingSpeakers(1)'), '시작 카드는 1번 인물 하나')
  assert.ok(MULTI.includes('function StarterCard(') && MULTI.includes('data-testid="starter-card"'))
  // 중복 제거: 시작 카드 추가 버튼·카드별 추가 버튼·목록 아래 인물 select+대사 입력 행이 없다.
  for (const forbidden of ['data-testid="starter-add"', '<option value="__new__">', 'id="dlg-new-line"', 'id="dlg-new-speaker"', 'const [newLine, setNewLine]']) {
    assert.equal(MULTI.includes(forbidden), false, forbidden)
  }
  assert.equal((MULTI.match(/\+ 대화 추가/g) ?? []).length, 1, '+ 대화 추가 버튼 하나')
  assert.ok(MULTI.includes('data-testid="dialogue-add-open"') && MULTI.includes('data-testid="dialogue-add-dialog"'))
  assert.ok(MULTI.includes('data-testid="dialogue-add-done"') && MULTI.includes('data-testid="dialogue-add-cancel"'))
  // 기존 인물 → 준비된 목소리 재사용(빈 카드), 새 인물 → 이름·목소리(시작 카드). 대사 입력은 설정 창에 없다.
  const sheet = between(MULTI, 'function AddDialogueSheet(', '\nfunction SpeakerVoicePanel(')
  assert.equal((sheet.match(/<textarea/g) ?? []).length, 0, '설정 창에 대사 칸 없음')
  assert.ok(sheet.includes('준비된 목소리를 그대로 씁니다') && sheet.includes('data-testid="dialogue-add-voice"'))
  assert.ok(sheet.includes('if (assignedHere.current) props.onRemoveVoice(assignedHere.current)'), '취소하면 이 창에서 한 목소리 지정만 되돌린다')
  assert.ok(MULTI.includes('p.addPendingSpeakerNamed(label)') && HOOK.includes('const addPendingSpeakerNamed = useCallback((label: string) => {'))
  assert.ok(MULTI.includes('setFocusKey(key)') && MULTI.includes('autoFocus={focusKey === u.key}'), '만든 카드의 대사 칸에 포커스')
  // 시작 카드·빈 카드는 blur/Ctrl+Enter 로 반영한다(별도 추가 버튼 없음).
  const starter = between(MULTI, 'function StarterCard(', '\nfunction AddDialogueSheet(')
  assert.ok(starter.includes('onBlur={commit}') && starter.includes("if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit()"))
  assert.ok(starter.includes('props.onSpeakerIdChanged?.(fromId, toId)'), '이름 변경 → 슬롯 이동')
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
