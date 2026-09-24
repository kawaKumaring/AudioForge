// 테스트개발 작업실의 **판정 규칙**을 실제로 돌려 본다.
//
// 이 규칙들이 흔들리면 사용자가 "고른 것이 바뀌었다" 거나 "빠진 문장이 조용히 빠졌다" 를 겪는다.
// 화면·저장·내보내기가 전부 이 함수들을 쓰므로 여기서 막는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptedTake, defaultSettings, emptyDoc, exportBlockReason, exportBlockText,
  exportReadiness, hasUnusedTake, isExportBlockNotice, lineStatus,
  linesNeedingWork, newLine, parseDoc, parseSettings, redoTargets, shouldAutoAdopt,
  synthesisOptions, takeBadge, tailResidualOf,
  takeTailCut, voiceKeyOf, TAIL_RESIDUAL_CUT,
  type LabDoc, type LabLine, type LabTake,
} from './labWorkspace.ts'

const VOICE = 'C:/voice/A.wav'
const vk = voiceKeyOf(VOICE)

function take(over: Partial<LabTake> = {}): LabTake {
  return { id: 't1', path: 'C:/takes/t1.wav', text: '안녕하세요', voiceKey: vk, createdAt: 1, ...over }
}
function line(over: Partial<LabLine> = {}): LabLine {
  return { id: 'l1', text: '안녕하세요', takes: [], adoptedTakeId: null, ...over }
}
function doc(lines: LabLine[], voicePath = VOICE): LabDoc {
  return { voicePath, voiceLabel: 'A', lines, settings: defaultSettings('auto'), updatedAt: 0 }
}

test('첫 성공 결과는 기본 채택한다', () => {
  const l = line()
  assert.equal(shouldAutoAdopt(l, take(), vk), true)
})

test('이미 고른 것이 있으면 새 테이크가 그것을 밀어내지 않는다', () => {
  const t1 = take({ id: 'a' })
  const l = line({ takes: [t1], adoptedTakeId: 'a' })
  assert.equal(shouldAutoAdopt(l, take({ id: 'b' }), vk), false,
    '사용자가 고른 결과를 자동 교체하면 안 된다')
})

test('생성 도중 대사를 고쳤으면 늦게 온 결과를 자동 채택하지 않는다', () => {
  // 요청은 '안녕하세요' 로 나갔는데 그 사이 대사가 바뀌었다.
  const l = line({ text: '반갑습니다' })
  const late = take({ text: '안녕하세요' })
  assert.equal(shouldAutoAdopt(l, late, vk), false)
  assert.equal(takeBadge(late, l, vk), '수정 전 대사')
})

test('목소리를 바꾸면 이전 결과는 보존되고 꼬리표가 붙는다', () => {
  const l = line({ takes: [take()], adoptedTakeId: 't1' })
  const other = voiceKeyOf('C:/voice/B.wav')
  assert.equal(l.takes.length, 1, '테이크는 지워지지 않는다')
  assert.equal(takeBadge(l.takes[0], l, other), '이전 목소리')
  assert.equal(lineStatus(l, other), 'stale_voice')
})

test('줄 상태 — 빈 줄·미생성·수정 전·이전 목소리·준비됨', () => {
  assert.equal(lineStatus(line({ text: '   ' }), vk), 'empty')
  assert.equal(lineStatus(line(), vk), 'none')
  const t = take()
  assert.equal(lineStatus(line({ takes: [t], adoptedTakeId: 't1' }), vk), 'ready')
  assert.equal(lineStatus(line({ text: '다른 말', takes: [t], adoptedTakeId: 't1' }), vk), 'stale_text')
  assert.equal(lineStatus(line({ takes: [t], adoptedTakeId: 't1' }), 'other'), 'stale_voice')
})

test('변경된 문장만 다시 만든다 — 준비된 줄은 목록에 없다', () => {
  const ready = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const edited = line({ id: 'b', text: '고친 말', takes: [take({ id: 'tb' })], adoptedTakeId: 'tb' })
  const fresh = line({ id: 'c', text: '새 말' })
  const blank = line({ id: 'd', text: '' })
  const ids = linesNeedingWork(doc([ready, edited, fresh, blank])).map((l) => l.id)
  assert.deepEqual(ids, ['b', 'c'], '준비된 줄과 빈 줄은 다시 만들지 않는다')
})

