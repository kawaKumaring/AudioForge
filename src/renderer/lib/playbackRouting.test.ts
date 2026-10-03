import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []) }
const sources = files(root).map(path => ({path, code: readFileSync(path, 'utf8')}))
test('모든 WaveSurfer 생성 위치는 공용 음향 출력에 등록한다', () => {
 let players = 0
 for (const {path,code} of sources) {
  const count = (code.match(/WaveSurfer\.create\(/g) || []).length
  if (!count) continue
  players += count
  assert.equal((code.match(/attachPlaybackBoost\(ws\.getMediaElement\(\)\)/g) || []).length, count, path)
 }
 assert.ok(players >= 5)
})
test('HTMLAudio 생성은 공용 생성기를 거친다', () => {
 for (const {path,code} of sources) if (/new Audio\(/.test(code)) assert.ok(path.endsWith('playbackVolume.ts'), path)
 const owner = sources.find(s => s.path.endsWith('playbackVolume.ts'))!.code
 assert.match(owner, /attachPlaybackBoost\(el\)/)
})
test('JSX 오디오도 공용 음량·음향에 등록한다', () => {
 for (const {path,code} of sources) if (/<audio\b/.test(code) && /<audio\s+ref=/.test(code)) assert.match(code,/attachPlaybackVolume\(el\)/,path)
})
