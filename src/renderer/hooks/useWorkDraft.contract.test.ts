// 현재 작업 자동 저장·복원 배선 계약 — 규칙은 shared/workDraft 하나뿐이고, 훅은 효과만 낸다.
// 저장 경계(다른 저장소 무접촉)와 복원 규칙(재확정 요구 없음·대체 없음)이 코드에 실제로 있는지 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const HOOK = codeOf(read('./useWorkDraft.ts'))
const SHELL = codeOf(read('../components/TTSEditor.tsx'))
const CARD = codeOf(read('../components/MultiSpeakerDialogue.tsx'))
const IPC = codeOf(read('../../main/ipc/audio.ipc.ts'))
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)) }

test('저장은 자기 키 하나에만 쓴다 — 목소리 구성·전역 자산 등록부를 건드리지 않는다', () => {
  assert.ok(HOOK.includes('window.api.settings.set(WORK_DRAFT_STORAGE_KEY'))
  assert.equal(/settings\.set\((?!WORK_DRAFT_STORAGE_KEY)/.test(HOOK), false, '다른 키로 저장하지 않는다')
  for (const forbidden of ['VOICE_CAST_STORAGE_KEY', 'GLOBAL_ASSET_STORAGE_KEY', 'voiceCasts', 'referenceAssets']) {
    assert.equal(HOOK.includes(forbidden), false, forbidden)
  }
  // main 도 세 키를 서로 독립으로 둔다(키 하나만 원자적으로 교체).
  assert.ok(IPC.includes('|| key === WORK_DRAFT_STORAGE_KEY'))
})

test('규칙은 계약에서만 온다 — 훅이 판정을 다시 쓰지 않는다', () => {
  for (const fn of ['planWorkRestore', 'slotForPlan', 'buildWorkDraft', 'findWorkDraft', 'workKeyOf', 'putWorkDraft']) {
    assert.ok(HOOK.includes(fn), fn)
  }
  // 구간 추천을 다시 돌리지 않는다(저장된 구간 그대로 재생성).
  assert.equal(/analyzeReference|recommend|rescan/.test(HOOK), false, '복원이 추천을 다시 돌리지 않는다')
})

test('복원은 저장된 구간 그대로 되살리고 실패해도 다른 목소리로 대체하지 않는다', () => {
  const prep = between(HOOK, 'const prepareOne = useCallback', '}, [setSpeakerRefState])')
  assert.ok(prep.includes('plan.region.start, plan.region.duration'), '저장된 구간을 그대로 넘긴다')
  assert.ok(prep.includes("'spk:' + plan.speakerId"), '그 인물 소유 키로만 만든다')
  // 실패 경로는 ready 를 올리지 않고 지정을 지우지도 않는다.
  const fails = prep.split('ready: false').length - 1
  assert.ok(fails >= 2, '실패·예외 두 경로 모두 준비됨이 아니다')
  assert.equal(/source:\s*['"]/.test(prep), false, '실패 시 다른 원본을 넣지 않는다')
})

test('복원 중에는 준비됨이 아니고, 이 작업에 이미 인물이 있으면 기록으로 덮지 않는다', () => {
  assert.ok(HOOK.includes('if (Object.keys(useAppStore.getState().ttsSpeakerRefState).length > 0)'))
  assert.ok(HOOK.includes('suppressSave.current = true'), '복원이 곧바로 저장으로 되돌아오지 않는다')
  assert.ok(HOOK.includes('if (workDraftIsEmpty(draft)) return'), '빈 기록으로 쓸모 있는 기록을 덮지 않는다')
  assert.ok(HOOK.includes('if (!loaded || rootError'), '기록을 읽지 못했으면 저장하지 않는다')
})

test('셸이 훅을 걸고, 저장이 막힌 실행은 숨기지 않는다', () => {
  assert.ok(SHELL.includes('const workDraft = useWorkDraft(ttsEngine)'))
  assert.ok(SHELL.includes('data-testid="work-draft-notice"'))
  assert.ok(SHELL.includes('workDraft.rootError &&'))
})

test('카드는 복원 상태를 그대로 보여 준다 — 구간 선택 필요로 뭉개지 않는다', () => {
  const fn = between(CARD, 'export function voiceStatusShort', '\n}\n')
  assert.ok(CARD.includes("const RESTORE_STATUS = ['목소리 준비 중', '원본 다시 연결 필요'] as const"))
  assert.ok(fn.includes('const restore = RESTORE_STATUS.find((m) => message === m)'))
  assert.ok(fn.indexOf('RESTORE_STATUS.find') < fn.indexOf("message.includes('구간')"), '복원 상태를 먼저 본다')
})

test('원본 존재 확인은 가볍다 — 인물마다 ffprobe 를 돌리지 않는다', () => {
  assert.ok(HOOK.includes('window.api.audio.sourcesPresent(sources)'))
  const handler = between(IPC, "ipcMain.handle('audio:sources-present'", '\n  })')
  assert.ok(handler.includes('existsSync(p)'))
  assert.equal(/ffprobe|execFile/.test(handler), false)
})
