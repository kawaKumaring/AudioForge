// 더빙에서 고친 번역문이 **떠날 때도** 남는가.
//
// ★3차 감사에서 내가 낸 결함을 찾았다(2026-09-25).
//   고친 문장을 0.5초 뒤에 쌓도록 만들어 놨는데, 화면을 떠날 때는 **타이머만 지웠다.**
//   그래서 마지막 글자를 친 뒤 0.5초 안에 탭을 바꾸거나 영상을 바꾸면 그 편집이
//   사라졌다 — 사이드카를 만든 이유가 "저장 단추를 누르기 전에 잃지 않기" 인데
//   **그 창이 0.5초 남아 있었다.**
//
//   구멍을 막는 것보다 중요한 것은, 같은 구멍이 다시 생기지 않게 하는 것이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(HERE, 'DubWorkspace.tsx'), 'utf-8')

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
const code = SRC.split(/\r?\n/)
  .filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

test('고치는 즉시 쌓는 자리가 있다', () => {
  assert.ok(code.includes('saveEdits('), '고친 번역문을 쌓는 통로가 없다')
})

test('떠날 때 **대기 중인 것을 보낸다** — 타이머만 지우고 끝내지 않는다', () => {
  // 언마운트 전용 효과(빈 의존성)에서 한 번 더 보내야 한다.
  const at = code.indexOf('useEffect(() => () =>')
  assert.ok(at > 0, '언마운트 때 도는 자리가 없다 — 마지막 0.5초가 사라진다')
  const block = code.slice(at, at + 400)
  assert.ok(block.includes('saveEdits('),
    '떠나면서 대기 중인 편집을 보내지 않는다')
  assert.ok(block.includes('editsRef'),
    '떠나는 시점의 최신 값을 읽지 않는다 — 옛 값을 보내면 뜻이 없다')
})

// ★언마운트 시점에는 결과를 보여 줄 화면이 없다. 그래서 여기서만 버린다 —
//   그 사실을 주석으로 적어 두는 것까지가 계약이다(다음 사람이 흉내 내지 않게).
test('결과를 버리는 자리에 그 이유가 적혀 있다', () => {
  const at = SRC.indexOf('useEffect(() => () =>')
  const before = SRC.slice(Math.max(0, at - 600), at)
  assert.ok(before.includes('보여 줄 자리가 없는 것'),
    '왜 결과를 버리는지 적혀 있지 않다 — 다음 사람이 아무 데서나 버린다')
})

// ★쌓는 것과 저장 단추는 다른 일이다. 저장 단추가 사라지면 파이썬이 읽는 파일이
//   갱신되지 않아, 화면에는 고친 것이 보이는데 영상에는 옛 문장이 실린다.
test('저장 단추는 그대로 있다', () => {
  assert.ok(code.includes('saveKorean('), '번역문 저장 통로가 사라졌다')
  assert.ok(SRC.includes('dub-cancel'), '멈추기 단추가 사라졌다')
})
