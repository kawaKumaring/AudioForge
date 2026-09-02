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
