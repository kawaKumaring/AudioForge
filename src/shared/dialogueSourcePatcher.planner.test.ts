// 실제 planner 출력에 대한 패처 계약 — 손으로 만든 좌표가 아니라 `python/script_plan.build_structure`
// 가 실제로 내놓은 좌표(fixtures/dialogue-planner-spans.json)로 검사한다.
//
// 이 파일이 있는 이유: 첫 개발 화면 확인에서 모든 대본이 NON_WHITESPACE_OUTSIDE 로 막혔다.
// 발화 구간이 `[화자 …]` 줄을 포함한다고 가정했지만 실제 계획은 그 줄을 빈틈에 둔다.
// 가정을 코드로 남기지 않고 실측 좌표를 고정 데이터로 남긴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  groupUtteranceRows, structurable, utteranceParts, changeBaseEmotion, deleteUtterance,
  changeSpeaker, insertUtteranceAfter, moveUtterance,
} from './dialogueSourcePatcher.ts'
import type { UtteranceView } from './dialogueSourcePatcher.ts'

type Fixture = {
  source: string
  parser_authority: boolean
  source_sha256: string
  warnings: { code: string }[]
  speakers: { speaker_id: string; label: string; utterance_count: number }[]
  utterances: {
    index: number; speaker_id: string | null; speaker_label: string | null; emotion_id: string | null
    source_start: number; source_end: number; line_index: number | null; source_offsets_exact: boolean
  }[]
}

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX: Record<string, Fixture> = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'dialogue-planner-spans.json'), 'utf-8'))

// 훅과 같은 규칙(analysisWording.PLAN_WARNING_BLOCKS 의 차단 코드) — 여기서는 값 import 를 피한다.
const BLOCKING = new Set(['UNKNOWN_DIRECTIVE', 'EMPTY_UTTERANCE', 'CONFLICTING_DIRECTIVES', 'INVALID_SPEAKER'])
const sha = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex')

function rowsOf(f: Fixture): UtteranceView[] {
  return groupUtteranceRows(f.source, f.utterances.map((u) => ({
    index: u.index, speakerId: u.speaker_id, speakerLabel: u.speaker_label, emotionId: u.emotion_id,
    sourceStart: u.source_start, sourceEnd: u.source_end, lineIndex: u.line_index,
  })))
}
function verdictOf(f: Fixture, rows: UtteranceView[]) {
  return structurable({
    text: f.source, textSha256: sha(f.source), planSourceSha256: f.source_sha256,
    parserAuthority: f.parser_authority, utterances: rows,
    offsetsExact: f.utterances.map((u) => u.source_offsets_exact),
    hasBlockingWarning: f.warnings.some((w) => BLOCKING.has(w.code)),
  })
}
const slices = (f: Fixture, rows: UtteranceView[]) => rows.map((r) => f.source.slice(r.sourceStart, r.sourceEnd))
const bodies = (f: Fixture, rows: UtteranceView[]) => slices(f, rows).map((s) => utteranceParts(s).body.trim())

test('planner 의 source_sha256 은 UTF-8 sha256 과 같다(PLAN_STALE 판정의 전제)', () => {
  for (const [k, f] of Object.entries(FIX)) assert.equal(f.source_sha256, sha(f.source), k)
})

test('한 줄 대본: 화자 줄을 흡수해 구간이 원문 전체가 된다', () => {
  const f = FIX.single_line
  const rows = rowsOf(f)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hasOwnSpeakerDirective, true)
  assert.equal(slices(f, rows)[0], f.source)
  const v = verdictOf(f, rows)
  assert.equal(v.mode, 'structured', v.blockers.join(','))
})

test('세 화자 대본: 시간순 3행, 같은 화자 반복, 본문에 지시 없음', () => {
  const f = FIX.three_speakers
  const rows = rowsOf(f)
  assert.deepEqual(rows.map((r) => r.speakerLabel), ['민수', '영희', '민수'])
  assert.deepEqual(rows.map((r) => r.hasOwnSpeakerDirective), [true, true, true])
  assert.deepEqual(rows.map((r) => r.emotionId), [null, 'happy', 'sad'])
  assert.deepEqual(bodies(f, rows), ['안녕', '반가워', '잘 가'])
  assert.equal(verdictOf(f, rows).mode, 'structured')
})

