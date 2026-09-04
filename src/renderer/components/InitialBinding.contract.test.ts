// 여러 명 1번 인물의 초기 목소리 binding 계약 — 소스를 읽어 고정한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const SHELL = codeOf(read('./TTSEditor.tsx'))
const HOOK = codeOf(read('../hooks/useDialogueProjection.ts'))
const MULTI = codeOf(read('./MultiSpeakerDialogue.tsx'))

const i = SHELL.indexOf('const initialSpeakerBind = useRef')
const block = SHELL.slice(i, SHELL.indexOf('const requestSpeakerSource', i))

test('1번 인물은 처음 불러온 음성에 명시적 binding — store 슬롯을 실제로 만든다(화면 상속 아님)', () => {
  assert.ok(i > 0)
  assert.ok(block.includes("if (ttsSpeakerMode !== 'multi' || !fileInfo?.path) return"), '여러 명 모드에서만')
  assert.ok(block.includes('registerSpeakerRef(first.speakerId, fileInfo.path, first.label)'), '같은 canonical asset 에 슬롯 생성')
  assert.ok(block.includes('setSpeakerRefState(first.speakerId, {'), '준비 상태도 슬롯에')
  // 파일·클립 복사 없음, 기본 목소리의 임시 클립 경로 공유 없음.
  for (const forbidden of ['copyFile', 'selectFile', 'clip: ttsReferenceClip', 'trimReference']) {
    assert.equal(block.includes(forbidden), false, forbidden)
  }
  assert.ok(block.includes("clip: ''"))
})

test('초기 binding 은 아무 인물도 목소리가 없을 때 한 번만 — 이후 한 명/여러 명은 독립, 2번 이후 자동 연결 없음', () => {
  assert.ok(block.includes('if (Object.keys(ttsSpeakerRefState).length > 0) return'), '이미 지정이 있으면 개입하지 않음')
  assert.ok(block.includes('const first = speakerUiRows[0]'), '1번 인물만')
  assert.ok(block.includes('initialSpeakerBind.current === key'), '한 파일·한 인물 id 당 한 번')
  // 기본 목소리 변경(setFile) 은 새 작업이라 슬롯이 비고, 여러 명 1번 목소리 변경은 registerSpeakerRef 만 부른다 —
  // 기본 목소리(ttsReferenceClip/ttsRefReady) 를 쓰는 코드가 이 블록 밖 인물 경로에 없다.
  assert.equal(/setTtsRefState\(|setFile\(/.test(block), false, '초기 binding 이 기본 목소리를 바꾸지 않는다')
})

test('준비 규칙: 3~10초 통째로 유효 → 바로 준비됨, 10초 초과(구간 클립) → 구간 선택 필요, 대체 없음', () => {
  assert.ok(block.includes('const wholeValid = !!ttsRefReady && !ttsReferenceClip'))
  assert.ok(block.includes('ready: wholeValid'))
  assert.ok(block.includes("ttsReferenceClip ? '구간 선택 필요'"))
  for (const forbidden of ['global_default', 'fallback', '다른 인물']) assert.equal(block.includes(forbidden), false, forbidden)
})

test('여러 명 첫 진입은 시작 카드 1개(인물1) — 탭을 열기만 해서는 원문을 쓰지 않는다', () => {
  assert.ok(MULTI.includes('p.ensurePendingSpeakers(1)'))
  assert.ok(HOOK.includes('label: `인물${out.length + 1}`'), '이해 가능한 초기 이름')
  assert.ok(HOOK.includes('speakerId: nextPendingId(out)'), '내부 id 는 이름에서 파생하지 않는다')
  const j = HOOK.indexOf('const ensurePendingSpeakers')
  assert.equal(HOOK.slice(j, HOOK.indexOf('}, [])', j)).includes('setText('), false, '원문 쓰기 없음')
})
