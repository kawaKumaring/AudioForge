// 저장이 **화면 수명에 묶이지 않는가.**
//
// ★2026-09-27 검수 재현: 대사 A 저장 대기 → B 로 수정 → 600ms 안에 다른 메뉴로 이동 →
//   900ms 뒤 저장값은 **A** 였다. 화면을 떠날 때 저장 타이머를 취소했기 때문이다.
//   화면 수명과 저장 수명은 다른 것이다. 이 검사는 그 분리를 지킨다.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type Store = { key: string; value: unknown }
const writes: Store[] = []
let setImpl: (key: string, value: unknown) => Promise<unknown> = async (key, value) => {
  writes.push({ key, value }); return { ok: true }
}
let getImpl: () => Promise<unknown> = async () => ({})
const syncWrites: Store[] = []

// 모듈이 읽는 창구를 먼저 세운다 — 불러오는 순간 beforeunload 를 건다.
;(globalThis as Record<string, unknown>).window = {
  addEventListener: () => {},
  api: { settings: {
    set: (k: string, v: unknown) => setImpl(k, v), get: () => getImpl(),
    setSync: (k: string, v: unknown) => { syncWrites.push({ key: k, value: v }); return { ok: true } },
  } },
}

const saver = await import('./cardWorkSaver.ts')
const { CARD_STORAGE_KEY } = await import('../../shared/synthesisCardSave.ts')

const work = (text: string, savedAt = 1) => ({
  savedAt, joins: {},
  cards: [{
    id: 'c1', label: 'A', sourcePath: 'a.wav', sourceName: 'a.wav', sourceDuration: 8,
    text, settings: {}, takes: [], adoptedId: null,
  }],
})
const lastWrite = () => writes[writes.length - 1]?.value as { current?: { cards: { text: string }[] }; kept?: unknown[] }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  writes.length = 0
  syncWrites.length = 0
  setImpl = async (key, value) => { writes.push({ key, value }); return { ok: true } }
  getImpl = async () => ({})
  saver.resetSaverForTest()
})

// ★이것이 이 파일의 존재 이유다.
test('화면을 떠나도 마지막 편집이 남는다', async () => {
  await saver.loadSavedFile()
  saver.queueSave(work('대사 A'))
  saver.queueSave(work('대사 B'))     // 600ms 안에 다시 고쳤다
  await saver.flushSave()             // 화면이 사라지면서 흘려보낸다
  assert.equal(lastWrite()?.current?.cards[0].text, '대사 B', '마지막 편집을 잃었다')
})

test('떠나지 않아도 잠시 뒤 스스로 쓴다', async () => {
  await saver.loadSavedFile()
  saver.queueSave(work('대사 C'))
  await wait(saver.SAVE_DELAY_MS + 120)
  assert.equal(lastWrite()?.current?.cards[0].text, '대사 C')
})

test('같은 열쇠에 쓴다 — 문장별 작업 자리를 건드리지 않는다', async () => {
  await saver.loadSavedFile()
  saver.queueSave(work('x'))
  await saver.flushSave()
  assert.equal(writes[writes.length - 1].key, CARD_STORAGE_KEY)
})

// ★실패를 삼키면 사용자는 저장된 줄 안다.
test('저장 실패를 상태로 올린다', async () => {
  setImpl = async () => ({ ok: false, code: 'DISK_FULL' })
  await saver.loadSavedFile()
  saver.queueSave(work('실패할 것'))
  await saver.flushSave()
  const st = saver.saveState()
  assert.equal(st.phase, 'failed', '실패를 성공처럼 둔다')
  assert.equal(st.code, 'DISK_FULL', '사유를 잃었다')
})

