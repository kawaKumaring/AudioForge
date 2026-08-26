// 참조 목소리 보관함 — 표시 로직 + 컴포넌트 계약 테스트.
// DOM·React 렌더 없이 순수 파생을 검사하고, 컴포넌트 소스는 파싱해 계약을 고정한다
// (레포의 기존 선례와 같은 방식).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildReferenceAssetView, decideImportAvailability, summarizeReferenceAssets,
  REFERENCE_ASSET_SECTION_TITLE, REFERENCE_ASSET_TEXT,
} from './ReferenceAssetLibraryPanel.logic.ts'
import type { ReferenceLibraryItem } from '../../shared/referenceLibraryApi.ts'

function item(over: Partial<ReferenceLibraryItem> = {}): ReferenceLibraryItem {
  return {
    referenceId: 'b'.repeat(16),
    contentSha256: 'c'.repeat(64),
    sourceSha256: 'd'.repeat(64),
    regionStartMs: 1000,
    regionDurationMs: 4000,
    analysisVersion: 1,
    ready: true,
    missing: false,
    selected: false,
    transcript: 'present',
    displayName: '참조 1',
    ...over,
  }
}

const panelSrc = readFileSync(
  fileURLToPath(new URL('./ReferenceAssetLibraryPanel.tsx', import.meta.url)), 'utf-8'
).replace(/\r\n/g, '\n')
const logicSrc = readFileSync(
  fileURLToPath(new URL('./ReferenceAssetLibraryPanel.logic.ts', import.meta.url)), 'utf-8'
).replace(/\r\n/g, '\n')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const panelCode = stripComments(panelSrc)

// ── 목록 ────────────────────────────────────────────────────────────────────

test('빈 목록: 손상과 구분되고 안내 문구가 나온다', () => {
  const view = buildReferenceAssetView('ok', [])
  assert.equal(view.isEmpty, true)
  assert.equal(view.showCorruptNotice, false)
  assert.deepEqual(view.rows, [])
  assert.equal(summarizeReferenceAssets(view), '저장된 참조 없음')
  assert.ok(REFERENCE_ASSET_TEXT.empty.length > 0)
})

test('손상: 빈 목록으로 위장하지 않는다', () => {
  const view = buildReferenceAssetView('corrupt', [item()])
  assert.equal(view.showCorruptNotice, true)
  assert.equal(view.isEmpty, false, '손상은 비어 있음이 아니다')
  assert.deepEqual(view.rows, [], '손상 상태에서 목록을 지어내지 않는다')
  assert.equal(summarizeReferenceAssets(view), REFERENCE_ASSET_TEXT.corrupt)
})

test('정렬: referenceId 사전순으로 고정된다(번호가 흔들리지 않게)', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'c'.repeat(16), displayName: '' }),
    item({ referenceId: 'a'.repeat(16), displayName: '' }),
    item({ referenceId: 'b'.repeat(16), displayName: '' }),
  ])
  assert.deepEqual(view.rows.map((r) => r.referenceId[0]), ['a', 'b', 'c'])
  assert.deepEqual(view.rows.map((r) => r.displayName), ['참조 1', '참조 2', '참조 3'])
})

test('상태 표시: 사용 중 / 누락 / 손상이 각각 다른 문구로 나온다', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16), selected: true }),
    item({ referenceId: 'b'.repeat(16), ready: false, missing: true }),
    item({ referenceId: 'c'.repeat(16), ready: false, missing: false }),
    item({ referenceId: 'd'.repeat(16) }),
  ])
  const [used, missing, corrupt, plain] = view.rows
  assert.equal(used.statusLabel, REFERENCE_ASSET_TEXT.inUse)
  assert.equal(used.tone, 'ok')
  assert.equal(missing.statusLabel, REFERENCE_ASSET_TEXT.missing)
  assert.equal(missing.tone, 'error')
  assert.equal(corrupt.statusLabel, REFERENCE_ASSET_TEXT.corrupt)
  assert.equal(corrupt.tone, 'warn')
  assert.equal(plain.statusLabel, null)
  assert.equal(plain.tone, 'neutral')
})

// ── 선택 / 삭제 ─────────────────────────────────────────────────────────────

test('선택: 손상·누락 참조는 고를 수 없다', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16) }),
    item({ referenceId: 'b'.repeat(16), ready: false }),
    item({ referenceId: 'c'.repeat(16), missing: true, ready: false }),
  ])
  assert.deepEqual(view.rows.map((r) => r.selectable), [true, false, false])
})

