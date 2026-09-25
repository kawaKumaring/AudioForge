// 잠긴 단추가 **왜** 잠겼는지 말하는가.
//
// ★왜(2026-09-25 사용자 신고): "영상에 목소리 쓰기를 하지 못한다".
//   코드를 따라가 보니 기능은 멀쩡했다 — 앞단이 끝나야 쓸 수 있을 뿐이다.
//   그런데 화면은 **흐릿한 단추 하나**만 보여 주고 아무 말도 하지 않았다.
//   사용자 쪽에서 보면 "된다/안 된다" 밖에 없으니 "고장" 으로 읽힌다.
//
//   같은 날 목소리 후보 등록에서도 똑같은 일이 있었다(사유를 버렸다).
//   **되는 조건을 아는 쪽이 말을 안 하면, 모르는 쪽은 알 길이 없다.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useOriginalBlockReason, DUB_RESUME_HINT } from './dubGate.ts'

const S = (o: Partial<Parameters<typeof useOriginalBlockReason>[0]> = {}) =>
  ({ videoPath: '', frontLoaded: false, busy: false, ...o })

test('셋 다 갖추면 쓸 수 있다 — 괜한 잠금은 없다', () => {
  assert.equal(useOriginalBlockReason(S({ videoPath: 'a.mp4', frontLoaded: true })), '')
})

test('영상을 안 골랐으면 그것부터 말한다', () => {
  const r = useOriginalBlockReason(S())
  assert.ok(r.includes('영상'), `영상 이야기를 안 한다: ${r}`)
  assert.ok(!r.includes('앞단'), '순서를 건너뛴 안내는 길을 잃게 한다')
})

// ★이번 신고의 실제 자리.
test('앞단이 없으면 무엇을 해야 하는지 말한다', () => {
  const r = useOriginalBlockReason(S({ videoPath: 'a.mp4' }))
  assert.ok(r.includes('시작'), `눌러야 할 단추 이름이 없다: ${r}`)
  assert.ok(r.includes('갈라'), '왜 필요한지 말하지 않는다')
})

test('작업 중이면 고장이 아니라 기다리는 것이라고 말한다', () => {
  const r = useOriginalBlockReason(S({ videoPath: 'a.mp4', frontLoaded: true, busy: true }))
  assert.ok(r.includes('끝나면'), `기다리면 된다는 말이 없다: ${r}`)
})

test('어떤 경우에도 빈손으로 잠그지 않는다', () => {
  for (const v of ['', 'a.mp4']) {
    for (const f of [false, true]) {
      for (const b of [false, true]) {
        const r = useOriginalBlockReason({ videoPath: v, frontLoaded: f, busy: b })
        const usable = !!v && f && !b
        assert.equal(r === '', usable,
          `videoPath=${v} front=${f} busy=${b}: 잠겼는데 이유가 없거나, 멀쩡한데 잠갔다`)
      }
    }
  }
})

// ── 화면이 실제로 이것을 쓰는가 ──────────────────────────────────────────
// ★판정을 만들어 놓고 안 부르면 아무것도 달라지지 않는다.
const SCREEN = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'renderer', 'components', 'DubWorkspace.tsx'), 'utf-8')

test('화면이 그 판정을 부른다', () => {
  assert.ok(SCREEN.includes('useOriginalBlockReason('), '판정을 부르지 않는다')
})

test('이유를 눈에 보이게 그린다 — 도움말 풍선만으로는 모른다', () => {
  const at = SCREEN.indexOf('영상 속 목소리 쓰기')
  assert.ok(at > 0, '단추를 못 찾았다 — 검사가 눈이 멀었다')
  const near = SCREEN.slice(at, at + 400)
  assert.ok(near.includes('{props.useOriginalReason}'),
    '이유를 글자로 띄우지 않는다 — 흐릿한 단추만 남는다')
})

test('단추가 옛 방식으로 되돌아가지 않았다', () => {
  assert.ok(!SCREEN.includes('canUseOriginal'),
    '이유 없는 참·거짓 잠금이 되살아났다')
})

// ★다 해 놓은 앞단을 처음부터 다시 돌리게 두면 시간을 통째로 버린다.
test('되살리는 길을 화면이 알려 준다', () => {
  assert.ok(DUB_RESUME_HINT.includes('다시 고르면'), '되살리는 방법이 문구에 없다')
  assert.ok(SCREEN.includes('DUB_RESUME_HINT'), '화면이 그 안내를 쓰지 않는다')
})
