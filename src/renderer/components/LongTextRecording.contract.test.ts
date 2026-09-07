// 장문 종료 원인의 기록·분류 계약 — 시간 초과와 모델 상한을 다른 사유로 남기고 화면은 내부 코드를 내지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const IPC = codeOf(read('../../main/ipc/audio.ipc.ts'))
const TL = codeOf(read('./TrackList.tsx'))
const WORKER = read('../../../python/tts_worker.py')
const CP = read('../../../python/chunk_publish.py')

test('watchdog 세 판정은 기계 코드를 갖는다(모델 상한과 섞이지 않음)', () => {
  assert.ok(IPC.includes("code: 'JOB_STALLED'"))
  assert.ok(IPC.includes("code: 'JOB_BUDGET_EXHAUSTED'"))
  assert.ok(IPC.includes("code: 'JOB_INACTIVE'"))
})

test('실패 마감은 payload 수치(조각·반복·상한)를 manifest 에 남기고 분류한다', () => {
  assert.ok(WORKER.includes('_cpub.failure_extra_from_payload('))
  assert.ok(CP.includes('def failure_extra_from_payload(code, payload):'))
  assert.ok(CP.includes('"GENERATION_LIMIT_EXCEEDED": FAILURE_CLASS_MODEL_CAP'))
  assert.ok(CP.includes('"JOB_STALLED": FAILURE_CLASS_TIME_LIMIT'))
  // 허용 필드 목록에 대사·경로·이름 필드가 없다.
  const i = CP.indexOf('FAILURE_EXTRA_FIELDS = (')
  const fields = CP.slice(i, CP.indexOf(')', i))
  for (const forbidden of ['"text"', '"path"', '"label"', '"speaker_label"']) assert.equal(fields.includes(forbidden), false, forbidden)
})

test('화면은 시간 제한 판정을 사용자 말로 하고 보존하지 않은 것을 보존했다고 말하지 않는다', () => {
  assert.ok(TL.includes("errorInfo?.code === 'JOB_STALLED'") && TL.includes("errorInfo?.code === 'JOB_BUDGET_EXHAUSTED'"))
  assert.ok(TL.includes('생성이 진행되지 않아 중단했습니다'))
  assert.equal(TL.includes('완료된 앞부분은 보존했습니다'), false, '보존 기능이 없는 동안은 그 문구를 쓰지 않는다')
  for (const forbidden of ['watchdog', 'token', 'frame']) {
    const visible = TL.split('\n').filter((l) => /[가-힣]/.test(l) && !l.includes('//'))
    assert.equal(visible.some((l) => l.toLowerCase().includes(forbidden)), false, forbidden)
  }
})