test('삭제: 사용 중인 참조는 막히고 이유가 함께 나온다', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16), selected: true }),
    item({ referenceId: 'b'.repeat(16) }),
  ])
  const [inUse, free] = view.rows
  assert.equal(inUse.removable, false)
  assert.equal(inUse.removeBlockedNotice, REFERENCE_ASSET_TEXT.removeBlocked)
  assert.equal(free.removable, true)
  assert.equal(free.removeBlockedNotice, null)
})

test('삭제: 손상·누락이어도 사용 중이 아니면 지울 수 있다(고아 회수)', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16), ready: false, missing: true }),
  ])
  assert.equal(view.rows[0].removable, true)
  assert.equal(view.rows[0].selectable, false)
})

// ── 등록 가능 여부 ──────────────────────────────────────────────────────────

test('등록: 확정 구간이 있어야 가능하고, 불가 사유가 항상 문장으로 나온다', () => {
  const base = { hasConfirmedRegion: true, busy: false, status: 'ok' as const, importing: false }
  assert.deepEqual(decideImportAvailability(base), { enabled: true, notice: null })

  const noRegion = decideImportAvailability({ ...base, hasConfirmedRegion: false })
  assert.equal(noRegion.enabled, false)
  assert.equal(noRegion.notice, REFERENCE_ASSET_TEXT.noConfirmedRegion)

  const busy = decideImportAvailability({ ...base, busy: true })
  assert.equal(busy.enabled, false)
  assert.equal(busy.notice, REFERENCE_ASSET_TEXT.busy)

  const importing = decideImportAvailability({ ...base, importing: true })
  assert.equal(importing.enabled, false)

  const corrupt = decideImportAvailability({ ...base, status: 'corrupt' })
  assert.equal(corrupt.enabled, false)
  assert.equal(corrupt.notice, REFERENCE_ASSET_TEXT.corrupt)

  // 비활성인데 이유가 없는 경우는 없어야 한다.
  for (const d of [noRegion, busy, importing, corrupt]) {
    assert.ok(d.notice && d.notice.length > 0)
  }
})

test('요약: 저장 개수·확인 필요·사용 중을 한 줄로 구분한다', () => {
  const ok = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16), selected: true }),
    item({ referenceId: 'b'.repeat(16) }),
  ])
  assert.equal(summarizeReferenceAssets(ok), '저장됨 2 · 사용 중 1')

  const withBroken = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16) }),
    item({ referenceId: 'b'.repeat(16), ready: false }),
  ])
  assert.equal(summarizeReferenceAssets(withBroken), '저장됨 2 · 확인 필요 1')
})

// ── 경로·해시 유출 ──────────────────────────────────────────────────────────

test('유출 방지: 화면 값에 경로가 없고 전체 해시를 그대로 쓰지 않는다', () => {
  const view = buildReferenceAssetView('ok', [item({ contentSha256: 'e'.repeat(64) })])
  const values = view.rows.flatMap((r) => Object.values(r).map((v) => String(v))).join('|')
  for (const needle of ['/', '\\', ':', '.wav', 'C:']) {
    assert.ok(!values.includes(needle), `표시 값에 ${needle} 없음`)
  }
  assert.equal(view.rows[0].shortHash, 'e'.repeat(8), '진단용은 앞 8자리만')
  assert.ok(!values.includes('e'.repeat(64)), '전체 해시를 화면 값으로 만들지 않는다')
})

test('유출 방지: 컴포넌트가 원본 파일명·경로 필드를 렌더하지 않는다', () => {
  for (const banned of ['filePath', 'sourcePath', 'originalName', 'fileName']) {
    assert.ok(!panelCode.includes(banned), `${banned} 를 렌더하지 않는다`)
  }
  // 진단용 짧은 해시는 기본 화면에 노출하지 않는다.
  assert.ok(!panelCode.includes('shortHash'), 'shortHash 는 기본 화면에 그리지 않는다')
})

// ── 접기 / 접근성 계약 ──────────────────────────────────────────────────────

