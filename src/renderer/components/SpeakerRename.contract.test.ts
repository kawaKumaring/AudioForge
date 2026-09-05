// 인물 이름 변경 계약 — 카드 머리(이름 옆)의 '이름 바꾸기' 는 원문 표기·목소리 슬롯(확정 구간)·감정별 설정을 함께 옮긴다.
// 저장된 목소리 구성은 건드리지 않는다(사용자가 명시적으로 저장/덮어쓸 때만) — 현재 작업에서는 별칭으로 읽어 정체성·자산 연결을 유지한다.
// 다른 기존 인물과 충돌하면 병합하지 않고 거부. 고급 원문 편집(표기 직접 수정)은 알림+되돌리기만(슬롯 이동 없음).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const SHELL = codeOf(read('./TTSEditor.tsx'))
const MULTI = codeOf(read('./MultiSpeakerDialogue.tsx'))
const HOOK = codeOf(read('../hooks/useDialogueProjection.ts'))
const STORE = codeOf(read('../stores/app.store.ts'))
const CAST = codeOf(read('../hooks/useVoiceCastRegistry.ts'))
const REGISTRY = codeOf(read('../../shared/emotionCandidateRegistry.ts'))
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)) }

test('이름 바꾸기는 카드 머리(이름 옆)에 있고 목소리 상세 안에 숨지 않는다. 거부 코드를 그대로 안내한다(자동 병합 없음)', () => {
  const card = between(MULTI, 'function UtteranceCard(', 'function PendingUtteranceCard(')
  assert.ok(card.includes('data-testid="card-rename"') && card.includes('<RenameRow'), '카드 머리의 이름 바꾸기')
  const panel = between(MULTI, 'function SpeakerVoicePanel(', '\n}\n')
  assert.equal(panel.includes('speaker-rename'), false, '상세 안에는 이름 바꾸기가 없다')
  const row = between(MULTI, 'function RenameRow(', '\n}\n')
  for (const id of ['speaker-rename', 'speaker-rename-input', 'speaker-rename-apply', 'speaker-rename-problem']) assert.ok(row.includes(`data-testid="${id}"`), id)
  assert.ok(row.includes('const refused = props.onRename(next)') && row.includes('setProblem(REFUSAL_LABEL[refused] ?? refused)'))
  assert.ok(MULTI.includes("SPEAKER_LABEL_DUPLICATE: '같은 이름의 인물이 이미 있습니다. 기존 인물을 고르거나 다른 이름을 쓰세요'"))
})

test('셸: 원문 표기 일괄 변경이 성공했을 때만 현재 작업의 슬롯·이름·감정별 설정을 옮긴다 — 저장된 목소리 구성은 건드리지 않는다', () => {
  const w = between(SHELL, 'onRenameSpeaker={(id, newLabel) => {', '}}\n')
  assert.ok(w.includes("return 'SPEAKER_LABEL_DUPLICATE'"), '다른 인물(원문·시작 카드·슬롯)과 충돌하면 거부')
  assert.ok(w.includes('const refused = dialogue.renameSpeaker(id, newLabel)') && w.includes('if (refused) return refused'))
  assert.ok(w.indexOf('dialogue.renameSpeaker(') < w.indexOf('moveSpeakerRef(id, toId)'), '원문 변경 성공 뒤에 슬롯 이동')
  assert.ok(w.includes('setSpeakerLabel(toId, newLabel.trim())'))
  assert.equal(/voiceCast\.renameSpeaker|renameSpeakerInCasts/.test(SHELL), false, '저장 구성 전체 순회 변경 없음')
  assert.equal(CAST.includes('renameSpeakerInCasts') || CAST.includes('renameSpeaker:'), false, '훅에도 없음')
  assert.equal(REGISTRY.includes('renameSpeakerInCasts'), false, '등록부에도 없음')
  // 고급 원문 편집(표기 직접 수정)은 다른 동작 — 슬롯을 옮기지 않는다.
  const raw = between(SHELL, 'const onSingleEditorChange = (next: string) => {', '\n  }\n')
  assert.equal(raw.includes('moveSpeakerRef'), false)
  assert.ok(raw.includes('setStructureNotice('))
})

test('정체성 유지: 저장 구성은 별칭으로 읽는다 — 감정별 참조는 현재 id 로 옮겨 읽고, 후보 편집기·추가는 구성 안의 원래 id 로', () => {
  assert.ok(SHELL.includes('applySpeakerRenames(toSpeakerEmotionRefs(reg, active.selections, {}, () => undefined), ttsSpeakerRenames)'))
  assert.ok(SHELL.includes('speakerId={castSpeakerIdOf(ttsSpeakerRenames, id)} speakerLabel={label}'))
  assert.ok(STORE.includes('ttsSpeakerRenames: Record<string, string>'))
  assert.ok(STORE.includes('export function castSpeakerIdOf(') && STORE.includes('export function applySpeakerRenames('))
  const m = between(STORE, 'moveSpeakerRef: (fromId, toId) => {', '\n  },\n')
  assert.ok(m.includes("renameReferenceClip?.('spk:' + fromId, 'spk:' + toId)"), '클립 key 이동(파일 이동 없음)')
  assert.ok(m.includes('refs[toId] = slot') && m.includes('ttsSpeakerEmotionRefs: rekey(s.ttsSpeakerEmotionRefs)') && m.includes('ttsEmotionCandidateSelections: rekey(s.ttsEmotionCandidateSelections)'))
  assert.ok(m.includes("const origin = Object.keys(renames).find((k) => renames[k] === fromId) ?? fromId"), '별칭은 원래 id 를 따라간다')
  assert.ok((STORE.match(/ttsSpeakerRenames: \{\}/g) ?? []).length >= 3, '기본·setFile·reset 에서 비운다')
})

test('훅·패처: renameSpeaker 는 좌표 의존 명령(guard)이며 patcher 명령 하나로 원문을 바꾼다', () => {
  const h = between(HOOK, 'const renameSpeaker = useCallback', '}, [')
  assert.ok(h.includes('guard()') && h.includes('renameSpeakerInSource(text, views, speakerId, newLabel)'))
  assert.ok(HOOK.includes('renameSpeaker: (speakerId: string, newLabel: string) => string | null'))
})
