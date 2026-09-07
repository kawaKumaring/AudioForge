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
  changeSpeaker, insertUtteranceAfter, moveUtterance, replaceUtteranceBody,
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

// ── 기본 인물(화자 표기 없음) ────────────────────────────────────────────────

test('기본 인물 → 명시 인물: 표기 없는 대사 앞에 [화자 이름] 을 세우고, 뒤 대사는 [화자 기본] 으로 되돌린다', () => {
  const f = FIX.no_speaker
  const rows = rowsOf(f)
  const res = changeSpeaker(f.source, rows, 0, '민수')
  assert.equal(res.changed, true, res.refusedCode ?? '')
  assert.equal(res.text, '[화자 민수]\n그냥 한 줄\n[화자 기본]\n[기쁨] 둘째 줄')
})

test('[화자 기본] 은 파서가 화자를 비운다(실측) — 행은 기본 인물이고, 명시 인물로 바꾸면 표기만 바뀐다', () => {
  const f = FIX.default_reset
  const rows = rowsOf(f)
  assert.deepEqual(rows.map((r) => r.speakerLabel), ['민수', null, null])
  assert.deepEqual(rows.map((r) => r.hasOwnSpeakerDirective), [true, true, false])
  assert.equal(verdictOf(f, rows).mode, 'structured')
  // 자기 표기([화자 기본])가 있는 기본 인물 행 → 표기만 바꾸고, 이어받던 셋째 줄은 기본으로 복원.
  const res = changeSpeaker(f.source, rows, 1, '영희')
  assert.equal(res.changed, true, res.refusedCode ?? '')
  assert.equal(res.text, '[화자 민수]\n안녕\n[화자 영희]\n둘째\n[화자 기본]\n셋째')
  // 이미 기본 인물인 행을 기본 인물로 → 변화 없음.
  assert.equal(changeSpeaker(f.source, rows, 1, null).refusedCode, 'NO_CHANGE')
  // 빈 문자열은 기본 인물이 아니라 잘못된 이름이다.
  assert.equal(changeSpeaker(f.source, rows, 1, '').refusedCode, 'SPEAKER_LABEL_EMPTY')
})

test('명시 인물 → 기본 인물: 표기를 [화자 기본] 으로 바꾼다(다음 행이 자기 표기를 가지면 복원 없음)', () => {
  const f = FIX.three_speakers
  const rows = rowsOf(f)
  const res = changeSpeaker(f.source, rows, 1, null)
  assert.equal(res.changed, true, res.refusedCode ?? '')
  assert.equal(res.text, '[화자 민수]\n안녕\n[화자 기본]\n[기쁨] 반가워\n[화자 민수]\n[슬픔] 잘 가')
})

// ── 쉼 ──────────────────────────────────────────────────────────────────────

test('줄 안의 쉼: 화자 변경·본문 수정 뒤에도 [쉼 N] 이 그대로 남는다', () => {
  const f = FIX.pause_inside
  const rows = rowsOf(f)
  const sp = changeSpeaker(f.source, rows, 0, '영희')
  assert.equal(sp.changed, true, sp.refusedCode ?? '')
  assert.match(sp.text, /^\[화자 영희\]\n안녕 \[쉼 1\] 잘 지냈어\?\n/)
  // 본문에서 쉼을 지우는 수정은 일반 경로에서 거부된다(태그 손실 방지).
  const drop = replaceUtteranceBody(f.source, rows, 0, '안녕 잘 지냈어?')
  assert.equal(drop.changed, false)
  assert.equal(drop.refusedCode, 'MID_EMOTION_WOULD_BE_LOST')
  // 쉼을 지키는 수정은 반영된다.
  const keep = replaceUtteranceBody(f.source, rows, 0, '반가워 [쉼 1] 잘 지냈어?')
  assert.equal(keep.changed, true, keep.refusedCode ?? '')
  assert.match(keep.text, /^\[화자 민수\]\n반가워 \[쉼 1\] 잘 지냈어\?\n/)
})

test('독립 쉼 줄(발화 사이의 지시 전용 줄)은 직접 입력으로 물러난다 — NON_WHITESPACE_OUTSIDE', () => {
  const f = FIX.pause_line
  const rows = rowsOf(f)
  assert.equal(rows.length, 2)
  const v = verdictOf(f, rows)
  assert.equal(v.mode, 'sourceOnly')
  assert.ok(v.blockers.includes('NON_WHITESPACE_OUTSIDE'), v.blockers.join(','))
})
