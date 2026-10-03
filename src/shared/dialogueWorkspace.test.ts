// 대화 작업실 규칙 — **소속·합치기·파일 이름**.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptFault, analysisBasis, analysisFault, autoRestoreFault, displayNameOf, editedSegmentCount,
  effectiveSegment, emptyDraft, exportPlan, mergeSpeakers, resolveMerge, speakerRows,
  trackFileNames, unmergeSpeakers, TRACK_NAME_MAX, type DialogueAnalysis,
} from './dialogueWorkspace.ts'

const analysis = (over: Partial<DialogueAnalysis> = {}): DialogueAnalysis => ({
  sourceKey: 'C:/work/a.wav', runId: 'R1',
  segments: [
    { start: 0, end: 2, speaker: '화자 A' },
    { start: 2, end: 9, speaker: '화자 B' },
    { start: 9, end: 10, speaker: '화자 A' },
  ],
  speakers: ['화자 A', '화자 B'], overlaps: [], outputDir: 'C:/out',
  durationSec: 10, trimSilence: false, transcribe: false, ...over,
})

// ── 소속 ────────────────────────────────────────────────────────────────────
test('다른 원본의 결과는 들이지 않는다', () => {
  assert.equal(analysisFault({ sourceKey: 'C:/work/a.wav', runId: 'R1' }, 'C:/work/a.wav', 'R1'), '')
  assert.match(analysisFault({ sourceKey: 'C:/work/b.wav', runId: 'R1' }, 'C:/work/a.wav', 'R1'), /다른 원본/)
})

test('★늦게 온 지난 실행의 결과는 지금 작업을 덮지 않는다', () => {
  assert.match(analysisFault({ sourceKey: 'C:/work/a.wav', runId: 'OLD' }, 'C:/work/a.wav', 'NEW'), /지난 실행/)
})

test('실행 식별자가 없는 결과(옛 경로)는 원본만 맞으면 받는다', () => {
  assert.equal(analysisFault({ sourceKey: 'C:/work/a.wav' }, 'C:/work/a.wav', 'NEW'), '')
})

test('교정 문서도 원본·실행이 맞아야 저절로 이어 쓴다', () => {
  const a = analysis()
  assert.equal(autoRestoreFault(emptyDraft('C:/work/a.wav', 'R1'), a), '')
  assert.match(autoRestoreFault(emptyDraft('C:/work/b.wav', 'R1'), a), /다른 원본/)
  assert.match(autoRestoreFault(emptyDraft('C:/work/a.wav', 'R2'), a), /다른 실행/)
})

test('★다른 실행의 교정은 **대응이 확인될 때만** 가져온다', () => {
  const a = analysis()
  const old = { ...emptyDraft('C:/work/a.wav', 'OLD'), basis: analysisBasis(a) }
  assert.equal(adoptFault(old, a), '', '같은 분석인데 막혔다')
  // ★실행 식별자를 현재 값으로 바꿔치기해도 통과해서는 안 된다 — 지문이 판정한다.
  const moved = analysis({ segments: [
    { start: 0, end: 2, speaker: '화자 A' },
    { start: 2, end: 8, speaker: '화자 B' },     // 시각이 달라졌다
    { start: 9, end: 10, speaker: '화자 A' },
  ] })
  assert.match(adoptFault({ ...old, runId: moved.runId }, moved), /발언 시각이 다릅니다/)
})

test('★발언 수가 달라지면 막는다', () => {
  const a = analysis()
  const old = { ...emptyDraft('C:/work/a.wav', 'OLD'), basis: analysisBasis(a) }
  const fewer = analysis({ segments: a.segments.slice(0, 2) })
  assert.match(adoptFault(old, fewer), /발언 수가 다릅니다/)
})

test('★식별자가 같다고 같은 사람으로 보지 않는다 — 인물 구성이 다르면 막는다', () => {
  const a = analysis()
  const old = { ...emptyDraft('C:/work/a.wav', 'OLD'), basis: analysisBasis(a) }
  const other = analysis({ segments: a.segments.map((sg, i) => (
    i === 1 ? { ...sg, speaker: '화자 C' } : sg)) })
  assert.match(adoptFault(old, other), /인물 구성이 다릅니다/)
})

test('★그때의 분석 정보가 없으면 번호로 옮기지 않는다 — 보관·확인 대상', () => {
  const a = analysis()
  const noBasis = emptyDraft('C:/work/a.wav', 'OLD')
  assert.match(adoptFault(noBasis, a), /분석 정보가 없어/)
})

