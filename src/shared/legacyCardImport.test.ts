// 옛 작업 → 카드 가져오기 — **무엇을 옮기고 무엇을 옮기지 않는가.**
//
// 이 검사가 붙드는 것은 하나다: *지어내지 않는다.*
// 기록이 없는 값을 지금 설정으로 채우거나, 뜻이 다른 값을 같은 자리에 넣으면 운다.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  planFromLab, planFromDraft, legacyWorks, alreadyImported, applyImport, baseName,
// @ts-ignore TS5097
} from './legacyCardImport.ts'
// @ts-ignore TS5097
import { parseSavedFile, parseSavedWork, type SavedFile } from './synthesisCardSave.ts'

const AT = 1_700_000_000_000

const labDoc = () => ({
  voicePath: 'E:/소리/A.wav',
  voiceLabel: 'A 목소리',
  settings: { speed: 1.2, pitch: -2, silenceGap: 0.9, engine: 'qwen', tailMode: 'auto', refTargetSec: 7 },
  updatedAt: AT - 5000,
  lines: [
    {
      id: 'l1', text: '첫 줄', adoptedTakeId: 't2',
      takes: [
        { id: 't1', path: 'E:/out/1.wav', text: '첫 줄 옛 대사', voiceKey: 'E:/소리/A.wav', createdAt: 10 },
        { id: 't2', path: 'E:/out/2.wav', text: '첫 줄', voiceKey: 'E:/소리/A.wav', createdAt: 20 },
      ],
    },
    { id: 'l2', text: '둘째 줄', adoptedTakeId: null, takes: [] },
  ],
})

test('줄 순서·대사·생성본·채택이 그대로 옮겨진다', () => {
  const plan = planFromLab(labDoc(), AT)
  assert.ok(plan)
  const cards = plan!.doc.cards
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map((c) => c.text), ['첫 줄', '둘째 줄'])
  assert.equal(cards[0].takes.length, 2)
  assert.deepEqual(cards[0].takes.map((t) => t.path), ['E:/out/1.wav', 'E:/out/2.wav'])
  // 채택은 **기록된 것만** 따라간다
  assert.equal(cards[0].adoptedId, 'lab_t2')
  assert.equal(cards[1].adoptedId, null)
  assert.equal(plan!.work.takeCount, 2)
})

test('뜻이 같은 값만 옮긴다 — 속도·음높이는 오고, 대사 안의 쉼은 오지 않는다', () => {
  const plan = planFromLab(labDoc(), AT)!
  const s = plan.doc.cards[0].settings
  assert.equal(s.speed, 1.2)
  assert.equal(s.pitch, -2)
  // ★대사 '안' 의 쉼이 카드 '사이' 간격으로 새어 들어가지 않는다
  assert.equal(s.silenceGap, undefined)
  assert.deepEqual(plan.doc.joins, {})
  assert.equal((plan.doc.joins as Record<string, unknown>).gap, undefined)
})

test('생성본의 당시 설정을 지금 설정으로 채우지 않는다', () => {
  const plan = planFromLab(labDoc(), AT)!
  for (const t of plan.doc.cards[0].takes) {
    assert.deepEqual(t.settings, {})
    assert.deepEqual(t.applied, {})
    assert.equal(t.settingsUnknown, true)     // '없다' 는 사실 자체를 남긴다
  }
  // 카드 설정(1.2배속)이 생성본으로 새어 들어가지 않았다
  assert.notEqual(plan.doc.cards[0].settings.speed, undefined)
  assert.equal(plan.doc.cards[0].takes[0].settings.speed, undefined)
})

test('기록된 것은 남긴다 — 생성본의 당시 대사와 목소리 파일', () => {
  const plan = planFromLab(labDoc(), AT)!
  const t = plan.doc.cards[0].takes[0]
  assert.equal(t.text, '첫 줄 옛 대사')       // 지금 카드 대사로 덮지 않는다
  assert.equal(t.sourcePath, 'E:/소리/A.wav')
  assert.equal((t.voice as Record<string, unknown>).kind, 'reference')
})

test('참조 구간은 기록이 없으므로 자동으로 둔다', () => {
  const plan = planFromLab(labDoc(), AT)!
  assert.equal(plan.doc.cards[0].settings.reference, 'auto')
  assert.equal(plan.doc.cards[0].settings.start, 0)
  assert.equal(plan.doc.cards[0].settings.end, 0)
})

test('옮기지 못하는 항목을 미리 말한다', () => {
  const plan = planFromLab(labDoc(), AT)!
  const what = plan.work.skips.map((k) => k.what).join(' | ')
  assert.match(what, /생성본별 설정/)
  assert.match(what, /쉼/)
  assert.match(what, /참조 구간/)
  assert.match(what, /엔진/)
})

test('모양이 아니면 반쯤 만들지 않는다', () => {
  assert.equal(planFromLab(null, AT), null)
  assert.equal(planFromLab({}, AT), null)
  assert.equal(planFromLab({ lines: [] }, AT), null)
  // 줄은 있는데 쓸 수 있는 것이 없으면 만들지 않는다
  assert.equal(planFromLab({ lines: [{ text: 'x' }] }, AT), null)
})

test('파일 자리가 없는 생성본은 옮기지 않는다 — 다른 파일로 바꿔치지도 않는다', () => {
  const doc = labDoc()
  doc.lines[0].takes.push({ id: 't3', path: '', text: '빈 것', voiceKey: '', createdAt: 30 } as never)
  const plan = planFromLab(doc, AT)!
  assert.equal(plan.doc.cards[0].takes.length, 2)
  assert.ok(!plan.doc.cards[0].takes.some((t) => t.path === ''))
})

