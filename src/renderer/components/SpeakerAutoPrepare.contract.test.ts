// 새 인물 목소리 자동 준비 계약 — 파일을 고르면 그것으로 끝이어야 한다.
// 기존 분석·추천·구간 확정 경로를 그대로 이어서 돌리고(새 준비 함수를 만들지 않는다), 사용자가 카드 상세와
// 파형을 열어 다시 확정하는 절차를 기본 흐름에서 없앤다. 실패·늦은 결과·교체 실패의 처리도 함께 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const codeOf = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const SHELL = codeOf(read('./TTSEditor.tsx'))
const CARD = codeOf(read('./MultiSpeakerDialogue.tsx'))
const between = (src: string, a: string, b: string) => { const i = src.indexOf(a); assert.ok(i >= 0, a); return src.slice(i, src.indexOf(b, i)) }

test('목소리 파일을 고르면 카드를 열지 않아도 준비가 돈다 — 보이지 않는 자리에서 한 번에 한 명', () => {
  assert.ok(SHELL.includes('data-testid="speaker-voice-driver"'))
  const driver = between(SHELL, 'data-testid="speaker-voice-driver"', '</div>')
  assert.ok(driver.includes('renderSpeakerRegion(autoPrep.id, false, true)'), '접힌 채(open=false) 자동 확정으로 돈다')
  const pick = between(SHELL, 'const [autoPrep, setAutoPrep] = useState', '}, [ttsSpeakerRefState, ttsSpeakerInherit, autoPrep])')
  assert.ok(pick.includes('.sort((a, b) => a[0].localeCompare(b[0]))[0]'), '순서가 정해져 있고 한 명만 고른다')
  assert.ok(pick.includes('if (st?.source === autoPrep.source && !st.ready) return'),
    '잡은 사람은 계속 붙잡는다 — 준비가 끝나기 전에 놓지 않는다')
  assert.ok(pick.includes('autoPrepDone.current.has'), '이미 한 번 돌린 파일은 다시 돌리지 않는다')
  assert.ok(pick.includes("id !== ttsSpeakerInherit?.speakerId"), '첫 인물 이어받기와 겹치지 않는다')
  // ★ 회귀 가드: 준비 상태 문구로 대상을 고르면, 패널이 올리는 진행 문구('살펴보는 중')가 곧
  //   조건을 깨서 드라이버가 스스로 언마운트되고 자동 확정이 영영 실행되지 않는다(실측 결함).
  assert.equal(/st\.message|message \?\? ''/.test(pick), false, '준비 상태 문구로 대상을 고르지 않는다')
})

test('기존 준비 경로를 재사용한다 — 새 분석·추천 함수를 만들지 않는다', () => {
  const fn = between(SHELL, 'const renderSpeakerRegion = (speakerId: string', '\n  }\n')
  assert.ok(fn.includes('<ReferenceRegionPanel'), '같은 구간 편집기 컴포넌트를 쓴다')
  assert.ok(fn.includes("clipKey={'spk:' + speakerId}"), '그 인물 소유 키')
  assert.ok(fn.includes('autoConfirm={autoConfirm}'), '기본 목소리와 같은 자동 확정 통로')
  assert.ok(fn.includes('onAutoConfirmSettled={autoConfirm ?'), '끝났다는 신호로만 다음 사람으로 넘어간다')
  assert.ok(fn.includes('autoPrepDone.current.add('), '끝난 파일을 표시해 재실행을 막는다')
  // 엔진별 정책·추천은 패널이 소유한다. 셸이 구간을 스스로 고르지 않는다.
  assert.equal(/analyzeReference|recommend|clampDuration/.test(fn), false)
})

test('연속 파일 선택 — 이전 파일의 늦은 결과가 새 선택을 덮지 않는다', () => {
  const fn = between(SHELL, 'const renderSpeakerRegion = (speakerId: string', '\n  }\n')
  assert.ok(fn.includes('if (useAppStore.getState().ttsSpeakerRefState[speakerId]?.source !== src) return'))
  assert.ok(fn.indexOf('?.source !== src) return') < fn.indexOf('setSpeakerRefState(speakerId, st)'),
    '반영 전에 먼저 막는다')
  assert.ok(fn.includes('key={src}'), '파일이 바뀌면 패널이 새로 뜬다')
})

test('교체 실패 — 기존 정상 목소리를 그대로 두고 실패를 안내한다. 원본은 건드리지 않는다', () => {
  const assign = between(SHELL, 'onAssignVoice={(id, label) =>', '})() }}')
  assert.ok(assign.includes('if (before?.ready) prevGoodVoice.current[id] = before'), '고르기 직전의 정상 목소리를 보관')
  const rec = between(SHELL, 'for (const [id, keep] of Object.entries(prevGoodVoice.current))', '\n  }, [ttsSpeakerRefState])')
  assert.ok(rec.includes("if (msg === '') continue"), '아직 준비 중이면 손대지 않는다')
  assert.ok(rec.includes("if (msg.includes('구간'))"), '수동 구간 선택 요청은 실패가 아니다 — 새 파일을 유지한다')
  assert.ok(rec.includes('setVoiceReplaceNotice('), '교체 실패를 알린다')
  assert.ok(SHELL.includes('data-testid="voice-replace-notice"'))
  // 사용자 원본 파일을 바꾸거나 지우지 않는다.
  assert.equal(/writeFile|unlink|rename\(/.test(rec), false)
})

test('카드는 준비 중 → 준비됨을 그대로 보여 주고, 구간 수정 입구가 남는다', () => {
  const fn = between(CARD, 'export function voiceStatusShort', '\n}\n')
  assert.ok(fn.includes("if (voice.ready) return `준비됨 · ${regionText(voice.region)}`"), '준비된 사용 구간을 보여 준다')
  assert.ok(fn.includes("if (message.includes('구간')) return '구간 선택 필요'"), '추천 실패 때만 수동 요청')
  assert.ok(CARD.includes('data-testid="card-voice"'), '목소리 설정(구간 수정) 입구')
  assert.ok(CARD.includes('data-testid="voice-region-toggle"'), '구간 편집기 열기')
})

// 패널 쪽 계약 — '끝났다'를 반드시 한 번 알린다. 이것이 없으면 드라이버가 한 사람을 붙잡은 채 멈춘다.
test('자동 준비는 성공·실패·해당 없음 모두에서 끝났다고 알린다', () => {
  const PANEL = codeOf(read('./ReferenceRegionPanel.tsx'))
  const eff = between(PANEL, 'const settleAuto = useCallback',
    '}, [autoConfirm, path, clipKey, analysis, analyzeError, hasCommitted, settleAuto])')
  assert.ok(eff.includes('if (hasCommitted) { settleAuto(key); return }'), '이미 쓰는 구간이 있으면 끝')
  assert.ok(eff.includes('if (analyzeError) { settleAuto(key); return }'), '분석 실패도 끝')
  assert.ok(eff.includes('if (!analysis) return'), '분석 중은 끝이 아니다')
  assert.ok(eff.includes('if (!analysis.needs_region) { settleAuto(key); return }'), '자를 필요가 없으면 끝')
  assert.ok(eff.includes('.finally(() => settleAuto(key))'), '확정을 시도했으면 결과와 무관하게 끝을 알린다')
  assert.ok(eff.includes('if (settledKey.current === key) return'), '한 파일당 한 번만')
})
