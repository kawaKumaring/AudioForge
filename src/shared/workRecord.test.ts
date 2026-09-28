import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  WORK_KINDS, LEGACY_KEY_OF, isWorkKind, fileNameOf, fingerprint, isWorkFile,
  makeRecord, parseRecord, splitLegacyMap,
// @ts-ignore TS5097
} from './workRecord.ts'

test('갈래 목록과 옛 열쇠 표가 서로 맞는다', () => {
  for (const k of WORK_KINDS) {
    assert.ok(Array.isArray(LEGACY_KEY_OF[k]) && LEGACY_KEY_OF[k].length >= 1,
      `${k} 의 옛 열쇠가 없다 — 옮길 때 이 갈래가 통째로 빠진다`)
  }
  assert.equal(Object.keys(LEGACY_KEY_OF).length, WORK_KINDS.length,
    '표에만 있고 목록에 없는 갈래가 있다')
  assert.ok(isWorkKind('cards'))
  assert.ok(!isWorkKind('없는갈래'))
  assert.ok(!isWorkKind(7))
})

test('★옛 열쇠가 겹치지 않는다 — 한 열쇠를 두 갈래가 가져가면 하나가 사라진다', () => {
  const seen = new Set<string>()
  for (const keys of Object.values(LEGACY_KEY_OF)) {
    for (const k of keys) {
      assert.ok(!seen.has(k), `열쇠 ${k} 가 두 갈래에 있다`)
      seen.add(k)
    }
  }
})

test('파일 이름은 쓸 수 있는 글자만 남긴다', () => {
  const n = fileNameOf('C:\\소리\\말.wav\u001f본문')
  assert.ok(!/[\u0000-\u001f<>:"/\\|?*]/.test(n), `못 쓰는 글자가 남았다: ${n}`)
  assert.ok(n.endsWith('.json'))
  assert.ok(isWorkFile(n), `우리 파일로 알아보지 못한다: ${n}`)
})

test('★못 쓰는 글자만 다른 열쇠가 같은 파일이 되지 않는다', () => {
  // 깎기만 하면 둘 다 `C_소리_말.json` 이 되어 한쪽이 다른 쪽을 덮는다.
  const a = fileNameOf('C:/소리/말')
  const b = fileNameOf('C:\\소리\\말')
  assert.notEqual(a, b, '서로 다른 열쇠인데 같은 파일 이름이다')
})

test('★대소문자만 다른 열쇠도 갈라진다', () => {
  assert.notEqual(fileNameOf('작업.wav'), fileNameOf('작업.WAV'))
})

test('아주 긴 열쇠도 이름이 길어지지 않는다', () => {
  const long = 'C:/' + '가'.repeat(400) + '/말.wav'
  const n = fileNameOf(long)
  assert.ok(n.length <= 80, `이름이 너무 길다(${n.length}) — 윈도우 경로 상한에 걸린다`)
  assert.notEqual(n, fileNameOf(long + '2'), '길이를 깎느라 서로 같아졌다')
})

test('빈 열쇠도 쓸 수 있는 이름을 준다', () => {
  const n = fileNameOf('')
  assert.ok(n.length > 5 && n.endsWith('.json'), n)
  assert.ok(isWorkFile(n))
})

test('지문은 같은 열쇠에 늘 같다', () => {
  assert.equal(fingerprint('가나다'), fingerprint('가나다'))
  assert.notEqual(fingerprint('가나다'), fingerprint('가나라'))
})

test('남의 파일은 우리 것으로 보지 않는다', () => {
  assert.ok(!isWorkFile('settings.json'))
  assert.ok(!isWorkFile('.숨김.abc.json'))
  assert.ok(!isWorkFile('메모.txt'))
})

test('기록을 만들고 되읽는다', () => {
  const r = makeRecord('열쇠', { a: 1 }, 1234)
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(r))), r)
})

test('★모양이 아니면 null — 빈 기록으로 꾸미지 않는다', () => {
  assert.equal(parseRecord(null), null)
  assert.equal(parseRecord('글자'), null)
  assert.equal(parseRecord([]), null)
  assert.equal(parseRecord({ key: '', data: 1 }), null, '열쇠가 없으면 어느 작업인지 모른다')
  assert.equal(parseRecord({ key: 'a' }), null, '본문이 없으면 기록이 아니다')
  // 시각이 이상하면 0 으로 — 그 때문에 기록을 버리지는 않는다.
  assert.deepEqual(parseRecord({ key: 'a', data: 1, updatedAt: 'x' }),
    { key: 'a', updatedAt: 0, data: 1 })
})

