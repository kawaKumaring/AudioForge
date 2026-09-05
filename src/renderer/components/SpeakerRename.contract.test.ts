// 인물 이름 변경 계약 — 카드 상세의 '이름 바꾸기' 는 원문 표기·목소리 슬롯(확정 구간)·감정별 설정·목소리 구성을 함께 옮긴다.
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
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)) }

test('카드 상세에 이름 바꾸기가 있고, 거부 코드를 그대로 안내한다(자동 병합 없음)', () => {
  const panel = between(MULTI, 'function SpeakerVoicePanel(', '\n}\n')
  for (const id of ['speaker-rename-toggle', 'speaker-rename-input', 'speaker-rename-apply', 'speaker-rename-problem']) assert.ok(panel.includes(`data-testid="${id}"`), id)
  assert.ok(panel.includes('const refused = props.onRenameSpeaker(next)') && panel.includes('setRenameProblem(REFUSAL_LABEL[refused] ?? refused)'))
  assert.ok(panel.includes('이 인물의 모든 대사와 목소리·구간·감정별 설정이 새 이름으로 함께 유지됩니다.'))
  assert.ok(MULTI.includes("SPEAKER_LABEL_DUPLICATE: '같은 이름의 인물이 이미 있습니다. 기존 인물을 고르거나 다른 이름을 쓰세요'"))
  // 시작 카드(원문에 없는 인물)는 이름 입력이 따로 있으므로 상세의 이름 바꾸기는 원문에 있는 인물 카드에서만 넘긴다.
  assert.ok(MULTI.includes('onRenameSpeaker={props.onRenameSpeaker ? ((label) => props.onRenameSpeaker!(sid, label)) : undefined}'))
})

test('셸: 원문 표기 일괄 변경이 성공했을 때만 슬롯·이름·감정별 설정·목소리 구성을 새 id 로 옮긴다', () => {
  const w = between(SHELL, 'onRenameSpeaker={(id, newLabel) => {', '}}\n')
  assert.ok(w.includes("return 'SPEAKER_LABEL_DUPLICATE'"), '다른 인물(원문·시작 카드·슬롯)과 충돌하면 거부')
  assert.ok(w.includes('const refused = dialogue.renameSpeaker(id, newLabel)') && w.includes('if (refused) return refused'))
  assert.ok(w.indexOf('dialogue.renameSpeaker(') < w.indexOf('moveSpeakerRef(id, toId)'), '원문 변경 성공 뒤에 슬롯 이동')
  assert.ok(w.includes('void voiceCast.renameSpeaker(id, toId)') && w.includes('setSpeakerLabel(toId, newLabel.trim())'))
  // 고급 원문 편집(표기 직접 수정)은 다른 동작 — 슬롯을 옮기지 않는다.
  const raw = between(SHELL, 'const onSingleEditorChange = (next: string) => {', '\n  }\n')
  assert.equal(raw.includes('moveSpeakerRef'), false)
  assert.ok(raw.includes('setStructureNotice('))
})

test('훅·패처: renameSpeaker 는 좌표 의존 명령(guard)이며 patcher 명령 하나로 원문을 바꾼다', () => {
  const h = between(HOOK, 'const renameSpeaker = useCallback', '}, [')
  assert.ok(h.includes('guard()') && h.includes('renameSpeakerInSource(text, views, speakerId, newLabel)'))
  assert.ok(HOOK.includes('renameSpeaker: (speakerId: string, newLabel: string) => string | null'))
})

test('store·목소리 구성: 슬롯 이동이 확정 구간·이어받기 플래그·감정별 참조 키·후보 선택·배역 후보를 함께 옮긴다', () => {
  const m = between(STORE, 'moveSpeakerRef: (fromId, toId) => {', '\n  },\n')
  assert.ok(m.includes("renameReferenceClip?.('spk:' + fromId, 'spk:' + toId)"), '클립 key 이동(파일 이동 없음)')
  assert.ok(m.includes('refs[toId] = slot') && m.includes('ttsSpeakerEmotionRefs: rekey(s.ttsSpeakerEmotionRefs)') && m.includes('ttsEmotionCandidateSelections: rekey(s.ttsEmotionCandidateSelections)'))
  assert.ok(m.includes('speakerId: toId } : s.ttsSpeakerInherit'))
  assert.ok(STORE.includes('setSpeakerLabel: (speakerId, label) => set('))
  assert.ok(CAST.includes('renameSpeakerInCasts(casts, fromId, toId, nowIso(), samplerSha256Hex)') && CAST.includes('if (res.refused) return res.refused'))
})
