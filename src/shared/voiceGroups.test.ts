// 목소리 고르기 묶음 — 엔진 이름은 묶음 제목 한 번, 칩에는 짧은 이름(2026-10-01).
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { groupVoices } from './voiceGroups.ts'

const v = (engineId: string, label: string, i: number) => ({ engineId, modelId: `${engineId}${i}`, label, path: `/m/${i}` })

test('★Supertonic 은 "빠른 기본 목소리" · 소희는 "고품질 · 느림" — 칩에는 짧은 이름', () => {
  const list = [v('supertonic', 'Supertonic 남성 2', 1), v('supertonic', 'Supertonic 여성 3', 2), v('qwen-custom', 'Qwen 소희 (GPU · 시작 느림)', 3),
    v('supertonic', 'Supertonic 여성 1', 4), v('supertonic', 'Supertonic 남성 1', 5)]
  const g = groupVoices(list)
  assert.deepEqual(g.map((x) => x.title), ['빠른 기본 목소리', '고품질 · 느림'])
  assert.deepEqual(g[0].voices.map((x) => x.short), ['여성 1', '여성 3', '남성 1', '남성 2'], '여성 → 남성, 번호 차례')
  assert.deepEqual(g[1].voices.map((x) => [x.short, x.tag]), [['소희', 'GPU']])
  assert.ok(g[0].voices.every((x) => x.voice.label.startsWith('Supertonic')), '원래 이름표는 그대로 둔다(툴팁·화면 읽기)')
})

test('모르는 엔진은 따로 · 없는 묶음은 보이지 않는다', () => {
  const g = groupVoices([v('piper', 'ko_KR-x', 1)])
  assert.deepEqual(g.map((x) => [x.title, x.voices[0].short]), [['다른 기본 목소리', 'ko_KR-x']])
  assert.deepEqual(groupVoices([]), [])
})