test('지문은 같은 입력에 같은 값이고, 시각이 바뀌면 달라진다', () => {
  const a = analysis()
  assert.equal(analysisBasis(a).timesHash, analysisBasis(analysis()).timesHash)
  const b = analysis({ segments: a.segments.map((sg) => ({ ...sg, end: sg.end + 0.5 })) })
  assert.notEqual(analysisBasis(a).timesHash, analysisBasis(b).timesHash)
})

// ── 합치기 ──────────────────────────────────────────────────────────────────
test('★합치기는 구간을 하나씩 고치지 않는다 — 한 걸음이다', () => {
  const a = analysis()
  const d = mergeSpeakers(emptyDraft(a.sourceKey, a.runId), ['화자 B'], '화자 A')
  assert.deepEqual(Object.keys(d.edits), [], '구간 수정을 만들지 않는다')
  const rows = speakerRows(a, d)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].count, 3, '세 발언이 모두 한 사람에게 모인다')
  assert.deepEqual(rows[0].absorbed, ['화자 B'])
})

test('합치기를 한 번에 되돌린다', () => {
  const a = analysis()
  const d = mergeSpeakers(emptyDraft(a.sourceKey, a.runId), ['화자 B'], '화자 A')
  const back = unmergeSpeakers(d, ['화자 B'])
  assert.equal(speakerRows(a, back).length, 2)
})

test('체인을 남기지 않는다 — C→B→A 는 전부 A 를 가리킨다', () => {
  let d = emptyDraft('s', 'r')
  d = mergeSpeakers(d, ['화자 B'], '화자 A')
  d = mergeSpeakers(d, ['화자 C'], '화자 B')
  assert.equal(resolveMerge(d.merges, '화자 C'), '화자 A')
  assert.equal(resolveMerge(d.merges, '화자 B'), '화자 A')
})

test('고리가 생겨도 멈춘다', () => {
  assert.equal(resolveMerge({ a: 'b', b: 'a' }, 'a'), 'b')
})

// ── 인물 카드 ───────────────────────────────────────────────────────────────
test('★대표 구간은 **가장 긴** 구간이다(품질을 본 것이 아니다)', () => {
  const rows = speakerRows(analysis(), emptyDraft('s', 'r'))
  const b = rows.find((r) => r.id === '화자 B')!
  assert.deepEqual({ start: b.longest!.start, end: b.longest!.end }, { start: 2, end: 9 })
  const a = rows.find((r) => r.id === '화자 A')!
  assert.equal(a.count, 2)
  assert.equal(Math.round(a.totalSec), 3)
})

test('이름을 정하지 않으면 식별자를 그대로 보여 준다', () => {
  const d = emptyDraft('s', 'r')
  assert.equal(displayNameOf(d, '화자 A'), '화자 A')
  assert.equal(displayNameOf({ ...d, names: { '화자 A': '  민수 ' } }, '화자 A'), '민수')
  assert.equal(displayNameOf({ ...d, names: { '화자 A': '   ' } }, '화자 A'), '화자 A', '빈 이름은 이름이 아니다')
})

// ── 파일 이름 ───────────────────────────────────────────────────────────────
test('★표시 이름을 파일 이름으로 그대로 쓰지 않는다 — 경로·금지 문자를 뺀다', () => {
  const n = trackFileNames([
    { id: '화자 A', name: '../../etc/passwd' },
    { id: '화자 B', name: 'a/b\\c:d*e?f"g<h>i|j' },
  ])
  for (const v of Object.values(n)) {
    for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
      assert.ok(!v.includes(ch), `금지 문자 ${ch} 가 남았다: ${v}`)
    }
    assert.ok(!v.startsWith('.') && !v.endsWith('.'), `앞뒤 점이 남았다: ${v}`)
    assert.ok(!v.includes('..'), `상위 경로가 남았다: ${v}`)
  }
})

test('★동명이인은 서로 다른 파일이 된다', () => {
  const n = trackFileNames([
    { id: '화자 A', name: '민수' }, { id: '화자 B', name: '민수' }, { id: '화자 C', name: '민수' },
  ])
  const vals = Object.values(n)
  assert.equal(new Set(vals.map((v) => v.toLowerCase())).size, 3, `겹친다: ${JSON.stringify(vals)}`)
  assert.ok(vals.includes('민수'))
})

