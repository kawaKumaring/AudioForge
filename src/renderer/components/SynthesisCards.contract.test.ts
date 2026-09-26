// 생성 카드가 **실제로 이어져 있는가.**
//
// ★관리자 지시(2026-09-26)의 네 가지를 화면 코드에서 지킨다.
//   1. 카드별 준비·생성을 실제 경로로 부른다(전역 목소리·전역 설정을 바꿔 흉내 내지 않는다).
//   2. 늦은 응답이 바뀐 카드나 다른 카드에 반영되지 않는다.
//   3. 미지원 설정을 조용히 무시하거나 적용된 것처럼 표시하지 않는다.
//   4. 다시 생성해도 이전 생성본을 지우지 않는다.
//
// ★가드는 **계약**에 맨다 — 단추 글자·자리·색이 아니다.
//   이 저장소는 글자에 맨 가드가 멀쩡한 코드를 실패로 몬 일이 네 번 있다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]) => readFileSync(path.join(HERE, ...p), 'utf-8')

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
function codeOf(raw: string): string {
  return raw.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
}

const SCREEN = read('SynthesisCardWorkspace.tsx')
const RUNNER = read('..', 'lib', 'cardSynthesis.ts')
const STORE = read('..', 'stores', 'synthesisCards.store.ts')
const MAIN = read('..', '..', 'main', 'ipc', 'audio.ipc.ts')
const SAVE = read('..', '..', 'shared', 'synthesisCardSave.ts')

