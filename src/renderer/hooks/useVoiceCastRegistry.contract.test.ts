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
//   이 저장소에서 같은 실수를 네 번째 하는 것이라, 정규식으로 어림잡지 않고
//   **문제의 자리를 정확히 떼어 내서** 본다.
//
// ★★이빨 확인 방식도 바꿨다(2026-09-25, 내가 낸 사고).
//   검사가 진짜로 잡는지 보겠다고 **실제 소스를 깨뜨렸다 되돌렸다.**
//   그때 개발 서버가 그 파일을 사용자 앱에 물고 있어서 **쓰던 창이 망가졌다.**
//   지금은 읽은 글자만 보는 순수 함수라, 파일을 건드리지 않고 확인한다.

/** 사유를 모으는 쪽(갈고리)이 제대로 되어 있는가. 어긋난 곳 이름을 돌려준다. */
export function hookFaults(text: string): string[] {
  const code = codeOf(text)
  const bad: string[] = []
  const at = code.indexOf('failed++')
  if (at < 0) return ['failed++ 를 못 찾았다 — 검사가 눈이 멀었다']
  const open = code.lastIndexOf('catch', at)
  if (open < 0 || at - open > 400) return ['failed++ 를 감싸는 catch 를 못 찾았다']
  const blk = code.slice(open, at + 300)
  if (!/catch\s*\(/.test(blk)) bad.push('사유 없는 catch 로 실패를 삼킨다')
  const push = blk.indexOf('reasons.push(')
  if (push < 0) bad.push('사유를 모으지 않는다')
  else {
    if (!blk.slice(push, push + 120).includes('baseName(')) {
      bad.push('사유에 폴더 경로가 들어간다 — 경로는 개인정보다')
    }
    // catch 안에서 반복을 끊으면 뒤 파일이 등록되지 않는다.
    const inner = blk.slice(0, blk.indexOf('}', push))
    for (const stop of ['break', 'throw', 'return']) {
      if (inner.includes(stop)) bad.push(`catch 에서 ${stop} 하면 나머지 파일이 등록되지 않는다`)
    }
  }
  return bad
}

/** 화면 쪽이 그 사유를 실제로 받아 말하는가. */
export function screenFaults(text: string): string[] {
  const code = codeOf(text)
  const bad: string[] = []
  const at = code.indexOf('addCandidateFiles(')
  if (at < 0) return ['후보 넣기 호출을 못 찾았다 — 검사가 눈이 멀었다']
  const NLc = String.fromCharCode(10)
  const line = code.slice(code.lastIndexOf(NLc, at) + 1, code.indexOf(NLc, at))
  if (!/=\s*await\s+voiceCast\.addCandidateFiles\(/.test(line)) {
    bad.push(`반환을 받지 않는다: ${line.trim().slice(0, 60)}`)
  }
  const after = code.slice(at, at + 400)
  if (!after.includes('.failed')) bad.push('실패 수를 보지 않는다')
  if (!after.includes('.reasons')) bad.push('사유를 화면에 올리지 않는다')
  if (!after.includes('setRefAssetNotice(')) bad.push('알림 자리로 보내지 않는다')
  return bad
}

test('지금 갈고리는 사유를 이름만 담아 모은다', () => {
  assert.deepEqual(hookFaults(HOOK), [])
})

test('지금 화면은 그 사유를 받아 말한다', () => {
  assert.deepEqual(screenFaults(SCREEN), [])
})

// ★이빨 확인 — 파일을 건드리지 않는다.
test('사유를 버리던 예전 모습이었다면 운다', () => {
  const 옛 = 'for (const p of paths) {' + String.fromCharCode(10)
    + '  try { add(p); added++ } catch { failed++ }' + String.fromCharCode(10) + '}'
  const bad = hookFaults(옛)
  assert.ok(bad.some((b) => b.includes('삼킨다')), `예전 모습을 통과시킨다: ${JSON.stringify(bad)}`)
})

test('사유에 전체 경로를 실으면 운다', () => {
  const 샘 = HOOK.split('baseName(path)').join('(path)')
  assert.ok(hookFaults(샘).some((b) => b.includes('개인정보')), '경로가 새도 통과시킨다')
})

test('한 파일 실패에 반복을 끊으면 운다', () => {
  const 끊김 = HOOK.split('reasons.push(').join('break; reasons.push(')
  assert.ok(hookFaults(끊김).some((b) => b.includes('break')), '나머지를 버려도 통과시킨다')
})

test('반환을 통째로 버리던 예전 모습이었다면 운다', () => {
  const 옛 = '      await voiceCast.addCandidateFiles(castId, s, e, paths)'
  const bad = screenFaults(옛)
  assert.ok(bad.length >= 3, `반환을 버리는데 통과시킨다: ${JSON.stringify(bad)}`)
})


test('활성 배역은 화면 로컬 상태가 아니라 작업 store를 읽는다', () => {
  assert.ok(HOOK.includes('useAppStore((s) => s.activeVoiceCastId)'))
  assert.ok(HOOK.includes('useAppStore((s) => s.setActiveVoiceCast)'))
  assert.equal(HOOK.includes('const [activeVoiceCastId, setActive] = useState'), false)
})
