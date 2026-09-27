// 텍스트 추출 결과 작업실 — **읽고 고치고 복사하고 저장하는 흐름**만 본다(2026-09-27).
//   · 실제로 있는 결과만 보여 준다(번역이 없으면 탭도 없다)
//   · 문장별 시간이 있을 때만 구간 듣기를 준다. 없으면 가짜 시간을 만들지 않는다
//   · 고친 내용이 **복사와 저장에 똑같이** 들어간다
//   · 원문을 고쳤다고 번역·자막이 갱신된 것처럼 말하지 않는다
//   · 교정은 **파일마다** 보존되고, 다른 원본에 이전 교정을 적용하지 않는다
//   · 읽기 실패를 '저장 없음' 으로 단정하지 않는다
//
// 본체 응답은 모의다(엔진을 돌리지 않는다).
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')

const bundle = await build({
  stdin: {
    resolveDir: root, loader: 'tsx',
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import T from './src/renderer/components/TranscriptEditor';
import{useAppStore}from './src/renderer/stores/app.store';
window.store=useAppStore;
createRoot(document.getElementById('root')).render(<T/>);`,
  },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  tsconfig: path.join(root, 'tsconfig.web.json'),
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 940, height: 900 } })
let checks = 0
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const pass = (s) => { checks++; console.log('PASS', s) }

const SEGS = [
  { start: 1, end: 3, text: '안녕하세요' },
  { start: 4, end: 7, text: '오늘은 날씨가 좋네요' },
  { start: 8, end: 11, text: '그럼 시작해 볼까요' },
]
const withSegs = (base, src) => ({
  name: 'transcript', label: '텍스트 (ko)', path: `C:/out/${base}.txt`,
  text: SEGS.map((s) => s.text).join('\n'), language: 'ko', base, segments: SEGS,
})
const TRANSLATION = {
  name: 'translation', label: '한국어 번역', path: 'C:/out/x_korean.txt',
  text: '번역된 글입니다.', language: 'ko',
}

try {
  await page.setContent('<style>*{box-sizing:border-box}body{margin:20px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--cyan:#6cc;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
  await page.evaluate(() => {
    window.__settings = {}
    window.__copied = null
    window.__saved = null
    window.__opened = null
    window.api = {
      settings: {
        get: async () => JSON.parse(JSON.stringify(window.__settings)),
        set: async (k, v) => { window.__settings[k] = JSON.parse(JSON.stringify(v)); return { ok: true } },
      },
      app: {
        openFolder: (d) => { window.__opened = d },
        saveCorrectedTranscript: async (dir, base, txt, srt) => {
          window.__saved = { dir, base, txt, srt }
          return { ok: true, files: [`${base}_corrected.txt`, `${base}_corrected.srt`] }
        },
      },
      utils: { copyToClipboard: async (t) => { window.__copied = t } },
    }
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  const show = async (tracks, src) => {
    await page.evaluate(({ tracks, src }) => {
      window.store.setState({
        mode: 'transcribe', resultMode: 'transcribe',
        fileInfo: { path: src, name: src, duration: 20, channels: 1, sampleRate: 16000, format: 'wav' },
        fileUrl: 'data:audio/wav;base64,UklGRgAAAABXQVZF',
      })
      window.store.getState().setResult(tracks, 'C:/out', null)
    }, { tracks, src })
    await page.waitForSelector('[data-testid="transcript-editor"]')
  }

  // ══ 있는 결과만 보여 준다 ══════════════════════════════════════════════
  await show([withSegs('a', 'C:/work/a.wav')], 'C:/work/a.wav')
  assert.equal(await page.getByTestId('transcript-views').count(), 0, '번역이 없는데 탭이 나왔다')
  assert.equal(await page.getByTestId('transcript-row').count(), 3)
  pass('★번역이 없으면 탭을 만들지 않는다')

  await show([withSegs('b', 'C:/work/b.wav'), TRANSLATION], 'C:/work/b.wav')
  await page.waitForSelector('[data-testid="transcript-views"]')
  assert.equal(await page.getByTestId('transcript-view-translation').count(), 1)
  pass('★번역이 있으면 전환할 수 있다')

  // ══ 번역은 읽기 전용, 구간 듣기 없음 ═══════════════════════════════════
  await page.getByTestId('transcript-view-translation').click()
  await page.waitForSelector('[data-testid="transcript-translation"]')
  assert.equal(await page.getByTestId('transcript-play').count(), 0,
    '번역에 구간 듣기가 붙었다 — 번역에는 문장별 시간이 없다')
  assert.match(await page.getByTestId('transcript-edited-count').innerText(), /읽기 전용/)
  pass('★번역은 읽기 전용이고 가짜 시간을 만들지 않는다')

  await page.getByTestId('transcript-copy').click()
  await page.waitForFunction(() => window.__copied !== null)
  assert.equal(await page.evaluate(() => window.__copied), '번역된 글입니다.')
  pass('번역 복사는 번역을 복사한다')

  // ══ 고친 내용이 복사·저장에 똑같이 들어간다 ════════════════════════════
  await page.getByTestId('transcript-view-source').click()
  await page.waitForSelector('[data-testid="transcript-row"]')
  await page.getByTestId('transcript-input').nth(1).fill('오늘은 날씨가 참 좋네요')
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="transcript-edited-count"]').innerText.includes('1개'))
  await page.evaluate(() => { window.__copied = null })
  await page.getByTestId('transcript-copy').click()
  await page.waitForFunction(() => window.__copied !== null)
  const copied = await page.evaluate(() => window.__copied)
  assert.ok(copied.includes('참 좋네요'), `복사가 옛 글을 썼다: ${copied}`)
  pass('★복사가 고친 글을 쓴다(화면과 같은 글)')

  await page.getByTestId('transcript-save').click()
  await page.waitForFunction(() => window.__saved !== null)
  const saved = await page.evaluate(() => window.__saved)
  assert.ok(saved.txt.includes('참 좋네요'), `저장이 옛 글을 썼다: ${saved.txt}`)
  assert.ok(saved.srt.includes('참 좋네요'), '자막도 고친 글이어야 한다')
  assert.match(await page.getByTestId('transcript-message').innerText(), /교정본을 저장했습니다/)
  pass('★저장도 고친 글을 쓴다 — 복사와 저장이 어긋나지 않는다')

  // 번역·자막이 갱신된 것처럼 말하지 않는다.
  assert.equal(await page.getByTestId('transcript-notes').count(), 1)
  const noteTip = await page.getByTestId('transcript-notes').getAttribute('title')
  assert.ok(/번역/.test(noteTip), `번역이 그대로라는 말이 없다: ${noteTip}`)
  pass('★원문을 고쳐도 번역이 갱신된 것처럼 말하지 않는다')

  // ══ 구간 듣기는 공용 파형에 부탁한다 ═══════════════════════════════════
  await page.getByTestId('transcript-play').nth(1).click()
  const asked = await page.evaluate(() => window.store.getState().waveRange)
  assert.ok(asked && asked.start === 4 && asked.end === 7,
    `공용 파형에 그 구간을 부탁하지 않았다: ${JSON.stringify(asked)}`)
  assert.equal(await page.evaluate(() => document.querySelectorAll('audio').length), 0,
    '이 화면이 소리를 따로 들고 있다 — 두 소리가 겹칠 수 있다')
  pass('★구간 듣기를 공용 파형에 부탁한다(소리를 따로 들지 않는다)')

  // ══ 파일별 보존 ════════════════════════════════════════════════════════
  await page.waitForTimeout(800)
  await show([withSegs('c', 'C:/work/c.wav')], 'C:/work/c.wav')
  await page.waitForTimeout(300)
  const cText = await page.getByTestId('transcript-input').nth(1).inputValue()
  assert.equal(cText, '오늘은 날씨가 좋네요', `다른 원본에 이전 교정이 붙었다: ${cText}`)
  pass('★다른 원본에 이전 교정을 적용하지 않는다')

  await page.waitForTimeout(700)
  await show([withSegs('b', 'C:/work/b.wav'), TRANSLATION], 'C:/work/b.wav')
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="transcript-input"]')[1]?.value.includes('참 좋네요'))
  pass('★그 파일로 돌아오면 교정이 살아 있다(파일별 보존)')

  const keys = await page.evaluate(() => Object.keys(window.__settings.transcriptDrafts?.drafts || {}))
  assert.ok(keys.length >= 1, `보관함이 비었다: ${JSON.stringify(keys)}`)
  pass('교정이 파일별 보관함에 담긴다')

  // ══ 같은 파일을 다시 추출하면 — 옛 교정을 덮지 않는다 ═════════════════
  await page.waitForTimeout(700)
  const REDO = [{
    name: 'transcript', label: '텍스트 (ko)', path: 'C:/out/b.txt', base: 'b', language: 'ko',
    text: '다시 추출한 글', segments: [
      { start: 1, end: 3, text: '안녕하세요' },
      { start: 4, end: 7, text: '오늘 날씨 좋다' },      // 갈라진 자리가 달라졌다
      { start: 8, end: 11, text: '그럼 시작해 볼까요' },
    ],
  }]
  await show(REDO, 'C:/work/b.wav')
  await page.waitForSelector('[data-testid="transcript-past-note"]')
  const redoText = await page.getByTestId('transcript-input').nth(1).inputValue()
  assert.equal(redoText, '오늘 날씨 좋다', `다시 추출한 결과에 옛 교정을 덮었다: ${redoText}`)
  assert.match(await page.getByTestId('transcript-past-note').innerText(), /보관 중/)
  pass('★다시 추출하면 옛 교정을 덮지 않고, 보관 중임을 알린다')

  // 옛 교정은 그대로 남아 있다.
  const stillKept = await page.evaluate(() =>
    JSON.stringify(window.__settings.transcriptDrafts?.drafts || {}))
  assert.ok(stillKept.includes('참 좋네요'), `옛 교정이 사라졌다: ${stillKept.slice(0, 200)}`)
  pass('★옛 교정은 보관함에 그대로 남는다')

  // ══ 문장별 시간이 없는 결과 ════════════════════════════════════════════
  await page.waitForTimeout(700)
  await show([{
    name: 'transcript', label: '텍스트 (ko)', path: 'C:/out/d.txt',
    text: '시간 정보가 없는 글입니다.', language: 'ko', base: 'd', segments: [],
  }], 'C:/work/d.wav')
  await page.waitForSelector('[data-testid="transcript-plain"]')
  assert.equal(await page.getByTestId('transcript-play').count(), 0, '없는 시간을 만들어 냈다')
  assert.equal(await page.getByTestId('transcript-save').isDisabled(), true,
    '시간이 없는데 교정본 자막 저장을 열어 두었다')
  pass('★시간 정보가 없으면 구간 듣기를 주지 않고 가짜 시간도 만들지 않는다')
  await page.getByTestId('transcript-copy').click()
  await page.waitForFunction(() => (window.__copied || '').includes('시간 정보가 없는'))
  pass('시간이 없어도 글은 읽고 복사할 수 있다')

  // ══ 읽기 실패 ══════════════════════════════════════════════════════════
  await page.evaluate(() => {
    window.api.settings.get = async () => { throw new Error('읽기 실패') }
  })
  await show([withSegs('e', 'C:/work/e.wav')], 'C:/work/e.wav')
  await page.waitForSelector('[data-testid="transcript-read-fail"]')
  const before = await page.evaluate(() => JSON.stringify(window.__settings.transcriptDrafts || {}))
  await page.getByTestId('transcript-input').first().fill('덮어쓰나 보자')
  await page.waitForTimeout(900)
  const after = await page.evaluate(() => JSON.stringify(window.__settings.transcriptDrafts || {}))
  assert.equal(after, before, '읽기 실패 뒤 남의 저장본을 덮었다')
  pass('★읽기 실패를 "저장 없음" 으로 단정하지 않고 덮지도 않는다')

  // ══ 좁은 창 ════════════════════════════════════════════════════════════
  await page.setViewportSize({ width: 430, height: 900 })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    '좁은 창에서 가로로 넘친다')
  const reach = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="transcript-save"]').getBoundingClientRect()
    return b.right <= innerWidth + 1 && b.width > 20
  })
  assert.ok(reach, '좁은 창에서 저장 단추가 화면 밖으로 나갔다')
  pass('★좁은 창에서도 복사·저장이 화면 안에 있다')
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-text-narrow.png') })
  await page.setViewportSize({ width: 940, height: 900 })
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-text-wide.png') })

  assert.equal(errors.length, 0, `런타임 오류: ${errors.join(' | ')}`)
  pass('런타임 오류 없음')
  console.log(JSON.stringify({ passed: checks, shots: process.env.TEMP || '.' }))
} catch (e) {
  console.error('FAIL', e?.message || e)
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'af-text-fail.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
