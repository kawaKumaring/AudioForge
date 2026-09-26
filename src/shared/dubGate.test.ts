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
//
// ★판정을 만들어 놓고 안 부르면 아무것도 달라지지 않는다. 그래서 화면 코드를 읽어 본다.
//
// ★★검사에 이빨이 있는지 확인하는 방법을 바꿨다(2026-09-25, 내가 낸 사고).
//   예전에는 **실제 소스 파일을 일부러 깨뜨렸다가 되돌려** 검사가 우는지 봤다.
//   그런데 그 순간 개발 서버가 그 파일을 사용자 앱에 물고 있었다 —
//   **사용자가 쓰던 창이 그때마다 망가졌다.** 실제로 두 번 망가뜨렸다.
//   그래서 지금은 **읽은 글자만 검사하는 순수 함수**로 바꿨다.
//   진짜 소스에는 통과를, 일부러 만든 나쁜 본보기에는 실패를 요구한다 —
//   **파일을 건드리지 않고** 이빨을 확인한다.

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
const codeOf = (text: string): string =>
  text.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

/**
 * 화면 코드가 이유를 제대로 쓰고 그리는가. 어긋난 곳의 이름을 돌려준다.
 *
 * ★주석을 먼저 걷어낸다(2026-09-26). 이 저장소에서 **세 번째** 같은 실수다 —
 *   나중에 붙인 주석에 단추 이름이 들어가자, 검사가 그 주석을 단추로 착각해
 *   멀쩡한 코드를 실패로 몰았다. **잘못 잡는 가드는 결국 꺼진다.**
 */
export function screenFaults(raw: string): string[] {
  const text = codeOf(raw)
  const bad: string[] = []
  if (!text.includes('useOriginalBlockReason(')) bad.push('판정을 부르지 않는다')
  if (text.includes('canUseOriginal')) bad.push('이유 없는 참·거짓 잠금이 되살아났다')
  if (!text.includes('DUB_RESUME_HINT')) bad.push('되살리는 안내를 쓰지 않는다')
  // ★이름표가 아니라 **계약**에 맨다(2026-09-26, 네 번째 같은 실수를 막는다).
  //   단추 글자는 언제든 바뀐다 — 실제로 화면을 단계로 다시 짜면서 바뀌었다.
  //   지켜야 할 것은 '영상 속 목소리를 쓰는 길 옆에 이유가 글자로 있다' 이다.
  // ★'첫 번째 자리' 를 집지 않는다. 부르는 곳과 그리는 곳이 둘 다 같은 이름을 쓴다 —
  //   첫 하나만 보면 부르는 곳을 집어 멀쩡한 화면을 실패로 몬다(이 저장소의 오랜 함정).
  const spots: number[] = []
  for (let i = text.indexOf('onUseOriginal'); i >= 0; i = text.indexOf('onUseOriginal', i + 1)) spots.push(i)
  if (spots.length === 0) bad.push('영상 속 목소리를 쓰는 길이 없다')
  else if (!spots.some((i) => text.slice(i, i + 400).includes('{props.useOriginalReason}'))) {
    bad.push('이유를 글자로 띄우지 않는다 — 흐릿한 단추만 남는다')
  }
  return bad
}

const SCREEN = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'renderer', 'components', 'DubWorkspace.tsx'), 'utf-8')

test('지금 화면 코드는 이유를 부르고, 그리고, 되살리는 길을 말한다', () => {
  assert.deepEqual(screenFaults(SCREEN), [])
})

// ★이빨 확인 — 파일을 건드리지 않는다.
test('예전 모습이었다면 검사가 운다', () => {
  const 옛모습 = [
    '        canUseOriginal={!!front}',
    '      <Btn onClick={props.onUseOriginal} disabled={props.disabled || !props.canUseOriginal}>',
    '        영상 속 목소리 쓰기',
    '      </Btn>',
  ].join(String.fromCharCode(10))
  const bad = screenFaults(옛모습)
  assert.ok(bad.length >= 3, `예전 모습을 그냥 통과시킨다: ${JSON.stringify(bad)}`)
})

test('이유를 만들어만 놓고 안 그리면 운다', () => {
  // 앞쪽 title= 자리에도 같은 글자가 있어 첫 하나만 바꾸면 안 된다 — 전부 바꾼다.
  const 반쪽 = SCREEN.split('{props.useOriginalReason}').join('{null}')
  assert.ok(screenFaults(반쪽).some((b) => b.includes('글자로')),
    '도움말 풍선만 남아도 통과시킨다')
})

test('되살리는 안내를 빼면 운다', () => {
  assert.ok(screenFaults(SCREEN.split('DUB_RESUME_HINT').join('X')).length > 0)
})

test('되살리는 문구에 방법이 들어 있다', () => {
  assert.ok(DUB_RESUME_HINT.includes('다시 고르면'), '되살리는 방법이 문구에 없다')
})