export function connectionFaults(screen: string, runner: string, store: string, mainSrc = '', saveSrc = ''): string[] {
  const s = codeOf(screen), r = codeOf(runner), st = codeOf(store), main = codeOf(mainSrc)
  const bad: string[] = []

  // 1. 실제 경로를 부른다.
  if (!s.includes('prepareCardReference(')) bad.push('카드별 목소리 준비를 부르지 않는다')
  if (!s.includes('startCardGeneration(')) bad.push('카드별 생성을 부르지 않는다')
  if (!r.includes('window.api.audio.process(')) bad.push('생성이 엔진에 닿지 않는다')

  // ★전역 설정을 바꿔 카드별 동작을 흉내 내지 않는다 — 값은 요청에 실어 보낸다.
  if (r.includes('setSynthesisTab(') || r.includes('useAppStore.setState(')) {
    bad.push('전역 상태를 바꿔 카드별 동작을 흉내 낸다')
  }

  // 2. 늦은 응답을 버린다. **식별자가 있는지가 아니라 실제로 대조하는지**를 본다
  //    (2026-09-27 검수: '코드에 reqId 가 있는지' 검사로는 부족하다).
  if (!r.includes('clientRequestId: reqId')) bad.push('요청 식별자를 본체에 보내지 않는다')
  if (!r.includes('cardEventFault(')) bad.push('결과를 받을 때 요청을 대조하지 않는다')
  if (!s.includes('cardEventFault(')) bad.push('화면이 진행·오류를 대조 없이 받는다')
  if (!main.includes('tagWith(')) bad.push('본체가 이벤트에 요청 식별자를 되돌려 주지 않는다')
  for (const ch of ["'audio:result'", "'audio:progress'", "'audio:error'"]) {
    const at = main.indexOf('webContents.send(' + ch)
    if (at < 0 || !main.slice(at, at + 200).includes('tagWith(')) {
      bad.push(`${ch} 에 요청 식별자가 실리지 않는다`)
    }
  }

  // 2-0. ★저장 열쇠가 **본체 허용 목록에 있는가.**
  //    없으면 본체가 SETTINGS_KEY_NOT_ALLOWED 로 조용히 거절하고 화면은 저장한 줄 안다.
  //    실제로 그 상태였다 — 카드 작업이 디스크에 한 번도 저장되지 않았다(2026-09-27).
  if (mainSrc) {
    const allow = mainSrc.indexOf("ipcMain.handle('settings:set'")
    if (allow < 0 || !mainSrc.slice(allow, allow + 1600).includes('CARD_STORAGE_KEY')) {
      bad.push('본체가 카드 저장 열쇠를 받지 않는다 — 저장이 조용히 거절된다')
    }
    const readAt = mainSrc.indexOf('[DIALOGUE_EDIT_STORAGE_KEY]: stored[')
    if (readAt < 0 || !mainSrc.slice(readAt - 900, readAt + 400).includes('[CARD_STORAGE_KEY]: stored[')) {
      bad.push('본체가 카드 저장본을 돌려주지 않는다 — 되살릴 수 없다')
    }
  }

  // 2-2. ★마감 이벤트에서 식별자를 잃지 않는다(2026-09-27 2차 검수).
  //    `done` 에서 값을 비웠더니 result 와 보류된 error 가 식별자 없이 나갔다.
  if (mainSrc) {
    const doneAt = main.indexOf("runner.on('done'")
    const tail = main.slice(doneAt, doneAt + 900)
    if (doneAt >= 0 && tail.includes('runClientReq = null')) {
      bad.push('실행이 끝나면서 식별자를 비운다 — 마감 이벤트가 식별자를 잃는다')
    }
    if (!main.includes('sendError(pendingError, clientReq)')) {
      bad.push('보류된 오류가 어느 요청의 것인지 말하지 않는다')
    }
  }
  // 2-3. ★'식별자가 없으면 내 것' 예외를 되살리지 않는다.
  if (/\?\s*got === job\.reqId\s*:\s*true/.test(s)) {
    bad.push('식별자 없는 신호를 내 것으로 본다 — 남의 취소가 내 작업을 끝낸다')
  }

  // 2-1. 저장이 화면 수명에 묶이지 않는다(2026-09-27 검수 재현 1).
  if (s.includes('saveSetting(')) bad.push('화면이 저장을 직접 한다 — 떠나면 마지막 편집을 잃는다')
  if (!s.includes('queueSave(') || !s.includes('flushSave(')) {
    bad.push('저장을 화면 밖 소유자에게 맡기지 않는다')
  }
  // 2-4. ★저장 문서를 조용히 버리지 않는다(2차 검수: 다섯 개 넘으면 잘렸다).
  if (saveSrc.includes('.slice(0, KEPT_SHOW)') || saveSrc.includes('.slice(0, KEPT_MAX)')) {
    bad.push('보관 개수를 잘라 작업 문서를 버린다')
  }
  if (!saveSrc.includes('export function adoptFromKept(')) {
    bad.push('보관본을 꺼낼 때 하던 작업을 지키는 규칙이 없다')
  }

  // 실패를 삼키지 않는다(재현 2).
  if (!s.includes('retrySave(')) bad.push('저장 실패에 다시 시도할 길이 없다')

  // 3. 미지원 설정을 화면이 말한다.
  if (!s.includes('cardApplied(')) bad.push('엔진이 못 받는 설정을 가려내지 않는다')
  if (!s.includes('notes.map(')) bad.push('못 보낸 설정을 화면에 띄우지 않는다')

  // 4. 생성본을 지우지 않는다. **더하기만** 한다.
  if (!/addTake:\s*\(id,\s*take\)\s*=>[\s\S]{0,260}takes:\s*\[\.\.\.c\.takes,\s*take\]/.test(st)) {
    bad.push('생성본을 더하는 자리가 없다 — 다시 만들면 이전 것이 사라질 수 있다')
  }
  // 채택은 사용자가 정한다. 생성 쪽이 adoptedId 를 건드리면 임의 교체가 된다.
  if (/addTake[\s\S]{0,260}adoptedId/.test(st)) bad.push('생성이 채택을 임의로 바꾼다')
  // ★'파일 어디에든 adoptedId 가 있으면 실패' 는 너무 무디다 — 저장본을 되살리는 코드는
  //   당연히 채택을 복원한다. 계약은 **생성 결과를 받는 자리**가 채택을 바꾸지 않는 것이다.
  const accept = r.slice(r.indexOf('function acceptCardResult'))
  if (accept && accept.slice(0, 1200).includes('adoptedId')) {
    bad.push('생성 결과를 받는 자리가 채택을 바꾼다')
  }

  return bad
}