test('다시 시도하면 성공 상태로 돌아온다', async () => {
  setImpl = async () => ({ ok: false, code: 'DISK_FULL' })
  await saver.loadSavedFile()
  saver.queueSave(work('한 번은 실패'))
  await saver.flushSave()
  setImpl = async (key, value) => { writes.push({ key, value }); return { ok: true } }
  await saver.retrySave()
  assert.equal(saver.saveState().phase, 'saved')
  assert.equal(lastWrite()?.current?.cards[0].text, '한 번은 실패', '재시도가 내용을 잃었다')
})

// ★느린 앞 쓰기가 뒤 쓰기를 덮으면 옛 내용이 최종본이 된다.
test('저장 순서가 뒤집히지 않는다', async () => {
  let n = 0
  setImpl = async (key, value) => {
    const mine = ++n
    await wait(mine === 1 ? 80 : 5)     // 첫 쓰기가 느리다
    writes.push({ key, value })
    return { ok: true }
  }
  await saver.loadSavedFile()
  saver.queueSave(work('먼저'))
  void saver.flushSave()
  saver.queueSave(work('나중'))
  await saver.flushSave()
  assert.equal(lastWrite()?.current?.cards[0].text, '나중', '느린 앞 쓰기가 뒤를 덮었다')
})

// ★검수 재현 3: 거절하고 새 작업을 편집하자 이전 문서가 덮였다.
test('되살리기를 거절해도 이전 문서가 남는다', async () => {
  getImpl = async () => ({ [CARD_STORAGE_KEY]: work('이전 작업', 111) })
  await saver.loadSavedFile()
  await saver.keepCurrentAside()          // '나중에' 를 골랐다
  saver.queueSave(work('새 작업', 222))   // 새 카드를 편집한다
  await saver.flushSave()
  const w = lastWrite()
  assert.equal(w?.current?.cards[0].text, '새 작업')
  assert.equal(w?.kept?.length, 1, '이전 문서를 잃었다 — 순서·대사·채택이 통째로 사라진다')
  assert.equal((w?.kept?.[0] as { cards: { text: string }[] }).cards[0].text, '이전 작업')
})

test('치워 둔 문서를 다시 꺼내 쓸 수 있다', async () => {
  getImpl = async () => ({ [CARD_STORAGE_KEY]: work('이전 작업', 111) })
  await saver.loadSavedFile()
  await saver.keepCurrentAside()
  saver.adoptKept(0)
  await saver.flushSave()
  const w = lastWrite()
  assert.equal(w?.current?.cards[0].text, '이전 작업', '재시작 뒤 이전 작업에 닿을 길이 없다')
  assert.equal(w?.kept?.length, 0)
})

test('읽지 못해도 저장본을 지우지 않는다', async () => {
  getImpl = async () => { throw new Error('읽기 실패') }
  const f = await saver.loadSavedFile()
  assert.equal(f.current, null)
  assert.deepEqual(f.kept, [])
  assert.equal(writes.length, 0, '읽기 실패가 쓰기를 부른다 — 저장본을 날린다')
})

// ★창이 닫히는 순간의 비동기 요청은 기다려 주지 않는다 — 마지막 편집 직후 종료하면 잃는다.
test('종료 직전에는 기다려 주는 통로로 남긴다', () => {
  saver.queueSave(work('닫기 직전 대사'))
  saver.flushSaveSync()
  const last = syncWrites[syncWrites.length - 1]
  assert.equal(last?.key, CARD_STORAGE_KEY)
  assert.equal((last?.value as { current: { cards: { text: string }[] } }).current.cards[0].text, '닫기 직전 대사',
    '종료 저장이 마지막 편집을 담지 못했다')
})

test('종료 저장도 보관함을 함께 남긴다', async () => {
  getImpl = async () => ({ [CARD_STORAGE_KEY]: work('이전 작업', 111) })
  await saver.loadSavedFile()
  await saver.keepCurrentAside()
  saver.queueSave(work('새 작업', 222))
  saver.flushSaveSync()
  const last = syncWrites[syncWrites.length - 1]?.value as { kept: unknown[] }
  assert.equal(last.kept.length, 1, '종료 저장이 보관함을 날린다')
})