test('내보내기 — 준비 안 된 자리가 있으면 막고 어디인지 알린다', () => {
  const ok = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const bad = line({ id: 'b', text: '아직' })
  const r = exportReadiness(doc([ok, bad]))
  assert.equal(r.ready, false, '빠진 문장을 조용히 빼고 내보내면 안 된다')
  assert.equal(r.blocking.length, 1)
  assert.equal(r.blocking[0].index, 1)
  assert.equal(r.blocking[0].status, 'none')
})

test('내보내기 — 전부 준비되면 대본 순서대로 경로를 준다', () => {
  const a = line({ id: 'a', text: '하나', takes: [take({ id: 'ta', text: '하나', path: 'p1' })], adoptedTakeId: 'ta' })
  const b = line({ id: 'b', text: '둘', takes: [take({ id: 'tb', text: '둘', path: 'p2' })], adoptedTakeId: 'tb' })
  const r = exportReadiness(doc([a, b]))
  assert.equal(r.ready, true)
  assert.deepEqual(r.paths, ['p1', 'p2'], '대본 순서를 지킨다')
})

test('내보내기 — 빈 줄은 건너뛰되 몇 줄인지 알린다', () => {
  const a = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const r = exportReadiness(doc([a, line({ id: 'x', text: '' }), line({ id: 'y', text: '  ' })]))
  assert.equal(r.ready, true)
  assert.equal(r.skippedEmpty, 2)
})