test('윈도우가 가로채는 이름을 피한다', () => {
  const n = trackFileNames([{ id: '화자 A', name: 'CON' }, { id: '화자 B', name: 'nul.txt' }])
  assert.ok(!['con', 'nul'].includes(n['화자 A'].toLowerCase().split('.')[0]), n['화자 A'])
  assert.ok(!['con', 'nul'].includes(n['화자 B'].toLowerCase().split('.')[0]), n['화자 B'])
})

test('쓸 수 없는 이름이면 식별자에서 만든다', () => {
  const n = trackFileNames([{ id: '화자 A', name: '///' }, { id: '화자 B', name: '   ' }])
  assert.equal(n['화자 A'], 'speaker_a')
  assert.equal(n['화자 B'], 'speaker_b')
})

test('빈칸과 붙임표는 지우지 않는다 — 다른 이름이 되어 버린다', () => {
  const n = trackFileNames([{ id: '화자 A', name: '첫 곡' }, { id: '화자 B', name: 'Jean-Luc' }])
  assert.equal(n['화자 A'], '첫 곡')
  assert.equal(n['화자 B'], 'Jean-Luc')
})

test('길이 상한을 넘지 않고, 같은 입력이면 같은 결과다', () => {
  const rows = [{ id: '화자 A', name: 'ㄱ'.repeat(80) }, { id: '화자 B', name: 'ㄱ'.repeat(80) }]
  const a = trackFileNames(rows)
  const b = trackFileNames([...rows].reverse())
  assert.deepEqual(a, b, '순서가 달라도 같은 결과여야 한다')
  for (const v of Object.values(a)) assert.ok(v.length <= TRACK_NAME_MAX, `${v.length}자`)
  assert.equal(new Set(Object.values(a)).size, 2)
})

// ── 내보내기 ────────────────────────────────────────────────────────────────
test('★내보낼 구간의 화자는 **파일 이름**이고, 되읽을 표를 함께 준다', () => {
  const a = analysis()
  const d = { ...emptyDraft(a.sourceKey, a.runId), names: { '화자 A': '민수:1', '화자 B': '민수:1' } }
  const plan = exportPlan(a, d)
  const names = new Set(plan.segments.map((s) => s.speaker))
  assert.equal(names.size, 2, '동명이인이 한 파일로 뭉치지 않는다')
  for (const n of names) assert.ok(!n.includes(':'), `금지 문자가 나갔다: ${n}`)
  for (const n of names) assert.ok(plan.nameToId[n], '파일 이름 → 식별자 표가 빠졌다')
})

test('★겹친 발언을 지우거나 한 사람에게 몰지 않는다', () => {
  const a = analysis({
    segments: [
      { start: 0, end: 5, speaker: '화자 A' },
      { start: 3, end: 8, speaker: '화자 B' },   // 3~5 겹침
    ],
  })
  const plan = exportPlan(a, emptyDraft(a.sourceKey, a.runId))
  assert.equal(plan.segments.length, 2, '겹쳤다고 하나를 버리지 않는다')
  assert.notEqual(plan.segments[0].speaker, plan.segments[1].speaker, '한쪽으로 몰지 않는다')
})

test('시간이 뒤집힌 구간은 빼고 사유를 남긴다 — 조용히 고치지 않는다', () => {
  const a = analysis()
  const d = { ...emptyDraft(a.sourceKey, a.runId), edits: { 1: { end: 1 } } }
  const plan = exportPlan(a, d)
  assert.equal(plan.segments.length, 2)
  assert.deepEqual(plan.blocked, [{ index: 1, problem: 'END_BEFORE_START' }])
})

test('고친 구간만 고친 것으로 센다', () => {
  const a = analysis()
  const d = { ...emptyDraft(a.sourceKey, a.runId), edits: { 0: { speaker: '화자 B' } } }
  assert.equal(editedSegmentCount(a, d), 1)
  assert.equal(effectiveSegment(a, d, 0).speaker, '화자 B')
  assert.equal(effectiveSegment(a, d, 0).start, 0, '건드리지 않은 값은 최초 분석 그대로')
})

test('합치기도 그 구간을 "고친 것" 으로 센다 — 결과가 달라지기 때문이다', () => {
  const a = analysis()
  const d = mergeSpeakers(emptyDraft(a.sourceKey, a.runId), ['화자 B'], '화자 A')
  assert.equal(editedSegmentCount(a, d), 1, '화자 B 의 발언 하나가 바뀐다')
})
