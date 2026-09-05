// 참조 음성 상태 분리 계약 — 원본(권위) / 사용 중인 확정 구간·클립 / 편집 중 draft 를 섞지 않는다.
//
// 감사에서 확인한 결함: 구간 편집기를 다시 열면 analyze 가 확정 클립을 지웠고(재생·합성이 함께 막힘),
// 재확정은 이전 클립을 먼저 지운 뒤 시도해 실패하면 멀쩡한 상태를 잃었다. 재생 버튼은 임시 클립에 묶여 있었다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const IPC = codeOf(read('../../main/ipc/audio.ipc.ts'))
const PANEL = codeOf(read('./ReferenceRegionPanel.tsx'))
const SHELL = codeOf(read('./TTSEditor.tsx'))

test('분석(편집기 열기)은 확정 클립을 지우지 않는다', () => {
  const i = IPC.indexOf("ipcMain.handle('audio:analyze-reference'")
  const block = IPC.slice(i, IPC.indexOf('ipcMain.handle(', i + 10))
  assert.equal(block.includes('releaseRefClip('), false, 'analyze 에 releaseRefClip 없음')
})

test('재확정은 원자 교체 — 새 클립이 성공했을 때만 이전 클립을 놓고, 실패하면 이전 클립을 그대로 둔다', () => {
  const i = IPC.indexOf("ipcMain.handle('audio:trim-reference'")
  const block = IPC.slice(i, IPC.indexOf('ipcMain.handle(', i + 10))
  const rel = block.indexOf('releaseRefClip(clipKey)')
  const run = block.indexOf('await runPreview(')
  assert.ok(rel > run, '이전 클립 해제가 트림 실행 뒤에 온다')
  assert.ok(block.includes('if (succeeded) {') && block.includes('refClipDirs.set(clipKey, outDir)'))
  assert.ok(block.includes("existsSync(r.clip_path as string)"), '성공 판정은 실제 파일 존재까지')
  assert.ok(block.includes('removeRefClipDir(tmpdir(), outDir)'), '실패한 새 폴더는 지운다')
  assert.equal((block.match(/refClipDirs\.set\(clipKey, outDir\)/g) ?? []).length, 1, '성공 분기에서만 교체')
})

test('패널: 사용 중인 확정 상태가 있으면 재분석·재확정 실패가 준비 상태를 내리지 않는다', () => {
  assert.ok(PANEL.includes('committed?: { clip: string; region: { start: number; duration: number } | null; whole?: boolean } | null'))
  assert.ok(PANEL.includes('const hasCommitted = !!(committed && (committed.clip || committed.region || committed.whole))'), '원본 전체 사용 중도 사용 중이다')
  assert.ok(PANEL.includes("if (!hasCommitted) {\n      onStateRef.current({ ready: false, clip: ''"), '마운트 리셋은 확정이 없을 때만')
  assert.ok(PANEL.includes('setStart(committed.region.start)'), '슬라이더는 사용 중 구간에서 시작(전체 원본 범위)')
  assert.ok(PANEL.includes('이전에 확정한 구간을 그대로 사용합니다'))
  assert.ok(PANEL.includes('data-testid="region-confirm-kept"'))
  // 편집 대상은 늘 path(원본). clip 을 파형으로 여는 코드가 없다.
  assert.equal(/getFileUrl\((committed|confirmedClip)/.test(PANEL), false)
})

test('셸: 인물·감정·기본 패널에 committed 를 넘기고, 재생은 원본의 확정 구간을 튼다(임시 클립 아님)', () => {
  // 인물·감정 패널 + 기본 패널 두 자리(한 명 화면 / 여러 명의 숨긴 준비 구동) — 같은 committed 계약.
  assert.equal((SHELL.match(/committed=\{/g) ?? []).length, 4, '네 마운트 모두')
  assert.ok(SHELL.includes("previewLocalFile(fileInfo?.path || '', ttsReferenceRegion)"), '기본 재생 = 원본 + 구간')
  assert.ok(SHELL.includes("previewLocalFile(s?.source || '', s?.region ?? null)"), '인물 재생 = 원본 + 구간')
  assert.equal(SHELL.includes('previewLocalFile(ttsReferenceClip ||'), false)
  assert.equal(/previewLocalFile\(\s*ttsSpeakerRefState\[id\]\?\.clip/.test(SHELL), false)
  assert.ok(SHELL.includes('el.currentTime = region ? Math.max(0, region.start) : 0'))
  assert.ok(SHELL.includes('Math.round(region.duration * 1000)'), '구간 길이 뒤 정지')
})