test('한 줄 안의 감정 전환: 발화 2조각이 한 행이 되고 중간 태그는 본문에 남는다', () => {
  const f = FIX.mid_emotion
  const rows = rowsOf(f)
  assert.equal(rows.length, 2)
  assert.equal(slices(f, rows)[0], '[화자 민수]\n[기쁨] 앞부분 [슬픔] 뒷부분')
  assert.equal(rows[0].emotionId, 'happy')
  assert.match(bodies(f, rows)[0], /\[슬픔\] 뒷부분/)
  assert.equal(verdictOf(f, rows).mode, 'structured')
  const res = changeBaseEmotion(f.source, rows, 0, '[화남]')
  assert.equal(res.changed, true, res.refusedCode ?? '')
  assert.equal(res.text, '[화자 민수]\n[화남] 앞부분 [슬픔] 뒷부분\n[화자 영희]\n네')
})

test('이어받는 줄: 둘째 줄은 자기 화자 표기가 없고, 첫 줄 삭제 시 표기가 복원된다', () => {
  const f = FIX.inherited_line
  const rows = rowsOf(f)
  assert.deepEqual(rows.map((r) => r.hasOwnSpeakerDirective), [true, false, true])
  assert.deepEqual(rows.map((r) => r.speakerLabel), ['민수', '민수', '영희'])
  assert.equal(verdictOf(f, rows).mode, 'structured')
  const del = deleteUtterance(f.source, rows, 0)
  assert.equal(del.changed, true, del.refusedCode ?? '')
  assert.equal(del.text.includes('첫 줄'), false)
  assert.match(del.text, /\[화자 민수\]\s*\n?\s*둘째 줄/)
  assert.match(del.text, /\[화자 영희\]\n셋째 줄$/)
  // 둘째 줄의 화자를 바꾸면 셋째 줄은 자기 표기가 있으므로 복원 표기가 붙지 않는다.
  const ch = changeSpeaker(f.source, rows, 1, '영희')
  assert.equal(ch.changed, true, ch.refusedCode ?? '')
  assert.equal(ch.text, '[화자 민수]\n첫 줄\n[화자 영희]\n둘째 줄\n[화자 영희]\n셋째 줄')
})

test('화자 표기가 대사와 같은 줄에 있어도 흡수된다', () => {
  const f = FIX.inline_speaker
  const rows = rowsOf(f)
  assert.deepEqual(rows.map((r) => r.hasOwnSpeakerDirective), [true, true])
  assert.deepEqual(bodies(f, rows), ['안녕', '반가워'])
  assert.equal(verdictOf(f, rows).mode, 'structured')
})

test('줄 안의 쉼 표기는 행 본문에 남고 구조화는 유지된다', () => {
  const f = FIX.pause_inside
  const rows = rowsOf(f)
  assert.equal(rows.length, 2)
  assert.match(bodies(f, rows)[0], /\[쉼 1\]/)
  assert.equal(verdictOf(f, rows).mode, 'structured')
  // 기본 감정을 붙여도 쉼 표기는 사라지지 않는다.
  const res = changeBaseEmotion(f.source, rows, 0, '[기쁨]')
  assert.equal(res.changed, true, res.refusedCode ?? '')
  assert.match(res.text, /^\[화자 민수\]\n\[기쁨\] 안녕 \[쉼 1\] 잘 지냈어\?\n/)
})

test('알 수 없는 지시가 있는 대본은 직접 입력으로 남는다(BLOCKING_WARNING)', () => {
  const f = FIX.unknown_directive
  const v = verdictOf(f, rowsOf(f))
  assert.equal(v.mode, 'sourceOnly')
  assert.ok(v.blockers.includes('BLOCKING_WARNING'), v.blockers.join(','))
})

test('화자 표기가 전혀 없는 대본도 행으로 보이되 화자는 비어 있다', () => {
  const f = FIX.no_speaker
  const rows = rowsOf(f)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.speakerLabel), [null, null])
  assert.equal(verdictOf(f, rows).mode, 'structured')
})

test('실측 좌표 위에서 추가·이동도 성립한다', () => {
  const f = FIX.three_speakers
  const rows = rowsOf(f)
  const ins = insertUtteranceAfter(f.source, rows, 2, '영희', '그래', null)
  assert.equal(ins.changed, true, ins.refusedCode ?? '')
  assert.equal(ins.text, f.source + '\n[화자 영희]\n그래')
  // 인접·둘 다 자기 표기·사이 공백·뒤 이어받음 없음 → 안전한 이동
  const mv = moveUtterance(f.source, rows, 1, 2)
  assert.equal(mv.changed, true, mv.refusedCode ?? '')
  assert.equal(mv.text, '[화자 민수]\n안녕\n[화자 민수]\n[슬픔] 잘 가\n[화자 영희]\n[기쁨] 반가워')
})