test('생성 카드가 준비·생성·보존 계약을 지킨다', () => {
  assert.deepEqual(connectionFaults(SCREEN, RUNNER, STORE, MAIN, SAVE), [])
})

// ★이빨 확인 — 실제 파일을 건드리지 않는다. 글자 조각으로만 본다.
test('연결 전 모습이었다면 검사가 운다', () => {
  const bad = connectionFaults('<button disabled>생성</button>', 'const x = 1', 'const y = 2', '')
  assert.ok(bad.length >= 6, `연결 안 된 모습을 통과시킨다: ${JSON.stringify(bad)}`)
})

test('생성이 채택을 덮으면 운다', () => {
  const st = STORE.replace('addTake: (id, take) => set(s => ({',
    'addTake: (id, take) => set(s => ({ adoptedId: take.id,')
  assert.ok(connectionFaults(SCREEN, RUNNER, st, MAIN, SAVE).some((b) => b.includes('채택')),
    '재생성이 채택을 갈아 끼워도 통과시킨다')
})

test('못 보낸 설정을 안 띄우면 운다', () => {
  const s = SCREEN.split('notes.map(').join('void 0 && [].map(')
  assert.ok(connectionFaults(s, RUNNER, STORE, MAIN, SAVE).some((b) => b.includes('못 보낸 설정')),
    '조용히 무시해도 통과시킨다')
})

test('주석만으로는 통과하지 못한다', () => {
  const fake = [
    '// prepareCardReference( startCardGeneration( cardApplied( notes.map(',
    '// window.api.audio.process( reqId',
  ].join('\n')
  assert.ok(connectionFaults(fake, fake, fake, fake).length >= 6, '주석을 코드로 착각한다')
})

// ★검수 재현 1·2 가 코드 수준에서 되돌아오지 않게.
test('화면이 다시 저장을 떠안으면 운다', () => {
  const s = SCREEN + String.fromCharCode(10) + 'void saveSetting(window.api.settings.set, K, v)'
  assert.ok(connectionFaults(s, RUNNER, STORE, MAIN, SAVE).some((b) => b.includes('저장을 직접')),
    '화면이 저장을 떠안아도 통과시킨다')
})

test('본체가 식별자를 안 실으면 운다', () => {
  const m = MAIN.split('tagWith(').join('plain(')
  assert.ok(connectionFaults(SCREEN, RUNNER, STORE, m, SAVE).length >= 1,
    '이벤트에 출신이 없어도 통과시킨다')
})
test('본체 허용 목록에서 카드 열쇠가 빠지면 운다', () => {
  const m = MAIN.split('CARD_STORAGE_KEY').join('SOME_OTHER_KEY')
  assert.ok(connectionFaults(SCREEN, RUNNER, STORE, m, SAVE).some((b) => b.includes('조용히 거절')),
    '저장이 통째로 거절돼도 통과시킨다')
})
test('마감에서 식별자를 비우면 운다', () => {
  const m = MAIN.replace("runner.on('done', (code) => {",
    "runner.on('done', (code) => {" + String.fromCharCode(10) + '      runClientReq = null')
  assert.ok(connectionFaults(SCREEN, RUNNER, STORE, m, SAVE).some((b) => b.includes('식별자를 비운다')),
    '마감 이벤트가 출신을 잃어도 통과시킨다')
})

test('보관 문서를 자르면 운다', () => {
  const sv = SAVE.replace('return { current: parseSavedWork(o.current), kept }',
    'return { current: parseSavedWork(o.current), kept: kept.slice(0, KEPT_SHOW) }')
  assert.ok(connectionFaults(SCREEN, RUNNER, STORE, MAIN, sv).some((b) => b.includes('작업 문서를 버린다')),
    '사용자가 지운 적 없는 문서를 버려도 통과시킨다')
})