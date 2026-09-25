// 목소리 후보를 넣다 실패했을 때 **왜 실패했는지가 화면까지 가는가.**
//
// ★왜(2026-09-25 실사용에서 드러남)
//   사용자가 "테스트를 해 보는데 화면에도 터미널에도 변화가 없어 되는 건지 아닌지
//   알 수가 없다" 고 했다. 기록을 보니 실제로 실패가 있었다 —
//   `참조 파일을 찾을 수 없습니다: speaker_b.wav`.
//
//   그 사유가 **두 겹으로** 사라지고 있었다.
//     1. `catch { failed++ }` — 사유를 버리고 개수만 셌다
//     2. 호출부가 `await ...addCandidateFiles(...)` 로 **반환을 통째로 버렸다**
//   그래서 파일이 그냥 목록에 안 나타날 뿐, 화면이 한 글자도 말하지 않았다.
//
//   이 저장소가 반복해서 데인 바로 그 부류다 — **약속을 버린다.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = readFileSync(path.join(HERE, 'useVoiceCastRegistry.ts'), 'utf-8')
const SCREEN = readFileSync(
  path.resolve(HERE, '..', 'components', 'TTSEditor.tsx'), 'utf-8')

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
const codeOf = (text: string): string =>
  text.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

// ★검사를 처음 썼을 때 **셋 다 잘못 잡았다**(코드는 맞는데 정규식이 엉성했다).
//   이 저장소에서 같은 실수를 네 번째 하는 것이라, 여기서는 정규식으로 어림잡지 않고
//   **문제의 자리를 정확히 떼어 내서** 본다.

/** `failed++` 를 감싸는 catch 블록만 떼어 낸다. */
function failCatchBlock(): string {
  const code = codeOf(HOOK)
  const at = code.indexOf('failed++')
  assert.ok(at > 0, 'failed++ 를 못 찾았다 — 검사가 눈이 멀었다')
  const open = code.lastIndexOf('catch', at)
  assert.ok(open > 0 && at - open < 400, 'failed++ 를 감싸는 catch 를 못 찾았다')
  return code.slice(open, at + 300)
}

test('실패 사유를 버리지 않는다', () => {
  const blk = failCatchBlock()
  assert.match(blk, /catch\s*\(/, '사유 없는 catch 로 실패를 삼킨다')
  assert.ok(blk.includes('reasons.push('), '사유를 모으지 않는다')
})

test('사유에 폴더 경로를 싣지 않는다 — 이름만', () => {
  const blk = failCatchBlock()
  const at = blk.indexOf('reasons.push(')
  const line = blk.slice(at, at + 120)
  assert.ok(line.includes('baseName('), `사유에 전체 경로가 들어간다: ${line.slice(0, 60)}`)
})

// ★모아 두고 **안 쓰면** 아무것도 달라지지 않는다. 이것이 두 번째 겹이었다.
test('화면이 그 결과를 실제로 받는다', () => {
  const code = codeOf(SCREEN)
  const at = code.indexOf('addCandidateFiles(')
  assert.ok(at > 0, '후보 넣기 호출을 못 찾았다 — 검사가 눈이 멀었다')
  // 그 호출이 들어 있는 **한 줄**만 본다.
  const NL = String.fromCharCode(10)
  const from = code.lastIndexOf(NL, at) + 1
  const line = code.slice(from, code.indexOf(NL, at))
  assert.match(line, /=\s*await\s+voiceCast\.addCandidateFiles\(/,
    `반환을 받지 않는다: ${line.trim()}`)
})

test('실패가 있으면 화면이 말한다', () => {
  const code = codeOf(SCREEN)
  const at = code.indexOf('addCandidateFiles(')
  const after = code.slice(at, at + 400)
  assert.ok(after.includes('.failed'), '실패 수를 보지 않는다')
  assert.ok(after.includes('.reasons'), '사유를 화면에 올리지 않는다')
  assert.ok(after.includes('setRefAssetNotice('), '알림 자리로 보내지 않는다')
})

// ★한 파일이 실패해도 나머지는 등록돼야 한다 — 회피성 단순화를 막는다.
test('한 파일이 실패해도 나머지는 계속 넣는다', () => {
  const blk = failCatchBlock()
  // catch 안에서 반복을 끊으면 뒤 파일이 등록되지 않는다.
  const inner = blk.slice(0, blk.indexOf('}', blk.indexOf('reasons.push(')))
  for (const stop of ['break', 'throw', 'return']) {
    assert.ok(!inner.includes(stop), `catch 에서 ${stop} 하면 나머지 파일이 등록되지 않는다`)
  }
})
