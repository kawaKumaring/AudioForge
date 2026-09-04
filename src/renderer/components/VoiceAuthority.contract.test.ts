// 인물별 목소리의 단일 권위 — 편집 위치는 여러 명 화면의 인물/발화 카드 하나뿐이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(here(rel), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

const SHELL = codeOf(read('./TTSEditor.tsx'))
const MULTI = codeOf(read('./MultiSpeakerDialogue.tsx'))
const CAST = codeOf(read('./VoiceCastManager.tsx'))

test('고급 설정에는 인물별 목소리 편집 UI 가 없고 읽기 전용 안내만 있다', () => {
  assert.equal(SHELL.includes('<SpeakerReferenceManager'), false, '중복 편집기 제거')
  assert.equal(existsSync(here('./SpeakerReferenceManager.tsx')), false, '컴포넌트 파일 폐기')
  assert.ok(SHELL.includes('data-testid="speaker-voice-elsewhere"'))
  assert.ok(SHELL.includes('인물별 목소리는 여러 명 화면의 각 인물 카드에서 설정합니다.'))
  // 목소리 구성 관리자는 구성 만들기/적용/저장만 — 인물별 후보 편집은 그리지 않는다.
  assert.ok(SHELL.includes('hideSpeakerCandidates'))
  assert.ok(CAST.includes('props.hideSpeakerCandidates ?'))
  assert.ok(CAST.includes('data-testid="voice-cast-speakers-elsewhere"'))
})

test('감정별 목소리 후보는 인물 카드 패널의 접힌 상세에서만 편집한다', () => {
  assert.ok(MULTI.includes('renderEmotionVoiceEditor?: (speakerId: string, label: string) => ReactNode'))
  assert.ok(MULTI.includes('data-testid="emotion-voice-toggle"') && MULTI.includes('data-testid="emotion-voice-editor"'))
  assert.ok(MULTI.includes("'감정별 목소리 후보 (고급)'"))
  assert.ok(SHELL.includes('renderEmotionVoiceEditor={(id, label) => {'))
  assert.ok(SHELL.includes('<SpeakerEmotionCandidates'))
  assert.ok(SHELL.includes('data-testid="emotion-voice-needs-config"'))
  // 같은 store 콜백(voiceCast registry) — 두 번째 저장소 없음.
  assert.ok(SHELL.includes('void voiceCast.selectCandidate(active.voiceCastId, sid, eid, choice)'))
})

test('내부 권위 하나 — 카드 표시·준비·전송·판정이 같은 슬롯에서 파생된다', () => {
  assert.ok(SHELL.includes('const speakerReadiness = readinessFromSlots({'))
  assert.ok(SHELL.includes('speakerSlots: ttsSpeakerRefState'))
  const PB = codeOf(read('./ProcessButton.tsx'))
  assert.ok(PB.includes('for (const [id, slot] of Object.entries(ttsSpeakerRefState))'), '전송도 같은 슬롯')
  assert.ok(PB.includes('readinessFromSlots({'), 'preflight 도 같은 함수')
})
