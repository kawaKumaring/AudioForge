// 대사 분석 패널은 **계획을 보여 주기만 한다** — 소스 계약으로 그것을 고정한다.
//
// 왜 소스를 읽어 검사하나
// -----------------------
// 화면이 자기 계산을 갖는 순간 화면과 생성 결과가 갈라진다. 문단을 다시 세거나 대본을 다시
// 나누는 코드가 들어오면 그날은 아무 테스트도 깨지지 않고, 어긋난 숫자를 사용자가 먼저 본다.
// 그래서 렌더 결과가 아니라 **그런 코드가 있는지**를 본다(`useInputAnalysis.contract.test.ts`
// 와 같은 방식이다).
//
// 문구·계산 자체는 `analysisWording` 의 순수 함수 테스트가 검증한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('./InputAnalysisPanel.tsx', import.meta.url)), 'utf-8')

/** 주석은 검사에서 뺀다 — 금지 이유를 주석에 적는 것까지 막으면 근거를 남길 수 없다. */
const CODE = SRC.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

test('패널이 대본을 다시 해석하지 않는다', () => {
  for (const forbidden of ['parseTtsScript', 'ttsGrammar', 'normalizeLineEndings']) {
    assert.equal(CODE.includes(forbidden), false,
      `파서를 화면에서 다시 부르면 계획이 둘이 된다: ${forbidden}`)
  }
})

test('패널이 대본을 다시 나누거나 세지 않는다', () => {
  // 원문에서 허용되는 연산은 미리보기용 slice 하나뿐이다.
  assert.equal(/sourceText\s*\.\s*split/.test(CODE), false, '줄을 다시 나누면 안 된다')
  assert.equal(/sourceText\s*\.\s*match/.test(CODE), false, '정규식으로 훑으면 안 된다')
  assert.equal(/sourceText\s*\.\s*indexOf/.test(CODE), false, '좌표를 다시 찾으면 안 된다')
  const uses = CODE.match(/sourceText\s*\.\s*\w+/g) ?? []
  for (const u of uses) {
    assert.match(u, /sourceText\s*\.\s*slice/, `원문에 허용된 것은 slice 뿐이다: ${u}`)
  }
})

test('개수는 계획의 배열에서 나온다 — 화면이 다시 세지 않는다', () => {
  // 세 축의 개수·발화 묶음 수·감정 구간은 모두 analysisWording 의 순수 함수가 만든다.
  for (const fn of ['axisRelationLine', 'utteranceRows', 'emotionSpanRows', 'planWarningRows']) {
    assert.ok(CODE.includes(fn), `${fn} 를 써야 한다(화면에서 직접 계산하면 안 된다)`)
  }
  // 계획 배열을 화면에서 걸러 세면 그것이 곧 두 번째 계산이다.
  assert.equal(/plan\s*\.\s*(utterances|chunks|emotions|warnings)\s*\.\s*(filter|reduce)/
    .test(CODE), false, '집계는 wording 모듈이 소유한다')
})

test('PHASE 3 이 요구한 다섯 가지가 화면에 있다', () => {
  const required: [string, string][] = [
    ['analysis-structure', '문단·발화·생성 묶음의 관계'],
    ['analysis-utterances', '문단 아래의 발화'],
    ['analysis-emotions', '감정 구간'],
    ['analysis-splits', '실제 자동 분할 경계'],
    ['analysis-plan-warnings', '구조화 경고와 원문 위치'],
    ['analysis-reserved-axes', '앞으로 지시가 들어갈 자리'],
  ]
  for (const [testid, what] of required) {
    assert.ok(CODE.includes(`"${testid}"`), `${what} 가 없다: ${testid}`)
  }
})

test('화자 표시도 계획이 센 값을 읽는다', () => {
  assert.ok(CODE.includes('speakerRows'), '등장 인물 목록은 wording 이 만든다')
  assert.ok(CODE.includes('defaultSpeakerUtteranceCount'), '기본 화자 발화 수도 마찬가지다')
  assert.ok(CODE.includes('"analysis-speakers"'), '등장 인물 영역이 있어야 한다')
  assert.ok(CODE.includes('"analysis-utterance-speaker"'), '발화마다 화자가 보여야 한다')
  // 참조 준비 상태를 화면이 지어내지 않는다 — PHASE 2 에는 화자별 참조가 없다.
  assert.ok(CODE.includes('SPEAKER_REFERENCE_NOTE'))
  assert.equal(/registerSpeakerRef|ttsSpeakerRefs/.test(CODE), false,
    '읽기 전용 단계에서 참조를 고르는 경로를 만들지 않는다')
  // 화자 집계를 화면에서 다시 하면 그것이 곧 두 번째 계산이다.
  assert.equal(/plan\s*\.\s*speakers\s*\.\s*(filter|reduce)/.test(CODE), false)
})

test('아직 없는 축은 상세 정보 안에만 있다', () => {
  // 기본 화면에 값 0 여섯 개를 항상 늘어놓으면 지금 쓰는 숫자가 그만큼 뒤로 밀린다.
  // 판정은 사용자 것이고, 여기서는 그 자리가 지켜지는지만 본다.
  const detailAt = CODE.indexOf('function DetailBlock')
  assert.ok(detailAt > 0, 'DetailBlock 이 있어야 한다')
  const main = CODE.slice(0, detailAt)
  const detail = CODE.slice(detailAt)
  assert.equal(main.includes('<ReservedAxisList'), false, '기본 화면에 두지 않는다')
  assert.ok(detail.includes('<ReservedAxisList'), '상세 정보 안에 있어야 한다')
})

test('차단 오류와 비차단 경고를 갈라 그린다', () => {
  // 이름(오류/경고)과 색을 모두 다르게 한다 — 색만으로 가르면 색을 구분하기 어려운
  // 사용자에게는 아무 차이가 없다. 판정 자체는 wording 이 소유한다(화면이 정하지 않는다).
  assert.ok(CODE.includes('data-blocking'), '행마다 차단 여부를 남겨야 한다')
  assert.ok(CODE.includes('w.kindLabel'), '이름은 wording 이 준 것을 쓴다')
  assert.equal(/['"`]오류['"`]/.test(CODE), false, '화면에 이름을 하드코딩하면 출처가 둘이 된다')
  assert.ok(CODE.includes('w.blocking ?'), '색도 차단 여부로 갈라야 한다')
  assert.ok(CODE.includes('planWarningNote'), '목록 아래 문구도 wording 이 소유한다')
})

test('경고는 합성을 막는 장치를 달지 않는다', () => {
  // 이 패널은 읽기 전용이다. 버튼을 잠그거나 합성 경로를 건드리는 코드가 있으면 안 된다.
  for (const forbidden of ['disabled=', 'canSynthesize', 'blockSynthesis', 'setText(']) {
    assert.equal(CODE.includes(forbidden), false, `읽기 전용을 벗어난다: ${forbidden}`)
  }
})

test('원문을 화면 밖으로 내보내지 않는다', () => {
  // 미리보기는 자기 textarea 값에서 잘라 그 자리에서 그린다. 로그·IPC 로 보내지 않는다.
  for (const forbidden of ['console.log', 'window.api?.log', 'invoke(']) {
    assert.equal(CODE.includes(forbidden), false, `대사가 밖으로 나갈 길: ${forbidden}`)
  }
})
