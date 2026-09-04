// 생성 방식(speakerMode) 계약 — 소스를 읽어 고정한다.
//
// 한 명은 기본 기능이다. 명시 화자가 있다는 이유로 한 명 편집을 막거나 "여러 명에서 바꾸라" 고
// 강요하지 않는다. 탭은 생성 방식이고, 대본 권위는 ttsText 하나다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildTtsConfig } from '../../shared/ttsConfig.ts'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(here(rel), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

const SHELL = codeOf(read('./TTSEditor.tsx'))
const PB = codeOf(read('./ProcessButton.tsx'))
const STORE = codeOf(read('../stores/app.store.ts'))

test('한 명 편집기는 제한이 없다 — 보호·차단·전환 코드가 셸에 없다', () => {
  for (const forbidden of ['SingleScriptGuard', 'speakerStructurePreserved', 'convertToSingleScript',
    'stripSpeakerDirectives', 'singleEditBlocked', '여러 명 화면에서 바꾸']) {
    assert.equal(SHELL.includes(forbidden), false, forbidden)
  }
  assert.equal(existsSync(here('./SingleScriptGuard.tsx')), false, '보호 컴포넌트는 폐기됐다')
  // onChange 는 늘 원문을 쓴다 — 표기 변화는 알림만 만든다(return 으로 막지 않는다).
  const i = SHELL.indexOf('const onSingleEditorChange')
  const body = SHELL.slice(i, SHELL.indexOf('\n  }\n', i))
  assert.ok(body.includes('setTtsText(next)'))
  assert.equal((body.match(/return/g) ?? []).length, 1, 'disabled 가드 하나만')
  assert.ok(body.includes('setStructureNotice('))
  assert.ok(SHELL.includes('data-testid="speaker-structure-notice"'))
  assert.ok(SHELL.includes('인물 구분이 변경되었습니다'))
  assert.ok(SHELL.includes('data-testid="speaker-structure-undo"'))
  // 되돌리기는 원문만 되돌린다 — 목소리 자산·구성에 손대지 않는다.
  const u = SHELL.indexOf('const undoStructureChange')
  const ubody = SHELL.slice(u, SHELL.indexOf('\n  }\n', u))
  for (const forbidden of ['removeSpeakerRef', 'setSpeakerEmotionRefs', 'voiceCast', 'settings']) {
    assert.equal(ubody.includes(forbidden), false, forbidden)
  }
})

test('탭 = 생성 방식(store ttsSpeakerMode). 클릭은 그 값만 바꾼다', () => {
  assert.ok(SHELL.includes('const dialogueTab: DialogueTab = ttsSpeakerMode'))
  assert.ok(SHELL.includes("const setDialogueTab = (t: DialogueTab) => { if (!disabled) setTtsSpeakerMode(t) }"))
  assert.ok(SHELL.includes('<DialogueTabs tab={dialogueTab} onTab={setDialogueTab}'))
  assert.equal(SHELL.includes('confirm('), false, '탭 전환 확인창 없음')
  // 한 명 모드의 중립 안내만.
  assert.ok(SHELL.includes('data-testid="single-mode-note"'))
  assert.ok(SHELL.includes('모든 대사를 한 목소리로 생성합니다'))
})

test('생성 방식은 config 로 나간다 — 기본 single, Python 이 single 에서 화자 표기를 무시한다', () => {
  assert.ok(PB.includes('ttsSpeakerMode'), 'ProcessButton 이 보낸다')
  assert.equal(buildTtsConfig({}).ttsSpeakerMode, 'single')
  assert.equal(buildTtsConfig({ ttsSpeakerMode: 'multi' }).ttsSpeakerMode, 'multi')
  // store: 기본 single, 새 파일·리셋·복원(부재)에서 single.
  assert.ok(STORE.includes("ttsSpeakerMode: 'single' as 'single' | 'multi'"))
  assert.ok((STORE.match(/ttsSpeakerMode: 'single'/g) ?? []).length >= 3, 'setFile·reset·기본')
  assert.ok(STORE.includes("ttsSpeakerMode: o.ttsSpeakerMode === 'multi' ? 'multi' : 'single'"), '복원은 저장된 값만')
})

test('Python 라우팅 계약의 거울 — single 은 speaker_id 전부 None, 화자 참조 준비 없음', () => {
  const py = readFileSync(here('../../../python/speaker_refs.py'), 'utf-8')
  assert.ok(py.includes('speaker_id = None if speaker_mode == SPEAKER_MODE_SINGLE else item[2]'))
  const worker = readFileSync(here('../../../python/tts_worker.py'), 'utf-8')
  assert.ok(worker.includes('_used_speaker_ids = ([] if speaker_mode == _sr.SPEAKER_MODE_SINGLE'))
  assert.ok(worker.includes('speaker_mode=getattr(ref_table, "speaker_mode", "single"))'), 'run header 기록')
})