// ── 자동 저장(workDrafts) ────────────────────────────────────────────────

test('인물이 하나면 목소리와 구간이 그대로 온다', () => {
  const plan = planFromDraft({
    sourcePath: 'E:/소리/B.mp4', ttsText: '대사 한 덩어리', speakerMode: 'single',
    updatedAt: '2026-09-20T10:00:00.000Z',
    speakers: { s1: { source: 'E:/소리/B.mp4', label: 'B', region: { start: 3, duration: 5 } } },
  }, 'k1', AT)!
  const c = plan.doc.cards[0]
  assert.equal(c.text, '대사 한 덩어리')
  assert.equal(c.sourcePath, 'E:/소리/B.mp4')
  assert.equal(c.settings.reference, 'manual')
  assert.equal(c.settings.start, 3)
  assert.equal(c.settings.end, 8)
})

test('줄과 인물의 대응이 없으면 배역을 붙이지 않는다', () => {
  const plan = planFromDraft({
    sourcePath: 'E:/소리/C.wav', ttsText: '누가 말했는지 모르는 대사',
    speakerMode: 'multi', updatedAt: '',
    speakers: {
      s1: { source: 'E:/소리/C.wav', label: 'A', region: null },
      s2: { source: 'E:/소리/D.wav', label: 'B', region: null },
    },
  }, 'k2', AT)!
  assert.equal(plan.doc.cards.length, 1)
  // 원문은 보존하고
  assert.equal(plan.doc.cards[0].text, '누가 말했는지 모르는 대사')
  // 목소리는 비워 둔다 — 사용자가 고른다
  assert.equal(plan.doc.cards[0].sourcePath, '')
  assert.match(plan.work.skips.map((k) => k.what).join(' | '), /인물 2명/)
})

test('합성 전 기록에는 생성본이 없다 — 없는 것을 만들어 넣지 않는다', () => {
  const plan = planFromDraft({
    sourcePath: 'E:/소리/B.wav', ttsText: '대사', speakerMode: 'single', updatedAt: '',
    speakers: { s1: { source: 'E:/소리/B.wav', label: 'B', region: null } },
  }, 'k3', AT)!
  assert.equal(plan.doc.cards[0].takes.length, 0)
  assert.equal(plan.doc.cards[0].adoptedId, null)
  assert.match(plan.work.skips.map((k) => k.what).join(' | '), /생성본/)
})

// ── 모으기·다시 가져오기·반영 ────────────────────────────────────────────

test('두 자리에서 모두 모으고, 같은 기록이면 언제나 같은 결과다', () => {
  const all = {
    labWorkspace: labDoc(),
    workDrafts: {
      schemaVersion: 1,
      drafts: {
        b: { sourcePath: 'E:/b.wav', ttsText: '나', speakerMode: 'single', updatedAt: '', speakers: {} },
        a: { sourcePath: 'E:/a.wav', ttsText: '가', speakerMode: 'single', updatedAt: '', speakers: {} },
      },
    },
  }
  const one = legacyWorks(all, AT)
  const two = legacyWorks(all, AT)
  assert.equal(one.length, 3)
  assert.deepEqual(one.map((p) => p.work.key), two.map((p) => p.work.key))
})

test('가져오기는 덮지 않는다 — 하던 작업은 보관함으로 간다', () => {
  const plan = planFromLab(labDoc(), AT)!
  const before: SavedFile = {
    current: { cards: [{ id: 'now', label: '하던 것', sourcePath: 'E:/x.wav', sourceName: 'x', sourceDuration: 0, text: '하던 대사', settings: {}, takes: [], adoptedId: null }], joins: {}, savedAt: 1 },
    kept: [],
  }
  const after = applyImport(before, plan.doc)
  assert.equal(after.current, plan.doc)
  assert.equal(after.kept.length, 1)
  assert.equal(after.kept[0].cards[0].text, '하던 대사')   // 지워지지 않았다
})

test('같은 작업을 또 가져오려 하면 어디에 있는지 말한다', () => {
  const plan = planFromLab(labDoc(), AT)!
  const file = applyImport({ current: null, kept: [] }, plan.doc)
  const dup = alreadyImported(file, 'lab')
  assert.deepEqual(dup, { slot: 'current', index: 0, at: AT })
  assert.equal(alreadyImported(file, 'draft:k1'), null)
  // 보관함으로 밀려나도 찾아낸다
  const moved = applyImport(file, { cards: [], joins: {}, savedAt: 2 })
  assert.equal(alreadyImported(moved, 'lab')?.slot, 'kept')
})

test('가져온 문서는 저장본 읽기를 그대로 통과한다(출처와 기록 없음 표시 포함)', () => {
  const plan = planFromLab(labDoc(), AT)!
  const round = parseSavedWork(JSON.parse(JSON.stringify(plan.doc)))
  assert.ok(round)
  assert.equal(round!.cards.length, 2)
  assert.equal(round!.cards[0].takes[0].settingsUnknown, true)
  assert.deepEqual(round!.importedFrom, { kind: 'lab', key: 'lab', at: AT })
  // 문서 한 장으로 넣었다 뺐을 때도 출처가 살아 있다
  const file = parseSavedFile({ current: JSON.parse(JSON.stringify(plan.doc)), kept: [] })
  assert.equal(alreadyImported(file, 'lab')?.slot, 'current')
})

test('경로에서 이름만 떼어낸다', () => {
  assert.equal(baseName('E:/소리/A.wav'), 'A.wav')
  assert.equal(baseName('E:' + String.fromCharCode(92) + '소리' + String.fromCharCode(92) + 'B.wav'), 'B.wav')
  assert.equal(baseName('C.wav'), 'C.wav')
  assert.equal(baseName(''), '')
})
