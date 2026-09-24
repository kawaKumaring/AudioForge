// 합성 전제 조건 목록의 계약 — **그리고 목록이 실제로 쓰이는지**까지 본다.
//
// ★왜(2026-09-24 2차 감사): 판정이 if 로 흩어져 있어서 파이썬을 새로 돌리는 길이
//   하나 늘었을 때 아무도 갱신하지 않았다. 목록을 모으는 것만으로는 부족하다 —
//   모아 두고 부르는 쪽이 옛 if 를 그대로 쓰면 같은 일이 또 생긴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUARDED, blockReason, type RunningState } from './synthesisGate.ts'

test('아무것도 안 돌면 막지 않는다', () => {
  assert.equal(blockReason({}), null)
})

test('도는 것마다 **무엇 때문인지** 말한다', () => {
  assert.match(blockReason({ mainRunner: true })!, /이미 처리 중/)
  assert.match(blockReason({ transcriptPreview: true })!, /참조 전사 미리보기/)
  assert.match(blockReason({ referenceTrim: true })!, /참조 구간 트림/)
  assert.match(blockReason({ samplerPreview: true })!, /미리듣기/)
  assert.match(blockReason({ dubJob: true })!, /더빙/)
})

test('시작하려는 일의 이름이 문구에 들어간다', () => {
  assert.match(blockReason({ samplerPreview: true }, '트랙 작업')!, /트랙 작업을 시작할 수 없습니다/)
})

test('여럿이 겹치면 하나만 말한다 — 화면에 사유를 쌓지 않는다', () => {
  const r = blockReason({ mainRunner: true, samplerPreview: true })
  assert.match(r!, /이미 처리 중/)
})

// ★가드가 통째로 사라지는 것을 막는다. 감정 정의 드리프트 가드가 실제로 그렇게 죽었다.
test('감정 미리듣기는 반드시 목록에 있다 — 이것이 빠져서 사고가 났다', () => {
  assert.ok(GUARDED.includes('samplerPreview'),
    '미리듣기를 목록에서 빼면 파이썬 둘이 같은 GPU 를 동시에 문다')
  assert.ok(GUARDED.includes('dubJob'),
    '더빙 앞단·내보내기도 제 실행기를 따로 만든다 — 빼면 같은 사고가 난다')
  assert.equal(GUARDED.length, 5, '실행기를 늘렸으면 여기 수도 같이 늘어야 한다')
})

// ★목록을 만들어 두고 **안 쓰면** 아무것도 달라지지 않는다.
test('본체가 이 목록을 실제로 부른다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.resolve(here, '..', 'main', 'ipc', 'audio.ipc.ts'), 'utf-8')
  assert.ok(src.includes('blockReason('), 'audio.ipc 가 공용 판정을 부르지 않는다')
  const calls = (src.match(/blockReason\(/g) || []).length
  assert.ok(calls >= 2, `합성·트랙 두 자리에서 불러야 한다(지금 ${calls}곳)`)
})

// 타입이 실수를 잡는지 — 없는 이름을 쓰면 컴파일이 막힌다.
const _shape: RunningState = {
  mainRunner: false, transcriptPreview: false, referenceTrim: false,
  samplerPreview: false, dubJob: false,
}
void _shape

// ── 제 실행기를 따로 만드는 길은 **양방향으로** 이어져야 한다 ──────────────
//
// ★'목록에 넣었다' 만으로는 부족하다. 배선이 끊겨 있으면 값이 늘 false 다.
//   더빙은 실제로 그랬다 — 본체 배선 단계에서부터 바쁨을 주고받지 않았다.
test('더빙은 시작 전에 다른 작업을 보고, 도는 동안 남에게 보인다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, "..", "..")
  const dub = readFileSync(path.join(root, "src", "main", "ipc", "dub.ipc.ts"), "utf-8")
  const index = readFileSync(path.join(root, "src", "main", "index.ts"), "utf-8")
  const audio = readFileSync(path.join(root, "src", "main", "ipc", "audio.ipc.ts"), "utf-8")

  // ① 더빙이 남을 본다
  assert.ok(dub.includes("busyReason()"), "더빙이 다른 작업을 보지 않고 시작한다")
  // ② 더빙이 제 상태를 세운다
  assert.ok(dub.includes("dubGuard"), "더빙이 제 바쁨을 세우지 않는다")
  assert.ok(dub.includes("isRunning:"), "더빙이 바쁨을 밖에 알려 주지 않는다")
  // ③ 배선이 양쪽으로 이어져 있다
  const flat = index.split(/\r?\n/).join(' ')
  assert.ok(/registerDubIpc\([^;]*busyReason/.test(flat),
    '본체 배선이 더빙에 바쁨 판정을 넘기지 않는다')
  assert.ok(/registerAudioIpc\([^;]*isRunning/.test(flat),
    '합성 쪽이 더빙 상태를 받지 않는다')
  // ④ 합성 판정이 실제로 그 값을 쓴다
  assert.ok(audio.includes("dubJob: isDubRunning()"), "합성 판정이 더빙을 보지 않는다")
})

// ★판정을 한 곳에서만 모으는지 — 흩어지면 새 실행기가 늘 때 또 한 곳을 빠뜨린다.
test('실행 상태를 한 곳에서 모은다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, "..", "..")
  const audio = readFileSync(path.join(root, "src", "main", "ipc", "audio.ipc.ts"), "utf-8")
  assert.ok(audio.includes('const runningState = ()'), '실행 상태를 모으는 자리가 없다')
  // 판정을 부르는 자리는 전부 모아 둔 것을 써야 한다 — **딱 하나만 예외다.**
  // 트랙 작업은 제 슬롯(trackSlot)을 따로 보므로 일부만 골라 쓴다. 그 사실을
  // 여기 적어 두어, 두 번째 예외가 생기면 이 검사가 울리게 한다.
  // 호출이 여러 줄에 걸쳐 있으므로 줄이 아니라 **호출 단위**로 본다.
  const flat = audio.split(/\r?\n/).join(' ')
  const callers = [...flat.matchAll(/blockReason\(/g)]
    .map((m) => flat.slice(m.index!, m.index! + 160))
  const own = callers.filter((l) => l.includes('runningState()'))
  const exceptions = callers.filter((l) => !l.includes('runningState()'))
  assert.ok(own.length >= 3, `모아 두고 쓰지 않으면 소용없다(지금 ${own.length}곳)`)
  assert.equal(exceptions.length, 1, `예외가 늘었다 — 왜 따로 세는지 적으세요:\n${exceptions.join('\n')}`)
  assert.ok(exceptions[0].includes('samplerPreview') && exceptions[0].includes('dubJob'),
    '예외(트랙 작업)조차 제 실행기를 따로 만드는 길들을 봐야 한다')
})
