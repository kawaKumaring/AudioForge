// 더빙 화면이 **순서 있는 화면**인가.
//
// ★2026-09-26 신고: "최상단에 음원을 불렀다. 그리고 아래 영상과 목소리를 고르라고 강제한다.
//   그리고 영상 속 목소리 쓰기는 버튼이 똑같아서 식별도 안 된다.
//   구조적으로 이게 대체 뭘 하려는건지 근본없이 누더기처럼 붙여놨다."
//
//   단추를 평평하게 깔면 화면이 순서를 말하지 않는다. 그러면 잠긴 단추가 고장으로 읽힌다 —
//   실제로 "영상 속 목소리 쓰기를 하지 못한다" 는 신고가 그렇게 나왔다.
//
// ★이 검사는 **계약**에 맨다. 단추 글자·자리·색이 아니라
//   "순서를 화면 밖에서 가져온다 / 두 길을 다르게 설명한다 / 다섯 단계를 다 그린다" 만 본다.
//   글자에 매는 가드는 이름 하나 바뀔 때마다 멀쩡한 코드를 실패로 몬다(이 저장소에서 네 번).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(HERE, 'DubWorkspace.tsx'), 'utf-8')

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
function codeOf(raw: string): string {
  return raw.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
}

/** 어긋난 곳의 이름. 비면 성하다. */
export function stepFaults(raw: string): string[] {
  const text = codeOf(raw)
  const bad: string[] = []
  if (!text.includes('dubSteps(')) bad.push('순서를 화면이 스스로 판단한다')
  for (const key of ['video', 'front', 'voice', 'synth', 'render']) {
    if (!text.includes(`stepOf('${key}')`)) bad.push(`${key} 단계를 그리지 않는다`)
  }
  // ★두 길이 **무엇이 다른지** 말해야 한다. 같은 모양 단추 둘로는 식별되지 않는다.
  if (!text.includes('DUB_ORIGINAL_VOICE_WHY')) bad.push('영상 속 목소리가 무엇인지 말하지 않는다')
  if (!text.includes('DUB_PICKED_VOICE_WHY')) bad.push('다른 목소리가 무엇인지 말하지 않는다')
  return bad
}

test('지금 화면은 순서를 밖에서 가져오고 다섯 단계를 다 그린다', () => {
  assert.deepEqual(stepFaults(SRC), [])
})

// ★이빨 확인 — 파일을 건드리지 않는다. 글자 조각으로만 본다.
test('평평한 단추 줄이었다면 검사가 운다', () => {
  const 옛모습 = [
    "      <Btn onClick={props.onPickVideo}>영상 고르기</Btn>",
    "      <Btn onClick={props.onPickVoice}>목소리 고르기</Btn>",
    "      <Btn onClick={props.onUseOriginal}>영상 속 목소리 쓰기</Btn>",
  ].join(String.fromCharCode(10))
  const bad = stepFaults(옛모습)
  assert.ok(bad.length >= 6, `평평한 줄을 그냥 통과시킨다: ${JSON.stringify(bad)}`)
})

test('두 길에 같은 설명을 달면 운다', () => {
  const 한쪽만 = SRC.split('DUB_PICKED_VOICE_WHY').join('DUB_ORIGINAL_VOICE_WHY')
  assert.ok(stepFaults(한쪽만).some((b) => b.includes('다른 목소리')),
    '두 길이 같은 말을 해도 통과시킨다')
})

// ★주석에 단계 이름을 적어 두었다고 통과하면 안 된다 — 같은 실수를 네 번 했다.
test('주석만으로는 통과하지 못한다', () => {
  const 주석뿐 = [
    "// dubSteps( 를 부른다",
    "// stepOf('video') stepOf('front') stepOf('voice') stepOf('synth') stepOf('render')",
    "// DUB_ORIGINAL_VOICE_WHY DUB_PICKED_VOICE_WHY",
  ].join(String.fromCharCode(10))
  assert.ok(stepFaults(주석뿐).length >= 6, '주석을 코드로 착각한다')
})
