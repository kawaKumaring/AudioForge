// 한 명 화면의 화자 구조 보호 계약 — 소스를 읽어 고정한다.
//
// 실제 결함: 한 명 화면에서 `[화자 …]` 줄을 지우면 여러 명 화면의 인물과 배정이 조용히 사라졌다.
// 원문 하나가 권위라는 구조는 유지하되, 그 구조를 없애는 것은 명시 전환으로만 가능해야 한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) =>
  src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

const GUARD = codeOf(read('./SingleScriptGuard.tsx'))
const SHELL = codeOf(read('./TTSEditor.tsx'))

test('한 명 편집기는 화자 구조를 지키는 변경만 받는다', () => {
  assert.ok(SHELL.includes('onChange={onSingleEditorChange}'), '편집기 onChange 가 보호 함수를 거친다')
  const i = SHELL.indexOf('const onSingleEditorChange')
  assert.ok(i > 0)
  const body = SHELL.slice(i, SHELL.indexOf('\n  }\n', i))
  assert.ok(body.includes("dialogueTab === 'single'"), '한 명 탭에서만')
  assert.ok(body.includes('speakerDirectives.length > 0'), '명시 화자가 있을 때만')
  assert.ok(body.includes('!speakerStructurePreserved(ttsText, next)'), '표기 순서 비교')
  assert.ok(body.includes('setSingleEditBlocked(true)'), '거부를 알린다')
  // 거부 경로에서 원문을 쓰지 않는다: return 이 setTtsText 보다 먼저 온다.
  assert.ok(body.indexOf('return') < body.indexOf('setTtsText(next)'))
})

test('탭 전환은 원문·배정·목소리 구성을 쓰지 않는다 (탭 컴포넌트는 setter 하나만)', () => {
  assert.ok(SHELL.includes('<DialogueTabs tab={dialogueTab} onTab={setDialogueTab}'))
  // 탭 상태 변화에 반응해 원문·store 를 쓰는 effect 가 없다.
  for (const m of SHELL.matchAll(/useEffect\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\)/g)) {
    if (m[1].includes('dialogueTab')) {
      assert.equal(/setTtsText|setSpeakerEmotionRefs|removeSpeakerRef|settings\.set/.test(m[0]), false,
        '탭 전환 effect 가 상태를 쓴다')
    }
  }
})

test('구조 제거는 명시 전환만 — 결과 설명 + 사용자 확인 + 취소는 완전 무변경', () => {
  assert.ok(SHELL.includes("dialogueTab === 'single' && speakerDirectives.length > 0 && ("), '보호 안내는 한 명 + 명시 화자일 때만')
  assert.ok(SHELL.includes('<SingleScriptGuard'))
  assert.ok(SHELL.includes('onConvert={convertToSingleScript}'))
  const i = SHELL.indexOf('const convertToSingleScript')
  const body = SHELL.slice(i, SHELL.indexOf('\n  }\n', i))
  assert.ok(body.includes('stripSpeakerDirectives(ttsText)'), '전환은 패처의 표기 제거 함수만 쓴다')
  // 전환은 목소리 지정·목소리 구성·후보 음원·설정을 건드리지 않는다.
  for (const forbidden of ['removeSpeakerRef', 'setSpeakerEmotionRefs', 'ttsSpeakerRefState', 'voiceCast',
    'settings.set', 'deleteVoiceCast', 'unregisterCandidate', 'referenceAssets']) {
    assert.equal(body.includes(forbidden), false, `전환이 ${forbidden} 를 건드린다`)
  }
  // 컴포넌트: 결과를 먼저 말하고, 확인 버튼만 onConvert 를 부른다. 취소는 패널만 닫는다.
  assert.ok(GUARD.includes('인물 구분이 제거되며 모든 대사가 기본 목소리를 사용합니다'))
  assert.ok(GUARD.includes('저장된 목소리 구성과 후보 음원은 삭제되지 않습니다'))
  assert.ok(GUARD.includes('data-testid="single-convert-confirm"'))
  assert.ok(GUARD.includes('data-testid="single-convert-cancel"'))
  const cancelIdx = GUARD.indexOf('data-testid="single-convert-cancel"')
  const cancelBlock = GUARD.slice(cancelIdx, GUARD.indexOf('</button>', cancelIdx))
  assert.equal(cancelBlock.includes('onConvert'), false, '취소가 전환을 부른다')
  assert.equal((GUARD.match(/onConvert\(\)/g) ?? []).length, 1, '전환 호출은 확인 버튼 한 곳')
  for (const forbidden of ['confirm(', 'setTtsText', 'useAppStore', 'window.api', 'settings', 'Patcher']) {
    assert.equal(GUARD.includes(forbidden), false, `컴포넌트가 ${forbidden} 를 쓴다`)
  }
})

test('사용자 화면 용어만 쓴다', () => {
  for (const forbidden of ['VoiceCast', '배역 세트', 'patcher', 'parser', 'SHA', 'projection']) {
    assert.equal(GUARD.includes(forbidden), false, forbidden)
  }
  assert.ok(GUARD.includes("'한 명 대본으로 전환'"))
})
