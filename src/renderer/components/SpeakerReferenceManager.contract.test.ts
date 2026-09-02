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
import { referenceDecisionText } from '../../shared/analysisWording.ts'
import { REFERENCE_SOURCES, SPEAKER_REFERENCE_FAILURES } from '../../shared/speakerReference.ts'

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