test('내보내기 — 낡은 결과를 최신인 것처럼 내보내지 않는다', () => {
  const stale = line({ id: 'a', text: '고친 말', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const r = exportReadiness(doc([stale]))
  assert.equal(r.ready, false)
  assert.equal(r.blocking[0].status, 'stale_text')
  assert.deepEqual(r.paths, [])
})

test('저장본 복원 — 모양이 맞으면 되살리고, 어긋나면 지어내지 않는다', () => {
  const d = doc([line({ takes: [take()], adoptedTakeId: 't1' })])
  const back = parseDoc(JSON.parse(JSON.stringify(d)))
  assert.ok(back)
  assert.equal(back!.lines[0].takes.length, 1)
  assert.equal(back!.lines[0].adoptedTakeId, 't1')
  assert.equal(back!.voicePath, VOICE)

  assert.equal(parseDoc(null), null)
  assert.equal(parseDoc({}), null)
  assert.equal(parseDoc({ lines: [{ id: 1 }] }), null)
})

test('저장본 복원 — 없는 테이크를 가리키던 채택은 조용히 풀린다', () => {
  const back = parseDoc({ voicePath: VOICE, lines: [{ id: 'l1', text: 'x', takes: [], adoptedTakeId: 'gone' }] })
  assert.ok(back)
  assert.equal(back!.lines[0].adoptedTakeId, null, '없는 파일을 고른 상태로 두면 내보내기가 거짓말을 한다')
})

test('설정은 작업실 소유다 — 초기값은 제품 기본값', () => {
  const d = emptyDoc('auto')
  assert.deepEqual(d.settings, {
    speed: 1.0, silenceGap: 0.5, pitch: 0.0,
    engine: 'auto', qwenModel: '', referenceConditioningMode: 'auto', refTargetSec: 0,
    tailMode: 'auto', tailPaddingMs: 120, tailFadeMs: 8,
  }, '제품 기본값과 같아야 한다 — 합성 탭의 현재 값을 끌어오지 않는다')
})

test('설정 복원 — 저장된 값은 살리고, 없거나 망가진 값만 기본값으로 채운다', () => {
  const got = parseSettings({ speed: 1.4, engine: 'qwen', pitch: 'x', nonsense: 1 }, 'auto')
  assert.equal(got.speed, 1.4, '저장한 값을 지키다')
  assert.equal(got.engine, 'qwen')
  assert.equal(got.pitch, 0.0, '망가진 값은 기본값으로')
  assert.equal(got.silenceGap, 0.5, '없는 값은 기본값으로')
  assert.equal(parseSettings(null, 'auto').speed, 1.0)
})

test('저장본에 설정이 없어도 기본값으로 열린다 (옛 저장본 호환)', () => {
  const back = parseDoc({ voicePath: VOICE, lines: [{ id: 'l1', text: 'x', takes: [], adoptedTakeId: null }] }, 'auto')
  assert.ok(back)
  assert.deepEqual(back!.settings, defaultSettings('auto'))
})

test('설정은 문서와 함께 저장·복원된다', () => {
  const d = { ...doc([line()]), settings: { ...defaultSettings('auto'), speed: 1.25, engine: 'qwen' } }
  const back = parseDoc(JSON.parse(JSON.stringify(d)), 'auto')
  assert.equal(back!.settings.speed, 1.25)
  assert.equal(back!.settings.engine, 'qwen')
})

test('내보내기 차단 사유 — 만들기 / 고르기 / 다시 만들기를 구분한다', () => {
  // 하나도 만든 적이 없다
  assert.equal(exportBlockReason(line(), vk), 'need_generate')
  // 지금 대사·목소리의 생성본이 있는데 고르지 않았다 → 만들 필요 없이 고르면 된다
  assert.equal(exportBlockReason(line({ takes: [take()] }), vk), 'need_pick')
  // 고른 것이 낡았지만 맞는 생성본이 따로 있다 → 이것도 고르기다
  const stale = take({ id: 'old', text: '옛 대사' })
  const good = take({ id: 'new' })
  assert.equal(exportBlockReason(line({ takes: [stale, good], adoptedTakeId: 'old' }), vk), 'need_pick')
  // 생성본은 있는데 지금 대사의 것이 하나도 없다 → 다시 만들어야 한다
  assert.equal(exportBlockReason(line({ takes: [stale], adoptedTakeId: 'old' }), vk), 'need_regenerate')
  // 목소리를 바꾼 경우도 다시 만들기
  assert.equal(exportBlockReason(line({ takes: [take()], adoptedTakeId: 't1' }), 'other'), 'need_regenerate')
  // 막지 않는 경우
  assert.equal(exportBlockReason(line({ takes: [take()], adoptedTakeId: 't1' }), vk), null)
  assert.equal(exportBlockReason(line({ text: '  ' }), vk), null, '빈 줄은 막지 않는다')
})

test('내보내기 차단 문구 — 그대로 읽고 행동할 수 있다', () => {
  assert.equal(exportBlockText(1, 'need_generate'), '2번 문장의 음성을 생성하세요.')
  assert.equal(exportBlockText(1, 'need_pick'), '2번 문장에서 사용할 음성을 선택하세요.')
  assert.equal(exportBlockText(1, 'need_regenerate'), '2번 문장이 변경됐습니다. 음성을 다시 생성하세요.')
})

test('내보내기 목록 — 막는 자리마다 사유가 붙는다', () => {
  const okLine = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const pick = line({ id: 'b', text: '고를 것', takes: [take({ id: 'tb', text: '고를 것' })] })
  const regen = line({ id: 'c', text: '바뀐 말', takes: [take({ id: 'tc' })], adoptedTakeId: 'tc' })
  const r = exportReadiness(doc([okLine, pick, regen]))
  assert.equal(r.ready, false)
  assert.deepEqual(r.blocking.map((b) => [b.index, b.block]), [[1, 'need_pick'], [2, 'need_regenerate']])
  assert.deepEqual(r.paths, [], '빠진 문장을 조용히 빼고 내보내지 않는다')
})

test('내보내기 — 최신 생성본이라는 이유로 고른 것을 바꾸지 않는다', () => {
  const older = take({ id: 'ta', path: 'p_old', createdAt: 1 })
  const newer = take({ id: 'tb', path: 'p_new', createdAt: 9 })
  const l = line({ takes: [older, newer], adoptedTakeId: 'ta' })
  const r = exportReadiness(doc([l]))
  assert.equal(r.ready, true)
  assert.deepEqual(r.paths, ['p_old'], '사용자가 고른 것을 그대로 쓴다')
})

test('차단 안내는 문제가 풀리면 지워야 하는 종류로 가려진다', () => {
  // 누가 띄웠는지가 아니라 **무슨 말인지**로 가린다 — 어느 경로로 떴든 지워져야 한다.
  assert.equal(isExportBlockNotice(exportBlockText(1, 'need_generate')), true)
  assert.equal(isExportBlockNotice(exportBlockText(1, 'need_pick')), true)
  assert.equal(isExportBlockNotice(exportBlockText(1, 'need_regenerate')), true)
  assert.equal(isExportBlockNotice('만든 문장이 없습니다.'), true)
  // 다른 알림은 건드리지 않는다
  assert.equal(isExportBlockNotice('내보냈습니다 — 2개 문장, 128KB'), false)
  assert.equal(isExportBlockNotice('문장을 지웠습니다. 되돌릴 수 있습니다.'), false)
  assert.equal(isExportBlockNotice('새 생성본이 있습니다. 사용할 음성을 선택하세요. (…)'), true,
    '이것도 고르면 풀리는 같은 종류다')
  assert.equal(isExportBlockNotice(null), false)
})

test('일괄 생성 대상 — 번호와 이유를 누르기 전에 알 수 있다', () => {
  const ready = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const fresh = line({ id: 'b', text: '새 말' })
  const edited = line({ id: 'c', text: '고친 말', takes: [take({ id: 'tc' })], adoptedTakeId: 'tc' })
  const blank = line({ id: 'd', text: '' })
  assert.deepEqual(redoTargets(doc([ready, fresh, edited, blank])), [
    { number: 2, reason: '아직 음성 없음' },
    { number: 3, reason: '대사 바뀜' },
  ], '준비된 줄과 빈 줄은 대상이 아니다')
})

test('일괄 생성 대상 — 목소리를 바꾸면 그 사유로 나온다', () => {
  const l = line({ takes: [take()], adoptedTakeId: 't1' })
  const d = doc([l], 'C:/voice/B.wav')
  assert.deepEqual(redoTargets(d), [{ number: 1, reason: '목소리 바뀜' }])
})

test('새 생성본 알림 — 고른 것보다 나중에 만든 것이 있을 때만', () => {
  const old = take({ id: 'ta', createdAt: 1 })
  const neo = take({ id: 'tb', createdAt: 2 })
  // 새로 만들었는데 이전 결과 보존 원칙 때문에 자동 선택되지 않았다 → 알린다
  assert.equal(hasUnusedTake(line({ takes: [old, neo], adoptedTakeId: 'ta' }), vk), true)
  // 그 새 것을 골랐다 → 더 알릴 일이 없다(예전 생성본이 남아 있어도)
  assert.equal(hasUnusedTake(line({ takes: [old, neo], adoptedTakeId: 'tb' }), vk), false,
    '이미 고른 뒤에도 계속 알리면 표시가 무의미해진다')
  // 아직 아무것도 고르지 않았는데 결과가 있다 → 고르라고 알린다
  assert.equal(hasUnusedTake(line({ takes: [old] }), vk), true)
  assert.equal(hasUnusedTake(line(), vk), false)
})

test('새 생성본 알림 — 지금 대사·목소리의 것이 아니면 알리지 않는다', () => {
  const cur = take({ id: 'ta', createdAt: 1 })
  const stale = take({ id: 'tb', createdAt: 2, text: '옛 대사' })
  assert.equal(hasUnusedTake(line({ takes: [cur, stale], adoptedTakeId: 'ta' }), vk), false,
    '수정 전 대사의 결과를 "골라 보세요" 라고 권하면 안 된다')
  const other = take({ id: 'tc', createdAt: 2, voiceKey: 'B' })
  assert.equal(hasUnusedTake(line({ takes: [cur, other], adoptedTakeId: 'ta' }), vk), false)
})

test('빈 작업실은 줄 하나로 시작한다', () => {
  const d = emptyDoc('auto')
  assert.equal(d.lines.length, 1)
  assert.equal(lineStatus(d.lines[0], ''), 'empty')
  assert.equal(adoptedTake(newLine('x')), null)
})

// ── 말끝 다듬기 ────────────────────────────────────────────────────────────
// 작업실이 이 값을 안 보내면 워커가 'off' 로 떨어지고, 그때 말끝 20ms 가 0 까지 깎이며
// 뒤 여유가 사라진다(실측: 마지막 20ms 잔존 60.9% vs auto 86.5%). 기본은 반드시 'auto'.

test('말끝 다듬기 기본값은 켜짐이고 제품 기본값과 같다', () => {
  const d = defaultSettings('auto')
  assert.equal(d.tailMode, 'auto')
  assert.equal(d.tailPaddingMs, 120)
  assert.equal(d.tailFadeMs, 8)
})

test('말끝 설정이 없는 옛 저장본은 켜짐으로 올라온다(조용한 off 강등 금지)', () => {
  const got = parseSettings({ speed: 1.0, engine: 'auto' }, 'auto')
  assert.equal(got.tailMode, 'auto')
  assert.equal(got.tailPaddingMs, 120)
  assert.equal(got.tailFadeMs, 8)
})

test('말끝 설정을 저장해 뒀으면 그 값을 그대로 쓴다', () => {
  const got = parseSettings({ tailMode: 'off', tailPaddingMs: 40, tailFadeMs: 3 }, 'auto')
  assert.equal(got.tailMode, 'off')
  assert.equal(got.tailPaddingMs, 40)
  assert.equal(got.tailFadeMs, 3)
})

test('말끝 방식에 엉뚱한 값이 들어오면 기본값으로 되돌린다', () => {
  assert.equal(parseSettings({ tailMode: 'loud' }, 'auto').tailMode, 'auto')
  assert.equal(parseSettings({ tailPaddingMs: 'x' }, 'auto').tailPaddingMs, 120)
})

const REF = { clip: 'C:/ref/clip.wav', region: { start: 1, duration: 9 } }

test('보내는 옵션에 말끝 설정이 실제로 담긴다', () => {
  const o = synthesisOptions('안녕하세요', defaultSettings('auto'), REF)
  // 이 세 값이 빠지면 워커가 'off' 로 떨어져 말끝이 깎인다 — 빠뜨림을 여기서 막는다.
  assert.equal(o.ttsTailMode, 'auto')
  assert.equal(o.ttsTailPaddingMs, 120)
  assert.equal(o.ttsTailFadeMs, 8)
})

test('보내는 옵션이 작업실 설정을 그대로 따른다', () => {
  const s = { ...defaultSettings('auto'), speed: 1.25, pitch: -1.5, engine: 'qwen', tailPaddingMs: 200 }
  const o = synthesisOptions('문장', s, REF)
  assert.equal(o.ttsText, '문장')
  assert.equal(o.ttsSpeed, 1.25)
  assert.equal(o.ttsPitch, -1.5)
  assert.equal(o.ttsEngine, 'qwen')
  assert.equal(o.ttsTailPaddingMs, 200)
  assert.equal(o.ttsSpeakerMode, 'single')
  assert.equal(o.ttsReferenceOverride, REF.clip)
  assert.deepEqual(o.ttsReferenceRegion, REF.region)
})

// 화면이 만든 옵션이 **파이썬에 실제로 실릴 config** 까지 그대로 가는지 한 줄로 잇는다.
// 중간의 buildTtsConfig 는 값이 없으면 조용히 'off' 로 채운다 — 그래서 여기서 끝까지 확인한다.
test('작업실 옵션이 워커 config 까지 말끝 켜짐으로 도달한다', async () => {
  const { buildTtsConfig } = await import('./ttsConfig.ts')
  const cfg = buildTtsConfig(synthesisOptions('안녕하세요', defaultSettings('auto'), REF))
  assert.equal(cfg.ttsTailMode, 'auto', "여기서 'off' 면 말끝 20ms 가 0 까지 깎인다")
  assert.equal(cfg.ttsTailPaddingMs, 120)
  assert.equal(cfg.ttsTailFadeMs, 8)
})

// ── 끝 잘림 의심 판정 ──────────────────────────────────────────────────────
// 실측(2026-09-16, 4회): 끊긴 1회 0.087 / 정상 3회 0.000·0.002·0.007.
// 되살릴 수 없는 현상이라 **알아보는 것**이 전부다 — 잘못 알리면 쓸모가 없어진다.

test('끝났을 때 소리가 남아 있었으면 잘림 의심으로 본다', () => {
  assert.equal(takeTailCut(take({ tailResidual: 0.087 })), true, '실측된 끊긴 회차')
  assert.equal(takeTailCut(take({ tailResidual: TAIL_RESIDUAL_CUT })), true, '기준값은 포함한다')
})

test('잦아들며 끝난 것은 잘림이라 하지 않는다', () => {
  for (const v of [0, 0.002, 0.007]) {
    assert.equal(takeTailCut(take({ tailResidual: v })), false, `정상 회차 ${v}`)
  }
})

test('재지 않은 옛 생성본은 잘렸다고 말하지 않는다', () => {
  assert.equal(takeTailCut(take()), false, '모르는 것을 단정하지 않는다')
  assert.equal(takeTailCut(take({ tailResidual: Number.NaN })), false)
})

test('실측한 값이 저장·복원을 건너도 남는다', () => {
  const src = doc([{ ...line(), takes: [take({ tailResidual: 0.087 })], adoptedTakeId: 't1' }])
  const back = parseDoc(JSON.parse(JSON.stringify(src)))
  assert.ok(back)
  assert.equal(back!.lines[0].takes[0].tailResidual, 0.087)
})

test('값이 없던 옛 저장본은 없는 채로 복원된다 — 0 으로 채우지 않는다', () => {
  const back = parseDoc({
    voicePath: VOICE,
    lines: [{ id: 'l1', text: 'x', takes: [{ id: 't1', path: 'p.wav' }], adoptedTakeId: null }],
  })
  assert.ok(back)
  assert.equal('tailResidual' in back!.lines[0].takes[0], false,
    '0 으로 채우면 정상이라고 거짓말하게 된다')
})

// ★2026-09-24: 여기가 **없는 자리**를 읽어 '끝 잘림 의심' 꼬리표가 한 번도 뜨지 않았다.
//   파이썬은 metadata 를 tracks 의 **형제**로 보내는데 화면은 트랙 **안쪽**을 읽었다.
//   받는 인자가 any 라 타입검사가 못 잡았다 — 그래서 모양을 검사로 못 박는다.
{
  const real = { tracks: [{ path: 'a.wav' }], outputDir: 'out', metadata: { tail_residual_ratio: 0.087 } }
  assert.equal(tailResidualOf(real), 0.087, '파이썬이 실제로 보내는 모양에서 꺼내야 한다')
  assert.equal(takeTailCut(take({ tailResidual: tailResidualOf(real) })), true, '꺼낸 값이 판정까지 이어져야 한다')

  const oldWrongGuess = { tracks: [{ path: 'a.wav', metadata: { tail_residual_ratio: 0.087 } }] }
  assert.equal(tailResidualOf(oldWrongGuess), undefined, '트랙 안쪽은 파이썬이 쓰지 않는 자리다')

  assert.equal(tailResidualOf({ tracks: [], outputDir: 'o', metadata: {} }), undefined)
  assert.equal(tailResidualOf({ metadata: { tail_residual_ratio: 'x' } }), undefined, '숫자가 아니면 모르는 것이다')
  assert.equal(tailResidualOf({ metadata: { tail_residual_ratio: Number.NaN } }), undefined)
  assert.equal(tailResidualOf(null), undefined)
  assert.equal(tailResidualOf(undefined), undefined)
  assert.equal(tailResidualOf({ metadata: { tail_residual_ratio: 0 } }), 0, '0은 아주 좋은 값이지 모름이 아니다')
}
