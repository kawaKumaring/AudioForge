import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileWorkspaceClipKeys } from './referenceClipOwnership.ts'

test('파일 교체는 일반·더빙과 알 수 없는 작업 슬롯을 보존한다', () => {
  const clips = new Map([
    ['default', 'advanced.wav'], ['spk:alice', 'alice.wav'], ['happy', 'happy.wav'],
    ['lab', 'script.wav'], ['dub', 'dub.wav'], ['future-workspace', 'future.wav'],
  ])
  for (const key of fileWorkspaceClipKeys(clips.keys())) clips.delete(key)
  assert.deepEqual([...clips.keys()], ['lab', 'dub', 'future-workspace'])
})

test('공용 파일 정리 IPC는 소유 범위를 쓰고 종료 전체 정리는 유지한다', () => {
  const source = readFileSync(new URL('../main/ipc/audio.ipc.ts', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf("ipcMain.handle('audio:release-reference-clip'"),
    source.indexOf("ipcMain.handle('audio:fingerprint-reference'"))
  assert.ok(handler.includes('fileWorkspaceClipKeys(refClipDirs.keys())'))
  assert.ok(source.includes('sweepRefClipDirs(clipRoot())'))
})