test('접기: 기본 접힘이고 자체 토글만 쓴다(이중 접기 금지)', () => {
  assert.ok(/useState\(false\)/.test(panelCode), '기본 접힘')
  assert.ok(/aria-expanded=\{open\}/.test(panelCode))
  assert.ok(/aria-controls=/.test(panelCode))
  // 펼칠 때만 목록을 읽는다(닫힌 채 폴링하지 않는다).
  assert.ok(/if \(next && onRefresh\) onRefresh\(\)/.test(panelCode))
})

test('접근성: 조작은 실제 button 이고 모두 aria-label 을 갖는다', () => {
  const tags = [...panelCode.replace(/=>/g, '__ARROW__').matchAll(/<button[\s\S]*?>/g)].map((m) => m[0])
  assert.ok(tags.length >= 4, `버튼이 충분히 있다: ${tags.length}`)
  for (const tag of tags) {
    assert.ok(tag.includes('type="button"'), `type=button: ${tag.slice(0, 60)}`)
    assert.ok(tag.includes('aria-label'), `aria-label: ${tag.slice(0, 60)}`)
  }
  assert.ok(!/onClick=\{[^}]*\}\s*>/.test(panelCode.replace(/<button[\s\S]*?<\/button>/g, '')),
    '버튼 밖에서 클릭 핸들러를 쓰지 않는다')
})

test('레이아웃: 고정 폭 없이 wrap 하고 가로 넘침을 막는다', () => {
  assert.ok(panelCode.includes("maxWidth: '100%'"))
  assert.ok(panelCode.includes('flexWrap'))
  assert.ok(panelCode.includes("overflowX: 'hidden'"))
  assert.ok(panelCode.includes("overflowWrap: 'anywhere'"))
  assert.ok(!/width:\s*\d+\s*,/.test(panelCode.replace(/width: 8,/g, '')), '고정 px 폭 없음')
})

test('경계: 감정 참조 등록·미리듣기와 어휘가 겹치지 않는다', () => {
  assert.equal(REFERENCE_ASSET_SECTION_TITLE, '참조 목소리 보관함')
  for (const other of ['감정 참조 등록', '감정·표현 미리듣기']) {
    assert.ok(!logicSrc.includes(`'${other}'`), `${other} 어휘를 쓰지 않는다`)
  }
  // 기존 후보 선택 패널을 끌어다 쓰지 않는다(역할이 다르다).
  assert.ok(!panelCode.includes('ReferenceLibraryPanel'), '후보 선택 패널과 분리되어 있다')
})

// ── 전사 상태 ───────────────────────────────────────────────────────────────

test('전사: 없음·손상은 배지로 드러나고 샘플 생성이 막힌다', () => {
  const view = buildReferenceAssetView('ok', [
    item({ referenceId: 'a'.repeat(16), transcript: 'present' }),
    item({ referenceId: 'b'.repeat(16), transcript: 'TRANSCRIPT_MISSING' }),
    item({ referenceId: 'c'.repeat(16), transcript: 'TRANSCRIPT_HASH_MISMATCH' }),
    item({ referenceId: 'd'.repeat(16), transcript: 'TRANSCRIPT_CORRUPT' }),
  ])
  const [ok, missing, mismatch, corrupt] = view.rows
  assert.equal(ok.transcriptLabel, null)
  assert.equal(ok.samplerReady, true)
  assert.equal(missing.transcriptLabel, REFERENCE_ASSET_TEXT.transcriptMissing)
  assert.equal(missing.samplerReady, false)
  assert.equal(mismatch.transcriptLabel, REFERENCE_ASSET_TEXT.transcriptBroken)
  assert.equal(mismatch.samplerReady, false)
  assert.equal(corrupt.samplerReady, false)
  // 전사가 없어도 보관·선택·삭제는 가능하다(등록 자체를 막지 않는다).
  assert.equal(missing.selectable, true)
  assert.equal(missing.removable, true)
})

test('전사: 안내 문구가 관리자 확정 문장과 같다', () => {
  assert.equal(
    REFERENCE_ASSET_TEXT.samplerBlocked,
    '참조 전사가 없어 감정 샘플을 만들 수 없습니다. 참조 구간의 전사를 먼저 확정해 주세요.'
  )
})

test('전사: 화면 값에 전사 원문이 실릴 자리가 없다', () => {
  const view = buildReferenceAssetView('ok', [item({ transcript: 'present' })])
  const keys = Object.keys(view.rows[0])
  for (const banned of ['text', 'transcriptText', 'transcript']) {
    assert.ok(!keys.includes(banned), `행에 ${banned} 필드가 없다`)
  }
})
