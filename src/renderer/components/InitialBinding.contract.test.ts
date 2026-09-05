// 여러 명 첫 인물의 초기 목소리 — 기본 목소리(처음 불러온 음성)를 **이어받는** 계약. 소스를 읽어 고정한다.
//
// 결함 배경(2026-09-05): 예전 초기 binding 은 기본 목소리의 확정 클립을 공유하지 않기로 하고 clip:'' ready:false 로
// 슬롯을 만들었다. 10초 초과 원본(기본 목소리가 구간 클립을 쓰는 보통의 경우)에서 상단은 '준비됨', 첫 인물은
// '목소리 확인 중' 이 됐고, 같은 파일을 다시 지정하면 구간 확정을 또 요구했다. 이제는 원본·확정 구간·유효 참조를
// 실제로 옮기고(클립은 main 이 인물 key 로 복사해 소유권 분리), 기본 목소리가 준비될 때까지 동기화한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const SHELL = codeOf(read('./TTSEditor.tsx'))
const STORE = codeOf(read('../stores/app.store.ts'))
const MAIN = codeOf(read('../../main/ipc/audio.ipc.ts'))
const PRELOAD = codeOf(read('../../preload/index.ts'))

const i = SHELL.indexOf('const firstDialogueSpeaker = dialogue.speakers[0]')
const block = SHELL.slice(i, SHELL.indexOf('const requestSpeakerSource', i))

test('첫 인물(계획 1번 또는 빈 대본의 시작 카드)에 슬롯을 만들고 이어받기 플래그를 세운다 — 여러 명·어느 인물도 목소리 없음·한 번', () => {
  assert.ok(i > 0)
  assert.ok(block.includes("if (ttsSpeakerMode !== 'multi' || !fileInfo?.path || !firstSpeakerVoiceId) return"))
  assert.ok(block.includes('if (Object.keys(ttsSpeakerRefState).length > 0) return'), '이미 지정이 있으면 개입하지 않음')
  assert.ok(block.includes('initialSpeakerBind.current === key'), '한 파일·한 인물 id 당 한 번')
  assert.ok(block.includes('registerSpeakerRef(firstSpeakerVoiceId, fileInfo.path, firstDialogueSpeaker?.label)'), '같은 원본에 슬롯 생성')
  assert.ok(block.includes('setSpeakerInherit({ speakerId: firstSpeakerVoiceId, filePath: fileInfo.path })'))
  assert.ok(block.includes('firstDialogueSpeaker.pending'), '빈 대본의 시작 카드(인물1)도 첫 인물이다')
})

test('동기화: 기본 목소리가 준비되면 원본·확정 구간·유효 참조를 옮긴다(재선택·재확정 없음). 준비 중이면 같은 사유, 완료 시 갱신', () => {
  assert.ok(block.includes("adoptReferenceClip('default', 'spk:' + id)"), '확정 클립은 main 이 인물 key 로 복사(소유권 분리)')
  assert.ok(block.includes('setSpeakerRefState(id, { clip: adopted, region: ttsReferenceRegion ?? null, ready: true, message: \'\' })'))
  assert.ok(block.includes("setSpeakerRefState(id, { clip: '', region: null, ready: true, message: '' })"), '원본 전체가 유효하면 그대로')
  assert.ok(block.includes("setSpeakerRefState(id, { ready: false, message: ttsRefMessage || '목소리 확인 중' })"), '준비 중이면 같은 사유')
  assert.ok(block.includes('setSpeakerInherit(null)'), '옮긴 뒤 독립')
  for (const forbidden of ["'구간 선택 필요'", 'selectFile', 'trimReference', 'setTtsRefState(', 'setFile(']) {
    assert.equal(block.includes(forbidden), false, forbidden)
  }
  assert.ok(block.includes('inheritSlotSource !== inh.filePath) return'), '사용자가 다른 원본을 골랐으면 개입하지 않음')
})

test('store: 사용자의 목소리 지정·해제는 이어받기를 끝낸다(초기화가 덮어쓰지 않음). 파일 변경·리셋은 플래그를 비운다', () => {
  assert.ok(STORE.includes('ttsSpeakerInherit: { speakerId: string; filePath: string } | null'))
  assert.equal((STORE.match(/ttsSpeakerInherit: s\.ttsSpeakerInherit\?\.speakerId === speakerId \? null : s\.ttsSpeakerInherit/g) ?? []).length, 2, 'register·remove 모두')
  assert.ok((STORE.match(/ttsSpeakerInherit: null/g) ?? []).length >= 3, '기본·setFile·reset')
  assert.ok(STORE.includes('moveSpeakerRef: (fromId, toId) => {'), '시작 카드 이름 변경 시 슬롯 이동')
  assert.ok(STORE.includes("renameReferenceClip?.('spk:' + fromId, 'spk:' + toId)"))
})

test('main/preload: 클립 이어받기는 복사이며 이전 소유 클립은 새 클립이 준비된 뒤에만 놓는다', () => {
  assert.ok(MAIN.includes("ipcMain.handle('audio:adopt-reference-clip'"))
  const a = MAIN.indexOf("ipcMain.handle('audio:adopt-reference-clip'")
  const body = MAIN.slice(a, MAIN.indexOf("ipcMain.handle('audio:rename-reference-clip'", a))
  assert.ok(body.includes('copyFileSync(join(srcDir, f), join(outDir, f))'), '복사(공유 아님)')
  assert.ok(body.indexOf('releaseRefClip(toKey)') > body.indexOf("if (!existsSync(clip))"), '성공 확인 뒤에만 이전 클립 해제')
  assert.ok(body.includes("return ''") , '기본이 원본 전체면 빈 문자열')
  assert.ok(MAIN.includes("ipcMain.handle('audio:rename-reference-clip'"))
  assert.ok(PRELOAD.includes('adoptReferenceClip: (fromKey: string, toKey: string)'))
  assert.ok(PRELOAD.includes('renameReferenceClip: (fromKey: string, toKey: string)'))
})