test('옛 한 덩어리를 기록 여럿으로 가른다', () => {
  const legacy = {
    version: 1,
    drafts: {
      'A.wav\u001f본문': { edits: { 1: '고침' }, updatedAt: 500 },
      'B.wav\u001f본문': { edits: {}, updatedAt: 900 },
    },
  }
  const got = splitLegacyMap(legacy, 111)
  assert.equal(got.length, 2)
  assert.deepEqual(got.map((r) => r.key).sort(), ['A.wav\u001f본문', 'B.wav\u001f본문'])
  assert.equal(got.find((r) => r.key.startsWith('A')).updatedAt, 500, '그때 시각을 그대로 쓴다')
})

test('감싸개가 없는 옛 모양도 가른다', () => {
  const got = splitLegacyMap({ 'A': { x: 1 }, 'B': { x: 2 } }, 7)
  assert.equal(got.length, 2)
  assert.equal(got[0].updatedAt, 7, '시각이 없으면 지금 시각을 쓴다')
})

test('★가르면서 내용을 바꾸지 않는다', () => {
  const inner = { 깊이: { 안: [1, 2, { 셋: true }] }, updatedAt: 5 }
  const got = splitLegacyMap({ drafts: { 'K': inner } }, 0)
  assert.deepEqual(got[0].data, inner, '옮기면서 모양을 바꾸면 무엇이 달라졌는지 알 수 없다')
})

test('가를 것이 없으면 빈 목록', () => {
  assert.deepEqual(splitLegacyMap(null, 0), [])
  assert.deepEqual(splitLegacyMap('글자', 0), [])
  assert.deepEqual(splitLegacyMap([], 0), [])
  assert.deepEqual(splitLegacyMap({ version: 1, drafts: {} }, 0), [])
})

test('★옛 한 칸짜리는 기록 하나다 — 필드를 각각 기록으로 쪼개지 않는다', () => {
  // `dialogueEdits` 는 지도가 아니라 교정 문서 하나다. 지도로 착각하면
  // sourcePath·segments·edits·updatedAt 이 **각각 기록이 된다**(2026-09-29 실측).
  const oneDoc = {
    sourcePath: 'C:/work/C.wav',
    segments: [{ start: 1, end: 3, speaker: '화자 A' }],
    edits: { 1: { speaker: '화자 A' } },
    updatedAt: 7,
  }
  const got = splitLegacyMap(oneDoc, 999)
  assert.equal(got.length, 1, `쪼개졌다: ${got.map((r) => r.key).join(', ')}`)
  assert.equal(got[0].key, 'C:/work/C.wav', '원본 경로를 열쇠로 둬야 화면이 찾는다')
  assert.equal(got[0].updatedAt, 7, '그때 시각을 쓴다')
  assert.deepEqual(got[0].data, oneDoc, '내용을 바꾸지 않는다')
})

test('sourceKey 를 쓰는 한 칸짜리도 같다', () => {
  const got = splitLegacyMap({ sourceKey: 'B.wav', names: {}, merges: {}, edits: {} }, 5)
  assert.equal(got.length, 1)
  assert.equal(got[0].key, 'B.wav')
})

test('감싸개가 있으면 한 칸짜리로 보지 않는다', () => {
  // {version, drafts:{...}} 안의 값이 sourcePath 를 가져도 그것은 **지도**다.
  const got = splitLegacyMap({ version: 1, drafts: { K: { sourcePath: 'A.wav' } } }, 0)
  assert.deepEqual(got.map((r) => r.key), ['K'])
})

test('원본 경로가 없는 덩어리는 지도로 본다', () => {
  const got = splitLegacyMap({ current: { cards: [] }, kept: [] }, 0)
  assert.deepEqual(got.map((r) => r.key).sort(), ['current', 'kept'])
})

test('★감싸개 없는 옛 카드 한 벌은 하던 것 하나다', () => {
  // 아주 옛 판은 `{current, kept}` 없이 작업 한 벌을 그대로 저장했다.
  // 지도로 착각하면 cards·joins·savedAt 이 각각 기록이 된다(2026-09-29 실측).
  const bare = { cards: [{ id: 'c1', text: '가' }], joins: {}, savedAt: 111 }
  const got = splitLegacyMap(bare, 0)
  assert.equal(got.length, 1, `쪼개졌다: ${got.map((r) => r.key).join(', ')}`)
  assert.equal(got[0].key, 'current')
  assert.deepEqual(got[0].data, bare)
  assert.equal(got[0].updatedAt, 0, 'savedAt 은 본문의 값이고 기록 시각과 다르다')
})

test('감싸개가 있으면 카드도 지도로 본다', () => {
  const got = splitLegacyMap({ current: { cards: [] }, kept: [{ cards: [] }] }, 0)
  assert.deepEqual(got.map((r) => r.key).sort(), ['current', 'kept'])
})
